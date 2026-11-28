// End-to-end proof against the REAL daemon and the REAL @dool2/approvals verify path (no stubs): the phone pairs,
// the daemon's gate stops a pay action at level 'ask', the PhoneSimulator signs the exact card, the daemon's
// approve() runs @dool2/approvals verifyApproval + matchesApproved, and a resume send runs the action once. A denied
// card never runs; a tampered signature is rejected.

import { Agentd } from '@dool2/agentd'
import { envelopeHash } from '@dool2/approvals'
import type { Brain } from '@dool2/brains'
import { type HostBridges, makeFakeBridges, type PageSnapshot } from '@dool2/sandbox'
import { describe, expect, it } from 'vitest'
import { InMemoryKeyStore } from './keystore.js'
import { pairDevice } from './pairing.js'
import { signCard } from './sign.js'
import { PhoneSimulator } from './simulator.js'

/** Fake bridges whose page snapshot shows a pay button at e2, so a click on e2 classifies as a payment. */
function payBridges(): ReturnType<typeof makeFakeBridges> {
  const fake = makeFakeBridges()
  fake.page.snapshot = async (): Promise<PageSnapshot> => ({
    url: 'https://shop.example.com/checkout',
    title: 'Checkout',
    nodes: [{ ref: 'e2', role: 'button', name: 'Pay 50,000 won' }],
  })
  return fake
}

/** A brain that runs one `code` snippet clicking `ref`, then finishes. Replays the click on a resume send(). */
function clickBrain(ref: string): Brain {
  return {
    id: 'pi',
    label: 'click',
    async ready() {
      return true
    },
    async *run(input) {
      const alreadyRan = input.messages.some((m) => m.role === 'tool')
      if (alreadyRan) {
        yield { kind: 'turn_end', stop: 'done' }
        return
      }
      yield {
        kind: 'tool_call',
        call: {
          id: 'c1',
          name: 'code',
          args: { code: `await page.snapshot(); await page.click(${JSON.stringify(ref)})` },
        },
      }
      yield { kind: 'turn_end', stop: 'tool' }
    },
  }
}

describe('phone <-> daemon end to end (real Agentd + real approvals verify)', () => {
  it('pay at level ask: card -> phone signs -> daemon verifies -> resume runs the action', async () => {
    const keystore = new InMemoryKeyStore()
    const bridges: HostBridges & { calls: string[] } = payBridges()
    const agentd = new Agentd({ brain: clickBrain('e2'), bridges, level: 'ask' })

    // Pairing registers the device pubkey with the daemon (so approve() can verify later).
    const pair = await pairDevice(agentd, keystore, { label: 'Test iPhone' })
    expect(pair.response.ok).toBe(true)

    // Turn 1: the gate stops the pay click; it surfaces as a signable card.
    const first = await agentd.send('pay for the order')
    expect(first.approvalsNeeded).toHaveLength(1)
    const card = first.approvalsNeeded[0]
    if (!card) throw new Error('expected an approval card')
    expect(card.tier).toBe('pay')
    expect(card.amountKrw).toBe(50_000)
    expect(bridges.calls).not.toContain('page.click:e2')

    // The phone signs via the simulator (approve pay). This runs the real signCard -> agentd.approve path.
    const phone = new PhoneSimulator(agentd, keystore, { approve: ['pay'] })
    const [decision] = await phone.handleAll(first.approvalsNeeded)
    if (!decision) throw new Error('expected a decision')
    expect(decision.approved).toBe(true)
    expect(decision.result?.ok).toBe(true) // verifyApproval + matchesApproved passed on the daemon
    expect(agentd.isApproved(card.hash)).toBe(true)

    // Resume: the daemon recomputes the same hash, finds it approved, and the click runs once.
    const resumed = await agentd.send('pay for the order', { approved: [card.hash] })
    expect(resumed.approvalsNeeded).toHaveLength(0)
    expect(bridges.calls).toContain('page.click:e2')
    const payGate = resumed.gateDecisions.find((g) => g.tier === 'pay')
    expect(payGate?.decision).toBe('run')

    // Single-use: it is now spent, so another resume pauses again.
    expect(agentd.isApproved(card.hash)).toBe(false)
  })

  it('a denied card is never signed, so the action never runs', async () => {
    const keystore = new InMemoryKeyStore()
    const bridges: HostBridges & { calls: string[] } = payBridges()
    const agentd = new Agentd({ brain: clickBrain('e2'), bridges, level: 'ask' })
    await pairDevice(agentd, keystore)

    const first = await agentd.send('pay for the order')
    const card = first.approvalsNeeded[0]
    if (!card) throw new Error('expected an approval card')

    // The phone denies payments: it does not sign, and does not call approve.
    const phone = new PhoneSimulator(agentd, keystore, { deny: ['pay'] })
    const [decision] = await phone.handleAll(first.approvalsNeeded)
    expect(decision?.approved).toBe(false)
    expect(decision?.result).toBeUndefined()
    expect(agentd.isApproved(card.hash)).toBe(false)

    // A resume cannot run the action, because nothing was approved.
    const resumed = await agentd.send('pay for the order', { approved: [card.hash] })
    expect(resumed.approvalsNeeded).toHaveLength(1)
    expect(bridges.calls).not.toContain('page.click:e2')
  })

  it('a tampered signature is rejected by the daemon', async () => {
    const keystore = new InMemoryKeyStore()
    const bridges = payBridges()
    const agentd = new Agentd({ brain: clickBrain('e2'), bridges, level: 'ask' })
    await pairDevice(agentd, keystore)

    const first = await agentd.send('pay for the order')
    const card = first.approvalsNeeded[0]
    if (!card) throw new Error('expected an approval card')

    // Sign the real card, then flip a byte of the signature before sending it.
    const good = await signCard(card, keystore)
    const bytes = Buffer.from(good, 'base64')
    bytes[0] = bytes[0] === undefined ? 1 : bytes[0] ^ 0xff
    const tampered = bytes.toString('base64')

    const result = agentd.approve(card.hash, tampered)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('bad-signature')
    expect(agentd.isApproved(card.hash)).toBe(false)

    // A valid signature for a DIFFERENT action is likewise rejected: it is bound to that action's hash, not this
    // card's. The daemon verifies the submitted signature against THIS card's envelope, so it does not match.
    const otherEnvelope = { ...card.envelope, amountKrw: 1_000 }
    const wrongActionSig = await signCard(
      { hash: envelopeHash(otherEnvelope), envelope: otherEnvelope },
      keystore,
    )
    const r2 = agentd.approve(card.hash, wrongActionSig)
    expect(r2.ok).toBe(false)
  })
})
