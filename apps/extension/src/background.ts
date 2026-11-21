// 두리 확장 서비스 워커. 판단 없는 얇은 손이다 (ADR 0006, docs/architecture.md 5.1).
// - 두리 본체가 시킨 일만 한다. 무엇이 위험한지, 해도 되는지는 본체(승인 게이트)가 정한다
// - 두리가 연 탭만 다룬다. 사용자가 연 탭은 건드리지 않는다
// - 클릭·입력은 chrome.debugger(CDP Input)로 실제 입력과 같게 넣는다
import type { BridgeRequest, BrowserCommand } from '@dool2/protocol'
import { type FrameNode, layoutFrames, screenOrder } from './frames.js'
import { keyDef, pickPath, safeUrl } from './keys.js'
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
import { CLOSE_AFTER_MS, tidyPlan } from './tidy.js'

/** @dool2/protocol의 BROWSER_HOST_NAME과 같아야 한다 (테스트로 확인) */
export const HOST_NAME = 'com.dool2.host'
const VERSION = chrome.runtime.getManifest().version
const DEBUGGER_IDLE_MS = 2 * 60_000

type Status = { state: 'connecting' | 'on' | 'off'; detail?: string }
let port: chrome.runtime.Port | undefined
let status: Status = { state: 'off' }

// ── 본체와 연결 ──────────────────────────────────────────────

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
      detail: why?.includes('not found') ? '두리 앱이 설치돼 있지 않아요' : '두리 앱이 꺼져 있어요',
    })
  })
  p.postMessage({ event: 'hello', version: VERSION, browser: browserName() })
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
    setStatus({ state: 'off', detail: '두리 앱이 꺼져 있어요' })
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

// 서비스 워커는 쉬면 꺼진다. 연결이 살아 있으면 Chrome이 깨워 두고, 끊기면 30초마다 다시 붙는다
chrome.alarms.create('dool2-reconnect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'dool2-reconnect') return
  connect()
  void tidy()
})
chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
connect()
// 서비스 워커가 새로 떴는데 두리 탭 목록이 비어 있으면(확장 다시 켜기·Chrome 다시 켜기) 그룹에서 되찾는다
void load().then((s) => (s.owned.length ? undefined : reclaim()))

// 팝업: 연결 상태 보기, 다시 연결
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return
  if (msg?.type === 'retry') connect()
  reply({ ...status, connected: Boolean(port) && status.state !== 'off' })
})

// ── 두리 탭 ──────────────────────────────────────────────────

const GROUP_TITLE = '두리'

interface Saved {
  windowId?: number
  owned: number[]
  groupId?: number
  /** 탭마다 두리가 마지막으로 쓴 때 (서비스 워커가 쉬었다 깨도 남게) */
  used?: Record<string, number>
  /** 사람·승인을 기다리는 탭 → 이때까지 정리하지 않는다 (hold) */
  held?: Record<string, number>
  /** 최근에 닫힌 두리 탭 (다시 부르면 "사용자가 연 탭"이 아니라 "닫혔어요"로 알린다) */
  closed?: number[]
  /** 두리 탭마다 언제·어느 탭이 열었는지 (새 창·결제 창 목록, 정리에서 빼기). 최근 50개 */
  recs?: TabRec[]
  /** 정리(tidy)가 닫은 탭: 다음 읽기·탭 목록에서 알린다 */
  tidied?: Tidied[]
}
interface TabRec {
  tabId: number
  /** 이 탭을 연 두리 탭 (두리가 직접 연 탭은 없음) */
  opener?: number
  at: number
  url?: string
  title?: string
  /** popup 명령으로 이미 알린 새 창 */
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
/** 기록 하나 더하기 (같은 탭이면 고친다) */
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
 * 두리 탭 목록 되찾기. 목록은 session 저장소라 확장을 다시 켜거나(자동 업데이트 포함) Chrome을 다시 켜면 비워진다.
 * 그러면 열려 있던 두리 탭이 주인 없는 탭이 되어 정리(tidy)에서 빠지고, 새 "두리" 그룹이 또 생겨 탭이 쌓였다
 * (실측: 하루 시험 뒤 두리 탭 20여 개·Chrome 10GB, 8GB 맥이 멈춤).
 * 탭 번호는 Chrome을 다시 켜면 새로 매겨져 옛 번호를 믿으면 사용자 탭과 겹칠 수 있다. 그래서 번호 대신
 * "두리" 그룹(두리 탭은 열 때 늘 이 그룹에 넣는다)에 든 탭을 두리 탭으로 거둬들이고, 그룹이 여럿이면 하나로 합친다.
 */
async function reclaim() {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE }).catch(() => [])
  if (!groups.length) return
  const tabs = (await chrome.tabs.query({})).filter((t) => groups.some((g) => g.id === t.groupId))
  const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined)
  const [main, ...rest] = groups
  if (!main) return
  // 여러 "두리" 그룹은 첫 그룹으로 합친다 (같은 창의 것만. 다른 창 그룹은 그대로 두고 탭만 거둔다)
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
/** 두리 탭 목록 바꾸기는 한 번에 하나씩: 탭 두 개가 동시에 열리면 서로의 저장을 덮어써 "두리가 연 탭이 아니에요"가 났다 */
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
  if (!Number.isInteger(tabId)) throw new Error('두리가 연 탭이 아니에요. 사용자가 연 탭은 다루지 않아요')
  if (!s.owned.includes(tabId)) {
    // 두리 탭이 방금 연 새 탭(로그인 창 등)은 넘겨받기(adopt)가 저장되기 전에 바로 불릴 수 있다:
    // 연 탭이 두리 탭이면 여기서 넘겨받는다 (실측: 29CM·유니클로·서울예약·에어비앤비 구글·캐치테이블 네이버에서
    // "두리가 연 탭이 아니에요"로 멈췄다)
    const t = await chrome.tabs.get(tabId).catch(() => undefined)
    // 닫힌 두리 탭은 목록에서 빠져 "사용자가 연 탭"처럼 보였다: 닫혔다고 알린다 (AI·폰이 까닭을 바로 말하게)
    if (!t && s.closed?.includes(tabId)) throw new Error('탭이 닫혔어요')
    if (t?.openerTabId !== undefined && s.owned.includes(t.openerTabId)) await adopt(t.openerTabId, tabId)
    else throw new Error('두리가 연 탭이 아니에요. 사용자가 연 탭은 다루지 않아요')
  }
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    throw new Error('탭이 닫혔어요')
  }
  // 오래 안 써서 잠재운 탭이면 다시 불러온다
  if (tab.discarded) {
    await chrome.tabs.reload(tabId)
    await waitLoad(tabId)
  }
  // 다루는 동안 뜨는 사이트 알림창을 받는다 (사람에게 넘길 때·닫을 때는 붙이지 않는다)
  if (watching) await watch(tabId)
  return tabId
}

/** 두리 탭은 "두리" 창 하나에 모으고 초록 탭 그룹으로 묶는다 */
async function openTab(url: string): Promise<chrome.tabs.Tab> {
  const s = await load()
  let tab: chrome.tabs.Tab | undefined
  if (s.windowId !== undefined) {
    try {
      await chrome.windows.get(s.windowId)
      tab = await chrome.tabs.create({ windowId: s.windowId, url, active: true })
    } catch {
      s.windowId = undefined
    }
  }
  if (!tab) {
    const w = await chrome.windows.create({ url, focused: false, type: 'normal' })
    s.windowId = w?.id
    tab = w?.tabs?.[0]
  }
  if (tab?.id === undefined) throw new Error('탭을 열지 못했어요')
  const id = tab.id
  await update((x) => {
    x.owned = [...new Set([...x.owned, id])]
    if (s.windowId !== undefined) x.windowId = s.windowId
    putRec(x, { tabId: id, at: Date.now() })
  })
  touch(id)
  // 두리 탭은 소리 없이 (쇼핑몰 영상 등). 사용자가 듣고 싶으면 탭에서 켜면 된다
  void chrome.tabs.update(id, { muted: true }).catch(() => undefined)
  await groupTab(id)
  void tidy(id)
  return tab
}

// ── 다 쓴 두리 탭 정리 (메모리) ─────────────────────────────
// AI가 일 끝에 탭 닫기를 잊으면 탭이 쌓여 Chrome이 몇 GB씩 먹는다.
// 오래 안 쓴 탭은 잠재우고(discard), 더 오래되거나 너무 많으면 닫는다 (tidy.ts)

const usedAt = new Map<number, number>()
let usedSavedAt = 0
function touch(tabId: number) {
  usedAt.set(tabId, Date.now())
  tracked.add(tabId)
  // 저장은 가끔만 (명령마다 저장하면 느려진다)
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
      // 서비스 워커가 다시 깨어나 기록이 없으면 지금 쓴 것으로 본다 (깨자마자 몽땅 닫지 않게)
      const at = usedAt.get(id) ?? s.used?.[id] ?? now
      usedAt.set(id, at)
      // 가족 탭은 닫지도 재우지도 않는다: 연 탭이 살아 있는 탭(결제 창을 띄운 주문서), 살아 있는 탭이 30분 안에 연 탭(결제 창).
      // 주문서를 닫거나 재우면 결제 창이 결과를 돌려줄 곳이 없어 결제가 끊긴다 (실측 11-20 G마켓)
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
        why: old ? '45분 넘게 안 써서' : '두리 탭이 많아서(3개까지 둬요)',
      })
      await detach(id)
      await chrome.tabs.remove(id).catch(() => undefined)
    }
    // 닫은 것은 남겨 두고 다음 읽기·탭 목록에서 알린다 (말없이 닫으면 AI는 탭이 왜 사라졌는지 모른다)
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
    // 그룹은 보기 좋으라고 하는 것. 실패해도 일은 계속한다
  }
}

// 두리 탭에서 새 탭이 열리면(새 창 링크) 그것도 두리 탭으로 본다.
// 연 탭마다 목록으로 남긴다: 예전에는 마지막 새 창 하나만 기억해서, 다른 탭이 새 창을 열거나 누르기가 시작되면
// 늦게 뜬 결제 창을 잊었다
/** 탭마다 마지막으로 새 탭을 연 때 (누른 뒤 기다리기를 일찍 끝내게) */
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
// 미리 그려 둔 페이지로 바뀌면(prerender) 탭 번호가 바뀐다: 두리 탭이면 새 번호도 두리 탭
chrome.tabs.onReplaced.addListener((added, removed) => {
  void update((s) => {
    if (s.owned.includes(removed)) s.owned = [...s.owned.filter((t) => t !== removed), added]
  })
})
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  adopt(d.sourceTabId, d.tabId)
})
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined && tab.openerTabId !== undefined) adopt(tab.openerTabId, tab.id)
})
chrome.tabs.onRemoved.addListener(async (tabId) => {
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

async function waitLoad(tabId: number, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const t = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!t) throw new Error('탭이 닫혔어요')
    if (t.status === 'complete') return t
    // 여는 중에 확인 창이 뜨면 고를 때까지 다 열리지 않는다: 기다리지 않고 알린다
    if (dialogs.has(tabId)) return t
    await sleep(200)
  }
  return chrome.tabs.get(tabId)
}

