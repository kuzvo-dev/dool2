// 두리 폰 앱 (v2 디자인: docs/design/screens/soft). PC의 두리와 중계 서버를 거쳐 종단 간 암호화로 이야기한다 (ADR 0012).
// 화면: 연결(페어링) → 앱(대화 하나 · 맡긴 일 · 아이디어 · 연결) + 메뉴 서랍 · 두리 패널 · 승인/로그인 시트 · PC 화면
// 머리·탭·입력칸은 한 번만 만들고, 대화는 바뀐 말만 덧붙인다 (다시 그려도 깜빡이거나 스크롤이 튀지 않게).
import type {
  ApprovalRecordMessage,
  ApprovalView,
  ConnectRecordMessage,
  DaemonStreamEvent,
  HandoffRecord,
  InfoRequestView,
  LifeAction,
  LifeState,
  LoginRecordMessage,
  LoginRequestView,
  PairInvite,
  PcToPhone,
  PhoneToPc,
  StoredMessage,
} from '@dool2/protocol'
import { type ConnectionItem, SOCIAL_LABEL, type SocialProvider } from '@dool2/protocol/connect'
import { findCard } from '@dool2/protocol/connect-text'
import {
  type Envelope,
  fromB64u,
  generateDevice,
  LINK_VERSION,
  linkKey,
  open,
  pairCode,
  seal,
  signText,
} from '@dool2/protocol/e2e'
import {
  type IdeaItem,
  type IdeaSection,
  ideaCatalog,
  ideaCount,
  needsConnect,
  searchIdeas,
} from '@dool2/protocol/ideas'
import { approvalSignText, LinkClient } from '@dool2/protocol/link'
import { narrationLine, readAppNote, splitPhoto, toolLabel, withoutPhotoMark } from '@dool2/protocol/rich'
import { brandMark, SOCIAL_CTA } from './brands.js'
import { type ConnectCtx, connectionsView, serviceView } from './connections.js'
import {
  doori,
  emoTile,
  h,
  type IconName,
  icon,
  liveDoori,
  rich,
  segBtn,
  shortTime,
  withLogo,
} from './dom.js'
import {
  feedView,
  goalSheet,
  goalsView,
  itemSheet,
  type LifeCtx,
  libraryView,
  memorySeg,
  plain,
  upcomingSeg,
} from './life-views.js'
import {
  acceptGhost,
  drawCheck,
  gooFilter,
  holdButton,
  otpBoxes,
  playFlip,
  playSeg,
  riseIn,
  Spring,
  springTo,
  tick,
} from './motion.js'
import { rollNumbers, swipeDeck } from './motion-cards.js'
import { defaultRelay, inviteFrom, isNative, launchInvite, listenNative, scanQr } from './native.js'
import { createRemote, type RemoteScreen, type Shot } from './remote.js'
import { clear, load, type Saved, save } from './store.js'

const app = document.getElementById('app') as HTMLElement

// ── 상태 ──
/** 탭 막대 5칸 + 메뉴에서 여는 쪽(연결·설정) */
type Tab = 'chat' | 'feed' | 'ideas' | 'goals' | 'library' | 'connect' | 'settings'
type Screen =
  | { name: 'intro' }
  | { name: 'unsupported' }
  | { name: 'pairing'; code: string; pcName: string; rejected?: boolean }
  | { name: 'app' }
  | { name: 'remote'; tabId: number; connectId?: string }
  /** 따로 하는 대화 하나 */
  | { name: 'side'; id: string }
type Overlay =
  | { kind: 'drawer' }
  | { kind: 'agent' }
  | { kind: 'approval'; id: string }
  | { kind: 'login'; id: string }
  /** 로그인 중 화면이 묻는 것 (인증번호 등) */
  | { kind: 'info'; id: string }
  /** 서비스 연결하기: 아이디·비밀번호 → 두리가 대신 로그인 */
  | { kind: 'connect'; id: string }
  | { kind: 'goal'; id: string }
  | { kind: 'item'; id: string }
  /** 답을 길게 눌렀을 때: 보관함에 남기기·복사 */
  | { kind: 'msg'; id: string }
  /** 입력칸 + : 빠른 메뉴 */
  | { kind: 'plus' }
  | undefined

const st: {
  saved?: Saved
  key?: CryptoKey
  client?: LinkClient
  online: boolean
  /** 중계에는 붙었는데 PC가 답하지 않는다 (PC가 꺼졌거나, PC에서 이 폰 연결을 지웠다) */
  pcSilent: boolean
  screen: Screen
  tab: Tab
  overlay: Overlay
  pc?: Extract<PcToPhone, { kind: 'state' }>
  /** 대화 하나 */
  conv: StoredMessage[]
  convLoaded: boolean
  hasMore: boolean
  busy: boolean
  queued: string[]
  /** 지금 답에서 온 글자와 한 일 */
  live: string
  steps: string[]
  /** 보냈지만 PC가 아직 받았다고 하지 않은 말 (바로 화면에 띄운다) */
  pending: { id: number; text: string; photo?: string }[]
  /** 보낼 사진 (줄인 JPEG base64) */
  attach?: string
  approvals: Map<string, ApprovalView & { shot?: string }>
  decided: Map<string, { ok: boolean; message: string }>
  logins: Map<string, LoginRequestView>
  infos: Map<string, InfoRequestView>
  loginDraft: { id: string; user: string; pw: string; busy?: boolean; error?: string }
  /** 대신 로그인이 끝까지 못 간 서비스 → 그 화면(탭) */
  connectTabs: Map<string, number>
  services?: ConnectionItem[]
  connectQuery: string
  /** 아이디어 탭: 고른 분류('all' = 전체)와 찾는 말 */
  ideaCat: string
  /** 두리 본체가 지금 로그인하고 있는 서비스 */
  connecting: Set<string>
  /** 일하는 화면: 두리가 웹에서 일하는 동안 대화에 띄우는 그 탭의 실시간 화면 */
  work: { tabId?: number; web: boolean; shot?: string; url?: string }
  ideaQuery: string
  /** 연결하고 나서 바로 보낼 아이디어 (연결 안 한 곳의 아이디어를 눌렀을 때) */
  afterConnect?: { id: string; text: string; at: number }
  connectDetail?: string
  opening?: string
  agentSeg: 'upcoming' | 'memory' | 'screen' | 'activity' | 'approvals'
  /** 목표·보관함·기억·피드 (PC 본체) */
  life?: LifeState
  /** 열어 둔 따로 하는 대화 */
  side?: {
    id: string
    title: string
    messages: StoredMessage[]
    live: string
    steps: string[]
    busy: boolean
    draft: string
  }
  /** 새 따로 하는 대화를 만들어 달라고 했다 (만들어지면 바로 연다) */
  sideWanted?: boolean
  librarySeg: 'made' | 'media'
  draft: string
  toast?: string
  screenShot?: Shot
} = {
  online: false,
  pcSilent: false,
  screen: { name: 'intro' },
  tab: 'chat',
  overlay: undefined,
  conv: [],
  convLoaded: false,
  hasMore: false,
  busy: false,
  queued: [],
  live: '',
  steps: [],
  pending: [],
  approvals: new Map(),
  decided: new Map(),
  logins: new Map(),
  infos: new Map(),
  loginDraft: { id: '', user: '', pw: '' },
  connectTabs: new Map(),
  connectQuery: '',
  ideaCat: 'all',
  connecting: new Set(),
  work: { web: false },
  ideaQuery: '',
  agentSeg: 'activity',
  librarySeg: 'made',
  draft: '',
}
let pendingSeq = 0

// ── 연결 ──

// 보내기는 한 줄로 세운다. 순번(seq)을 올리고 저장·암호화를 기다리는 사이 다른 메시지가 끼면
// 같은 순번으로 나가거나 순서가 뒤집혀, PC가 뒤의 것을 재전송으로 보고 버린다
let sending = Promise.resolve()
function send(body: PhoneToPc): Promise<void> {
  sending = sending.then(() => sendNow(body)).catch(() => {})
  return sending
}

async function sendNow(body: PhoneToPc) {
  const s = st.saved
  if (!s || !st.key || !st.client) return
  const seq = ++s.seq
  await save(s)
  st.client.send(
    await seal(st.key, { v: LINK_VERSION, from: s.keys.id, to: s.pcId, kind: body.kind, seq }, body),
  )
}

let heard = false
let silentTimer: ReturnType<typeof setTimeout> | undefined

/** 이 폰의 연결을 지우고 처음(QR 찍기)으로 */
async function forgetPc() {
  st.client?.stop()
  st.client = undefined
  await clear()
  st.saved = undefined
  st.key = undefined
  st.online = false
  st.pcSilent = false
  st.conv = []
  st.convLoaded = false
  st.overlay = undefined
  st.screen = { name: 'intro' }
  render()
}

function connect() {
  const s = st.saved
  if (!s) return
  st.client?.stop()
  st.client = new LinkClient({
    relay: s.relay ?? defaultRelay(),
    role: 'phone',
    keys: s.keys,
    room: s.pcId,
    onEnvelope: (env) => void receive(env),
    onState: (state) => {
      st.online = state === 'ready'
      clearTimeout(silentTimer)
      if (state === 'ready' && st.saved?.paired) {
        // 7초 안에 PC가 아무 말도 없으면 알려 준다 (빈 화면으로 멈춰 있지 않게)
        heard = false
        silentTimer = setTimeout(() => {
          if (heard || !st.online) return
          st.pcSilent = true
          render()
        }, 7000)
        void send({ kind: 'hello' })
        void send({ kind: 'conversation' })
        void send({ kind: 'connections' })
        void send({ kind: 'life' })
      }
      render()
    },
  })
  st.client.start()
}

async function receive(env: Envelope) {
  const s = st.saved
  if (!s || !st.key || env.from !== s.pcId || env.to !== s.keys.id) return
  let msg: PcToPhone
  try {
    msg = await open<PcToPhone>(st.key, env)
  } catch {
    return
  }
  heard = true
  if (st.pcSilent) st.pcSilent = false
  switch (msg.kind) {
    case 'paired':
      s.paired = true
      s.pcName = msg.pcName
      await save(s)
      toast('연결됐어요. 이제 폰으로 부탁해 보세요')
      st.screen = { name: 'app' }
      // 다시 연결할 때와 같은 것을 받아 온다 (피드·목표·아이디어가 비어 보이지 않게)
      void send({ kind: 'conversation' })
      void send({ kind: 'connections' })
      void send({ kind: 'life' })
      break
    case 'pair-rejected':
      if (st.screen.name === 'pairing') st.screen = { ...st.screen, rejected: true }
      await clear()
      st.saved = undefined
      break
    case 'state':
      st.pc = msg
      // PC 이름을 PC나 다른 폰에서 바꿨으면 따라간다
      if (msg.pcName && msg.pcName !== s.pcName) {
        s.pcName = msg.pcName
        await save(s)
      }
      for (const a of msg.approvals) if (!st.approvals.has(a.id)) st.approvals.set(a.id, a)
      for (const l of msg.logins ?? []) st.logins.set(l.id, l)
      for (const q of msg.infos ?? []) st.infos.set(q.id, q)
      for (const id of st.infos.keys()) if (!(msg.infos ?? []).some((q) => q.id === id)) st.infos.delete(id)
      st.connecting = new Set(msg.connecting ?? [])
      void syncPush()
      openPending()
      break
    case 'conversation':
      if (msg.before) {
        const have = new Set(st.conv.map((m) => m.id))
        st.conv = [...msg.state.messages.filter((m) => !have.has(m.id)), ...st.conv]
      } else {
        st.conv = msg.state.messages
        st.convLoaded = true
        stickToBottom = true
      }
      st.hasMore = msg.state.hasMore
      st.busy = msg.state.busy
      st.queued = msg.state.queued
      // 다시 받아 온 기록이 끝난 상태면, 놓친 끝 신호 때문에 남은 "대답하는 중"을 지운다
      if (!msg.before && !msg.state.busy) {
        st.live = ''
        st.steps = []
      }
      break
    case 'conversation-status':
      st.busy = msg.busy
      st.queued = msg.queued
      // 줄 선 말로 넘어간 건 "보내는 중"에서 뺀다
      st.pending = st.pending.filter((p) => !msg.queued.includes(p.text))
      if (!msg.busy) {
        st.live = ''
        st.steps = []
      }
      break
    case 'stream':
      // 따로 하는 대화의 진행은 그 화면으로, 나머지는 메인 대화로
      if (isSideThread(msg.threadId)) {
        onSideStream(msg.threadId, msg.event)
        if (st.screen.name !== 'side') return
        break
      }
      onStream(msg.event)
      break
    case 'approval':
      st.approvals.set(msg.approval.id, msg.approval)
      if (msg.approval.status === 'pending')
        notify('승인을 기다려요', msg.approval.what, `approval-${msg.approval.id}`)
      break
    case 'decided': {
      st.decided.set(msg.id, { ok: msg.ok, message: msg.message })
      const a = st.approvals.get(msg.id)
      if (a && msg.ok) st.approvals.set(msg.id, { ...a, status: a.status === 'pending' ? 'done' : a.status })
      // 잘 됐으면 카드가 바로 바뀌니 알림 막대는 띄우지 않는다
      if (!msg.ok) toast(msg.message)
      void send({ kind: 'approval', id: msg.id })
      break
    }
    case 'info-request':
      // 연결 중 화면이 묻는 것: 입력 화면을 바로 띄운다 (PC 화면을 찾아 칠 필요 없이)
      st.infos.set(msg.request.id, msg.request)
      openOverlay({ kind: 'info', id: msg.request.id })
      break
    case 'info-done':
      st.infos.delete(msg.id)
      if (st.overlay?.kind === 'info' && st.overlay.id === msg.id) st.overlay = undefined
      break
    case 'login-request':
      st.logins.set(msg.request.id, msg.request)
      // 서비스 연결 중 두리가 부탁한 계정(카카오 등): 입력 화면을 바로 띄운다
      if (msg.request.connect) openOverlay({ kind: 'login', id: msg.request.id })
      notify(
        '로그인이 필요해요',
        `${msg.request.site} 아이디와 비밀번호를 넣어 주세요`,
        `login-${msg.request.id}`,
      )
      break
    case 'login-done': {
      const l = st.logins.get(msg.id)
      if (msg.ok && l) st.logins.set(msg.id, { ...l, status: 'saved' })
      if (st.loginDraft.id === msg.id) {
        st.loginDraft.busy = false
        st.loginDraft.error = msg.ok ? undefined : msg.message
        if (msg.ok && st.overlay?.kind === 'login') st.overlay = undefined
      }
      toast(msg.message)
      break
    }
    case 'form': {
      if (remoteUi?.tabId === msg.tabId) remoteUi.setForm(msg.form, msg.error)
      return
    }
    case 'screen': {
      if (st.screen.name !== 'remote' && msg.tabId === st.work.tabId && msg.shot) {
        // 대화 안 일하는 화면: 그림만 바꾼다
        const first = !st.work.shot
        st.work = { ...st.work, shot: msg.shot, ...(msg.url ? { url: msg.url } : {}) }
        const img = document.querySelector<HTMLImageElement>('.work-shot')
        if (img) img.src = `data:image/jpeg;base64,${msg.shot}`
        const host = document.querySelector('.work-host')
        if (host) host.textContent = hostOf(msg.url ?? '')
        if (first) render()
        return
      }
      if (st.screen.name !== 'remote' || st.screen.tabId !== msg.tabId) return
      const hadShot = !!st.screenShot?.shot
      st.screenShot = { tabId: msg.tabId, ...(msg.error ? { error: msg.error } : {}), ...pick(msg) }
      if (msg.error) break
      frameTimes.push(performance.now())
      nextScreen(msg.tabId)
      // 실시간 화면: 그림만 바꾼다 (화면 전체를 다시 그리지 않아 깜빡이지 않는다)
      // 원격 화면은 한 번 만든 화면에 그림·정보만 바꾼다
      if (remoteUi?.tabId === msg.tabId && hadShot) {
        remoteUi.update(st.screenShot, fps())
        return
      }
      break
    }
    case 'connections': {
      st.services = msg.services
      // 원격 화면으로 로그인하는 중에 PC가 로그인을 확인하면 그 서비스로 돌아간다
      const v = st.screen
      if (v.name === 'remote' && v.connectId) {
        const done = msg.services.find((x) => x.card.id === v.connectId && x.connectedAt)
        if (done) {
          st.screen = { name: 'app' }
          st.tab = 'connect'
          st.connectDetail = done.card.id
          toast(`${done.card.name} 로그인을 확인했어요`)
          runAfterConnect(done.card.id)
        }
      }
      break
    }
    case 'life':
      st.life = msg.state
      break
    case 'work-tab':
      st.work = { ...st.work, tabId: msg.tabId }
      pollWork()
      return
    case 'connect-status':
      st.connecting = new Set(msg.connecting)
      break
    case 'connect-result': {
      const d = st.loginDraft
      if (d.id === `connect:${msg.id}`) {
        d.busy = false
        d.error = msg.ok || msg.human ? undefined : msg.message
      }
      if (msg.tabId !== undefined) st.connectTabs.set(msg.id, msg.tabId)
      if (msg.ok) {
        st.connectTabs.delete(msg.id)
        if (st.overlay?.kind === 'connect') st.overlay = undefined
        toast(msg.message)
        runAfterConnect(msg.id)
      } else if (msg.tabId !== undefined) {
        // 로봇 확인·본인인증, 자동 로그인 실패: 그 화면을 바로 열어 직접 마치게 한다
        toast(msg.message)
        openRemote(msg.tabId, msg.id)
        return
      } else toast(msg.message)
      break
    }
    case 'connect-opened':
      st.opening = undefined
      openRemote(msg.tabId, msg.id)
      return
    case 'error':
      st.opening = undefined
      toast(msg.message)
      break
    case 'thread': {
      const t = msg.thread
      if (st.sideWanted && t.side && !msg.messages.length) {
        st.sideWanted = false
        openSide(t.id, t.title)
      }
      if (st.side?.id === t.id) {
        st.side.title = t.title
        st.side.messages = msg.messages
        st.side.busy = Boolean(t.busy)
      }
      break
    }
  }
  render()
}

