// 두리 확장 서비스 워커. 판단 없는 얇은 손이다 (ADR 0006, docs/architecture.md 5.1).
// - 두리 본체가 시킨 일만 한다. 무엇이 위험한지, 해도 되는지는 본체(승인 게이트)가 정한다
// - 두리가 연 탭만 다룬다. 사용자가 연 탭은 건드리지 않는다
// - 클릭·입력은 chrome.debugger(CDP Input)로 실제 입력과 같게 넣는다
import type { BridgeRequest, BrowserCommand } from '@dool2/protocol'
import { keyDef, pickPath, safeUrl } from './keys.js'
import {
  type ExtractSpec,
  type LocateMode,
  type LocateResult,
  pageCaretEnd,
  pageClick,
  pageCursor,
  pageCutOff,
  pageExtract,
  pageFind,
  pageForm,
  pageFormFocus,
  pageFormTarget,
  pageFrameBox,
  pageLocate,
  pageMarkFilled,
  pageMarkTaps,
  pageMarkText,
  pageRemoteInfo,
  pageScroll,
  pageScrollBy,
  pageSnapshot,
  pageTapAt,
  pageViewport,
  type ReadScope,
} from './page.js'
import { tidyPlan } from './tidy.js'

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
  if (!Number.isInteger(tabId) || !s.owned.includes(tabId))
    throw new Error('두리가 연 탭이 아니에요. 사용자가 연 탭은 다루지 않아요')
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
    for (const id of s.owned) {
      const t = await chrome.tabs.get(id).catch(() => undefined)
      if (!t) continue
      // 서비스 워커가 다시 깨어나 기록이 없으면 지금 쓴 것으로 본다 (깨자마자 몽땅 닫지 않게)
      const at = usedAt.get(id) ?? s.used?.[id] ?? now
      usedAt.set(id, at)
      tabs.push({
        id,
        usedAt: at,
        keep: id === fresh || phoneView.has(id) || emulated.has(id),
        discarded: Boolean(t.discarded),
        active: Boolean(t.active),
      })
    }
    const plan = tidyPlan(tabs, now)
    for (const id of plan.close) {
      await detach(id)
      await chrome.tabs.remove(id).catch(() => undefined)
    }
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

// 두리 탭에서 새 탭이 열리면(새 창 링크) 그것도 두리 탭으로 본다
let lastPopup: { opener: number; tabId: number } | undefined
async function adopt(opener: number, tabId: number) {
  let took = false
  await update((s) => {
    if (!s.owned.includes(opener) || s.owned.includes(tabId)) return
    s.owned.push(tabId)
    took = true
  })
  if (!took) return
  lastPopup = { opener, tabId }
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
  })
  if (!had) return
  usedAt.delete(tabId)
  frameMaps.delete(tabId)
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

/** 입력 뒤 화면이 바뀌기를 잠깐(최대 1.2초) 기다린다. 이동이 시작됐으면 끝날 때까지 */
async function settle(tabId: number, before?: string) {
  for (let i = 0; i < 12; i++) {
    await sleep(100)
    // 확인 창이 뜨면 화면은 더 바뀌지 않는다 (고를 때까지 멈춰 있다)
    if (dialogs.has(tabId)) return
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
  // 같은 알림창이 한 번에 여러 번 알려질 때가 있다 (실측): 한 번만 남긴다
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
  // 그리지 못하는 화면(가상 화면·잠든 창)에서는 답이 오지 않을 수 있다: 오래 기다리지 않는다
  await Promise.race([
    cdp(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 10,
      clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
    }).catch(() => {}),
    sleep(1500),
  ])
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

/** React·Vue 클릭 처리기만 붙은 상자에 표시 달기 (페이지 스크립트 공간에서만 보인다). 실패해도 화면 읽기는 계속한다 */
async function markTaps(tabId: number, frameId: number) {
  const target = frameId ? { tabId, frameIds: [frameId] } : { tabId }
  await chrome.scripting.executeScript({ target, world: 'MAIN', func: pageMarkTaps }).catch(() => {})
}

// ── 화면 안 액자 (iframe): 로그인 칸을 액자 안에 두는 사이트 (아고다 등) ──
/** 액자 하나의 표시 번호 대역 (액자 n → e{n*10000+1}…) */
const FRAME_SPAN = 10_000
/** 탭마다: 표시 대역 번호 → 확장 frameId·주소 (마지막으로 읽은 화면 기준) */
const frameMaps = new Map<number, Map<number, { frameId: number; url: string }>>()

/** 표시(e10012)가 어느 액자의 것인지 */
function frameOf(tabId: number, ref: string): { frameId: number; url?: string; index: number } {
  const n = Number(ref.slice(1))
  const index = Math.floor(n / FRAME_SPAN)
  if (!index) return { frameId: 0, index: 0 }
  const f = frameMaps.get(tabId)?.get(index)
  if (!f) throw new Error(`${ref}를 찾을 수 없어요. 화면을 다시 읽어 주세요`)
  return { frameId: f.frameId, url: f.url, index }
}

/** 액자가 페이지 화면의 어디에 있는지. 먼저 페이지에서 그 주소의 액자 상자를 재고, 못 찾으면 CDP로 */
async function frameOffset(tabId: number, url: string): Promise<{ x: number; y: number }> {
  const box = await inPage(tabId, pageFrameBox, url).catch(() => undefined)
  if (box) return box
  return frameOffsetCdp(tabId, url)
}

/** CDP: 액자 주인 요소의 상자 (같은 주소의 액자) */
async function frameOffsetCdp(tabId: number, url: string): Promise<{ x: number; y: number }> {
  type Tree = { frame: { id: string; url: string }; childFrames?: Tree[] }
  const tree = (await cdp(tabId, 'Page.getFrameTree', {})) as { frameTree: Tree }
  const all: Tree[] = []
  const walk = (t: Tree) => {
    all.push(t)
    for (const c of t.childFrames ?? []) walk(c)
  }
  walk(tree.frameTree)
  const hit =
    all.find((t) => t !== tree.frameTree && t.frame.url === url) ??
    all.find((t) => t !== tree.frameTree && url.startsWith(t.frame.url))
  if (!hit) return { x: 0, y: 0 }
  const owner = (await cdp(tabId, 'DOM.getFrameOwner', { frameId: hit.frame.id })) as {
    backendNodeId: number
  }
  const box = (await cdp(tabId, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId })) as {
    model: { content: number[] }
  }
  return { x: box.model.content[0] ?? 0, y: box.model.content[1] ?? 0 }
}