/** 입력 뒤 화면이 바뀌기를 잠깐(최대 1.2초) 기다린다. 이동이 시작됐으면 끝날 때까지 (액자 안 이동도) */
/** quick: 키패드 숫자처럼 화면이 거의 안 바뀌는 누르기 (0.3초만 본다. 이동이 시작되면 그대로 끝까지 기다린다) */
async function settle(tabId: number, before?: string, quick = false) {
  const since = Date.now()
  await settleTop(tabId, before, quick ? 3 : 12)
  await framesSettle(tabId, since)
}
async function settleTop(tabId: number, before?: string, rounds = 12) {
  const since = Date.now()
  for (let i = 0; i < rounds; i++) {
    await sleep(100)
    // 확인 창이 뜨면 화면은 더 바뀌지 않는다 (고를 때까지 멈춰 있다)
    if (dialogs.has(tabId)) return
    // 누른 결과로 새 탭이 열렸으면 이 탭은 더 바뀌지 않는다: 기다리지 않는다
    // (새 탭이 앞으로 오면 이 탭은 뒤로 가서 그리기가 느려져, 1.2초를 다 채우던 것 — CI에서 4초)
    if ((lastOpened.get(tabId) ?? 0) >= since) return
    // 가려진 창에서도 누른 뒤의 화면 바뀜·애니메이션이 이어지게. 한 장 그리기가 40ms쯤 들어서(실측) 4번에 1번만
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

// ── 액자마다 불러오는 중인지 (webNavigation) ──
// 탭 상태·맨 위 주소만 보면 액자 안 이동(결제 단계·주소 찾기 결과)이 끝났는지 몰라, 반쯤 그려진 액자를 읽었다
/** 두리가 다루는 탭 (사용자 탭의 이동은 남기지 않는다) */
const tracked = new Set<number>()
/** 탭마다 마지막 주소·제목 (닫힌 뒤에도 탭 목록에서 무엇이었는지 알리게) */
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

/** 탭마다 마지막 읽기에서 글·누를 것이 있어 실은 액자 (광고 액자가 늘 새로 고쳐져도 누르기마다 기다리지 않게) */
const listedFrames = new Map<number, Set<number>>()

/**
 * since 뒤에 이동을 시작한 액자가 아직 불러오는 중이면 끝날 때까지 (많아야 maxMs).
 * 지난 읽기에 실은 액자와 새로 생긴 액자(눌러서 뜬 창)만 본다
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

// ── chrome.debugger: 실제 입력·화면 캡처 ─────────────────────

const attached = new Map<number, ReturnType<typeof setTimeout>>()
const stoppedByUser = new Set<number>()

/** 원격 화면으로 폰 크기를 흉내 내는 탭 (디버거가 떨어지면 Chrome이 원래 크기로 되돌린다) */
const emulated = new Map<number, string>()

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return
  // 떼면 Chrome이 폰 너비 그리기도 푼다
  phoneView.delete(source.tabId)
  phoneSize.delete(source.tabId)
  listening.delete(source.tabId)
  netLog.delete(source.tabId)
  clearTimeout(attached.get(source.tabId))
  attached.delete(source.tabId)
  emulated.delete(source.tabId)
  // 떼면 알림창은 Chrome이 다시 직접 띄운다 (두리가 고를 수 없다)
  dialogs.delete(source.tabId)
  // 사용자가 "취소"를 눌렀다면 그 탭은 더 이상 다루지 않는다
  if (reason === 'canceled_by_user') stoppedByUser.add(source.tabId)
})

/** 확인 창이 떠 있어도 할 수 있는 명령 (나머지는 페이지가 멈춰 있어 답이 오지 않는다) */
const DIALOG_SAFE = /^(?:Page\.(?:enable|handleJavaScriptDialog)|Network\.|Emulation\.clear)/

async function cdp<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  if (stoppedByUser.has(tabId)) throw new Error('사용자가 이 탭의 두리 제어를 멈췄어요')
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3')
    attached.set(
      tabId,
      setTimeout(() => {}, 0),
    )
    // 붙이자마자 사이트 알림창을 받는다. 이걸 안 하면 디버거가 붙은 탭에서 뜬 알림창이 아무도 닫지 못한 채
    // 페이지를 영원히 멈춰 세운다 (실측: 클릭 뒤 읽기가 계속 시간 초과). 알림창이 이미 떠 있으면 답이 안 오니 오래 기다리지 않는다
    await Promise.race([chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {}), sleep(2000)])
  }
  const open = dialogs.get(tabId)
  if (open && !DIALOG_SAFE.test(method)) throw new Error(dialogBlocked(open))
  // 한동안 안 쓰면 뗀다 (브라우저 위 "제어 중" 막대가 계속 떠 있지 않게)
  clearTimeout(attached.get(tabId))
  attached.set(
    tabId,
    setTimeout(() => idleDetach(tabId), DEBUGGER_IDLE_MS),
  )
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T
}

function idleDetach(tabId: number) {
  // 확인 창이 떠 있는 동안 떼면 아무도 닫을 수 없어 페이지가 멈춘 채 남는다: 붙여 둔다
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

// ── 사이트 알림창 (alert·confirm·prompt·떠나기 확인) ──
// 알림(alert)은 [확인] 하나뿐이라 바로 닫고 글만 남긴다 ("아이디 또는 비밀번호가 틀렸어요" 같은 말을 AI가 봐야 한다).
// 떠나기 확인은 두리가 그 페이지를 떠나려 할 때만 뜨니 떠난다.
// 확인(confirm)·입력(prompt)은 고르는 일이라 손이 정하지 않는다: 떠 있는 채로 두고 본체가 고르게 한다 (dialog 명령)

interface SiteDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  url: string
  defaultPrompt?: string
  /** 두리가 바로 [확인]·[떠나기]를 눌렀다 (알림창·떠나기 확인. 결과에 그대로 알린다) */
  autoAccepted?: boolean
}
/** 탭마다 떠 있는 확인 창 (confirm·prompt) */
const dialogs = new Map<number, SiteDialog>()
/** 탭마다 두리가 바로 닫은 알림창 (다음에 페이지를 읽을 때 함께 알린다) */
const dialogNotes = new Map<number, SiteDialog[]>()

function dialogBlocked(d: SiteDialog) {
  return `사이트 확인 창이 떠 있어서 페이지가 멈춰 있어요: "${d.message.slice(0, 200)}" — 먼저 확인이나 취소를 골라 주세요`
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId
  if (tabId === undefined) return
  if (method === 'Page.javascriptDialogClosed') {
    dialogs.delete(tabId)
    return
  }
  // 새 창 열기 시도 (막혔는지는 새 탭이 생겼는지로 본다)
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
  // 같은 알림창이 한 번에 여러 번 알려질 때가 있다 (실측): 한 번만 남긴다.
  // 떠나기 확인은 두리가 이동을 시킨 때만 뜨므로 그대로 떠나되, 몰래 하지 않고 다음 결과에 알린다
  d.autoAccepted = true
  const last = notes.at(-1)
  if (!last || last.type !== d.type || last.message !== d.message) notes.push(d)
  dialogNotes.set(tabId, notes.slice(-5))
  chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
})

/** 읽을 때 함께 알릴 알림창: 떠 있는 확인 창, 그리고 그동안 바로 닫은 알림창 (한 번 알리면 지운다) */
function takeDialogs(tabId: number): { dialog?: SiteDialog; dialogNotes?: SiteDialog[] } {
  const notes = dialogNotes.get(tabId)
  dialogNotes.delete(tabId)
  const open = dialogs.get(tabId)
  return { ...(open ? { dialog: open } : {}), ...(notes?.length ? { dialogNotes: notes } : {}) }
}

/** 이 탭의 알림창을 받기 시작한다 (디버거를 붙이고 Page.enable). 이미 붙어 있으면 그대로 */
async function watch(tabId: number) {
  if (attached.has(tabId) || stoppedByUser.has(tabId)) return
  await Promise.race([cdp(tabId, 'Page.enable').catch(() => {}), sleep(2500)])
}

// ── 페이지가 받은 응답 듣기 (커넥터 capture) ──
// 두리가 요청을 보내지 않는다. 사람이 그 화면을 열 때 사이트가 스스로 받는 응답 중 필요한 것을 읽을 뿐이다.
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
 * 탭을 한 장 그리게 한다. 창이 다른 창 뒤에 가려져 있으면 Chrome이 그 탭을 그리지 않아서,
 * 다음 그리기에 맞춰 상태를 바꾸는 사이트는 입력·Enter·팝업 닫기가 반쯤 멈춘 채 남는다
 * (실측: 사람이 없는 맥의 평소 Chrome에서 캐치테이블 검색 Enter가 안 먹고, 닫은 팝업 버튼이 계속 읽혔다).
 * 1×1로 화면을 찍으면 한 장을 그린다. 창을 앞으로 끌어오지 않으니 맥을 쓰는 사람을 방해하지 않는다
 */
