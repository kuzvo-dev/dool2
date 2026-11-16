// 두리 확장 서비스 워커. 판단 없는 얇은 손이다 (ADR 0006, docs/architecture.md 5.1).
// - 두리 본체가 시킨 일만 한다. 무엇이 위험한지, 해도 되는지는 본체(승인 게이트)가 정한다
// - 두리가 연 탭만 다룬다. 사용자가 연 탭은 건드리지 않는다
// - 클릭·입력은 chrome.debugger(CDP Input)로 실제 입력과 같게 넣는다
import type { BridgeRequest, BrowserCommand } from '@dool2/protocol'
import { keyDef, safeUrl } from './keys.js'
import {
  type LocateMode,
  type LocateResult,
  pageClick,
  pageLocate,
  pageMarkFilled,
  pageScroll,
  pageSnapshot,
  pageTapAt,
  pageViewport,
} from './page.js'

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
  run(req.cmd, req.args ?? {}).then(
    (result) => p.postMessage({ id: req.id, ok: true, result }),
    (e: Error) => p.postMessage({ id: req.id, ok: false, error: e.message || String(e) }),
  )
}

// 서비스 워커는 쉬면 꺼진다. 연결이 살아 있으면 Chrome이 깨워 두고, 끊기면 30초마다 다시 붙는다
chrome.alarms.create('dool2-reconnect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'dool2-reconnect') connect()
})
chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
connect()

// 팝업: 연결 상태 보기, 다시 연결
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return
  if (msg?.type === 'retry') connect()
  reply({ ...status, connected: Boolean(port) && status.state !== 'off' })
})

// ── 두리 탭 ──────────────────────────────────────────────────

interface Saved {
  windowId?: number
  owned: number[]
  groupId?: number
}
async function load(): Promise<Saved> {
  const s = (await chrome.storage.session.get('dool2')).dool2 as Saved | undefined
  return s ?? { owned: [] }
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

async function ownedTab(args: Record<string, unknown>): Promise<number> {
  const tabId = Number(args.tabId)
  const s = await load()
  if (!Number.isInteger(tabId) || !s.owned.includes(tabId))
    throw new Error('두리가 연 탭이 아니에요. 사용자가 연 탭은 다루지 않아요')
  try {
    await chrome.tabs.get(tabId)
  } catch {
    throw new Error('탭이 닫혔어요')
  }
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
  await groupTab(id)
  return tab
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
    await chrome.tabGroups.update(groupId, { title: '두리', color: 'green' })
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
  frameMaps.delete(tabId)
  attached.delete(tabId)
  port?.postMessage({ event: 'tab-closed', tabId })
})

async function waitLoad(tabId: number, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const t = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!t) throw new Error('탭이 닫혔어요')
    if (t.status === 'complete') return t
    await sleep(200)
  }
  return chrome.tabs.get(tabId)
}

/** 입력 뒤 화면이 바뀌기를 잠깐(최대 1.2초) 기다린다. 이동이 시작됐으면 끝날 때까지 */
async function settle(tabId: number, before?: string) {
  for (let i = 0; i < 12; i++) {
    await sleep(100)
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
  clearTimeout(attached.get(source.tabId))
  attached.delete(source.tabId)
  emulated.delete(source.tabId)
  // 사용자가 "취소"를 눌렀다면 그 탭은 더 이상 다루지 않는다
  if (reason === 'canceled_by_user') stoppedByUser.add(source.tabId)
})

async function cdp<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  if (stoppedByUser.has(tabId)) throw new Error('사용자가 이 탭의 두리 제어를 멈췄어요')
  if (!attached.has(tabId)) await chrome.debugger.attach({ tabId }, '1.3')
  // 한동안 안 쓰면 뗀다 (브라우저 위 "제어 중" 막대가 계속 떠 있지 않게)
  clearTimeout(attached.get(tabId))
  attached.set(
    tabId,
    setTimeout(() => {
      attached.delete(tabId)
      chrome.debugger.detach({ tabId }).catch(() => {})
    }, DEBUGGER_IDLE_MS),
  )
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T
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
  const target = frameId ? { tabId, frameIds: [frameId] } : { tabId }
  const [res] = await chrome.scripting.executeScript({ target, world: 'ISOLATED', func, args })
  return res?.result as R
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

