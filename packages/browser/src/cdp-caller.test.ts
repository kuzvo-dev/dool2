import { afterEach, describe, expect, it } from 'vitest'
import { CdpBrowserCaller, type CdpBrowserLike, type CdpPageLike } from './cdp-caller.js'

// The daemon's SNAP_ROLES (apps/daemon/src/region/kr/browser.ts) and parseRefs regex, inlined so this package test
// stays independent. A snapshot's text must carry marks this matches.
const SNAP_ROLES = '링크|버튼|입력칸|검색칸|비밀번호칸|체크박스|라디오|스위치|탭|메뉴|선택지|선택 상자|항목'
function parseRefs(text: string): Map<string, { role: string; name: string }> {
  const re = new RegExp(`\\[(e\\d+) (${SNAP_ROLES})(?: "([^"]*)")?[^\\]]*\\]`, 'g')
  const refs = new Map<string, { role: string; name: string }>()
  for (const m of text.matchAll(re)) refs.set(m[1] as string, { role: m[2] ?? '', name: m[3] ?? '' })
  return refs
}

const SNAP_TEXT =
  '# 두리 쇼핑\n여기에서 찾아보세요 [e1 검색칸 "검색어"] [e2 버튼 "검색"]\n약관 동의 [e3 체크박스 "동의"] [e4 링크 "자세히"]'

class FakePage implements CdpPageLike {
  readonly targetId: string
  closed = false
  readonly sent: { method: string; params?: Record<string, unknown> }[] = []
  readonly navigated: string[] = []
  constructor(
    id: string,
    private readonly opts: { url: string; title: string; snapshot?: string; screenshot?: string },
  ) {
    this.targetId = id
  }
  async send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.sent.push({ method, params })
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1' } } } as unknown as T
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 } as unknown as T
    if (method === 'Runtime.callFunctionOn')
      return { result: { value: this.opts.snapshot ?? '' } } as unknown as T
    if (method === 'Page.captureScreenshot')
      return { data: this.opts.screenshot ?? 'JPEGDATA' } as unknown as T
    return {} as T
  }
  async navigate(url: string): Promise<unknown> {
    this.navigated.push(url)
    return {}
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    if (expression.includes('readyState')) return true as unknown as T
    if (expression.includes('location.href'))
      return { url: this.opts.url, title: this.opts.title } as unknown as T
    return undefined as unknown as T
  }
  async close(): Promise<unknown> {
    this.closed = true
    return {}
  }
}

class FakeBrowser implements CdpBrowserLike {
  running = true
  readonly pages: FakePage[] = []
  private n = 0
  constructor(private readonly make: (i: number) => FakePage) {}
  async openPage(): Promise<CdpPageLike> {
    const p = this.make(this.n++)
    this.pages.push(p)
    return p
  }
  async close(): Promise<void> {
    this.running = false
  }
}

function caller(make: (i: number) => FakePage) {
  const browser = new FakeBrowser(make)
  const c = new CdpBrowserCaller({ dataDir: '/tmp/dool2-test', launch: async () => browser })
  return { c, browser }
}