async function paint(tabId: number) {
  // 그리지 못하는 화면(가상 화면·잠든 창)에서는 답이 오지 않을 수 있다: 오래 기다리지 않는다.
  // 찍는 자리는 지금 보이는 곳의 왼쪽 위 (clip은 문서 기준이라 0,0이면 굴린 페이지에서 화면 밖이다. 화면 밖을 찍으면
  // Chrome이 화면을 잠깐 옮겨 그리고, 그 뒤 다른 사이트 액자의 누르는 자리가 굴린 만큼 어긋났다 — 주소 찾기 버튼이 안 눌림)
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
 * Page.captureScreenshot의 clip은 문서 기준(굴린 만큼 더한 자리)이다. 화면 기준 자리(getBoundingClientRect)를 찍으려면
 * 굴린 만큼을 더해야 한다. 예전에는 화면 기준 그대로 넣어, 굴린 페이지에서 엉뚱한 곳(위쪽)이 찍혔다.
 * layout: 요소 상자(레이아웃 화면 기준), visual: 사람이 보는 화면 기준(확대해 본 폰 화면)
 */
async function scrollOffset(tabId: number, kind: 'layout' | 'visual'): Promise<{ x: number; y: number }> {
  type V = { pageX: number; pageY: number }
  const m = await cdp<{ cssLayoutViewport?: V; cssVisualViewport?: V }>(tabId, 'Page.getLayoutMetrics').catch(
    () => undefined,
  )
  const v = kind === 'layout' ? m?.cssLayoutViewport : m?.cssVisualViewport
  return { x: v?.pageX ?? 0, y: v?.pageY ?? 0 }
}

/** 원격 '필요한 칸만'을 액자 안에서 뽑은 탭: 그 액자 (채울 때 그쪽으로 보낸다) */
const formFrames = new Map<number, { frameId: number; url: string }>()
const FORM_FRAME = 'fr'
const FORM_FRAME_ID = /^fr(\d+)~(.+)$/

/** 폰 너비로 그리고 있는 탭 (원격 화면) */
const phoneView = new Set<number>()

/** 폰 너비로 그리는 탭의 폰 크기와, 잘린 창 때문에 넓혀 그리는 중인지 */
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
 * 폰 너비에서 입력칸·버튼이 화면 밖으로 잘리면(너비가 고정된 PC용 창: 정부24 간편인증) 잘리지 않는 너비까지 넓혀 그린다.
 * 폰에는 PC 화면이 줄어 보이고, 두 손가락으로 키워 볼 수 있다. 잘린 칸은 폰에서 볼 수도 누를 수도 없다
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
  // 넓혀 그리던 중 다른 화면으로 넘어갔으면 다시 폰 너비로 (인증을 마치고 신청 화면으로 넘어간 때)
  if (s.wide && (await chrome.tabs.get(tabId)).url !== before) await phoneWidth(tabId, s.w, s.h)
  // 눌러서 뜬 창이 그려질 틈
  else if (!s.wide) await sleep(400)
  await widenIfCut(tabId)
}

/**
 * 화면 아래로 잘린 창(결제 비밀번호 키패드 등): 그 아래까지 보이게 화면 높이를 늘려 그린다.
 * 굴려도 안 보이는(고정 위치) 창은 화면 밖이면 찍으면 빈 그림이고 마우스도 닿지 않는다
 * (실측 11-20: 쿠팡 키패드가 창 아래로 잘려 버튼 그림이 회색뿐이었다 → 두리가 숫자를 못 읽었다)
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
/** keepTall로 늘린 채 둔 탭 → 그래도 늦게라도 되돌리는 시계 (비밀번호를 다 못 누르고 멈춰도 남지 않게) */
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
/** 늘린 화면 높이를 원래대로 (남겨 두면 그 뒤 화면 찍기·누르는 자리가 어긋났다 — 실측 11-20 G마켓 배송지 추가) */
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
  // 확인 창이 떠 있으면 페이지 스크립트가 멈춰 있어 답이 오지 않는다 (기다리지 않고 알린다)
  const open = dialogs.get(tabId)
  if (open) throw new Error(dialogBlocked(open))
  const target = frameId ? { tabId, frameIds: [frameId] } : { tabId }
  const [res] = await chrome.scripting.executeScript({ target, world: 'ISOLATED', func, args })
  return res?.result as R
}

/** React·Vue 클릭 처리기만 붙은 상자에 표시 달기 (페이지 스크립트 공간에서만 보인다). 실패해도 화면 읽기는 계속한다.
 *  window.open 지켜보기(막힌 새 창 알기)도 함께 건다 */
async function markTaps(tabId: number, frameId: number) {
  const target = frameId ? { tabId, frameIds: [frameId] } : { tabId }
  await Promise.all([
    chrome.scripting.executeScript({ target, world: 'MAIN', func: pageMarkTaps }).catch(() => {}),
    chrome.scripting.executeScript({ target, world: 'MAIN', func: pageHookOpen }).catch(() => {}),
  ])
}

// ── 화면 안 액자 (iframe): 로그인 칸을 액자 안에 두는 사이트 (아고다 등) ──
/** 액자 하나의 표시 번호 대역 (액자 n → e{n*10000+1}…) */
const FRAME_SPAN = 10_000
/** 탭마다: 표시 대역 번호 → 확장 frameId·주소 (읽은 액자 모두. 사라진 액자는 읽을 때 뺀다) */
const frameMaps = new Map<number, Map<number, { frameId: number; url: string }>>()
/**
 * 탭마다 액자 → 번호를 고정한다. 읽을 때마다 보이는 순서로 매기면 광고 액자가 늘고 줄 때 번호가 밀려,
 * 방금 읽은 표시(e30010)가 누를 때는 다른 액자를 가리켰다 (실측 11-20 G마켓 주소 찾기 결과를 못 누름)
 */
const frameIndexes = new Map<number, Map<number, number>>()

/** 표시(e10012)가 어느 액자의 것인지 */
function frameOf(tabId: number, ref: string): { frameId: number; url?: string; index: number } {
  const n = Number(ref.slice(1))
  const index = Math.floor(n / FRAME_SPAN)
  if (!index) return { frameId: 0, index: 0 }
  const f = frameMaps.get(tabId)?.get(index)
  if (!f) throw new Error(`${ref}를 찾을 수 없어요. 화면을 다시 읽어 주세요`)
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
 * 액자 안의 자리(px, py: 그 액자 화면 기준)가 페이지 화면의 어디인지.
 * 액자 → 바깥 액자 → … → 페이지로 올라가며 단계마다 바깥 문서에서 액자 상자를 재어 더한다 (중첩 액자).
 * 단계마다: ① 같은 주소면 액자가 자기 상자(frameElement)를 잰다 ② 바깥 문서에서 주소·크기로 찾는다
 * ③ 같은 모양이 여럿이면 메시지로 어느 액자인지 가린다 ④ 그래도 모르면 디버거(CDP)로 액자 주인을 잰다.
 * 다 안 되면 오류를 낸다: 예전에는 (0,0)으로 잡아 엉뚱한 곳을 눌렀다.
 * scroll: 그 자리가 바깥 화면 밖이면 바깥을 굴려 보이게 한다 (누르기·사진)
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
    if (!f || depth > 10) throw new Error('화면 안 액자가 사라졌어요. 화면을 다시 읽어 주세요')
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
      // 디버거는 페이지 화면 기준 자리를 바로 준다 (바깥 단계는 더하지 않는다)
      const abs = await frameOwnerCdp(tabId, f.url).catch(() => undefined)
      if (abs) return { x: abs.x + x, y: abs.y + y }
      throw new Error(
        `화면 안 액자(${hostOf(f.url)})가 페이지의 어디에 있는지 찾지 못해서 누르지 않았어요. 화면을 다시 읽거나 browser_screenshot으로 확인해 주세요`,
      )
    }
    x += box.x
    y += box.y
    cur = parent
  }
  return { x, y }
}

/** 같은 모양 액자가 여럿일 때: 안쪽 액자가 바깥으로 메시지를 보내 어느 액자인지 가린다 (순번, 모르면 -1) */
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

/** CDP: 그 주소의 액자가 하나뿐일 때 액자 주인 요소의 안쪽 상자 (페이지 화면 기준). 여럿·없음이면 undefined */
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
 * 같은 사이트인지 (www.agoda.com ↔ accounts.agoda.com, shop.co.kr ↔ login.shop.co.kr, shop.com.au).
 * 이름이 셋 이상이고 둘째 칸이 짧은 공용 이름(co·or·go·ne·ac·re·pe·com·net·org)이면 세 칸까지가 사이트다.
 * IP·localhost는 그 주소 그대로
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
 * 두리 창 안에서 이 탭을 앞 탭으로 둔다. 뒤에 있는 탭은 Chrome이 그리지 않아 입력을 받지 않는다.
 * 두리 창은 두리 탭만 있으므로 사용자 탭에는 영향이 없다 (창 자체를 앞으로 가져오지는 않는다)
 */
async function frontTab(tabId: number) {
  const t = await chrome.tabs.get(tabId)
  if (t.active) return
  await chrome.tabs.update(tabId, { active: true })
  await sleep(150)
}

/** force: 둘레 글이 바뀌었거나 다른 버튼이 덮고 있어도 멈추지 않는다 (AI가 화면을 보고 그래도 누르기로 한 때) */
async function locate(tabId: number, ref: unknown, mode: LocateMode, force = false): Promise<LocateResult> {
  if (typeof ref !== 'string' || !/^e\d+$/.test(ref)) throw new Error('ref는 e12 같은 표시여야 해요')
  await frontTab(tabId)
  const f = frameOf(tabId, ref)
  const r = await inFrame(tabId, f.frameId, pageLocate, ref, mode, force)
  if (!r?.ok) throw new Error(r?.error ?? '요소를 찾지 못했어요')
  if (!f.frameId) return r
  // 액자 안 좌표 → 페이지 화면 좌표 (겹친 액자는 단계마다 더한다. 못 재면 오류)
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

// ── 마우스 움직임 ──
// 사람처럼 마우스를 목표까지 옮긴 뒤 누른다. 움직임 없이 바로 누르면 올려 두어야 열리는 메뉴가 안 열리고,
// 마우스가 들어온 적 없는 버튼을 누르는 셈이라 사이트가 사람 입력이 아니라고 볼 수 있다
/** 탭마다 마지막 마우스 자리 */
const pointer = new Map<number, { x: number; y: number }>()
/** 떼기(mouseReleased) 확인이 오지 않은 탭: 다음 동작 전에 떼기를 다시 보내 '누른 채'로 남지 않게 한다 */
const stillPressed = new Set<number>()

/**
 * 앞 클릭의 떼기가 화면이 바뀌는 사이 사라지면 페이지는 버튼을 누른 채로 안다. 그 상태로 커서가 움직이면 끌기가 된다
 * (실측: 구글 캘린더에서 일정을 지운 뒤 다음 일정 칩을 누르자 일정이 다른 날로 옮겨지고 '실행 취소'가 떴다)
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
  // 끝으로 갈수록 느려지고, 살짝 휘어 간다 (곧은 등속 직선은 사람 손이 아니다)
  const bend = Math.min(dist * 0.08, 18) * (from.x < x ? 1 : -1)
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const e = 1 - (1 - t) ** 3
    const px = from.x + (x - from.x) * e
    const py = from.y + (y - from.y) * e + Math.sin(Math.PI * t) * bend
    // 가려진 탭은 입력 확인 답이 늦다: 오래 기다리지 않는다
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

/** 두리가 하는 일을 페이지 위 커서로 보여 준다 (실패해도 일은 계속한다) */
function showCursor(tabId: number, x: number, y: number, label: string) {
  if (dialogs.has(tabId)) return Promise.resolve()
  return chrome.scripting
    .executeScript({ target: { tabId }, world: 'ISOLATED', func: pageCursor, args: [x, y, label] })
    .then(() => undefined)
    .catch(() => undefined)
}

/** label: 두리가 하는 일이면 커서를 보여 주고 마우스를 옮겨 간다. 없으면(사람이 원격으로 누름) 그 자리로 바로 */
async function clickAt(tabId: number, x: number, y: number, label?: string) {
  const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' }
  // 한 장 그리기는 마우스를 옮기기 전에 한다: 찍은 바로 뒤(수십 ms 안)의 누르기는 다른 사이트 액자(OOPIF)에 닿지 않고
  // 버려졌다 (실측: 시험 가게 배송지 액자 속 [우편번호 찾기]가 마우스로는 안 눌림, 찍은 뒤 50ms만 지나도 닿음)
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
  // 클릭으로 새 탭이 앞으로 오면 이 탭은 뒤로 가서 그려지지 않고, 입력 확인 답이 몇 초씩 늦는다. 오래 기다리지 않는다
  await Promise.race([
    cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }).then(() =>
      stillPressed.delete(tabId),
    ),
    sleep(1000),
  ])
}