/** 액자가 페이지 화면의 어디에 있는지 (CDP: 액자 주인 요소의 상자) */
async function frameOffset(tabId: number, url: string): Promise<{ x: number; y: number }> {
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

async function clickAt(tabId: number, x: number, y: number) {
  const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' }
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
  return { tabId, url: t.url ?? '', title: t.title ?? '' }
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
    case 'open': {
      const url = safeUrl(a.url)
      if (!url) throw new Error('http·https 주소만 열 수 있어요')
      const tab = await openTab(url)
      if (tab.id === undefined) throw new Error('탭을 열지 못했어요')
      await waitLoad(tab.id)
      return pageState(tab.id)
    }
    case 'navigate': {
      const tabId = await ownedTab(a)
      const url = safeUrl(a.url)
      if (!url) throw new Error('http·https 주소만 열 수 있어요')
      await chrome.tabs.update(tabId, { url })
      await sleep(200)
      await waitLoad(tabId)
      return pageState(tabId)
    }
    case 'snapshot': {
      const tabId = await ownedTab(a)
      await waitLoad(tabId, 10_000)
      const max = Math.min(Math.max(Number(a.maxChars) || 12_000, 1_000), 40_000)
      const main = await inPage(tabId, pageSnapshot, max, 0)
      // 화면 안 액자(로그인 창 등): 누를 것이 있는 액자만 아래에 붙인다
      const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? []
      const map = new Map<number, { frameId: number; url: string }>()
      let text = main.text
      let captcha = main.captcha
      let index = 0
      for (const fr of frames) {
        if (fr.frameId === 0 || !/^https?:/.test(fr.url) || index >= 6) continue
        index++
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
      return { tabId, ...main, text: text.slice(0, max + Math.floor(max / 2)), captcha }
    }
    case 'click': {
      const tabId = await ownedTab(a)
      const at = await locate(tabId, a.ref, 'point')
      lastPopup = undefined
      const before = (await chrome.tabs.get(tabId)).url
      let via: 'mouse' | 'key' | 'script' = 'mouse'
      if (!at.hidden) await clickAt(tabId, at.x, at.y)
      else {
        // 두리 창이 가려져 있거나 화면이 꺼져 있으면 Chrome이 마우스 입력을 버린다 (키보드는 받는다, 실측).
        // 그래서 요소에 초점을 주고 Enter·Space로 누른다. 브라우저가 만드는 진짜 클릭이라 사이트가 보기에도 같다
        const act = await locate(tabId, a.ref, 'activate')
        if (!act.focused) {
          // 키보드로 누를 수 없는 요소(초점을 못 받는 div 등)는 마지막 수단으로 페이지 안에서 누른다
          via = 'script'
          await inFrame(tabId, frameOf(tabId, String(a.ref)).frameId, pageClick, String(a.ref))
        } else {
          via = 'key'
          await pressKey(tabId, act.toggle ? 'Space' : 'Enter')
        }
      }
      await settle(tabId, before)
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
      await cdp(tabId, 'Input.insertText', { text: a.text })
      if (a.submit) {
        const before = (await chrome.tabs.get(tabId)).url
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
      if (inFrameRef && !at.hidden) await clickAt(tabId, at.x, at.y)
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
      // 원격 화면(fit)은 폰이 선명하게 보도록 화면 배율(2배)까지 그대로 찍는다
      const scale = (fit ? Math.min(v.dpr, maxWidth / v.width) : Math.min(1, maxWidth / v.width)) / v.dpr
      const shot = await cdp<{ data: string }>(tabId, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality,
        optimizeForSpeed: true,
        clip: { x: 0, y: 0, width: v.width, height: v.height, scale },
      })
      return {
        ...(await pageState(tabId)),
        mime: 'image/jpeg',
        data: shot.data,
        viewport: { width: v.width, height: v.height },
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
        if (!(x >= 0 && y >= 0 && x <= v.width && y <= v.height)) throw new Error('화면 밖을 눌렀어요')
        // 창이 보이면 진짜 마우스로, 가려져 있으면 그 자리의 요소를 누른다 (가려진 창은 마우스 입력을 버린다)
        if (!v.hidden) await clickAt(tabId, x, y)
        else await inPage(tabId, pageTapAt, x, y)
      } else if (a.action === 'text') {
        if (typeof a.text !== 'string' || !a.text) throw new Error('넣을 글자가 없어요')
        await cdp(tabId, 'Input.insertText', { text: a.text.slice(0, 500) })
      } else if (a.action === 'key') {
        const key = String(a.key ?? '')
        if (!['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp'].includes(key))
          throw new Error(`이 키는 원격으로 누를 수 없어요: ${key}`)
        await pressKey(tabId, key)
      } else if (a.action === 'scroll') {
        await inPage(tabId, pageScroll, Number(a.dy) < 0 ? -1 : 1)
      } else throw new Error('모르는 원격 입력이에요')
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
      const tabId = await ownedTab(a)
      const t = await chrome.tabs.update(tabId, { active: true })
      if (t?.windowId !== undefined)
        await chrome.windows.update(t.windowId, { focused: true, drawAttention: true })
      await detach(tabId)
      return pageState(tabId)
    }
    case 'close': {
      const tabId = await ownedTab(a)
      await detach(tabId)
      await chrome.tabs.remove(tabId)
      return { tabId, closed: true }
    }
  }
  throw new Error(`모르는 명령이에요: ${String(cmd)}`)
}
