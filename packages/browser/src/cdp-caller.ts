// Dool2's own browser, part 3: the daemon's browser caller backed by the downloaded hidden Chromium, no extension (ADR 0046).
//
// The daemon's browser tools talk to one object with `call(cmd, args, timeoutMs)` (see BrowserCaller in apps/daemon). Until
// now that was the extension bridge (bridge.ts). This caller answers the same way, but drives Dool2's own Chromium over the
// DevTools pipe (chromium-launch.ts). It keeps a tab registry mapping a numeric tabId to a ChromiumPage, assigning
// incrementing ids the way the extension does, so the daemon's parseRefs and result shapes keep working unchanged.
//
// This slice adds INTERACTION on top of read-only browsing: click (by ref or by a point), type, press (keys), hover, scroll,
// navigate/back and pdf (Page.printToPDF — cleaner than a print dialog, nothing pops up). A ref `eN` from a snapshot is
// resolved back to its element by re-running the very same DOM walk in a fresh isolated world and stopping at the Nth
// interactive element (findNth below), so the counting that assigns `eN` and the counting that finds it never diverge.
// Still not here (they throw a clear error naming the command): vault fill, dropdown options/choose, element shots, form
// read, frames and popup adoption — a full login→lookup→PDF needs those.
import type { Lang } from '@dool2/i18n'
import { ChromiumInstall, chromiumPaths } from './chromium.js'
import { launchChromium } from './chromium-launch.js'
import { SNAP_ROLE_WORDS } from './locales/snapshot.js'

