// Dool2 extension service worker. A thin hand with no judgment (ADR 0006, docs/architecture.md 5.1).
// - It only does what the Dool2 daemon asks. What is risky and what may be done is decided by the daemon (approval gate)
// - It only touches tabs Dool2 opened. Tabs the user opened are left alone
// - Clicks and typing go through chrome.debugger (CDP Input), the same as real input
import type { BridgeRequest, BrowserCommand } from '@dool2/protocol'
import { READ_CDP_METHODS } from '@dool2/protocol/cdp'
import { type FrameNode, layoutFrames, screenOrder } from './frames.js'
import { staleBuild } from './fresh.js'
import { keyDef, pickPath, safeUrl } from './keys.js'
import { lang } from './lang.js'
import { ui } from './locales/ui.js'
import {
  type ExtractSpec,
  type LocateMode,
  type LocateResult,
  pageActiveValueLength,
  pageCaptchaRects,
  pageCaretEnd,
  pageClick,
  pageCursor,
  pageCutOff,
  pageExtract,
  pageFind,
  pageForm,
  pageFormCheckFix,
  pageFormFocus,
  pageFormTarget,
  pageFrameBox,
  pageFrameProbeListen,
  pageFrameProbeRead,
  pageFrameProbeSend,
  pageFrameSelf,
  pageHitArm,
  pageHitRead,
  pageHookOpen,
  pageLinkNavigates,
  pageLocate,
  pageMarkFilled,
  pageMarkTaps,
  pageMarkText,
  pageMutArm,
  pageMutRead,
  pageOptionPoint,
  pagePrintCleanup,
  pagePrintFrameCopy,
  pagePrintHook,
  pagePrintPrepare,
  pagePrintTake,
  pagePrintUnhook,
  pageReadOpens,
  pageRememberShown,
  pageRemoteInfo,
  pageRevealItem,
  pageScroll,
  pageScrollBy,
  pageScrollInfo,
  pageSelectChoose,
  pageSelectOptions,
  pageShotRect,
  pageShowsText,
  pageSnapshot,
  pageTapAt,
  pageUploadChunk,
  pageUploadFinish,
  pageUploadState,
  pageUploadTarget,
  pageValueLength,
  pageViewport,
  type ReadScope,
  type SnapshotResult,
} from './page.js'
import { FRAME_HEADING } from './region/kr/snapshot.js'
import { CLOSE_AFTER_MS, tidyPlan } from './tidy.js'

const txt = ui(lang)

/** Must equal BROWSER_HOST_NAME in @dool2/protocol (checked by a test) */
export const HOST_NAME = 'com.dool2.host'
const VERSION = chrome.runtime.getManifest().version
/** Build fingerprint (injected by scripts/build.mjs; 'dev' in tests and development) */
declare const __DOOL2_BUILD__: string | undefined
const BUILD = typeof __DOOL2_BUILD__ === 'string' ? __DOOL2_BUILD__ : 'dev'

/** Restart itself when new code has been installed on disk (fresh.ts) */
async function reloadIfStale() {
  const onDisk = await fetch(chrome.runtime.getURL('build.json'), { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<{ build?: string }>) : {}))
    .then((j) => (j as { build?: string }).build)
    .catch(() => undefined)
  if (staleBuild(BUILD, onDisk)) chrome.runtime.reload()
}
setTimeout(() => void reloadIfStale(), 3000)
setInterval(() => void reloadIfStale(), 10 * 60_000)
const DEBUGGER_IDLE_MS = 2 * 60_000

type Status = { state: 'connecting' | 'on' | 'off'; detail?: string }
let port: chrome.runtime.Port | undefined
let status: Status = { state: 'off' }

// ── Connection to the daemon ─────────────────────────────────

function setStatus(next: Status) {
  status = next
  chrome.action.setBadgeText({ text: next.state === 'on' ? '' : '!' }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }).catch(() => {})
}

function connect() {
  if (port) return
  let p: chrome.runtime.Port
  try {
    p = chrome.runtime.connectNative(HOST_NAME)
  } catch (e) {
    setStatus({ state: 'off', detail: (e as Error).message })
    return
  }
  port = p
  setStatus({ state: 'connecting' })
  p.onMessage.addListener((msg) => onMessage(p, msg))
  p.onDisconnect.addListener(() => {
    const why = chrome.runtime.lastError?.message
    if (port === p) port = undefined
    setStatus({
      state: 'off',
      detail: why?.includes('not found') ? txt.appNotInstalled : txt.appOff,
    })
  })
  p.postMessage({ event: 'hello', version: VERSION, build: BUILD, browser: browserName() })
  void reloadIfStale()
}

function browserName() {
  const brands = (
    navigator as Navigator & { userAgentData?: { brands: { brand: string; version: string }[] } }
  ).userAgentData?.brands
  const b = brands?.find((x) => !/not.?a.?brand|chromium/i.test(x.brand)) ?? brands?.[0]
  return b ? `${b.brand} ${b.version}` : 'Chromium'
}

function onMessage(p: chrome.runtime.Port, msg: unknown) {
  if (!msg || typeof msg !== 'object') return
  if ((msg as { event?: string }).event === 'daemon-offline') {
    p.disconnect()
    if (port === p) port = undefined
    setStatus({ state: 'off', detail: txt.appOff })
    return
  }
  const req = msg as BridgeRequest
  if (typeof req.id !== 'number') return
  setStatus({ state: 'on' })
  const tabId = (req.args as { tabId?: unknown } | undefined)?.tabId
  if (typeof tabId === 'number') touch(tabId)
  run(req.cmd, req.args ?? {}).then(
    (result) => p.postMessage({ id: req.id, ok: true, result }),
    (e: Error) => p.postMessage({ id: req.id, ok: false, error: e.message || String(e) }),
  )
}

// The service worker stops when idle. While the connection is alive Chrome keeps it awake; if it drops we reconnect every 30 seconds
chrome.alarms.create('dool2-reconnect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'dool2-reconnect') return
  connect()
  void tidy()
})
chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
connect()
// When the service worker restarts with an empty Dool2 tab list (extension reload, Chrome restart), recover the tabs from the group
void load().then((s) => (s.owned.length ? undefined : reclaim()))

// Popup: show connection status, reconnect
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return
  if (msg?.type === 'retry') connect()
  reply({ ...status, connected: Boolean(port) && status.state !== 'off' })
})

// ── Dool2 tabs ───────────────────────────────────────────────

const GROUP_TITLE = txt.groupTitle

interface Saved {
  windowId?: number
  owned: number[]
  groupId?: number
  /** When Dool2 last used each tab (kept even if the service worker sleeps and wakes) */
  used?: Record<string, number>
  /** Tabs waiting for a person or an approval: not tidied until this time (hold) */
  held?: Record<string, number>
  /** Recently closed Dool2 tabs (when called again, report "closed" instead of "a tab the user opened") */
  closed?: number[]
  /** Which tab opened which Dool2 tab and when (new windows, payment windows; excluded from tidying). Last 50 */
  recs?: TabRec[]
  /** Tabs closed by tidying: reported on the next read or tab list */
  tidied?: Tidied[]
}
interface TabRec {
  tabId: number
  /** The Dool2 tab that opened this tab (Dool2 itself opens no such tabs) */
  opener?: number
  at: number
  url?: string
  title?: string
  /** New windows already reported by the popup command */
  seen?: boolean
  closedAt?: number
}
interface Tidied {
  tabId: number
  url: string
  title: string
  at: number
  why: string
  told?: boolean
}
/** Add one record (updates it if the tab is already there) */
function putRec(s: Saved, r: TabRec) {
  const list = (s.recs ?? []).filter((x) => x.tabId !== r.tabId)
  list.push(r)
  s.recs = list.slice(-50)
}
async function load(): Promise<Saved> {
  const s = (await chrome.storage.session.get('dool2')).dool2 as Saved | undefined
  return s ?? { owned: [] }
}

/**
 * Recover the Dool2 tab list. The list lives in session storage, so reloading the extension (including auto-update) or restarting Chrome empties it.
 * Then open Dool2 tabs become ownerless and escape tidying, and a new Dool2 group is created, so tabs piled up
 * (measured: after a day of testing, 20+ Dool2 tabs and 10GB of Chrome, which froze an 8GB Mac).
 * Tab ids are renumbered when Chrome restarts, so trusting old ids could collide with user tabs. Instead of ids,
 * we adopt the tabs in the Dool2 group (Dool2 tabs are always opened into that group) and merge several groups into one.
 */
async function reclaim() {
  // Match the title in every language, so switching the language keeps the existing group
  const titles = new Set([ui('ko').groupTitle, ui('en').groupTitle])
  const groups = (await chrome.tabGroups.query({}).catch(() => [])).filter((g) => titles.has(g.title ?? ''))
  if (!groups.length) return
  const tabs = (await chrome.tabs.query({})).filter((t) => groups.some((g) => g.id === t.groupId))
  const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined)
  const [main, ...rest] = groups
  if (!main) return
  // Several Dool2 groups are merged into the first one (same window only; groups in other windows stay and only their tabs are adopted)
  for (const g of rest) {
    if (g.windowId !== main.windowId) continue
    const inG = tabs.filter((t) => t.groupId === g.id && t.id !== undefined).map((t) => t.id as number)
    if (inG.length)
      await chrome.tabs
        .group({ groupId: main.id, tabIds: inG as [number, ...number[]] })
        .catch(() => undefined)
  }
  await update((x) => {
    x.owned = [...new Set([...x.owned, ...ids])]
    x.groupId ??= main.id
    x.windowId ??= main.windowId
  })
  void tidy()
}
async function save(s: Saved) {
  await chrome.storage.session.set({ dool2: s })
}
/** Changes to the Dool2 tab list run one at a time: when two tabs opened at once they overwrote each other's save and "not a Dool2 tab" errors came up */
let stateQueue: Promise<unknown> = Promise.resolve()
function update(fn: (s: Saved) => void | Promise<void>): Promise<Saved> {
  const run = stateQueue.then(async () => {
    const s = await load()
    await fn(s)
    await save(s)
    return s
  })
  stateQueue = run.catch(() => undefined)
  return run
}

async function ownedTab(args: Record<string, unknown>, watching = true): Promise<number> {
  const tabId = Number(args.tabId)
  const s = await load()
  if (!Number.isInteger(tabId))
    throw new Error('Not a tab Dool2 opened. Tabs the user opened are not touched')
  if (!s.owned.includes(tabId)) {
    // A new tab just opened by a Dool2 tab (a login window, etc.) can be used before adopt has been saved:
    // if the opener is a Dool2 tab, adopt it here (measured: it stopped with "not a tab Dool2 opened" on
    // 29CM, Uniqlo, Seoul reservations, Airbnb Google login, and Catch Table Naver login)
    const t = await chrome.tabs.get(tabId).catch(() => undefined)
    // A closed Dool2 tab drops out of the list and looked like "a tab the user opened": say it was closed (so the AI and phone can explain right away)
    if (!t && s.closed?.includes(tabId)) throw new Error('The tab was closed')
    if (t?.openerTabId !== undefined && s.owned.includes(t.openerTabId)) await adopt(t.openerTabId, tabId)
    else throw new Error('Not a tab Dool2 opened. Tabs the user opened are not touched')
  }
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    throw new Error('The tab was closed')
  }
  // If the tab was put to sleep for being idle, load it again
  if (tab.discarded) {
    await chrome.tabs.reload(tabId)
    await waitLoad(tabId)
  }
  // Catch site dialogs that open while handling the tab (not when handing off to a person or closing)
  if (watching) await watch(tabId)
  return tabId
}

/**
 * Dool2 tabs are gathered in one Dool2 window and grouped in a green tab group. background: the tab opens behind the
 * one in front (a lookup reading while another task drives the browser; reading needs no painting)
 */
async function openTab(url: string, background = false): Promise<chrome.tabs.Tab> {
  const s = await load()
  let tab: chrome.tabs.Tab | undefined
  if (s.windowId !== undefined) {
    try {
      await chrome.windows.get(s.windowId)
      tab = await chrome.tabs.create({ windowId: s.windowId, url, active: !background })
    } catch {
      s.windowId = undefined
    }
  }
  if (!tab) {
    const w = await chrome.windows.create({ url, focused: false, type: 'normal' })
    s.windowId = w?.id
    tab = w?.tabs?.[0]
  }
  if (tab?.id === undefined) throw new Error('Could not open the tab')
  const id = tab.id
  await update((x) => {
    x.owned = [...new Set([...x.owned, id])]
    if (s.windowId !== undefined) x.windowId = s.windowId
    putRec(x, { tabId: id, at: Date.now() })
  })
  touch(id)
  // Dool2 tabs are silent (shop videos, etc.). The user can turn sound on from the tab
  void chrome.tabs.update(id, { muted: true }).catch(() => undefined)
  await groupTab(id)
  void tidy(id)
  return tab
}

// ── Tidying finished Dool2 tabs (memory) ─────────────────────
// If the AI forgets to close tabs at the end of a task they pile up and Chrome eats several GB.
// Idle tabs are put to sleep (discard); older ones, or any beyond the limit, are closed (tidy.ts)

const usedAt = new Map<number, number>()
let usedSavedAt = 0
function touch(tabId: number) {
  usedAt.set(tabId, Date.now())
  tracked.add(tabId)
  // Save only now and then (saving on every command would be slow)
  if (Date.now() - usedSavedAt < 30_000) return
  usedSavedAt = Date.now()
  void update((s) => {
    s.used = Object.fromEntries([...usedAt].filter(([id]) => s.owned.includes(id)))
  })
}

let tidying = false
async function tidy(fresh?: number) {
  if (tidying) return
  tidying = true
  try {
    const s = await load()
    const now = Date.now()
    const tabs = []
    const info = new Map<number, chrome.tabs.Tab>()
    const live = new Set<number>()
    for (const id of s.owned) if (await chrome.tabs.get(id).catch(() => undefined)) live.add(id)
    for (const id of s.owned) {
      const t = await chrome.tabs.get(id).catch(() => undefined)
      if (!t) continue
      info.set(id, t)
      // If the service worker woke up with no record, treat the tab as just used (so a wake-up does not close everything)
      const at = usedAt.get(id) ?? s.used?.[id] ?? now
      usedAt.set(id, at)
      // Family tabs are neither closed nor put to sleep: a tab whose opener is alive (an order page that opened a payment window), and a tab opened within 30 minutes by a live tab (the payment window).
      // Closing or sleeping the order page leaves the payment window nowhere to return its result, and payment breaks (measured 11-20 Gmarket)
      const rec = s.recs?.find((r) => r.tabId === id)
      const family =
        (s.recs ?? []).some((r) => r.opener === id && live.has(r.tabId)) ||
        (rec?.opener !== undefined && live.has(rec.opener) && now - rec.at < 30 * 60_000)
      tabs.push({
        id,
        usedAt: at,
        keep: id === fresh || phoneView.has(id) || emulated.has(id) || (s.held?.[id] ?? 0) > now,
        family,
        discarded: Boolean(t.discarded),
        active: Boolean(t.active),
      })
    }
    const plan = tidyPlan(tabs, now)
    const gone: Tidied[] = []
    for (const id of plan.close) {
      const t = info.get(id)
      const old = now - (usedAt.get(id) ?? now) >= CLOSE_AFTER_MS
      gone.push({
        tabId: id,
        url: t?.url ?? '',
        title: t?.title ?? '',
        at: now,
        why: old ? 'unused for over 45 minutes' : 'too many Dool2 tabs (up to 3 are kept)',
      })
      await detach(id)
      await chrome.tabs.remove(id).catch(() => undefined)
    }
    // Keep what was closed and report it on the next read or tab list (closing silently leaves the AI unaware why a tab vanished)
    if (gone.length)
      await update((x) => {
        x.tidied = [...(x.tidied ?? []), ...gone].slice(-20)
      })
    for (const id of plan.sleep) {
      await detach(id)
      await chrome.tabs.discard(id).catch(() => undefined)
    }
  } finally {
    tidying = false
  }
}

async function groupTab(tabId: number) {
  try {
    const s = await load()
    let groupId = s.groupId
    if (groupId !== undefined) {
      try {
        await chrome.tabGroups.get(groupId)
      } catch {
        groupId = undefined
      }
    }
    groupId = await chrome.tabs.group({ tabIds: [tabId], ...(groupId !== undefined ? { groupId } : {}) })
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'green' })
    const gid = groupId
    await update((x) => {
      x.groupId = gid
    })
  } catch {
    // Grouping is cosmetic. If it fails, the work goes on
  }
}