function onStream(ev: DaemonStreamEvent) {
  lastStreamAt = Date.now()
  if (ev.type === 'saved') {
    const m = ev.message
    if (!st.conv.some((x) => x.id === m.id)) st.conv = [...st.conv, m]
    if (m.role === 'user') {
      const i = st.pending.findIndex((p) => p.text === splitPhoto(m.text).text)
      if (i >= 0) st.pending.splice(i, 1)
    }
    if (m.role === 'assistant') {
      st.live = ''
      st.steps = []
    }
  } else if (ev.type === 'agent') {
    st.busy = true
    if (ev.event.type === 'text') st.live += ev.event.delta
    else if (ev.event.type === 'tool') {
      // 웹에서 일하기 시작하면 대화에 그 화면을 띄운다
      const web = /browser_/.test(ev.event.name)
      if (web !== st.work.web) {
        st.work = { ...st.work, web }
        if (web) pollWork()
      }
      // 도구 앞에 한 말은 답이 아니라 지금 하는 일. 한국어 한 줄만 단계로 남기고 말풍선은 비운다
      const label = narrationLine(st.live) ?? `${toolLabel(ev.event.name)} 중`
      st.live = ''
      if (st.steps.at(-1) !== label) st.steps = [...st.steps, label]
    }
  } else if (ev.type === 'end') {
    st.live = ''
    st.steps = []
    st.work = { ...st.work, web: false, shot: undefined }
    void send({ kind: 'hello' })
  }
}

function pick(m: Omit<Shot, 'tabId'>) {
  return {
    ...(m.shot ? { shot: m.shot } : {}),
    ...(m.url ? { url: m.url } : {}),
    ...(m.title ? { title: m.title } : {}),
    ...(m.fields ? { fields: m.fields } : {}),
    ...(m.actions ? { actions: m.actions } : {}),
    ...(m.focus !== undefined ? { focus: m.focus } : {}),
  }
}

// ── 할 일 ──

/** 부탁 보내기: 내 말을 바로 화면에 띄우고 PC에 보낸다 */
function ask(text: string) {
  const photo = st.attach
  const t = text.trim() || (photo ? '이 사진 봐 줘' : '')
  if (!t || !st.online) return
  st.pending.push({ id: ++pendingSeq, text: t, ...(photo ? { photo } : {}) })
  st.draft = ''
  st.attach = undefined
  st.tab = 'chat'
  stickToBottom = true
  render()
  void send({ kind: 'ask', text: t, ...(photo ? { image: photo } : {}) })
}

/** 사진을 가로 1024px·300KB 이하 JPEG로 줄인다 (중계 한 번에 보낼 수 있게) */
async function shrinkPhoto(file: File): Promise<string> {
  const bmp = await createImageBitmap(file)
  for (const [max, q] of [
    [1024, 0.78],
    [900, 0.65],
    [720, 0.55],
  ] as const) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.round(bmp.width * scale)
    c.height = Math.round(bmp.height * scale)
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height)
    const data = c.toDataURL('image/jpeg', q).split(',')[1] ?? ''
    if (data.length < 300_000) return data
  }
  throw new Error('사진이 너무 커요')
}

/** + > 사진 보내기 */
function pickPhoto() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = async () => {
    const f = input.files?.[0]
    if (!f) return
    try {
      st.attach = await shrinkPhoto(f)
      st.overlay = undefined
      st.tab = 'chat'
      render()
      shell?.textarea.focus()
    } catch (e) {
      toast((e as Error).message)
    }
  }
  input.click()
}

async function decide(a: ApprovalView, decision: 'approve' | 'reject', quiet = false) {
  const s = st.saved
  if (!s) return
  // 승인 내용에 이 폰의 키로 서명한다. PC가 페어링 때 받은 공개키로 확인한다
  const sig = await signText(s.keys.signPriv, approvalSignText(a, decision))
  // 꾹 눌러 승인은 체크를 보여 준 뒤에 카드를 접는다 (markDecided를 나중에 부른다)
  if (!quiet) markDecided(a, decision)
  await send({ kind: 'decide', id: a.id, decision, sig })
}

function markDecided(a: ApprovalView, decision: 'approve' | 'reject') {
  if (st.decided.has(a.id)) return
  st.decided.set(a.id, {
    ok: true,
    message: decision === 'approve' ? '승인을 보냈어요. PC에서 누르는 중…' : '거절을 보냈어요',
  })
  render()
}

const pendingApprovals = () =>
  [...st.approvals.values()].filter((a) => a.status === 'pending' && !st.decided.has(a.id))
const pendingLogins = () => [...st.logins.values()].filter((l) => l.status === 'pending')

// ── 원격 화면: 두리가 넘긴 PC 탭을 폰에서 보고 누른다 (다음 단계에서 실시간 화면으로 바꾼다) ──

let screenTimer: ReturnType<typeof setTimeout> | undefined
/** 실시간 화면: 그림이 오면 곧바로 다음 그림을 부탁한다 (초당 3~5장). 2초 동안 안 오면 다시 부탁 */
const frameTimes: number[] = []
function nextScreen(tabId: number) {
  clearTimeout(screenTimer)
  const ask = () => {
    if (st.screen.name === 'remote' && st.screen.tabId === tabId && document.visibilityState === 'visible') {
      void send({ kind: 'screen', tabId })
      screenTimer = setTimeout(ask, 2000)
    }
  }
  screenTimer = setTimeout(ask, 120)
}

/** 초당 몇 장 오는지 (최근 2초) */
function fps() {
  const now = performance.now()
  while (frameTimes.length && now - (frameTimes[0] ?? 0) > 2000) frameTimes.shift()
  return Math.max(1, Math.round(frameTimes.length / 2))
}

function openRemote(tabId: number, connectId?: string) {
  st.screenShot = { tabId }
  st.overlay = undefined
  st.screen = { name: 'remote', tabId, ...(connectId ? { connectId } : {}) }
  render()
  void send({ kind: 'screen', tabId })
}

function remote(input: Omit<Extract<PhoneToPc, { kind: 'remote' }>, 'kind' | 'tabId'>) {
  if (st.screen.name !== 'remote') return
  const tabId = st.screen.tabId
  clearTimeout(screenTimer)
  if (st.screenShot) st.screenShot.busy = true
  remoteUi?.update(st.screenShot, fps())
  void send({ kind: 'remote', tabId, ...input })
}

// ── 일하는 화면: 두리가 웹에서 일하는 동안 대화에 그 탭을 작게 실시간으로 ──

let workTimer: ReturnType<typeof setTimeout> | undefined
function pollWork() {
  clearTimeout(workTimer)
  const tick = () => {
    const tab = st.work.tabId
    const watching =
      st.work.web &&
      st.busy &&
      tab !== undefined &&
      st.tab === 'chat' &&
      st.screen.name === 'app' &&
      document.visibilityState === 'visible'
    if (!watching) return
    void send({ kind: 'screen', tabId: tab })
    workTimer = setTimeout(tick, 1500)
  }
  workTimer = setTimeout(tick, 300)
}

function workCard(tab: number): HTMLElement {
  const img = h('img', { class: 'work-shot' })
  img.alt = '두리가 보고 있는 화면'
  if (st.work.shot) img.src = `data:image/jpeg;base64,${st.work.shot}`
  return h(
    'button',
    { class: 'work-card', label: '두리 화면 크게 보기', onclick: () => openRemote(tab) },
    img,
    h(
      'span',
      { class: 'work-meta' },
      h('span', { class: 'dot work pulse' }),
      h('span', { class: 'work-host', text: hostOf(st.work.url ?? '') }),
      h('span', { class: 'work-open' }, '크게 보기', icon('chevron', 'i')),
    ),
  )
}

// ── 알림 ──

function toast(text: string) {
  st.toast = text
  render()
  setTimeout(() => {
    if (st.toast === text) {
      st.toast = undefined
      render()
    }
  }, 3200)
}

function notify(title: string, body: string, tag?: string) {
  // 앱이 뒤에 있을 때만. PC가 보낸 푸시 알림과 tag가 같아서 둘이 겹치지 않는다
  if (document.visibilityState === 'visible') return
  if ('Notification' in window && Notification.permission === 'granted')
    new Notification(title, { body, ...(tag ? { tag } : {}) })
}

const pushReady = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array) {
  if (!a) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

/** 알림을 허락했으면 이 PC의 키로 푸시를 구독하고 PC에 알린다 */
let syncing = false
async function syncPush() {
  const vapid = st.pc?.vapid
  if (syncing || !vapid || !pushReady() || Notification.permission !== 'granted') return
  syncing = true
  try {
    const reg = await navigator.serviceWorker.ready
    const key = fromB64u(vapid)
    let sub = await reg.pushManager.getSubscription()
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe()
      sub = null
    }
    const fresh = !sub
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    if (fresh || !st.pc?.push) {
      const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
      if (j.endpoint && j.keys?.p256dh && j.keys.auth)
        await send({
          kind: 'push',
          sub: { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } },
        })
    }
  } catch {
    // 알림 주소를 못 받는 브라우저 (예: 홈 화면에 추가하지 않은 아이폰 사파리)
  } finally {
    syncing = false
  }
}

/** 알림을 눌러 열었으면 (#a=승인 id, #t=대화) 그 화면으로 간다 */
let pendingOpen = ''
function openPending() {
  const tab = /^#tab=(chat|feed|ideas|goals|library)$/.exec(pendingOpen)?.[1] as Tab | undefined
  if (tab && st.saved?.paired) {
    pendingOpen = ''
    history.replaceState(null, '', location.pathname)
    st.screen = { name: 'app' }
    st.tab = tab
    return
  }
  const m = /^#([at])=([\w-]+)$/.exec(pendingOpen)
  if (!m || !st.saved?.paired) return
  pendingOpen = ''
  history.replaceState(null, '', location.pathname)
  st.screen = { name: 'app' }
  if (m[1] === 'a') {
    st.overlay = { kind: 'approval', id: m[2] as string }
    void send({ kind: 'approval', id: m[2] as string })
  } else st.tab = 'chat'
}

// ── 페어링 ──

