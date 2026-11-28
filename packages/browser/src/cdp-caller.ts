// Dool2's own browser, part 3: the daemon's browser caller backed by the downloaded hidden Chromium, no extension (ADR 0046).
//
// The daemon's browser tools talk to one object with `call(cmd, args, timeoutMs)` (see BrowserCaller in apps/daemon). Until
// now that was the extension bridge (bridge.ts). This caller answers the same way, but drives Dool2's own Chromium over the
// DevTools pipe (chromium-launch.ts). It keeps a tab registry mapping a numeric tabId to a ChromiumPage, assigning
// incrementing ids the way the extension does, so the daemon's parseRefs and result shapes keep working unchanged.
//
// First slice (this file): read-only browsing and capture — open, tabs, focus, close, snapshot, screenshot. Anything else
// (click, type, pdf, eval, cdp, input…) throws a clear error naming the command; the daemon reports it. Those arrive in a
// later PR.
import type { Lang } from '@dool2/i18n'
import { ChromiumInstall, chromiumPaths } from './chromium.js'
import { launchChromium } from './chromium-launch.js'
import { SNAP_ROLE_WORDS } from './locales/snapshot.js'

/** A page of Dool2's browser, as this caller uses it (ChromiumPage satisfies it; tests inject a stub) */
export interface CdpPageLike {
  readonly targetId: string
  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>
  navigate(url: string): Promise<unknown>
  evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T>
  close(): Promise<unknown>
}

/** A running Dool2 browser, as this caller uses it (ChromiumBrowser satisfies it; tests inject a stub) */
export interface CdpBrowserLike {
  readonly running: boolean
  openPage(url?: string): Promise<CdpPageLike>
  close(graceMs?: number): Promise<void>
}

export interface CdpBrowserCallerOptions {
  /** Dool2 data folder: the downloaded Chromium and its own profile live here */
  dataDir: string
  /** Language for the install progress/errors people may read */
  lang?: () => Lang
  platform?: NodeJS.Platform
  /** Readies the Chromium build (downloads on first use). Default: a ChromiumInstall for this data folder */
  install?: ChromiumInstall
  /** Starts a browser (swapped in tests). Default: ensure the build, then launch it hidden */
  launch?: () => Promise<CdpBrowserLike>
}

/** Commands this first slice answers. Others throw until the next PR */
const SUPPORTED = ['open', 'tabs', 'focus', 'close', 'snapshot', 'screenshot'] as const

interface Tab {
  page: CdpPageLike
  url: string
  title: string
}

/**
 * The DOM walk that builds a snapshot. Runs in an isolated world (no Runtime.enable on the page), returns the page text with
 * inline ref marks `[eN role "name"]` whose role words match the daemon's SNAP_ROLES. Interactive elements get a stable eN for
 * this snapshot; names come from aria-label/title/alt/value/text (trimmed, quotes → single, capped). Password field values are
 * never emitted. A heading/line structure is enough for the first PR (no frame recursion yet).
 */
const SNAPSHOT_FN = `function(maxChars, R){
  var n = 0, out = '';
  function roleOf(el){
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    var aria = (el.getAttribute('role') || '').toLowerCase();
    if (aria === 'presentation' || aria === 'none') return null;
    if (tag === 'a' && el.hasAttribute('href')) return R.link;
    if (aria === 'link') return R.link;
    if (tag === 'button' || aria === 'button') return R.button;
    if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset' || type === 'image')) return R.button;
    if (tag === 'select' || aria === 'listbox') return R.select;
    if (tag === 'textarea') return R.input;
    if (tag === 'input'){
      if (type === 'hidden') return null;
      if (type === 'password') return R.password;
      if (type === 'search') return R.search;
      if (type === 'checkbox') return R.checkbox;
      if (type === 'radio') return R.radio;
      return R.input;
    }
    if (aria === 'checkbox') return R.checkbox;
    if (aria === 'radio') return R.radio;
    if (aria === 'switch') return R.switch;
    if (aria === 'tab') return R.tab;
    if (aria === 'menuitem' || aria === 'menu') return R.menu;
    if (aria === 'option') return R.option;
    if (aria === 'textbox' || aria === 'searchbox') return aria === 'searchbox' ? R.search : R.input;
    return null;
  }
  function nameOf(el, role){
    var s = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '';
    if (!s && role !== R.password){
      var tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea') s = el.getAttribute('value') || el.getAttribute('placeholder') || '';
    }
    if (!s && role === R.password) s = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    if (!s) s = (el.innerText || el.textContent || '');
    s = String(s).replace(/\\s+/g, ' ').trim().replace(/"/g, "'");
    if (s.length > 80) s = s.slice(0, 79) + '…';
    return s;
  }
  function visible(el){
    var st = el.ownerDocument.defaultView.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  }
  function block(el){
    var d = el.ownerDocument.defaultView.getComputedStyle(el).display;
    return d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' || d === 'table' || d === 'table-row';
  }
  var SKIP = {script:1, style:1, noscript:1, template:1, svg:1, head:1, iframe:1};
  function walk(node){
    if (out.length > maxChars + 2000) return;
    if (node.nodeType === 3){
      var t = node.textContent.replace(/\\s+/g, ' ');
      if (t.trim()) out += t;
      return;
    }
    if (node.nodeType !== 1) return;
    var el = node;
    var tag = el.tagName.toLowerCase();
    if (SKIP[tag]) return;
    if (!visible(el)) return;
    var role = roleOf(el);
    if (role){
      var id = 'e' + (++n);
      var name = nameOf(el, role);
      out += ' [' + id + ' ' + role + (name ? ' "' + name + '"' : '') + '] ';
      return;
    }
    var heading = /^h[1-6]$/.test(tag);
    var isBlock = heading || block(el);
    if (isBlock && out && !/\\n$/.test(out)) out += '\\n';
    if (heading) out += new Array(Number(tag[1]) + 1).join('#') + ' ';
    for (var c = el.firstChild; c; c = c.nextSibling) walk(c);
    if (isBlock && !/\\n$/.test(out)) out += '\\n';
  }
  if (document.body) walk(document.body);
  return out.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
}`