// A new tab opened from a Dool2 tab (a new-window link) is also treated as a Dool2 tab.
// Each opened tab is kept in a list: it used to remember only the last new window, so when another tab opened a window or a click started,
// a late payment window was forgotten
/** When each tab last opened a new tab (so waiting after a click can end early) */
const lastOpened = new Map<number, number>()
async function adopt(opener: number, tabId: number) {
  let took = false
  await update((s) => {
    if (!s.owned.includes(opener) || s.owned.includes(tabId)) return
    s.owned.push(tabId)
    putRec(s, { tabId, opener, at: Date.now() })
    took = true
  })
  if (!took) return
  lastOpened.set(opener, Date.now())
  tracked.add(tabId)
  void watch(tabId)
  void chrome.tabs.update(tabId, { muted: true }).catch(() => undefined)
  await groupTab(tabId)
}
// If the page is replaced by a prerendered one the tab id changes: if it was a Dool2 tab, the new id is one too
chrome.tabs.onReplaced.addListener((added, removed) => {
  void update((s) => {
    if (s.owned.includes(removed)) s.owned = [...s.owned.filter((t) => t !== removed), added]
  })
})
/** The daemon asked for an update (command update): apply it as soon as Chrome has it */
let updateWanted = false
chrome.runtime.onUpdateAvailable.addListener(() => {
  if (updateWanted) chrome.runtime.reload()
})
/** Which tab opened which (popups such as a verification window): a closed popup's site alerts go to its opener */
const openers = new Map<number, number>()
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  openers.set(d.tabId, d.sourceTabId)
  adopt(d.sourceTabId, d.tabId)
})
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined && tab.openerTabId !== undefined) {
    openers.set(tab.id, tab.openerTabId)
    adopt(tab.openerTabId, tab.id)
  }
})
chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Alerts a popup showed right before it closed (a verification window saying the details did not match) were lost
  // with it, and Dool2 asked for the same verification three times (test PC 11-27): hand them to the opener tab
  const opener = openers.get(tabId)
  openers.delete(tabId)
  const left = dialogNotes.get(tabId)
  if (opener !== undefined && left?.length)
    dialogNotes.set(
      opener,
      [
        ...(dialogNotes.get(opener) ?? []),
        ...left.map((d) => ({ ...d, message: `(in the window that closed) ${d.message}` })),
      ].slice(-5),
    )
  let had = false
  await update((s) => {
    had = s.owned.includes(tabId)
    s.owned = s.owned.filter((t) => t !== tabId)
    if (had) s.closed = [...(s.closed ?? []).filter((t) => t !== tabId), tabId].slice(-50)
    const rec = s.recs?.find((r) => r.tabId === tabId)
    if (rec) {
      rec.closedAt = Date.now()
      const last = lastSeen.get(tabId)
      if (last) Object.assign(rec, last)
    }
  })
  frameNav.delete(tabId)
  listedFrames.delete(tabId)
  navLog.delete(tabId)
  openAttempts.delete(tabId)
  lastSeen.delete(tabId)
  tracked.delete(tabId)
  if (!had) return
  usedAt.delete(tabId)
  frameMaps.delete(tabId)
  frameIndexes.delete(tabId)
  attached.delete(tabId)
  dialogs.delete(tabId)
  dialogNotes.delete(tabId)
  pointer.delete(tabId)
  port?.postMessage({ event: 'tab-closed', tabId })
})

/** The page text has to stay the same this long before a page that is still loading counts as ready */
const READY_QUIET_MS = 700

/**
 * Wait until the page can be used, like a person would: the load finished, or the document is parsed and its text
 * stopped changing for READY_QUIET_MS. Ads and trackers hold back the load event for 10 to 30 seconds after the
 * content is on screen (measured 11-24: yes24 content at 1.8 s, load at 21 s; daum 2.3 s vs 10.7 s; the text at that
 * point was 98-100% of the final text), and waiting for it made every page move take 20 s.
 * full: wait for the load event itself (connector extraction, which was verified against it)
 */
async function waitLoad(tabId: number, timeoutMs = 20_000, full = false) {
  const until = Date.now() + timeoutMs
  let base = -1
  let quietSince = 0
  while (Date.now() < until) {
    const t = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!t) throw new Error('The tab was closed')
    if (t.status === 'complete') return t
    // If a confirm dialog appears while opening, the load cannot finish until it is answered: report instead of waiting
    if (dialogs.has(tabId)) return t
    if (!full) {
      // Not yet on the new document (navigation not committed): the text read would be the old page's
      const n = t.pendingUrl ? undefined : await textLength(tabId)
      const now = Date.now()
      // Small changes (a clock, a rolling banner) do not count as the page still drawing
      if (n === undefined || base < 0 || Math.abs(n - base) > Math.max(20, base * 0.01)) {
        base = n ?? -1
        quietSince = now
      } else if (now - quietSince >= READY_QUIET_MS) return t
    }
    await sleep(150)
  }
  return chrome.tabs.get(tabId)
}

/** Length of the page's visible text, or undefined while the document is still being parsed or has no text yet */
async function textLength(tabId: number): Promise<number | undefined> {
  const [r] = await chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => (document.readyState === 'loading' ? -1 : (document.body?.innerText.length ?? 0)),
    })
    .catch(() => [])
  const n = r?.result
  return typeof n === 'number' && n > 0 ? n : undefined
}

/** Wait briefly (up to 1.2s) for the page to change after input. If a navigation started, wait until it ends (including navigation inside frames) */
/** quick: a click that barely changes the page, like a keypad digit (watch only 0.3s. If a navigation starts, still wait until it ends) */
async function settle(tabId: number, before?: string, quick = false) {
  const since = Date.now()
  await settleTop(tabId, before, quick ? 3 : 12)
  await framesSettle(tabId, since)
}
async function settleTop(tabId: number, before?: string, rounds = 12) {
  const since = Date.now()
  for (let i = 0; i < rounds; i++) {
    await sleep(100)
    // With a confirm dialog open the page cannot change further (it is frozen until answered)
    if (dialogs.has(tabId)) return
    // If the click opened a new tab, this tab changes no more: do not wait
    // (when the new tab comes to the front this tab goes behind and paints slowly, which used up the full 1.2s - 4s in CI)
    if ((lastOpened.get(tabId) ?? 0) >= since) return
    // Keep page changes and animations going after a click even in an occluded window. One paint takes about 40ms (measured), so only every 4th time
    if (i % 4 === 3 && attached.has(tabId)) await paint(tabId)
    const t = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!t) return
    if (t.status === 'loading' || (before !== undefined && t.url !== before)) {
      await waitLoad(tabId, 15_000)
      return
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Whether each frame is loading (webNavigation) ──
// Looking only at the tab state and top URL cannot tell whether navigation inside a frame (payment step, address search result) has finished, so half-drawn frames were read
/** Tabs Dool2 handles (navigation of user tabs is not recorded) */
const tracked = new Set<number>()
/** Last URL and title per tab (so the tab list can say what it was even after it closed) */
const lastSeen = new Map<number, { url?: string; title?: string }>()
chrome.tabs.onUpdated.addListener((id, _change, t) => {
  if (tracked.has(id)) lastSeen.set(id, { url: t.url, title: t.title })
})
type NavKind = 'start' | 'commit' | 'done' | 'error'
const frameNav = new Map<number, Map<number, { url: string; loading: boolean; at: number }>>()
const navLog = new Map<number, { at: number; frameId: number; url: string; kind: NavKind }[]>()
function noteNav(d: { tabId: number; frameId: number; url: string }, kind: NavKind) {
  if (!tracked.has(d.tabId)) return
  const m = frameNav.get(d.tabId) ?? new Map()
  m.set(d.frameId, { url: d.url, loading: kind === 'start' || kind === 'commit', at: Date.now() })
  frameNav.set(d.tabId, m)
  const log = navLog.get(d.tabId) ?? []
  log.push({ at: Date.now(), frameId: d.frameId, url: d.url, kind })
  navLog.set(d.tabId, log.slice(-40))
}
chrome.webNavigation.onBeforeNavigate.addListener((d) => noteNav(d, 'start'))
chrome.webNavigation.onCommitted.addListener((d) => noteNav(d, 'commit'))
chrome.webNavigation.onCompleted.addListener((d) => noteNav(d, 'done'))
chrome.webNavigation.onErrorOccurred.addListener((d) => noteNav(d, 'error'))

/** Frames that had text or clickable items in the last read of each tab (so ad frames that keep reloading do not make every click wait) */
const listedFrames = new Map<number, Set<number>>()

/**
 * If a frame that started navigating after `since` is still loading, wait until it finishes (at most maxMs).
 * Only frames included in the last read and newly created frames (windows opened by a click) are watched
 */
async function framesSettle(tabId: number, since: number, maxMs = 2_500) {
  const until = Date.now() + maxMs
  const listed = listedFrames.get(tabId)
  const known = frameIndexes.get(tabId)
  const busy = () =>
    [...(frameNav.get(tabId) ?? new Map()).entries()].some(
      ([fid, f]) => fid !== 0 && f.loading && f.at >= since && (listed?.has(fid) || !known?.has(fid)),
    )
  while (busy() && Date.now() < until) {
    if (dialogs.has(tabId)) return
    await sleep(150)
  }
}

// ── chrome.debugger: real input and screen capture ───────────

const attached = new Map<number, ReturnType<typeof setTimeout>>()
const stoppedByUser = new Set<number>()

/** Tabs whose size is mimicked to a phone for the remote screen (Chrome restores the original size when the debugger detaches) */
const emulated = new Map<number, string>()

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return
  // Once detached, Chrome also releases the phone-width rendering
  phoneView.delete(source.tabId)
  phoneSize.delete(source.tabId)
  listening.delete(source.tabId)
  netLog.delete(source.tabId)
  clearTimeout(attached.get(source.tabId))
  attached.delete(source.tabId)
  emulated.delete(source.tabId)
  // Once detached, Chrome shows dialogs by itself again (Dool2 can no longer answer them)
  dialogs.delete(source.tabId)
  // If the user pressed "Cancel", that tab is no longer handled
  if (reason === 'canceled_by_user') stoppedByUser.add(source.tabId)
})

/** Commands that work even while a confirm dialog is open (the rest get no answer because the page is frozen) */
const DIALOG_SAFE = /^(?:Page\.(?:enable|handleJavaScriptDialog)|Network\.|Emulation\.clear)/

async function cdp<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  if (stoppedByUser.has(tabId)) throw new Error('The user stopped Dool2 from controlling this tab')
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3')
    attached.set(
      tabId,
      setTimeout(() => {}, 0),
    )
    // Catch site dialogs right after attaching. Without it a dialog opened in a debugger-attached tab stays unclosed
    // and freezes the page forever (measured: reads kept timing out after a click). If a dialog is already open there is no answer, so do not wait long
    await Promise.race([chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {}), sleep(2000)])
  }
  const open = dialogs.get(tabId)
  if (open && !DIALOG_SAFE.test(method)) throw new Error(dialogBlocked(open))
  // Detach after a while of no use (so the "controlled" bar above the browser does not stay forever)
  clearTimeout(attached.get(tabId))
  attached.set(
    tabId,
    setTimeout(() => idleDetach(tabId), DEBUGGER_IDLE_MS),
  )
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T
}

function idleDetach(tabId: number) {
  // While a confirm dialog is open, detaching leaves nobody able to close it and the page frozen: stay attached
  if (dialogs.has(tabId)) {
    attached.set(
      tabId,
      setTimeout(() => idleDetach(tabId), DEBUGGER_IDLE_MS),
    )
    return
  }
  attached.delete(tabId)
  chrome.debugger.detach({ tabId }).catch(() => {})
}

// ── Site dialogs (alert, confirm, prompt, leave-page confirmation) ──
// alert has only [OK], so close it at once and keep only the text (the AI must see things like "Wrong ID or password").
// A leave-page confirmation only appears when Dool2 tries to leave that page, so leave.
// confirm and prompt are choices, so the hand does not decide: leave them open and let the daemon choose (dialog command)

interface SiteDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  url: string
  defaultPrompt?: string
  /** Dool2 pressed [OK]/[Leave] right away (alert, leave-page confirmation; reported as is in the result) */
  autoAccepted?: boolean
}
/** Confirm dialogs (confirm, prompt) open per tab */
const dialogs = new Map<number, SiteDialog>()
/** Alerts Dool2 closed right away per tab (reported with the next page read) */
const dialogNotes = new Map<number, SiteDialog[]>()

function dialogBlocked(d: SiteDialog) {
  return `A site confirm dialog is open and the page is frozen: "${d.message.slice(0, 200)}" - choose OK or Cancel first`
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId
  if (tabId === undefined) return
  if (method === 'Page.javascriptDialogClosed') {
    dialogs.delete(tabId)
    return
  }
  // Attempt to open a new window (whether it was blocked is judged by whether a new tab appeared)
  if (method === 'Page.windowOpen') {
    noteOpen(tabId, String((params as { url?: string }).url ?? ''))
    return
  }
  if (method !== 'Page.javascriptDialogOpening') return
  const p = params as { type?: string; message?: string; url?: string; defaultPrompt?: string }
  const d: SiteDialog = {
    type: (['alert', 'confirm', 'prompt', 'beforeunload'] as const).find((t) => t === p.type) ?? 'alert',
    message: String(p.message ?? '').slice(0, 1000),
    url: String(p.url ?? ''),
    ...(p.type === 'prompt' ? { defaultPrompt: String(p.defaultPrompt ?? '') } : {}),
  }
  if (d.type === 'confirm' || d.type === 'prompt') {
    dialogs.set(tabId, d)
    return
  }
  const notes = dialogNotes.get(tabId) ?? []
  // The same alert is sometimes reported several times at once (measured): keep only one.
  // A leave-page confirmation only appears when Dool2 ordered the navigation, so leave anyway, but report it in the next result instead of doing it quietly
  d.autoAccepted = true
  const last = notes.at(-1)
  if (!last || last.type !== d.type || last.message !== d.message) notes.push(d)
  dialogNotes.set(tabId, notes.slice(-5))
  chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
})

/** Dialogs to report with a read: open confirm dialogs and the alerts closed meanwhile (cleared once reported) */
function takeDialogs(tabId: number): { dialog?: SiteDialog; dialogNotes?: SiteDialog[] } {
  const notes = dialogNotes.get(tabId)
  dialogNotes.delete(tabId)
  const open = dialogs.get(tabId)
  return { ...(open ? { dialog: open } : {}), ...(notes?.length ? { dialogNotes: notes } : {}) }
}

/** Start catching dialogs of this tab (attach the debugger and Page.enable). Does nothing if already attached */
async function watch(tabId: number) {
  if (attached.has(tabId) || stoppedByUser.has(tabId)) return
  await Promise.race([cdp(tabId, 'Page.enable').catch(() => {}), sleep(2500)])
}

// ── Listening to responses the page receives (connector capture) ──
// Dool2 sends no requests. It only reads, among the responses the site fetches itself when a person opens that screen, the ones it needs.
interface NetEntry {
  id: string
  url: string
  status: number
  done: boolean
}
const netLog = new Map<number, NetEntry[]>()
const listening = new Set<number>()

async function listen(tabId: number) {
  await cdp(tabId, 'Network.enable', { maxTotalBufferSize: 30_000_000, maxResourceBufferSize: 8_000_000 })
  listening.add(tabId)
  netLog.set(tabId, [])
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId
  if (tabId === undefined || !listening.has(tabId)) return
  const p = params as {
    requestId?: string
    type?: string
    response?: { url: string; status: number }
  }
  const log = netLog.get(tabId)
  if (!log || !p.requestId) return
  if (method === 'Network.responseReceived' && p.response && (p.type === 'XHR' || p.type === 'Fetch')) {
    log.push({ id: p.requestId, url: p.response.url, status: p.response.status, done: false })
    if (log.length > 300) log.splice(0, log.length - 300)
  } else if (method === 'Network.loadingFinished') {
    const e = log.find((x) => x.id === p.requestId)
    if (e) e.done = true
  }
})

/**
 * Make a tab paint one frame. If the window is hidden behind another, Chrome does not paint that tab,
 * so on sites that update state on the next paint, typing, Enter and closing popups stay half stuck
 * (measured: on an unattended Mac's usual Chrome, Enter in Catch Table search did nothing and a closed popup button kept being read).
 * A 1x1 screenshot paints one frame. It does not bring the window forward, so it does not disturb someone using the Mac
 */
async function paint(tabId: number) {
  // On screens that cannot paint (virtual screens, sleeping windows) no answer may come: do not wait long.
  // Capture at the top-left of what is visible now (clip is document-based, so 0,0 on a scrolled page is off-screen. Capturing off-screen
  // makes Chrome shift the paint for a moment, after which click positions in other sites' frames were off by the scroll amount - the address search button could not be clicked)
  await Promise.race([
    (async () => {
      const o = await scrollOffset(tabId, 'visual')
      await cdp(tabId, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: 10,
        clip: { x: o.x, y: o.y, width: 1, height: 1, scale: 1 },
      })
    })().catch(() => {}),
    sleep(1500),
  ])
}

/**
 * Page.captureScreenshot's clip is document-based (position plus the scroll amount). To capture a viewport-based position
 * (getBoundingClientRect), add the scroll amount. It used to pass viewport coordinates as is, so a scrolled page captured the wrong place (the top).
 * layout: element box (layout viewport based), visual: what the person sees (the zoomed phone view)
 */
async function scrollOffset(tabId: number, kind: 'layout' | 'visual'): Promise<{ x: number; y: number }> {
  type V = { pageX: number; pageY: number }
  const m = await cdp<{ cssLayoutViewport?: V; cssVisualViewport?: V }>(tabId, 'Page.getLayoutMetrics').catch(
    () => undefined,
  )
  const v = kind === 'layout' ? m?.cssLayoutViewport : m?.cssVisualViewport
  return { x: v?.pageX ?? 0, y: v?.pageY ?? 0 }
}