async function startPairing(raw: string) {
  let invite: PairInvite
  try {
    invite = JSON.parse(new TextDecoder().decode(fromB64u(raw))) as PairInvite
  } catch {
    toast('QR이 올바르지 않아요. PC에서 다시 띄워 주세요')
    return
  }
  // 이미 연결된 그 PC의 초대면 지금 연결을 지우지 않는다 (같은 링크가 다시 들어온 경우)
  if (st.saved?.paired && st.saved.pcId === invite.pc) {
    history.replaceState(null, '', location.pathname)
    toast(`${st.saved.pcName ?? 'PC'}와 이미 연결돼 있어요`)
    return
  }
  history.replaceState(null, '', location.pathname)
  st.client?.stop()
  st.client = undefined
  st.online = false
  st.conv = []
  st.pending = []
  st.approvals.clear()
  st.decided.clear()
  st.pc = undefined
  const keys = await generateDevice(false)
  const saved: Saved = {
    pcId: invite.pc,
    pcBoxPub: invite.k,
    pcName: invite.n,
    keys,
    paired: false,
    seq: 0,
    ...(typeof invite.r === 'string' && /^https?:\/\//.test(invite.r) ? { relay: invite.r } : {}),
  }
  await save(saved)
  st.saved = saved
  st.key = await linkKey(keys.boxPriv, invite.k, [keys.id, invite.pc])
  const code = await pairCode(keys.boxPriv, invite.k)
  st.screen = { name: 'pairing', code, pcName: invite.n }
  render()
  connect()
  // 페어링 요청: 이 폰의 X25519 공개키를 머리에 실어, PC가 키를 만들 수 있게 한다
  saved.seq += 1
  await save(saved)
  const body: PhoneToPc = { kind: 'pair', secret: invite.s, signPub: keys.signPub, name: deviceName() }
  ;(st.client as LinkClient | undefined)?.send({
    ...(await seal(
      st.key,
      { v: LINK_VERSION, from: keys.id, to: invite.pc, kind: 'pair', seq: saved.seq, pub: keys.boxPub },
      body,
    )),
  })
}

function deviceName() {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return '아이폰'
  if (/iPad/.test(ua)) return '아이패드'
  if (/Android/.test(ua)) return '안드로이드 폰'
  return '폰'
}

// ── 화면 ──

/** 대화 아래쪽을 보고 있으면 새 말이 와도 아래에 붙어 있는다 */
let stickToBottom = true
let shell:
  | {
      top: HTMLElement
      page: HTMLElement
      chat: HTMLElement
      composerBox: HTMLElement
      textarea: HTMLTextAreaElement
      sendBtn: HTMLButtonElement
      tabs: HTMLElement
      overlay: HTMLElement
      toast: HTMLElement
    }
  | undefined

function render() {
  const s = st.screen
  if (s.name !== 'app') {
    shell = undefined
    const view =
      s.name === 'intro'
        ? introView()
        : s.name === 'unsupported'
          ? unsupportedView()
          : s.name === 'pairing'
            ? pairingView(s)
            : s.name === 'side'
              ? sideView(s.id)
              : remoteView(s)
    if (s.name === 'remote') {
      // 같은 원격 화면이면 그대로 둔다 (다시 꽂으면 키보드가 닫힌다)
      remoteToast ??= h('div', { class: 'toast float-toast' })
      remoteToast.textContent = st.toast ?? ''
      remoteToast.hidden = !st.toast
      if (app.firstElementChild !== view) app.replaceChildren(view, remoteToast)
      return
    }
    const t = h('div', { class: 'toast float-toast', text: st.toast ?? '' })
    t.hidden = !st.toast
    app.replaceChildren(view, t)
    return
  }
  if (!shell) buildShell()
  renderTop()
  renderPage()
  renderComposer()
  renderTabs()
  renderOverlay()
  if (shell) {
    shell.toast.textContent = st.toast ?? ''
    shell.toast.hidden = !st.toast
  }
  // 다시 그린 뒤: 칸 하이라이트·스위치 손잡이를 앞 자리에서 새 자리로 움직인다
  playSeg()
  playFlip()
}

let lastScrollY = 0

function buildShell() {
  const top = h('header', { class: 'app-top' })
  const page = h('main', { class: 'app-page' })
  const chat = h('div', { class: 'chat-list' })
  page.addEventListener(
    'scroll',
    () => {
      if (st.tab === 'chat') stickToBottom = page.scrollHeight - page.scrollTop - page.clientHeight < 80
      // 긴 목록을 내리면 탭 막대를 숨기고, 올리면 다시 보인다 (대화는 입력칸이 있어 그대로)
      const y = page.scrollTop
      const away = st.tab !== 'chat' && y > 80 && y > lastScrollY + 6
      if (away || y < lastScrollY - 6 || y <= 80) shell?.tabs.classList.toggle('away', away)
      lastScrollY = y
    },
    { passive: true },
  )
  const textarea = h('textarea')
  textarea.rows = 1
  textarea.placeholder = '두리에게 부탁하기'
  textarea.setAttribute('aria-label', '부탁')
  textarea.addEventListener('input', () => {
    st.draft = textarea.value
    autosize(textarea)
    renderComposer()
  })
  textarea.addEventListener('keydown', (e) => {
    // 이어 쓰기 제안 받기: Tab, 또는 글 끝에서 →
    if (
      ghostRest &&
      (e.key === 'Tab' || (e.key === 'ArrowRight' && textarea.selectionStart === textarea.value.length)) &&
      !e.isComposing
    ) {
      e.preventDefault()
      takeGhost()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault()
      ask(st.draft)
      textarea.value = ''
      autosize(textarea)
    }
  })
  const plus = h(
    'button',
    { class: 'cbtn plus', label: '더 하기', onclick: () => openOverlay({ kind: 'plus' }) },
    icon('plus', 'i md'),
  )
  const sendBtn = h('button', { class: 'send-btn', label: '보내기' })
  sendBtn.addEventListener('click', () => {
    if (!st.draft.trim() && !st.attach && st.busy) return void send({ kind: 'conversation-cancel' })
    ask(st.draft)
    textarea.value = ''
    autosize(textarea)
    textarea.focus()
  })
  const attachBox = h('div', { class: 'attach-preview' })
  const ghost = h('div', { class: 'ghost' })
  ghost.hidden = true
  ghost.setAttribute('aria-hidden', 'true')
  const field = h('div', { class: 'ghost-wrap' }, textarea, ghost)
  const composerBox = h('div', { class: 'composer float app-composer' }, attachBox, plus, field, sendBtn)
  const tabs = h('nav', { class: 'tabs app-tabs', label: '탭' })
  const overlay = h('div', { class: 'app-overlay' })
  const toast = h('div', { class: 'toast float-toast' })
  toast.setAttribute('role', 'status')
  app.replaceChildren(h('div', { class: 'app-shell' }, top, page, composerBox, tabs, overlay, toast))
  shell = { top, page, chat, composerBox, textarea, sendBtn, tabs, overlay, toast }
  ghostEl = ghost
  pullToRefresh(page)
}

// ── 이어 쓰기 제안: 쓰는 말이 아이디어의 앞부분과 같으면 나머지를 흐리게 보여 준다 (누르거나 Tab으로 받기) ──

let ghostEl: HTMLElement | undefined
let ghostRest = ''

function ghostFor(draft: string): string {
  const d = draft.trimStart()
  if (d.length < 2 || d.includes('\n')) return ''
  const mine = (st.life?.ideas ?? []).map((i) => i.text)
  const all = ideaCatalog(st.services ?? []).flatMap((g) => g.items.map((i) => i.text))
  const hit = [...mine, ...all].find((t) => t.startsWith(d) && t.length > d.length)
  return hit ? hit.slice(d.length) : ''
}

function updateGhost() {
  const g = ghostEl
  const t = shell?.textarea
  if (!g || !t) return
  const rest = ghostFor(st.draft)
  // 한 줄일 때만: 쓴 말이 두 줄로 넘어가면 글자 자리가 어긋나서 보이지 않는다
  const oneLine = t.scrollHeight <= Number.parseFloat(getComputedStyle(t).minHeight) + 2
  if (!rest || !oneLine) {
    ghostRest = ''
    g.hidden = true
    g.replaceChildren()
    return
  }
  if (rest === ghostRest && !g.hidden) return
  ghostRest = rest
  // 입력칸과 같은 글꼴·안쪽 여백으로 겹쳐 그린다
  const cs = getComputedStyle(t)
  g.style.font = cs.font
  g.style.letterSpacing = cs.letterSpacing
  g.style.padding = cs.padding
  const typed = h('span', { class: 'ghost-typed', text: st.draft })
  const letters = [...rest].map((ch) => h('span', { class: 'g', text: ch }))
  const restEl = h('span', { class: 'ghost-rest', onclick: takeGhost }, ...letters)
  const key = h(
    'button',
    { class: 'ghost-key', label: '이어 쓰기 받기', onclick: takeGhost },
    icon('chevron', 'i'),
  )
  g.replaceChildren(typed, restEl, key)
  g.hidden = false
  springTo(restEl, [{ opacity: 0 }, { opacity: 1 }], 'fade')
  springTo(
    key,
    [
      { opacity: 0, transform: 'scale(0.6)' },
      { opacity: 1, transform: 'none' },
    ],
    'squash',
  )
}

function takeGhost() {
  const g = ghostEl
  const t = shell?.textarea
  if (!g || !t || !ghostRest) return
  const full = st.draft + ghostRest
  ghostRest = ''
  // 흐린 글자가 왼쪽부터 밝아지며 톡, 그다음 진짜 글자로 바꾼다
  const letters = [...g.querySelectorAll<HTMLElement>('.ghost-rest .g')]
  acceptGhost(letters)
  g.querySelector('.ghost-key')?.remove()
  g.classList.add('taking')
  t.classList.add('ghosting')
  setTimeout(
    () => {
      st.draft = full
      t.value = full
      t.classList.remove('ghosting')
      g.classList.remove('taking')
      g.hidden = true
      g.replaceChildren()
      autosize(t)
      renderComposer()
      t.focus()
      t.setSelectionRange(full.length, full.length)
    },
    reducedMotion() ? 0 : 260 + letters.length * 16,
  )
}

/** 입력칸 높이: 줄이 늘고 줄 때 스프링으로 */
function autosize(t: HTMLTextAreaElement) {
  const h0 = t.offsetHeight
  t.style.height = 'auto'
  const h1 = Math.min(t.scrollHeight, 132)
  t.style.height = `${h1}px`
  if (h0 && Math.abs(h1 - h0) > 1) springTo(t, [{ height: `${h0}px` }, { height: `${h1}px` }], 'field')
}

const TAB_ORDER: Tab[] = ['chat', 'feed', 'ideas', 'goals', 'library']

function setTab(tab: Tab) {
  const from = TAB_ORDER.indexOf(st.tab)
  const to = TAB_ORDER.indexOf(tab)
  st.tab = tab
  st.overlay = undefined
  if (tab === 'chat') stickToBottom = true
  if (tab === 'connect') st.connectDetail = undefined
  render()
  const page = shell?.page
  if (!page) return
  page.scrollTo({ top: tab === 'chat' ? page.scrollHeight : 0 })
  shell?.tabs.classList.remove('away')
  if (tab === 'chat') pollWork()
  // 탭 순서대로 옆에서 밀려 들어온다
  if (from >= 0 && to >= 0 && from !== to && !reducedMotion())
    page.animate(
      [
        { opacity: 0, transform: `translateX(${to > from ? 18 : -18}px)` },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    )
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** 머리: 메뉴 · 두리(지금 하는 일) · 내 PC */
function renderTop() {
  const t = shell?.top
  if (!t) return
  const waiting = pendingApprovals().length + pendingLogins().length
  const mood =
    !st.online || st.pcSilent
      ? 'sleeping'
      : waiting
        ? 'asking'
        : st.busy || st.pending.length
          ? 'working'
          : ''
  const status = !st.online
    ? 'PC 연결 중…'
    : st.pcSilent
      ? 'PC가 답하지 않아요'
      : waiting
        ? pendingApprovals().length
          ? '승인을 기다려요'
          : '로그인을 기다려요'
        : st.busy || st.pending.length
          ? (st.steps.at(-1) ?? '대답하는 중…')
          : ''
  const tag = h(
    'span',
    { class: 'agent-tag' },
    '두리',
    status && h('span', { class: waiting ? 'ask' : !st.online || st.pcSilent ? 'off' : '', text: status }),
  )
  const agent = h(
    'button',
    { class: 'agent', label: '두리 패널 열기', onclick: () => openOverlay({ kind: 'agent' }) },
    h('span', { class: 'agent-av' }, doori(mood)),
    tag,
  )
  const pill = h(
    'button',
    { class: 'fpill', label: '내 PC', onclick: () => setTab('settings') },
    h('span', { class: st.online && !st.pcSilent ? 'dot work' : 'dot' }),
    shortPc(st.saved?.pcName),
  )
  // 상태 섬: 글이 바뀌면 앞 크기에서 새 크기로 스프링 (가로가 먼저 닿고 세로가 따라온다), 글은 흐려졌다 또렷해진다
  const old = t.querySelector<HTMLElement>('.agent-tag')
  const before =
    old && old.dataset.status !== status ? { w: old.offsetWidth, h: old.offsetHeight } : undefined
  tag.dataset.status = status
  t.replaceChildren(
    h(
      'button',
      { class: 'fbtn', label: '메뉴', onclick: () => openOverlay({ kind: 'drawer' }) },
      icon('menu'),
    ),
    agent,
    pill,
  )
  if (before) {
    const w = tag.offsetWidth
    const ht = tag.offsetHeight
    if (Math.abs(w - before.w) > 1) springTo(tag, [{ width: `${before.w}px` }, { width: `${w}px` }], 'lead')
    if (Math.abs(ht - before.h) > 1)
      springTo(tag, [{ height: `${before.h}px` }, { height: `${ht}px` }], 'soft')
    const line = tag.querySelector('span')
    if (line)
      springTo(
        line,
        [
          { opacity: 0, filter: 'blur(4px)', transform: 'translateY(3px)' },
          { opacity: 1, filter: 'blur(0)', transform: 'none' },
        ],
        'fade',
      )
  }
}

function shortPc(name?: string) {
  if (!name) return '내 PC'
  return name.length > 8 ? `${name.slice(0, 7)}…` : name
}

function openOverlay(o: Overlay) {
  st.overlay = o
  render()
}

let pillStop: (() => void) | undefined
/** 지금 하는 일에서 이미 보여 준 단계 수 (새로 온 단계만 움직인다) */
let shownSteps = 0

function renderTabs() {
  const t = shell?.tabs
  if (!t) return
  const waiting = pendingApprovals().length + pendingLogins().length
  const items: [Tab, IconName, string][] = [
    ['chat', 'chat', '대화'],
    ['feed', 'feed', '피드'],
    ['ideas', 'idea', '아이디어'],
    ['goals', 'goal', '목표'],
    ['library', 'library', '보관함'],
  ]
  // 버튼은 한 번만 만든다: 다시 그리면 움직임이 끊긴다
  if (!t.querySelector('.tab')) {
    t.classList.add('has-pill')
    t.replaceChildren(
      h('span', { class: 'tab-pill' }),
      ...items.map(([id, ic, label]) =>
        h(
          'button',
          { class: 'tab', label, onclick: () => setTab(id) },
          icon(ic),
          h('span', { class: 'tab-label', text: label }),
          h('span', { class: 'badge' }),
        ),
      ),
    )
    items.forEach(([id], i) => {
      ;(t.querySelectorAll('.tab')[i] as HTMLElement).dataset.tab = id
    })
  }
  const btns = [...t.querySelectorAll<HTMLElement>('.tab')]
  const pill = t.querySelector<HTMLElement>('.tab-pill') as HTMLElement
  const ready = t.dataset.ready === '1'
  // 태블릿은 왼쪽 세로 막대: 알약이 위아래로 움직인다
  const vertical = getComputedStyle(t).flexDirection === 'column'
  const pos = (e: HTMLElement) => (vertical ? e.offsetTop : e.offsetLeft)
  const size = (e: HTMLElement) => (vertical ? e.offsetHeight : e.offsetWidth)
  const [P, S] = vertical ? (['top', 'height'] as const) : (['left', 'width'] as const)
  const before = new Map(btns.map((b) => [b, pos(b)]))
  const pillFrom = { x: pos(pill), w: size(pill) }
  let changed = false
  for (const b of btns) {
    const on = b.dataset.tab === st.tab
    if (b.classList.contains('on') !== on) changed = true
    b.classList.toggle('on', on)
    if (on) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
    ;(b.querySelector('.badge') as HTMLElement).hidden = !(b.dataset.tab === 'feed' && waiting > 0)
  }
  const active = btns.find((b) => b.classList.contains('on'))
  pill.hidden = !active
  if (!active) return
  pill.style.removeProperty(vertical ? 'left' : 'top')
  pill.style.removeProperty(vertical ? 'width' : 'height')
  // 화면이 바뀌는 도중이라 칸 크기가 0이면 다음에 다시 잰다
  if (!size(active)) return
  pill.style[P] = `${pos(active)}px`
  pill.style[S] = `${size(active)}px`
  t.dataset.ready = '1'
  if (!ready || !changed || reducedMotion()) return
  // 알약: 가는 쪽 끝이 먼저(lead) 닿고 뒤쪽 끝이 늦게(trail) 따라와서, 움직이는 동안 늘어났다가 줄어든다
  const toA = pos(active)
  const toB = toA + size(active)
  const fwd = toA > pillFrom.x
  const A = new Spring(pillFrom.x).use(fwd ? 'trail' : 'lead')
  const B = new Spring(pillFrom.x + pillFrom.w).use(fwd ? 'lead' : 'trail')
  A.t = toA
  B.t = toB
  pillStop?.()
  pillStop = tick((dt) => {
    A.step(dt)
    B.step(dt)
    pill.style[P] = `${A.x.toFixed(2)}px`
    pill.style[S] = `${Math.max(8, B.x - A.x).toFixed(2)}px`
    return !(A.resting && B.resting)
  })
  // 나머지 탭은 제자리로 스프링, 고른 탭 아이콘은 찌그러졌다 톡, 이름은 떠오른다 (참고 값: bar 340 28, squash 520 14)
  for (const b of btns) {
    const dx = (before.get(b) ?? 0) - pos(b)
    if (dx)
      springTo(
        b,
        [{ transform: vertical ? `translateY(${dx}px)` : `translateX(${dx}px)` }, { transform: 'none' }],
        'bar',
      )
  }
  const svg = active.querySelector('svg')
  if (svg) springTo(svg, [{ transform: 'scale(0.72)' }, { transform: 'scale(1)' }], 'squash')
  const label = active.querySelector('.tab-label')
  if (label)
    springTo(
      label,
      [
        { opacity: 0, transform: 'translateX(-6px)' },
        { opacity: 1, transform: 'none' },
      ],
      'fade',
      {
        delay: 60,
        fill: 'backwards',
      },
    )
  navigator.vibrate?.(8)
}

function renderComposer() {
  if (!shell) return
  const { composerBox, textarea, sendBtn } = shell
  composerBox.hidden = st.tab !== 'chat'
  const attachBox = composerBox.querySelector('.attach-preview') as HTMLElement
  if (st.attach) {
    const img = h('img')
    img.src = `data:image/jpeg;base64,${st.attach}`
    img.alt = '보낼 사진'
    attachBox.replaceChildren(
      img,
      h(
        'button',
        {
          class: 'fbtn small',
          label: '사진 빼기',
          onclick: () => {
            st.attach = undefined
            render()
          },
        },
        icon('close'),
      ),
    )
    attachBox.hidden = false
  } else {
    attachBox.replaceChildren()
    attachBox.hidden = true
  }
  if (textarea.value !== st.draft) {
    textarea.value = st.draft
    autosize(textarea)
  }
  const has = Boolean(st.draft.trim() || st.attach)
  const stop = !has && st.busy
  // 보내기 ↔ 멈추기: 앞 아이콘은 돌며 작아지고 새 아이콘이 톡 커진다
  const mode = stop ? 'stop' : 'send'
  if (sendBtn.dataset.mode !== mode) {
    const first = !sendBtn.dataset.mode
    sendBtn.dataset.mode = mode
    const ic = icon(mode, 'i md')
    sendBtn.replaceChildren(ic)
    if (!first)
      springTo(ic, [{ transform: `scale(0) rotate(${stop ? -90 : 90}deg)` }, { transform: 'none' }], 'morph')
  }
  sendBtn.setAttribute('aria-label', stop ? '멈추기' : '보내기')
  sendBtn.classList.toggle('ready', has)
  sendBtn.classList.toggle('stop', stop)
  sendBtn.disabled = !st.online || (!has && !st.busy)
  if (!shell.textarea.classList.contains('ghosting')) updateGhost()
}

function renderPage() {
  if (!shell) return
  const { page, chat } = shell
  page.dataset.tab = st.tab
  if (st.tab === 'chat') {
    if (page.firstChild !== chat || page.childNodes.length !== 1) page.replaceChildren(chat)
    syncChat()
    if (stickToBottom) requestAnimationFrame(() => page.scrollTo({ top: page.scrollHeight }))
    return
  }
  const y = page.scrollTop
  const ctx = lifeCtx()
  page.replaceChildren(
    st.tab === 'feed'
      ? feedView(ctx)
      : st.tab === 'ideas'
        ? ideasView()
        : st.tab === 'goals'
          ? goalsView(ctx)
          : st.tab === 'library'
            ? libraryView(ctx)
            : st.tab === 'settings'
              ? settingsView()
              : connectView(),
  )
  page.scrollTop = y
}

// ── 대화: 바뀐 말만 ──

/** 대화 목록에 있어야 할 것 (key, 서명, 만들기). 서명이 같으면 그대로 둔다 */
type Item = { key: string; sig: string; make: () => HTMLElement }

function chatItems(): Item[] {
  const items: Item[] = []
  if (st.pcSilent) items.push({ key: 'silent', sig: st.saved?.pcName ?? '', make: silentCard })
  const first = st.conv[0]
  if (st.hasMore && first)
    items.push({
      key: 'more',
      sig: first.id,
      make: () =>
        h('button', {
          class: 'btn-text more',
          text: '이전 대화 더 보기',
          onclick: () => void send({ kind: 'conversation', before: first.createdAt }),
        }),
    })
  if (st.convLoaded && !st.conv.length && !st.pending.length)
    items.push({ key: 'hello', sig: st.saved?.pcName ?? '', make: helloCard })
  for (const m of st.conv) {
    if (m.role === 'tool') items.push({ key: m.id, sig: toolSig(m.text), make: () => toolCard(m.text) })
    else if (m.role === 'user') {
      // 두리 앱이 AI에게 보낸 알림(승인 결과 등)은 내 말이 아니라 가운데 작은 줄로
      const note = readAppNote(m.text)
      items.push({
        key: m.id,
        sig: '',
        make: () => (note !== undefined ? h('p', { class: 'msg note' }, note) : meBubble(m.text)),
      })
    } else if (m.role === 'assistant')
      items.push({
        key: m.id,
        sig: '',
        make: () => {
          const b = h('div', { class: 'bubble rich' })
          b.append(rich(m.text))
          onLongPress(b, () => openOverlay({ kind: 'msg', id: m.id }))
          // 방금 온 답이면 돈·퍼센트가 굴러서 선다 (지난 대화를 불러올 때는 그대로)
          if (Date.now() - Date.parse(m.createdAt) < 60_000) rollNumbers(b)
          return b
        },
      })
    else {
      const note = readAppNote(m.text)
      items.push({
        key: m.id,
        sig: '',
        make: () => h('p', { class: 'msg note', text: note ?? m.text }),
      })
    }
  }
  for (const p of st.pending)
    items.push({
      key: `p${p.id}`,
      sig: '',
      make: () => meBubble(p.text, p.photo, 'bubble me sending'),
    })
  st.queued.forEach((q, i) => {
    items.push({
      key: `q${i}`,
      sig: q,
      make: () =>
        h(
          'div',
          { class: 'queued' },
          h('div', { class: 'bubble me', text: q }),
          h('span', { class: 'meta', text: '이어서 말할게요' }),
        ),
    })
  })
  if (st.busy || st.pending.length) {
    const step = st.steps.at(-1)
    const tab = st.work.tabId
    if (st.work.web && st.busy && tab !== undefined && st.work.shot)
      items.push({ key: 'work', sig: String(tab), make: () => workCard(tab) })
    if (step)
      items.push({
        key: 'step',
        sig: step,
        make: () => h('p', { class: 'meta step' }, h('span', { class: 'dot work pulse' }), step),
      })
    if (st.live) items.push({ key: 'live', sig: '', make: liveBubble })
    else
      items.push({
        key: 'typing',
        sig: '',
        make: thinkingDots,
      })
  }
  return items
}

/** 내 말풍선: 사진을 보냈으면 사진(보낸 직후) 또는 "사진" 표시 */
function meBubble(raw: string, photo?: string, cls = 'bubble me') {
  const { text, photo: name } = splitPhoto(raw)
  const b = h('div', { class: `${cls}${photo || name ? ' with-photo' : ''}` })
  if (photo) {
    const img = h('img', { class: 'sent-photo' })
    img.src = `data:image/jpeg;base64,${photo}`
    img.alt = '보낸 사진'
    b.append(img)
  } else if (name) b.append(h('span', { class: 'photo-chip' }, icon('image', 'i'), '사진'))
  if (text) b.append(h('span', { text }))
  return b
}

/** 길게 누르기 (폰) · 오른쪽 클릭 (PC 브라우저) */
function onLongPress(el: HTMLElement, fn: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let x = 0
  let y = 0
  const cancel = () => clearTimeout(timer)
  el.addEventListener('pointerdown', (e) => {
    x = e.clientX
    y = e.clientY
    timer = setTimeout(() => {
      navigator.vibrate?.(10)
      fn()
    }, 480)
  })
  el.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - x) > 8 || Math.abs(e.clientY - y) > 8) cancel()
  })
  el.addEventListener('pointerup', cancel)
  el.addEventListener('pointercancel', cancel)
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    cancel()
    fn()
  })
}

