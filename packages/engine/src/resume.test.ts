import { envelopeForAction, envelopeHash } from '@dool2/approvals'
import type { HostBridges, PageSnapshot, VaultItemSummary } from '@dool2/sandbox'
import { describe, expect, it } from 'vitest'
import { runTurn } from './engine.js'
import { scriptedBrain } from './scripted-brain.js'

// One labeled pay button at ref pay1. `clicks` records which refs actually ran, so a test can prove whether the gate
// let the click through.
function makePayBridges(): HostBridges & { clicks: string[] } {
  const clicks: string[] = []
  const snapshot: PageSnapshot = {
    url: 'https://shop.example.com/checkout',
    title: 'Checkout',
    nodes: [{ ref: 'pay1', role: 'button', name: 'Pay 50,000 won' }],
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

// The exact hash the gate computes for the pay click: tier pay (defaultClassify upgrades the click), label from the
// sandbox GatedAction ("click pay1"), amount parsed from the button name. This is what agentd would mint + the phone
// would sign, because both sides go through envelopeForAction.
const PAY_HASH = envelopeHash(envelopeForAction({ tier: 'pay', label: 'click pay1', amountKrw: 50_000 }))

const oneClick = [
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
const twoClicks = [
  {
    kind: 'tool_call' as const,
    call: {
      id: 'c1',
      name: 'code' as const,
      args: { code: 'await page.snapshot(); await page.click("pay1"); await page.click("pay1")' },
    },
  },
  { kind: 'turn_end' as const, stop: 'tool' as const },
]

describe('the resume-after-signature seam in runTurn', () => {
  it('a sign action NOT in the approved set surfaces approvalNeeded whose hash equals approvals.envelopeHash', async () => {
    const bridges = makePayBridges()
    const result = await runTurn(
      { brain: scriptedBrain([oneClick, [{ kind: 'turn_end', stop: 'done' }]]), bridges, level: 'ask' },
      { message: 'buy it' },
    )

    expect(bridges.clicks).not.toContain('pay1') // it did not run
    expect(result.approvals).toHaveLength(1)
    const [outcome] = result.approvals
    expect(outcome?.status).toBe('approvalNeeded')
    // the hash the engine surfaces is exactly what @dool2/approvals produces for this action — single hash source
    expect(outcome?.hash).toBe(PAY_HASH)
    expect(outcome && envelopeHash(outcome.envelope)).toBe(PAY_HASH)
    expect(result.consumedApprovals).toHaveLength(0)
  })

  it('a sign action whose hash IS in the approved set runs, and the gate records it as run/approved', async () => {
    const bridges = makePayBridges()
    const result = await runTurn(
      {
        brain: scriptedBrain([oneClick, [{ kind: 'turn_end', stop: 'done' }]]),
        bridges,
        level: 'ask',
        isApproved: (h) => h === PAY_HASH,
      },
      { message: 'buy it' },
    )

    expect(bridges.clicks).toContain('pay1') // the approved action ran
    expect(result.approvals).toHaveLength(0)
    expect(result.gateDecisions).toHaveLength(1)
    expect(result.gateDecisions[0]?.decision).toBe('run')
    expect(result.gateDecisions[0]?.reason).toBe('approved')
    expect(result.gateDecisions[0]?.allowed).toBe(true)
    expect(result.consumedApprovals).toEqual([PAY_HASH])
  })

  it('is single-use within the turn: the second identical action pauses again', async () => {
    const bridges = makePayBridges()
    const result = await runTurn(
      {
        brain: scriptedBrain([twoClicks, [{ kind: 'turn_end', stop: 'done' }]]),
        bridges,
        level: 'ask',
        isApproved: (h) => h === PAY_HASH,
      },
      { message: 'buy it twice' },
    )

    // the first click ran once; the second was gated again (not run)
    expect(bridges.clicks).toEqual(['pay1'])
    expect(result.consumedApprovals).toEqual([PAY_HASH])
    expect(result.approvals).toHaveLength(1)
    expect(result.approvals[0]?.hash).toBe(PAY_HASH)
  })
})