/** Tabs where the remote "only the needed fields" were taken from inside a frame: that frame (fills are sent there) */
const formFrames = new Map<number, { frameId: number; url: string }>()
const FORM_FRAME = 'fr'
const FORM_FRAME_ID = /^fr(\d+)~(.+)$/

/** Tabs drawn at phone width (remote screen) */
const phoneView = new Set<number>()

/** For tabs drawn at phone size: the phone size, and whether drawn wider because of a clipped window */
const phoneSize = new Map<number, { w: number; h: number; wide: boolean }>()

async function phoneWidth(tabId: number, w: number, h: number) {
  await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 2,
    mobile: true,
  })
  phoneView.add(tabId)
  phoneSize.set(tabId, { w, h, wide: false })
  await sleep(250)
}

/**
 * If inputs or buttons are clipped off-screen at phone width (PC windows with a fixed width: Gov24 simple authentication), draw wider up to an unclipped width.
 * The phone sees the PC screen shrunk and can pinch to zoom. Clipped fields can be neither seen nor tapped on the phone
 */
async function widenIfCut(tabId: number) {
  const s = phoneSize.get(tabId)
  if (!s || s.wide) return
  const cut = () => inPage(tabId, pageCutOff).catch(() => 0)
  if ((await cut()) < 2) return
  for (const width of [768, 1024, 1280]) {
    await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
      width,
      height: Math.round((s.h * width) / s.w),
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(250)
    if ((await cut()) < 2) break
  }
  s.wide = true
}

async function refitAfterTap(tabId: number, before: string | undefined) {
  const s = phoneSize.get(tabId)
  if (!s) return
  // If it moved to another screen while drawn wider, go back to phone width (when authentication ended and it went on to the application screen)
  if (s.wide && (await chrome.tabs.get(tabId)).url !== before) await phoneWidth(tabId, s.w, s.h)
  // Time for the window opened by the click to paint
  else if (!s.wide) await sleep(400)
  await widenIfCut(tabId)
}

/**
 * For windows clipped below the screen (payment PIN keypads, etc.): draw with a taller viewport so the part below is visible.
 * A window that stays off-screen even when scrolled (fixed position) gives an empty capture, and the mouse cannot reach it either
 * (measured 11-20: a Coupang keypad was cut off below the window and the button images were all gray, so Dool2 could not read the digits)
 */
async function tallerIfBelow(tabId: number, bottom: number): Promise<boolean> {
  if (phoneView.has(tabId) || emulated.has(tabId)) return false
  const v = await inPage(tabId, pageViewport)
  if (bottom <= v.height - 2) return false
  await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
    width: Math.round(v.width),
    height: Math.min(4000, Math.ceil(bottom + 80)),
    deviceScaleFactor: 0,
    mobile: false,
  })
  await sleep(350)
  return true
}
/** A tab left tall by keepTall: a timer that restores it later anyway (so it does not stay if the PIN could not be finished) */
const keptTall = new Map<number, ReturnType<typeof setTimeout>>()
function keepTallFor(tabId: number) {
  clearTimeout(keptTall.get(tabId))
  keptTall.set(
    tabId,
    setTimeout(() => {
      keptTall.delete(tabId)
      void restoreHeight(tabId)
    }, 3_000),
  )
}
/** Restore the stretched viewport height (if left, later captures and click positions were off - measured 11-20 Gmarket adding a delivery address) */
async function restoreHeight(tabId: number) {
  clearTimeout(keptTall.get(tabId))
  keptTall.delete(tabId)
  if (phoneView.has(tabId) || emulated.has(tabId)) return
  await cdp(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {})
  await sleep(150)
}

async function leavePhoneView(tabId: number) {
  phoneSize.delete(tabId)
  const fitted = emulated.delete(tabId)
  if (!phoneView.delete(tabId) && !fitted) return
  await cdp(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {})
}

async function detach(tabId: number) {
  clearTimeout(attached.get(tabId))
  if (attached.delete(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {})
}

async function inPage<A extends unknown[], R>(
  tabId: number,
  func: (...args: A) => R,
  ...args: A
): Promise<R> {
  return inFrame(tabId, 0, func, ...args)
}

async function inFrame<A extends unknown[], R>(
  tabId: number,
  frameId: number,
  func: (...args: A) => R,
  ...args: A
): Promise<R> {
  // With a confirm dialog open the page script is frozen and no answer comes (report instead of waiting)
  const open = dialogs.get(tabId)
  if (open) throw new Error(dialogBlocked(open))
  const target = frameId ? { tabId, frameIds: [frameId] } : { tabId }
  const [res] = await chrome.scripting.executeScript({ target, world: 'ISOLATED', func, args })
  return res?.result as R
}

/** Mark boxes that only have React/Vue click handlers (visible only in the page script world). Reading continues even if it fails.
 *  Also hooks window.open watching (to notice blocked new windows) */
async function markTaps(tabId: number, frameId: number) {
  const target = frameId ? { tabId, frameIds: [frameId] } : { tabId }
  await Promise.all([
    chrome.scripting.executeScript({ target, world: 'MAIN', func: pageMarkTaps }).catch(() => {}),
    chrome.scripting.executeScript({ target, world: 'MAIN', func: pageHookOpen }).catch(() => {}),
  ])
}

// ── Frames in the page (iframe): sites that put the login fields inside a frame (Agoda, etc.) ──
/** The mark number range of one frame (frame n -> e{n*10000+1}...) */
const FRAME_SPAN = 10_000
/** Per tab: mark range number -> extension frameId and URL (all frames read; vanished frames are dropped when reading) */
const frameMaps = new Map<number, Map<number, { frameId: number; url: string }>>()
/**
 * Pin frame -> number per tab. Numbering by visible order on each read shifted numbers when ad frames came and went,
 * so a mark just read (e30010) pointed at another frame when clicked (measured 11-20 Gmarket: could not click the address search result)
 */
const frameIndexes = new Map<number, Map<number, number>>()

/** Which frame a mark (e10012) belongs to */
function frameOf(tabId: number, ref: string): { frameId: number; url?: string; index: number } {
  const n = Number(ref.slice(1))
  const index = Math.floor(n / FRAME_SPAN)
  if (!index) return { frameId: 0, index: 0 }
  const f = frameMaps.get(tabId)?.get(index)
  if (!f) throw new Error(`${ref} was not found. Read the page again`)
  return { frameId: f.frameId, url: f.url, index }
}

function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname || url
  } catch {
    return url
  }
}

/**
 * Where a position inside a frame (px, py: relative to that frame's viewport) is on the page viewport.
 * Go up frame -> outer frame -> ... -> page, at each step measuring the frame box in the outer document and adding it (nested frames).
 * At each step: (1) if same-origin the frame measures its own box (frameElement) (2) find it in the outer document by URL and size
 * (3) if several look alike, ask by message which frame it is (4) if still unknown, measure the frame owner with the debugger (CDP).
 * If none works, throw: it used to assume (0,0) and clicked the wrong place.
 * scroll: if the position is outside the outer viewport, scroll the outer one so it shows (clicks and photos)
 */
async function framePoint(
  tabId: number,
  frameId: number,
  px: number,
  py: number,
  scroll = true,
): Promise<{ x: number; y: number }> {
  if (!frameId) return { x: px, y: py }
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? []
  const byId = new Map(frames.map((f) => [f.frameId, f]))
  let cur = frameId
  let x = px
  let y = py
  for (let depth = 0; cur !== 0; depth++) {
    const f = byId.get(cur)
    if (!f || depth > 10) throw new Error('The frame on the page is gone. Read the page again')
    const parent = Math.max(f.parentFrameId, 0)
    const self = await inFrame(tabId, cur, pageFrameSelf, scroll ? y : -1).catch(() => undefined)
    let box = self?.owner
    if (!box) {
      let r = await inFrame(
        tabId,
        parent,
        pageFrameBox,
        f.url,
        self?.w ?? 0,
        self?.h ?? 0,
        scroll ? y : -1,
        -1,
      ).catch(() => undefined)
      if (r && 'ambiguous' in r) {
        const pick = await probeFrame(tabId, parent, cur)
        r =
          pick >= 0
            ? await inFrame(tabId, parent, pageFrameBox, f.url, 0, 0, scroll ? y : -1, pick).catch(
                () => undefined,
              )
            : undefined
      }
      if (r && !('ambiguous' in r)) box = r
    }
    if (!box) {
      // The debugger gives the position relative to the page viewport directly (outer steps are not added)
      const abs = await frameOwnerCdp(tabId, f.url).catch(() => undefined)
      if (abs) return { x: abs.x + x, y: abs.y + y }
      throw new Error(
        `Could not locate the frame (${hostOf(f.url)}) on the page, so nothing was clicked. Read the page again or check with browser_screenshot`,
      )
    }
    x += box.x
    y += box.y
    cur = parent
  }
  return { x, y }
}

/** When several frames look alike: the inner frame sends a message to the outer one to tell which frame it is (index, -1 if unknown) */
async function probeFrame(tabId: number, parent: number, child: number): Promise<number> {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  if (!(await inFrame(tabId, parent, pageFrameProbeListen, token).catch(() => false))) return -1
  await inFrame(tabId, child, pageFrameProbeSend, token).catch(() => false)
  for (let i = 0; i < 6; i++) {
    await sleep(60)
    const n = await inFrame(tabId, parent, pageFrameProbeRead, token).catch(() => -1)
    if (n >= 0) return n
  }
  return -1
}

/** CDP: when only one frame has that URL, the inner box of the frame's owner element (page viewport based). undefined if several or none */
async function frameOwnerCdp(tabId: number, url: string): Promise<{ x: number; y: number } | undefined> {
  type Tree = { frame: { id: string; url: string }; childFrames?: Tree[] }
  const tree = (await cdp(tabId, 'Page.getFrameTree', {})) as { frameTree: Tree }
  const all: Tree[] = []
  const walk = (t: Tree) => {
    all.push(t)
    for (const c of t.childFrames ?? []) walk(c)
  }
  walk(tree.frameTree)
  const subs = all.filter((t) => t !== tree.frameTree)
  let hits = subs.filter((t) => t.frame.url === url)
  if (!hits.length) hits = subs.filter((t) => url.startsWith(t.frame.url) && t.frame.url.length > 8)
  const hit = hits.length === 1 ? hits[0] : undefined
  if (!hit) return undefined
  const owner = (await cdp(tabId, 'DOM.getFrameOwner', { frameId: hit.frame.id })) as {
    backendNodeId: number
  }
  const box = (await cdp(tabId, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId })) as {
    model: { content: number[] }
  }
  const [x, y] = box.model.content
  if (x === undefined || y === undefined) return undefined
  return { x, y }
}

/**
 * Whether it is the same site (www.agoda.com <-> accounts.agoda.com, shop.co.kr <-> login.shop.co.kr, shop.com.au).
 * With three or more labels and a short shared second label (co, or, go, ne, ac, re, pe, com, net, org), the site is the first three labels.
 * IPs and localhost are taken as they are
 */
function siteOf(origin: string): string {
  try {
    const host = new URL(origin).hostname
    if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host
    const parts = host.split('.')
    const sld = parts.at(-2) ?? ''
    const keep = parts.length >= 3 && /^(co|or|go|ne|ac|re|pe|com|net|org)$/.test(sld) ? 3 : 2
    return parts.slice(-keep).join('.')
  } catch {
    return origin
  }
}

/**
 * Put this tab in front inside the Dool2 window. Chrome does not paint background tabs, so they take no input.
 * The Dool2 window holds only Dool2 tabs, so user tabs are unaffected (the window itself is not brought forward)
 */
async function frontTab(tabId: number) {
  const t = await chrome.tabs.get(tabId)
  if (t.active) return
  await chrome.tabs.update(tabId, { active: true })
  await sleep(150)
}

/** force: do not stop even if the surrounding text changed or another button covers it (when the AI looked at the screen and decided to click anyway) */
async function locate(tabId: number, ref: unknown, mode: LocateMode, force = false): Promise<LocateResult> {
  if (typeof ref !== 'string' || !/^e\d+$/.test(ref)) throw new Error('ref must be a mark like e12')
  await frontTab(tabId)
  const f = frameOf(tabId, ref)
  const r = await inFrame(tabId, f.frameId, pageLocate, ref, mode, force)
  if (!r?.ok) throw new Error(r?.error ?? 'Element not found')
  if (!f.frameId) return r
  // Coordinates in a frame -> page viewport coordinates (nested frames add up step by step. Throw if it cannot be measured)
  const p = await framePoint(tabId, f.frameId, r.x, r.y)
  const v = await inPage(tabId, pageViewport)
  const outside = Boolean(r.outside) || p.x < 0 || p.y < 0 || p.x > v.width || p.y > v.height
  return {
    ...r,
    x: p.x,
    y: p.y,
    frame: true,
    ...(outside ? { outside } : {}),
    ...(r.bottom !== undefined ? { bottom: p.y + (r.bottom - r.y) } : {}),
  }
}

// ── Mouse movement ──
// Move the mouse to the target like a person, then click. Clicking without movement does not open hover menus,
// and clicks a button the mouse never entered, so the site may judge it was not human input
/** Last mouse position per tab */
const pointer = new Map<number, { x: number; y: number }>()
/** Tabs where the release (mouseReleased) was not confirmed: resend the release before the next action so the button does not stay "held" */
const stillPressed = new Set<number>()

/**
 * If the release of the previous click is lost while the page changes, the page thinks the button is still held. Moving the cursor then becomes a drag
 * (measured: in Google Calendar, after deleting an event, clicking the next event chip moved the event to another day and "Undo" appeared)
 */
async function releaseIfPressed(tabId: number) {
  if (!stillPressed.has(tabId)) return
  const at = pointer.get(tabId) ?? { x: 0, y: 0 }
  await Promise.race([
    cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: at.x,
      y: at.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    }).catch(() => undefined),
    sleep(500),
  ])
  stillPressed.delete(tabId)
}

async function moveMouse(tabId: number, x: number, y: number) {
  await releaseIfPressed(tabId)
  const from = pointer.get(tabId) ?? { x: Math.max(x - 140, 0), y: y + 90 }
  const dist = Math.hypot(x - from.x, y - from.y)
  const n = Math.min(12, Math.max(3, Math.round(dist / 60)))
  // Slows toward the end and curves slightly (a straight constant-speed line is not a human hand)
  const bend = Math.min(dist * 0.08, 18) * (from.x < x ? 1 : -1)
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const e = 1 - (1 - t) ** 3
    const px = from.x + (x - from.x) * e
    const py = from.y + (y - from.y) * e + Math.sin(Math.PI * t) * bend
    // Occluded tabs answer input confirmation slowly: do not wait long
    await Promise.race([
      cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: px,
        y: py,
        button: 'none',
        pointerType: 'mouse',
      }),
      sleep(300),
    ])
    await sleep(8)
  }
  pointer.set(tabId, { x, y })
}

/** Show what Dool2 is doing as a cursor on the page (work goes on even if it fails) */
function showCursor(tabId: number, x: number, y: number, label: string) {
  if (dialogs.has(tabId)) return Promise.resolve()
  return chrome.scripting
    .executeScript({ target: { tabId }, world: 'ISOLATED', func: pageCursor, args: [x, y, label] })
    .then(() => undefined)
    .catch(() => undefined)
}

/** label: if Dool2 is acting, show the cursor and move the mouse there. Without it (a person tapping remotely) go straight to the spot */
async function clickAt(tabId: number, x: number, y: number, label?: string) {
  const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' }
  // Paint one frame before moving the mouse: a click right after a capture (within tens of ms) did not reach other sites' frames (OOPIF) and was
  // dropped (measured: the [Find postal code] button in a test shop's address frame could not be clicked with the mouse; after 50ms it reached)
  await paint(tabId)
  await sleep(50)
  if (label) {
    await showCursor(tabId, x, y, label)
    await moveMouse(tabId, x, y)
    await sleep(40)
  } else {
    await Promise.race([
      cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        pointerType: 'mouse',
      }),
      sleep(300),
    ])
    pointer.set(tabId, { x, y })
  }
  await releaseIfPressed(tabId)
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
  stillPressed.add(tabId)
  // If the click brings a new tab to the front this tab goes behind and is not painted, so input confirmation is seconds late. Do not wait long
  await Promise.race([
    cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }).then(() =>
      stillPressed.delete(tabId),
    ),
    sleep(1000),
  ])
}

async function pressKey(tabId: number, name: string) {
  const k = keyDef(name)
  if (!k) throw new Error(`Unknown key: ${name}`)
  // Paint one frame first so typed text is reflected in the site state (Enter on an occluded window became an empty search)
  await paint(tabId)
  const common = {
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
  }
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: k.text ? 'keyDown' : 'rawKeyDown',
    ...common,
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
  })
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

/**
 * Type one key at a time (digits, letters, symbols). For secure input fields that do not accept inserting all at once (insertText)
 * (measured: the phone number field of a financial certificate window got 0 characters when inserted at once)
 */