/** 생각하는 중: 점 셋이 차례로 통통 튀고, 쫀득한 필터로 서로 늘어나 붙는다 */
function thinkingDots() {
  gooFilter()
  return h(
    'span',
    { class: 'typing goo', label: '생각하는 중' },
    h('span', { class: 'goo-dots' }, h('i'), h('i'), h('i')),
  )
}

function liveBubble() {
  const b = h('div', { class: 'bubble rich streaming' })
  b.append(rich(st.live))
  riseWords(b)
  return b
}

/**
 * 흘러오는 답: 새로 온 낱말만 아래에서 떠오르며 또렷해진다.
 * 글을 다시 그릴 때마다 낱말을 감싸고, 앞에서 이미 보인 낱말 수보다 뒤에 있는 것만 움직인다
 */
function riseWords(el: HTMLElement) {
  const seen = Number(el.dataset.words ?? 0)
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  let i = 0
  for (const node of nodes) {
    const parts = (node.textContent ?? '').split(/(\s+)/)
    if (parts.length <= 1 && !parts[0]?.trim()) continue
    const frag = document.createDocumentFragment()
    for (const p of parts) {
      if (!p) continue
      if (/^\s+$/.test(p)) {
        frag.append(p)
        continue
      }
      const w = document.createElement('span')
      w.className = i >= seen ? 'wd wd-in' : 'wd'
      if (i >= seen) w.style.animationDelay = `${Math.min(i - seen, 8) * 35}ms`
      w.textContent = p
      frag.append(w)
      i++
    }
    node.replaceWith(frag)
  }
  el.dataset.words = String(i)
}

function syncChat() {
  const list = shell?.chat
  if (!list) return
  const want = chatItems()
  const have = new Map<string, HTMLElement>()
  for (const el of [...list.children] as HTMLElement[]) if (el.dataset.key) have.set(el.dataset.key, el)
  const keep = new Set<string>()
  let prev: Element | null = null
  for (const it of want) {
    keep.add(it.key)
    let el = have.get(it.key)
    if (el && it.key === 'live') {
      // 흘러오는 답은 글자만 바꾼다
      el.replaceChildren(rich(st.live))
      riseWords(el)
    } else if (!el || el.dataset.sig !== it.sig) {
      const fresh = it.make()
      fresh.dataset.key = it.key
      fresh.dataset.sig = it.sig
      if (!el) fresh.classList.add('rise')
      if (el) el.replaceWith(fresh)
      el = fresh
    }
    const next: Element | null = prev ? prev.nextElementSibling : list.firstElementChild
    if (next !== el) {
      if (prev) prev.after(el)
      else list.prepend(el)
    }
    prev = el
  }
  for (const [k, el] of have) if (!keep.has(k)) el.remove()
}

/** PC가 답하지 않을 때: 빈 화면 대신 이유와 할 일 */
function silentCard() {
  const pc = st.saved?.pcName ?? 'PC'
  return h(
    'div',
    { class: 'card ask-card silent-card' },
    h('div', { class: 'card-label' }, doori('sleeping', 22), `${pc}가 답하지 않아요`),
    h('p', {
      class: 'card-text',
      text: 'PC가 켜져 있고 두리가 실행 중인지 확인해 주세요. PC에서 이 폰 연결을 지웠다면 다시 연결해야 해요.',
    }),
    h(
      'div',
      { class: 'approve-actions' },
      h('button', { class: 'btn-ghost', text: '다시 시도', onclick: () => connect() }),
      h('button', { class: 'btn', text: '다시 연결하기', onclick: () => void forgetPc() }),
    ),
  )
}

function helloCard() {
  return h(
    'div',
    { class: 'hello' },
    h('div', { class: 'bubble', text: `안녕하세요, 두리예요. ${st.saved?.pcName ?? '내 PC'}에서 일해요.` }),
    h('div', {
      class: 'bubble',
      text: '예약·장보기·택배·서류처럼 귀찮은 일을 말로 맡겨 주세요. 돈 쓰는 일은 꼭 먼저 물어볼게요.',
    }),
    h(
      'div',
      { class: 'quick' },
      ...['택배 어디쯤 왔어?', '이번 주 토요일 저녁 7시, 2명 식당 예약해 줘', '뭘 할 수 있어?'].map((q) =>
        h('button', { text: q, onclick: () => ask(q) }),
      ),
    ),
    h(
      'div',
      { class: 'card start-card' },
      h('strong', { text: '처음이면 이렇게 시작해 보세요' }),
      ...(
        [
          ['apps', '1', '자주 쓰는 쇼핑몰·통신사를 연결해 두기', () => setTab('connect')],
          ['feed', '2', '매일 아침 받을 소식 정하기', () => setTab('feed')],
          ['goal', '3', '예약하고 목표 세우기', () => setTab('goals')],
        ] as [IconName, string, string, () => void][]
      ).map(([ic, n, t, go]) =>
        h(
          'button',
          { class: 'start-step', onclick: go },
          h('span', { class: 'start-n', text: n }),
          h('span', { class: 'row-t', text: t }),
          icon(ic, 'i'),
        ),
      ),
    ),
  )
}

function toolSig(raw: string) {
  try {
    const rec = JSON.parse(raw) as { kind?: string }
    if (rec.kind === 'approval') {
      const a = approvalFor(rec as ApprovalRecordMessage)
      return `${a?.id}:${a?.status}:${a ? (st.decided.get(a.id)?.message ?? '') : ''}`
    }
    if (rec.kind === 'login') {
      const l = loginFor(rec as LoginRecordMessage)
      return `${l?.id}:${l?.status}`
    }
    if (rec.kind === 'connect') {
      const it = connectFor(rec as ConnectRecordMessage)
      return `${it?.card.id}:${it?.connectedAt ?? ''}:${it && st.connecting.has(it.card.id)}`
    }
  } catch {}
  return ''
}

function approvalFor(rec: ApprovalRecordMessage) {
  return [...st.approvals.values()]
    .filter((x) => x.tabId === rec.tabId && x.ref === rec.ref)
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0]
}

function loginFor(rec: LoginRecordMessage) {
  return [...st.logins.values()]
    .filter((x) => x.tabId === rec.tabId)
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0]
}

function toolCard(raw: string): HTMLElement {
  let rec: HandoffRecord | ApprovalRecordMessage | LoginRecordMessage | ConnectRecordMessage
  try {
    rec = JSON.parse(raw)
  } catch {
    return h('span')
  }
  if (rec.kind === 'approval') return approvalInline(rec)
  if (rec.kind === 'login') return loginInline(rec)
  if (rec.kind === 'connect') return connectInline(rec)
  // 직접 해 주세요
  const tabId = rec.tabId
  return h(
    'div',
    { class: 'card ask-card' },
    h('div', { class: 'card-label' }, doori('asking', 22), '직접 해 주세요'),
    h('p', { class: 'card-text', text: rec.reason }),
    tabId !== undefined &&
      h('button', { class: 'btn-ghost', text: '폰에서 PC 화면 열기', onclick: () => openRemote(tabId) }),
  )
}

/** 대화 안의 승인 카드: 무엇을 · 얼마 · [거절][승인하기] */
function approvalInline(rec: ApprovalRecordMessage): HTMLElement {
  const a = approvalFor(rec)
  const decided = a ? st.decided.get(a.id) : undefined
  if (!a || a.status !== 'pending' || decided) {
    // 정한 뒤에는 한 줄로: 승인했어요 · 15,900원 · 제주 귤 3kg 바로 구매
    const what = a?.what || rec.what || '승인 요청'
    const failed = (decided && !decided.ok) || a?.status === 'failed'
    const head = failed
      ? '못 눌렀어요'
      : a?.status === 'rejected'
        ? '거절했어요'
        : a?.status === 'expired'
          ? '시간이 지나 취소됐어요'
          : a || decided
            ? '승인했어요'
            : ''
    return h(
      'p',
      { class: `done-line${failed ? ' warn' : ''}` },
      icon(failed || a?.status === 'rejected' ? 'close' : 'check'),
      [head, a?.amount, failed ? (decided?.message ?? what) : what].filter(Boolean).join(' · '),
    )
  }
  const tone: IconName = a.kind === 'money' ? 'cart' : a.kind === 'contact' ? 'mail' : 'hand'
  return h(
    'div',
    { class: 'card approve-card' },
    h(
      'div',
      { class: 'approve-head' },
      h('span', { class: 'tile amber' }, icon(tone, 'i md')),
      h(
        'div',
        {},
        h('strong', { text: approveQuestion(a) }),
        h('span', { class: 'meta', text: [a.where, hostOf(a.url)].filter(Boolean).join(' · ') }),
      ),
    ),
    a.amount && h('p', { class: 'approve-amount', text: a.amount }),
    h('p', { class: 'approve-what', text: a.what }),
    h(
      'div',
      { class: 'approve-actions' },
      h('button', { class: 'btn-ghost', text: '거절', onclick: () => void decide(a, 'reject') }),
      holdButton({
        label: '꾹 눌러 승인',
        done: '승인했어요',
        cls: 'btn btn-approve',
        onDone: () => decide(a, 'approve', true),
        after: () => markDecided(a, 'approve'),
      }),
    ),
    h('button', {
      class: 'btn-link',
      text: '화면 보고 결정하기',
      onclick: () => openOverlay({ kind: 'approval', id: a.id }),
    }),
  )
}

function approveQuestion(a: ApprovalView) {
  if (a.kind === 'money') return '결제할까요?'
  if (a.kind === 'contact') return '보낼까요?'
  if (a.kind === 'app') return '이 PC 앱을 다뤄도 될까요?'
  return '진행할까요?'
}

/** 로그인할 주소가 어느 연결 카드의 사이트인지 (로고) */
function cardIdFor(url: string): string | undefined {
  const host = hostOf(url).replace(/^www\./, '')
  if (!host) return undefined
  return st.services?.find((s) => {
    const site = (s.card.site ?? '').replace(/^www\./, '')
    return site && (host === site || host.endsWith(`.${site}`))
  })?.card.id
}