describe('CdpBrowserCaller', () => {
  it('open assigns incrementing tab ids and navigates', async () => {
    const { c, browser } = caller(
      (i) => new FakePage(`T${i}`, { url: `https://example.com/${i}`, title: `Page ${i}` }),
    )
    const a = (await c.call('open', { url: 'https://example.com/0' })) as { tabId: number }
    const b = (await c.call('open', { url: 'https://example.com/1' })) as { tabId: number }
    expect(a.tabId).toBe(1)
    expect(b.tabId).toBe(2)
    expect(browser.pages[0]?.navigated).toEqual(['https://example.com/0'])
    expect(browser.pages[1]?.navigated).toEqual(['https://example.com/1'])
  })

  it('snapshot returns the extension shape and emits marks parseRefs matches', async () => {
    const { c } = caller(
      (i) => new FakePage(`T${i}`, { url: 'https://shop.test/', title: '두리 쇼핑', snapshot: SNAP_TEXT }),
    )
    const { tabId } = (await c.call('open', { url: 'https://shop.test/' })) as { tabId: number }
    const snap = (await c.call('snapshot', { tabId, maxChars: 40_000 })) as {
      tabId: number
      url: string
      title: string
      text: string
      truncated: boolean
      captcha: boolean
    }
    expect(snap.tabId).toBe(tabId)
    expect(snap.url).toBe('https://shop.test/')
    expect(snap.title).toBe('두리 쇼핑')
    expect(snap.captcha).toBe(false)
    expect(snap.truncated).toBe(false)
    const refs = parseRefs(snap.text)
    expect(refs.get('e1')).toEqual({ role: '검색칸', name: '검색어' })
    expect(refs.get('e2')).toEqual({ role: '버튼', name: '검색' })
    expect(refs.get('e3')).toEqual({ role: '체크박스', name: '동의' })
    expect(refs.get('e4')).toEqual({ role: '링크', name: '자세히' })
  })

  it('snapshot truncates to maxChars and flags it', async () => {
    const long = `${'x'.repeat(50)} [e1 버튼 "ok"]`
    const { c } = caller((i) => new FakePage(`T${i}`, { url: 'https://a.test/', title: 'a', snapshot: long }))
    const { tabId } = (await c.call('open', { url: 'https://a.test/' })) as { tabId: number }
    const snap = (await c.call('snapshot', { tabId, maxChars: 10 })) as { text: string; truncated: boolean }
    expect(snap.text.length).toBe(10)
    expect(snap.truncated).toBe(true)
  })

  it('snapshot uses an isolated world (no Runtime.enable on the page)', async () => {
    const { c, browser } = caller(
      (i) => new FakePage(`T${i}`, { url: 'https://a.test/', title: 'a', snapshot: SNAP_TEXT }),
    )
    const { tabId } = (await c.call('open', { url: 'https://a.test/' })) as { tabId: number }
    await c.call('snapshot', { tabId })
    const methods = browser.pages[0]?.sent.map((s) => s.method) ?? []
    expect(methods).toContain('Page.createIsolatedWorld')
    expect(methods).toContain('Runtime.callFunctionOn')
    expect(methods).not.toContain('Runtime.enable')
  })

  it('screenshot returns jpeg data with url and title', async () => {
    const { c } = caller(
      (i) => new FakePage(`T${i}`, { url: 'https://p.test/', title: 'Pic', screenshot: 'BASE64JPEG' }),
    )
    const { tabId } = (await c.call('open', { url: 'https://p.test/' })) as { tabId: number }
    const shot = (await c.call('screenshot', { tabId })) as {
      data: string
      mime: string
      url: string
      title: string
    }
    expect(shot).toEqual({ data: 'BASE64JPEG', mime: 'image/jpeg', url: 'https://p.test/', title: 'Pic' })
  })

  it('tabs lists open tabs with an active flag', async () => {
    const { c } = caller((i) => new FakePage(`T${i}`, { url: `https://t.test/${i}`, title: `T${i}` }))
    await c.call('open', { url: 'https://t.test/0' })
    const second = (await c.call('open', { url: 'https://t.test/1' })) as { tabId: number }
    const list = (await c.call('tabs')) as {
      tabs: { tabId: number; url: string; title: string; active: boolean }[]
    }
    expect(list.tabs.map((t) => t.tabId)).toEqual([1, 2])
    expect(list.tabs.find((t) => t.tabId === second.tabId)?.active).toBe(true)
    expect(list.tabs.find((t) => t.tabId === 1)?.active).toBe(false)
  })

  it('focus is a no-op that returns an empty object', async () => {
    const { c } = caller((i) => new FakePage(`T${i}`, { url: 'https://f.test/', title: 'f' }))
    const { tabId } = (await c.call('open', { url: 'https://f.test/' })) as { tabId: number }
    expect(await c.call('focus', { tabId })).toEqual({})
  })

  it('close removes the tab from the registry', async () => {
    const { c, browser } = caller((i) => new FakePage(`T${i}`, { url: 'https://c.test/', title: 'c' }))
    const { tabId } = (await c.call('open', { url: 'https://c.test/' })) as { tabId: number }
    await c.call('close', { tabId })
    expect(browser.pages[0]?.closed).toBe(true)
    await expect(c.call('snapshot', { tabId })).rejects.toThrow(/No tab/)
  })

  it('throws a clear error naming an unsupported command', async () => {
    const { c } = caller((i) => new FakePage(`T${i}`, { url: 'https://u.test/', title: 'u' }))
    await expect(c.call('click', { tabId: 1, ref: 'e1' })).rejects.toThrow(/click/)
  })

  it('status reports connected so the daemon treats the browser as present', () => {
    const { c } = caller((i) => new FakePage(`T${i}`, { url: 'https://s.test/', title: 's' }))
    expect(c.status.connected).toBe(true)
  })
})

// Opt-in: downloads and launches the real Chromium, opens example.com, asserts the snapshot sees the page and a ref mark.
// Kept out of CI (network + a browser download); run with DOOL2_BUILTIN_IT=1.
const IT = process.env.DOOL2_BUILTIN_IT === '1' ? describe : describe.skip
IT('CdpBrowserCaller integration (real Chromium)', () => {
  const dataDir = '/tmp/dool2-builtin-it'
  let c: CdpBrowserCaller | undefined
  afterEach(async () => {
    await c?.closeBrowser()
    c = undefined
  })

  it('opens example.com and snapshots text with a ref mark', async () => {
    c = new CdpBrowserCaller({ dataDir })
    const { tabId } = (await c.call('open', { url: 'https://example.com/' }, 60_000)) as { tabId: number }
    const snap = (await c.call('snapshot', { tabId, maxChars: 40_000 })) as { text: string; title: string }
    expect(snap.text.toLowerCase()).toContain('example')
    expect(snap.text).toMatch(/\[e\d+ /)
  }, 120_000)
})