async function typeKeys(tabId: number, text: string) {
  for (const ch of text) {
    const digit = /[0-9]/.test(ch)
    const letter = /[a-zA-Z]/.test(ch)
    const code = digit ? `Digit${ch}` : letter ? `Key${ch.toUpperCase()}` : ''
    const keyCode = digit ? 48 + Number(ch) : letter ? ch.toUpperCase().charCodeAt(0) : 0
    const common = { key: ch, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: ch, unmodifiedText: ch })
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    await sleep(40)
  }
}

/**
 * Type into a spot drawn by an editor (a title or body box that is not a text field). Such editors (Naver Blog SmartEditor ONE, etc.) do not take text directly:
 * clicking gives focus to a hidden field (a contenteditable inside a frame), and text that arrives there is redrawn. So instead of script focus,
 * click the spot with the real mouse and type where focus went (Input.insertText goes to the focused frame).
 * Newlines are Enter (the editor makes a new paragraph). After typing, check that the last line is visible in the page text and report it
 */
async function typeDrawn(tabId: number, ref: string, at: LocateResult, text: string, submit: boolean) {
  const fid = frameOf(tabId, ref).frameId
  await clickAt(tabId, at.x, at.y, txt.cursorTyping)
  await sleep(150)
  // If there is text already, continue at the end rather than where it was clicked (the middle)
  if (at.filled) await pressKey(tabId, 'End')
  const lines = text.split(/\r?\n/)
  for (const [i, line] of lines.entries()) {
    if (i) await pressKey(tabId, 'Enter')
    if (line) await cdp(tabId, 'Input.insertText', { text: line })
  }
  const probe = (lines.filter((l) => l.trim()).at(-1) ?? '').trim().slice(-40)
  const shows = async () =>
    (await inFrame(tabId, fid, pageShowsText, probe).catch(() => false)) ||
    (fid !== 0 && (await inPage(tabId, pageShowsText, probe).catch(() => false)))
  let seen = await shows()
  if (!seen) {
    // Editors that redraw late: look again after a moment
    await sleep(400)
    seen = await shows()
  }
  if (submit) {
    const before = (await chrome.tabs.get(tabId)).url
    await sleep(300)
    await pressKey(tabId, 'Enter')
    await settle(tabId, before)
  }
  return { ...(await pageState(tabId)), drawn: true, seen }
}

async function pageState(tabId: number) {
  const t = await chrome.tabs.get(tabId)
  const open = dialogs.get(tabId)
  return { tabId, url: t.url ?? '', title: t.title ?? '', ...(open ? { dialog: open } : {}) }
}

/**
 * The newest not-yet-reported new tab opened by this tab (since: only ones opened after this time). Reporting marks it as reported.
 * Tabs already closed are not reported
 */
async function takePopup(opener: number, since = 0): Promise<{ newTabId?: number }> {
  let found: number | undefined
  await update(async (s) => {
    const fresh = (s.recs ?? [])
      .filter(
        (r) => r.opener === opener && !r.seen && !r.closedAt && r.at >= since && s.owned.includes(r.tabId),
      )
      .sort((a, b) => b.at - a.at)
    for (const r of fresh) {
      if (!(await chrome.tabs.get(r.tabId).catch(() => undefined))) continue
      r.seen = true
      found = r.tabId
      break
    }
  })
  return found !== undefined ? { newTabId: found } : {}
}
/** Whether this tab opened a new tab after `since` (does not mark it as reported) */
async function openedSince(opener: number, since: number): Promise<boolean> {
  const s = await load()
  return (s.recs ?? []).some((r) => r.opener === opener && r.at >= since)
}

// ── Blocked new windows ──
// If the page called window.open (left by pageHookOpen, and the debugger's Page.windowOpen) but no new tab appeared,
// Chrome blocked it as a popup. If a late payment window is blocked the screen stays white (measured 11-20 Gmarket)
interface OpenAttempt {
  url: string
  at: number
  told?: boolean
}
const openAttempts = new Map<number, OpenAttempt[]>()
function noteOpen(tabId: number, url: string, at = Date.now()) {
  const list = (openAttempts.get(tabId) ?? []).filter((x) => Date.now() - x.at < 10 * 60_000)
  // If the same call arrives by both routes (page and debugger), keep one
  if (!list.some((x) => x.url === url && Math.abs(x.at - at) < 1_500)) list.push({ url, at })
  openAttempts.set(tabId, list.slice(-10))
}
/** Collect window.open calls the page left and return the ones with no new tab (blocked new windows). tell: mark as reported */
async function blockedPopups(tabId: number, tell = true): Promise<{ url: string; at: number }[]> {
  // With a confirm dialog open the page script is frozen and gives no answer: look only at what was already collected
  const got = dialogs.has(tabId)
    ? []
    : await Promise.race([
        chrome.scripting
          .executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: pageReadOpens })
          .catch(() => []),
        sleep(1_500).then(() => []),
      ])
  for (const g of got)
    for (const o of (g.result ?? []) as { url: string; at: number }[]) noteOpen(tabId, o.url, o.at)
  const list = openAttempts.get(tabId) ?? []
  if (!list.length) return []
  const s = await load()
  const now = Date.now()
  // Pair one new tab with each call (if two windows open at once only the second is blocked: the first window must not pair with both)
  const recs = (s.recs ?? []).filter((r) => r.opener === tabId)
  const urls = new Map<number, string>()
  for (const r of recs) {
    const t = await chrome.tabs.get(r.tabId).catch(() => undefined)
    urls.set(r.tabId, t?.pendingUrl || t?.url || r.url || '')
  }
  const used = new Set<number>()
  const out: { url: string; at: number }[] = []
  for (const a of [...list].sort((x, y) => x.at - y.at)) {
    const near = recs.filter((r) => !used.has(r.tabId) && r.at >= a.at - 500 && r.at - a.at < 5_000)
    const blank = (u?: string) => !u || u === 'about:blank'
    const hit =
      near.find((r) => a.url && urls.get(r.tabId) === a.url) ??
      near.find((r) => blank(urls.get(r.tabId)) || !a.url)
    if (hit) {
      used.add(hit.tabId)
      a.told = true
      continue
    }
    // One that was just called may still be opening
    if (now - a.at < 1_500 || (tell && a.told)) continue
    out.push({ url: a.url, at: a.at })
    if (tell) a.told = true
  }
  return out
}

// ── Reading frames ──
// Frames read: http(s) and about:blank / about:srcdoc (many payment companies create an empty frame and fill it with script).
// Even without clickable items, frames with text (amounts, error messages) are included briefly. They are listed in screen order (top to bottom), with a frame list at the front
const READ_FRAME = /^(?:https?:|about:(?:blank|srcdoc)$)/
const LOOK_FRAMES = 40
/** Frames with text only get at most this much */
const TEXT_ONLY_MAX = 400

interface FrameItem {
  index: number
  frameId: number
  url: string
  /** Outer frame number (0 = main page) */
  parent: number
  shown: boolean
  loading: boolean
  refs: boolean
  truncated: boolean
  /** The position was guessed by order among frames with the same URL and size */
  guess?: boolean
}
interface FramesRead {
  text: string
  list: FrameItem[]
  captcha: boolean
  /** frame frameId -> read result (when replacing frame placeholders in the text) */
  marks: Map<number, Map<number, number>>
  blocked: { url: string; at: number }[]
}

/** Run jobs n at a time (so script injection does not bunch up on screens with many frames) */
async function inBatches<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn))
}

