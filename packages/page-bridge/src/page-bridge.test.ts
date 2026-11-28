import type { GatedAction } from '@dool2/core'
import { describe, expect, it } from 'vitest'
import { type BrowserCallerLike, createPageBridge, parseNodes } from './index.js'

interface Recorded {
  cmd: string
  args: Record<string, unknown>
}

/** A fake caller: records every call and returns canned data, so no real Chromium launches. */
function fakeCaller(responses: Record<string, unknown> = {}): BrowserCallerLike & { calls: Recorded[] } {
  const calls: Recorded[] = []
  return {
    calls,
    async call(cmd, args = {}) {
      calls.push({ cmd, args })
      if (cmd in responses) return responses[cmd]
      if (cmd === 'open') return { tabId: 7 }
      if (cmd === 'snapshot')
        return {
          url: 'https://example.com/login',
          title: 'Example',
          text: 'Sign in [e1 textbox "Email"] [e2 button "Sign in"]',
        }
      return {}
    },
  }
}

describe('createPageBridge', () => {
  it('goto opens a tab and snapshot returns the page', async () => {
    const caller = fakeCaller()
    const page = createPageBridge(caller)

    await page.goto('https://example.com/login')
    expect(caller.calls[0]).toEqual({ cmd: 'open', args: { url: 'https://example.com/login' } })

    const snap = await page.snapshot()
    expect(caller.calls.find((c) => c.cmd === 'snapshot')?.args).toEqual({ tabId: 7 })
    expect(snap).toEqual({
      url: 'https://example.com/login',
      title: 'Example',
      nodes: [
        { ref: 'e1', role: 'textbox', name: 'Email' },
        { ref: 'e2', role: 'button', name: 'Sign in' },
      ],
    })
  })

  it('a second goto navigates the existing tab instead of opening a new one', async () => {
    const caller = fakeCaller()
    const page = createPageBridge(caller)
    await page.goto('https://example.com/a')
    await page.goto('https://example.com/b')
    expect(caller.calls.filter((c) => c.cmd === 'open')).toHaveLength(1)
    expect(caller.calls).toContainEqual({
      cmd: 'navigate',
      args: { tabId: 7, url: 'https://example.com/b' },
    })
  })

  it('click/type/press map to the right caller commands with the ref', async () => {
    const caller = fakeCaller()
    const page = createPageBridge(caller)
    await page.goto('https://example.com')
    await page.click('e2')
    await page.type('e1', 'hello@example.com')
    await page.press('Enter')
    expect(caller.calls).toContainEqual({ cmd: 'click', args: { tabId: 7, ref: 'e2' } })
    expect(caller.calls).toContainEqual({
      cmd: 'type',
      args: { tabId: 7, ref: 'e1', text: 'hello@example.com' },
    })
    expect(caller.calls).toContainEqual({ cmd: 'press', args: { tabId: 7, key: 'Enter' } })
  })

  it('acting methods report a GatedAction via onAction; snapshot/read does not', async () => {
    const actions: GatedAction[] = []
    const page = createPageBridge(fakeCaller(), { onAction: (a) => void actions.push(a) })
    await page.goto('https://example.com') // acting -> reports
    await page.snapshot() // read -> no report
    await page.click('e2') // acting -> reports
    expect(actions).toEqual([
      { tier: 'act', label: 'goto https://example.com' },
      { tier: 'act', label: 'click e2' },
    ])
  })

  it('fetch (the data path) maps to the fetch command and is not gated', async () => {
    const actions: GatedAction[] = []
    const caller = fakeCaller({
      fetch: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
    })
    const page = createPageBridge(caller, { onAction: (a) => void actions.push(a) })
    await page.goto('https://example.com')
    actions.length = 0 // forget the goto report; we are asserting fetch does not report

    const res = await page.fetch('https://example.com/api', { method: 'GET' })
    expect(res).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    })
    expect(caller.calls).toContainEqual({
      cmd: 'fetch',
      args: { tabId: 7, url: 'https://example.com/api', method: 'GET' },
    })
    expect(actions).toEqual([])
  })

  it('an onAction that throws stops the action before the caller runs', async () => {
    const caller = fakeCaller()
    const page = createPageBridge(caller, {
      onAction: () => {
        throw new Error('blocked by gate')
      },
    })
    await expect(page.goto('https://example.com')).rejects.toThrow('blocked by gate')
    expect(caller.calls.some((c) => c.cmd === 'open')).toBe(false)
  })

  it('a classify override refines the tier (e.g. a pay click)', async () => {
    const actions: GatedAction[] = []
    const page = createPageBridge(fakeCaller(), {
      onAction: (a) => void actions.push(a),
      classify: (method, args) =>
        method === 'click'
          ? { tier: 'pay', label: `pay via ${String(args[0])}` }
          : { tier: 'act', label: method },
    })
    await page.goto('https://example.com')
    await page.click('e9')
    expect(actions[1]).toEqual({ tier: 'pay', label: 'pay via e9' })
  })

  it('acting before any page is open throws a clear error', async () => {
    const page = createPageBridge(fakeCaller())
    await expect(page.snapshot()).rejects.toThrow(/No page is open/)
    await expect(page.click('e1')).rejects.toThrow(/No page is open/)
  })
})

describe('parseNodes', () => {
  it('reads ref/role/name marks, with and without a name, including Korean roles', () => {
    const text = 'hi [e1 링크] mid [e2 button "OK"] end [e3 textbox "이메일"]'
    expect(parseNodes(text)).toEqual([
      { ref: 'e1', role: '링크' },
      { ref: 'e2', role: 'button', name: 'OK' },
      { ref: 'e3', role: 'textbox', name: '이메일' },
    ])
  })

  it('returns an empty list when there are no marks', () => {
    expect(parseNodes('just some text')).toEqual([])
  })

  it('reads frame-qualified refs (fMeN) alongside top-document refs', () => {
    const text = 'Sign in [e1 button "Open"]\n[frame f1]\n[f1e1 입력칸 "아이디"] [f1e2 비밀번호칸]'
    expect(parseNodes(text)).toEqual([
      { ref: 'e1', role: 'button', name: 'Open' },
      { ref: 'f1e1', role: '입력칸', name: '아이디' },
      { ref: 'f1e2', role: '비밀번호칸' },
    ])
  })
})

// Opt-in integration against a real CdpBrowserCaller (real hidden Chromium). Skipped in CI; set DOOL2_BRIDGE_IT=1
// to run. Downloads Chromium on first use, so it can be slow.
describe.skipIf(process.env.DOOL2_BRIDGE_IT !== '1')('integration: real hidden Chromium', () => {
  it('goto example.com and snapshot contains the page', async () => {
    const [{ CdpBrowserCaller }, os, path, fs] = await Promise.all([
      import('@dool2/browser'),
      import('node:os'),
      import('node:path'),
      import('node:fs'),
    ])
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dool2-bridge-it-'))
    const caller = new CdpBrowserCaller({ dataDir })
    const page = createPageBridge(caller)
    try {
      await page.goto('https://example.com')
      const snap = await page.snapshot()
      expect(snap.url).toContain('example.com')
      expect(snap.title.length).toBeGreaterThan(0)
    } finally {
      await caller.closeBrowser()
    }
  }, 180_000)
})