export class CdpBrowserCaller {
  /** For the daemon's handoff check: the built-in browser is always "connected" (no extension to be offline) */
  readonly status = { connected: true } as const

  private readonly install: ChromiumInstall
  private readonly lang: () => Lang
  private readonly doLaunch: () => Promise<CdpBrowserLike>
  private browser?: CdpBrowserLike
  private launching?: Promise<CdpBrowserLike>
  private readonly tabs = new Map<number, Tab>()
  private nextTabId = 1
  private lastTabId?: number

  constructor(opts: CdpBrowserCallerOptions) {
    this.lang = opts.lang ?? (() => 'ko')
    const platform = opts.platform ?? process.platform
    this.install = opts.install ?? new ChromiumInstall({ dataDir: opts.dataDir, platform })
    this.doLaunch =
      opts.launch ??
      (async () => {
        let executable: string
        try {
          executable = await this.install.ensure(this.lang())
        } catch (err) {
          throw new Error(
            `Dool2's browser is not ready yet: ${(err as Error).message}. It downloads on first use; try again in a moment.`,
          )
        }
        const paths = chromiumPaths(opts.dataDir)
        return launchChromium({
          executable,
          profileDir: paths.profile,
          platform,
        }) as Promise<CdpBrowserLike>
      })
  }

  /** The browser caller the daemon uses. Same shape as the extension bridge's call */
  async call(cmd: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    switch (cmd) {
      case 'open':
        return this.open(args, timeoutMs)
      case 'tabs':
        return this.listTabs()
      case 'focus':
        // Hidden windows are never brought forward; nothing to do, but the tab still counts as the one in focus
        if (typeof args.tabId === 'number' && this.tabs.has(args.tabId)) this.lastTabId = args.tabId
        return {}
      case 'close':
        return this.closeTab(args)
      case 'snapshot':
        return this.snapshot(args, timeoutMs)
      case 'screenshot':
        return this.screenshot(args, timeoutMs)
      default:
        throw new Error(
          `Dool2's built-in browser cannot "${cmd}" yet. It can so far: ${SUPPORTED.join(', ')}. ` +
            `Clicking, typing and saving PDFs arrive in the next update.`,
        )
    }
  }

  /** Readies and starts the browser, reusing a running one; concurrent calls share one launch */
  private async getBrowser(): Promise<CdpBrowserLike> {
    if (this.browser?.running) return this.browser
    this.browser = undefined
    if (!this.launching) {
      this.launching = (async () => {
        const b = await this.doLaunch()
        this.browser = b
        return b
      })()
      this.launching
        .finally(() => {
          this.launching = undefined
        })
        .catch(() => {})
    }
    return this.launching
  }

