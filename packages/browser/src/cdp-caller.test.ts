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

// A fake %PDF with two /Type /Page objects, so pdf reports pages: 2
const FAKE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type /Page >>endobj\n2 0 obj<</Type /Page >>endobj\n',
).toString('base64')

interface PageOpts {
  url: string
  title: string
  snapshot?: string
  screenshot?: string
  /** click/hover ref resolve result; set found:false to act as a stale ref */
  prep?: { found: boolean; x?: number; y?: number; w?: number; h?: number }
  /** Runtime.evaluate (the data-path fetch) result: whatever the in-page fetch expression would resolve to */
  fetchResult?: Record<string, unknown>
}

class FakePage implements CdpPageLike {
  readonly targetId: string
  readonly sessionId: string
  closed = false
  readonly sent: { method: string; params?: Record<string, unknown> }[] = []
  readonly navigated: string[] = []
  /** The last expression Runtime.evaluate was asked to run (the data-path fetch), for asserting how fetch runs */
  lastEvalExpr = ''
  constructor(
    id: string,
    private readonly opts: PageOpts,
  ) {
    this.targetId = id
    this.sessionId = `S-${id}`
  }
  async send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.sent.push({ method, params })
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1' } } } as unknown as T
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 } as unknown as T
    if (method === 'Page.printToPDF') return { data: FAKE_PDF } as unknown as T
    if (method === 'Page.captureScreenshot')
      return { data: this.opts.screenshot ?? 'JPEGDATA' } as unknown as T
    if (method === 'Runtime.evaluate') {
      // The data-path fetch runs here (main world). Return the canned in-page shape; no real JS runs.
      this.lastEvalExpr = String(params.expression ?? '')
      return { result: { value: this.opts.fetchResult ?? {} } } as unknown as T
    }
    if (method === 'Runtime.callFunctionOn') {
      const fn = String(params.functionDeclaration ?? '')
      if (fn.includes('maxChars')) return { result: { value: this.opts.snapshot ?? '' } } as unknown as T
      if (fn.includes('textField'))
        return {
          result: {
            value: { found: this.opts.prep?.found ?? true, tag: 'input', type: 'text', textField: true },
          },
        } as unknown as T
      if (fn.includes('scrollBy'))
        return {
          result: { value: { target: 'page', before: 0, after: 800, max: 2000, atEnd: false } },
        } as unknown as T
      // CLICK_PREP_FN (resolve a ref to a point)
      return {
        result: {
          value: this.opts.prep ?? { found: true, x: 100, y: 200, w: 50, h: 20, tag: 'button', type: '' },
        },
      } as unknown as T
    }
    return {} as T
  }
  async navigate(url: string): Promise<unknown> {
    this.navigated.push(url)
    return {}
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    if (expression.includes('readyState')) return true as unknown as T
    if (expression.includes('innerWidth')) return { w: 1000, h: 800 } as unknown as T
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
  private listeners: ((m: string, p: Record<string, unknown>, s?: string) => void)[] = []
  constructor(private readonly make: (i: number) => FakePage) {}
  async openPage(): Promise<CdpPageLike> {
    const p = this.make(this.n++)
    this.pages.push(p)
    return p
  }
  async close(): Promise<void> {
    this.running = false
  }
  onEvent(fn: (m: string, p: Record<string, unknown>, s?: string) => void): () => void {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn)
    }
  }
  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    for (const l of this.listeners) l(method, params, sessionId)
  }
}

function caller(make: (i: number) => FakePage) {
  const browser = new FakeBrowser(make)
  const c = new CdpBrowserCaller({ dataDir: '/tmp/dool2-test', launch: async () => browser })
  return { c, browser }
}

