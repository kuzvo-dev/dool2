import type { HostBridges, PageSnapshot, VaultItemSummary } from '@dool2/sandbox'
import { describe, expect, it } from 'vitest'
import type { ActionClassifier } from './classify.js'
import { runTurn } from './engine.js'
import { scriptedBrain } from './scripted-brain.js'

// Bridges with one labeled pay button. `clicks` records which refs were actually clicked, so a test can prove the
// gate stopped a click before it ran.
function makePayBridges(): HostBridges & { clicks: string[] } {
  const clicks: string[] = []
  const snapshot: PageSnapshot = {
    url: 'https://shop.example.com/checkout',
    title: 'Checkout',
    nodes: [
      { ref: 'q1', role: 'textbox', name: 'Quantity' },
      { ref: 'pay1', role: 'button', name: 'Pay 50,000 won' },
    ],
  }
  return {
    clicks,
    page: {
      async snapshot() {
        return snapshot
      },
      async fetch() {
        return { status: 200, headers: {}, body: '' }
      },
      async goto() {},
      async click(ref: string) {
        clicks.push(ref)
      },
      async type() {},
      async press() {},
    },
    vault: {
      async listItems(): Promise<VaultItemSummary[]> {
        return []
      },
      async fillLogin() {},
      async fillTotp() {},
    },
    pc: {
      async snapshot() {
        return { app: 'none', nodes: [] }
      },
      async launch() {},
      async click() {},
      async type() {},
    },
    fs: {
      async read() {
        return ''
      },
      async list() {
        return []
      },
      async write() {},
    },
  }
}

const payRound = [
  {
    kind: 'tool_call' as const,
    call: {
      id: 'c1',
      name: 'code' as const,
      args: { code: 'await page.snapshot(); await page.click("pay1")' },
    },
  },
  { kind: 'turn_end' as const, stop: 'tool' as const },
]

describe('autonomy gate inside the code hand', () => {
  it('ask level: a labeled pay click is gated to a signature, blocked, and surfaced as approvalNeeded', async () => {
    const bridges = makePayBridges()
    const result = await runTurn(
      { brain: scriptedBrain([payRound, [{ kind: 'turn_end', stop: 'done' }]]), bridges, level: 'ask' },
      { message: 'buy it' },
    )

    // the click never ran
    expect(bridges.clicks).not.toContain('pay1')

    // the default classifier upgraded the click to a pay action with the amount from the button label
    expect(result.gateDecisions).toHaveLength(1)
    const gate = result.gateDecisions[0]
    expect(gate?.tier).toBe('pay')
    expect(gate?.decision).toBe('sign')
    expect(gate?.allowed).toBe(false)
    expect(gate?.amountKrw).toBe(50000)

    // an approvalNeeded outcome the daemon turns into a phone card
    expect(result.approvals).toHaveLength(1)
    expect(result.approvals[0]?.status).toBe('approvalNeeded')

    // the tool result tells the brain it needs approval (not "stop"), and did not run
    const toolResult = result.transcript.find((t) => t.kind === 'tool_result')
    const content = toolResult?.kind === 'tool_result' ? toolResult.result.content : ''
    expect(content).toContain('approval')
    expect(content).toContain('did not run')
  })

  it('full level with a known merchant under the cap: the pay click notifies and runs', async () => {
    const bridges = makePayBridges()
    // A daemon-shaped classifier: it knows this merchant and that the amount is under the onboarding cap.
    const classify: ActionClassifier = () => ({
      tier: 'pay',
      amountKrw: 50000,
      merchantKnown: true,
      underCap: true,
    })
    const result = await runTurn(
      {
        brain: scriptedBrain([payRound, [{ kind: 'turn_end', stop: 'done' }]]),
        bridges,
        level: 'full',
        classify,
      },
      { message: 'buy it' },
    )

    // the click actually ran
    expect(bridges.clicks).toContain('pay1')

    expect(result.gateDecisions).toHaveLength(1)
    expect(result.gateDecisions[0]?.decision).toBe('notify')
    expect(result.gateDecisions[0]?.allowed).toBe(true)

    // no approval needed, but the user is told after the fact
    expect(result.approvals).toHaveLength(0)
    expect(result.notices).toHaveLength(1)
    expect(result.notices[0]).toContain('pay1')
  })
})