async function pressKey(tabId: number, name: string) {
  const k = keyDef(name)
  if (!k) throw new Error(`모르는 키예요: ${name}`)
  // 넣은 글이 사이트 상태에 반영되게 먼저 한 장 그린다 (가려진 창에서 Enter가 빈 검색이 되던 것)
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
 * 한 글자씩 키를 눌러 넣기 (숫자·영문·기호). 한 번에 넣기(insertText)를 받지 않는 보안 입력칸용
 * (실측 금융인증서 창 휴대폰번호 칸: 한 번에 넣으면 0자)
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

async function pageState(tabId: number) {
  const t = await chrome.tabs.get(tabId)
  const open = dialogs.get(tabId)
  return { tabId, url: t.url ?? '', title: t.title ?? '', ...(open ? { dialog: open } : {}) }
}

/**
 * 이 탭이 연 새 탭 중 아직 알리지 않은 가장 새것 (since: 이때 뒤에 열린 것만). 알리면 알린 것으로 남긴다.
 * 이미 닫힌 탭은 알리지 않는다
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
/** 이 탭이 since 뒤에 연 새 탭이 있는지 (알린 것으로 남기지 않는다) */
async function openedSince(opener: number, since: number): Promise<boolean> {
  const s = await load()
  return (s.recs ?? []).some((r) => r.opener === opener && r.at >= since)
}

// ── 막힌 새 창 ──
// 페이지가 window.open을 불렀는데(pageHookOpen이 남김, 디버거의 Page.windowOpen도) 새 탭이 생기지 않았으면
// Chrome이 팝업으로 막은 것이다. 늦게 뜨는 결제 창이 막히면 화면만 하얗게 남는다 (실측 11-20 G마켓)
interface OpenAttempt {
  url: string
  at: number
  told?: boolean
}
const openAttempts = new Map<number, OpenAttempt[]>()
function noteOpen(tabId: number, url: string, at = Date.now()) {
  const list = (openAttempts.get(tabId) ?? []).filter((x) => Date.now() - x.at < 10 * 60_000)
  // 같은 부름이 두 길(페이지·디버거)로 들어오면 하나만
  if (!list.some((x) => x.url === url && Math.abs(x.at - at) < 1_500)) list.push({ url, at })
  openAttempts.set(tabId, list.slice(-10))
}
/** 페이지가 남긴 window.open 부름을 모으고, 새 탭이 안 생긴 것(막힌 새 창)을 돌려준다. tell: 알린 것으로 남긴다 */
async function blockedPopups(tabId: number, tell = true): Promise<{ url: string; at: number }[]> {
  // 확인 창이 떠 있으면 페이지 스크립트가 멈춰 있어 답이 오지 않는다: 이미 모은 것만 본다
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
  // 부름 하나에 새 탭 하나씩 짝짓는다 (한 번에 두 창을 열면 둘째만 막힌다: 첫 창이 둘 다의 짝이 되면 안 된다)
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
    // 막 부른 것은 아직 열리는 중일 수 있다
    if (now - a.at < 1_500 || (tell && a.told)) continue
    out.push({ url: a.url, at: a.at })
    if (tell) a.told = true
  }
  return out
}

// ── 액자 읽기 ──
// 읽는 액자: http(s)와 about:blank·about:srcdoc (결제 회사가 빈 액자를 만들어 스크립트로 채우는 곳이 많다).
// 누를 것이 없어도 글이 있으면(금액·오류 안내) 짧게 싣는다. 화면 순서(위→아래)로 늘어놓고, 맨 앞에 액자 목록을 단다
const READ_FRAME = /^(?:https?:|about:(?:blank|srcdoc)$)/
const LOOK_FRAMES = 40
/** 글만 있는 액자는 이만큼만 */
const TEXT_ONLY_MAX = 400

interface FrameItem {
  index: number
  frameId: number
  url: string
  /** 바깥 액자 번호 (0 = 본문) */
  parent: number
  shown: boolean
  loading: boolean
  refs: boolean
  truncated: boolean
  /** 자리를 주소·크기가 같은 액자들 사이에서 순서로 짐작했다 */
  guess?: boolean
}
interface FramesRead {
  text: string
  list: FrameItem[]
  captcha: boolean
  /** 액자 frameId → 읽기 결과 (글 속 [액자] 자리 표시를 바꿀 때) */
  marks: Map<number, Map<number, number>>
  blocked: { url: string; at: number }[]
}

/** 작업을 n개씩 나눠 돌린다 (액자가 많은 화면에서 스크립트 넣기가 한꺼번에 몰리지 않게) */
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
  // 사라진 액자는 지도에서 뺀다 (번호는 그대로 둔다: 다시 생긴 같은 액자가 다른 번호를 받아도 옛 표시와 섞이지 않게)
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
  // 글 속 자리 표시: 바깥 문서 frameId → (자리 표시 번호 → 액자 번호)
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
    // 빈 액자·안 보이는 글 액자(광고·추적용)는 뺀다. 누를 것이 있으면 안 보여도 싣는다 (곧 뜨는 로그인 창)
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
  // 자리 나누기: 보이는 누를 것 있는 액자 → 안 보이는 것 → 글만 있는 것 순으로, 남은 자리만큼
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
    '\n## 화면 안 액자 목록 (화면 위→아래. 액자 fN 안의 표시는 eN0001부터: f3 → e30001…)',
    ...list.map(
      (f) =>
        `- f${f.index} ${where(f.url)} · 바깥: ${f.parent ? `f${f.parent}` : '본문'} · ${f.shown ? '보임' : '안 보임'}${f.loading ? ' · 불러오는 중' : ''}${f.truncated ? ' · 글 잘림' : ''}${f.refs ? '' : ' · 글만'}${f.guess ? ' · 자리 짐작' : ''}`,
    ),
    ...(skipped ? [`(빈 액자·광고처럼 글이 없거나 안 보이는 액자 ${skipped}개는 뺐어요)`] : []),
  ].join('\n')
  const bodies = list
    .map((f) => {
      const t = kept.get(f.frameId) ?? ''
      const host = /^https?:/.test(f.url) ? hostOf(f.url) : f.url
      const tag = `f${f.index}${f.parent ? `, f${f.parent} 안` : ''}${f.truncated ? ', 글 잘림' : ''}`
      return t
        ? `\n## 화면 안 액자 (${host}) — ${tag}\n${t}`
        : `\n## 화면 안 액자 (${host}) — ${tag}\n(자리가 모자라 글을 싣지 못했어요. 필요하면 이 액자만 보이게 다시 읽어 주세요)`
    })
    .join('')
  return { text: `${head}${bodies}`, list, captcha, marks, blocked: [] }
}

/** 글 속 액자 자리 표시(U+2063 F{n} U+2063)를 [액자 f3]으로 (모르는 것은 [액자]) */
function withFrameMarks(text: string, frameId: number, read: Pick<FramesRead, 'marks'>): string {
  const m = read.marks.get(frameId)
  return text
    .replace(/\u2063F(\d+)\u2063/g, (_x, n: string) => {
      const index = m?.get(Number(n))
      return index !== undefined ? `[액자 f${index}]` : '[액자]'
    })
    .replace(/\u2063F?\d*$/, '')
}

/** 읽기 결과 끝에 붙이는 두리 알림: 막힌 새 창, 정리로 닫은 탭, 표시 번호 다시 매김 (한 번 알리면 지운다) */
async function snapshotNotes(tabId: number, main: SnapshotResult, read: FramesRead): Promise<string> {
  const out: string[] = []
  const blocked = await blockedPopups(tabId).catch(() => [])
  read.blocked = blocked
  for (const b of blocked)
    out.push(
      `- 이 탭이 새 창을 열려고 했는데 Chrome이 팝업으로 막았어요: ${b.url || '(주소 없는 빈 창: 결제 양식을 보내는 창일 수 있어요)'}. 결제 창이면 승인받은 결제 버튼을 누를 때 두리가 이 사이트 팝업을 허용해 두니 그 버튼을 다시 눌러요. 주소가 있는 보통 창이면 그 주소를 열어도 돼요`,
    )
  const told: number[] = []
  const s = await load()
  for (const t of s.tidied ?? []) {
    if (t.told) continue
    told.push(t.tabId)
    out.push(`- 두리가 탭 ${t.tabId}(${t.title || t.url || '제목 없음'})을 닫았어요: ${t.why}`)
  }
  if (told.length)
    await update((x) => {
      for (const t of x.tidied ?? []) if (told.includes(t.tabId)) t.told = true
    })
  if (main.renumbered)
    out.push(
      '- 이 화면의 표시 번호를 처음부터 새로 매겼어요. 전에 읽은 표시(e…)는 쓰지 말고 이 화면의 표시를 쓰세요',
    )
  if (main.refsCapped)
    out.push(
      `- 누를 것이 너무 많아 ${main.refsCapped}개에는 표시를 못 붙였어요(괄호로만 보여요). from·view로 필요한 부분만 다시 읽어 주세요`,
    )
  return out.length ? `\n## 두리 알림\n${out.join('\n')}` : ''
}

// ── 명령 ─────────────────────────────────────────────────────