function hostOf(url: string) {
  if (url.startsWith('app:')) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function connectFor(rec: ConnectRecordMessage) {
  const services = st.services ?? []
  const card = findCard(
    services.map((s) => s.card),
    rec.service,
  )
  return card ? services.find((s) => s.card.id === card.id) : undefined
}

/** 대화 안의 연결 카드 (connect_ask): [연결하기] → 아이디·비밀번호 시트 → 본체가 뒤에서 로그인 */
function connectInline(rec: ConnectRecordMessage): HTMLElement {
  const it = connectFor(rec)
  if (!it) return h('p', { class: 'done-line' }, icon('link'), `${rec.service} 연결 카드를 찾지 못했어요`)
  const c = it.card
  const mark = (big = false) =>
    withLogo(
      h('span', {
        class: big ? 'svc-mark' : 'svc-mark sm',
        text: /^\d+/.exec(c.name)?.[0] ?? [...c.name][0] ?? '',
      }),
      c.id,
    )
  if (it.connectedAt) return h('p', { class: 'done-line connect-line' }, mark(), `${c.name} 연결돼 있어요`)
  const busy = st.connecting.has(c.id)
  const browser = c.how === 'browser'
  return h(
    'div',
    { class: 'card approve-card connect-card' },
    h(
      'div',
      { class: 'approve-head' },
      mark(true),
      h(
        'div',
        {},
        h('strong', { text: busy ? `${c.name}에 로그인하는 중이에요` : `${c.name} 연결` }),
        h('span', {
          class: 'meta',
          text: busy
            ? 'PC에서 두리가 하고 있어요. 다른 일을 하셔도 돼요'
            : browser
              ? '아이디·비밀번호를 넣으면 두리가 PC에서 로그인해요'
              : '연결 화면에서 켜요',
        }),
      ),
      busy ? h('span', { class: 'spin' }) : undefined,
    ),
    busy
      ? undefined
      : h(
          'div',
          { class: 'approve-actions' },
          browser
            ? h('button', {
                class: 'btn-ghost',
                text: '화면 보며 직접',
                onclick: () => {
                  st.opening = c.id
                  render()
                  void send({ kind: 'connect', id: c.id, action: 'open' })
                },
              })
            : undefined,
          h('button', {
            class: 'btn',
            text: '연결하기',
            onclick: () => {
              if (browser) return openOverlay({ kind: 'connect', id: c.id })
              st.tab = 'connect'
              st.connectDetail = c.id
              render()
            },
          }),
        ),
  )
}

function loginInline(rec: LoginRecordMessage): HTMLElement {
  const r = loginFor(rec)
  if (!r || r.status !== 'pending')
    return h(
      'p',
      { class: 'done-line' },
      icon('lock'),
      r?.status === 'saved'
        ? `${r.site} 로그인 정보를 PC 금고에 저장했어요`
        : `${rec.site || '사이트'} 로그인 요청이 끝났어요`,
    )
  return h(
    'div',
    { class: 'card approve-card' },
    h(
      'div',
      { class: 'approve-head' },
      withLogo(h('span', { class: 'svc-mark', text: [...r.site][0] ?? '' }), cardIdFor(r.origin)),
      h(
        'div',
        {},
        h('strong', { text: `${r.site} 로그인이 필요해요` }),
        h('span', { class: 'meta', text: hostOf(r.origin) }),
      ),
    ),
    h(
      'div',
      { class: 'approve-actions' },
      h('button', { class: 'btn-ghost', text: '화면 보며 직접', onclick: () => openRemote(r.tabId) }),
      h('button', {
        class: 'btn',
        text: '로그인하기',
        onclick: () => openOverlay({ kind: 'login', id: r.id }),
      }),
    ),
  )
}

// ── 맡긴 일 ──

/** 피드 맨 위: 나를 기다리는 것·지금 하는 일·다음 차례 */
function waitingCards(): HTMLElement[] {
  const box = h('div', { class: 'waiting' })
  const approvals = pendingApprovals()
  const logins = pendingLogins()
  if (approvals.length || logins.length) {
    box.append(h('h2', { class: 'over', text: '나를 기다려요' }))
    for (const a of approvals)
      box.append(
        h(
          'button',
          { class: 'task-card ask', onclick: () => openOverlay({ kind: 'approval', id: a.id }) },
          h('span', { class: 'meta' }, h('span', { class: 'dot ask' }), '승인을 기다려요'),
          h('strong', { text: [a.what, a.amount].filter(Boolean).join(' · ') }),
          h('span', { class: 'meta', text: a.where }),
        ),
      )
    for (const l of logins)
      box.append(
        h(
          'button',
          { class: 'task-card ask', onclick: () => openOverlay({ kind: 'login', id: l.id }) },
          h('span', { class: 'meta' }, h('span', { class: 'dot ask' }), '로그인이 필요해요'),
          h('strong', { text: `${l.site} 로그인` }),
          h('span', { class: 'meta', text: hostOf(l.origin) }),
        ),
      )
  }
  if (st.busy) {
    const log = h('ul', { class: 'worklog' })
    if (st.steps.length < shownSteps) shownSteps = 0
    st.steps.forEach((s, i) => {
      const li = h('li', { class: i === st.steps.length - 1 ? 'now' : 'done', text: s })
      // 새 단계가 오면: 방금 끝난 단계의 동그라미가 톡, 새 단계는 아래에서 떠오른다
      if (i >= shownSteps && i > 0) {
        springTo(
          li,
          [
            { opacity: 0, transform: 'translateY(10px)' },
            { opacity: 1, transform: 'none' },
          ],
          'item',
        )
        const prev = log.lastElementChild
        if (prev)
          springTo(prev, [{ transform: 'scale(0.6)' }, { transform: 'scale(1)' }], 'pop', {}, '::before')
      }
      log.append(li)
    })
    shownSteps = st.steps.length
    box.append(
      h('h2', { class: 'over', text: '지금 하는 일' }),
      h(
        'div',
        { class: 'task-card' },
        h('span', { class: 'meta' }, h('span', { class: 'dot work pulse' }), '하는 중'),
        h('strong', { text: lastUserText() ?? '부탁하신 일' }),
        st.steps.length ? log : h('span', { class: 'meta', text: '대답을 쓰는 중이에요' }),
        h('button', {
          class: 'btn-text',
          text: '멈추기',
          onclick: () => void send({ kind: 'conversation-cancel' }),
        }),
      ),
    )
  }
  if (st.queued.length) {
    box.append(h('h2', { class: 'over', text: '다음 차례' }))
    for (const q of st.queued) box.append(h('div', { class: 'row' }, h('span', { class: 'row-t', text: q })))
  }
  return box.childNodes.length ? [box] : []
}

function lifeAct(a: LifeAction) {
  void send({ kind: 'life-action', ...a })
}

function lifeCtx(): LifeCtx {
  return {
    ...(st.life ? { life: st.life } : {}),
    online: st.online,
    act: lifeAct,
    ask: (text) => ask(text),
    fill: (text) => {
      st.draft = text
      setTab('chat')
      requestAnimationFrame(() => {
        shell?.textarea.focus()
        shell?.textarea.setSelectionRange(text.length, text.length)
      })
    },
    openGoal: (id) => openOverlay({ kind: 'goal', id }),
    openItem: (id) => openOverlay({ kind: 'item', id }),
    close: () => openOverlay(undefined),
    waiting: waitingCards(),
    librarySeg: st.librarySeg,
    setLibrarySeg: (seg) => {
      st.librarySeg = seg
      render()
    },
  }
}

function lastUserText() {
  return [
    ...st.pending.map((p) => p.text).reverse(),
    ...[...st.conv]
      .reverse()
      .filter((m) => m.role === 'user')
      .map((m) => m.text),
  ][0]
}

/** 답을 한 줄 미리 보기로: 굵게·목록 표시를 빼고 공백을 줄인다 */
function plainPreview(text: string, max = 80) {
  const t = text
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * 맡긴 일 목록 (최근 6개). 부탁 하나가 일 하나:
 * - 두리가 되물어서 이어 답한 말("동탄역"), 앱 알림(승인 결과)은 새 일이 아니라 앞 일에 이어 붙인다
 * - 제목은 처음 부탁, 설명은 마지막 답
 */
function recentDone() {
  const out: { ask: string; answer: string; at: string; id: string }[] = []
  let open: { ask: string; asked: boolean } | undefined
  let last: { text: string; at: number } | undefined
  for (const m of st.conv) {
    if (m.role === 'user') {
      // 두리가 묻고 바로 짧게 답한 말("동탄역")은 앞 일의 이어짐
      const quickReply =
        !!last && m.text.trim().length <= 8 && Date.parse(m.createdAt) - last.at < 10 * 60_000
      const followUp = readAppNote(m.text) !== undefined || quickReply
      if (!followUp || !out.length) open = { ask: m.text, asked: true }
      else open = { ask: '', asked: false }
    } else if (m.role === 'assistant') {
      last = { text: m.text, at: Date.parse(m.createdAt) }
      const item = { answer: plainPreview(m.text), at: m.createdAt, id: m.id }
      if (open?.asked) out.push({ ask: open.ask, ...item })
      else if (out.length) Object.assign(out[out.length - 1] as object, item)
      open = undefined
    }
  }
  return out.reverse().slice(0, 6)
}

/** 대화 탭으로 가서 그 말이 보이게 */
function showInChat(id: string) {
  setTab('chat')
  requestAnimationFrame(() => {
    const el = shell?.chat.querySelector<HTMLElement>(`[data-key="${CSS.escape(id)}"]`)
    if (!el) return
    stickToBottom = false
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 1400)
  })
}

function emptyState(mood: string, title: string, sub: string) {
  return h(
    'div',
    { class: 'empty' },
    doori(mood, 64),
    h('strong', { text: title }),
    h('span', { class: 'meta', text: sub }),
  )
}

// ── 아이디어 ──

/** 연결하고 나서 미뤄 둔 아이디어를 보낸다 (10분 안에 연결했을 때만) */
function runAfterConnect(id: string) {
  const p = st.afterConnect
  if (!p || p.id !== id) return
  st.afterConnect = undefined
  if (Date.now() - p.at < 10 * 60_000) setTimeout(() => ask(p.text), 400)
}

function tapIdea(it: IdeaItem) {
  if (needsConnect(it) && it.service) {
    st.afterConnect = { id: it.service.id, text: it.ask, at: Date.now() }
    openOverlay({ kind: 'connect', id: it.service.id })
    return
  }
  ask(it.ask)
}

function ideaRow(it: IdeaItem, sec: IdeaSection) {
  const lead = it.service
    ? withLogo(h('span', { class: 'svc-mark', text: it.service.mark }), it.service.id)
    : emoTile(sec.emo)
  return h(
    'button',
    { class: 'idea', onclick: () => tapIdea(it) },
    lead,
    h(
      'span',
      { class: 'row-text' },
      h('span', { class: 'row-t', text: it.text }),
      h('span', { class: 'row-d', text: it.note }),
    ),
    needsConnect(it) ? h('span', { class: 'idea-tag', text: '연결' }) : undefined,
  )
}

function ideasView() {
  const groups = ideaCatalog(st.services ?? [])
  const box = h(
    'section',
    { class: 'tab-page' },
    h('h1', { class: 'ptitle', text: '아이디어' }),
    h('p', { class: 'psub', text: `누르면 두리가 바로 시작해요 · ${ideaCount(groups)}가지` }),
  )
  // 두리가 먼저 찾은 할 일 (기억·목표·연결 기반, 매일 아침 새로)
  const ideas = st.life?.ideas ?? []
  const busy = Boolean(st.life?.ideasBusy)
  const refresh = h('button', {
    class: 'btn-ghost small',
    text: busy ? '찾는 중…' : ideas.length ? '새로 찾기' : '찾아 줘',
    onclick: () => lifeAct({ action: 'ideas-refresh' }),
  })
  refresh.disabled = busy || !st.online
  box.append(
    h(
      'div',
      { class: 'card suggested' },
      h(
        'div',
        { class: 'suggested-head' },
        doori(busy ? 'thinking' : '', 28),
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-t', text: '오늘의 추천' }),
          h('span', { class: 'row-d', text: '나에게 맞춰 매일 아침 새로 골라요' }),
        ),
        refresh,
      ),
      // 둘 이상이면 카드 더미로: 오른쪽으로 넘기면 맡기고, 왼쪽은 다음에
      ...(ideas.length > 1
        ? [swipeDeck(ideas, { onTake: (text) => ask(text) })]
        : ideas.map((i) =>
            h(
              'button',
              { class: 'idea', onclick: () => ask(i.text) },
              emoTile('bulb'),
              h(
                'span',
                { class: 'row-text' },
                h('span', { class: 'row-t', text: i.text }),
                h('span', { class: 'row-d', text: i.why }),
              ),
            ),
          )),
    ),
  )

  // 찾기 + 분류. 글자를 칠 때마다 페이지 전체를 다시 그리면 한글 조합이 끊기므로 아래 목록만 다시 그린다
  const wasTyping = document.activeElement?.id === 'idea-search'
  const search = h('input', { class: 'field idea-search' })
  search.id = 'idea-search'
  search.type = 'search'
  search.placeholder = '아이디어 찾기 (택배, 항공권, 영수증…)'
  search.value = st.ideaQuery
  if (wasTyping)
    queueMicrotask(() => {
      search.focus()
      search.setSelectionRange(search.value.length, search.value.length)
    })
  const chips = h('div', { class: 'chips idea-cats' })
  const body = h('div', { class: 'idea-body' })
  const list = (items: { section: IdeaSection; item: IdeaItem }[]) =>
    h('div', { class: 'idea-list' }, ...items.map((x) => ideaRow(x.item, x.section)))
  const pick = (id: string) => {
    st.ideaCat = id
    st.ideaQuery = ''
    search.value = ''
    draw()
    chips.querySelector('.chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' })
    chips.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  const draw = () => {
    const cat = groups.some((g) => g.section.id === st.ideaCat) ? st.ideaCat : 'all'
    const q = st.ideaQuery.trim()
    const chip = (id: string, label: string) =>
      h('button', {
        class: `chip quiet${cat === id && !q ? ' on' : ''}`,
        text: label,
        onclick: () => pick(id),
      })
    chips.replaceChildren(chip('all', '전체'), ...groups.map((g) => chip(g.section.id, g.section.label)))
    body.replaceChildren()
    if (q) {
      const found = searchIdeas(groups, q)
      if (found.length) body.append(list(found))
      body.append(
        h(
          'button',
          { class: 'idea idea-raw', onclick: () => ask(q) },
          h('span', { class: 'tile' }, icon('send', 'i md')),
          h(
            'span',
            { class: 'row-text' },
            h('span', { class: 'row-t', text: `"${q}" 그대로 부탁하기` }),
            h('span', {
              class: 'row-d',
              text: found.length
                ? '찾는 게 없으면 그냥 말해 보세요'
                : '맞는 아이디어가 없어요. 그래도 두리가 해 볼게요',
            }),
          ),
        ),
      )
      return
    }
    if (cat === 'all') {
      for (const g of groups) {
        const sec = g.section
        body.append(
          h(
            'button',
            { class: 'idea-sec-head', onclick: () => pick(sec.id) },
            emoTile(sec.emo, 'sm'),
            h('strong', { text: sec.label }),
            h('span', { class: 'meta', text: `${g.items.length}가지` }),
            icon('chevron', 'i chev'),
          ),
          list(g.items.slice(0, 3).map((item) => ({ section: sec, item }))),
        )
      }
      return
    }
    const g = groups.find((x) => x.section.id === cat)
    if (!g) return
    const ready = g.items.filter((i) => !needsConnect(i))
    const later = g.items.filter(needsConnect)
    if (ready.length)
      body.append(
        h('h2', { class: 'over', text: '바로 할 수 있어요' }),
        list(ready.map((item) => ({ section: g.section, item }))),
      )
    if (later.length)
      body.append(
        h('h2', { class: 'over', text: '연결하면 할 수 있어요' }),
        h('p', {
          class: 'meta idea-later',
          text: '누르면 아이디·비밀번호를 한 번 넣고, 연결되면 바로 시작해요',
        }),
        list(later.map((item) => ({ section: g.section, item }))),
      )
  }
  search.oninput = () => {
    st.ideaQuery = search.value
    draw()
  }
  draw()
  box.append(search, chips, body)

  box.append(
    h(
      'div',
      { class: 'card ask-card' },
      h('div', { class: 'card-label' }, doori('asking', 22), '이건 직접 해 주셔야 해요'),
      h('p', {
        class: 'card-text',
        text: '본인인증, 보안 문자, 공동인증서. 대신 그 화면을 폰에 바로 띄워 드릴게요.',
      }),
    ),
  )
  return box
}

// ── 연결 (connections.ts) ──

function connectCtx(): ConnectCtx {
  return {
    ...(st.services ? { services: st.services } : {}),
    query: st.connectQuery,
    connecting: st.connecting,
    online: st.online,
    ...(st.opening ? { opening: st.opening } : {}),
    header: (title, back) =>
      h(
        'div',
        { class: back ? 'page-head sub' : 'page-head' },
        back && h('button', { class: 'fbtn small', label: '뒤로', onclick: back }, icon('back')),
        title && h(back ? 'h2' : 'h1', { class: back ? 'title-2' : 'ptitle', text: title }),
      ),
    home: () => setTab('chat'),
    list: () => {
      st.connectDetail = undefined
      render()
      shell?.page.scrollTo({ top: 0 })
    },
    detail: (id) => {
      st.connectDetail = id
      render()
      shell?.page.scrollTo({ top: 0 })
    },
    setQuery: (q) => {
      st.connectQuery = q
      render()
      const input = document.getElementById('connect-search') as HTMLInputElement | null
      input?.focus()
      input?.setSelectionRange(q.length, q.length)
    },
    open: (id) => openOverlay({ kind: 'connect', id }),
    mark: (id, on) => void send({ kind: 'connect', id, action: on ? 'mark' : 'unmark' }),
    tryAsk: (text) => ask(text),
  }
}

function connectView() {
  return st.connectDetail ? serviceView(connectCtx(), st.connectDetail) : connectionsView(connectCtx())
}

