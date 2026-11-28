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
// Frames are handled: the snapshot walks the top document and each child frame (same-process frames on the page session,
// cross-origin OOPIFs on their own auto-attached session), emitting frame-qualified refs (`f1e2`) that click/type/hover/
// scroll resolve back to the right frame and offset to a top-level point — needed for Korean simple-identity (gov/bank)
// login widgets and payment windows that live inside iframes. Still not here (they throw a clear error naming the command):
// vault fill, dropdown options/choose, element shots, form read and popup adoption.
//
// It also adds the DATA path: `fetch` runs the site's own window.fetch inside the page's main world under the user's
// live session (cookies), so a skill can call a site's internal API instead of clicking through the UI — the biggest
// speed win (click-free reads). See the `fetch` method and fetchExpr below.
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
  /**
   * A DevTools command on a specific flat session (a cross-origin child frame's own session). ChromiumBrowser.send has
   * exactly this shape; a stub may omit it, in which case cross-origin frames are simply not walked.
   */
  send?<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T>
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
  'fetch',
  'screencast',
] as const

/**
 * The data path. Default cap on a fetched body (bytes ≈ chars): 2 MB. Big enough for a site's JSON API response, small
 * enough that one call never pulls an unbounded download over the DevTools pipe. The in-page code caps first (bounded
 * transfer) and the caller re-enforces this defensively. Override per call with args.maxBytes.
 */
const DEFAULT_FETCH_CAP = 2 * 1024 * 1024
/** Default wall-clock for a fetch (the in-page AbortController fires at this; the pipe call waits a touch longer). */
const DEFAULT_FETCH_TIMEOUT = 30_000

/**
 * Frame guards, so a page full of ad/tracker iframes never explodes a snapshot. Depth/breadth caps bound the DOM-walk
 * work; a frame whose owner box is smaller than MIN_FRAME_PX in either dimension (or hidden) is skipped (and with it its
 * subtree) — ad slots, 1×1 beacons and display:none frames carry nothing a user acts on.
 */
const MAX_FRAMES = 24 // total documents walked, counting the top one
const MAX_FRAME_DEPTH = 5 // how deep the iframe nesting is followed
const MIN_FRAME_PX = 24 // frames narrower/shorter than this are treated as decorative and skipped

/** One screencast frame delivered to an onScreencastFrame subscriber: base64 image bytes + its mime type. */
export interface ScreencastFrame {
  data: string
  mime: string
}

/** A site dialog, as the daemon's SiteDialog expects it (browser-tools.ts) */
interface SiteDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  url: string
  defaultPrompt?: string
}

/**
 * Where a frame-qualified ref (`fMeN`) resolves: which CDP session owns that frame, the DevTools frameId, and the
 * absolute offset of the frame's viewport origin on the top page (so an element's frame-relative centre becomes a
 * top-level click point). Built per snapshot and stored on the tab, exactly so a later click/type can find the frame
 * again (the frame→session+offset map the plan calls for). sessionId is undefined for same-process frames (they ride
 * the page session) and a child session id for a cross-origin OOPIF.
 */
interface FrameLoc {
  frameId: string
  sessionId?: string
  offsetX: number
  offsetY: number
}

/** A child iframe/frame element box, as FRAME_WALK_FN reports it for its own document (viewport-relative) */
interface FrameBox {
  x: number
  y: number
  w: number
  h: number
  visible: boolean
}

interface Tab {
  page: CdpPageLike
  url: string
  title: string
  /** JS dialogs this caller closed by itself since the last snapshot (reported so the daemon/AI can react) */
  dialogNotes?: SiteDialog[]
  /** DevTools session id → the frame it drives, for cross-origin (OOPIF) child frames auto-attached on this tab */
  frameSessions: Map<string, string>
  /** prefix (`f1`, `f2`, …) → where that frame resolves; rebuilt on every snapshot so refs stay in step with the walk */
  frames?: Map<string, FrameLoc>
}

/** A ref parsed into its frame prefix (`''` for the top document, `f1`/`f2`/… for a frame) and element index */
function parseRef(ref: string): { prefix: string; index: number } | null {
  const m = /^(f\d+)?e(\d+)$/.exec(ref)
  if (!m) return null
  const index = Number(m[2])
  if (!index) return null
  return { prefix: m[1] ?? '', index }
}

/** The flat DFS order of a frame tree, parent before children, with each frame's position among its siblings */
interface WalkFrame {
  ordinal: number
  frameId: string
  parentOrdinal: number | null
  childIndex: number
  depth: number
}

interface FrameTreeNode {
  frame: { id: string }
  childFrames?: FrameTreeNode[]
}