async function run(cmd: BrowserCommand, a: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case 'options': {
      // 펼침 목록의 고를 것 (결제 화면의 등록 카드·할부, 상품 옵션). 고르는 건 하지 않는다
      const tabId = await ownedTab(a)
      const ref = String(a.ref ?? '')
      const fid = frameOf(tabId, ref).frameId
      let r = await inFrame(tabId, fid, pageSelectOptions, ref, false)
      // 스크립트 누르기로 안 열리는 목록(요즘 부품은 진짜 입력만 받는다. 실측 무신사·오늘의집): 진짜 마우스로 열고 다시 읽는다
      if (!r?.options) {
        await inFrame(tabId, fid, pageRememberShown)
        const at = await locate(tabId, ref, 'point')
        await clickAt(tabId, at.x, at.y, '옵션 목록 여는 중')
        await sleep(700)
        const r2 = await inFrame(tabId, fid, pageSelectOptions, ref, true)
        r = r2?.options ? r2 : { why: `${r?.why ?? ''} / 마우스로 연 뒤: ${r2?.why ?? ''}`.slice(0, 900) }
      }
      return { tabId, options: r?.options ?? null, ...(r?.why ? { why: r.why } : {}) }
    }
    case 'choose': {
      // 펼침 목록에서 글자가 같은 것을 고른다
      const tabId = await ownedTab(a)
      const ref = String(a.ref ?? '')
      const label = String(a.label ?? '')
      const f = frameOf(tabId, ref)
      const r = await inFrame(tabId, f.frameId, pageSelectChoose, ref, label)
      if (r.ok) return { tabId, label: r.label }
      // 안 되면 진짜 마우스로 열고, 그 항목도 진짜 마우스로 누른다
      await inFrame(tabId, f.frameId, pageRememberShown)
      const at = await locate(tabId, ref, 'point')
      await clickAt(tabId, at.x, at.y, '옵션 목록 여는 중')
      await sleep(700)
      const pt = await inFrame(tabId, f.frameId, pageOptionPoint, label)
      if (!pt.ok) throw new Error(pt.error)
      const p = await framePoint(tabId, f.frameId, pt.x, pt.y)
      await clickAt(tabId, p.x, p.y, `${pt.label} 고르는 중`)
      await sleep(400)
      return { tabId, label: pt.label }
    }
    case 'mark-text': {
      // 글자로 누를 곳에 표시를 붙인다 (그 뒤 보통 click으로 누른다)
      const tabId = await ownedTab(a)
      const r = await inPage(tabId, pageMarkText, String(a.text ?? ''))
      if (!r.ok) throw new Error(r.error)
      return r
    }
    case 'thumb': {
      // 카드 사진: 받아서 긴 쪽 360px JPEG로 줄인다 (폰으로 보내는 크기를 줄이고, 그림 종류를 하나로)
      const url = String(a.url ?? '')
      if (!/^https:\/\//.test(url)) throw new Error('https 사진만 받아요')
      const res = await fetch(url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(8000),
      })
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
      if (!res.ok || !/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) throw new Error('사진이 아니에요')
      const blob = await res.blob()
      if (blob.size > 8_000_000) throw new Error('사진이 너무 커요')
      const bmp = await createImageBitmap(blob)
      const scale = Math.min(1, 360 / Math.max(bmp.width, bmp.height))
      const w = Math.max(1, Math.round(bmp.width * scale))
      const hgt = Math.max(1, Math.round(bmp.height * scale))
      const canvas = new OffscreenCanvas(w, hgt)
      const g = canvas.getContext('2d')
      if (!g) throw new Error('그릴 수 없어요')
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
      // 커넥터: 화면 목록을 칸별로 뽑는다 (읽기만)
      const tabId = await ownedTab(a)
      await waitLoad(tabId, 10_000)
      if (attached.has(tabId)) await paint(tabId)
      const spec = a.spec as ExtractSpec
      let r = await inPage(tabId, pageExtract, spec)
      if (!r.ok) throw new Error(r.error)
      // 사진 칸이 비어 있으면: 늦게 그리는 사진이다. 목록을 한 번 훑어 내려 그리게 한 뒤 다시 읽는다
      // (창이 다른 창 뒤에 가려져 있으면 Chrome이 화면 밖 사진을 불러오지 않는다 — 호텔스닷컴 0/10 → 시험 창 9/10)
      const pics = Object.entries(spec.fields)
        .filter(([, f]) => f.image)
        .map(([k]) => k)
      const missing = () => (r.ok ? r.rows.filter((row) => pics.some((k) => !row[k])).length : 0)
      if (pics.length && r.ok && r.rows.length && missing() > r.rows.length * 0.2) {
        const total = Math.min(r.total, spec.limit ?? 30, 40)
        for (let i = 0; i < total; i += 2) {
          await inPage(tabId, pageRevealItem, spec.items, i)
          // 가려진 창도 한 장씩 그리게 한다 (그래야 화면에 들어온 사진을 불러온다)
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
      // 커넥터: 화면 글에 이 말들이 있는지 (기다리기·화면 확인)
      const tabId = await ownedTab(a)
      if (attached.has(tabId)) await paint(tabId)
      const patterns = (a.patterns ?? {}) as Record<string, string>
      return inPage(tabId, pageFind, patterns)
    }
    case 'capture': {
      // 커넥터: 이 탭의 페이지가 스스로 받은 응답(JSON)을 읽는다. 두리가 따로 요청하지 않는다 (ADR 0018)
      const tabId = await ownedTab(a)
      if (!listening.has(tabId))
        throw new Error('이 탭은 응답을 듣고 있지 않아요 (주소를 열 때 capture를 켜야 해요)')
      let re: RegExp
      try {
        re = new RegExp(String(a.url ?? ''))
      } catch {
        throw new Error(`주소 패턴이 틀렸어요: ${String(a.url)}`)
      }
      const wait = Math.min(Math.max(Number(a.timeoutMs) || 10_000, 500), 30_000)
      const until = Date.now() + wait
      // 새 탭이 열리자마자 데이터를 부르면 듣기가 붙기 전에 지나간다(사용자 Chrome에서 유니클로·다이소몰이 들쭉날쭉).
      // 반쯤 기다려도 그 주소를 하나도 못 들었으면 한 번만 새로 고쳐 다시 부르게 한다. 몰래 새로 고치지 않는다:
      // 부르는 쪽이 reloadIfSilent로 시킨 때만(읽기만 하는 커넥터 목록 화면), 그리고 결과에 알린다.
      // 시키지 않았으면 못 들었다고만 알린다 (쓰던 칸·결제 화면을 새로 고치면 넣은 것이 사라진다)
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
            throw new Error(`페이지가 받은 응답이 JSON이 아니에요 (${hit.url.slice(0, 80)})`)
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
            `페이지가 그 데이터를 받지 않았어요 (${String(a.url)})${a.reloadIfSilent === true ? '' : '. 듣기를 붙이기 전에 지나갔을 수 있어요(새로 고치면 다시 부를 수 있어요)'}`,
          )
        await sleep(200)
      }
    }
    case 'dialog': {
      // 떠 있는 확인 창에서 고른다 (고르는 판단은 본체가 한다). expect: 본체가 본 창과 같은 창일 때만
      const tabId = await ownedTab(a)
      const d = dialogs.get(tabId)
      if (!d) throw new Error('떠 있는 사이트 확인 창이 없어요')
      if (typeof a.expect === 'string' && a.expect.slice(0, 200) !== d.message.slice(0, 200))
        throw new Error('확인 창 내용이 바뀌어서 고르지 않았어요')
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
      // 올려 두기: 마우스를 그 자리로 옮기기만 한다 (올려 두어야 열리는 메뉴·설명)
      const tabId = await ownedTab(a)
      const at = await locate(tabId, a.ref, 'point')
      if (at.hidden) throw new Error('두리 창이 가려져 있어서 마우스를 올릴 수 없어요')
      await showCursor(tabId, at.x, at.y, '두리가 올려 보는 중')
      await moveMouse(tabId, at.x, at.y)
      // 그려지지 않던 창은 올려 둔 상태(:hover)를 다음 그리기·움직임에서야 반영한다: 한 장 그리고 제자리에서 한 번 더
      await paint(tabId)
      await Promise.race([
        cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none' }),
        sleep(300),
      ])
      await settle(tabId)
      return pageState(tabId)
    }
    case 'link-navigates': {
      // 승인 게이트: 이 링크가 다른 화면으로 가기만 하는지 (값은 참·거짓만)
      const tabId = await ownedTab(a)
      const frameId = frameOf(tabId, String(a.ref)).frameId
      return {
        navigates: Boolean(
          await inFrame(tabId, frameId, pageLinkNavigates, String(a.ref)).catch(() => false),
        ),
      }
    }
    case 'reload': {
      // 답을 먼저 보낸 뒤 다시 켠다 (다시 켜지면 본체에 새로 인사한다)
      setTimeout(() => chrome.runtime.reload(), 200)
      return { ok: true }
    }
    case 'open': {
      const url = safeUrl(a.url)
      if (!url) throw new Error('http·https 주소만 열 수 있어요')
      // 빈 탭을 먼저 열고 알림창 받기를 켠 뒤 주소로 간다 (여는 중에 뜨는 알림창도 받게).
      // capture면 페이지가 받는 응답도 처음부터 듣는다
      const tab = await openTab('about:blank')
      if (tab.id === undefined) throw new Error('탭을 열지 못했어요')
      await watch(tab.id)
      if (a.capture) await listen(tab.id)
      await chrome.tabs.update(tab.id, { url })
      await sleep(200)
      await waitLoad(tab.id)
      return pageState(tab.id)
    }
    case 'navigate': {
      const tabId = await ownedTab(a)
      const url = safeUrl(a.url)
      if (!url) throw new Error('http·https 주소만 열 수 있어요')
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
      // 확인 창이 떠 있으면 페이지가 멈춰 있어 읽을 수 없다: 창 내용만 알린다
      if (dialogs.has(tabId))
        return {
          ...(await pageState(tabId)),
          text: '',
          truncated: false,
          captcha: false,
          ...takeDialogs(tabId),
        }
      // 닫힌 팝업이 사라지는 등 멈춰 있던 화면 바뀜을 마저 끝내고 읽는다
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
      // 액자(로그인·인증·결제 창)가 잘리지 않게 액자 글을 먼저 싣고, 남은 자리만큼 본문을 싣는다
      // (실측 홈택스: 본문 4만 자 뒤에 붙인 간편인증 액자가 전체 자르기에 잘려 [인증 완료]를 못 봤다)
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
        // 본문 글의 길이 (이어 읽기 skip은 이것만큼. 액자 글·알림은 본문이 아니다)
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
      // 결제 비밀번호 키패드처럼 같은 자리를 잇달아 누를 때: 커서 움직임을 보여 주지 않고 짧게만 기다린다 (숫자 하나 2.3초 → 실측)
      const quick = a.quick === true
      // keepTall: 이어서 또 누를 테니 늘린 화면 높이를 아직 되돌리지 않는다 (마지막 숫자에서 되돌린다)
      const keepTall = quick && a.keepTall === true
      let at = await locate(tabId, ref, 'point', force)
      // 굴려도 화면 밖인 것(화면 아래에 고정된 결제 키패드 등)만 화면 높이를 잠깐 늘려 마우스가 닿게 한다 (누른 뒤 원래대로)
      const tall = at.outside
        ? await tallerIfBelow(tabId, (at.bottom ?? at.y) + 30).catch(() => false)
        : false
      if (tall) at = await locate(tabId, ref, 'point', force)
      // 굴려 옮겼으면 늦게 뜨는 그림·목록으로 자리가 밀리거나, 목록이 칸을 재활용해 다른 것을 그린다.
      // 잠깐 그리게 한 뒤 다시 잰다 (다른 것이 그려졌으면 locate가 "다시 읽어 주세요"로 멈춘다)
      if (at.moved) {
        await sleep(300)
        await paint(tabId)
        at = await locate(tabId, ref, 'point', force)
      }
      const t0 = Date.now()
      const before = (await chrome.tabs.get(tabId)).url
      const fid = frameOf(tabId, ref).frameId
      // 막힌 새 창을 알아채게 window.open 지켜보기를 건다 (읽기 뒤 화면이 바뀌었을 수 있어 다시. 이미 걸려 있으면 그대로)
      await chrome.scripting
        .executeScript({
          target: fid ? { tabId, frameIds: [fid] } : { tabId },
          world: 'MAIN',
          func: pageHookOpen,
        })
        .catch(() => undefined)
      let via: 'mouse' | 'key' | 'script' = 'mouse'
      // 화면 서명: 주소·초점·체크된 칸 수·문서 크기 (그 액자 안에서 본다)
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
      // 닿았는지: 진짜 입력(isTrusted)이 그 요소에 닿았으면 눌린 것이다. 다시 누르지 않는다
      // (화면 글이 안 바뀌는 버튼을 "안 눌렸다"고 보고 다시 눌러 키패드 숫자가 두 번 들어갔다 — 실측 쿠팡 결제 비밀번호)
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
        await clickAt(tabId, at.x, at.y, quick ? undefined : '두리가 누르는 중')
        await settle(tabId, before, quick)
        const hit = await inFrame(tabId, fid, pageHitRead, false).catch(() => noHit)
        const opened = await openedSince(tabId, t0)
        // 문서가 바뀌었으면(이동) 걸어 둔 것이 사라진다: 눌려서 넘어간 것이다
        delivered = hit.hit || opened || !hit.armed
        if (!hit.hit && hit.other) hitOther = hit.other
        if (!delivered) {
          // 닿은 기록이 없어도 화면이 바뀌었으면 다시 누르지 않는다 (사이트가 입력을 먼저 가로챘을 수 있다)
          const mut = await inFrame(tabId, fid, pageMutRead, 'click', true).catch(() => ({ n: -1 }))
          const same = sig !== '' && sig === (await mark())
          // 창이 일부 가려져 있으면 '보인다'고 나와도 Chrome이 마우스 입력을 버릴 때가 있다 (실측: 인증번호 확인 버튼).
          // 켜고 끄는 칸(체크박스 등)은 다시 누르면 되돌아가니 다시 누르지 않는다. once: 그래도 한 번만
          retry = same && mut.n <= 0 && !a.once && !(await locate(tabId, ref, 'activate', true)).toggle
        } else void inFrame(tabId, fid, pageMutRead, 'click', true).catch(() => undefined)
      }
      if (!mouse || retry) {
        // 두리 창이 가려져 있거나 화면이 꺼져 있으면 Chrome이 마우스 입력을 버린다 (키보드는 받는다, 실측).
        // 다른 버튼이 덮고 있는데 force로 부른 때도 마우스로 누르면 덮은 버튼이 눌리니 그 요소를 직접 누른다.
        // 초점을 주고 Enter·Space로 누른다. 브라우저가 만드는 진짜 클릭이라 사이트가 보기에도 같다
        const act = await locate(tabId, ref, 'activate', true)
        await inFrame(tabId, fid, pageHitArm, ref).catch(() => false)
        if (!act.focused) {
          // 키보드로 누를 수 없는 요소(초점을 못 받는 div 등)는 마지막 수단으로 페이지 안에서 누른다
          via = 'script'
          delivered = Boolean(await inFrame(tabId, fid, pageClick, ref).catch(() => false))
        } else {
          via = 'key'
          await pressKey(tabId, act.toggle ? 'Space' : 'Enter')
          await settle(tabId, before, quick)
          const hit = await inFrame(tabId, fid, pageHitRead, false).catch(() => noHit)
          delivered = hit.hit || !hit.armed || (await openedSince(tabId, t0))
          // 뒤에 가려진 창은 키도 안 먹을 때가 있다 (실측): 그 요소에 닿지 않았을 때만 페이지 안에서 누른다
          if (!delivered && !act.toggle) {
            via = 'script'
            delivered = Boolean(await inFrame(tabId, fid, pageClick, ref).catch(() => false))
          }
        }
        await settle(tabId, before, quick)
      }
      // 누른 뒤 창이 스스로 닫혔다 (결제 창의 마지막 비밀번호 숫자: 결제가 끝나면 결제 회사 창이 닫힌다).
      // 눌린 것이니 오류('탭이 닫혔어요')로 돌려주지 않는다 — 예전에는 결제가 된 뒤에 '못 눌렀다'로 알렸다
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
        // 누른 자리 (페이지 화면 기준, 액자 안이면 겹친 액자 상자를 모두 더한 자리)
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
      if (typeof a.text !== 'string') throw new Error('넣을 글자가 없어요')
      const ref = String(a.ref ?? '')
      let at = await locate(tabId, ref, 'type')
      if (at.isPassword) throw new Error('비밀번호 칸에는 두리 금고로만 채워요')
      // 다른 주소의 액자는 스크립트 초점을 막는 경우가 있다: 초점이 안 들어갔으면 칸을 한 번 눌러 진짜 초점을 준 뒤
      // 다시 골라(원래 글 전체 선택) 넣는다. 초점 없이 넣으면 글이 바깥 페이지로 가거나 사라졌다 (fill과 같은 까닭)
      if (at.frame && !at.hidden && !at.focused) {
        await clickAt(tabId, at.x, at.y, '두리가 입력하는 중')
        at = await locate(tabId, ref, 'type')
      } else if (!at.hidden) await showCursor(tabId, at.x, at.y, '두리가 입력하는 중')
      await cdp(tabId, 'Input.insertText', { text: a.text })
      // 한 번에 넣기를 받지 않는 칸: 하나도 안 들어갔으면 잠깐 뒤 다시 보고, 그래도 비었을 때만 다시 골라 키를 하나씩
      // (글을 늦게 반영하는 칸에서 바로 키를 또 누르면 두 번 들어간다)
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
        // 입력을 조금 늦게 상태에 반영하는 칸이 있다: 잠깐 기다린 뒤 Enter (pressKey가 한 장 그리기도 한다)
        await sleep(300)
        await pressKey(tabId, 'Enter')
        await settle(tabId, before)
      }
      return pageState(tabId)
    }
    case 'fill': {
      // 두리 금고 (ADR 0011): 값은 본체가 준다. 주소가 맞을 때만 넣고, 값은 어디에도 돌려주지 않는다
      const tabId = await ownedTab(a)
      if (typeof a.value !== 'string' || typeof a.origin !== 'string') throw new Error('채울 값이 없어요')
      const at = await locate(tabId, a.ref, 'type')
      // 액자 안 칸은 같은 사이트의 액자일 때만 (로그인 창을 하위 도메인 액자로 띄우는 곳)
      const inFrameRef = Boolean(at.frame)
      // 내 정보(이름·휴대폰·생년월일)는 공인된 인증 창 액자에도 넣는다 (금융인증서 창은 금융결제원 주소의 액자다).
      // 비밀번호(금고)는 a.trust를 주지 않아 지금처럼 그 사이트에만 넣는다
      const trusted =
        inFrameRef && Array.isArray(a.trust) && (a.trust as string[]).includes(siteOf(at.origin))
      const ok = at.origin === a.origin || (inFrameRef && siteOf(at.origin) === siteOf(a.origin)) || trusted
      if (!ok) throw new Error('지금 페이지 주소가 저장된 사이트와 달라서 채우지 않았어요')
      if (a.password && !at.isPassword) throw new Error('비밀번호 칸이 아니라서 채우지 않았어요')
      // 다른 주소의 액자는 스크립트 초점을 막는 경우가 있어, 칸을 한 번 눌러 초점을 준다
      // 스크립트 초점이 이미 들어갔으면 누르지 않는다: 액자 좌표가 어긋나 칸 밖을 누르면 초점이 빠지고
      // 사이트가 "번호를 올바르게 입력해 주세요"를 띄웠다 (실측 금융인증서 창)
      if (inFrameRef && !at.hidden && !at.focused) await clickAt(tabId, at.x, at.y, '두리 금고로 채우는 중')
      else if (!at.hidden) await showCursor(tabId, at.x, at.y, '두리 금고로 채우는 중')
      await cdp(tabId, 'Input.insertText', { text: a.value })
      const frameId = frameOf(tabId, String(a.ref)).frameId
      // 칸이 글자 수를 막으면(maxlength) 잘려 들어간다: 들어간 길이만 알린다 (값은 돌려주지 않는다)
      let length = (await inFrame(tabId, frameId, pageValueLength, String(a.ref), !a.password).catch(
        () => -1,
      )) as number
      // 글을 늦게 반영하는 칸이 있다: 0이면 잠깐 뒤 다시 본다 (바로 키를 또 누르면 두 번 들어간다)
      if (length === 0 && a.value && !a.password) {
        await sleep(150)
        length = (await inFrame(tabId, frameId, pageValueLength, String(a.ref), true).catch(
          () => -1,
        )) as number
      }
      // 그래도 하나도 안 들어갔으면 다시 골라(전체 선택) 키를 하나씩 (비밀번호는 금고 값이 키 기록에 남지 않게 하지 않는다)
      if (length === 0 && a.value && !a.password) {
        await locate(tabId, a.ref, 'type')
        await typeKeys(tabId, a.value)
        length = (await inFrame(tabId, frameId, pageValueLength, String(a.ref), !a.password).catch(
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
      // ref를 주면 그 요소(또는 그것을 품은 굴러가는 상자: 목록 창·모달·액자 안)를 굴린다. 없으면 페이지.
      // 얼마나 굴렀는지·끝인지를 돌려준다 (AI가 더 굴릴지 정한다)
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      const v = await inPage(tabId, pageViewport)
      const dir = a.direction === 'up' ? -1 : 1
      const ref = typeof a.ref === 'string' && /^e\d+$/.test(a.ref) ? a.ref : null
      const fid = ref ? frameOf(tabId, ref).frameId : 0
      const info0 = await inFrame(tabId, fid, pageScrollInfo, ref, 0)
      if (!info0.ok) throw new Error(info0.error ?? '굴릴 곳을 찾지 못했어요')
      if (v.hidden) {
        // 가려진 창은 마우스 휠을 받지 않는다. 스크롤은 사이트에 의미 있는 입력이 아니라서 페이지 안에서 옮긴다
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
      // 휠이 가운데의 다른 상자를 굴려 정한 곳이 그대로면 그곳을 페이지 안에서 굴린다 (굴린 곳은 결과에 그대로 알린다)
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
      // 결제 창은 버튼을 누른 순간이 아니라 서버에 다녀와서 새 창으로 열린다: Chrome이 팝업으로 막아 화면만 하얗게 남았다
      // (실측 11-20 G마켓 카드 결제). 두리가 결제하는 사이트만 팝업을 허용한다 (사람은 주소창의 '팝업 허용'을 누르던 것).
      // 사이트 범위는 같은 사이트 판단(siteOf)과 같다: shop.co.kr·shop.com.au는 세 칸, IP·localhost는 그 주소만
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
      // 누른 뒤 늦게 뜬 새 창(결제 창 등): 그 탭이 연 창 중 아직 알리지 않은 가장 새것. 막힌 새 창도 함께 알린다
      const tabId = await ownedTab(a)
      const blocked = await blockedPopups(tabId).catch(() => [])
      return { ...(await takePopup(tabId)), ...(blocked.length ? { blockedPopups: blocked } : {}) }
    }
    case 'tabs': {
      // 두리 탭 목록: 누가 열었는지·언제·주소·제목·창 종류·앞 탭인지, 최근에 닫힌 새 창, 정리로 닫은 탭, 막힌 새 창.
      // 늦게 뜬 결제 창·로그인 창이 어디 있는지 AI가 직접 본다
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
      // 기다리기: 화면이 바뀔 때까지(또는 ms 동안) 기다리고, 무엇이 바뀌었는지 돌려준다.
      // 바뀜: 문서 글·요소(본문·액자), 액자 이동, 주소 이동, 새 탭, 사이트 알림창·확인 창. 됐는지는 AI가 본다
      const tabId = await ownedTab(a)
      const ms = Math.min(Math.max(Number(a.ms) || 3_000, 100), 10_000)
      const untilChange = a.until !== 'time'
      const t0 = Date.now()
      const before = (await chrome.tabs.get(tabId)).url ?? ''
      const notesBefore = dialogNotes.get(tabId)?.length ?? 0
      const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? []
      // 지켜볼 문서: 본문 + 마지막으로 읽은 액자들 (많아야 8개)
      const known = new Set([...(frameMaps.get(tabId)?.values() ?? [])].map((f) => f.frameId))
      const watchIds = [0, ...frames.filter((f) => known.has(f.frameId)).map((f) => f.frameId)].slice(0, 9)
      const armed: number[] = []
      if (!dialogs.has(tabId))
        await Promise.all(
          watchIds.map(async (fid) => {
            if (await inFrame(tabId, fid, pageMutArm, 'wait').catch(() => false)) armed.push(fid)
          }),
        )
      const label = (fid: number) => (fid ? `f${frameIndexes.get(tabId)?.get(fid) ?? '?'}` : '본문')
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
            // 바뀌기 시작했으면 조금 더 기다려 마저 그리게 한다 (이동이면 끝날 때까지)
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
        ...(state.url !== before ? [`주소 이동: ${state.url.slice(0, 120)}`] : []),
        ...navs.filter((n) => n.frame !== '본문').map((n) => `액자 ${n.frame} 이동: ${n.url.slice(0, 100)}`),
        ...dom.map(
          (d) =>
            `${d.frame} 글·요소 바뀜 (더함 ${d.added}·뺌 ${d.removed}·속성 ${d.attrs})${d.text ? `: ${d.text}` : ''}`,
        ),
        ...newTabs.map((n) => `새 탭 ${n.tabId}${n.closed ? ' (이미 닫힘)' : ''}`),
        ...blocked.map((b) => `막힌 새 창: ${b.url || '(주소 없음)'}`),
        ...(state.dialog ? [`사이트 확인 창: "${state.dialog.message.slice(0, 120)}"`] : []),
        ...((dialogNotes.get(tabId)?.length ?? 0) > notesBefore ? ['사이트 알림창이 떴다 닫혔어요'] : []),
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
      // 표시마다 그 자리만 잘라 찍는다 (그림 숫자 키패드: 버튼마다 따로 보여 AI가 숫자를 읽게).
      // 표시마다 보이게 굴린 뒤 찍고, 표시마다 됐는지(status) 알린다. 굴려도 화면 밖(아래에 고정된 키패드)일 때만
      // 화면 높이를 잠깐 늘린다 (실측 11-20 쿠팡 키패드가 창 아래로 잘려 회색 그림만 찍혔다)
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
      // 먼저 모두 잰다. 화면 아래로 잘린 것이 있으면 가장 아래 것까지 보이게 한 번만 늘리고 다시 잰다
      // (예전에는 처음 잘린 버튼 높이까지만 늘려, 그 아래 줄 키패드 버튼은 여전히 화면 밖이라 못 찍었다 — 실측 결제 창 키패드)
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
        // clip은 문서 기준: 굴린 만큼 더한다 (scrollOffset)
        const o = await scrollOffset(tabId, 'layout')
        const shot = await cdp<{ data: string }>(tabId, 'Page.captureScreenshot', {
          format: 'jpeg',
          quality: 85,
          clip: { x: Math.max(0, m.x) + o.x, y: Math.max(0, m.y) + o.y, width: m.w, height: m.h, scale: 2 },
        }).catch(() => undefined)
        status.push({ ref, status: shot ? 'ok' : 'offscreen' })
        // rect: 보이는 화면 기준 자리 (그림 눌러 풀기에서 폰이 누른 곳을 화면 좌표로 바꾼다)
        if (shot) shots.push({ ref, data: shot.data, rect: { x: m.x, y: m.y, w: m.w, h: m.h } })
      }
      // 표시가 없는 그림(로봇 확인 그림·캔버스): AI가 화면 사진에서 짚은 상자 (보이는 화면 기준 0~1000)
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
      // taller: 화면 아래로 잘려 높이를 잠깐 늘려 찍었다 (다시 읽을 때 자리가 원래대로라는 것을 알린다)
      return { shots, status, ...(tall ? { taller: true } : {}) }
    }
    case 'captcha-candidates': {
      // 보안문자 칸 둘레를 몇 장 잘라 돌려준다. 어느 그림이 보안문자인지는 AI가 보고 고른다
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      if (typeof a.ref !== 'string') throw new Error('칸 표시(ref)가 필요해요')
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
      // clip은 문서 기준: 굴린 만큼 더한다
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
    case 'screenshot': {
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      // 원격 화면: 폰 화면 크기로 그리게 한다 (모바일 화면으로 다시 그려져 폰에 꽉 차고, 누른 자리가 그대로 맞는다).
      // 폰이 화면을 그만 부탁하면 디버거가 떨어지면서 원래 크기로 돌아온다
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
      // 레티나 화면이면 2배로 찍혀 AI가 읽기에 너무 크다. 보이는 영역만, 가로 1280px(원격 화면은 더 작게) 이하로 줄인다
      const v = await inPage(tabId, pageViewport)
      const maxWidth = Math.min(Math.max(Number(a.maxWidth) || 1280, 320), 1280)
      const quality = Math.min(Math.max(Number(a.quality) || 60, 30), 80)
      // 원격 화면은 폰에서 또렷하게 2배까지 찍는다
      const scale =
        (fit ? Math.min(v.dpr, maxWidth / v.width) : Math.min(a.remote ? 2 : 1, maxWidth / v.width)) / v.dpr
      // 폰 크기로 그리는 중이면(view·fit) 화면에 보이는 그대로 찍는다 (넓은 페이지는 폰처럼 줄어 보인다).
      // 그때 누르는 자리는 보이는 화면 기준이라 viewport도 그 크기로 알려 준다
      const phone = Boolean(a.remote) && (phoneView.has(tabId) || emulated.has(tabId))
      // clip은 문서 기준: 지금 보이는 곳을 찍으려면 굴린 만큼 더한다 (예전엔 0,0이라 굴린 페이지의 위쪽이 찍혔다)
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
      // 원격 화면(폰)에서 사람이 하는 입력. 좌표는 CSS 픽셀 (본체가 사진 비율을 바꿔 준다)
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
          throw new Error('화면 밖을 눌렀어요')
        // 창이 보이면 진짜 마우스로(보이는 화면 기준 자리), 가려져 있으면 그 자리의 요소를 누른다 (가려진 창은 마우스 입력을 버린다)
        if (!v.hidden) await clickAt(tabId, x, y)
        else if (phoneView.has(tabId))
          await inPage(tabId, pageTapAt, v.vv.x + x / v.vv.scale, v.vv.y + y / v.vv.scale)
        else await inPage(tabId, pageTapAt, x, y)
        // 입력칸을 눌렀으면 커서를 끝으로 (폰에서 이어 쓰고 지우기 좋게)
        await inPage(tabId, pageCaretEnd).catch(() => {})
      } else if (a.action === 'view') {
        // 폰 너비로 그리기: 사이트가 폰 화면으로 보여 주어 글씨가 제 크기다
        const width = Math.round(Math.min(Math.max(Number(a.w) || 390, 320), 520))
        const height = Math.round(Math.min(Math.max(Number(a.h) || 700, 360), 1100))
        await phoneWidth(tabId, width, height)
        await widenIfCut(tabId)
        return pageState(tabId)
      } else if (a.action === 'leave') {
        await leavePhoneView(tabId)
        return pageState(tabId)
      } else if (a.action === 'text') {
        if (typeof a.text !== 'string' || !a.text) throw new Error('넣을 글자가 없어요')
        await cdp(tabId, 'Input.insertText', { text: a.text.slice(0, 500) })
      } else if (a.action === 'key') {
        const key = String(a.key ?? '')
        if (!['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp'].includes(key))
          throw new Error(`이 키는 원격으로 누를 수 없어요: ${key}`)
        await pressKey(tabId, key)
      } else if (a.action === 'scroll') {
        const dy = Number(a.dy) || 0
        if (Math.abs(dy) <= 1) await inPage(tabId, pageScroll, dy < 0 ? -1 : 1)
        else {
          // 손가락으로 끈 만큼: 그 자리에서 휠을 굴려 안쪽 상자도 같이 내려간다
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
      } else throw new Error('모르는 원격 입력이에요')
      await settle(tabId, before)
      // 누른 뒤 PC용 창(간편인증 등)이 떴거나 다른 화면으로 넘어갔으면 폰 너비가 맞는지 다시 잰다
      if (a.action === 'tap') await refitAfterTap(tabId, before)
      return pageState(tabId)
    }
    case 'form': {
      // 원격 화면 '필요한 칸만': 칸·고를 것·버튼을 뽑고, 보안문자 그림은 잘라 붙인다
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      let form: Awaited<ReturnType<typeof pageForm>> & { frame?: string } = await inPage(
        tabId,
        pageForm,
        false,
      )
      formFrames.delete(tabId)
      // 가운데를 덮은 창이 액자면(정부24 간편인증) 그 액자 안의 칸을 뽑는다. 표시에 액자 번호를 붙여 채울 때 그 액자로 보낸다
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
      // 액자 안 칸(표시 앞에 액자 번호)이면 그 액자에서 찾고, 자리는 액자 상자만큼 옮긴다
      const fr = formFrames.get(tabId)
      // 자리를 못 재면 액자 안에서 그 자리를 누른다 (엉뚱한 곳을 진짜 마우스로 누르지 않게)
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
        // 가려진 창이면 액자 안에서 그 자리를 누른다(lx·ly는 액자 기준 그대로)
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
            // 눌렀는데 그대로면 같은 줄의 글자를 누른다 (칸을 덮어 둔 화면)
            const w = where(id)
            await inFrame(tabId, w.frameId, pageFormCheckFix, w.id, it.checked).catch(() => undefined)
          }
        } else if (typeof it.value === 'string') {
          // 진짜 키 입력처럼: 칸을 비우고(전체 선택) 새 글자를 넣는다
          const w = where(id)
          if (!(await inFrame(tabId, w.frameId, pageFormFocus, w.id))) continue
          if (it.value) {
            const text = it.value.slice(0, 200)
            await cdp(tabId, 'Input.insertText', { text })
            // 한 번에 넣기를 받지 않는 칸(보안문자·본인확인 칸): 하나도 안 들어갔으면 키를 하나씩 누른다
            // (실측: 폰 '필요한 칸만'에서 넣었는데 PC 칸은 비어 있었다)
            let n = (await inFrame(tabId, w.frameId, pageActiveValueLength).catch(() => -1)) as number
            // 늦게 반영하는 칸: 잠깐 뒤 다시 보고, 그래도 비었을 때만 다시 골라 키를 하나씩 (두 번 들어가지 않게)
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
        if (!t.ok) throw new Error('누를 버튼을 찾지 못했어요. 화면이 바뀌었을 수 있어요')
        await tapIn(t)
      }
      await settle(tabId, before)
      return pageState(tabId)
    }
    case 'back': {
      const tabId = await ownedTab(a)
      await chrome.tabs.goBack(tabId).catch(() => {
        throw new Error('뒤로 갈 페이지가 없어요')
      })
      await sleep(200)
      await waitLoad(tabId)
      return pageState(tabId)
    }
    case 'focus': {
      // 사람에게 넘길 때: 두리 창과 탭을 앞으로
      const tabId = await ownedTab(a, false)
      await leavePhoneView(tabId)
      const t = await chrome.tabs.update(tabId, { active: true })
      if (t?.windowId !== undefined)
        await chrome.windows.update(t.windowId, { focused: true, drawAttention: true })
      await detach(tabId)
      return pageState(tabId)
    }
    case 'hold': {
      // 사람·승인을 기다리는 탭: 이 시간 동안 정리(잠재우기·닫기)하지 않는다. 오래 잡지 않게 많아야 1시간
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
  throw new Error(`모르는 명령이에요: ${String(cmd)}`)
}

// ── PC 파일 올리기 (browser_upload) ──
// 해도 되는지는 본체가 정한다(승인). 손은 넣기만 한다:
// ① 파일 칸을 찾으면 Chrome DevTools(DOM.setFileInputFiles)로 경로를 그대로 넣는다 (큰 영상도 빠르다. 다른 주소 액자는 ③)
// ② 칸이 없으면(누를 때 칸을 만드는 사이트) 파일 고르기 창을 가로채고(Page.setInterceptFileChooserDialog) 버튼을 누른다.
//    PC에 파일 고르기 창이 뜨지 않는다
// ③ 확장에 파일 접근이 꺼져 있으면 Chrome이 ①을 막는다("Not allowed"): 본체가 보낸 조각을 페이지 안에서 파일로 만들어 넣는다

/** 조각을 기다리는 올리기: 표시 → 넣을 곳 (액자 안 칸이면 frameId, 고르기 창으로 잡은 칸이면 페이지 공간 objectId) */
const uploads = new Map<string, { tabId: number; frameId: number; objectId?: string; at: number }>()
/** 탭마다 가로챈 파일 고르기 창을 기다리는 쪽 */
const choosers = new Map<number, (p: { backendNodeId: number; mode: string }) => void>()

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Page.fileChooserOpened' || source.tabId === undefined) return
  choosers.get(source.tabId)?.(params as { backendNodeId: number; mode: string })
})

/** 페이지 공간에서 그 요소를 this로 함수 부르기 (값으로 돌려받는다) */
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
    throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? '페이지에서 오류가 났어요')
  return r.result?.value as R
}