// ── 겹쳐 뜨는 것: 메뉴 서랍 · 두리 패널 · 승인 시트 · 로그인 시트 ──

function renderOverlay() {
  const o = shell?.overlay
  if (!o) return
  const ov = st.overlay
  if (!ov) {
    o.replaceChildren()
    o.hidden = true
    delete o.dataset.key
    return
  }
  o.hidden = false
  // 꾹 누르는 중·보내는 중에 다시 그리면 버튼이 처음으로 돌아가서, 그동안은 그대로 둔다
  const key = 'id' in ov ? `${ov.kind}:${ov.id}` : ov.kind
  if (o.dataset.key === key && o.querySelector('.hold.holding, .hold.busy, .hold.done')) return
  const opening = o.dataset.key !== key
  o.dataset.key = key
  o.dataset.kind = ov.kind
  const scrim = h('div', { class: 'scrim', onclick: () => openOverlay(undefined) })
  const body =
    ov.kind === 'drawer'
      ? drawerView()
      : ov.kind === 'agent'
        ? agentPanel()
        : ov.kind === 'approval'
          ? approvalSheet(ov.id)
          : ov.kind === 'connect'
            ? connectSheet(ov.id)
            : ov.kind === 'goal'
              ? goalSheet(lifeCtx(), ov.id)
              : ov.kind === 'item'
                ? itemSheet(lifeCtx(), ov.id)
                : ov.kind === 'msg'
                  ? msgSheet(ov.id)
                  : ov.kind === 'plus'
                    ? plusSheet()
                    : ov.kind === 'info'
                      ? infoSheet(ov.id)
                      : loginSheet(ov.id)
  // 입력 중인 칸은 다시 그려도 커서를 잃지 않게
  const active = document.activeElement
  const typing =
    active instanceof HTMLInputElement && o.contains(active)
      ? { id: active.id, s: active.selectionStart }
      : undefined
  o.replaceChildren(scrim, body)
  // 처음 열 때만: 메뉴 줄이 하나씩 떠오른다
  if (opening) riseIn(body.querySelectorAll(':scope > .set-row, :scope > .navi, :scope > .row'))
  if (typing?.id) {
    const el = document.getElementById(typing.id) as HTMLInputElement | null
    el?.focus()
    if (typing.s !== null) el?.setSelectionRange(typing.s, typing.s)
  }
}

function drawerView() {
  const tabs: [Tab, IconName, string][] = [
    ['chat', 'chat', '대화'],
    ['feed', 'feed', '피드'],
    ['ideas', 'idea', '아이디어'],
    ['goals', 'goal', '목표'],
    ['library', 'library', '보관함'],
  ]
  const navi = (tab: Tab, ic: IconName, label: string, extra?: Node) =>
    h(
      'button',
      { class: st.tab === tab ? 'navi on' : 'navi', onclick: () => setTab(tab) },
      icon(ic, 'i md'),
      label,
      extra,
    )
  const connected = (st.services ?? []).filter((x) => x.connectedAt).length
  return h(
    'aside',
    { class: 'drawer app-drawer' },
    h('div', { class: 'drawer-title' }, doori('', 28), '두리'),
    ...tabs.map(([t, ic, label]) => navi(t, ic, label)),
    h(
      'div',
      { class: 'drawer-sec side-head' },
      h('span', { class: 'over', text: '따로 하는 대화' }),
      h('button', { class: 'fbtn small', label: '새 대화', onclick: newSide }, icon('pencil')),
    ),
    ...sideThreads()
      .slice(0, 12)
      .map((t) =>
        h(
          'button',
          { class: 'navi side-item', onclick: () => openSide(t.id, t.title) },
          h('span', { class: t.busy ? 'dot work pulse' : 'dot' }),
          h('span', { class: 'side-name', text: t.title }),
        ),
      ),
    h('p', { class: 'over drawer-sec', text: '설정' }),
    navi(
      'connect',
      'apps',
      '연결',
      connected ? h('span', { class: 'meta navi-count', text: `${connected}곳` }) : undefined,
    ),
    navi('settings', 'gear', '설정'),
    h(
      'div',
      { class: 'navi static' },
      icon('pc', 'i md'),
      h(
        'span',
        { class: 'row-text' },
        h('span', { text: st.saved?.pcName ?? '내 PC' }),
        h('span', {
          class: 'meta',
          text: !st.online ? '연결 중…' : st.pcSilent ? '답하지 않아요' : '연결돼 있어요',
        }),
      ),
    ),
    h('p', { class: 'meta drawer-foot', text: '주고받는 내용은 PC와 이 폰만 열 수 있게 암호화돼요.' }),
  )
}

/** 내 PC 이름 바꾸기: PC 설정에 저장돼서, 같은 PC에 연결한 다른 폰에도 새 이름이 보여요 */
function renamePc() {
  if (!st.online) return toast('PC와 연결된 뒤에 바꿀 수 있어요')
  const name = prompt('이 PC를 뭐라고 부를까요? (예: 집 맥북, 회사 PC)', st.saved?.pcName ?? '')?.trim()
  if (!name || name === st.saved?.pcName) return
  void send({ kind: 'rename-pc', name: name.slice(0, 40) })
  toast(`"${name.slice(0, 40)}"(으)로 바꿨어요`)
}

/** 설정 (메뉴 > 설정): 알림·화면·내 PC·약속 */
// ── 앱으로 설치 (PWA): 안드로이드·PC 크롬은 설치 창, 아이폰은 공유 → 홈 화면에 추가 ──

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
let installPrompt: InstallPrompt | undefined
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  installPrompt = e as InstallPrompt
  render()
})
addEventListener('appinstalled', () => {
  installPrompt = undefined
  toast('홈 화면에 두리를 추가했어요')
})
const installed = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent)

function installRow(
  row: (ic: IconName, title: string, sub: string, right?: Node, onclick?: () => void) => HTMLElement,
) {
  if (installed()) return row('check', '앱으로 쓰는 중', '홈 화면에서 열었어요')
  if (installPrompt)
    return row(
      'plus',
      '홈 화면에 두리 추가',
      '앱처럼 바로 열고, 알림도 받아요',
      h('span', { class: 'btn small', text: '추가' }),
      () => {
        const p = installPrompt
        installPrompt = undefined
        void p?.prompt().then(() => render())
      },
    )
  if (isIos())
    return row('plus', '홈 화면에 두리 추가', '사파리 아래 공유 버튼 → "홈 화면에 추가"를 눌러 주세요')
  return row('plus', '홈 화면에 두리 추가', '브라우저 메뉴에서 "앱 설치" 또는 "홈 화면에 추가"를 눌러 주세요')
}

function settingsView() {
  const box = h('section', { class: 'tab-page settings' }, h('h1', { class: 'ptitle', text: '설정' }))
  const row = (ic: IconName, title: string, sub: string, right?: Node, onclick?: () => void) =>
    h(
      onclick ? 'button' : 'div',
      { class: 'set-row', ...(onclick ? { onclick } : {}) },
      h('span', { class: 'tile sm blue' }, icon(ic, 'i')),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: title }),
        h('span', { class: 'row-d', text: sub }),
      ),
      right,
    )
  const perm = 'Notification' in window ? Notification.permission : 'denied'
  box.append(h('h2', { class: 'over', text: '앱' }), installRow(row))
  box.append(
    h('h2', { class: 'over', text: '알림' }),
    row(
      'bell',
      '폰 알림',
      perm === 'granted'
        ? '켜져 있어요 · 승인 요청·끝낸 일·피드 새 글'
        : perm === 'denied'
          ? '브라우저 설정에서 막혀 있어요'
          : '꺼져 있어요',
      perm === 'default' ? h('span', { class: 'btn small', text: '켜기' }) : undefined,
      perm === 'default'
        ? () =>
            void Notification.requestPermission().then(() => {
              void syncPush()
              render()
            })
        : undefined,
    ),
  )
  const theme = document.documentElement.dataset.theme ?? 'auto'
  const seg = h('div', { class: 'seg' })
  for (const [id, label] of [
    ['auto', '기기 따라'],
    ['light', '밝게'],
    ['dark', '어둡게'],
  ] as const)
    seg.append(
      segBtn(theme === id, {
        text: label,
        onclick: () => {
          document.documentElement.dataset.theme = id
          localStorage.setItem('dool2-theme', id)
          render()
        },
      }),
    )
  box.append(h('h2', { class: 'over', text: '화면' }), seg)
  box.append(
    h('h2', { class: 'over', text: '내 PC' }),
    row(
      'pc',
      st.saved?.pcName ?? '내 PC',
      !st.online
        ? '연결 중…'
        : st.pcSilent
          ? '답하지 않아요'
          : '연결돼 있어요 · 두리는 이 PC의 Chrome에서 일해요',
      h('span', { class: 'meta', text: '이름 바꾸기' }),
      () => renamePc(),
    ),
    row(
      'apps',
      '연결한 서비스',
      `${(st.services ?? []).filter((x) => x.connectedAt).length}곳 · 아이디·비밀번호는 PC 금고에만`,
      icon('chevron'),
      () => setTab('connect'),
    ),
    row('close', '다른 PC와 다시 연결', '이 폰의 연결을 지우고 QR을 다시 찍어요', undefined, () => {
      if (confirm('이 폰의 PC 연결을 지울까요? PC에서 QR을 다시 찍으면 다시 연결돼요.')) void forgetPc()
    }),
  )
  box.append(h('h2', { class: 'over', text: '두리의 약속' }))
  for (const [ic, t] of [
    ['card', '돈 쓰는 일과 메시지 보내기는 꼭 먼저 물어봐요. 이건 끌 수 없어요.'],
    ['lock', '비밀번호와 카드 번호는 두리(AI)도 저희도 못 봐요.'],
    ['pc', '대화·기억·보관함은 내 PC에만 저장돼요. 폰과 PC 사이는 암호화돼요.'],
    ['hand', '본인인증·보안 문자는 화면을 띄워 드리고 직접 하시게 해요.'],
  ] as [IconName, string][])
    box.append(
      h(
        'div',
        { class: 'set-row' },
        h('span', { class: 'tile sm mint' }, icon(ic, 'i')),
        h('span', { class: 'row-t', text: t }),
      ),
    )
  return box
}

/** 입력칸 + : 아이디어·목표·피드·따로 하는 대화·연결 */
function plusSheet() {
  const item = (ic: IconName, tone: string, title: string, sub: string, onclick: () => void) =>
    h(
      'button',
      { class: 'set-row', onclick },
      h('span', { class: `tile sm ${tone}` }, icon(ic, 'i')),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: title }),
        h('span', { class: 'row-d', text: sub }),
      ),
    )
  return h(
    'section',
    { class: 'sheet float app-sheet rise plus-sheet' },
    item('image', 'blue', '사진 보내기', '영수증·캡처·상품 사진을 보여 주고 부탁하기', () => pickPhoto()),
    item('idea', 'amber', '아이디어', '두리에게 맡길 만한 일 보기', () => setTab('ideas')),
    item('goal', 'rose', '목표·알림 만들기', '매일 아침 브리핑, 운동, 저축…', () => setTab('goals')),
    item('feed', 'blue', '피드 받기', '매일 아침 받을 소식 정하기', () => setTab('feed')),
    item('pencil', 'violet', '따로 하는 대화', '여행 준비처럼 긴 주제는 따로', () => newSide()),
    item('apps', 'mint', '서비스 연결', '쇼핑몰·통신사·예매 사이트 로그인해 두기', () => setTab('connect')),
  )
}

/** 답을 길게 누르면: 보관함에 남기기 · 복사 */
function msgSheet(id: string) {
  const m = st.conv.find((x) => x.id === id)
  const sheet = h('section', { class: 'sheet float app-sheet rise msg-sheet' })
  if (!m) return sheet
  const title = plain(m.text, 30)
  sheet.append(
    h('p', { class: 'msg-quote', text: plain(m.text, 140) }),
    h(
      'button',
      {
        class: 'set-row',
        onclick: () => {
          lifeAct({ action: 'library-save', title, body: m.text })
          openOverlay(undefined)
          toast('보관함에 남겼어요')
        },
      },
      h('span', { class: 'tile sm amber' }, icon('bookmark', 'i')),
      h('span', { class: 'row-t', text: '보관함에 남기기' }),
    ),
    h(
      'button',
      {
        class: 'set-row',
        onclick: (e: MouseEvent) => {
          const row = e.currentTarget as HTMLElement
          void navigator.clipboard?.writeText(m.text).then(
            () => {
              // 복사 아이콘이 돌며 작아지고 체크가 그려진다, 글은 '복사했어요'로 올라간다
              const tile = row.querySelector('.tile') as HTMLElement
              const label = row.querySelector('.row-t') as HTMLElement
              const ok = icon('check', 'i')
              tile.replaceChildren(ok)
              tile.classList.replace('blue', 'mint')
              drawCheck(ok)
              label.textContent = '복사했어요'
              springTo(
                label,
                [
                  { opacity: 0, transform: 'translateY(10px)' },
                  { opacity: 1, transform: 'none' },
                ],
                'fade',
              )
              setTimeout(() => openOverlay(undefined), 700)
            },
            () => {
              toast('복사하지 못했어요')
              openOverlay(undefined)
            },
          )
        },
      },
      h('span', { class: 'tile sm blue' }, icon('copy', 'i')),
      h('span', { class: 'row-t', text: '복사' }),
    ),
    h('button', { class: 'btn-ghost wide', text: '닫기', onclick: () => openOverlay(undefined) }),
  )
  return sheet
}

function agentPanel() {
  const waiting = pendingApprovals().length + pendingLogins().length
  const mood = !st.online || st.pcSilent ? 'sleeping' : waiting ? 'asking' : st.busy ? 'working' : ''
  const segs: [typeof st.agentSeg, IconName, string][] = [
    ['upcoming', 'clock', '예정'],
    ['memory', 'brain', '기억'],
    ['screen', 'pc', '화면'],
    ['activity', 'list', '활동'],
    ['approvals', 'hand', '승인'],
  ]
  const seg = h(
    'div',
    { class: 'agent-icons' },
    ...segs.map(([id, ic, label]) => {
      const b = h(
        'button',
        {
          class: st.agentSeg === id ? 'on' : '',
          label,
          onclick: () => {
            st.agentSeg = id
            render()
          },
        },
        h(
          'span',
          { class: 'ic' },
          icon(ic, 'i md'),
          id === 'approvals' && waiting ? h('span', { class: 'badge' }) : undefined,
        ),
        h('span', { class: 'lb', text: label }),
      )
      b.setAttribute('aria-pressed', String(st.agentSeg === id))
      return b
    }),
  )
  const body = h('div', { class: 'agent-body' })
  const ctx = lifeCtx()
  const act = (tile: Node, title: string, sub?: string, time?: string, onclick?: () => void) =>
    h(
      onclick ? 'button' : 'div',
      { class: 'act-row', ...(onclick ? { onclick } : {}) },
      tile,
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: title }),
        sub && h('span', { class: 'row-d', text: sub }),
      ),
      time && h('span', { class: 'meta', text: time }),
    )
  if (st.agentSeg === 'upcoming') body.append(...upcomingSeg(ctx))
  else if (st.agentSeg === 'memory') body.append(...memorySeg(ctx))
  else if (st.agentSeg === 'screen') {
    const tab = st.pc?.activeTab
    body.append(
      h('p', {
        class: 'meta seg-note',
        text: '두리가 PC의 Chrome에서 보고 있는 화면을 실시간으로 봐요. 직접 누르면 두리는 잠깐 멈춰요.',
      }),
      tab !== undefined
        ? h('button', { class: 'btn wide', onclick: () => openRemote(tab) }, icon('pc'), '두리 화면 보기')
        : h('p', {
            class: 'meta seg-empty',
            text: '지금 두리가 연 화면이 없어요. 웹에서 일을 시작하면 볼 수 있어요.',
          }),
    )
  } else if (st.agentSeg === 'activity') {
    if (st.busy)
      body.append(
        act(
          h('span', { class: 'tile sm mint' }, icon('globe', 'i')),
          st.steps.at(-1) ?? '대답하는 중',
          lastUserText(),
        ),
      )
    const done = (st.life?.feed ?? []).filter((f) => f.kind === 'done' || f.kind === 'routine').slice(0, 30)
    for (const f of done)
      body.append(
        act(
          h(
            'span',
            { class: `tile sm ${f.kind === 'done' ? 'blue' : 'violet'}` },
            icon(f.kind === 'done' ? 'check' : 'clock', 'i'),
          ),
          withoutPhotoMark(f.title),
          f.body ? plain(f.body, 70) : undefined,
          shortTime(f.at),
        ),
      )
    if (!done.length && !st.busy)
      body.append(h('p', { class: 'meta seg-empty', text: '아직 한 일이 없어요' }))
  } else {
    const approvals = pendingApprovals()
    const logins = pendingLogins()
    for (const a of approvals)
      body.append(
        act(
          h('span', { class: 'tile sm amber' }, icon('card', 'i')),
          [a.what, a.amount].filter(Boolean).join(' · '),
          a.where,
          '기다려요',
          () => openOverlay({ kind: 'approval', id: a.id }),
        ),
      )
    for (const l of logins)
      body.append(
        act(
          h('span', { class: 'tile sm amber' }, icon('lock', 'i')),
          `${l.site} 로그인`,
          hostOf(l.origin),
          '기다려요',
          () => openOverlay({ kind: 'login', id: l.id }),
        ),
      )
    const history = [...st.approvals.values()]
      .filter((a) => a.status !== 'pending')
      .slice(-10)
      .reverse()
    for (const a of history)
      body.append(
        act(
          h('span', { class: 'tile sm mint' }, icon(a.status === 'rejected' ? 'close' : 'check', 'i')),
          [a.what, a.amount].filter(Boolean).join(' · '),
          a.status === 'rejected' ? '거절했어요' : a.status === 'expired' ? '시간이 지났어요' : '승인했어요',
        ),
      )
    if (!approvals.length && !logins.length && !history.length)
      body.append(
        h('p', {
          class: 'meta seg-empty',
          text: '기다리는 승인이 없어요. 돈 쓰는 일·보내기 전에 여기로 물어봐요.',
        }),
      )
  }
  const where = st.saved?.pcName ?? '내 PC'
  return h(
    'section',
    { class: 'agent-panel rise' },
    h(
      'div',
      { class: 'panel-head' },
      h('button', { class: 'fbtn', label: '닫기', onclick: () => openOverlay(undefined) }, icon('close')),
    ),
    h('div', { class: 'agent-big' }, liveDoori('agent', mood, 136)),
    h('h2', { class: 'agent-name', text: st.busy ? '두리가 일하는 중' : '두리' }),
    h(
      'p',
      { class: 'agent-where' },
      h('span', { class: st.online ? 'dot work' : 'dot' }),
      st.online
        ? `${where}에서 ${st.busy ? (st.steps.at(-1) ?? '일하는 중') : '쉬는 중'}`
        : `${where}에 연결 중…`,
    ),
    seg,
    body,
  )
}