async function readFrames(
  tabId: number,
  max: number,
  root: Pick<SnapshotResult, 'self' | 'kids'>,
): Promise<FramesRead> {
  const all = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? []
  const fixed = frameIndexes.get(tabId) ?? new Map<number, number>()
  frameIndexes.set(tabId, fixed)
  const map = frameMaps.get(tabId) ?? new Map<number, { frameId: number; url: string }>()
  // Vanished frames are dropped from the map (numbers are kept: so a same frame that reappears with a different number is not mixed with old marks)
  const alive = new Set(all.map((f) => f.frameId))
  for (const [i, f] of map) if (!alive.has(f.frameId)) map.delete(i)
  frameMaps.set(tabId, map)
  const indexOf = (frameId: number) => {
    let index = fixed.get(frameId)
    if (index === undefined) {
      index = Math.max(0, ...fixed.values()) + 1
      fixed.set(frameId, index)
    }
    return index
  }
  const cands = all.filter((f) => f.frameId !== 0 && READ_FRAME.test(f.url)).slice(0, LOOK_FRAMES)
  const per = Math.floor(max / 2)
  const reads = new Map<number, SnapshotResult>()
  await inBatches(cands, 8, async (fr) => {
    const index = indexOf(fr.frameId)
    await markTaps(tabId, fr.frameId)
    const r = await inFrame(tabId, fr.frameId, pageSnapshot, per, index * FRAME_SPAN).catch(() => undefined)
    if (!r) return
    reads.set(fr.frameId, r)
    map.set(index, { frameId: fr.frameId, url: fr.url })
  })
  const mainRead = { self: root.self ?? { w: 0, h: 0 }, kids: root.kids ?? [] }
  const nodes: FrameNode[] = cands.map((fr) => {
    const r = reads.get(fr.frameId)
    return {
      frameId: fr.frameId,
      parentFrameId: Math.max(fr.parentFrameId, 0),
      url: fr.url,
      ...(r?.self ? { self: r.self } : {}),
      ...(r?.kids ? { kids: r.kids } : {}),
    }
  })
  const places = layoutFrames(nodes, mainRead)
  // Placeholders in the text: outer document frameId -> (placeholder number -> frame number)
  const marks = new Map<number, Map<number, number>>()
  for (const n of nodes) {
    const p = places.get(n.frameId)
    const kids =
      n.parentFrameId === 0 ? mainRead.kids : nodes.find((x) => x.frameId === n.parentFrameId)?.kids
    const marker = p?.kid !== undefined ? kids?.[p.kid]?.marker : undefined
    if (marker === undefined) continue
    const m = marks.get(n.parentFrameId) ?? new Map<number, number>()
    m.set(marker, indexOf(n.frameId))
    marks.set(n.parentFrameId, m)
  }
  const nav = frameNav.get(tabId)
  let captcha = false
  type Part = { item: FrameItem; text: string; prio: number }
  const parts: Part[] = []
  let skipped = 0
  for (const n of nodes) {
    const r = reads.get(n.frameId)
    const p = places.get(n.frameId)
    if (!r) {
      skipped++
      continue
    }
    captcha ||= r.captcha
    const refs = /\[e\d+ /.test(r.text)
    const body = r.text.replace(/\u2063F\d+\u2063/g, '').trim()
    const shown = p?.shown ?? false
    // Empty frames and frames with invisible text (ads, tracking) are dropped. Frames with clickable items are included even if invisible (a login window that appears soon)
    if (!refs && (!body || !shown)) {
      skipped++
      continue
    }
    const index = indexOf(n.frameId)
    parts.push({
      item: {
        index,
        frameId: n.frameId,
        url: n.url,
        parent: n.parentFrameId ? indexOf(n.parentFrameId) : 0,
        shown,
        loading: nav?.get(n.frameId)?.loading ?? false,
        refs,
        truncated: r.truncated,
        ...(p?.guess ? { guess: true } : {}),
      },
      text: withFrameMarks(r.text, n.frameId, { marks }),
      prio: refs ? (shown ? 0 : 1) : 2,
    })
  }
  // Space split: visible frames with clickable items, then invisible ones, then text-only ones, within the remaining space
  const total = max + Math.floor(max / 2)
  let room = total - 2_000
  const kept = new Map<number, string>()
  for (const part of [...parts].sort((x, y) => x.prio - y.prio)) {
    const want = part.prio === 2 ? Math.min(part.text.length, TEXT_ONLY_MAX) : part.text.length
    const give = Math.min(want, Math.max(room, 0))
    if (give < 120 && want > 120) {
      part.item.truncated = true
      kept.set(part.item.frameId, '')
      continue
    }
    if (give < part.text.length) part.item.truncated = true
    kept.set(part.item.frameId, part.text.slice(0, give))
    room -= give + 80
  }
  const order = screenOrder(
    parts.map((x) => x.item.frameId),
    places,
  )
  const byId = new Map(parts.map((x) => [x.item.frameId, x]))
  const list = order.map((id) => byId.get(id)?.item).filter((x): x is FrameItem => Boolean(x))
  listedFrames.set(tabId, new Set(list.map((x) => x.frameId)))
  if (!list.length) return { text: '', list, captcha, marks, blocked: [] }
  const where = (u: string) => {
    if (!/^https?:/.test(u)) return u
    try {
      const x = new URL(u)
      return `${x.hostname}${x.pathname}`.slice(0, 60)
    } catch {
      return u.slice(0, 60)
    }
  }
  const head = [
    `\n## ${FRAME_HEADING} list (top to bottom of the screen. Marks inside frame fN start at eN0001: f3 -> e30001...)`,
    ...list.map(
      (f) =>
        `- f${f.index} ${where(f.url)} · outer: ${f.parent ? `f${f.parent}` : 'main'} · ${f.shown ? 'visible' : 'hidden'}${f.loading ? ' · loading' : ''}${f.truncated ? ' · text cut' : ''}${f.refs ? '' : ' · text only'}${f.guess ? ' · position guessed' : ''}`,
    ),
    ...(skipped
      ? [`(${skipped} frames with no text or not visible, like empty frames and ads, were left out)`]
      : []),
  ].join('\n')
  const bodies = list
    .map((f) => {
      const t = kept.get(f.frameId) ?? ''
      const host = /^https?:/.test(f.url) ? hostOf(f.url) : f.url
      const tag = `f${f.index}${f.parent ? `, inside f${f.parent}` : ''}${f.truncated ? ', text cut' : ''}`
      return t
        ? `\n## ${FRAME_HEADING} (${host}) — ${tag}\n${t}`
        : `\n## ${FRAME_HEADING} (${host}) — ${tag}\n(There was no room to include the text. If needed, read again so that only this frame is shown)`
    })
    .join('')
  return { text: `${head}${bodies}`, list, captcha, marks, blocked: [] }
}

/** Turn frame placeholders in the text (U+2063 F{n} U+2063) into [frame f3] (unknown ones become [frame]) */
function withFrameMarks(text: string, frameId: number, read: Pick<FramesRead, 'marks'>): string {
  const m = read.marks.get(frameId)
  return text
    .replace(/\u2063F(\d+)\u2063/g, (_x, n: string) => {
      const index = m?.get(Number(n))
      return index !== undefined ? `[frame f${index}]` : '[frame]'
    })
    .replace(/\u2063F?\d*$/, '')
}

/** Dool2 notices appended to the end of a read result: blocked new windows, tabs closed by tidying, mark renumbering (cleared once reported) */
async function snapshotNotes(tabId: number, main: SnapshotResult, read: FramesRead): Promise<string> {
  const out: string[] = []
  const blocked = await blockedPopups(tabId).catch(() => [])
  read.blocked = blocked
  for (const b of blocked)
    out.push(
      `- This tab tried to open a new window and Chrome blocked it as a popup: ${b.url || '(empty window with no address: it may be the window that submits a payment form)'}. If it is a payment window, Dool2 allows popups for this site when the approved payment button is pressed, so press that button again. If it is a normal window with an address, you may open that address`,
    )
  const told: number[] = []
  const s = await load()
  for (const t of s.tidied ?? []) {
    if (t.told) continue
    told.push(t.tabId)
    out.push(`- Dool2 closed tab ${t.tabId} (${t.title || t.url || 'untitled'}): ${t.why}`)
  }
  if (told.length)
    await update((x) => {
      for (const t of x.tidied ?? []) if (told.includes(t.tabId)) t.told = true
    })
  if (main.renumbered)
    out.push(
      '- The marks on this screen were renumbered from the start. Do not use marks (e...) read before; use the ones on this screen',
    )
  if (main.refsCapped)
    out.push(
      `- There were too many clickable items, so ${main.refsCapped} got no mark (shown only in brackets). Read again with from or view for the part you need`,
    )
  return out.length ? `\n## Dool2 notices\n${out.join('\n')}` : ''
}

// ── Commands ─────────────────────────────────────────────────

async function run(cmd: BrowserCommand, a: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case 'options': {
      // Items to choose in a dropdown (registered card and installments on a payment screen, product options). Choosing is not done here
      const tabId = await ownedTab(a)
      const ref = String(a.ref ?? '')
      const fid = frameOf(tabId, ref).frameId
      let r = await inFrame(tabId, fid, pageSelectOptions, ref, false)
      // Dropdowns that script clicks do not open (modern components take only real input; measured Musinsa, Today's House): open with the real mouse and read again
      if (!r?.options) {
        await inFrame(tabId, fid, pageRememberShown)
        const at = await locate(tabId, ref, 'point')
        await clickAt(tabId, at.x, at.y, txt.cursorOpeningOptions)
        await sleep(700)
        const r2 = await inFrame(tabId, fid, pageSelectOptions, ref, true)
        r = r2?.options
          ? r2
          : { why: `${r?.why ?? ''} / after opening with the mouse: ${r2?.why ?? ''}`.slice(0, 900) }
      }
      return { tabId, options: r?.options ?? null, ...(r?.why ? { why: r.why } : {}) }
    }
    case 'choose': {
      // Choose the one with the same text in the dropdown
      const tabId = await ownedTab(a)
      const ref = String(a.ref ?? '')
      const label = String(a.label ?? '')
      const f = frameOf(tabId, ref)
      const r = await inFrame(tabId, f.frameId, pageSelectChoose, ref, label)
      if (r.ok) return { tabId, label: r.label }
      // If that fails, open with the real mouse and click that item with the real mouse too
      await inFrame(tabId, f.frameId, pageRememberShown)
      const at = await locate(tabId, ref, 'point')
      await clickAt(tabId, at.x, at.y, txt.cursorOpeningOptions)
      await sleep(700)
      const pt = await inFrame(tabId, f.frameId, pageOptionPoint, label)
      if (!pt.ok) throw new Error(pt.error)
      const p = await framePoint(tabId, f.frameId, pt.x, pt.y)
      await clickAt(tabId, p.x, p.y, txt.cursorChoosing(pt.label))
      await sleep(400)
      return { tabId, label: pt.label }
    }
    case 'mark-text': {
      // Mark the place to click by text (then click it normally with click)
      const tabId = await ownedTab(a)
      const text = String(a.text ?? '')
      const r = await inPage(tabId, pageMarkText, text)
      if (r.ok) return r
      // If it is not on the page, look in the frames already read (Naver Blog's editor is entirely inside a frame).
      // The mark is given in that frame's range (e10001...) so the click goes to that frame
      for (const f of frameMaps.get(tabId)?.values() ?? []) {
        const x = await inFrame(tabId, f.frameId, pageMarkText, text).catch(() => undefined)
        if (x?.ok) return x
      }
      throw new Error(r.error)
    }
    case 'thumb': {
      // Card photo: download and shrink to a 360px long side JPEG (smaller to send to the phone, and one image type)
      const url = String(a.url ?? '')
      if (!/^https:\/\//.test(url)) throw new Error('Only https photos are accepted')
      const res = await fetch(url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(8000),
      })
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
      if (!res.ok || !/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) throw new Error('Not an image')
      const blob = await res.blob()
      if (blob.size > 8_000_000) throw new Error('The photo is too large')
      const bmp = await createImageBitmap(blob)
      const scale = Math.min(1, 360 / Math.max(bmp.width, bmp.height))
      const w = Math.max(1, Math.round(bmp.width * scale))
      const hgt = Math.max(1, Math.round(bmp.height * scale))
      const canvas = new OffscreenCanvas(w, hgt)
      const g = canvas.getContext('2d')
      if (!g) throw new Error('Cannot draw it')
      g.fillStyle = '#fff'
      g.fillRect(0, 0, w, hgt)
      g.drawImage(bmp, 0, 0, w, hgt)
      bmp.close()
      const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
      const bytes = new Uint8Array(await out.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return { data: `data:image/jpeg;base64,${btoa(bin)}`, width: w, height: hgt }
    }
    case 'extract': {
      // Connector: pull the list on the screen item by item (read only)
      const tabId = await ownedTab(a)
      await waitLoad(tabId, 10_000, true)
      if (attached.has(tabId)) await paint(tabId)
      const spec = a.spec as ExtractSpec
      let r = await inPage(tabId, pageExtract, spec)
      if (!r.ok) throw new Error(r.error)
      // If a photo slot is empty: it is a late-loading photo. Scroll through the list once so it draws, then read again
      // (if the window is hidden behind another, Chrome does not load off-screen photos - Hotels.com 0/10 -> test window 9/10)
      const pics = Object.entries(spec.fields)
        .filter(([, f]) => f.image)
        .map(([k]) => k)
      const missing = () => (r.ok ? r.rows.filter((row) => pics.some((k) => !row[k])).length : 0)
      if (pics.length && r.ok && r.rows.length && missing() > r.rows.length * 0.2) {
        const total = Math.min(r.total, spec.limit ?? 30, 40)
        for (let i = 0; i < total; i += 2) {
          await inPage(tabId, pageRevealItem, spec.items, i)
          // Paint hidden windows one frame at a time too (so photos that came into view load)
          await paint(tabId)
          await sleep(90)
        }
        await sleep(400)
        await paint(tabId)
        const again = await inPage(tabId, pageExtract, spec)
        await inPage(tabId, pageRevealItem, spec.items, -1)
        if (again.ok) r = again
      }
      return r
    }
    case 'find': {
      // Connector: whether these words are in the page text (waiting and screen checks)
      const tabId = await ownedTab(a)
      if (attached.has(tabId)) await paint(tabId)
      const patterns = (a.patterns ?? {}) as Record<string, string>
      return inPage(tabId, pageFind, patterns)
    }
    case 'capture': {
      // Connector: read the responses (JSON) this tab's page received by itself. Dool2 makes no separate request (ADR 0018)
      const tabId = await ownedTab(a)
      if (!listening.has(tabId))
        throw new Error('This tab is not listening for responses (turn capture on when opening the address)')
      let re: RegExp
      try {
        re = new RegExp(String(a.url ?? ''))
      } catch {
        throw new Error(`Bad address pattern: ${String(a.url)}`)
      }
      const wait = Math.min(Math.max(Number(a.timeoutMs) || 10_000, 500), 30_000)
      const until = Date.now() + wait
      // If data is requested right after a new tab opens, it passes before listening starts (Uniqlo and Daiso Mall were inconsistent in the user's Chrome).
      // If nothing from that address was heard after waiting half the time, reload once and call again. No quiet reloads:
      // only when the caller asked with reloadIfSilent (connector list screens that only read), and it is reported in the result.
      // If not asked, only say it was not heard (reloading a form being filled or a payment screen would lose what was entered)
      const halfway = Date.now() + wait / 2
      let reloaded = a.reloadIfSilent !== true
      for (;;) {
        const hit = (netLog.get(tabId) ?? []).filter((e) => e.done && re.test(e.url)).at(-1)
        if (
          !hit &&
          !reloaded &&
          Date.now() > halfway &&
          !(netLog.get(tabId) ?? []).some((e) => re.test(e.url))
        ) {
          reloaded = true
          await cdp(tabId, 'Page.reload', { ignoreCache: false }).catch(() => {})
          await sleep(300)
        }
        if (hit) {
          const r = await cdp<{ body: string; base64Encoded: boolean }>(tabId, 'Network.getResponseBody', {
            requestId: hit.id,
          })
          const text = r.base64Encoded
            ? new TextDecoder().decode(Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)))
            : r.body
          let data: unknown
          try {
            data = JSON.parse(text)
          } catch {
            throw new Error(`The response the page received is not JSON (${hit.url.slice(0, 80)})`)
          }
          const path = typeof a.pick === 'string' ? a.pick : ''
          return {
            url: hit.url,
            status: hit.status,
            json: pickPath(data, path) ?? null,
            ...(a.reloadIfSilent === true && reloaded ? { reloaded: true } : {}),
          }
        }
        if (Date.now() > until)
          throw new Error(
            `The page did not receive that data (${String(a.url)})${a.reloadIfSilent === true ? '' : '. It may have passed before listening was attached (a reload can call it again)'}`,
          )
        await sleep(200)
      }
    }
    case 'dialog': {
      // Choose in the open confirm dialog (the daemon decides what to choose). expect: only if it is the same dialog the daemon saw
      const tabId = await ownedTab(a)
      const d = dialogs.get(tabId)
      if (!d) throw new Error('No site confirm dialog is open')
      if (typeof a.expect === 'string' && a.expect.slice(0, 200) !== d.message.slice(0, 200))
        throw new Error('The dialog content changed, so nothing was chosen')
      const before = (await chrome.tabs.get(tabId)).url
      await cdp(tabId, 'Page.handleJavaScriptDialog', {
        accept: a.accept !== false,
        ...(d.type === 'prompt' && typeof a.text === 'string' ? { promptText: a.text.slice(0, 500) } : {}),
      })
      dialogs.delete(tabId)
      await settle(tabId, before)
      return pageState(tabId)
    }
    case 'hover': {
      // Hover: only move the mouse to the spot (menus and tooltips that open on hover)
      const tabId = await ownedTab(a)
      const at = await locate(tabId, a.ref, 'point')
      if (at.hidden) throw new Error('The Dool2 window is hidden, so the mouse cannot hover')
      await showCursor(tabId, at.x, at.y, txt.cursorHovering)
      await moveMouse(tabId, at.x, at.y)
      // A window that was not painting reflects the hover state (:hover) only on the next paint or movement: paint one frame and move once more in place
      await paint(tabId)
      await Promise.race([
        cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none' }),
        sleep(300),
      ])
      await settle(tabId)
      return pageState(tabId)
    }
    case 'link-navigates': {
      // Approval gate: whether this link only goes to another screen (the value is only true or false)
      const tabId = await ownedTab(a)
      const frameId = frameOf(tabId, String(a.ref)).frameId
      return {
        navigates: Boolean(
          await inFrame(tabId, frameId, pageLinkNavigates, String(a.ref)).catch(() => false),
        ),
      }
    }
    case 'reload': {
      // Send the answer first, then reload (after reloading it greets the daemon again)
      setTimeout(() => chrome.runtime.reload(), 200)
      return { ok: true }
    }
    case 'update': {
      // The store copy asks Chrome for a newer version now instead of waiting for Chrome's own check every few hours
      // (11-27: the store had 0.3.3 for hours while the test PC still ran 0.3.2). The daemon asks only while idle; when
      // the download is ready the extension reloads itself and greets the daemon again
      updateWanted = true
      const r = (await chrome.runtime.requestUpdateCheck()) as unknown as {
        status?: string
        version?: string
      }
      return { status: r?.status ?? 'unknown', ...(r?.version ? { version: r.version } : {}) }
    }
    case 'open': {
      const url = safeUrl(a.url)
      if (!url) throw new Error('Only http and https addresses can be opened')
      // Open a blank tab first, turn on dialog catching, then go to the address (so dialogs that appear while opening are caught).
      // With capture, also listen to the responses the page receives from the start
      const background = a.background === true
      const tab = await openTab('about:blank', background)
      if (tab.id === undefined) throw new Error('Could not open the tab')
      await watch(tab.id)
      if (a.capture) await listen(tab.id)
      await chrome.tabs.update(tab.id, { url })
      await sleep(200)
      await waitLoad(tab.id)
      // Says it honored background, so the daemon knows this extension can let a lookup read beside another task
      return { ...(await pageState(tab.id)), ...(background ? { background: true } : {}) }
    }
    case 'navigate': {
      const tabId = await ownedTab(a)
      const url = safeUrl(a.url)
      if (!url) throw new Error('Only http and https addresses can be opened')
      if (a.capture) await listen(tabId)
      await chrome.tabs.update(tabId, { url })
      await sleep(200)
      await waitLoad(tabId)
      return pageState(tabId)
    }
    case 'snapshot': {
      const tabId = await ownedTab(a)
      await waitLoad(tabId, 10_000)
      const max = Math.min(Math.max(Number(a.maxChars) || 12_000, 1_000), 40_000)
      // With a confirm dialog open the page is frozen and cannot be read: report only the dialog content
      if (dialogs.has(tabId))
        return {
          ...(await pageState(tabId)),
          text: '',
          truncated: false,
          captcha: false,
          ...takeDialogs(tabId),
        }
      // Finish pending page changes that were frozen, like a closed popup disappearing, then read
      if (attached.has(tabId)) await paint(tabId)
      await markTaps(tabId, 0)
      const scope: ReadScope = {
        ...(a.view === true ? { view: true } : {}),
        ...(typeof a.from === 'string' && a.from.trim() ? { from: a.from.trim().slice(0, 100) } : {}),
        ...(Number(a.skip) > 0 ? { skip: Math.floor(Number(a.skip)) } : {}),
      }
      const main = await inPage(tabId, pageSnapshot, max, 0, scope)
      const read = await readFrames(tabId, max, main)
      const total = max + Math.floor(max / 2)
      // Put frame text first so frames (login, authentication, payment windows) are not cut off, and the body takes the remaining space
      // (measured Hometax: a simple-auth frame appended after 40,000 characters of body was cut by the overall cut and [Authentication done] could not be seen)
      const room = Math.max(total - read.text.length, 2_000)
      const mainText = withFrameMarks(main.text, 0, read)
      const cut = mainText.length > room
      const body = cut ? mainText.slice(0, room) : mainText
      const notes = await snapshotNotes(tabId, main, read)
      const text = `${body}${read.text}${notes}`
      const { kids: _k, self: _s, ...rest } = main
      return {
        tabId,
        ...rest,
        text,
        // Length of the body text (read-continuation skip is this much. Frame text and notices are not body)
        mainLength: body.length,
        truncated: main.truncated || cut,
        frames: read.list,
        captcha: main.captcha || read.captcha,
        ...(read.blocked.length ? { blockedPopups: read.blocked } : {}),
        ...takeDialogs(tabId),
      }
    }
    case 'click': {
      const tabId = await ownedTab(a)
      const ref = String(a.ref ?? '')
      const force = a.force === true
      // When pressing the same spot repeatedly like a payment PIN keypad: do not show cursor movement, wait only briefly (one digit took 2.3s - measured)
      const quick = a.quick === true
      // keepTall: another click follows, so do not yet restore the stretched viewport height (restore at the last digit)
      const keepTall = quick && a.keepTall === true
      let at = await locate(tabId, ref, 'point', force)
      // Only for items off-screen even when scrolled (a payment keypad fixed at the bottom), stretch the viewport height briefly so the mouse can reach (restored after the click)
      const tall = at.outside
        ? await tallerIfBelow(tabId, (at.bottom ?? at.y) + 30).catch(() => false)
        : false
      if (tall) at = await locate(tabId, ref, 'point', force)
      // After scrolling, late-loading images and lists can shift positions, or a list recycles slots and draws something else.
      // Let it paint briefly, then measure again (if something else was drawn, locate stops with "read the page again")
      if (at.moved) {
        await sleep(300)
        await paint(tabId)
        at = await locate(tabId, ref, 'point', force)
      }
      const t0 = Date.now()
      const before = (await chrome.tabs.get(tabId)).url
      const fid = frameOf(tabId, ref).frameId
      // Hook window.open watching to notice blocked new windows (the page may have changed since the read, so again. If already hooked, left as is)
      await chrome.scripting
        .executeScript({
          target: fid ? { tabId, frameIds: [fid] } : { tabId },
          world: 'MAIN',
          func: pageHookOpen,
        })
        .catch(() => undefined)
      let via: 'mouse' | 'key' | 'script' = 'mouse'
      // Screen signature: URL, focus, number of checked boxes, document size (looked at inside that frame)
      const mark = () =>
        inFrame(tabId, fid, () => {
          const f = document.activeElement
          return [
            location.href,
            f ? `${f.tagName}#${f.id}.${f.getAttribute('name') ?? ''}` : '',
            document.querySelectorAll(':checked').length,
            document.body?.getElementsByTagName('*').length ?? 0,
            document.body?.innerText.length ?? 0,
          ].join('|')
        }).catch(() => '')
      const noHit = { armed: false, hit: false, n: 0 } as ReturnType<typeof pageHitRead>
      // Whether it landed: if real input (isTrusted) reached the element, it was clicked. Do not click again
      // (a button whose page text does not change was judged "not clicked" and clicked again, so a keypad digit went in twice - measured Coupang payment PIN)
      let delivered = false
      let hitOther: string | undefined
      const mouse = !at.hidden && !at.outside && !at.coveredByControl
      let retry = false
      if (mouse) {
        const [sig] = await Promise.all([
          mark(),
          inFrame(tabId, fid, pageMutArm, 'click').catch(() => false),
          inFrame(tabId, fid, pageHitArm, ref).catch(() => false),
        ])
        await clickAt(tabId, at.x, at.y, quick ? undefined : txt.cursorClicking)
        await settle(tabId, before, quick)
        const hit = await inFrame(tabId, fid, pageHitRead, false).catch(() => noHit)
        const opened = await openedSince(tabId, t0)
        // If the document changed (navigation), what was hooked is gone: the click went through and it navigated
        delivered = hit.hit || opened || !hit.armed
        if (!hit.hit && hit.other) hitOther = hit.other
        if (!delivered) {
          // Even without a landing record, if the page changed do not click again (the site may have intercepted the input first)
          const mut = await inFrame(tabId, fid, pageMutRead, 'click', true).catch(() => ({ n: -1 }))
          const same = sig !== '' && sig === (await mark())
          // If the window is partly occluded, Chrome sometimes drops mouse input even when it says "visible" (measured: authentication code confirm button).
          // Toggles (checkboxes, etc.) flip back if clicked again, so do not click again. once: still only one time
          retry = same && mut.n <= 0 && !a.once && !(await locate(tabId, ref, 'activate', true)).toggle
        } else void inFrame(tabId, fid, pageMutRead, 'click', true).catch(() => undefined)
      }
      if (!mouse || retry) {
        // If the Dool2 window is occluded or the screen is off, Chrome drops mouse input (it accepts the keyboard, measured).
        // Even when another button covers it and this was called with force, a mouse click would press the covering button, so click the element directly.
        // Give focus and press with Enter or Space. It is a real click made by the browser, so it looks the same to the site
        const act = await locate(tabId, ref, 'activate', true)
        await inFrame(tabId, fid, pageHitArm, ref).catch(() => false)
        if (!act.focused) {
          // For elements that cannot be pressed by keyboard (a div that cannot take focus), click inside the page as a last resort
          via = 'script'
          delivered = Boolean(await inFrame(tabId, fid, pageClick, ref).catch(() => false))
        } else {
          via = 'key'
          await pressKey(tabId, act.toggle ? 'Space' : 'Enter')
          await settle(tabId, before, quick)
          const hit = await inFrame(tabId, fid, pageHitRead, false).catch(() => noHit)
          delivered = hit.hit || !hit.armed || (await openedSince(tabId, t0))
          // Occluded windows sometimes do not take keys either (measured): click inside the page only if it did not reach that element
          if (!delivered && !act.toggle) {
            via = 'script'
            delivered = Boolean(await inFrame(tabId, fid, pageClick, ref).catch(() => false))
          }
        }
        await settle(tabId, before, quick)
      }
      // The window closed itself after the click (the last PIN digit in a payment window: when payment ends the payment company window closes).
      // It was clicked, so do not return it as an error ('The tab was closed') - it used to report "could not click" after the payment went through
      const closed = {
        tabId,
        url: before ?? '',
        title: '',
        closed: true,
        via,
        delivered: true,
        point: { x: Math.round(at.x), y: Math.round(at.y) },
      }
      if (!(await chrome.tabs.get(tabId).catch(() => undefined))) return closed
      if (tall || keptTall.has(tabId)) {
        if (keepTall) keepTallFor(tabId)
        else await restoreHeight(tabId)
      }
      const blocked = await blockedPopups(tabId).catch(() => [])
      const now = await pageState(tabId).catch(() => undefined)
      if (!now) return closed
      return {
        ...now,
        via,
        delivered,
        // Where it was clicked (page viewport based; inside a frame, the sum of all nested frame boxes)
        point: { x: Math.round(at.x), y: Math.round(at.y) },
        ...(await takePopup(tabId, t0)),
        ...(at.coveredBy && !at.hidden ? { coveredBy: at.coveredBy } : {}),
        ...(hitOther ? { hitOther } : {}),
        ...(at.ctxChanged ? { ctxChanged: at.ctxChanged } : {}),
        ...(blocked.length ? { blockedPopups: blocked } : {}),
      }
    }
    case 'type': {
      const tabId = await ownedTab(a)
      if (typeof a.text !== 'string') throw new Error('No text to enter')
      const ref = String(a.ref ?? '')
      let at = await locate(tabId, ref, 'type')
      if (at.isPassword) throw new Error('Password fields are filled only from the Dool2 vault')
      if (at.drawn) return typeDrawn(tabId, ref, at, a.text, Boolean(a.submit))
      // Frames at another address sometimes block script focus: if focus did not go in, click the field once to give real focus,
      // then select again (select all the original text) and type. Typing without focus sent text to the outer page or lost it (same reason as fill)
      if (at.frame && !at.hidden && !at.focused) {
        await clickAt(tabId, at.x, at.y, txt.cursorTyping)
        at = await locate(tabId, ref, 'type')
      } else if (!at.hidden) await showCursor(tabId, at.x, at.y, txt.cursorTyping)
      await cdp(tabId, 'Input.insertText', { text: a.text })
      // Fields that do not accept inserting all at once: if nothing went in, look again after a moment, and only if still empty select again and type key by key
      // (pressing keys right away in a field that reflects text late puts it in twice)
      if (a.text && /^[\x20-\x7e]+$/.test(a.text)) {
        const fid = frameOf(tabId, ref).frameId
        const len = () => inFrame(tabId, fid, pageValueLength, ref, false).catch(() => -1) as Promise<number>
        let n = await len()
        if (n === 0) {
          await sleep(150)
          n = await len()
        }
        if (n === 0) {
          await locate(tabId, ref, 'type')
          await typeKeys(tabId, a.text)
        }
      }
      if (a.submit) {
        const before = (await chrome.tabs.get(tabId)).url
        // Some fields reflect input into state a little late: wait a moment, then Enter (pressKey also paints one frame)
        await sleep(300)
        await pressKey(tabId, 'Enter')
        await settle(tabId, before)
      }
      return pageState(tabId)
    }
    case 'fill': {
      // Dool2 vault (ADR 0011): the daemon gives the value. Enter it only if the address matches, and never return the value anywhere
      const tabId = await ownedTab(a)
      if (typeof a.value !== 'string' || typeof a.origin !== 'string') throw new Error('No value to fill')
      const at = await locate(tabId, a.ref, 'type')
      // A field inside a frame only if it is a frame of the same site (places that show the login window as a subdomain frame)
      const inFrameRef = Boolean(at.frame)
      // Personal info (name, phone, birth date) is also entered into official authentication window frames (the financial certificate window is a frame at a Korea Financial Telecommunications and Clearings Institute address).
      // A password (vault) gets no a.trust, so as now it goes only to that site
      // Frames with an empty address (about:blank, srcdoc) were drawn by that page itself, so treat them as the outer page address
      // (measured 11-21 Shinhan Card ID search: the phone authentication field was an about:blank frame, so it was not filled for "different address")
      const opaque = !at.origin || at.origin === 'null' || /^about:|^data:/.test(at.origin)
      const frameOrigin =
        inFrameRef && opaque
          ? await chrome.tabs
              .get(tabId)
              .then((t) => new URL(t.url ?? '').origin)
              .catch(() => at.origin)
          : at.origin
      const trusted =
        inFrameRef && Array.isArray(a.trust) && (a.trust as string[]).includes(siteOf(frameOrigin))
      const ok =
        frameOrigin === a.origin || (inFrameRef && siteOf(frameOrigin) === siteOf(a.origin)) || trusted
      if (!ok) throw new Error('The current page address differs from the saved site, so nothing was filled')
      if (a.password && !at.isPassword) throw new Error('It is not a password field, so nothing was filled')
      // Frames at another address sometimes block script focus, so click the field once to give focus
      // If script focus already went in, do not click: if frame coordinates are off and the click lands outside the field, focus is lost
      // and the site showed "Enter the number correctly" (measured: financial certificate window)
      if (inFrameRef && !at.hidden && !at.focused) await clickAt(tabId, at.x, at.y, txt.cursorFillingVault)
      else if (!at.hidden) await showCursor(tabId, at.x, at.y, txt.cursorFillingVault)
      await cdp(tabId, 'Input.insertText', { text: a.value })
      const frameId = frameOf(tabId, String(a.ref)).frameId
      // If the field limits characters (maxlength) the text is cut: report only the length that went in (the value is not returned)
      let length = (await inFrame(tabId, frameId, pageValueLength, String(a.ref), !a.password).catch(
        () => -1,
      )) as number
      // Some fields reflect text late: if 0, look again after a moment (pressing keys right away puts it in twice)
      if (length === 0 && a.value && !a.password) {
        await sleep(150)
        length = (await inFrame(tabId, frameId, pageValueLength, String(a.ref), true).catch(
          () => -1,
        )) as number
      }
      // If still nothing went in, select again (select all) and type key by key (not done for passwords, so the vault value does not stay in key records)
      if (length === 0 && a.value && !a.password) {
        await locate(tabId, a.ref, 'type')
        await typeKeys(tabId, a.value)
        length = (await inFrame(tabId, frameId, pageValueLength, String(a.ref), !a.password).catch(
          () => -1,
        )) as number
      }
      // If a password inserted at once was cut or dropped (secure input fields that take only key input), select again and type key by key once more
      // (measured 11-21 Shinhan Card signup: the created password kept being rejected as "characters missing"). The value goes only as key events and is kept nowhere
      if (a.password && a.value && length >= 0 && length !== a.value.length) {
        await locate(tabId, a.ref, 'type')
        await typeKeys(tabId, a.value)
        length = (await inFrame(tabId, frameId, pageValueLength, String(a.ref), false).catch(
          () => -1,
        )) as number
      }
      await inFrame(tabId, frameId, pageMarkFilled, String(a.ref))
      return { tabId, filled: true, ...(length >= 0 ? { length } : {}) }
    }
    case 'press': {
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      const before = (await chrome.tabs.get(tabId)).url
      await pressKey(tabId, String(a.key ?? ''))
      await settle(tabId, before)
      return pageState(tabId)
    }
    case 'scroll': {
      // With ref, scroll that element (or the scrolling box containing it: list window, modal, inside a frame). Without it, the page.
      // Return how far it scrolled and whether it reached the end (the AI decides whether to scroll more)
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      const v = await inPage(tabId, pageViewport)
      const dir = a.direction === 'up' ? -1 : 1
      const ref = typeof a.ref === 'string' && /^e\d+$/.test(a.ref) ? a.ref : null
      const fid = ref ? frameOf(tabId, ref).frameId : 0
      const info0 = await inFrame(tabId, fid, pageScrollInfo, ref, 0)
      if (!info0.ok) throw new Error(info0.error ?? 'Could not find a place to scroll')
      if (v.hidden) {
        // Occluded windows do not take the mouse wheel. Scrolling is not input that matters to sites, so move it inside the page
        if (ref) await inFrame(tabId, fid, pageScrollInfo, ref, dir)
        else await inPage(tabId, pageScroll, dir)
      } else {
        const p = ref ? await framePoint(tabId, fid, info0.x, info0.y) : { x: v.width / 2, y: v.height / 2 }
        const wheel = cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: p.x,
          y: p.y,
          deltaX: 0,
          deltaY: dir * Math.round((ref ? info0.h : v.height) * 0.8),
        })
        await Promise.race([wheel, sleep(1000)])
      }
      await sleep(300)
      let info1 = await inFrame(tabId, fid, pageScrollInfo, ref, 0)
      // If the wheel scrolled a different box in the middle and the spot stayed the same, scroll that spot inside the page (the scrolled spot is reported in the result as is)
      const room = dir > 0 ? info0.top < info0.max - 1 : info0.top > 0
      if (!v.hidden && info1.ok && info1.top === info0.top && room) {
        await inFrame(tabId, fid, pageScrollInfo, ref, dir)
        await sleep(150)
        info1 = await inFrame(tabId, fid, pageScrollInfo, ref, 0)
      }
      return {
        ...(await pageState(tabId)),
        scroll: {
          target: info0.box ? 'box' : 'page',
          before: info0.top,
          after: info1.top,
          max: info1.max,
          atEnd: dir > 0 ? info1.top >= info1.max - 1 : info1.top <= 0,
        },
      }
    }
    case 'allow-popups': {
      // A payment window opens as a new window after a round trip to the server, not at the moment of the button press: Chrome blocked it as a popup and the screen stayed white
      // (measured 11-20 Gmarket card payment). Popups are allowed only for the site Dool2 pays on (a person used to press "Allow popups" in the address bar).
      // The site range equals the same-site judgment (siteOf): three labels for shop.co.kr and shop.com.au, only that address for IPs and localhost
      const tabId = await ownedTab(a)
      const u = new URL((await chrome.tabs.get(tabId)).url ?? '')
      const base = siteOf(u.origin)
      const single = base === u.hostname && !u.hostname.includes('.')
      const ip = /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':') || single
      const pattern = ip ? `${u.protocol}//${u.host}/*` : `${u.protocol}//*.${base}/*`
      await chrome.contentSettings.popups.set({ primaryPattern: pattern, setting: 'allow' })
      return { ok: true, pattern }
    }
    case 'popup': {
      // A new window that opened late after the click (payment window, etc.): the newest not-yet-reported window opened by that tab. Blocked new windows are reported too
      const tabId = await ownedTab(a)
      const blocked = await blockedPopups(tabId).catch(() => [])
      return { ...(await takePopup(tabId)), ...(blocked.length ? { blockedPopups: blocked } : {}) }
    }
    case 'tabs': {
      // Dool2 tab list: who opened it, when, address, title, window type, whether it is the front tab, recently closed new windows, tabs closed by tidying, blocked new windows.
      // So the AI can see for itself where a late payment window or login window is
      const s = await load()
      const now = Date.now()
      const tabs: Record<string, unknown>[] = []
      for (const id of s.owned) {
        const t = await chrome.tabs.get(id).catch(() => undefined)
        if (!t) continue
        const w = await chrome.windows.get(t.windowId).catch(() => undefined)
        const rec = s.recs?.find((r) => r.tabId === id)
        tabs.push({
          tabId: id,
          url: t.url ?? '',
          title: t.title ?? '',
          ...(rec?.opener !== undefined ? { opener: rec.opener } : {}),
          ...(rec ? { createdAt: rec.at } : {}),
          windowType: w?.type ?? 'normal',
          active: Boolean(t.active),
          loading: t.status === 'loading',
          ...((s.held?.[id] ?? 0) > now ? { held: true } : {}),
          ...(t.discarded ? { sleeping: true } : {}),
        })
      }
      const closed = (s.recs ?? [])
        .filter((r) => r.closedAt && now - r.closedAt < 30 * 60_000)
        .map((r) => ({
          tabId: r.tabId,
          ...(r.opener !== undefined ? { opener: r.opener } : {}),
          url: r.url ?? '',
          title: r.title ?? '',
          createdAt: r.at,
          closedAt: r.closedAt,
        }))
      const want = a.tabId !== undefined && Number.isInteger(Number(a.tabId)) ? [Number(a.tabId)] : s.owned
      const blocked: { tabId: number; url: string; at: number }[] = []
      for (const id of want.filter((x) => s.owned.includes(x)))
        for (const b of await blockedPopups(id, false).catch(() => [])) blocked.push({ tabId: id, ...b })
      return { tabs, closed, tidied: (s.tidied ?? []).slice(-10), blockedPopups: blocked }
    }
    case 'wait': {
      // Wait: wait until the page changes (or for ms) and return what changed.
      // Changes: document text and elements (main page and frames), frame navigation, address change, new tabs, site alerts and confirm dialogs. The AI judges whether it worked
      const tabId = await ownedTab(a)
      const ms = Math.min(Math.max(Number(a.ms) || 3_000, 100), 10_000)
      const untilChange = a.until !== 'time'
      const t0 = Date.now()
      const before = (await chrome.tabs.get(tabId)).url ?? ''
      const notesBefore = dialogNotes.get(tabId)?.length ?? 0
      const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? []
      // Documents to watch: the main page + the frames read last (at most 8)
      const known = new Set([...(frameMaps.get(tabId)?.values() ?? [])].map((f) => f.frameId))
      const watchIds = [0, ...frames.filter((f) => known.has(f.frameId)).map((f) => f.frameId)].slice(0, 9)
      const armed: number[] = []
      if (!dialogs.has(tabId))
        await Promise.all(
          watchIds.map(async (fid) => {
            if (await inFrame(tabId, fid, pageMutArm, 'wait').catch(() => false)) armed.push(fid)
          }),
        )
      const label = (fid: number) => (fid ? `f${frameIndexes.get(tabId)?.get(fid) ?? '?'}` : 'main')
      let changed = false
      for (let i = 0; Date.now() - t0 < ms; i++) {
        await sleep(200)
        if (i % 4 === 3 && attached.has(tabId)) await paint(tabId)
        const t = await chrome.tabs.get(tabId).catch(() => undefined)
        if (!t) break
        const nav = (navLog.get(tabId) ?? []).some((n) => n.at >= t0)
        const quick =
          dialogs.has(tabId) ||
          (dialogNotes.get(tabId)?.length ?? 0) > notesBefore ||
          t.url !== before ||
          nav ||
          (await openedSince(tabId, t0))
        let dom = false
        if (!quick && i % 2 === 1 && !dialogs.has(tabId))
          for (const fid of armed) {
            const m = await inFrame(tabId, fid, pageMutRead, 'wait', false).catch(() => ({ n: 0 }))
            if (m.n > 0) {
              dom = true
              break
            }
          }
        if (quick || dom) {
          changed = true
          if (untilChange) {
            // If it started changing, wait a bit longer for it to finish painting (if it is a navigation, until it ends)
            await settle(tabId, before)
            break
          }
        }
      }
      const dom: { frame: string; added: number; removed: number; attrs: number; text?: string }[] = []
      if (!dialogs.has(tabId))
        for (const fid of armed) {
          const m = await inFrame(tabId, fid, pageMutRead, 'wait', true).catch(() => undefined)
          if (m && m.n > 0)
            dom.push({
              frame: label(fid),
              added: m.added,
              removed: m.removed,
              attrs: m.attrs,
              ...(m.text ? { text: m.text } : {}),
            })
        }
      const navs = (navLog.get(tabId) ?? [])
        .filter((n) => n.at >= t0 && (n.kind === 'commit' || n.kind === 'error'))
        .map((n) => ({
          frame: label(n.frameId),
          url: n.url.slice(0, 200),
          ...(n.kind === 'error' ? { error: true } : {}),
        }))
      const s = await load()
      const newTabs = (s.recs ?? [])
        .filter((r) => r.opener === tabId && r.at >= t0)
        .map((r) => ({ tabId: r.tabId, ...(r.closedAt ? { closed: true } : {}) }))
      const blocked = await blockedPopups(tabId).catch(() => [])
      const state = await pageState(tabId)
      const what = [
        ...(state.url !== before ? [`address changed: ${state.url.slice(0, 120)}`] : []),
        ...navs
          .filter((n) => n.frame !== 'main')
          .map((n) => `frame ${n.frame} navigated: ${n.url.slice(0, 100)}`),
        ...dom.map(
          (d) =>
            `${d.frame} text/elements changed (added ${d.added}, removed ${d.removed}, attributes ${d.attrs})${d.text ? `: ${d.text}` : ''}`,
        ),
        ...newTabs.map((n) => `new tab ${n.tabId}${n.closed ? ' (already closed)' : ''}`),
        ...blocked.map((b) => `blocked new window: ${b.url || '(no address)'}`),
        ...(state.dialog ? [`site confirm dialog: "${state.dialog.message.slice(0, 120)}"`] : []),
        ...((dialogNotes.get(tabId)?.length ?? 0) > notesBefore
          ? ['a site alert appeared and was closed']
          : []),
      ]
      return {
        ...state,
        waitedMs: Date.now() - t0,
        changed: changed || what.length > 0,
        what,
        details: {
          dom,
          navigations: navs,
          newTabs,
          ...(blocked.length ? { blockedPopups: blocked } : {}),
        },
        ...(dialogNotes.get(tabId)?.length ? takeDialogs(tabId) : {}),
      }
    }
    case 'element-shots': {
      // Capture only that spot for each mark (picture digit keypads: each button shown separately so the AI reads the digit).
      // Scroll each into view, capture, and report the status of each. Only when still off-screen after scrolling (a keypad fixed at the bottom)
      // stretch the viewport height briefly (measured 11-20 Coupang keypad was cut off below the window and only gray images were captured)
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      const refs = (Array.isArray(a.refs) ? a.refs : []).map(String).slice(0, 16)
      const shots: { ref: string; data: string; rect: { x: number; y: number; w: number; h: number } }[] = []
      const status: { ref: string; status: 'ok' | 'missing' | 'zeroSize' | 'offscreen' | 'frame' }[] = []
      let v = await inPage(tabId, pageViewport)
      let tall = false
      type Shot = { status: (typeof status)[number]['status']; x: number; y: number; w: number; h: number }
      const measure = async (ref: string, fid: number): Promise<Shot> => {
        const none = { x: 0, y: 0, w: 0, h: 0 }
        const r = await inFrame(tabId, fid, pageShotRect, ref).catch(() => undefined)
        if (!r || r.status === 'missing' || r.status === 'zeroSize')
          return { status: r?.status ?? 'missing', ...none }
        const p = fid ? await framePoint(tabId, fid, r.x, r.y).catch(() => undefined) : { x: r.x, y: r.y }
        if (!p) return { status: 'frame', ...none }
        const off = p.y < 0 || p.x < 0 || p.y + r.h > v.height + 1 || p.x + r.w > v.width + 1
        return { status: off ? 'offscreen' : 'ok', x: p.x, y: p.y, w: r.w, h: r.h }
      }
      // Measure everything first. If something is cut off below the screen, stretch once so the lowest one is visible and measure again
      // (it used to stretch only to the height of the first cut button, so keypad buttons on the lower row were still off-screen and could not be captured - measured payment window keypad)
      const fids = new Map<string, number>()
      const plan = new Map<string, Shot>()
      for (const ref of refs) {
        try {
          fids.set(ref, frameOf(tabId, ref).frameId)
        } catch {
          continue
        }
        plan.set(ref, await measure(ref, fids.get(ref) ?? 0))
      }
      const below = [...plan.values()].filter((m) => m.status === 'offscreen' && m.y + m.h > v.height)
      if (below.length) {
        tall = await tallerIfBelow(tabId, Math.max(...below.map((m) => m.y + m.h))).catch(() => false)
        if (tall) {
          v = await inPage(tabId, pageViewport)
          for (const ref of plan.keys()) plan.set(ref, await measure(ref, fids.get(ref) ?? 0))
        }
      }
      for (const ref of refs) {
        const m = plan.get(ref)
        if (!m) {
          status.push({ ref, status: 'missing' })
          continue
        }
        if (m.status !== 'ok') {
          status.push({ ref, status: m.status })
          continue
        }
        // clip is document-based: add the scroll amount (scrollOffset)
        const o = await scrollOffset(tabId, 'layout')
        const shot = await cdp<{ data: string }>(tabId, 'Page.captureScreenshot', {
          format: 'jpeg',
          quality: 85,
          clip: { x: Math.max(0, m.x) + o.x, y: Math.max(0, m.y) + o.y, width: m.w, height: m.h, scale: 2 },
        }).catch(() => undefined)
        status.push({ ref, status: shot ? 'ok' : 'offscreen' })
        // rect: position relative to the visible viewport (to convert where the phone tapped to screen coordinates when solving a picture by tapping)
        if (shot) shots.push({ ref, data: shot.data, rect: { x: m.x, y: m.y, w: m.w, h: m.h } })
      }
      // Pictures without a mark (robot-check pictures, canvases): a box the AI pointed at in a screenshot (0-1000 of the visible viewport)
      const boxes = (Array.isArray(a.boxes) ? a.boxes : []).slice(0, 4) as Record<string, unknown>[]
      if (boxes.length) {
        const v = await inPage(tabId, pageViewport)
        const o = await scrollOffset(tabId, 'layout')
        for (const [i, b] of boxes.entries()) {
          const x = Math.max(0, Math.min(1000, Number(b.x) || 0))
          const y = Math.max(0, Math.min(1000, Number(b.y) || 0))
          const w = Math.max(1, Math.min(1000 - x, Number(b.w) || 0))
          const h = Math.max(1, Math.min(1000 - y, Number(b.h) || 0))
          const r = {
            x: (x / 1000) * v.width,
            y: (y / 1000) * v.height,
            w: (w / 1000) * v.width,
            h: (h / 1000) * v.height,
          }
          const shot = await cdp<{ data: string }>(tabId, 'Page.captureScreenshot', {
            format: 'jpeg',
            quality: 85,
            clip: { x: r.x + o.x, y: r.y + o.y, width: r.w, height: r.h, scale: 2 },
          }).catch(() => undefined)
          if (shot) shots.push({ ref: `box${i + 1}`, data: shot.data, rect: r })
        }
      }
      if (tall) await restoreHeight(tabId)
      // taller: it was cut off below the screen, so the viewport height was stretched briefly to capture (tells that positions are back to normal when read again)
      return { shots, status, ...(tall ? { taller: true } : {}) }
    }
    case 'captcha-candidates': {
      // Return several crops around the captcha field. The AI looks and chooses which picture is the captcha
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      if (typeof a.ref !== 'string') throw new Error('A field mark (ref) is required')
      const f = frameOf(tabId, a.ref)
      const rects = ((await inFrame(tabId, f.frameId, pageCaptchaRects, a.ref).catch(() => [])) ?? []) as {
        x: number
        y: number
        w: number
        h: number
        what: string
      }[]
      const off = await framePoint(tabId, f.frameId, 0, 0, false)
      await sleep(250)
      // clip is document-based: add the scroll amount
      const o = await scrollOffset(tabId, 'layout')
      off.x += o.x
      off.y += o.y
      const shots: { what: string; data: string }[] = []
      for (const r of rects) {
        const shot = await cdp<{ data: string }>(tabId, 'Page.captureScreenshot', {
          format: 'jpeg',
          quality: 85,
          clip: {
            x: Math.max(0, r.x + off.x),
            y: Math.max(0, r.y + off.y),
            width: r.w,
            height: r.h,
            scale: 2,
          },
        }).catch(() => undefined)
        if (shot) shots.push({ what: r.what, data: shot.data })
      }
      return { shots }
    }
    case 'pdf': {
      // The page as a PDF, the way Chrome prints it (certificates and statements open in a viewer page): Dool2 keeps
      // it as a file. Only a tab Dool2 opened
      const tabId = await ownedTab(a)
      // Only the document the viewer shows (its page canvases or images, or the element ref names), one per A4 sheet;
      // the whole tab only when nothing looks like a document or the caller asks for it (only: 'page')
      const prepared =
        a.only === 'page'
          ? { count: 0, what: '' }
          : await inPage(tabId, pagePrintPrepare, typeof a.ref === 'string' ? a.ref : null).catch(() => ({
              count: 0,
              what: '',
            }))
      try {
        const r = await cdp<{ data: string }>(tabId, 'Page.printToPDF', {
          printBackground: true,
          preferCSSPageSize: true,
        })
        return {
          data: r.data,
          part: prepared.count ? 'document' : 'page',
          pages: prepared.count,
          what: prepared.what,
        }
      } finally {
        if (prepared.count) await inPage(tabId, pagePrintCleanup).catch(() => undefined)
      }
    }
    case 'printhook': {
      // Before pressing the site's own print button: catch the print it asks for (pagePrintHook), every frame
      const tabId = await ownedTab(a)
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: pagePrintHook,
      })
      return { ok: true }
    }
    case 'printtake': {
      // After pressing it: wait for the print the site asked for, and bring back what it would print
      const tabId = await ownedTab(a)
      const until = Date.now() + Math.min(Math.max(Number(a.waitMs) || 30_000, 1_000), 60_000)
      for (;;) {
        const runs = await chrome.scripting
          .executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: pagePrintTake })
          .catch(() => [])
        const hit = runs.find((r) => r.result && r.result.calls > 0)
        const got = hit ? { ...hit.result, frameId: hit.frameId } : undefined
        if (got) {
          await chrome.scripting
            .executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: pagePrintUnhook })
            .catch(() => undefined)
          if (got.via === 'page' && !got.frameId) {
            // The site printed its page itself: the same print Chrome's "Save as PDF" makes, with the site's print styles
            const r = await cdp<{ data: string }>(tabId, 'Page.printToPDF', {
              printBackground: true,
              preferCSSPageSize: true,
            })
            return { via: 'page', data: r.data, calls: got.calls }
          }
          // A frame printed itself: print its document, copied with its own styles into the page (Chrome prints only
          // the top page)
          if (got.via === 'page') {
            const href = await chrome.scripting
              .executeScript({ target: { tabId, frameIds: [got.frameId] }, func: () => location.href })
              .then((r) => String(r[0]?.result ?? ''))
              .catch(() => '')
            const copied = href ? await inPage(tabId, pagePrintFrameCopy, href).catch(() => false) : false
            if (!copied) return { ...got, via: 'frame-page' }
            try {
              const r = await cdp<{ data: string }>(tabId, 'Page.printToPDF', {
                printBackground: true,
                preferCSSPageSize: true,
              })
              return { via: 'frame', data: r.data, type: 'application/pdf', calls: got.calls }
            } finally {
              await inPage(tabId, pagePrintCleanup).catch(() => undefined)
            }
          }
          return got
        }
        if (Date.now() > until) {
          await chrome.scripting
            .executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: pagePrintUnhook })
            .catch(() => undefined)
          return { calls: 0 }
        }
        await sleep(800)
      }
    }
    case 'eval': {
      // A script on a page Dool2 opened, evaluated side-effect free by V8 (ADR 0045, T31): it can read and compute,
      // and throws if it would click, type, change the page, store anything or call the network
      const tabId = await ownedTab(a)
      const expression = String(a.expression ?? '')
      if (!expression.trim() || expression.length > 20_000)
        throw new Error('Give a script of up to 20,000 characters')
      // Never hand a password field's value to the AI (T15): only while none holds one
      const pw = await cdp<{ result: { value?: unknown } }>(tabId, 'Runtime.evaluate', {
        expression: `[...document.querySelectorAll('input[type=password]')].some((i) => i.value !== '')`,
        returnByValue: true,
        throwOnSideEffect: true,
      }).catch(() => ({ result: { value: true } }))
      if (pw.result.value !== false)
        throw new Error('A password field on this page holds a value, so scripts do not run here')
      const r = await cdp<{
        result: { type: string; value?: unknown; description?: string }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }>(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        throwOnSideEffect: true,
        awaitPromise: false,
        userGesture: false,
        includeCommandLineAPI: false,
        timeout: 5_000,
      })
      if (r.exceptionDetails)
        return {
          error: (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'Error').slice(
            0,
            1_000,
          ),
        }
      return {
        type: r.result.type,
        value: r.result.value,
        ...(r.result.description ? { description: r.result.description } : {}),
      }
    }
    case 'cdp': {
      // A DevTools method from the read-only list (ADR 0045, T31), on a page Dool2 opened
      const tabId = await ownedTab(a)
      const method = String(a.method ?? '')
      if (!(READ_CDP_METHODS as readonly string[]).includes(method))
        throw new Error(`${method} is not on the list of DevTools methods that only read or produce`)
      const params =
        a.params && typeof a.params === 'object' ? { ...(a.params as Record<string, unknown>) } : {}
      // Always return the data, never a stream handle (IO.* is not on the list)
      delete params.transferMode
      return await cdp(tabId, method, params)
    }
    case 'screenshot': {
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      // Remote screen: draw at the phone's screen size (redrawn as a mobile page that fills the phone, and tap positions match).
      // When the phone stops asking for the screen, the debugger detaches and the original size comes back
      const fit = a.fit as { width?: unknown; height?: unknown } | undefined
      if (fit) {
        const width = Math.round(Math.min(Math.max(Number(fit.width) || 0, 320), 1024))
        const height = Math.round(Math.min(Math.max(Number(fit.height) || 0, 400), 2000))
        const key = `${width}x${height}`
        if (emulated.get(tabId) !== key) {
          await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: 2,
            mobile: true,
          })
          emulated.set(tabId, key)
          await sleep(350)
        }
      } else if (emulated.has(tabId)) {
        await cdp(tabId, 'Emulation.clearDeviceMetricsOverride', {})
        emulated.delete(tabId)
      }
      // A Retina screen captures at 2x, too big for the AI to read. Only the visible area, shrunk to at most 1280px wide (smaller for the remote screen)
      const v = await inPage(tabId, pageViewport)
      const maxWidth = Math.min(Math.max(Number(a.maxWidth) || 1280, 320), 1280)
      const quality = Math.min(Math.max(Number(a.quality) || 60, 30), 80)
      // The remote screen captures up to 2x so it is sharp on the phone
      const scale =
        (fit ? Math.min(v.dpr, maxWidth / v.width) : Math.min(a.remote ? 2 : 1, maxWidth / v.width)) / v.dpr
      // When drawing at phone size (view, fit), capture exactly what is visible (wide pages look shrunk like on a phone).
      // The click positions are viewport based then, so report the viewport at that size too
      const phone = Boolean(a.remote) && (phoneView.has(tabId) || emulated.has(tabId))
      // clip is document-based: to capture what is visible now, add the scroll amount (it used to be 0,0 so the top of a scrolled page was captured)
      const o = phone ? { x: 0, y: 0 } : await scrollOffset(tabId, 'layout')
      const shot = phone
        ? await cdp<{ data: string }>(tabId, 'Page.captureScreenshot', {
            format: 'jpeg',
            quality,
            optimizeForSpeed: true,
          })
        : await cdp<{ data: string }>(tabId, 'Page.captureScreenshot', {
            format: 'jpeg',
            quality,
            optimizeForSpeed: true,
            clip: { x: o.x, y: o.y, width: v.width, height: v.height, scale },
          })
      const shown = phone
        ? { width: Math.round(v.vv.w * v.vv.scale), height: Math.round(v.vv.h * v.vv.scale) }
        : { width: v.width, height: v.height }
      return {
        ...(await pageState(tabId)),
        mime: 'image/jpeg',
        data: shot.data,
        viewport: shown,
        ...(a.remote ? await inPage(tabId, pageRemoteInfo).catch(() => ({})) : {}),
      }
    }
    case 'input': {
      // Input a person makes on the remote screen (phone). Coordinates are CSS pixels (the daemon rescales the image ratio)
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      const before = (await chrome.tabs.get(tabId)).url
      const v = await inPage(tabId, pageViewport)
      if (a.action === 'tap') {
        const x = Math.round(Number(a.x))
        const y = Math.round(Number(a.y))
        if (
          !(
            x >= 0 &&
            y >= 0 &&
            x <= Math.max(v.width, v.vv.w * v.vv.scale) &&
            y <= Math.max(v.height, v.vv.h * v.vv.scale)
          )
        )
          throw new Error('Clicked outside the screen')
        // If the window is visible, use the real mouse (visible viewport position); if occluded, click the element at that spot (occluded windows drop mouse input)
        if (!v.hidden) await clickAt(tabId, x, y)
        else if (phoneView.has(tabId))
          await inPage(tabId, pageTapAt, v.vv.x + x / v.vv.scale, v.vv.y + y / v.vv.scale)
        else await inPage(tabId, pageTapAt, x, y)
        // If an input field was clicked, put the caret at the end (easy to continue writing and erasing from the phone)
        await inPage(tabId, pageCaretEnd).catch(() => {})
      } else if (a.action === 'view') {
        // Draw at phone width: the site shows its phone layout so text is at its proper size
        const width = Math.round(Math.min(Math.max(Number(a.w) || 390, 320), 520))
        const height = Math.round(Math.min(Math.max(Number(a.h) || 700, 360), 1100))
        await phoneWidth(tabId, width, height)
        await widenIfCut(tabId)
        return pageState(tabId)
      } else if (a.action === 'leave') {
        await leavePhoneView(tabId)
        return pageState(tabId)
      } else if (a.action === 'text') {
        if (typeof a.text !== 'string' || !a.text) throw new Error('No text to enter')
        await cdp(tabId, 'Input.insertText', { text: a.text.slice(0, 500) })
      } else if (a.action === 'key') {
        const key = String(a.key ?? '')
        if (!['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp'].includes(key))
          throw new Error(`This key cannot be pressed remotely: ${key}`)
        await pressKey(tabId, key)
      } else if (a.action === 'scroll') {
        const dy = Number(a.dy) || 0
        if (Math.abs(dy) <= 1) await inPage(tabId, pageScroll, dy < 0 ? -1 : 1)
        else {
          // As far as the finger dragged: scroll the wheel at that spot so inner boxes go down together
          const x = Math.max(Math.round(Number(a.x) || v.width / 2), 0)
          const y = Math.max(Math.round(Number(a.y) || v.height / 2), 0)
          const d = Math.max(-3000, Math.min(3000, Math.round(dy)))
          if (v.hidden)
            await inPage(
              tabId,
              pageScrollBy,
              phoneView.has(tabId) ? v.vv.x + x / v.vv.scale : x,
              phoneView.has(tabId) ? v.vv.y + y / v.vv.scale : y,
              d,
            )
          else
            await Promise.race([
              cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: d }),
              sleep(600),
            ])
          return pageState(tabId)
        }
      } else throw new Error('Unknown remote input')
      await settle(tabId, before)
      // If a PC-style window (simple authentication, etc.) appeared after the click or it moved to another screen, measure again whether the phone width fits
      if (a.action === 'tap') await refitAfterTap(tabId, before)
      return pageState(tabId)
    }
    case 'form': {
      // Remote screen "only the needed fields": pull fields, choices and buttons, and attach cropped captcha images
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      let form: Awaited<ReturnType<typeof pageForm>> & { frame?: string } = await inPage(
        tabId,
        pageForm,
        false,
      )
      formFrames.delete(tabId)
      // If the window covering the center is a frame (Gov24 simple authentication), pull the fields inside that frame. Add the frame number to marks so fills go to that frame
      if (form.frame) {
        const want = form.frame
        const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? []
        const fr =
          frames.find((x) => x.frameId !== 0 && x.url === want) ??
          frames.find((x) => x.frameId !== 0 && want.startsWith(x.url))
        if (fr) {
          const inner = await inFrame(tabId, fr.frameId, pageForm, true).catch(() => undefined)
          if (inner && (inner.fields.length || inner.buttons.length)) {
            const tag = (id: string) => `${FORM_FRAME}${fr.frameId}~${id}`
            for (const f of inner.fields as { id: string; options?: { id: string }[] }[]) {
              f.id = tag(f.id)
              for (const o of f.options ?? []) o.id = tag(o.id)
            }
            for (const b of inner.buttons) b.id = tag(b.id)
            formFrames.set(tabId, { frameId: fr.frameId, url: fr.url })
            form = { ...inner, url: form.url }
          }
        }
      }
      for (const f of form.fields as {
        captchaRect?: { x: number; y: number; w: number; h: number }
        captcha?: string
      }[]) {
        const r = f.captchaRect
        delete f.captchaRect
        if (!r) continue
        const shot = await cdp<{ data: string }>(tabId, 'Page.captureScreenshot', {
          format: 'jpeg',
          quality: 80,
          captureBeyondViewport: true,
          clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 2 },
        }).catch(() => undefined)
        if (shot) f.captcha = shot.data
      }
      return form
    }
    case 'form-fill': {
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      const before = (await chrome.tabs.get(tabId)).url
      const v = await inPage(tabId, pageViewport)
      // If it is a field in a frame (frame number before the mark), look in that frame and shift the position by the frame box
      const fr = formFrames.get(tabId)
      // If the position cannot be measured, click that spot inside the frame (so the real mouse does not click somewhere wrong)
      const off = fr
        ? await framePoint(tabId, fr.frameId, 0, 0, false).catch(() => undefined)
        : { x: 0, y: 0 }
      const where = (id: string) => {
        const m = id.match(FORM_FRAME_ID)
        return m ? { frameId: Number(m[1]), id: m[2] as string } : { frameId: 0, id }
      }
      const target = async (raw: string) => {
        const w = where(raw)
        const t = await inFrame(tabId, w.frameId, pageFormTarget, w.id)
        if (!w.frameId || !t.ok || t.done) return t
        // For an occluded window, click that spot inside the frame (lx and ly stay relative to the frame)
        if (!off) return { ...t, x: undefined, y: undefined, frameId: w.frameId }
        return { ...t, x: (t.x ?? 0) + off.x, y: (t.y ?? 0) + off.y, frameId: w.frameId }
      }
      const tapIn = async (t: { x?: number; y?: number; lx?: number; ly?: number; frameId?: number }) => {
        if (!v.hidden && t.x !== undefined && t.y !== undefined)
          await clickAt(tabId, Math.round(t.x), Math.round(t.y))
        else if (t.lx !== undefined && t.ly !== undefined)
          await inFrame(tabId, t.frameId ?? 0, pageTapAt, t.lx, t.ly)
      }
      const values = Array.isArray(a.values) ? (a.values as Record<string, unknown>[]).slice(0, 30) : []
      for (const it of values) {
        const id = String(it.id ?? '')
        if (typeof it.pick === 'string') {
          const t = await target(it.pick)
          if (t.ok && !t.done) await tapIn(t)
        } else if (typeof it.checked === 'boolean') {
          const t = await target(id)
          if (t.ok && !t.done && t.checked !== it.checked) {
            await tapIn(t)
            await sleep(120)
            // If nothing changed after the click, click the text on the same line (a screen that covers the field)
            const w = where(id)
            await inFrame(tabId, w.frameId, pageFormCheckFix, w.id, it.checked).catch(() => undefined)
          }
        } else if (typeof it.value === 'string') {
          // Like real key input: clear the field (select all) and type the new text
          const w = where(id)
          if (!(await inFrame(tabId, w.frameId, pageFormFocus, w.id))) continue
          if (it.value) {
            const text = it.value.slice(0, 200)
            await cdp(tabId, 'Input.insertText', { text })
            // Fields that do not accept inserting all at once (captcha and identity check fields): if nothing went in, press keys one by one
            // (measured: text entered from the phone's "only needed fields" but the PC field stayed empty)
            let n = (await inFrame(tabId, w.frameId, pageActiveValueLength).catch(() => -1)) as number
            // Fields that reflect late: look again after a moment, and only if still empty select again and type key by key (so it does not go in twice)
            if (n === 0) {
              await sleep(150)
              n = (await inFrame(tabId, w.frameId, pageActiveValueLength).catch(() => -1)) as number
            }
            if (n === 0) {
              await inFrame(tabId, w.frameId, pageFormFocus, w.id)
              await typeKeys(tabId, text)
            }
          } else await pressKey(tabId, 'Backspace')
        }
        await sleep(60)
      }
      if (typeof a.press === 'string' && a.press) {
        const t = await target(a.press)
        if (!t.ok) throw new Error('Could not find the button to click. The screen may have changed')
        await tapIn(t)
      }
      await settle(tabId, before)
      return pageState(tabId)
    }
    case 'back': {
      const tabId = await ownedTab(a)
      await chrome.tabs.goBack(tabId).catch(() => {
        throw new Error('There is no page to go back to')
      })
      await sleep(200)
      await waitLoad(tabId)
      return pageState(tabId)
    }
    case 'focus': {
      // When handing off to a person: bring the Dool2 window and tab to the front
      const tabId = await ownedTab(a, false)
      await leavePhoneView(tabId)
      const t = await chrome.tabs.update(tabId, { active: true })
      if (t?.windowId !== undefined)
        await chrome.windows.update(t.windowId, { focused: true, drawAttention: true })
      await detach(tabId)
      return pageState(tabId)
    }
    case 'hold': {
      // Tabs waiting for a person or an approval: no tidying (sleeping or closing) for this time. At most 1 hour so it is not held too long
      const tabId = await ownedTab(a, false)
      const ms = Math.min(Math.max(Number(a.ms) || 0, 0), 60 * 60_000)
      const now = Date.now()
      await update((s) => {
        const held = Object.fromEntries(
          Object.entries(s.held ?? {}).filter(([id, until]) => until > now && s.owned.includes(Number(id))),
        )
        if (ms) held[tabId] = now + ms
        else delete held[tabId]
        s.held = held
      })
      touch(tabId)
      return { tabId, until: ms ? now + ms : 0 }
    }
    case 'close': {
      const tabId = await ownedTab(a, false)
      await detach(tabId)
      await chrome.tabs.remove(tabId)
      return { tabId, closed: true }
    }
    case 'upload':
      return upload(a)
  }
  throw new Error(`Unknown command: ${String(cmd)}`)
}