/** 표시(data-dool2-up)를 단 칸의 DevTools 번호. 같은 프로세스의 액자까지 찾는다 (다른 주소 액자는 못 찾는다) */
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
  // 조각 받기·끝내기 (③)
  if (typeof a.token === 'string') {
    const u = uploads.get(a.token)
    if (!u || u.tabId !== tabId) throw new Error('올리던 파일 칸을 잊었어요. 다시 올려 주세요')
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
    throw new Error('조각(part)이나 끝내기(finish)가 없어요')
  }
  const ref = String(a.ref ?? '')
  if (!/^e\d+$/.test(ref)) throw new Error('ref는 e12 같은 표시여야 해요')
  const paths = (Array.isArray(a.paths) ? a.paths : []).map(String).filter(Boolean)
  if (!paths.length) throw new Error('올릴 파일이 없어요')
  for (const [k, v] of uploads) if (Date.now() - v.at > 10 * 60_000) uploads.delete(k)
  const f = frameOf(tabId, ref)
  const token = crypto.randomUUID()
  // 그 칸·라벨이 가리키는 칸·안에 든 칸 하나: 틀릴 일이 없어 바로 넣는다
  const t = await inFrame(tabId, f.frameId, pageUploadTarget, ref, token, false)
  if (!t?.ok) throw new Error(t?.error ?? '파일 칸을 찾지 못했어요')
  // viaPage: 시험용 — 경로 넣기(①)를 건너뛰고 조각 받기(③)로 (파일 접근이 꺼진 확장과 같은 길)
  const viaPage = a.viaPage === true
  if (t.how !== 'none') return uploadInto(tabId, f.frameId, token, t, paths, viaPage)
  // 버튼: 눌러서 사이트가 여는 파일 고르기 창을 가로챈다 (그 사이트가 고른 칸이 맞는 칸이다)
  let clickError = ''
  const chosen = await uploadByChooser(tabId, ref, token, paths, viaPage, (e) => {
    clickError = e
  })
  if (chosen) return chosen
  // 창이 안 떴으면 버튼 가까이(몇 단계 위 상자)에 하나뿐인 파일 칸
  const near = await inFrame(tabId, f.frameId, pageUploadTarget, ref, token, true)
  if (near?.ok && near.how !== 'none') return uploadInto(tabId, f.frameId, token, near, paths, viaPage)
  throw new Error(
    `${clickError ? `${clickError} — ` : ''}눌러도 파일 고르기 창이 뜨지 않았어요. 화면을 다시 읽어 [사진 추가]·[파일 선택]·[내 PC]·[업로드] 같은 버튼이나 파일 칸을 찾아 그것으로 다시 올려 주세요(먼저 메뉴·창을 열어야 할 수도 있어요)`,
  )
}