function approvalSheet(id: string) {
  const a = st.approvals.get(id)
  const sheet = h('section', { class: 'sheet float app-sheet rise' })
  const close = h(
    'button',
    { class: 'fbtn small sheet-x', label: '닫기', onclick: () => openOverlay(undefined) },
    icon('close'),
  )
  if (!a) {
    sheet.append(close, h('p', { class: 'meta', text: '불러오는 중…' }))
    return sheet
  }
  if (!a.shot && a.status === 'pending') void send({ kind: 'approval', id })
  const rows = h('dl', { class: 'kv' })
  const row = (k: string, v?: string, cls?: string) =>
    v && rows.append(h('dt', { text: k }), h('dd', { text: v, ...(cls ? { class: cls } : {}) }))
  row('무엇을', a.what)
  row('어디서', a.where)
  row('주소', hostOf(a.url), 'host')
  row('취소 조건', a.cancel)
  if (a.kind !== 'app') row('누를 버튼', `"${a.label}"`)
  sheet.append(
    close,
    h(
      'div',
      { class: 'approve-head' },
      doori('asking', 40),
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: approveQuestion(a) }),
        h('span', { class: 'meta', text: [a.where, st.saved?.pcName].filter(Boolean).join(' · ') }),
      ),
    ),
    ...(a.amount ? [h('p', { class: 'approve-amount', text: a.amount })] : []),
    rows,
  )
  if (a.shot) {
    const img = h('img', { class: 'sheet-shot' })
    img.alt = 'PC 화면'
    img.src = `data:image/jpeg;base64,${a.shot}`
    sheet.append(img)
  }
  const done = st.decided.get(id)
  if (a.status !== 'pending' || done) {
    sheet.append(
      h('p', {
        class: 'done-line',
        text:
          done?.message ??
          a.result ??
          (a.status === 'rejected'
            ? '거절했어요'
            : a.status === 'expired'
              ? '승인 시간이 지났어요'
              : '처리했어요'),
      }),
    )
    return sheet
  }
  sheet.append(
    h('p', {
      class: 'meta',
      text: '"얼마"·"무엇을"은 두리가 읽어 적은 것이라 화면과 맞는지 봐 주세요. 승인하면 두리가 이 버튼 하나만 눌러요.',
    }),
    h(
      'div',
      { class: 'approve-actions' },
      h('button', { class: 'btn-ghost lg', text: '거절', onclick: () => void decide(a, 'reject') }),
      holdButton({
        label: a.kind === 'app' ? '꾹 눌러 허용' : '꾹 눌러 승인',
        done: a.kind === 'app' ? '허용했어요' : '승인했어요',
        cls: 'btn btn-approve lg',
        onDone: () => decide(a, 'approve', true),
        after: () => markDecided(a, 'approve'),
      }),
    ),
  )
  return sheet
}

/** 로그인 시트: 넣은 값은 암호화돼 PC 금고로만 간다. AI·대화 기록에는 남지 않는다 */
interface CredTarget {
  key: string
  site: string
  host: string
  busyText: string
  submitText: string
  submit(user: string, password: string): void
  direct?: { text: string; onclick(): void }
  /** 간편 로그인 버튼 (카카오로 연결…): 아이디·비밀번호 없이 공급자 계정으로 */
  social?: { provider: SocialProvider; onclick(): void }[]
  /** 연결되면 바로 시작할 부탁 */
  next?: string
  /** 로고를 보여 줄 연결 카드 id */
  logo?: string
  /** 카카오·네이버 같은 공급자 계정이면 그 로고 */
  brand?: SocialProvider
}

/** 아이디·비밀번호 시트 (로그인 카드, 서비스 연결하기). 값은 PC 금고로만 간다 */
function credSheet(t: CredTarget) {
  const sheet = h('section', { class: 'sheet float app-sheet rise' })
  const d = st.loginDraft
  if (d.id !== t.key) Object.assign(d, { id: t.key, user: '', pw: '', busy: false, error: undefined })
  const user = h('input', { class: 'field' })
  user.id = 'login-user'
  user.placeholder = '아이디 또는 이메일'
  user.autocomplete = 'username'
  user.value = d.user
  user.oninput = () => {
    d.user = user.value
  }
  const pw = h('input', { class: 'field' })
  pw.id = 'login-pw'
  pw.type = 'password'
  pw.placeholder = '비밀번호'
  pw.autocomplete = 'current-password'
  pw.value = d.pw
  pw.oninput = () => {
    d.pw = pw.value
  }
  const submit = h('button', { class: 'btn lg', text: d.busy ? t.busyText : t.submitText })
  submit.type = 'submit'
  submit.disabled = !!d.busy
  const form = h(
    'form',
    { class: 'login-form' },
    user,
    pw,
    d.error && h('p', { class: 'login-error', text: d.error }),
    submit,
  )
  form.onsubmit = (e) => {
    e.preventDefault()
    if (!d.user.trim() || !d.pw || d.busy) return
    d.busy = true
    d.error = undefined
    const password = d.pw
    d.pw = ''
    t.submit(d.user.trim(), password)
    render()
  }
  sheet.append(
    h(
      'button',
      { class: 'fbtn small sheet-x', label: '닫기', onclick: () => openOverlay(undefined) },
      icon('close'),
    ),
    h(
      'div',
      { class: 'approve-head' },
      t.brand
        ? h('span', { class: `svc-mark lg brand-tile ${t.brand}` }, brandMark(t.brand))
        : withLogo(
            h('span', { class: 'svc-mark lg', text: /^\d+/.exec(t.site)?.[0] ?? [...t.site][0] ?? '' }),
            t.logo,
          ),
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: `${t.site} 로그인` }),
        h('span', {
          class: 'meta',
          text: `${t.host} · ${st.saved?.pcName ?? '내 PC'}의 Chrome에서 두리가 로그인해요`,
        }),
      ),
    ),
    ...(t.next ? [h('p', { class: 'cred-next' }, icon('idea'), `연결되면 바로 시작해요: ${t.next}`)] : []),
    ...(t.social?.length
      ? [
          h(
            'div',
            { class: 'social-list' },
            ...t.social.map((x) => {
              const b = h('button', { class: `btn-social ${x.provider}`, onclick: x.onclick })
              b.type = 'button'
              b.append(brandMark(x.provider), h('span', { text: SOCIAL_CTA[x.provider] }))
              return b
            }),
          ),
          h('p', { class: 'social-or' }, h('span', { text: '또는 아이디·비밀번호로' })),
        ]
      : []),
    form,
    h(
      'p',
      { class: 'lock-note' },
      icon('lock'),
      'PC의 두리 금고(키체인)에만 암호화해 저장돼요. 두리(AI)·대화 기록·중계 서버 어디에도 남지 않아요.',
    ),
    ...(t.direct
      ? [h('button', { class: 'btn-text cred-direct', text: t.direct.text, onclick: t.direct.onclick })]
      : []),
  )
  return sheet
}

/** 로그인 중 화면이 묻는 것 (인증번호·휴대폰 번호): 폰 입력 화면으로 받아 PC 칸에 넣는다 */
function infoSheet(id: string) {
  const q = st.infos.get(id)
  const sheet = h('section', { class: 'sheet float app-sheet rise info-sheet' })
  if (!q) return sheet
  const answer = (value?: string) => {
    void send({ kind: 'info-answer', id, ...(value ? { value } : {}) })
    st.infos.delete(id)
    st.overlay = undefined
    render()
    if (value) toast('넣었어요. 두리가 이어서 할게요')
  }
  const head = h(
    'div',
    { class: 'approve-head' },
    withLogo(h('span', { class: 'svc-mark lg', text: [...q.site][0] ?? '' }), undefined),
    h(
      'div',
      {},
      h('strong', { class: 'title-2', text: q.field === 'otp' ? '인증번호를 넣어 주세요' : q.label }),
      h('span', { class: 'meta', text: `${q.site} · ${q.host}` }),
    ),
  )
  const body: Node[] = []
  if (q.hint) body.push(h('p', { class: 'info-hint', text: q.hint }))
  if (q.field === 'otp') {
    body.push(otpBoxes({ onDone: (code) => setTimeout(() => answer(code), 500) }))
    body.push(h('p', { class: 'meta', text: '문자로 왔으면 키보드 위에 번호가 떠요. 누르면 바로 들어가요.' }))
    queueMicrotask(() => document.getElementById('otp-input')?.focus())
  } else {
    const input = h('input', { class: 'field' })
    input.id = 'info-input'
    input.placeholder = q.label
    if (q.field === 'tel') {
      input.type = 'tel'
      input.inputMode = 'tel'
      input.autocomplete = 'tel'
    }
    const go = h('button', { class: 'btn lg', text: '넣기' })
    go.type = 'submit'
    const form = h('form', { class: 'cred-form' }, input, go)
    form.onsubmit = (e) => {
      e.preventDefault()
      if (input.value.trim()) answer(input.value.trim())
    }
    body.push(form)
    queueMicrotask(() => input.focus())
  }
  sheet.append(
    head,
    ...body,
    h(
      'p',
      { class: 'lock-note' },
      icon('lock'),
      '넣은 값은 그 칸에만 들어가요. 저장하지 않고, 두리(AI)도 보지 않아요.',
    ),
    h('button', { class: 'btn-text cred-direct', text: '지금은 안 할게요', onclick: () => answer() }),
  )
  return sheet
}

/** 공급자 계정 주소면 그 공급자 (accounts.kakao.com → kakao) */
function brandOf(origin: string): SocialProvider | undefined {
  const h = hostOf(origin)
  if (/(^|\.)kakao\.com$/.test(h)) return 'kakao'
  if (/(^|\.)naver\.com$/.test(h)) return 'naver'
  if (/(^|\.)google\.com$/.test(h)) return 'google'
  if (/(^|\.)apple\.com$/.test(h)) return 'apple'
  if (/(^|\.)facebook\.com$/.test(h)) return 'facebook'
  if (/(^|\.)payco\.com$/.test(h)) return 'payco'
  return undefined
}

function loginSheet(id: string) {
  const r = st.logins.get(id)
  if (!r) return h('section', { class: 'sheet float app-sheet rise' })
  return credSheet({
    key: r.id,
    site: r.site,
    host: hostOf(r.origin),
    ...(cardIdFor(r.origin) ? { logo: cardIdFor(r.origin) } : {}),
    ...(brandOf(r.origin) ? { brand: brandOf(r.origin) } : {}),
    busyText: '저장하는 중…',
    submitText: '로그인하기',
    submit: (username, password) => void send({ kind: 'login', id: r.id, username, password }),
    direct: { text: '화면 보면서 직접 할게요', onclick: () => openRemote(r.tabId) },
  })
}

/** 서비스 연결하기: 아이디·비밀번호를 넣으면 두리가 PC Chrome에서 대신 로그인하고 결과를 알려 준다 */
function connectSheet(id: string) {
  const it = st.services?.find((x) => x.card.id === id)
  if (!it) return h('section', { class: 'sheet float app-sheet rise' })
  return credSheet({
    key: `connect:${id}`,
    site: it.card.name,
    host: it.card.site ?? '',
    busyText: '두리가 로그인하는 중…',
    submitText: '연결하기',
    submit: (username, password) => {
      // 기다리지 않는다: 시트를 닫고, 로그인은 두리 본체가 뒤에서 한다 (끝나면 대화·알림으로)
      void send({ kind: 'connect-login', id, username, password })
      st.loginDraft.busy = false
      st.overlay = undefined
      st.connecting.add(id)
      toast(`${it.card.name} 로그인은 두리가 PC에서 할게요. 끝나면 대화로 알려 드릴게요`)
    },
    ...(st.afterConnect?.id === id ? { next: st.afterConnect.text } : {}),
    logo: id,
    social: (it.card.social ?? []).map((provider) => ({
      provider,
      onclick: () => {
        // 공급자 쪽(카카오 등)이 PC Chrome에 로그인돼 있으면 두리가 버튼·동의만 넘기고, 아니면 그 화면을 넘겨 드려요
        void send({ kind: 'connect-social', id, provider })
        st.overlay = undefined
        st.connecting.add(id)
        toast(`${SOCIAL_LABEL[provider]}로 ${it.card.name}에 로그인해 볼게요. 끝나면 대화로 알려 드릴게요`)
      },
    })),
    direct: {
      text: st.connectTabs.has(id) ? 'PC 화면 보면서 마저 하기' : '화면 보면서 직접 로그인할게요',
      onclick: () => {
        const tab = st.connectTabs.get(id)
        if (tab !== undefined) return openRemote(tab, id)
        st.opening = id
        st.overlay = undefined
        render()
        void send({ kind: 'connect', id, action: 'open' })
      },
    },
  })
}

// ── 따로 하는 대화 ──

function sideThreads() {
  return (st.pc?.threads ?? []).filter((t) => t.side && t.title !== '두리 피드')
}

function isSideThread(id: string) {
  return st.side?.id === id || (st.pc?.threads ?? []).some((t) => t.id === id && t.side)
}

function openSide(id: string, title = '따로 하는 대화') {
  st.side = { id, title, messages: [], live: '', steps: [], busy: false, draft: '' }
  st.overlay = undefined
  st.screen = { name: 'side', id }
  render()
  void send({ kind: 'thread', id })
}

function newSide() {
  st.sideWanted = true
  st.overlay = undefined
  render()
  void send({ kind: 'side-new' })
}

function onSideStream(threadId: string, ev: DaemonStreamEvent) {
  const sd = st.side
  if (!sd || sd.id !== threadId) return
  if (ev.type === 'saved') {
    if (ev.message.role === 'user')
      sd.messages = sd.messages.filter((m) => !(m.id.startsWith('p') && m.text === ev.message.text))
    if (!sd.messages.some((m) => m.id === ev.message.id)) sd.messages = [...sd.messages, ev.message]
    if (ev.message.role === 'assistant') {
      sd.live = ''
      sd.steps = []
    }
  } else if (ev.type === 'agent') {
    sd.busy = true
    if (ev.event.type === 'text') sd.live += ev.event.delta
    else if (ev.event.type === 'tool') {
      const label = narrationLine(sd.live) ?? `${toolLabel(ev.event.name)} 중`
      sd.live = ''
      if (sd.steps.at(-1) !== label) sd.steps = [...sd.steps, label]
    }
  } else if (ev.type === 'end') {
    sd.busy = false
    sd.live = ''
    sd.steps = []
    void send({ kind: 'thread', id: sd.id })
    void send({ kind: 'hello' })
  }
}