// ── Uploading PC files (browser_upload) ──
// Whether it is allowed is decided by the daemon (approval). The hand only inserts:
// (1) If the file field is found, insert the path as is through Chrome DevTools (DOM.setFileInputFiles) (fast even for big videos. Frames at another address use (3))
// (2) If there is no field (sites that create the field on click), intercept the file chooser (Page.setInterceptFileChooserDialog) and click the button.
//    No file chooser opens on the PC
// (3) If file access is off for the extension, Chrome blocks (1) ("Not allowed"): build the file inside the page from the chunks the daemon sends and insert it

/** Uploads waiting for chunks: mark -> where to insert (frameId for a field in a frame, objectId in the page world for a field caught via the chooser) */
const uploads = new Map<string, { tabId: number; frameId: number; objectId?: string; at: number }>()
/** Per tab, the side waiting for an intercepted file chooser */
const choosers = new Map<number, (p: { backendNodeId: number; mode: string }) => void>()

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Page.fileChooserOpened' || source.tabId === undefined) return
  choosers.get(source.tabId)?.(params as { backendNodeId: number; mode: string })
})

/** Call a function with that element as this in the page world (the value comes back) */
async function callOn<R>(tabId: number, objectId: string, fn: (...args: never[]) => R, ...args: unknown[]) {
  const r = await cdp<{
    result?: { value?: R }
    exceptionDetails?: { exception?: { description?: string } }
  }>(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn.toString(),
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails)
    throw new Error(
      r.exceptionDetails.exception?.description?.split('\n')[0] ?? 'An error occurred in the page',
    )
  return r.result?.value as R
}

