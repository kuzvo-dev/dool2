import { generateDeviceKeyPair, signApproval } from '@dool2/approvals'
import type { Brain } from '@dool2/brains'
import { type HostBridges, makeFakeBridges, type PageSnapshot } from '@dool2/sandbox'
import { describe, expect, it } from 'vitest'
import { Agentd } from './agentd.js'

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

/**
 * A stateless brain that, each turn, runs one `code` snippet clicking `ref`, then finishes. It keys off the running
 * messages (a tool result present means the code already ran this turn), so the SAME instance replays the click on a
 * second send() — exactly the resume case.
 */
function clickBrain(ref: string): Brain {
  return {
    id: 'pi',
    label: 'click',
    async ready() {
      return true
    },
    async *run(input, _handle) {
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

describe('Agentd resume: send -> approvalNeeded -> approve -> resume send runs the action', () => {
  it('runs the pay click only after a valid signature, and only when its hash is in the resume set', async () => {
    const device = generateDeviceKeyPair()
    const bridges: HostBridges & { calls: string[] } = payBridges()
    const agentd = new Agentd({
      brain: clickBrain('e2'),
      bridges,
      level: 'ask',
      devicePublicKeyPem: device.publicKeyPem,
    })

    // Turn 1: the gate stops the pay click; it surfaces as a signable card.
    const first = await agentd.send('pay for the order')
    expect(first.approvalsNeeded).toHaveLength(1)
    const card = first.approvalsNeeded[0]
    if (!card) throw new Error('expected an approval card')
    expect(card.tier).toBe('pay')
    expect(card.amountKrw).toBe(50_000)
    expect(bridges.calls).not.toContain('page.click:e2') // did not run

    // A resume BEFORE approval does nothing: the hash is not yet recorded, so it is ignored (pauses again).
    const premature = await agentd.send('pay for the order', { approved: [card.hash] })
    expect(premature.approvalsNeeded).toHaveLength(1)
    expect(bridges.calls).not.toContain('page.click:e2')

    // The phone signs the exact envelope; approve verifies + consumes + records it.
    const goodSig = signApproval(card.envelope, device.privateKeyPem)
    const ok = agentd.approve(card.hash, goodSig)
    expect(ok.ok).toBe(true)
    expect(agentd.isApproved(card.hash)).toBe(true)

    // A resume with a WRONG hash still does not run the action (and does not clear the real approval).
    const wrong = await agentd.send('pay for the order', { approved: ['0'.repeat(64)] })
    expect(wrong.approvalsNeeded).toHaveLength(1)
    expect(bridges.calls).not.toContain('page.click:e2')
    expect(agentd.isApproved(card.hash)).toBe(true)

    // The real resume: the engine recomputes the same hash, finds it approved, and the click runs once.
    const resumed = await agentd.send('pay for the order', { approved: [card.hash] })
    expect(resumed.approvalsNeeded).toHaveLength(0)
    expect(bridges.calls).toContain('page.click:e2')
    const payGate = resumed.gateDecisions.find((g) => g.tier === 'pay')
    expect(payGate?.decision).toBe('run')
    expect(payGate?.reason).toBe('approved')

    // Single-use across the session: it is now spent, so another resume pauses again.
    expect(agentd.isApproved(card.hash)).toBe(false)
    const after = await agentd.send('pay for the order', { approved: [card.hash] })
    expect(after.approvalsNeeded).toHaveLength(1)
  })
})