function sideView(id: string) {
  const sd = st.side?.id === id ? st.side : undefined
  const back = () => {
    st.screen = { name: 'app' }
    render()
  }
  const list = h('div', { class: 'chat-list side-list' })
  for (const m of sd?.messages ?? []) {
    if (m.role === 'user') {
      const note = readAppNote(m.text)
      list.append(
        note !== undefined
          ? h('p', { class: 'msg note' }, note)
          : h('div', { class: 'bubble me', text: m.text }),
      )
    } else if (m.role === 'assistant') {
      const b = h('div', { class: 'bubble rich' })
      b.append(rich(m.text))
      list.append(b)
    } else if (m.role === 'tool') list.append(toolCard(m.text))
  }
  if (sd?.busy) {
    const step = sd.steps.at(-1)
    if (step) list.append(h('p', { class: 'meta step' }, h('span', { class: 'dot work pulse' }), step))
    if (sd.live) {
      const b = h('div', { class: 'bubble rich streaming' })
      b.append(rich(sd.live))
      list.append(b)
    } else list.append(thinkingDots())
  }
  if (sd && !sd.messages.length && !sd.busy)
    list.append(
      h(
        'div',
        { class: 'card ask-card' },
        h('div', { class: 'card-label' }, doori('', 22), '주제 하나를 따로 이야기해요'),
        h('p', {
          class: 'card-text',
          text: '여행 계획, 이사 준비처럼 길게 이어질 일을 여기서 하면 메인 대화가 어지럽지 않아요. 두리는 메인 대화에서 알게 된 것도 기억해요.',
        }),
      ),
    )
  const ta = h('textarea')
  ta.id = 'side-input'
  ta.rows = 1
  ta.placeholder = '두리에게 부탁하기'
  ta.value = sd?.draft ?? ''
  ta.oninput = () => {
    if (sd) sd.draft = ta.value
    autosize(ta)
  }
  const go = h('button', { class: 'send-btn ready', label: '보내기' }, icon('send', 'i md'))
  const submit = () => {
    const text = ta.value.trim()
    if (!text || !sd || !st.online) return
    sd.draft = ''
    sd.busy = true
    sd.messages = [
      ...sd.messages,
      { id: `p${Date.now()}`, threadId: sd.id, role: 'user', text, createdAt: new Date().toISOString() },
    ]
    render()
    void send({ kind: 'ask', threadId: sd.id, text })
  }
  go.onclick = submit
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      submit()
    }
  }
  const page = h(
    'section',
    { class: 'side-page' },
    h(
      'header',
      { class: 'side-top' },
      h('button', { class: 'fbtn', label: '뒤로', onclick: back }, icon('back')),
      h('strong', { class: 'side-title', text: sd?.title ?? '따로 하는 대화' }),
      h(
        'button',
        {
          class: 'fbtn',
          label: '지우기',
          onclick: () => {
            if (!confirm('이 대화를 지울까요?')) return
            void send({ kind: 'side-delete', id })
            back()
          },
        },
        icon('trash'),
      ),
    ),
    h('div', { class: 'side-scroll' }, list),
    h('div', { class: 'composer float side-composer' }, ta, go),
  )
  requestAnimationFrame(() => {
    const sc = page.querySelector('.side-scroll')
    sc?.scrollTo({ top: sc.scrollHeight })
    if (sd?.draft && document.activeElement?.id !== 'side-input') {
      const el = document.getElementById('side-input') as HTMLTextAreaElement | null
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    }
  })
  return page
}

// ── 연결 전 화면 ──

function introView() {
  return h(
    'section',
    { class: 'center-page' },
    liveDoori('intro', '', 120),
    h('h1', { class: 'display-s', text: '두리' }),
    h('p', { class: 'psub', text: '내 컴퓨터의 두리에게 폰으로 부탁해요.' }),
    h(
      'ol',
      { class: 'steps' },
      h('li', { text: 'PC에서 두리 앱을 열어요' }),
      h('li', { text: '설정 → 폰 연결 → [폰 연결하기]' }),
      h('li', { text: isNative() ? '아래 [QR 찍기]로 PC 화면의 QR을 찍어요' : '폰 카메라로 QR을 찍어요' }),
    ),
    isNative() ? h('button', { class: 'btn', text: 'QR 찍기', onclick: () => void scanInvite() }) : null,
    h('p', { class: 'meta', text: '주고받는 내용은 PC와 이 폰만 열 수 있게 암호화돼요.' }),
  )
}

/** 앱: PC 화면의 연결 QR을 찍어 연결을 시작한다 */
async function scanInvite() {
  try {
    const text = await scanQr()
    if (!text) return
    const invite = inviteFrom(text)
    if (!invite) return toast('두리 연결 QR이 아니에요. PC의 설정 → 폰 연결에서 띄운 QR을 찍어 주세요')
    await startPairing(invite)
  } catch (e) {
    toast((e as Error).message || 'QR을 찍지 못했어요')
  }
}

/** 안드로이드 뒤로 가기: 열린 창 → 따로 하는 대화·원격 화면 → 대화 탭 순서로 닫는다. 더 닫을 게 없으면 false */
function goBack(): boolean {
  if (st.overlay) {
    st.overlay = undefined
    render()
    return true
  }
  if (st.screen.name === 'remote' || st.screen.name === 'side') {
    st.screen = { name: 'app' }
    render()
    return true
  }
  if (st.screen.name === 'app' && st.tab !== 'chat') {
    setTab('chat')
    return true
  }
  return false
}

function unsupportedView() {
  return h(
    'section',
    { class: 'center-page' },
    liveDoori('center', 'asking', 104),
    ...(isNative()
      ? [
          // 앱 안의 화면은 폰의 WebView로 그린다. 암호화(X25519·Ed25519)는 WebView 137 이상에서 된다
          h('h1', { class: 'title-2', text: '업데이트가 하나 필요해요' }),
          h('p', {
            class: 'psub',
            text: '폰의 Android System WebView가 오래돼서 암호화를 쓸 수 없어요. Play 스토어에서 업데이트한 뒤 다시 열어 주세요.',
          }),
          h('button', {
            class: 'btn',
            text: 'Play 스토어에서 업데이트',
            onclick: () => {
              location.href = 'https://play.google.com/store/apps/details?id=com.google.android.webview'
            },
          }),
        ]
      : [
          h('h1', { class: 'title-2', text: '이 브라우저에서는 열 수 없어요' }),
          h('p', {
            class: 'psub',
            text: '아이폰은 사파리 17 이상, 안드로이드는 크롬 최신 버전에서 열어 주세요.',
          }),
        ]),
  )
}

function pairingView(v: Extract<Screen, { name: 'pairing' }>) {
  if (v.rejected)
    return h(
      'section',
      { class: 'center-page' },
      liveDoori('center', 'asking', 104),
      h('h1', { class: 'title-2', text: 'PC에서 연결을 거절했어요' }),
      h('p', { class: 'psub', text: '숫자가 달랐다면 PC에서 QR을 새로 띄워 다시 찍어 주세요.' }),
    )
  return h(
    'section',
    { class: 'center-page' },
    liveDoori('center', 'thinking', 104),
    h('h1', { class: 'title-2', text: `${v.pcName}에 연결할게요` }),
    h('p', { class: 'psub', text: 'PC 화면에 이 숫자가 보이나요?' }),
    h('p', { class: 'pair-code mono', text: v.code }),
    h('p', {
      class: 'meta',
      text: 'PC에서 [같아요, 연결]을 눌러 주세요. 숫자가 다르면 "다른 숫자예요"를 눌러 주세요.',
    }),
  )
}

/** PC 화면 (지금은 화면 한 장씩. 로그인 단계에서 실시간 화면으로 바꾼다) */
let remoteUi: RemoteScreen | undefined
let remoteToast: HTMLElement | undefined

/** 원격 화면: 탭마다 한 번 만들고 그 뒤로는 그림·정보만 바꾼다 (remote.ts) */
function remoteView(v: Extract<Screen, { name: 'remote' }>) {
  if (remoteUi?.tabId !== v.tabId) {
    const back = () => {
      st.screen = { name: 'app' }
      remoteUi = undefined
      if (v.connectId) {
        st.tab = 'connect'
        st.connectDetail = v.connectId
      }
      render()
    }
    remoteUi = createRemote({
      tabId: v.tabId,
      ...(v.connectId ? { connectId: v.connectId } : {}),
      input: (i) => remote(i),
      back,
      handBack: back,
      done: () => {
        if (v.connectId) void send({ kind: 'connect', id: v.connectId, action: 'mark' })
        else ask('다 했어요. 이어서 해 주세요.')
        back()
      },
      hostOf,
      form: () => void send({ kind: 'form', tabId: v.tabId }),
      fill: (values, press) =>
        void send({ kind: 'form-fill', tabId: v.tabId, values, ...(press ? { press } : {}) }),
    })
  }
  remoteUi.update(st.screenShot, fps())
  return remoteUi.el
}

// ── 시작 ──

// 앱이 열려 있는 채로 새 QR을 찍거나 알림을 누르면 주소의 # 뒤만 바뀐다
window.addEventListener('hashchange', () => {
  const invite = /#p=([\w-]+)/.exec(location.hash)?.[1]
  if (invite) return void startPairing(invite)
  if (/^#([at]=|tab=)/.test(location.hash)) {
    pendingOpen = location.hash
    if (st.online) {
      openPending()
      render()
    }
  }
})

// ── 다시 맞추기: 앱을 내렸다 오거나 신호가 끊겨도 PC와 같은 화면이 되게 ──

let lastStreamAt = Date.now()

/** PC에서 대화·상태·생활·연결을 다시 받아 온다 */
function resync() {
  if (!st.online || !st.saved?.paired) return
  void send({ kind: 'hello' })
  void send({ kind: 'conversation' })
  void send({ kind: 'life' })
  void send({ kind: 'connections' })
  pollWork()
}

function startResync() {
  // 앱으로 돌아오면 (폰은 뒤로 가 있는 동안 연결이 끊기거나 신호를 놓친다)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (st.client && !st.online) connect()
    else resync()
  })
  // 앱을 켜 두고 있다고 1분마다 알린다 (PC는 켜 둔 폰에만 흘려 쓰는 답을 보낸다)
  setInterval(() => {
    if (st.online && st.saved?.paired && document.visibilityState === 'visible') void send({ kind: 'ping' })
  }, 60_000)
  // 답하는 중인데 40초 넘게 아무 신호가 없으면 기록을 다시 받는다
  setInterval(() => {
    if (st.busy && Date.now() - lastStreamAt > 40_000) {
      lastStreamAt = Date.now()
      resync()
    }
  }, 10_000)
}

/** 당겨서 새로고침: 목록 맨 위에서 아래로 당겼다 놓으면 PC에서 다시 받아 온다 */
/**
 * 당겨서 새로고침: 처음엔 반만 따라오고 멀리 당길수록 무거워진다(고무줄).
 * 넘으면 두리가 톡 커지며 알려 주고, 놓으면 그 자리에서 돌다가 스프링으로 돌아간다
 */
function pullToRefresh(page: HTMLElement) {
  const ind = h('div', { class: 'ptr' }, doori('', 28))
  page.before(ind)
  const TH = 64
  const HOLD = 56
  const rubber = (d: number) => (d <= 180 ? d * 0.55 : 99 + 60 * (1 - 1 / (((d - 180) * 0.55) / 60 + 1)))
  const P = new Spring(0).use('pull')
  const POP = new Spring(1).use('pop')
  let y0 = -1
  let mode: 'idle' | 'pulling' | 'loading' = 'idle'
  let armed = false
  let stop: (() => void) | undefined
  const draw = () => {
    const d = Math.max(0, P.x)
    ind.style.transform = `translate(-50%, ${d.toFixed(2)}px) rotate(${(mode === 'loading' ? 0 : d * 3).toFixed(1)}deg) scale(${POP.x.toFixed(3)})`
    ind.style.opacity = String(Math.min(1, d / 40))
  }
  const run = () => {
    stop?.()
    stop = tick((dt) => {
      P.step(dt)
      POP.step(dt)
      draw()
      return mode === 'pulling' || !(P.resting && POP.resting)
    })
  }
  page.addEventListener(
    'touchstart',
    (e) => {
      if (mode === 'loading') return
      y0 = page.scrollTop <= 0 ? (e.touches[0]?.clientY ?? -1) : -1
    },
    { passive: true },
  )
  page.addEventListener(
    'touchmove',
    (e) => {
      if (y0 < 0 || mode === 'loading') return
      const dy = (e.touches[0]?.clientY ?? y0) - y0
      if (dy <= 0 || page.scrollTop > 0) return
      if (mode !== 'pulling') {
        mode = 'pulling'
        armed = false
        run()
      }
      // 손가락을 바로 따라간다
      P.x = P.t = rubber(dy)
      P.v = 0
      const over = P.x >= TH
      if (over && !armed) {
        armed = true
        POP.v += 5
        navigator.vibrate?.(6)
      }
      if (!over) armed = false
      ind.classList.toggle('ready', over)
    },
    { passive: true },
  )
  page.addEventListener('touchend', () => {
    if (mode !== 'pulling') return
    y0 = -1
    if (!armed) {
      mode = 'idle'
      P.t = 0
      ind.classList.remove('ready')
      return run()
    }
    mode = 'loading'
    P.t = HOLD
    ind.classList.add('spinning')
    run()
    resync()
    setTimeout(() => {
      ind.classList.remove('spinning', 'ready')
      mode = 'idle'
      P.t = 0
      run()
    }, 900)
  })
}

async function main() {
  // 아이폰 사파리는 viewport의 확대 막기를 무시해서, 꼬집기 확대를 따로 막는다 (원격 화면은 자체로 처리)
  document.addEventListener('gesturestart', (e) => e.preventDefault())
  document.documentElement.dataset.theme = 'auto'
  if (!globalThis.crypto?.subtle || !('indexedDB' in window)) {
    st.screen = { name: 'unsupported' }
    return render()
  }
  try {
    // 암호화(X25519)와 서명(Ed25519) 둘 다 되어야 한다. 크롬·WebView는 X25519가 133, Ed25519가 137부터
    await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
    await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
  } catch {
    st.screen = { name: 'unsupported' }
    return render()
  }
  const theme = localStorage.getItem('dool2-theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  // 앱에서는 서비스 워커를 쓰지 않는다 (앱 코드가 이미 앱 안에 있다)
  if (!isNative() && 'serviceWorker' in navigator)
    void navigator.serviceWorker.register('sw.js').catch(() => {})
  listenNative({
    open: (url) => {
      const invite = inviteFrom(url)
      if (invite) void startPairing(invite)
    },
    back: goBack,
  })
  const invite = inviteFrom(location.hash) ?? (await launchInvite())
  if (invite) return startPairing(invite)
  if (/^#([at]=|tab=)/.test(location.hash)) pendingOpen = location.hash
  const saved = await load()
  if (!saved) {
    st.screen = { name: 'intro' }
    return render()
  }
  st.saved = saved
  st.key = await linkKey(saved.keys.boxPriv, saved.pcBoxPub, [saved.keys.id, saved.pcId])
  st.screen = saved.paired
    ? { name: 'app' }
    : { name: 'pairing', code: await pairCode(saved.keys.boxPriv, saved.pcBoxPub), pcName: saved.pcName }
  render()
  connect()
  startResync()
  // 태블릿을 돌리거나 창 크기가 바뀌면 탭 알약 자리를 다시 잡는다
  // 폴드를 펴고 접거나 태블릿을 돌리면 탭 막대 모양(가로·세로, 칸 너비)이 바뀐다.
  // 바뀌는 도중에 재면 알약 자리가 틀어지므로, 움직이던 알약은 멈추고 자리가 잡힌 뒤 다시 잰다
  let settleTabs: ReturnType<typeof setTimeout> | undefined
  const onResize = () => {
    pillStop?.()
    renderTabs()
    clearTimeout(settleTabs)
    settleTabs = setTimeout(() => renderTabs(), 450)
  }
  addEventListener('resize', onResize)
  screen.orientation?.addEventListener?.('change', onResize)
}

void main()