/** 찾은 파일 칸에 넣는다: ① 경로를 그대로, 안 되면 ③ 조각으로 받겠다고 알린다 */
async function uploadInto(
  tabId: number,
  frameId: number,
  token: string,
  t: { how: string; accept: string; multiple: boolean; disabled: boolean },
  paths: string[],
  viaPage = false,
): Promise<unknown> {
  if (t.disabled)
    throw new Error('파일 칸이 꺼져(비활성) 있어요. 화면에서 먼저 할 일(종류 고르기 등)이 있는지 읽어 보세요')
  if (!t.multiple && paths.length > 1)
    throw new Error('이 칸은 파일을 하나만 받아요. 한 개씩 나눠 올려 주세요')
  let why = viaPage ? '조각으로 (시험)' : ''
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
  } else if (!why) why = '다른 주소 액자 속 칸'
  uploads.set(token, { tabId, frameId, at: Date.now() })
  return { needBytes: true, token, found: t.how, accept: t.accept, multiple: t.multiple, why }
}

/**
 * 버튼을 눌러 뜨는 파일 고르기 창을 가로채 넣는다 (PC에는 창이 뜨지 않는다). 창이 안 뜨면 undefined.
 * 누르기가 실패하면 그 까닭을 onClickError로 알리고 undefined (부르는 쪽이 둘레 칸을 찾아본다)
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
    // 콜백이 채우는 칸 (변수로 두면 타입 좁히기가 콜백에서 채운 것을 모른다)
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
      throw new Error('이 칸은 파일을 하나만 받아요. 한 개씩 나눠 올려 주세요')
    let why = viaPage ? '조각으로 (시험)' : ''
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
    if (!object.objectId) throw new Error('파일 칸을 찾지 못했어요. 다시 읽어 주세요')
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