  private tab(args: Record<string, unknown>): Tab {
    const id = Number(args.tabId)
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`No tab ${args.tabId} in Dool2's browser (it may have been closed).`)
    return tab
  }

  private async open(args: Record<string, unknown>, timeoutMs?: number): Promise<{ tabId: number }> {
    const url = String(args.url ?? 'about:blank')
    const browser = await this.getBrowser()
    const page = await browser.openPage('about:blank')
    const tabId = this.nextTabId++
    const tab: Tab = { page, url, title: '' }
    this.tabs.set(tabId, tab)
    this.lastTabId = tabId
    await page.navigate(url)
    await this.waitReady(page, timeoutMs ?? 30_000)
    await this.refresh(tab)
    return { tabId }
  }

  /** Waits for the page to have content: readyState past loading and some body text, or the timeout (then opens anyway) */
  private async waitReady(page: CdpPageLike, timeoutMs: number): Promise<void> {
    const started = Date.now()
    const expr = `(document.readyState !== 'loading' && ((document.body && document.body.innerText) || '').trim().length > 0)`
    for (;;) {
      const ready = await page.evaluate<boolean>(expr, 8_000).catch(() => false)
      if (ready) return
      if (Date.now() - started >= timeoutMs) return
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  /** Refreshes a tab's remembered url and title (best effort) */
  private async refresh(tab: Tab): Promise<void> {
    const got = await tab.page
      .evaluate<{ url: string; title: string }>(`({ url: location.href, title: document.title })`, 8_000)
      .catch(() => undefined)
    if (got) {
      tab.url = got.url || tab.url
      tab.title = got.title || ''
    }
  }

  private async listTabs(): Promise<{
    tabs: { tabId: number; url: string; title: string; active: boolean }[]
  }> {
    const out: { tabId: number; url: string; title: string; active: boolean }[] = []
    for (const [tabId, tab] of this.tabs) {
      await this.refresh(tab)
      out.push({ tabId, url: tab.url, title: tab.title, active: tabId === this.lastTabId })
    }
    return { tabs: out }
  }

  private async closeTab(args: Record<string, unknown>): Promise<Record<string, never>> {
    const id = Number(args.tabId)
    const tab = this.tabs.get(id)
    if (tab) {
      this.tabs.delete(id)
      if (this.lastTabId === id) this.lastTabId = undefined
      await tab.page.close().catch(() => {})
    }
    return {}
  }

  private async snapshot(
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{
    tabId: number
    url: string
    title: string
    text: string
    truncated: boolean
    captcha: boolean
  }> {
    const tab = this.tab(args)
    const id = Number(args.tabId)
    const maxChars = Number.isFinite(Number(args.maxChars)) ? Math.max(0, Number(args.maxChars)) : 40_000
    await this.refresh(tab)
    const full = await this.evalInWorld<string>(
      tab.page,
      SNAPSHOT_FN,
      [maxChars, SNAP_ROLE_WORDS],
      timeoutMs ?? 20_000,
    )
    const text = (full ?? '').slice(0, maxChars)
    return {
      tabId: id,
      url: tab.url,
      title: tab.title,
      text,
      truncated: (full ?? '').length > maxChars,
      captcha: false,
    }
  }

  private async screenshot(
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ data: string; mime: string; url: string; title: string }> {
    const tab = this.tab(args)
    await this.refresh(tab)
    const r = await tab.page.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 50 },
      timeoutMs ?? 20_000,
    )
    return { data: r.data ?? '', mime: 'image/jpeg', url: tab.url, title: tab.title }
  }

  /**
   * Runs a function in a fresh isolated world of the page's main frame and returns its value. Keeps the Runtime domain off
   * the page (sites can notice Runtime.enable); Page.getFrameTree and Page.createIsolatedWorld need no Page.enable
   */
  private async evalInWorld<T>(
    page: CdpPageLike,
    functionDeclaration: string,
    args: unknown[],
    timeoutMs: number,
  ): Promise<T> {
    const { frameTree } = await page.send<{ frameTree: { frame: { id: string } } }>(
      'Page.getFrameTree',
      {},
      timeoutMs,
    )
    const frameId = frameTree?.frame?.id
    const { executionContextId } = await page.send<{ executionContextId: number }>(
      'Page.createIsolatedWorld',
      { frameId, worldName: 'dool2-snapshot' },
      timeoutMs,
    )
    const r = await page.send<{
      result?: { value?: T }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>(
      'Runtime.callFunctionOn',
      {
        functionDeclaration,
        executionContextId,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      },
      timeoutMs,
    )
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'snapshot failed',
      )
    return r.result?.value as T
  }

  /** Closes the browser (daemon shutdown). Downloaded build and profile stay */
  async closeBrowser(): Promise<void> {
    this.tabs.clear()
    const b = this.browser
    this.browser = undefined
    if (b) await b.close().catch(() => {})
  }
}
