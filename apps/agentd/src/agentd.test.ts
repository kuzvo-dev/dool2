import { generateDeviceKeyPair, signApproval } from '@dool2/approvals'
import { mockBrain } from '@dool2/brains'
import type { ActionClassifier, TurnEvent } from '@dool2/engine'
import { defaultClassify, scriptedBrain } from '@dool2/engine'
import { type HostBridges, makeFakeBridges, type PageSnapshot } from '@dool2/sandbox'
import { describe, expect, it } from 'vitest'
import { Agentd } from './agentd.js'

/** Fake bridges whose page snapshot shows a pay button at e2, so a click on e2 classifies as a payment. */
function payBridges(): HostBridges {
  const fake = makeFakeBridges()
  fake.page.snapshot = async (): Promise<PageSnapshot> => ({
    url: 'https://shop.example.com/checkout',
    title: 'Checkout',
    nodes: [
      { ref: 'e1', role: 'textbox', name: 'Card number' },
      { ref: 'e2', role: 'button', name: 'Pay 50,000 won' },
    ],
  })
  return fake
}

const codeRounds = (code: string): TurnEvent[][] => [
  [
    { kind: 'tool_call', call: { id: 'c1', name: 'code', args: { code } } },
    { kind: 'turn_end', stop: 'tool' },
  ],
  [{ kind: 'turn_end', stop: 'done' }],
]

describe('Agentd.send: engine + code hand + bridges', () => {
  it('runs a code snippet that snapshots the page and returns the snapshot to the brain', async () => {
    const bridges = makeFakeBridges()
    const agentd = new Agentd({
      brain: scriptedBrain(codeRounds('JSON.stringify(await page.snapshot())')),
      bridges,
    })

    const events: string[] = []
    const result = await agentd.send('what is on this page?', { onEvent: (e) => events.push(e.type) })

    expect(result.stop).toBe('done')
    expect(bridges.calls).toContain('page.snapshot')
    const toolResult = result.transcript.find((t) => t.kind === 'tool_result')
    const content = toolResult?.kind === 'tool_result' ? toolResult.result.content : ''
    expect(content).toContain('https://example.com/login')
    expect(content).toContain('Sign in')
    // the whole thing streamed through onEvent
    expect(events).toContain('tool_call')
    expect(events).toContain('tool_result')
    // a read-only turn needs no gate decision and no approval
    expect(result.gateDecisions).toHaveLength(0)
    expect(result.approvalsNeeded).toHaveLength(0)
  })

  it('mockBrain with no tool call ends the turn cleanly', async () => {
    const agentd = new Agentd({ brain: mockBrain(), bridges: makeFakeBridges() })
    const result = await agentd.send('hello')
    expect(result.stop).toBe('done')
    expect(result.transcript.some((t) => t.kind === 'text')).toBe(true)
  })
})

describe('Agentd: pay at level ask -> phone-signed approval', () => {
  it('surfaces an approvalNeeded with an ActionEnvelope, verifies a correct signature, rejects a wrong one', async () => {
    const device = generateDeviceKeyPair()
    const agentd = new Agentd({
      brain: scriptedBrain(codeRounds('await page.snapshot(); await page.click("e2")')),
      bridges: payBridges(),
      level: 'ask',
      devicePublicKeyPem: device.publicKeyPem,
    })

    const result = await agentd.send('pay for the order')

    // the pay action did not run; it surfaced as a signable approval bound to the exact action
    expect(result.approvalsNeeded).toHaveLength(1)
    const [card] = result.approvalsNeeded
    if (!card) throw new Error('expected an approval card')
    expect(card.tier).toBe('pay')
    expect(card.amountKrw).toBe(50000)
    expect(card.envelope.tier).toBe('pay')
    expect(card.hash).toMatch(/^[0-9a-f]{64}$/)
    // it is registered as pending
    expect(agentd.pending().map((p) => p.hash)).toContain(card.hash)

    // a wrong signature (over a tampered envelope) is rejected: verify recomputes the hash from the stored envelope
    const tampered = { ...card.envelope, amountKrw: 1 }
    const badSig = signApproval(tampered, device.privateKeyPem)
    const bad = agentd.approve(card.hash, badSig)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toBe('bad-signature')
    // still pending after a failed attempt
    expect(agentd.isApproved(card.hash)).toBe(false)

    // the correct signature over the exact envelope verifies, consumes, and records the approval
    const goodSig = signApproval(card.envelope, device.privateKeyPem)
    const ok = agentd.approve(card.hash, goodSig)
    expect(ok.ok).toBe(true)
    expect(agentd.isApproved(card.hash)).toBe(true)
    // single-use: the same signature cannot be replayed
    const replay = agentd.approve(card.hash, goodSig)
    expect(replay.ok).toBe(false)
  })

  it('rejects an approval when no device key is registered', async () => {
    const agentd = new Agentd({
      brain: scriptedBrain(codeRounds('await page.snapshot(); await page.click("e2")')),
      bridges: payBridges(),
      level: 'ask',
    })
    const result = await agentd.send('pay for the order')
    const [card] = result.approvalsNeeded
    if (!card) throw new Error('expected an approval card')
    const res = agentd.approve(card.hash, 'whatever')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('no-device-key')
  })
})

describe('Agentd: full-auto pay, known merchant under the cap -> notify and run', () => {
  it('records a notice and lets the action run (no approval)', async () => {
    // Detect the pay step from the page snapshot (defaultClassify reads the node name), then add what only the daemon
    // knows: this payee is known and the amount is under the onboarding cap.
    const classify: ActionClassifier = (action, ctx) => {
      const base = defaultClassify(action, ctx)
      return base.tier === 'pay' ? { ...base, merchantKnown: true, underCap: true } : base
    }

    const bridges = payBridges()
    const agentd = new Agentd({
      brain: scriptedBrain(codeRounds('await page.snapshot(); await page.click("e2")')),
      bridges,
      level: 'full',
      classify,
    })

    const notices: string[] = []
    const result = await agentd.send('pay for the order', {
      onEvent: (e) => e.type === 'notice' && notices.push(e.text),
    })

    expect(result.approvalsNeeded).toHaveLength(0)
    expect(result.blocked).toHaveLength(0)
    // the action ran: the fake page recorded the click
    expect((bridges as ReturnType<typeof makeFakeBridges>).calls).toContain('page.click:e2')
    // and a notice was recorded for the after-the-fact notification
    expect(result.notices.length).toBeGreaterThan(0)
    expect(notices.length).toBeGreaterThan(0)
    const gate = result.gateDecisions.find((g) => g.tier === 'pay')
    expect(gate?.decision).toBe('notify')
  })
})