/**
 * Flatten a Page.getFrameTree into a DFS pre-order list (the top document is ordinal 0, so its prefix is `''`). Bounded
 * by MAX_FRAMES (total) and MAX_FRAME_DEPTH (nesting), so an ad-heavy page cannot blow up the walk. Each frame keeps the
 * ordinal of its parent and its index among that parent's children, which lines up with the parent document's
 * `querySelectorAll('iframe, frame')` order (FRAME_WALK_FN.frames) for offsetting and skipping.
 */
function flattenFrames(root: FrameTreeNode, caps: { maxFrames: number; maxDepth: number }): WalkFrame[] {
  const out: WalkFrame[] = []
  let ordinal = 0
  const visit = (node: FrameTreeNode, parentOrdinal: number | null, depth: number, childIndex: number) => {
    if (out.length >= caps.maxFrames) return
    const o = ordinal++
    out.push({ ordinal: o, frameId: node.frame.id, parentOrdinal, childIndex, depth })
    if (depth >= caps.maxDepth) return
    const kids = node.childFrames ?? []
    for (let i = 0; i < kids.length; i++) {
      if (out.length >= caps.maxFrames) break
      visit(kids[i] as FrameTreeNode, o, depth + 1, i)
    }
  }
  visit(root, null, 0, -1)
  return out
}

/** A function that runs a DevTools command on one session (the page's own, or a child frame's) */
type SessionSend = <T extends Record<string, unknown> = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
) => Promise<T>

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
 * The DOM walk that builds a snapshot of ONE frame's document. Runs in an isolated world (no Runtime.enable on the page),
 * returns `{ text, frames }` where `text` carries inline ref marks `[<prefix>eN role "name"]` whose role words match the
 * daemon's SNAP_ROLES, and `frames` is the list of this document's own child iframe/frame element boxes in document order
 * (used by the caller to position and skip child frames). `prefix` is '' for the top document (refs `e1`, `e2`, …) and
 * `fM` for a child frame (refs `f1e1`, `f1e2`, …), so a ref stays globally unique across frames while the per-frame element
 * counting is identical to the top walk (findNth below counts the same way inside each frame). Interactive elements get a
 * stable eN within their frame; names come from aria-label/title/alt/value/text (trimmed, quotes → single, capped). Password
 * field values are never emitted. The walk itself does NOT descend into iframes (SKIP lists iframe); each frame is walked in
 * its own context and stitched together by the caller.
 */