/** DevTools node id of the field carrying the mark (data-dool2-up). Also finds frames in the same process (frames at another address are not found) */
async function markedNode(tabId: number, token: string): Promise<number | undefined> {
  await cdp(tabId, 'DOM.getDocument', { depth: 0 })
  const s = await cdp<{ searchId: string; resultCount: number }>(tabId, 'DOM.performSearch', {
    query: `input[data-dool2-up="${token}"]`,
  })
  try {
    if (!s.resultCount) return undefined
    const r = await cdp<{ nodeIds: number[] }>(tabId, 'DOM.getSearchResults', {
      searchId: s.searchId,
      fromIndex: 0,
      toIndex: s.resultCount,
    })
    return r.nodeIds.find((n) => n > 0)
  } finally {
    await cdp(tabId, 'DOM.discardSearchResults', { searchId: s.searchId }).catch(() => {})
  }
}

async function upload(a: Record<string, unknown>): Promise<unknown> {
  const tabId = await ownedTab(a)
  // Receive chunks and finish (3)
  if (typeof a.token === 'string') {
    const u = uploads.get(a.token)
    if (!u || u.tabId !== tabId) throw new Error('Forgot the file field being uploaded. Upload again')
    const token = a.token
    const sink = <R>(fn: (...args: never[]) => R, ...args: unknown[]): Promise<R> =>
      u.objectId
        ? callOn(tabId, u.objectId, fn, ...args)
        : (inFrame(tabId, u.frameId, fn as (...x: unknown[]) => R, ...args) as Promise<R>)
    if (a.cancel) {
      uploads.delete(token)
      await sink(pageUploadState, token).catch(() => undefined)
      return { token, cancelled: true }
    }
    if (typeof a.part === 'string') return { token, parts: await sink(pageUploadChunk, token, a.part) }
    if (Array.isArray(a.finish)) {
      uploads.delete(token)
      return { ...(await sink(pageUploadFinish, token, a.finish)), how: 'page' }
    }
    throw new Error('Neither part nor finish was given')
  }
  const ref = String(a.ref ?? '')
  if (!/^e\d+$/.test(ref)) throw new Error('ref must be a mark like e12')
  const paths = (Array.isArray(a.paths) ? a.paths : []).map(String).filter(Boolean)
  if (!paths.length) throw new Error('No files to upload')
  for (const [k, v] of uploads) if (Date.now() - v.at > 10 * 60_000) uploads.delete(k)
  const f = frameOf(tabId, ref)
  const token = crypto.randomUUID()
  // The field, the field a label points to, or the one field inside: it cannot be wrong, so insert right away
  const t = await inFrame(tabId, f.frameId, pageUploadTarget, ref, token, false)
  if (!t?.ok) throw new Error(t?.error ?? 'Could not find the file field')
  // viaPage: for testing - skip path insertion (1) and use chunk receiving (3) (the same path as an extension without file access)
  const viaPage = a.viaPage === true
  if (t.how !== 'none') return uploadInto(tabId, f.frameId, token, t, paths, viaPage)
  // Button: click it and intercept the file chooser the site opens (the field that site chose is the right one)
  let clickError = ''
  const chosen = await uploadByChooser(tabId, ref, token, paths, viaPage, (e) => {
    clickError = e
  })
  if (chosen) return chosen
  // If no window appeared, the only file field near the button (a few levels up)
  const near = await inFrame(tabId, f.frameId, pageUploadTarget, ref, token, true)
  if (near?.ok && near.how !== 'none') return uploadInto(tabId, f.frameId, token, near, paths, viaPage)
  throw new Error(
    `${clickError ? `${clickError} - ` : ''}Clicking did not open a file chooser. Read the page again, find a button like [Add photo], [Choose file], [My PC] or [Upload], or a file field, and upload with that (a menu or window may need to be opened first)`,
  )
}

