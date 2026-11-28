import type { HostBridges, PageSnapshot, VaultItemSummary } from '@dool2/sandbox'
import { describe, expect, it } from 'vitest'
import { createToolRuntime } from './tool-runtime.js'

// A page with a labeled pay button, plus a vault that holds a secret host-side and only ever returns masked
// summaries. `clicks` records real clicks so a test can prove the gate stopped one before it ran. The SECRET string
// is never handed to the sandbox, so it can never appear in a ToolResult — exactly the real vault's contract.
const SECRET = 'hunter2-TOTP-seed-DO-NOT-LEAK'

function makeBridges(): HostBridges & { clicks: string[] } {
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
      // The host-side secret fill: the value is read from the closure and never returned to the sandbox.
      async fill() {
        void SECRET
      },
    },
    vault: {
      async listItems(): Promise<VaultItemSummary[]> {
        return [{ id: 'v1', site: 'shop.example.com', username: 'shopper@example.com', hasTotp: true }]
      },
      async fillLogin() {
        void SECRET
      },
      async fillTotp() {
        void SECRET
      },
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

describe('createToolRuntime handler — the gate', () => {
  it('gates a pay click at ask level: it does not run and the result asks for approval', async () => {
    const bridges = makeBridges()
    const runtime = createToolRuntime({ bridges, level: 'ask' })
    try {
      const result = await runtime.handle({
        id: 'c1',
        name: 'code',
        args: { code: 'await page.snapshot(); await page.click("pay1")' },
      })

      // the click never ran
      expect(bridges.clicks).not.toContain('pay1')

      // the gate upgraded the click to a pay action and required a signature
      expect(runtime.gateDecisions).toHaveLength(1)
      expect(runtime.gateDecisions[0]?.tier).toBe('pay')
      expect(runtime.gateDecisions[0]?.decision).toBe('sign')
      expect(runtime.gateDecisions[0]?.allowed).toBe(false)
      expect(runtime.gateDecisions[0]?.amountKrw).toBe(50000)

      // an approvalNeeded outcome for the daemon, and a tool result the brain reads (never "stop")
      expect(runtime.approvals).toHaveLength(1)
      expect(runtime.approvals[0]?.status).toBe('approvalNeeded')
      expect(result.content).toContain('approval')
      expect(result.content).toContain('did not run')
    } finally {
      runtime.dispose()
    }
  })

  it('runs a plain act and returns the sandbox value', async () => {
    const bridges = makeBridges()
    const runtime = createToolRuntime({ bridges, level: 'ask' })
    try {
      const result = await runtime.handle({
        id: 'c2',
        name: 'code',
        args: { code: 'JSON.stringify(await page.snapshot())' },
      })
      expect(result.isError).toBeFalsy()
      expect(result.content).toContain('Checkout')
    } finally {
      runtime.dispose()
    }
  })
})

describe('createToolRuntime handler — secrets', () => {
  it('never puts a secret in a ToolResult (vault returns only masked summaries)', async () => {
    const bridges = makeBridges()
    const runtime = createToolRuntime({ bridges, level: 'ask' })
    try {
      const listed = await runtime.handle({
        id: 'c3',
        name: 'code',
        args: { code: 'JSON.stringify(await vault.listItems())' },
      })
      // masked fields are visible; the secret is not
      expect(listed.content).toContain('shopper@example.com')
      expect(listed.content).not.toContain(SECRET)

      // a login fill is a host-side act; the value still never crosses into a result
      const filled = await runtime.handle({
        id: 'c4',
        name: 'code',
        args: { code: 'await vault.fillLogin("v1"); "filled"' },
      })
      expect(filled.content).not.toContain(SECRET)
    } finally {
      runtime.dispose()
    }
  })
})