/** The Input.dispatchMouseEvent types a page saw, in order */
function mouseTypes(page: FakePage): string[] {
  return page.sent.filter((s) => s.method === 'Input.dispatchMouseEvent').map((s) => String(s.params?.type))
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

  it('click resolves a ref and dispatches a real left click in order', async () => {
    const { c, browser } = caller((i) => new FakePage(`T${i}`, { url: 'https://x.test/', title: 'x' }))
    const { tabId } = (await c.call('open', { url: 'https://x.test/' })) as { tabId: number }
    await c.call('click', { tabId, ref: 'e2' })
    const page = browser.pages[0] as FakePage
    expect(mouseTypes(page)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    const pressed = page.sent.find((s) => s.params?.type === 'mousePressed')
    expect(pressed?.params).toMatchObject({ button: 'left', x: 100, y: 200 })
  })

  it('point click maps 0-1000 coords onto the viewport', async () => {
    const { c, browser } = caller((i) => new FakePage(`T${i}`, { url: 'https://x.test/', title: 'x' }))
    const { tabId } = (await c.call('open', { url: 'https://x.test/' })) as { tabId: number }
    await c.call('click', { tabId, at: { x: 500, y: 250 } })
    const page = browser.pages[0] as FakePage
    const pressed = page.sent.find((s) => s.params?.type === 'mousePressed')
    // viewport 1000x800 → (500/1000*1000, 250/1000*800) = (500, 200)
    expect(pressed?.params).toMatchObject({ x: 500, y: 200 })
  })

  it('click on a stale ref throws asking to read again', async () => {
    const { c } = caller(
      (i) => new FakePage(`T${i}`, { url: 'https://x.test/', title: 'x', prep: { found: false } }),
    )
    const { tabId } = (await c.call('open', { url: 'https://x.test/' })) as { tabId: number }
    await expect(c.call('click', { tabId, ref: 'e9' })).rejects.toThrow(/not on the page/)
  })

  it('type inserts the text and submit presses Enter', async () => {
    const { c, browser } = caller((i) => new FakePage(`T${i}`, { url: 'https://x.test/', title: 'x' }))
    const { tabId } = (await c.call('open', { url: 'https://x.test/' })) as { tabId: number }
    await c.call('type', { tabId, ref: 'e1', text: 'hello', submit: true })
    const page = browser.pages[0] as FakePage
    const insert = page.sent.find((s) => s.method === 'Input.insertText')
    expect(insert?.params).toEqual({ text: 'hello' })
    const enterDown = page.sent.find(
      (s) =>
        s.method === 'Input.dispatchKeyEvent' && s.params?.type === 'keyDown' && s.params?.key === 'Enter',
    )
    expect(enterDown).toBeTruthy()
  })

  it('press maps named keys to their virtual key code', async () => {
    const { c, browser } = caller((i) => new FakePage(`T${i}`, { url: 'https://x.test/', title: 'x' }))
    const { tabId } = (await c.call('open', { url: 'https://x.test/' })) as { tabId: number }
    await c.call('press', { tabId, key: 'Escape' })
    const page = browser.pages[0] as FakePage
    const down = page.sent.find((s) => s.method === 'Input.dispatchKeyEvent' && s.params?.type === 'keyDown')
    expect(down?.params).toMatchObject({ key: 'Escape', windowsVirtualKeyCode: 27 })
  })

  it('press rejects a key it does not know', async () => {
    const { c } = caller((i) => new FakePage(`T${i}`, { url: 'https://x.test/', title: 'x' }))
    const { tabId } = (await c.call('open', { url: 'https://x.test/' })) as { tabId: number }
    await expect(c.call('press', { tabId, key: 'F13Weird' })).rejects.toThrow(/does not know the key/)
  })

  it('scroll returns the page scroll numbers', async () => {
    const { c } = caller((i) => new FakePage(`T${i}`, { url: 'https://x.test/', title: 'x' }))
    const { tabId } = (await c.call('open', { url: 'https://x.test/' })) as { tabId: number }
    const r = (await c.call('scroll', { tabId, direction: 'down' })) as {
      scroll: { target: string; before: number; after: number; max: number; atEnd: boolean }
    }
    expect(r.scroll).toEqual({ target: 'page', before: 0, after: 800, max: 2000, atEnd: false })
  })

  it('navigate moves the tab to the url', async () => {
    const { c, browser } = caller((i) => new FakePage(`T${i}`, { url: 'https://y.test/', title: 'y' }))
    const { tabId } = (await c.call('open', { url: 'https://y.test/' })) as { tabId: number }
    await c.call('navigate', { tabId, url: 'https://y.test/next' })
    expect(browser.pages[0]?.navigated).toContain('https://y.test/next')
  })

  it('pdf prints to PDF and returns bytes and a page count', async () => {
    const { c, browser } = caller((i) => new FakePage(`T${i}`, { url: 'https://d.test/', title: 'doc' }))
    const { tabId } = (await c.call('open', { url: 'https://d.test/' })) as { tabId: number }
    const r = (await c.call('pdf', { tabId })) as { data: string; pages: number }
    expect(browser.pages[0]?.sent.some((s) => s.method === 'Page.printToPDF')).toBe(true)
    expect(Buffer.from(r.data, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(r.pages).toBe(2)
  })

  it('auto-dismisses a javascript dialog and reports it on the next snapshot', async () => {
    const { c, browser } = caller(
      (i) => new FakePage(`T${i}`, { url: 'https://dlg.test/', title: 'dlg', snapshot: SNAP_TEXT }),
    )
    const { tabId } = (await c.call('open', { url: 'https://dlg.test/' })) as { tabId: number }
    const page = browser.pages[0] as FakePage
    browser.emit(
      'Page.javascriptDialogOpening',
      { type: 'confirm', message: 'Proceed?', url: 'https://dlg.test/' },
      page.sessionId,
    )
    // The dialog was closed (cancelled) so the page does not hang
    const handled = page.sent.find((s) => s.method === 'Page.handleJavaScriptDialog')
    expect(handled?.params).toEqual({ accept: false })
    const snap = (await c.call('snapshot', { tabId })) as { dialogNotes?: { message: string }[] }
    expect(snap.dialogNotes?.[0]?.message).toBe('Proceed?')
    // Reported once, then cleared
    const again = (await c.call('snapshot', { tabId })) as { dialogNotes?: unknown[] }
    expect(again.dialogNotes).toBeUndefined()
  })

  it('fetch runs window.fetch in the page with method/headers/body and credentials:include', async () => {
    const { c, browser } = caller(
      (i) =>
        new FakePage(`T${i}`, {
          url: 'https://shop.test/',
          title: 'shop',
          fetchResult: {
            ok: true,
            status: 200,
            statusText: 'OK',
            url: 'https://shop.test/api',
            headers: {},
            body: 'hi',
          },
        }),
    )
    const { tabId } = (await c.call('open', { url: 'https://shop.test/' })) as { tabId: number }
    await c.call('fetch', {
      tabId,
      url: 'https://shop.test/api',
      method: 'POST',
      headers: { 'x-test': '1' },
      body: '{"q":"hello"}',
    })
    const page = browser.pages[0] as FakePage
    // It used Runtime.evaluate (the page's main world), not an isolated world
    const methods = page.sent.map((s) => s.method)
    expect(methods).toContain('Runtime.evaluate')
    const evalCall = page.sent.find((s) => s.method === 'Runtime.evaluate')
    expect(evalCall?.params).toMatchObject({ returnByValue: true, awaitPromise: true })
    // The expression carries the request as the site's own fetch, with the session riding along
    expect(page.lastEvalExpr).toContain('fetch(')
    expect(page.lastEvalExpr).toContain('"credentials":"include"')
    expect(page.lastEvalExpr).toContain('"method":"POST"')
    expect(page.lastEvalExpr).toContain('"x-test":"1"')
    expect(page.lastEvalExpr).toContain('{\\"q\\":\\"hello\\"}')
    expect(page.lastEvalExpr).toContain('https://shop.test/api')
  })

  it('fetch returns ok/status/body from the page', async () => {
    const { c } = caller(
      (i) =>
        new FakePage(`T${i}`, {
          url: 'https://shop.test/',
          title: 'shop',
          fetchResult: {
            ok: true,
            status: 200,
            statusText: 'OK',
            url: 'https://shop.test/api',
            headers: {},
            body: 'plain text',
          },
        }),
    )
    const { tabId } = (await c.call('open', { url: 'https://shop.test/' })) as { tabId: number }
    const r = (await c.call('fetch', { tabId, url: 'https://shop.test/api' })) as {
      ok: boolean
      status: number
      body: string
      truncated: boolean
      json?: unknown
    }
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toBe('plain text')
    expect(r.truncated).toBe(false)
    expect(r.json).toBeUndefined()
  })

  it('fetch parses json when the content-type is JSON', async () => {
    const { c } = caller(
      (i) =>
        new FakePage(`T${i}`, {
          url: 'https://shop.test/',
          title: 'shop',
          fetchResult: {
            ok: true,
            status: 200,
            statusText: 'OK',
            url: 'https://shop.test/api/orders',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: '{"orders":[1,2,3]}',
          },
        }),
    )
    const { tabId } = (await c.call('open', { url: 'https://shop.test/' })) as { tabId: number }
    const r = (await c.call('fetch', { tabId, url: '/api/orders' })) as { json?: { orders: number[] } }
    expect(r.json).toEqual({ orders: [1, 2, 3] })
  })

  it('fetch on a non-2xx returns ok:false with the status', async () => {
    const { c } = caller(
      (i) =>
        new FakePage(`T${i}`, {
          url: 'https://shop.test/',
          title: 'shop',
          // in-page res.ok is false for 500; the caller passes it through
          fetchResult: {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            url: 'https://shop.test/api',
            headers: {},
            body: 'boom',
          },
        }),
    )
    const { tabId } = (await c.call('open', { url: 'https://shop.test/' })) as { tabId: number }
    const r = (await c.call('fetch', { tabId, url: 'https://shop.test/api' })) as {
      ok: boolean
      status: number
    }
    expect(r.ok).toBe(false)
    expect(r.status).toBe(500)
  })

  it('fetch caps a body over maxBytes and flags it truncated (and skips json on a cut body)', async () => {
    const big = 'x'.repeat(5000)
    const { c } = caller(
      (i) =>
        new FakePage(`T${i}`, {
          url: 'https://shop.test/',
          title: 'shop',
          fetchResult: {
            ok: true,
            status: 200,
            statusText: 'OK',
            url: 'https://shop.test/api',
            headers: { 'content-type': 'application/json' },
            body: big,
          },
        }),
    )
    const { tabId } = (await c.call('open', { url: 'https://shop.test/' })) as { tabId: number }
    const r = (await c.call('fetch', { tabId, url: 'https://shop.test/api', maxBytes: 100 })) as {
      body: string
      truncated: boolean
      json?: unknown
    }
    expect(r.body.length).toBe(100)
    expect(r.truncated).toBe(true)
    expect(r.json).toBeUndefined()
  })

  it('fetch resolves a relative url against the page origin (window.fetch resolves it in the page)', async () => {
    const { c, browser } = caller(
      (i) =>
        new FakePage(`T${i}`, {
          url: 'https://shop.test/account',
          title: 'shop',
          // the page resolved /api/me against its origin; the caller reports whatever res.url the page returned
          fetchResult: {
            ok: true,
            status: 200,
            statusText: 'OK',
            url: 'https://shop.test/api/me',
            headers: {},
            body: 'me',
          },
        }),
    )
    const { tabId } = (await c.call('open', { url: 'https://shop.test/account' })) as { tabId: number }
    const r = (await c.call('fetch', { tabId, url: '/api/me' })) as { url: string }
    // The raw relative url is handed to window.fetch, which resolves it against the document origin
    expect((browser.pages[0] as FakePage).lastEvalExpr).toContain('"/api/me"')
    expect(r.url).toBe('https://shop.test/api/me')
  })

  it('fetch on an unknown tab throws', async () => {
    const { c } = caller((i) => new FakePage(`T${i}`, { url: 'https://shop.test/', title: 'shop' }))
    await expect(c.call('fetch', { tabId: 999, url: 'https://shop.test/api' })).rejects.toThrow(/No tab/)
  })

  it('fetch surfaces an in-page failure as a clear error', async () => {
    const { c } = caller(
      (i) =>
        new FakePage(`T${i}`, {
          url: 'https://shop.test/',
          title: 'shop',
          fetchResult: { __fetchError: 'Failed to fetch' },
        }),
    )
    const { tabId } = (await c.call('open', { url: 'https://shop.test/' })) as { tabId: number }
    await expect(c.call('fetch', { tabId, url: 'https://shop.test/api' })).rejects.toThrow(/Failed to fetch/)
  })

  it('throws a clear error naming an unsupported command', async () => {
    const { c } = caller((i) => new FakePage(`T${i}`, { url: 'https://u.test/', title: 'u' }))
    await expect(c.call('fill', { tabId: 1, ref: 'e1', value: 'x' })).rejects.toThrow(/fill/)
  })

  it('status reports connected so the daemon treats the browser as present', () => {
    const { c } = caller((i) => new FakePage(`T${i}`, { url: 'https://s.test/', title: 's' }))
    expect(c.status.connected).toBe(true)
  })
})

// Opt-in: downloads and launches the real Chromium, drives a tiny data: URL page end to end. Kept out of CI (it downloads a
// browser); run with DOOL2_BUILTIN_IT=1.
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

  it('clicks a button on a data: page and the DOM changes, then prints a PDF', async () => {
    c = new CdpBrowserCaller({ dataDir })
    const html = '<button onclick="document.title=\'clicked\'">Press me</button><p id="p">before</p>'
    const { tabId } = (await c.call(
      'open',
      { url: `data:text/html,${encodeURIComponent(html)}` },
      60_000,
    )) as {
      tabId: number
    }
    const snap = (await c.call('snapshot', { tabId })) as { text: string }
    const ref = snap.text.match(/\[(e\d+) 버튼/)?.[1]
    expect(ref).toBeTruthy()
    await c.call('click', { tabId, ref })
    const after = (await c.call('snapshot', { tabId })) as { title: string }
    expect(after.title).toBe('clicked')
    const pdf = (await c.call('pdf', { tabId })) as { data: string; pages: number }
    expect(Buffer.from(pdf.data, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.pages).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('fetches a relative url from the page under the live session (the data path)', async () => {
    c = new CdpBrowserCaller({ dataDir })
    const { tabId } = (await c.call('open', { url: 'https://example.com/' }, 60_000)) as { tabId: number }
    const r = (await c.call('fetch', { tabId, url: '/' }, 30_000)) as {
      ok: boolean
      status: number
      url: string
      body: string
    }
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(r.url).toContain('example.com')
    expect(r.body.toLowerCase()).toContain('example')
  }, 120_000)
})