/** Put into the file field found: (1) the path as is; if that fails, say (3) it will be received in chunks */
async function uploadInto(
  tabId: number,
  frameId: number,
  token: string,
  t: { how: string; accept: string; multiple: boolean; disabled: boolean },
  paths: string[],
  viaPage = false,
): Promise<unknown> {
  if (t.disabled)
    throw new Error(
      'The file field is disabled. Read the page to see whether something must be done first (choosing a type, etc.)',
    )
  if (!t.multiple && paths.length > 1)
    throw new Error('This field accepts only one file. Upload one at a time')
  let why = viaPage ? 'in chunks (test)' : ''
  const node = viaPage
    ? undefined
    : await markedNode(tabId, token).catch((e: Error) => {
        why = e.message
        return undefined
      })
  if (node) {
    const set = await cdp(tabId, 'DOM.setFileInputFiles', { files: paths, nodeId: node }).then(
      () => true,
      (e: Error) => {
        why = e.message
        return false
      },
    )
    if (set) return { ...(await inFrame(tabId, frameId, pageUploadState, token)), how: 'cdp', found: t.how }
  } else if (!why) why = 'field in a frame at another address'
  uploads.set(token, { tabId, frameId, at: Date.now() })
  return { needBytes: true, token, found: t.how, accept: t.accept, multiple: t.multiple, why }
}

/**
 * Click a button and intercept the file chooser it opens, then insert (no chooser opens on the PC). undefined if no chooser opened.
 * If the click fails, report why through onClickError and return undefined (the caller looks for a field nearby)
 */
async function uploadByChooser(
  tabId: number,
  ref: string,
  token: string,
  paths: string[],
  viaPage: boolean,
  onClickError: (why: string) => void,
): Promise<unknown> {
  await cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true })
  try {
    // The field the callback fills (kept in a variable because type narrowing does not know what the callback fills)
    const box: { got?: { backendNodeId: number; mode: string } } = {}
    const opened = new Promise<void>((done) =>
      choosers.set(tabId, (p) => {
        box.got ??= p
        done()
      }),
    )
    try {
      await run('click', { tabId, ref, once: true })
    } catch (e) {
      onClickError((e as Error).message)
      return undefined
    }
    if (!box.got) await Promise.race([opened, sleep(4000)])
    choosers.delete(tabId)
    const got = box.got
    if (!got) return undefined
    if (got.mode === 'selectSingle' && paths.length > 1)
      throw new Error('This field accepts only one file. Upload one at a time')
    let why = viaPage ? 'in chunks (test)' : ''
    const set = viaPage
      ? false
      : await cdp(tabId, 'DOM.setFileInputFiles', {
          files: paths,
          backendNodeId: got.backendNodeId,
        }).then(
          () => true,
          (e: Error) => {
            why = e.message
            return false
          },
        )
    const { object } = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
      backendNodeId: got.backendNodeId,
    })
    if (!object.objectId) throw new Error('Could not find the file field. Read the page again')
    const info = await callOn(tabId, object.objectId, pageUploadState, token)
    if (set) return { ...info, how: 'cdp', found: 'chooser' }
    uploads.set(token, { tabId, frameId: 0, objectId: object.objectId, at: Date.now() })
    return {
      needBytes: true,
      token,
      found: 'chooser',
      accept: info?.accept ?? '',
      multiple: got.mode === 'selectMultiple',
      why,
    }
  } finally {
    choosers.delete(tabId)
    await cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
  }
}