/** A page of Dool2's browser, as this caller uses it (ChromiumPage satisfies it; tests inject a stub) */
export interface CdpPageLike {
  readonly targetId: string
  /** The flat-session id of this page (for matching DevTools events to a tab). ChromiumPage has it; a stub may omit it */
  readonly sessionId?: string
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
  /** DevTools events (method, params, sessionId); returns an unsubscribe. Optional: a stub may leave it out */
  onEvent?(fn: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void
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

/** Commands this caller answers. Others throw until a later PR */
const SUPPORTED = [
  'open',
  'tabs',
  'focus',
  'close',
  'snapshot',
  'screenshot',
  'navigate',
  'back',
  'click',
  'input',
  'type',
  'press',
  'hover',
  'scroll',
  'pdf',
] as const

/** A site dialog, as the daemon's SiteDialog expects it (browser-tools.ts) */
interface SiteDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  url: string
  defaultPrompt?: string
}

interface Tab {
  page: CdpPageLike
  url: string
  title: string
  /** JS dialogs this caller closed by itself since the last snapshot (reported so the daemon/AI can react) */
  dialogNotes?: SiteDialog[]
}

/**
 * Shared in-page helpers: the role test, the visibility test and findNth. Both the snapshot walk and the ref resolver embed
 * this, so the DFS that assigns `eN` and the DFS that finds eN count interactive elements in the exact same order. `R` (the
 * Korean role words) is a parameter of whatever function embeds this. findNth returns the Nth interactive element's node
 * (never leaves the page — the embedding function reads from it and returns primitives only).
 */
const WALK_HELPERS = `
  var SKIP = {script:1, style:1, noscript:1, template:1, svg:1, head:1, iframe:1};
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
  function visible(el){
    var st = el.ownerDocument.defaultView.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  }
  function findNth(target){
    var n = 0, hit = null;
    function go(node){
      if (hit || node.nodeType !== 1) return;
      var el = node, tag = el.tagName.toLowerCase();
      if (SKIP[tag] || !visible(el)) return;
      if (roleOf(el)){ if (++n === target) hit = el; return; }
      for (var c = el.firstChild; c; c = c.nextSibling) go(c);
    }
    if (document.body) go(document.body);
    return hit;
  }
`

/**
 * The DOM walk that builds a snapshot. Runs in an isolated world (no Runtime.enable on the page), returns the page text with
 * inline ref marks `[eN role "name"]` whose role words match the daemon's SNAP_ROLES. Interactive elements get a stable eN for
 * this snapshot; names come from aria-label/title/alt/value/text (trimmed, quotes → single, capped). Password field values are
 * never emitted. A heading/line structure is enough (no frame recursion yet).
 */
const SNAPSHOT_FN = `function(maxChars, R){
  ${WALK_HELPERS}
  var n = 0, out = '';
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
  function block(el){
    var d = el.ownerDocument.defaultView.getComputedStyle(el).display;
    return d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' || d === 'table' || d === 'table-row';
  }
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

/** Resolve a ref: find the Nth interactive element, scroll it into view, and report its centre and kind (for a click) */
const CLICK_PREP_FN = `function(target, R){
  ${WALK_HELPERS}
  var el = findNth(target);
  if (!el) return { found: false };
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  var r = el.getBoundingClientRect();
  return {
    found: true,
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    w: r.width,
    h: r.height,
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute('type') || '').toLowerCase(),
  };
}`

/** Resolve a ref for typing: find the Nth element, scroll it in, focus it, and select any existing value so insertText replaces it */
const TYPE_PREP_FN = `function(target, R){
  ${WALK_HELPERS}
  var el = findNth(target);
  if (!el) return { found: false };
  try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
  try { el.focus(); } catch (e) {}
  var tag = el.tagName.toLowerCase();
  var type = (el.getAttribute('type') || '').toLowerCase();
  var textField = (tag === 'input' || tag === 'textarea');
  if (textField && typeof el.select === 'function'){ try { el.select(); } catch (e) {} }
  return { found: true, tag: tag, type: type, textField: textField, password: type === 'password' };
}`

/** Scroll the page (or a ref into view) and report how far it moved, for the daemon's scroll note */
const SCROLL_FN = `function(target, dir, R){
  ${WALK_HELPERS}
  var el = target > 0 ? findNth(target) : null;
  var before = window.scrollY || window.pageYOffset || 0;
  var doc = document.documentElement;
  var max = Math.max(0, (doc.scrollHeight || document.body.scrollHeight || 0) - window.innerHeight);
  if (el){ try { el.scrollIntoView({ block: 'center' }); } catch (e) {} }
  else { window.scrollBy(0, (dir === 'up' ? -1 : 1) * Math.round(window.innerHeight * 0.9)); }
  var after = window.scrollY || window.pageYOffset || 0;
  return {
    target: el ? 'box' : 'page',
    before: Math.round(before),
    after: Math.round(after),
    max: Math.round(max),
    atEnd: after >= max - 2,
  };
}`

/** Keys the daemon's browser_press sends. Each becomes an Input.dispatchKeyEvent down+up */
const KEY_INFO: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

/** The index of a page ref like "e12" → 12 (0 if it is not an eN ref) */
function refIndex(ref: string): number {
  const m = /^e(\d+)$/.exec(ref)
  return m ? Number(m[1]) : 0
}

/** How many printed pages a PDF holds (counts /Type /Page objects; at least 1). For the human note only */
function countPdfPages(buf: Buffer): number {
  const s = buf.toString('latin1')
  const m = s.match(/\/Type\s*\/Page[^s]/g)
  return m && m.length > 0 ? m.length : 1
}

export class CdpBrowserCaller {
  /** For the daemon's handoff check: the built-in browser is always "connected" (no extension to be offline) */
  readonly status = { connected: true } as const

  private readonly install: ChromiumInstall
  private readonly lang: () => Lang
  private readonly doLaunch: () => Promise<CdpBrowserLike>
  private browser?: CdpBrowserLike
  private launching?: Promise<CdpBrowserLike>
  private readonly tabs = new Map<number, Tab>()
  /** sessionId → tabId, so a DevTools dialog event is matched to its tab */
  private readonly bySession = new Map<string, number>()
  private unsubEvents?: () => void
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
      case 'navigate':
        return this.navigate(args, timeoutMs)
      case 'back':
        return this.back(args, timeoutMs)
      case 'click':
        return this.click(args, timeoutMs)
      case 'input':
        return this.input(args, timeoutMs)
      case 'type':
        return this.type(args, timeoutMs)
      case 'press':
        return this.press(args, timeoutMs)
      case 'hover':
        return this.hover(args, timeoutMs)
      case 'scroll':
        return this.scroll(args, timeoutMs)
      case 'pdf':
        return this.pdf(args, timeoutMs)
      default:
        throw new Error(
          `Dool2's built-in browser cannot "${cmd}" yet. It can so far: ${SUPPORTED.join(', ')}. ` +
            `Vault fill, dropdown options, frames and popups arrive in a later update.`,
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
        this.watchDialogs(b)
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

  /** Closes JS dialogs by itself so a stray alert/confirm never hangs the page, and remembers each for the next snapshot */
  private watchDialogs(b: CdpBrowserLike): void {
    this.unsubEvents?.()
    this.unsubEvents = b.onEvent?.((method, params, sessionId) => {
      if (method !== 'Page.javascriptDialogOpening' || !sessionId) return
      const tabId = this.bySession.get(sessionId)
      const tab = tabId === undefined ? undefined : this.tabs.get(tabId)
      if (!tab) return
      const rawType = String(params.type ?? 'alert')
      const type = (
        ['alert', 'confirm', 'prompt', 'beforeunload'].includes(rawType) ? rawType : 'alert'
      ) as SiteDialog['type']
      const dialog: SiteDialog = {
        type,
        message: String(params.message ?? ''),
        url: String(params.url ?? tab.url),
        ...(typeof params.defaultPrompt === 'string' ? { defaultPrompt: params.defaultPrompt } : {}),
      }
      tab.dialogNotes = [...(tab.dialogNotes ?? []), dialog]
      // Dismiss (cancel) by default — a confirm that proceeds is a decision for the daemon's gate; a leave-page prompt is
      // accepted so navigation is not stuck
      const accept = type === 'beforeunload'
      tab.page.send('Page.handleJavaScriptDialog', { accept }).catch(() => {})
    })
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
    // Page is enabled so this caller hears javascript dialogs opening (Runtime stays off — sites can notice Runtime.enable)
    await page.send('Page.enable').catch(() => {})
    const tabId = this.nextTabId++
    const tab: Tab = { page, url, title: '' }
    this.tabs.set(tabId, tab)
    if (page.sessionId) this.bySession.set(page.sessionId, tabId)
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
      if (tab.page.sessionId) this.bySession.delete(tab.page.sessionId)
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
    dialogNotes?: SiteDialog[]
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
    const notes = tab.dialogNotes
    tab.dialogNotes = undefined
    return {
      tabId: id,
      url: tab.url,
      title: tab.title,
      text,
      truncated: (full ?? '').length > maxChars,
      captcha: false,
      ...(notes && notes.length ? { dialogNotes: notes } : {}),
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

  private async navigate(args: Record<string, unknown>, timeoutMs?: number): Promise<{ url: string }> {
    const tab = this.tab(args)
    await tab.page.navigate(String(args.url ?? 'about:blank'))
    await this.waitReady(tab.page, timeoutMs ?? 30_000)
    await this.refresh(tab)
    return { url: tab.url }
  }

  private async back(args: Record<string, unknown>, timeoutMs?: number): Promise<{ url: string }> {
    const tab = this.tab(args)
    await tab.page.evaluate('history.back()').catch(() => {})
    await this.waitReady(tab.page, timeoutMs ?? 15_000)
    await this.refresh(tab)
    return { url: tab.url }
  }

  private async click(
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ url?: string; delivered?: boolean }> {
    const tab = this.tab(args)
    const t = timeoutMs ?? 20_000
    // A spot on the last screenshot (0-1000 across the visible part), for icons/canvases with no ref
    if (args.at && typeof args.at === 'object') {
      const at = args.at as { x?: unknown; y?: unknown }
      const px = Number(at.x)
      const py = Number(at.y)
      if (!(px >= 0 && px <= 1000 && py >= 0 && py <= 1000))
        throw new Error('click at takes x and y from 0 to 1000 across the visible part of the tab.')
      const vp = await tab.page
        .evaluate<{ w: number; h: number }>(`({ w: window.innerWidth, h: window.innerHeight })`, 8_000)
        .catch(() => ({ w: 0, h: 0 }))
      if (!vp.w || !vp.h) throw new Error('Could not read the tab size to place that point click.')
      await this.dispatchClick(tab.page, (px / 1000) * vp.w, (py / 1000) * vp.h, t)
      await this.settle(tab)
      return { url: tab.url }
    }
    const ref = String(args.ref ?? '')
    const n = refIndex(ref)
    if (!n) throw new Error(`"${ref}" is not a page ref (eN) from the last snapshot; read the page first.`)
    const prep = await this.evalInWorld<{ found?: boolean; x?: number; y?: number; w?: number; h?: number }>(
      tab.page,
      CLICK_PREP_FN,
      [n, SNAP_ROLE_WORDS],
      t,
    )
    if (!prep?.found || typeof prep.x !== 'number' || typeof prep.y !== 'number')
      throw new Error(`Ref ${ref} is not on the page any more; read it again (browser_read).`)
    const delivered = (prep.w ?? 0) > 0 && (prep.h ?? 0) > 0
    await this.dispatchClick(tab.page, prep.x, prep.y, t)
    await this.settle(tab)
    return { url: tab.url, ...(delivered ? {} : { delivered: false }) }
  }

  /** Point input the daemon sends for point clicks and image-keypad taps: raw CSS pixels on the tab */
  private async input(args: Record<string, unknown>, timeoutMs?: number): Promise<{ url?: string }> {
    const tab = this.tab(args)
    const action = String(args.action ?? 'tap')
    if (action !== 'tap') throw new Error(`Dool2's built-in browser input supports "tap" (got "${action}").`)
    const x = Number(args.x)
    const y = Number(args.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('input tap needs x and y in pixels.')
    await this.dispatchClick(tab.page, x, y, timeoutMs ?? 20_000)
    await this.settle(tab)
    return { url: tab.url }
  }

  private async type(args: Record<string, unknown>, timeoutMs?: number): Promise<{ url?: string }> {
    const tab = this.tab(args)
    const t = timeoutMs ?? 20_000
    const ref = String(args.ref ?? '')
    const n = refIndex(ref)
    if (!n) throw new Error(`"${ref}" is not a page ref (eN); read the page first.`)
    const prep = await this.evalInWorld<{ found?: boolean }>(tab.page, TYPE_PREP_FN, [n, SNAP_ROLE_WORDS], t)
    if (!prep?.found) throw new Error(`Ref ${ref} is not on the page any more; read it again.`)
    // The value is inserted into the focused element; it is never read back, logged or put into an error here
    const text = String(args.text ?? '')
    if (text) await tab.page.send('Input.insertText', { text }, t)
    if (args.submit) await this.pressKey(tab.page, 'Enter', t)
    await this.settle(tab)
    return { url: tab.url }
  }

  private async press(args: Record<string, unknown>, timeoutMs?: number): Promise<{ url?: string }> {
    const tab = this.tab(args)
    await this.pressKey(tab.page, String(args.key ?? ''), timeoutMs ?? 20_000)
    await this.settle(tab)
    return { url: tab.url }
  }

  private async hover(args: Record<string, unknown>, timeoutMs?: number): Promise<{ url?: string }> {
    const tab = this.tab(args)
    const t = timeoutMs ?? 20_000
    const ref = String(args.ref ?? '')
    const n = refIndex(ref)
    if (!n) throw new Error(`"${ref}" is not a page ref (eN); read the page first.`)
    const prep = await this.evalInWorld<{ found?: boolean; x?: number; y?: number }>(
      tab.page,
      CLICK_PREP_FN,
      [n, SNAP_ROLE_WORDS],
      t,
    )
    if (!prep?.found || typeof prep.x !== 'number' || typeof prep.y !== 'number')
      throw new Error(`Ref ${ref} is not on the page any more.`)
    await tab.page.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: prep.x, y: prep.y, button: 'none', buttons: 0 },
      t,
    )
    return { url: tab.url }
  }

  private async scroll(
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{
    url?: string
    scroll: { target: string; before: number; after: number; max: number; atEnd: boolean }
  }> {
    const tab = this.tab(args)
    const dir = args.direction === 'up' ? 'up' : 'down'
    const n = typeof args.ref === 'string' ? refIndex(args.ref) : 0
    const r = await this.evalInWorld<{
      target: string
      before: number
      after: number
      max: number
      atEnd: boolean
    }>(tab.page, SCROLL_FN, [n, dir, SNAP_ROLE_WORDS], timeoutMs ?? 15_000)
    return { url: tab.url, scroll: r }
  }

  private async pdf(
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ data: string; pages: number }> {
    const tab = this.tab(args)
    // Page.printToPDF needs no visible print dialog (cleaner than the extension's print-window dance). ref/only are
    // accepted but not used to clip yet — the whole page is printed
    const r = await tab.page.send<{ data?: string }>(
      'Page.printToPDF',
      { printBackground: true, preferCSSPageSize: true },
      timeoutMs ?? 60_000,
    )
    const data = r.data ?? ''
    return { data, pages: countPdfPages(Buffer.from(data, 'base64')) }
  }

  /** mouseMoved → mousePressed → mouseReleased (left), the way a real click lands */
  private async dispatchClick(page: CdpPageLike, x: number, y: number, timeoutMs: number): Promise<void> {
    await page.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y, button: 'none', buttons: 0 },
      timeoutMs,
    )
    await page.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
      timeoutMs,
    )
    await page.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 },
      timeoutMs,
    )
  }

  /** A key down+up. Named keys (Enter, Tab, arrows…) carry their virtual key code; a single character is sent as text */
  private async pressKey(page: CdpPageLike, name: string, timeoutMs: number): Promise<void> {
    const info = KEY_INFO[name]
    if (info) {
      await page.send(
        'Input.dispatchKeyEvent',
        {
          type: 'keyDown',
          key: info.key,
          code: info.code,
          windowsVirtualKeyCode: info.keyCode,
          nativeVirtualKeyCode: info.keyCode,
          ...(info.text ? { text: info.text } : {}),
        },
        timeoutMs,
      )
      await page.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode },
        timeoutMs,
      )
      return
    }
    if (name.length === 1) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, text: name }, timeoutMs)
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name }, timeoutMs)
      return
    }
    throw new Error(`Dool2's built-in browser does not know the key "${name}".`)
  }

  /** After an action: let the page settle a moment, then re-read its url/title (navigation shows up here) */
  private async settle(tab: Tab): Promise<void> {
    await new Promise((r) => setTimeout(r, 150))
    await this.refresh(tab)
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
    this.bySession.clear()
    this.unsubEvents?.()
    this.unsubEvents = undefined
    const b = this.browser
    this.browser = undefined
    if (b) await b.close().catch(() => {})
  }
}