const FRAME_WALK_FN = `function(maxChars, R, prefix){
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
      var id = (prefix || '') + 'e' + (++n);
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
  // Child frame boxes, in document order — matches the order Page.getFrameTree lists this frame's children, so the
  // caller can line box[i] up with the i-th child frame to offset its coordinates and skip tiny/hidden frames.
  var boxes = [];
  var frameEls = document.querySelectorAll('iframe, frame');
  for (var i = 0; i < frameEls.length; i++){
    var fe = frameEls[i];
    var fr = fe.getBoundingClientRect();
    var fst = fe.ownerDocument.defaultView.getComputedStyle(fe);
    var fvis = !(fst.display === 'none' || fst.visibility === 'hidden' || Number(fst.opacity) === 0) && fr.width > 0 && fr.height > 0;
    // content-box origin in this document's viewport: the frame element's top-left plus its border width
    boxes.push({ x: fr.left + (fe.clientLeft || 0), y: fr.top + (fe.clientTop || 0), w: fr.width, h: fr.height, visible: fvis });
  }
  return { text: out.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim(), frames: boxes };
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

/**
 * The DATA path. Builds the expression run INSIDE the page's MAIN world (via Runtime.evaluate, awaitPromise) so a skill
 * can call a site's own internal API under the user's live session instead of clicking through the UI — the biggest
 * speed win (click-free reads).
 *
 * Why the page's MAIN world, not an isolated world: an isolated world shares the same origin and cookies, so a fetch
 * from either carries the user's session. But the main world is the site's own `window.fetch` — including any wrapper
 * the site installed (auth-header interceptors, base-URL rewriting, custom headers) — so the request looks exactly like
 * one the page itself would make, which is what reaching an internal API needs. Runtime.evaluate on the default context
 * runs there and needs no Runtime.enable (which sites can notice), matching the rest of this caller.
 *
 * Session: `credentials: 'include'` sends the page's cookies. A RELATIVE url resolves against the current page origin,
 * because `window.fetch` resolves it against the document base URL — nothing to prepend here. Body is read as text and
 * capped (bounded transfer); `truncated` flags a cut. On any failure (network, CORS as the site sees it, abort) the
 * expression returns `{ __fetchError }` instead of throwing, so the caller can surface one clear message.
 */
function fetchExpr(url: string, opts: Record<string, unknown>, cap: number, timeoutMs: number): string {
  return `(async () => {
  const __ctrl = new AbortController();
  const __timer = setTimeout(() => { try { __ctrl.abort(); } catch (e) {} }, ${timeoutMs});
  try {
    const __res = await fetch(${JSON.stringify(url)}, Object.assign(${JSON.stringify(opts)}, { signal: __ctrl.signal }));
    const __headers = {};
    try { __res.headers.forEach((v, k) => { __headers[k] = String(v); }); } catch (e) {}
    let __body = '';
    try { __body = await __res.text(); } catch (e) { __body = ''; }
    let __truncated = false;
    if (typeof __body === 'string' && __body.length > ${cap}) { __body = __body.slice(0, ${cap}); __truncated = true; }
    return {
      ok: !!__res.ok,
      status: __res.status,
      statusText: __res.statusText || '',
      url: __res.url || ${JSON.stringify(url)},
      headers: __headers,
      body: __body,
      truncated: __truncated,
    };
  } catch (e) {
    return { __fetchError: (e && e.message) ? String(e.message) : String(e) };
  } finally {
    clearTimeout(__timer);
  }
})()`
}

/** The shape the in-page fetch expression returns (or an error marker the caller turns into a thrown Error). */
interface InPageFetch {
  ok?: boolean
  status?: number
  statusText?: string
  url?: string
  headers?: Record<string, string>
  body?: string
  truncated?: boolean
  __fetchError?: string
}

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
  /** Every attached session (the page's own plus each child frame's) → tabId, so an auto-attach event finds its tab */
  private readonly sessionTab = new Map<string, number>()
  /** tabId → live subscribers of that tab's screencast frames (the desktop mirror; owner-scoped) */
  private readonly screencastSubs = new Map<number, Set<(frame: ScreencastFrame) => void>>()
  /** tabId → throttle state while a screencast runs on that tab (deliver only every everyNth-th frame) */
  private readonly screencastState = new Map<number, { everyNth: number; seen: number }>()
  /** Live subscribers of CDP Network events on Dool2's own tabs (the session recorder; ADR 0046 learn-by-watching) */
  private readonly networkSinks = new Set<(method: string, params: Record<string, unknown>) => void>()
  /** Whether the Network domain should be enabled on each tab (set once a recorder subscribes) so new tabs capture too */
  private networkWanted = false
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
      case 'fetch':
        return this.fetch(args, timeoutMs)
      case 'screencast':
        return this.screencast(args, timeoutMs)
      default:
        throw new Error(
          `Dool2's built-in browser cannot "${cmd}" yet. It can so far: ${SUPPORTED.join(', ')}. ` +
            `Vault fill, dropdown options and popups arrive in a later update.`,
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
        this.watchEvents(b)
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

  /** One DevTools event subscription: auto-closes JS dialogs and feeds screencast frames to their tab's subscribers */
  private watchEvents(b: CdpBrowserLike): void {
    this.unsubEvents?.()
    this.unsubEvents = b.onEvent?.((method, params, sessionId) => {
      // Target.attachedToTarget carries the NEW child session in params.sessionId; the envelope sessionId is the
      // parent (which is why attach is handled before the early return — a top-level attach has no envelope session).
      if (method === 'Target.attachedToTarget') {
        this.onAttached(params, sessionId)
        return
      }
      if (!sessionId) return
      if (method === 'Page.javascriptDialogOpening') this.onDialog(params, sessionId)
      else if (method === 'Page.screencastFrame') this.onScreencastFrameEvent(params, sessionId)
      else if (method === 'Target.detachedFromTarget') this.onDetached(params)
      else if (method === 'Network.requestWillBeSent' || method === 'Network.responseReceived')
        this.onNetworkEvent(method, params, sessionId)
    })
  }

  /**
   * A child target attached under one of our tabs (auto-attach, flatten). We only track iframe targets — a cross-origin
   * (OOPIF) child frame lives in its own renderer, so its DOM is only reachable through its own session. Record
   * frameId → child session on the owning tab, remember the session→tab link (so a nested attach finds its tab too), and
   * turn auto-attach on in the child so an OOPIF nested inside this one also attaches. Owner-scoped: an attach whose
   * parent session we do not know (not one of Dool2's tabs) is ignored.
   */
  private onAttached(params: Record<string, unknown>, parentSession?: string): void {
    const info = params.targetInfo as { targetId?: string; type?: string } | undefined
    if (!info || info.type !== 'iframe') return
    const childSession = typeof params.sessionId === 'string' ? params.sessionId : ''
    const frameId = typeof info.targetId === 'string' ? info.targetId : ''
    if (!childSession || !frameId) return
    const tabId = parentSession ? this.sessionTab.get(parentSession) : undefined
    if (tabId === undefined) return
    const tab = this.tabs.get(tabId)
    if (!tab) return
    tab.frameSessions.set(frameId, childSession)
    this.sessionTab.set(childSession, tabId)
    this.browser
      ?.send?.(
        'Target.setAutoAttach',
        { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
        childSession,
      )
      .catch(() => {})
    // Capture a cross-origin frame's own internal API calls too, when a recorder is listening.
    if (this.networkWanted) this.browser?.send?.('Network.enable', {}, childSession).catch(() => {})
  }

  /** A child target went away: forget its session and any frame it drove, so a stale frame ref resolves to nothing */
  private onDetached(params: Record<string, unknown>): void {
    const childSession = typeof params.sessionId === 'string' ? params.sessionId : ''
    if (!childSession) return
    const tabId = this.sessionTab.get(childSession)
    this.sessionTab.delete(childSession)
    if (tabId === undefined) return
    const tab = this.tabs.get(tabId)
    if (!tab) return
    for (const [frameId, sid] of tab.frameSessions)
      if (sid === childSession) tab.frameSessions.delete(frameId)
  }

  /** Closes a JS dialog by itself so a stray alert/confirm never hangs the page, and remembers it for the next snapshot */
  private onDialog(params: Record<string, unknown>, sessionId: string): void {
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
  }

  /**
   * A Page.screencastFrame event. ACK it so Chromium keeps sending (even a frame we throttle away must be ACKed, or
   * the stream stalls), then — every everyNth-th frame — hand the base64 jpeg to this tab's subscribers. Frames are
   * never persisted or logged; they carry the same page pixels a screenshot would.
   */
  private onScreencastFrameEvent(params: Record<string, unknown>, sessionId: string): void {
    const tabId = this.bySession.get(sessionId)
    if (tabId === undefined) return
    const tab = this.tabs.get(tabId)
    const ackId = params.sessionId
    if (tab && typeof ackId === 'number')
      tab.page.send('Page.screencastFrameAck', { sessionId: ackId }).catch(() => {})
    const state = this.screencastState.get(tabId)
    if (!state) return
    state.seen++
    if (state.seen % state.everyNth !== 0) return // throttle: deliver only every everyNth-th frame
    const subs = this.screencastSubs.get(tabId)
    if (!subs || subs.size === 0) return
    const data = typeof params.data === 'string' ? params.data : ''
    if (!data) return
    const frame: ScreencastFrame = { data, mime: 'image/jpeg' }
    for (const cb of subs) {
      try {
        cb(frame)
      } catch {
        // a subscriber error must not break the stream for others
      }
    }
  }

  /**
   * A CDP Network event on one of Dool2's own tabs (page or child-frame session). Forward it to every subscriber (the
   * session recorder). Owner-scoped: an event whose session is not one of Dool2's tabs is ignored, so a recorder only
   * ever sees traffic from tabs Dool2 opened. Nothing is persisted here — the recorder keeps only safe, de-duplicated
   * facts (@dool2/browser recorder.ts), never cookies/tokens or response bodies.
   */
  private onNetworkEvent(method: string, params: Record<string, unknown>, sessionId: string): void {
    if (this.networkSinks.size === 0) return
    if (!this.sessionTab.has(sessionId)) return
    for (const cb of this.networkSinks) {
      try {
        cb(method, params)
      } catch {
        // a sink error must not break the stream for others
      }
    }
  }

  /**
   * Subscribe to CDP Network events on Dool2's own tabs (the learn-by-watching recorder). Returns an unsubscribe.
   * Marks the Network domain as wanted, so tabs opened later enable it too; call {@link enableNetwork} to turn it on
   * for tabs that are already open.
   */
  onNetwork(cb: (method: string, params: Record<string, unknown>) => void): () => void {
    this.networkSinks.add(cb)
    this.networkWanted = true
    return () => {
      this.networkSinks.delete(cb)
      if (this.networkSinks.size === 0) this.networkWanted = false
    }
  }

  /**
   * Turn on the CDP Network domain on every tab that is already open (and mark it wanted for future tabs), so a
   * recorder's subscribers start receiving request/response events. Best-effort: a tab whose session cannot be reached
   * is skipped. Enabling Network is invisible to the page (no UI, no Runtime.enable).
   */
  async enableNetwork(): Promise<void> {
    this.networkWanted = true
    const tasks: Promise<unknown>[] = []
    for (const tab of this.tabs.values()) tasks.push(tab.page.send('Network.enable').catch(() => {}))
    await Promise.all(tasks)
  }

  /**
   * Subscribe to a tab's screencast frames (base64 jpeg). Returns an unsubscribe. Frames arrive only while a
   * screencast is running on that tab — see the `screencast` command. The desktop mirror subscribes here and
   * forwards each frame to the window; nothing is kept on disk.
   */
  onScreencastFrame(tabId: number, cb: (frame: ScreencastFrame) => void): () => void {
    let subs = this.screencastSubs.get(tabId)
    if (!subs) {
      subs = new Set()
      this.screencastSubs.set(tabId, subs)
    }
    subs.add(cb)
    return () => {
      const s = this.screencastSubs.get(tabId)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) this.screencastSubs.delete(tabId)
    }
  }

  /**
   * Live mirror of a tab via Chromium's screencast. `action:'start'` turns on Page.startScreencast (jpeg, a modest
   * quality/size so the DevTools pipe is not flooded) and begins delivering Page.screencastFrame images to this tab's
   * subscribers (onScreencastFrame); `action:'stop'` turns it off. Owner-scoped: this.tab throws for a tab Dool2 did
   * not open, so a screencast is only ever started on Dool2's own hidden tabs. Throttle with everyNthFrame (default 1).
   */
  private async screencast(
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ started: true } | { stopped: true }> {
    const tab = this.tab(args)
    const id = Number(args.tabId)
    const action = String(args.action ?? 'start')
    if (action === 'stop') {
      this.screencastState.delete(id)
      await tab.page.send('Page.stopScreencast', {}, timeoutMs ?? 10_000).catch(() => {})
      return { stopped: true }
    }
    if (action !== 'start')
      throw new Error(
        `Dool2's built-in browser screencast action must be "start" or "stop" (got "${action}").`,
      )
    const everyNth =
      Number.isFinite(Number(args.everyNthFrame)) && Number(args.everyNthFrame) >= 1
        ? Math.floor(Number(args.everyNthFrame))
        : 1
    const quality = Number.isFinite(Number(args.quality))
      ? Math.min(100, Math.max(1, Math.floor(Number(args.quality))))
      : 40
    const maxWidth =
      Number.isFinite(Number(args.maxWidth)) && Number(args.maxWidth) > 0
        ? Math.floor(Number(args.maxWidth))
        : 1000
    const maxHeight =
      Number.isFinite(Number(args.maxHeight)) && Number(args.maxHeight) > 0
        ? Math.floor(Number(args.maxHeight))
        : 720
    this.screencastState.set(id, { everyNth, seen: 0 })
    // Page must be enabled to receive screencast frames; open() already enabled it, but re-enable defensively (cheap).
    await tab.page.send('Page.enable', {}, timeoutMs ?? 10_000).catch(() => {})
    await tab.page.send(
      'Page.startScreencast',
      { format: 'jpeg', quality, maxWidth, maxHeight },
      timeoutMs ?? 10_000,
    )
    return { started: true }
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
    // Auto-attach (flatten) so each cross-origin child frame (OOPIF) gets its own session we can walk. Same-process
    // frames need no session — they ride this page session. waitForDebuggerOnStart:false so a frame never pauses.
    await page
      .send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false })
      .catch(() => {})
    // When a recorder is listening, enable the Network domain so this tab's internal API calls reach it (ADR 0046).
    if (this.networkWanted) await page.send('Network.enable').catch(() => {})
    const tabId = this.nextTabId++
    const tab: Tab = { page, url, title: '', frameSessions: new Map() }
    this.tabs.set(tabId, tab)
    if (page.sessionId) {
      this.bySession.set(page.sessionId, tabId)
      this.sessionTab.set(page.sessionId, tabId)
    }
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
      for (const [sid, tid] of this.sessionTab) if (tid === id) this.sessionTab.delete(sid)
      if (this.lastTabId === id) this.lastTabId = undefined
      this.screencastState.delete(id)
      this.screencastSubs.delete(id)
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
    const full = await this.walkFrames(tab, maxChars, timeoutMs ?? 20_000)
    const text = full.slice(0, maxChars)
    const notes = tab.dialogNotes
    tab.dialogNotes = undefined
    return {
      tabId: id,
      url: tab.url,
      title: tab.title,
      text,
      truncated: full.length > maxChars,
      captcha: false,
      ...(notes && notes.length ? { dialogNotes: notes } : {}),
    }
  }

  /**
   * Walk the top document and each child frame, stitch the texts together, and (re)build the tab's frame map so a later
   * click/type can resolve a frame-qualified ref (`fMeN`). The top document keeps the plain `eN` refs and its text comes
   * first unchanged; each kept child frame follows under a `[frame fM url]` line with its `fMeN` refs. Same-process
   * frames are walked on the page session; a cross-origin (OOPIF) frame is walked on its own auto-attached session. A
   * frame whose owner box is hidden or smaller than MIN_FRAME_PX (and its subtree) is skipped, as is a frame we cannot
   * reach (e.g. an OOPIF whose session has not attached yet) — the top document is always returned. When the page has no
   * frames this reduces to exactly the old single top-document walk.
   */
  private async walkFrames(tab: Tab, maxChars: number, timeoutMs: number): Promise<string> {
    const pageSend: SessionSend = (method, params, t) => tab.page.send(method, params, t)
    let ordered: WalkFrame[]
    try {
      const { frameTree } = await tab.page.send<{ frameTree: FrameTreeNode }>(
        'Page.getFrameTree',
        {},
        timeoutMs,
      )
      ordered = flattenFrames(frameTree, { maxFrames: MAX_FRAMES, maxDepth: MAX_FRAME_DEPTH })
    } catch {
      ordered = []
    }
    const frames = new Map<string, FrameLoc>()
    const walkedBoxes = new Map<number, FrameBox[]>() // ordinal → its child frame boxes (for offset + skip)
    const skipped = new Set<number>()
    const parts: string[] = []

    for (const f of ordered) {
      const prefix = f.ordinal === 0 ? '' : `f${f.ordinal}`
      let send = pageSend
      let offsetX = 0
      let offsetY = 0
      let childSession: string | undefined

      if (f.parentOrdinal !== null) {
        // A child frame whose parent was itself skipped or unreachable is skipped too (parents come first in DFS order)
        if (skipped.has(f.parentOrdinal) || !walkedBoxes.has(f.parentOrdinal)) {
          skipped.add(f.ordinal)
          continue
        }
        const box = walkedBoxes.get(f.parentOrdinal)?.[f.childIndex]
        if (!box || !box.visible || box.w < MIN_FRAME_PX || box.h < MIN_FRAME_PX) {
          skipped.add(f.ordinal)
          continue
        }
        const parentLoc = f.parentOrdinal === 0 ? undefined : frames.get(`f${f.parentOrdinal}`)
        offsetX = (parentLoc?.offsetX ?? 0) + box.x
        offsetY = (parentLoc?.offsetY ?? 0) + box.y
        childSession = tab.frameSessions.get(f.frameId)
        if (childSession) {
          const browserSend = this.browser?.send?.bind(this.browser)
          if (!browserSend) {
            // No way to reach a cross-origin frame without the browser-level send; skip it (top doc still returned)
            skipped.add(f.ordinal)
            continue
          }
          const cs = childSession
          send = (method, params, t) => browserSend(method, params, cs, t)
        }
      }

      let walk: { text?: string; frames?: FrameBox[] } | undefined
      try {
        walk = await this.evalFrame<{ text?: string; frames?: FrameBox[] }>(
          send,
          f.frameId,
          FRAME_WALK_FN,
          [maxChars, SNAP_ROLE_WORDS, prefix],
          timeoutMs,
        )
      } catch {
        skipped.add(f.ordinal)
        continue
      }
      walkedBoxes.set(f.ordinal, walk?.frames ?? [])
      if (f.ordinal !== 0)
        frames.set(prefix, { frameId: f.frameId, sessionId: childSession, offsetX, offsetY })
      const body = (walk?.text ?? '').trim()
      if (f.ordinal === 0) parts.push(body)
      else if (body) parts.push(`[frame ${prefix}]\n${body}`)
    }

    tab.frames = frames
    return parts.filter((p) => p.length > 0).join('\n\n')
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
    const loc = await this.resolveRef(tab, ref, t)
    const prep = await this.evalFrame<{ found?: boolean; x?: number; y?: number; w?: number; h?: number }>(
      loc.send,
      loc.frameId,
      CLICK_PREP_FN,
      [loc.index, SNAP_ROLE_WORDS],
      t,
    )
    if (!prep?.found || typeof prep.x !== 'number' || typeof prep.y !== 'number')
      throw new Error(`Ref ${ref} is not on the page any more; read it again (browser_read).`)
    const delivered = (prep.w ?? 0) > 0 && (prep.h ?? 0) > 0
    // The frame-relative centre becomes a top-level click point by adding the frame's viewport offset (0 for the top
    // document); the mouse event is always dispatched on the page session, which routes to whichever frame is hit.
    await this.dispatchClick(tab.page, prep.x + loc.offsetX, prep.y + loc.offsetY, t)
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
    const loc = await this.resolveRef(tab, ref, t)
    // TYPE_PREP runs in the ref's frame and focuses the field there (works for a same-process or a cross-origin frame);
    // Input.insertText is then dispatched on the page session and lands in whatever frame now holds focus.
    const prep = await this.evalFrame<{ found?: boolean }>(
      loc.send,
      loc.frameId,
      TYPE_PREP_FN,
      [loc.index, SNAP_ROLE_WORDS],
      t,
    )
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
    const loc = await this.resolveRef(tab, ref, t)
    const prep = await this.evalFrame<{ found?: boolean; x?: number; y?: number }>(
      loc.send,
      loc.frameId,
      CLICK_PREP_FN,
      [loc.index, SNAP_ROLE_WORDS],
      t,
    )
    if (!prep?.found || typeof prep.x !== 'number' || typeof prep.y !== 'number')
      throw new Error(`Ref ${ref} is not on the page any more.`)
    await tab.page.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: prep.x + loc.offsetX, y: prep.y + loc.offsetY, button: 'none', buttons: 0 },
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
    const t = timeoutMs ?? 15_000
    const dir = args.direction === 'up' ? 'up' : 'down'
    // A ref scrolls that element into view inside its own frame; no ref scrolls the top document's window.
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0
    const loc = hasRef
      ? await this.resolveRef(tab, String(args.ref), t)
      : {
          send: ((m, p, tt) => tab.page.send(m, p, tt)) as SessionSend,
          frameId: await this.topFrameId(tab, t),
          index: 0,
          offsetX: 0,
          offsetY: 0,
        }
    const r = await this.evalFrame<{
      target: string
      before: number
      after: number
      max: number
      atEnd: boolean
    }>(loc.send, loc.frameId, SCROLL_FN, [loc.index, dir, SNAP_ROLE_WORDS], t)
    return { url: tab.url, scroll: r }
  }

  /** The top document's frameId (for a page-level walk/scroll that has no frame ref) */
  private async topFrameId(tab: Tab, timeoutMs: number): Promise<string> {
    const { frameTree } = await tab.page.send<{ frameTree: FrameTreeNode }>(
      'Page.getFrameTree',
      {},
      timeoutMs,
    )
    return frameTree?.frame?.id
  }

  /**
   * Resolve a ref to the frame it lives in: the session that drives that frame, its DevTools frameId, the absolute
   * offset of its viewport on the top page, and the element index for findNth. A plain `eN` ref resolves to the top
   * document (offset 0). A frame-qualified `fMeN` ref is looked up in the tab's last-snapshot frame map; if the frame is
   * gone (or its cross-origin session is unreachable) it errors cleanly asking for a fresh read.
   */
  private async resolveRef(
    tab: Tab,
    ref: string,
    timeoutMs: number,
  ): Promise<{ send: SessionSend; frameId: string; index: number; offsetX: number; offsetY: number }> {
    const p = parseRef(ref)
    if (!p)
      throw new Error(`"${ref}" is not a page ref (eN or fMeN) from the last snapshot; read the page first.`)
    if (!p.prefix) {
      return {
        send: (m, pp, t) => tab.page.send(m, pp, t),
        frameId: await this.topFrameId(tab, timeoutMs),
        index: p.index,
        offsetX: 0,
        offsetY: 0,
      }
    }
    const fl = tab.frames?.get(p.prefix)
    if (!fl)
      throw new Error(
        `Frame ref ${ref} is not from the last snapshot (the frame may be gone); read the page again (browser_read).`,
      )
    const browserSend = this.browser?.send?.bind(this.browser)
    if (fl.sessionId && !browserSend)
      throw new Error(
        `Frame ref ${ref} needs its cross-origin session, which is unavailable; read the page again.`,
      )
    const childId = fl.sessionId
    const send: SessionSend =
      childId && browserSend
        ? (m, pp, t) => browserSend(m, pp, childId, t)
        : (m, pp, t) => tab.page.send(m, pp, t)
    return { send, frameId: fl.frameId, index: p.index, offsetX: fl.offsetX, offsetY: fl.offsetY }
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

  /**
   * The DATA path: run `window.fetch(url, {...})` inside the tab's page under the user's live session, so a skill can
   * hit a site's own internal API instead of clicking through the UI. Only works on a tab Dool2 opened (same ownership
   * rule as the other commands — `this.tab` throws for an unknown tab).
   *
   * The request runs in the page's MAIN world (see fetchExpr) with `credentials: 'include'`, so the page's cookies and
   * any site fetch wrapper apply, and a relative url resolves against the current page origin. Returns
   * `{ ok, status, statusText, url, headers, body, truncated }` with `body` as text, plus a `json` convenience when the
   * response's content-type is JSON and the (un-truncated) body parses. Body is capped at args.maxBytes (default 2 MB)
   * and the fetch is aborted after args.timeoutMs (default 30 s).
   *
   * Security: this runs AS THE USER on their own session — that is the point (their own accounts). It only calls the
   * same-site/able API the page itself could call, and sends nothing to anywhere external. The body is returned
   * verbatim (nothing redacted here). IMPORTANT: the daemon MUST pass this body through the vault's `maskSecretsInText`
   * (@dool2/vault) before the brain sees it, the same as any other page read — this caller never hands raw page bytes
   * to the model directly.
   */
  private async fetch(args: Record<string, unknown>, timeoutMs?: number): Promise<InPageFetch> {
    const tab = this.tab(args)
    const url = String(args.url ?? '')
    if (!url) throw new Error('browser fetch needs a url (absolute, or relative to the current page).')
    const cap =
      Number.isFinite(Number(args.maxBytes)) && Number(args.maxBytes) > 0
        ? Math.floor(Number(args.maxBytes))
        : DEFAULT_FETCH_CAP
    const fetchTimeout =
      Number.isFinite(Number(args.timeoutMs)) && Number(args.timeoutMs) > 0
        ? Math.floor(Number(args.timeoutMs))
        : (timeoutMs ?? DEFAULT_FETCH_TIMEOUT)

    // Build the fetch init: method/headers/body are optional; credentials is always 'include' so the session rides along
    const opts: Record<string, unknown> = { credentials: 'include' }
    if (typeof args.method === 'string' && args.method) opts.method = args.method
    if (args.headers && typeof args.headers === 'object') opts.headers = args.headers
    if (typeof args.body === 'string') opts.body = args.body

    // Wait a little past the in-page AbortController so the abort returns a clean error before the pipe call times out
    const r = await this.evalInPage<InPageFetch>(
      tab.page,
      fetchExpr(url, opts, cap, fetchTimeout),
      fetchTimeout + 5_000,
    )
    if (!r || typeof r !== 'object') throw new Error('browser fetch returned nothing from the page.')
    if (r.__fetchError) throw new Error(`browser fetch failed in the page: ${r.__fetchError}`)

    // Defensive re-cap: the in-page code already capped, but never trust a body longer than the cap over the wire
    let body = typeof r.body === 'string' ? r.body : ''
    let truncated = r.truncated === true
    if (body.length > cap) {
      body = body.slice(0, cap)
      truncated = true
    }
    const status = typeof r.status === 'number' ? r.status : 0
    const ok = typeof r.ok === 'boolean' ? r.ok : status >= 200 && status < 300
    const headers = r.headers && typeof r.headers === 'object' ? r.headers : {}
    const contentType = String(headers['content-type'] ?? headers['Content-Type'] ?? '')

    const out: {
      ok: boolean
      status: number
      statusText: string
      url: string
      headers: Record<string, string>
      body: string
      truncated: boolean
      json?: unknown
    } = {
      ok,
      status,
      statusText: typeof r.statusText === 'string' ? r.statusText : '',
      url: typeof r.url === 'string' && r.url ? r.url : url,
      headers,
      body,
      truncated,
    }
    // JSON convenience: only when the server said JSON and the body was not cut (a cut body would not parse)
    if (!truncated && /\bjson\b/i.test(contentType)) {
      try {
        out.json = JSON.parse(body)
      } catch {
        // leave json unset; the caller still has the raw text in body
      }
    }
    return out
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
   * Runs a function in a fresh isolated world of one frame (identified by frameId) on a given session, and returns its
   * value. For the top document the session is the page's own; for a cross-origin child frame it is that frame's
   * auto-attached session — in both cases Page.createIsolatedWorld + Runtime.callFunctionOn run against the right
   * renderer. Keeps the Runtime domain off the page (sites can notice Runtime.enable); createIsolatedWorld needs no
   * Page.enable. The snapshot walk and every ref resolver (click/type/hover/scroll) go through here, so the counting
   * that assigns a ref and the counting that finds it stay identical within each frame.
   */
  private async evalFrame<T>(
    send: SessionSend,
    frameId: string,
    functionDeclaration: string,
    args: unknown[],
    timeoutMs: number,
  ): Promise<T> {
    const { executionContextId } = await send<{ executionContextId: number }>(
      'Page.createIsolatedWorld',
      { frameId, worldName: 'dool2-snapshot' },
      timeoutMs,
    )
    const r = await send<{
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

  /**
   * Runs an expression in the page's MAIN world and returns its value. Unlike {@link evalFrame} (isolated world, for
   * the snapshot/ref DOM walks), this uses Runtime.evaluate on the default context so the data-path fetch is the site's
   * own `window.fetch` under its session. Runtime.evaluate needs no Runtime.enable (which sites can notice), so this
   * keeps the same low profile as the rest of the caller. awaitPromise resolves the async fetch IIFE before returning.
   */
  private async evalInPage<T>(page: CdpPageLike, expression: string, timeoutMs: number): Promise<T> {
    const r = await page.send<{
      result?: { value?: T }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'page fetch failed',
      )
    return r.result?.value as T
  }

  /** Closes the browser (daemon shutdown). Downloaded build and profile stay */
  async closeBrowser(): Promise<void> {
    this.tabs.clear()
    this.bySession.clear()
    this.sessionTab.clear()
    this.screencastState.clear()
    this.screencastSubs.clear()
    this.networkSinks.clear()
    this.networkWanted = false
    this.unsubEvents?.()
    this.unsubEvents = undefined
    const b = this.browser
    this.browser = undefined
    if (b) await b.close().catch(() => {})
  }
}