/** 같은 사이트인지 (www.agoda.com ↔ accounts.agoda.com, shop.co.kr ↔ login.shop.co.kr) */
function siteOf(origin: string): string {
  try {
    const parts = new URL(origin).hostname.split('.')
    const sld = parts.at(-2) ?? ''
    const keep =
      parts.length > 2 &&
      /^(co|or|go|ac|ne|re|pe|com|net|org)$/.test(sld) &&
      (parts.at(-1)?.length ?? 0) === 2
        ? 3
        : 2
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

async function locate(tabId: number, ref: unknown, mode: LocateMode): Promise<LocateResult> {
  if (typeof ref !== 'string' || !/^e\d+$/.test(ref)) throw new Error('ref는 e12 같은 표시여야 해요')
  await frontTab(tabId)
  const f = frameOf(tabId, ref)
  const r = await inFrame(tabId, f.frameId, pageLocate, ref, mode)
  if (!r?.ok) throw new Error(r?.error ?? '요소를 찾지 못했어요')
  if (!f.frameId || !f.url) return r
  // 액자 안 좌표 → 페이지 화면 좌표
  const off = await frameOffset(tabId, f.url).catch(() => ({ x: 0, y: 0 }))
  return { ...r, x: r.x + off.x, y: r.y + off.y, frame: true }
}

// ── 마우스 움직임 ──
// 사람처럼 마우스를 목표까지 옮긴 뒤 누른다. 움직임 없이 바로 누르면 올려 두어야 열리는 메뉴가 안 열리고,
// 마우스가 들어온 적 없는 버튼을 누르는 셈이라 사이트가 사람 입력이 아니라고 볼 수 있다
/** 탭마다 마지막 마우스 자리 */
const pointer = new Map<number, { x: number; y: number }>()

async function moveMouse(tabId: number, x: number, y: number) {
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
  await paint(tabId)
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
  // 클릭으로 새 탭이 앞으로 오면 이 탭은 뒤로 가서 그려지지 않고, 입력 확인 답이 몇 초씩 늦는다. 오래 기다리지 않는다
  await Promise.race([
    cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }),
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

async function pageState(tabId: number) {
  const t = await chrome.tabs.get(tabId)
  const open = dialogs.get(tabId)
  return { tabId, url: t.url ?? '', title: t.title ?? '', ...(open ? { dialog: open } : {}) }
}

/** 클릭 동안 새 탭이 열렸으면 알려 준다 */
function takePopup(opener: number) {
  if (lastPopup?.opener !== opener) return {}
  const tabId = lastPopup.tabId
  lastPopup = undefined
  return { newTabId: tabId }
}

// ── 명령 ─────────────────────────────────────────────────────

async function run(cmd: BrowserCommand, a: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case 'mark-text': {
      // 글자로 누를 곳에 표시를 붙인다 (그 뒤 보통 click으로 누른다)
      const tabId = await ownedTab(a)
      const r = await inPage(tabId, pageMarkText, String(a.text ?? ''))
      if (!r.ok) throw new Error(r.error)
      return r
    }
    case 'extract': {
      // 커넥터: 화면 목록을 칸별로 뽑는다 (읽기만)
      const tabId = await ownedTab(a)
      await waitLoad(tabId, 10_000)
      if (attached.has(tabId)) await paint(tabId)
      const r = await inPage(tabId, pageExtract, a.spec as ExtractSpec)
      if (!r.ok) throw new Error(r.error)
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
      const until = Date.now() + Math.min(Math.max(Number(a.timeoutMs) || 10_000, 500), 30_000)
      for (;;) {
        const hit = (netLog.get(tabId) ?? []).filter((e) => e.done && re.test(e.url)).at(-1)
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
          return { url: hit.url, status: hit.status, json: pickPath(data, path) ?? null }
        }
        if (Date.now() > until) throw new Error(`페이지가 그 데이터를 받지 않았어요 (${String(a.url)})`)
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
      // 화면 안 액자(로그인 창 등): 누를 것이 있는 액자만 아래에 붙인다
      const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? []
      const map = new Map<number, { frameId: number; url: string }>()
      let text = main.text
      let captcha = main.captcha
      let index = 0
      for (const fr of frames) {
        if (fr.frameId === 0 || !/^https?:/.test(fr.url) || index >= 6) continue
        index++
        await markTaps(tabId, fr.frameId)
        const r = await inFrame(
          tabId,
          fr.frameId,
          pageSnapshot,
          Math.floor(max / 2),
          index * FRAME_SPAN,
        ).catch(() => undefined)
        if (!r) continue
        captcha ||= r.captcha
        if (!/\[e\d+ /.test(r.text)) continue
        map.set(index, { frameId: fr.frameId, url: fr.url })
        text += `\n## 화면 안 액자 (${new URL(fr.url).hostname})\n${r.text}`
      }
      frameMaps.set(tabId, map)
      return {
        tabId,
        ...main,
        text: text.slice(0, max + Math.floor(max / 2)),
        captcha,
        ...takeDialogs(tabId),
      }
    }
    case 'click': {
      const tabId = await ownedTab(a)
      let at = await locate(tabId, a.ref, 'point')
      // 굴려 옮겼으면 늦게 뜨는 그림·목록으로 자리가 밀리거나, 목록이 칸을 재활용해 다른 것을 그린다.
      // 잠깐 그리게 한 뒤 다시 잰다 (다른 것이 그려졌으면 locate가 "다시 읽어 주세요"로 멈춘다)
      if (at.moved) {
        await sleep(300)
        await paint(tabId)
        at = await locate(tabId, a.ref, 'point')
      }
      lastPopup = undefined
      const before = (await chrome.tabs.get(tabId)).url
      let via: 'mouse' | 'key' | 'script' = 'mouse'
      // 창이 일부 가려져 있으면 '보인다'고 나와도 Chrome이 마우스 입력을 버릴 때가 있다 (실측: 인증번호 확인 버튼).
      // 눌러도 화면이 하나도 안 바뀌었으면 아래 키보드 방식으로 한 번 더 누른다
      // 화면 변화: 주소·초점·체크된 칸 수·문서 크기 (마우스가 먹으면 적어도 초점이 버튼으로 간다).
      // 액자 속 요소는 그 액자 안에서 본다: 다른 주소 액자는 가려진 창에서 마우스를 못 받는데, 바깥 페이지 초점만
      // 액자로 옮겨 가서 눌린 것처럼 보였다 (실측)
      const markFrame = frameOf(tabId, String(a.ref)).frameId
      const mark = () =>
        inFrame(tabId, markFrame, () => {
          const f = document.activeElement
          return [
            location.href,
            f ? `${f.tagName}#${f.id}.${f.getAttribute('name') ?? ''}` : '',
            document.querySelectorAll(':checked').length,
            document.body?.getElementsByTagName('*').length ?? 0,
            document.body?.innerText.length ?? 0,
          ].join('|')
        }).catch(() => '')
      let mouseIgnored = false
      if (!at.hidden) {
        const sig = await mark()
        await clickAt(tabId, at.x, at.y, '두리가 누르는 중')
        await settle(tabId, before)
        mouseIgnored = sig !== '' && sig === (await mark())
      }
      // 켜고 끄는 칸(체크박스 등)은 다시 누르면 되돌아가니 마우스가 안 먹은 것처럼 보여도 다시 누르지 않는다
      const retry = mouseIgnored && !(await locate(tabId, a.ref, 'activate')).toggle
      if (at.hidden || retry) {
        // 두리 창이 가려져 있거나 화면이 꺼져 있으면 Chrome이 마우스 입력을 버린다 (키보드는 받는다, 실측).
        // 그래서 요소에 초점을 주고 Enter·Space로 누른다. 브라우저가 만드는 진짜 클릭이라 사이트가 보기에도 같다
        const act = await locate(tabId, a.ref, 'activate')
        if (!act.focused) {
          // 키보드로 누를 수 없는 요소(초점을 못 받는 div 등)는 마지막 수단으로 페이지 안에서 누른다
          via = 'script'
          await inFrame(tabId, frameOf(tabId, String(a.ref)).frameId, pageClick, String(a.ref))
        } else {
          via = 'key'
          const sig = await mark()
          await pressKey(tabId, act.toggle ? 'Space' : 'Enter')
          await settle(tabId, before)
          // 뒤에 가려진 창은 키도 안 먹을 때가 있다 (실측): 그래도 그대로면 페이지 안에서 누른다
          if (!act.toggle && sig !== '' && sig === (await mark())) {
            via = 'script'
            await inFrame(tabId, frameOf(tabId, String(a.ref)).frameId, pageClick, String(a.ref))
          }
        }
        await settle(tabId, before)
      }
      return {
        ...(await pageState(tabId)),
        via,
        ...takePopup(tabId),
        ...(at.coveredBy && !at.hidden ? { coveredBy: at.coveredBy } : {}),
      }
    }
    case 'type': {
      const tabId = await ownedTab(a)
      if (typeof a.text !== 'string') throw new Error('넣을 글자가 없어요')
      const at = await locate(tabId, a.ref, 'type')
      if (at.isPassword) throw new Error('비밀번호 칸에는 두리 금고로만 채워요')
      if (!at.hidden) await showCursor(tabId, at.x, at.y, '두리가 입력하는 중')
      await cdp(tabId, 'Input.insertText', { text: a.text })
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
      const ok = at.origin === a.origin || (inFrameRef && siteOf(at.origin) === siteOf(a.origin))
      if (!ok) throw new Error('지금 페이지 주소가 저장된 사이트와 달라서 채우지 않았어요')
      if (a.password && !at.isPassword) throw new Error('비밀번호 칸이 아니라서 채우지 않았어요')
      // 다른 주소의 액자는 스크립트 초점을 막는 경우가 있어, 칸을 한 번 눌러 초점을 준다
      if (inFrameRef && !at.hidden) await clickAt(tabId, at.x, at.y, '두리 금고로 채우는 중')
      else if (!at.hidden) await showCursor(tabId, at.x, at.y, '두리 금고로 채우는 중')
      await cdp(tabId, 'Input.insertText', { text: a.value })
      await inFrame(tabId, frameOf(tabId, String(a.ref)).frameId, pageMarkFilled, String(a.ref))
      return { tabId, filled: true }
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
      const tabId = await ownedTab(a)
      await frontTab(tabId)
      const v = await inPage(tabId, pageViewport)
      const dir = a.direction === 'up' ? -1 : 1
      if (v.hidden) {
        // 가려진 창은 마우스 휠을 받지 않는다. 스크롤은 사이트에 의미 있는 입력이 아니라서 페이지 안에서 옮긴다
        await inPage(tabId, pageScroll, dir)
      } else {
        const wheel = cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: v.width / 2,
          y: v.height / 2,
          deltaX: 0,
          deltaY: dir * Math.round(v.height * 0.8),
        })
        await Promise.race([wheel, sleep(1000)])
      }
      await sleep(300)
      return pageState(tabId)
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
            clip: { x: 0, y: 0, width: v.width, height: v.height, scale },
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
      const off = fr ? await frameOffset(tabId, fr.url).catch(() => ({ x: 0, y: 0 })) : { x: 0, y: 0 }
      const where = (id: string) => {
        const m = id.match(FORM_FRAME_ID)
        return m ? { frameId: Number(m[1]), id: m[2] as string } : { frameId: 0, id }
      }
      const target = async (raw: string) => {
        const w = where(raw)
        const t = await inFrame(tabId, w.frameId, pageFormTarget, w.id)
        if (!w.frameId || !t.ok || t.done) return t
        // 가려진 창이면 액자 안에서 그 자리를 누른다(lx·ly는 액자 기준 그대로)
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
          if (t.ok && !t.done && t.checked !== it.checked) await tapIn(t)
        } else if (typeof it.value === 'string') {
          // 진짜 키 입력처럼: 칸을 비우고(전체 선택) 새 글자를 넣는다
          const w = where(id)
          if (!(await inFrame(tabId, w.frameId, pageFormFocus, w.id))) continue
          if (it.value) await cdp(tabId, 'Input.insertText', { text: it.value.slice(0, 200) })
          else await pressKey(tabId, 'Backspace')
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
    case 'close': {
      const tabId = await ownedTab(a, false)
      await detach(tabId)
      await chrome.tabs.remove(tabId)
      return { tabId, closed: true }
    }
  }
  throw new Error(`모르는 명령이에요: ${String(cmd)}`)
}
