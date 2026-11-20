// 두리 폰 앱 (v2 디자인: docs/design/screens/soft). PC의 두리와 중계 서버를 거쳐 종단 간 암호화로 이야기한다 (ADR 0012).
// 화면: 연결(페어링) → 앱(대화 하나 · 맡긴 일 · 아이디어 · 연결) + 메뉴 서랍 · 두리 패널 · 승인/로그인 시트 · PC 화면
// 머리·탭·입력칸은 한 번만 만들고, 대화는 바뀐 말만 덧붙인다 (다시 그려도 깜빡이거나 스크롤이 튀지 않게).
import type {
  ApprovalRecordMessage,
  ApprovalView,
  CardsRecordMessage,
  ConnectRecordMessage,
  ConnectStep,
  DaemonStreamEvent,
  FeedItem,
  HandoffRecord,
  InfoRequestView,
  LibraryItem,
  LifeAction,
  LifeState,
  LoginRecordMessage,
  LoginRequestView,
  PairInvite,
  PcToPhone,
  PhoneToPc,
  StoredMessage,
  TellRecordMessage,
  WorkRecordMessage,
} from '@dool2/protocol'
import { AUTH_APPS, CARRIERS, SIDE_THREAD_PEEK, type VaultEntry } from '@dool2/protocol'
import { type BlockEnv, blockView } from '@dool2/protocol/blocks-view'
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
import { approvalSignText, LinkClient, resetSignText } from '@dool2/protocol/link'
import { Pager } from '@dool2/protocol/paging'
import {
  CARD_ISSUERS,
  PAY_KINDS,
  type PayKind,
  type PayMethod,
  payMethodDetail,
  payMethodLabel,
  payMethodTitle,
} from '@dool2/protocol/pay-methods'
import {
  hyphenate,
  josa,
  narrationLine,
  readAppNote,
  splitPhoto,
  stripLinks,
  toolLabel,
  toolPlace,
  withoutPhotoMark,
} from '@dool2/protocol/rich'
import {
  bareHost,
  cardForHost,
  doneLine,
  groupSteps,
  type PlaceCard,
  type WorkGroup,
} from '@dool2/protocol/work-steps'
import { brandMark, SOCIAL_CTA } from './brands.js'
import { type ConnectCtx, connectionsView, serviceView, socialOrder } from './connections.js'
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
import { matchTextBox, recentTalk, ghostRest as suggestRest } from './ghost.js'
import {
  feedView,
  goalSheet,
  goalsView,
  itemSheet,
  type LifeCtx,
  libraryView,
  memorySeg,
  moreRow,
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
import {
  confirmDevice,
  defaultRelay,
  inviteFrom,
  isNative,
  launchInvite,
  listenNative,
  scanQr,
} from './native.js'
import { createRemote, type RemoteScreen, type Shot } from './remote.js'
import { clear, clearConv, load, loadConv, type Saved, save, saveConv } from './store.js'

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
  /** 문제 알리기: 방금 있었던 일을 PC의 기록에 남긴다 */
  | { kind: 'report' }
  /** 설정 > 내 정보: 가린 값 보기·고치기·지우기 */
  | { kind: 'profile' }
  /** 설정 > 금고: 저장된 로그인 보기(폰 잠금 확인 뒤)·고치기·지우기 (ADR 0026) */
  | { kind: 'vault' }
  /** 설정 > 결제 수단: 내 결제 수단 목록(맨 위가 주 결제 수단)·추가 (ADR 0023) */
  | { kind: 'pay' }
  | { kind: 'pay-add' }
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
  /** 승인 카드에서 고른 선택지 (결제 수단): 승인 id → 선택지 id */
  choice: Map<string, string>
  /** 설정 > 내 정보(가린 값)·사이트별 마지막 결제 수단 (PC에 물어 받는다) */
  profile?: {
    have: Record<string, string>
    missing: string[]
    payChoices: Record<string, string>
    /** 내 결제 수단 (예전 PC면 undefined: 등록 기능을 숨긴다) */
    payMethods?: PayMethod[]
  }
  /** 설정 > 금고 목록 (비밀번호 없음) */
  vault?: (VaultEntry & { name?: string })[]
  /** 잠깐 보이는 비밀번호 (30초 뒤·시트를 닫으면 지운다) */
  vaultShown?: { id: string; username: string; password: string }
  /** 고치는 중인 항목 */
  vaultEdit?: string
  /** 결제 수단 추가 시트에 쓰는 중인 것 */
  payDraft: { kind?: PayKind; inner: string; issuer: string; nickname: string; last4: string }
  logins: Map<string, LoginRequestView>
  infos: Map<string, InfoRequestView>
  loginDraft: { id: string; user: string; pw: string; busy?: boolean; error?: string }
  /** 대신 로그인이 끝까지 못 간 서비스 → 그 화면(탭) */
  connectTabs: Map<string, number>
  /** 연결하는 동안 두리가 로그인하고 있는 탭과 그 화면 (연결 카드에 작게 실시간으로) */
  connectLive: Map<string, { tabId: number; shot?: string }>
  services?: ConnectionItem[]
  connectQuery: string
  connectCat: string
  /** 아이디어 탭: 고른 분류('all' = 전체)와 찾는 말 */
  ideaCat: string
  /** 두리 본체가 지금 로그인하고 있는 서비스 */
  connecting: Set<string>
  /** 연결하는 동안 본체가 알려 온 단계 (서비스 id → 단계) */
  connectSteps: Map<string, ConnectStep[]>
  /** 연결이 끝까지 못 갔을 때 그 까닭 (카드가 "직접 마쳐 주세요"·"다시 넣기"로 남는다) */
  connectFails: Map<
    string,
    {
      reason: 'human' | 'wrong' | 'unknown'
      message: string
      tabId?: number
      agent?: boolean
      at?: number
    }
  >
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
  /** 메뉴에서 따로 하는 대화를 모두 펼쳐 보는 중 */
  sideAll?: boolean
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
  choice: new Map(),
  payDraft: { inner: '', issuer: '', nickname: '', last4: '' },
  logins: new Map(),
  infos: new Map(),
  loginDraft: { id: '', user: '', pw: '' },
  connectTabs: new Map(),
  connectLive: new Map(),
  connectQuery: '',
  connectCat: 'all',
  ideaCat: 'all',
  connecting: new Set(),
  connectSteps: new Map(),
  connectFails: new Map(),
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
  if (!QUIET_SEND.has(body.kind)) mark(`보냄 ${body.kind}${'action' in body ? `:${body.action}` : ''}`)
  sending = sending.then(() => sendNow(body)).catch(() => {})
  return sending
}

// ── 앱에서 방금 있었던 일 (문제 알리기용) ──
// 누른 것·받은 신호의 종류와 시각만 폰 메모리에 300줄까지 둔다. 대화 내용·넣은 값은 담지 않는다.
// [문제 알리기]를 누를 때만 PC로 보내고, PC의 일한 기록에 며칠 남는다
const trail: { at: number; what: string }[] = []
function mark(what: string) {
  trail.push({ at: Date.now(), what: what.slice(0, 160) })
  if (trail.length > 300) trail.splice(0, trail.length - 300)
}
/** 너무 자주 오가서 적지 않는 것 */
const QUIET_SEND = new Set<string>(['screen', 'ping', 'remote', 'report', 'thumb'])

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
/** 처음부터 다시 (시험용 PC): 두 번 묻고, 이 폰의 키로 서명해 보낸다. PC가 서명을 확인한 뒤에만 지운다 */
async function resetAll() {
  const s = st.saved
  if (!s) return
  if (
    !confirm(
      '처음부터 다시 할까요?\n\nPC의 대화·기억·목표·보관함·아이디어·내 정보가 모두 지워져요. 되돌릴 수 없어요.',
    )
  )
    return
  const services = confirm(
    '연결한 서비스도 처음부터 할까요?\n\n[확인] 연결 표시도 지워요\n[취소] 연결은 그대로 둬요\n\n금고의 비밀번호와 이 폰의 PC 연결은 어느 쪽이든 남아요.',
  )
  mark(`처음부터 다시 (서비스 ${services ? '포함' : '빼고'})`)
  const at = Date.now()
  const sig = await signText(s.keys.signPriv, resetSignText(at, services))
  toast('지우는 중이에요…')
  await send({ kind: 'reset', at, services, sig })
}

async function forgetPc() {
  st.client?.stop()
  st.client = undefined
  await clear()
  await clearConv().catch(() => undefined)
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
      if (st.online !== (state === 'ready')) mark(`중계 ${state}`)
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
  markReceived(msg)
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
      // PC가 보낸 기다리는 로그인이 전부다: 목록에 없으면 PC에서 끝났거나(본체를 다시 켬·시간 지남) 사라진 것
      // (컬리 로그인 카드가 연결을 마친 뒤에도 '나를 기다려요'에 남았다)
      for (const l of st.logins.values())
        if (l.status === 'pending' && !(msg.logins ?? []).some((x) => x.id === l.id))
          st.logins.set(l.id, { ...l, status: 'expired' })
      for (const q of msg.infos ?? []) st.infos.set(q.id, q)
      for (const id of st.infos.keys()) if (!(msg.infos ?? []).some((q) => q.id === id)) st.infos.delete(id)
      st.connecting = new Set(msg.connecting ?? [])
      // 일하는 중에 앱을 다시 열었으면: 두리가 보고 있는 탭을 받아 일하는 화면을 이어서 띄운다
      if (msg.activeTab !== undefined && st.work.tabId === undefined)
        st.work = { ...st.work, tabId: msg.activeTab }
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
      // 다시 받아 온 기록에 이미 있거나 줄 선 말은 "보내는 중"에서 뺀다 (안 그러면 같은 말이 두 번 보인다)
      if (!msg.before) {
        const mine = new Set(
          msg.state.messages.filter((m) => m.role === 'user').map((m) => splitPhoto(m.text).text),
        )
        st.pending = st.pending.filter((p) => !mine.has(p.text) && !msg.state.queued.includes(p.text))
      }
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
    case 'thumb':
      gotThumb(msg.url, msg.data)
      break
    case 'vault':
      st.vault = msg.entries
      st.vaultEdit = undefined
      if (msg.message) toast(msg.message)
      break
    case 'vault-secret': {
      st.vaultShown = { id: msg.id, username: msg.username, password: msg.password }
      const id = msg.id
      setTimeout(() => {
        if (st.vaultShown?.id === id) {
          st.vaultShown = undefined
          render()
        }
      }, 30_000)
      break
    }
    case 'profile':
      st.profile = {
        have: msg.have,
        missing: msg.missing,
        payChoices: msg.payChoices,
        ...(msg.payMethods ? { payMethods: msg.payMethods } : {}),
      }
      if (msg.message) toast(msg.message)
      break
    case 'reset-done': {
      toast(msg.message)
      if (!msg.ok) break
      // 이 폰에 남긴 대화 조각·방금 기록도 지우고, 앱을 처음 연 것처럼 다시 띄운다 (PC 연결·화면 테마는 그대로)
      await clearConv().catch(() => undefined)
      trail.splice(0)
      setTimeout(() => location.reload(), 1200)
      break
    }
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
      const live =
        st.screen.name !== 'remote' && msg.shot
          ? [...st.connectLive.values()].find((l) => l.tabId === msg.tabId)
          : undefined
      if (live && msg.shot) {
        // 연결 카드 안 로그인 화면: 그림만 바꾼다
        const first = !live.shot
        live.shot = msg.shot
        const img = document.querySelector<HTMLImageElement>(`.connect-shot[data-tab="${msg.tabId}"]`)
        if (img) img.src = `data:image/jpeg;base64,${msg.shot}`
        if (first) renderSoon()
        return
      }
      if (st.screen.name !== 'remote' && msg.tabId === st.work.tabId && msg.shot) {
        // 대화 안 일하는 화면: 그림만 바꾼다
        const first = !st.work.shot
        st.work = { ...st.work, shot: msg.shot, ...(msg.url ? { url: msg.url } : {}) }
        const shotHost = msg.url ? hostOf(msg.url) : ''
        if (shotHost) tabHosts.set(msg.tabId, shotHost)
        for (const img of document.querySelectorAll<HTMLImageElement>('.work-shot, .work-thumb'))
          img.src = `data:image/jpeg;base64,${msg.shot}`
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
      // 사람이나 두리가 화면에서 로그인을 마쳐 연결된 경우에도, 미뤄 둔 부탁(연결하면 바로 시작)을 이어서 보낸다
      if (st.afterConnect && msg.services.some((s) => s.card.id === st.afterConnect?.id && s.connectedAt))
        runAfterConnect(st.afterConnect.id)
      // 원격 화면으로 로그인하는 중에 PC가 로그인을 확인하면 그 서비스로 돌아간다
      const v = st.screen
      // 연결 카드에서 연 화면이든, 두리가 넘긴 화면(같은 로그인 탭)이든: 그 서비스가 연결되면 닫는다.
      // 그대로 두면 로그인 뒤 사이트 첫 화면(검색칸 등)을 '필요한 칸'으로 그려 버린다 (실측 11번가)
      const ownerOf = (tabId: number) =>
        [...st.connectTabs.entries()].find(([, t]) => t === tabId)?.[0] ??
        [...st.connectFails.entries()].find(([, f]) => f.tabId === tabId)?.[0]
      const remoteFor = v.name === 'remote' ? (v.connectId ?? ownerOf(v.tabId)) : undefined
      if (v.name === 'remote' && remoteFor) {
        const done = msg.services.find((x) => x.card.id === remoteFor && x.connectedAt)
        if (done) {
          // 대화로 돌아간다: 연결 카드가 "연결돼 있어요"로 바뀌고 이어지는 일도 거기서 보인다
          // (연결 화면에서 시작했을 때만 그 서비스 화면으로)
          st.screen = { name: 'app' }
          st.tab = remoteFrom === 'connect' ? 'connect' : 'chat'
          if (st.tab === 'connect') st.connectDetail = done.card.id
          else stickToBottom = true
          toast(`${done.card.name} 연결됐어요`)
          runAfterConnect(done.card.id)
        }
      }
      for (const x of msg.services) if (x.connectedAt) st.connectFails.delete(x.card.id)
      break
    }
    case 'life':
      takeLife(msg.state)
      break
    case 'life-page':
      // 부탁한 목록의 다음 페이지 (before 없으면 첫 페이지 다시 받기)
      if (msg.list === 'library') libPagers[msg.tab === 'files' ? 'files' : 'made'].take(msg.before, msg)
      else (msg.kinds?.length ? activityPager : feedPager).take(msg.before, msg)
      break
    case 'life-item':
      if (msg.item) fullItems.set(msg.id, msg.item)
      break
    case 'work-tab': {
      // 두리가 이 탭에서 일하기 시작했다 (브라우저 도구든 서비스 도구든): 답하는 중이면 대화에 그 화면을 띄운다.
      // 예전에는 도구 이름이 browser_일 때만 띄워서, 서비스 도구로 일하면 화면이 안 보였다
      const fresh = msg.tabId !== st.work.tabId
      // 방금 연 사이트의 새 탭이면 그 탭의 사이트로 기억한다
      if (openedHost && !tabHosts.has(msg.tabId)) {
        tabHosts.set(msg.tabId, openedHost)
        openedHost = undefined
      }
      st.work = {
        ...st.work,
        tabId: msg.tabId,
        web: st.work.web || st.busy,
        ...(fresh ? { shot: undefined, url: undefined } : {}),
      }
      pollWork()
      renderSoon()
      return
    }
    case 'connect-status':
      st.connecting = new Set(msg.connecting)
      // 다시 하기 시작하면 지난번 실패는 지운다
      for (const id of msg.connecting) st.connectFails.delete(id)
      for (const id of st.connectSteps.keys()) if (!st.connecting.has(id)) st.connectSteps.delete(id)
      for (const id of st.connectLive.keys()) if (!st.connecting.has(id)) st.connectLive.delete(id)
      break
    case 'connect-progress':
      st.connectSteps.set(msg.id, msg.steps)
      if (msg.tabId !== undefined && st.connectLive.get(msg.id)?.tabId !== msg.tabId) {
        st.connectLive.set(msg.id, { tabId: msg.tabId })
        pollConnect()
      }
      break
    case 'connect-result': {
      st.connecting.delete(msg.id)
      st.connectLive.delete(msg.id)
      const d = st.loginDraft
      if (d.id === `connect:${msg.id}`) {
        d.busy = false
        d.error = msg.ok || msg.human ? undefined : msg.message
      }
      if (msg.tabId !== undefined) st.connectTabs.set(msg.id, msg.tabId)
      if (msg.ok) {
        st.connectFails.delete(msg.id)
        // 연결 목록이 오기 전에도 카드가 바로 "연결돼 있어요"로 (잠깐 처음 상태로 돌아가 보이지 않게)
        const it = st.services?.find((x) => x.card.id === msg.id)
        if (it && !it.connectedAt) it.connectedAt = new Date().toISOString()
      } else
        st.connectFails.set(msg.id, {
          reason: msg.reason ?? (msg.human ? 'human' : 'unknown'),
          message: msg.message,
          ...(msg.tabId !== undefined ? { tabId: msg.tabId } : {}),
          // 두리가 이어받았으면 그때부터 (답하기 시작하기 전 잠깐도 '이어서 하는 중'으로 보이게)
          ...(msg.agent ? { agent: true, at: Date.now() } : {}),
        })
      if (msg.ok) {
        st.connectTabs.delete(msg.id)
        if (st.overlay?.kind === 'connect') st.overlay = undefined
        // 대화를 보고 있으면 카드가 "연결돼 있어요"로 바뀌는 걸로 충분하다 (같은 말을 또 띄우지 않는다)
        if (st.tab !== 'chat' || st.screen.name !== 'app') toast(msg.message)
        runAfterConnect(msg.id)
      } else if (st.tab !== 'chat' || st.screen.name !== 'app') {
        // 화면을 멋대로 바꾸지 않는다: 알리기만 한다. 사람 차례면 알림을 눌러 바로 그 화면을 연다
        const tab = msg.tabId
        if (tab !== undefined && msg.reason === 'human')
          toast(`${msg.message} 눌러서 열기`, () => openRemote(tab, msg.id))
        else toast(msg.message)
      }
      break
    }
    case 'connect-opened':
      st.opening = undefined
      openRemote(msg.tabId, msg.id)
      return
    case 'error':
      st.opening = undefined
      st.sideWanted = false
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
  renderSoon()
}

/** 받은 신호를 한 줄로 (내용 말고 종류만. 흘러오는 글자·화면 그림은 적지 않는다) */
function markReceived(msg: PcToPhone) {
  if (msg.kind === 'screen' || msg.kind === 'form') return
  if (msg.kind === 'stream') {
    const ev = msg.event
    if (ev.type === 'agent') {
      if (ev.event.type === 'tool') mark(`받음 도구 ${ev.event.name}`)
      return
    }
    return mark(`받음 stream:${ev.type}${ev.type === 'saved' ? `:${ev.message.role}` : ''}`)
  }
  if (msg.kind === 'connect-result')
    return mark(
      `받음 connect-result ${msg.id} ${msg.ok ? 'ok' : (msg.reason ?? 'fail')}${msg.agent ? ' 이어받음' : ''}`,
    )
  if (msg.kind === 'connect-progress') return mark(`받음 connect-progress ${msg.id} ${msg.steps.length}단계`)
  if (msg.kind === 'connect-status') return mark(`받음 connect-status ${msg.connecting.join(',') || '없음'}`)
  if (msg.kind === 'conversation-status')
    return mark(`받음 conversation-status ${msg.busy ? '답하는 중' : '쉼'}`)
  if (msg.kind === 'error') return mark(`받음 error ${msg.message}`)
  mark(`받음 ${msg.kind}`)
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
    if (m.role === 'assistant' || (m.role === 'tool' && m.text.includes('"kind":"work"'))) {
      st.live = ''
      st.steps = []
    }
  } else if (ev.type === 'agent') {
    st.busy = true
    if (ev.event.type === 'text') st.live += ev.event.delta
    else if (ev.event.type === 'tool') {
      // 웹에서 일하기 시작하면 대화에 그 화면을 띄운다
      // (서비스 도구는 본체가 탭을 열면서 work-tab으로 알린다. 다른 도구를 잠깐 쓴다고 화면을 끄지 않는다)
      if (/browser_/.test(ev.event.name) && !st.work.web) {
        st.work = { ...st.work, web: true }
        pollWork()
      }
      // 도구 앞에 한 말은 답이 아니라 지금 하는 일. 한국어 한 줄만 단계로 남기고 말풍선은 비운다
      const act = `${ev.event.title ?? toolLabel(ev.event.name)} 중`
      const label = narrationLine(st.live) ?? act
      st.live = ''
      // 일한 곳: 연 주소, 주소 없는 웹 도구는 지금 보는 화면의 사이트
      const tabId = (ev.event.input as { tabId?: unknown } | undefined)?.tabId
      const shown = st.work.url && tabId === st.work.tabId ? hostOf(st.work.url) : ''
      const here = (typeof tabId === 'number' ? tabHosts.get(tabId) : undefined) || shown || workHost
      const place = toolPlace(ev.event.name, ev.event.input, here)
      if (/browser_open$/.test(ev.event.name) && place) {
        workHost = place
        openedHost = place
      }
      if (/browser_navigate$/.test(ev.event.name) && place) {
        workHost = place
        if (typeof tabId === 'number') tabHosts.set(tabId, place)
      }
      const n = st.steps.length
      if (st.steps.at(-1) !== label || stepInfo[n - 1]?.place !== place) {
        if (n === 0) {
          stepAt.length = 0
          stepInfo.length = 0
          workAllSteps = false
        }
        st.steps = [...st.steps, label]
        stepAt[n] = Date.now()
        stepInfo[n] = { act, ...(place ? { place } : {}) }
      }
    }
  } else if (ev.type === 'end') {
    st.live = ''
    st.steps = []
    workHost = undefined
    openedHost = undefined
    tabHosts.clear()
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

/**
 * 연결하기는 대화에서: 내 말 "○○ 연결해 줘"를 바로 띄우고, PC가 연결 카드를 대화에 남긴다.
 * 로그인은 그 카드에서 이어 가고, 진행·결과도 같은 대화에 남는다 (연결 화면에서 기다리지 않게)
 */
function connectInChat(id: string) {
  const it = st.services?.find((s) => s.card.id === id)
  // 로그인해서 쓰는 곳(브라우저·공식 연동 전)은 모두 대화에서 연결한다. 폰 권한(device)만 연결 화면에서 켠다
  if (!it || it.card.how === 'device' || it.card.how === 'open') return openOverlay({ kind: 'connect', id })
  if (!st.online) return toast('PC와 연결되면 할 수 있어요')
  // 같은 연결 카드가 대화 끝 가까이에 이미 있으면 새로 쌓지 않고 그 카드로 간다
  const near = st.conv.slice(-6).some((m) => {
    if (m.role !== 'tool') return false
    try {
      const rec = JSON.parse(m.text) as ConnectRecordMessage
      return rec.kind === 'connect' && connectFor(rec)?.card.id === id
    } catch {
      return false
    }
  })
  st.connectDetail = undefined
  if (near) return setTab('chat')
  st.pending.push({ id: ++pendingSeq, text: `${it.card.name} 연결해 줘` })
  setTab('chat')
  void send({ kind: 'connect', id, action: 'chat' })
}

let convSaveTimer: ReturnType<typeof setTimeout> | undefined
let convSavedLast = ''
/** 마지막 대화 40줄을 폰에 남긴다 (바뀌었을 때만, 1초 모아서) */
function keepConv() {
  if (!st.convLoaded) return
  const tail = st.conv.slice(-40)
  const sig = `${tail.length}:${tail.at(-1)?.id ?? ''}`
  if (sig === convSavedLast) return
  clearTimeout(convSaveTimer)
  convSaveTimer = setTimeout(() => {
    convSavedLast = sig
    void saveConv(tail).catch(() => undefined)
  }, 1000)
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

/** 승인할 때 고른 선택지 (결제 수단). 고르지 않았으면 카드의 기본값 */
function chosenOf(a: ApprovalView): string | undefined {
  if (!a.choices?.length) return undefined
  return st.choice.get(a.id) ?? a.choice ?? a.choices[0]?.id
}

/** 세부 선택(등록 카드·할부)에서 고른 것. 고르지 않았으면 결제 화면에서 골라져 있던 것 */
function subChosenOf(
  a: ApprovalView,
  g: NonNullable<ApprovalView['subChoices']>[number],
): string | undefined {
  return st.choice.get(`${a.id}:${g.key}`) ?? g.choice ?? g.options[0]?.id
}

/** 지금 고른 결제 수단에 딸린 세부 선택만 (카드를 골라야 등록 카드·할부가 있다) */
function subsFor(a: ApprovalView) {
  const main = chosenOf(a)
  return (a.subChoices ?? []).filter((g) => !g.when || !main || g.when === main)
}

/** 서명·전송할 선택 전체: 결제 수단과 세부 선택을 쉼표로 ("c2,s1o3") */
function choiceString(a: ApprovalView): string | undefined {
  const parts = [chosenOf(a), ...subsFor(a).map((g) => subChosenOf(a, g))].filter((x): x is string => !!x)
  return parts.length ? parts.join(',') : undefined
}

async function decide(a: ApprovalView, decision: 'approve' | 'reject', quiet = false) {
  const s = st.saved
  if (!s) return
  // 고른 결제 수단·카드·할부도 서명에 함께 묶는다 (중간에서 다른 것으로 바꿀 수 없다)
  const choice = decision === 'approve' ? choiceString(a) : undefined
  // 승인 내용에 이 폰의 키로 서명한다. PC가 페어링 때 받은 공개키로 확인한다
  const sig = await signText(s.keys.signPriv, approvalSignText(a, decision, choice))
  // 꾹 눌러 승인은 체크를 보여 준 뒤에 카드를 접는다 (markDecided를 나중에 부른다)
  if (!quiet) markDecided(a, decision)
  await send({ kind: 'decide', id: a.id, decision, sig, ...(choice ? { choice } : {}) })
}

/** 고른 결제 수단에 맞춘 마지막 버튼 이름 ('카드로 결제하기' → 네이버페이를 고르면 '네이버페이로 결제하기') */
function finalLabel(a: ApprovalView): string {
  const now = a.choices?.find((c) => c.id === chosenOf(a))
  if (!now) return a.label
  const from = a.choices?.find((c) => a.label.startsWith(c.label))
  return from ? `${now.label}${a.label.slice(from.label.length)}` : a.label
}

/** 승인 카드의 '어떤 걸로 결제할까요?' 줄 (사이트가 받는 수단만, 기본은 이 사이트에서 마지막으로 쓴 것) */
/**
 * 고를 것이 많으면(할부 12개월 등) 자주 쓰는 것만 먼저: 지금 고른 것, 일시불·무이자, 앞에서 몇 개. 나머지는 [더 보기]
 * (실측 쿠팡 할부: 일시불~12개월 12개가 칩으로 늘어서 승인 카드가 길었다)
 */
function shown<T extends { id: string; label: string }>(
  options: T[],
  now: string | undefined,
  key: string,
): T[] {
  if (options.length <= 6 || st.choice.get(`${key}:more`)) return options
  const keep = options.filter((o, i) => i < 3 || /일시불|무이자/.test(o.label)).slice(0, 5)
  // 지금 고른 것은 늘 보인다
  const cur = options.find((o) => o.id === now)
  if (cur && !keep.includes(cur)) keep.push(cur)
  return keep.length < options.length ? keep : options
}

function choiceRow(a: ApprovalView): HTMLElement | undefined {
  const subs = subsFor(a)
  if (!a.choices?.length && !subs.length) return undefined
  const row = (
    title: string,
    options: { id: string; label: string; mine?: string }[],
    now: string | undefined,
    key: string,
  ) =>
    h(
      'div',
      { class: 'approve-choices' },
      h('span', { class: 'meta', text: title }),
      h(
        'div',
        { class: 'chip-row' },
        ...shown(options, now, key).map((c) => {
          // 내 결제 수단과 맞는 칩은 점을 붙인다 (ADR 0023)
          const chip = h(
            'button',
            {
              class: `chip${c.id === now ? ' on' : ''}${c.mine ? ' mine' : ''}`,
              onclick: () => {
                st.choice.set(key, c.id)
                render()
              },
            },
            c.mine ? h('span', { class: 'mine-dot' }) : '',
            c.label,
          )
          if (c.mine) chip.setAttribute('aria-label', `${c.label} (내 결제 수단: ${c.mine})`)
          return chip
        }),
        ...(shown(options, now, key).length < options.length
          ? [
              h('button', {
                class: 'chip chip-more',
                text: `더 보기 ${options.length - shown(options, now, key).length}`,
                onclick: () => {
                  st.choice.set(`${key}:more`, '1')
                  render()
                },
              }),
            ]
          : []),
      ),
    )
  // 아직 아무것도 안 바꿨으면 한 줄로 요약 (카드 · 신한카드 · 일시불 [바꾸기]). [바꾸기]를 누르면 칩이 펼쳐진다
  const groups: {
    title: string
    options: { id: string; label: string; mine?: string }[]
    now?: string
    key: string
  }[] = [
    ...(a.choices?.length
      ? [
          {
            title: a.choices.some((c) => c.mine)
              ? `${a.choiceTitle ?? '결제 수단'} · 내 결제 수단을 먼저 골라 뒀어요`
              : `${a.choiceTitle ?? '결제 수단'} · 어떤 걸로 할까요?`,
            options: a.choices,
            now: chosenOf(a),
            key: a.id,
          },
        ]
      : []),
    ...subs.map((g) => ({
      title: g.title,
      options: g.options,
      now: subChosenOf(a, g),
      key: `${a.id}:${g.key}`,
    })),
  ]
  const touched = groups.some((g) => st.choice.has(g.key))
  if (groups.length > 1 && !touched && !st.choice.has(`${a.id}:open`)) {
    const summary = groups
      .map((g) => g.options.find((o) => o.id === g.now)?.label ?? '')
      .filter(Boolean)
      .join(' · ')
    return h(
      'div',
      { class: 'approve-choices one-line' },
      h('span', { class: 'meta', text: `${a.choiceTitle ?? '결제 수단'} · ${summary}` }),
      h('button', {
        class: 'chip chip-more',
        text: '바꾸기',
        onclick: () => {
          st.choice.set(`${a.id}:open`, '1')
          render()
        },
      }),
    )
  }
  return h('div', {}, ...groups.map((g) => row(g.title, g.options, g.now, g.key)))
}

/** 두리가 결제 전에 스스로 고른 것 (보험 안 함·약관 동의 등)을 따로 한 줄로 보여 준다 */
function choseRow(a: ApprovalView): HTMLElement | undefined {
  if (!a.chose?.length) return undefined
  return h(
    'div',
    { class: 'approve-chose' },
    h('span', { class: 'meta', text: '두리가 고른 것' }),
    h('p', { text: a.chose.join(' · ') }),
  )
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
/** 기다리는 로그인: 시간이 지났거나 그 서비스가 이미 연결된 것은 빼고 */
const pendingLogins = () =>
  [...st.logins.values()].filter((l) => {
    if (l.status !== 'pending' || Date.parse(l.expiresAt) <= Date.now()) return false
    const cid = cardIdFor(l.origin)
    const svc = cid ? st.services?.find((x) => x.card.id === cid) : undefined
    return !(svc?.connectedAt && Date.parse(svc.connectedAt) >= Date.parse(l.createdAt))
  })

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

/** 원격 화면을 열기 전 탭 (닫으면 거기로 돌아간다: 대화에서 열었으면 대화로) */
let remoteFrom: Tab = 'chat'
function openRemote(tabId: number, connectId?: string) {
  if (st.screen.name === 'app') remoteFrom = st.tab
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

/** 연결하는 동안: 대화의 연결 카드에 두리가 로그인하고 있는 화면을 작게 실시간으로 */
let connectTimer: ReturnType<typeof setTimeout> | undefined
function pollConnect() {
  clearTimeout(connectTimer)
  const tick = () => {
    const tabs = [...st.connectLive.entries()].filter(([id]) => st.connecting.has(id))
    const watching =
      tabs.length && st.tab === 'chat' && st.screen.name === 'app' && document.visibilityState === 'visible'
    if (!watching) return
    for (const [, l] of tabs) void send({ kind: 'screen', tabId: l.tabId })
    connectTimer = setTimeout(tick, 1500)
  }
  connectTimer = setTimeout(tick, 300)
}

/** 연결 카드 안의 로그인 화면 (누르면 크게 열어 직접 할 수 있다) */
function connectPeek(id: string): HTMLElement | undefined {
  const l = st.connectLive.get(id)
  if (!l?.shot) return undefined
  const img = h('img', { class: 'connect-shot' })
  img.dataset.tab = String(l.tabId)
  img.src = `data:image/jpeg;base64,${l.shot}`
  return h(
    'button',
    { class: 'wp-peek', label: '로그인 화면 크게 보기', onclick: () => openRemote(l.tabId, id) },
    h(
      'span',
      { class: 'wp-bar' },
      h('span', { text: '두리가 로그인하고 있는 화면' }),
      h('span', { class: 'wp-live', text: '지금' }),
    ),
    img,
  )
}

/** 단계가 시작된 때 (st.steps와 같은 순서) */
const stepAt: number[] = []
/** 단계마다 도구가 한 일·일한 곳 (st.steps와 같은 순서) */
const stepInfo: { act: string; place?: string }[] = []
/** 마지막으로 연 사이트 (탭을 모르는 browser_ 도구가 이어서 쓴다) */
let workHost: string | undefined
/** 탭 번호 → 그 탭의 사이트. 화면 그림의 주소와 '연 직후 새 탭' 알림으로 채운다 (여러 탭을 오가도 맞는 줄에) */
const tabHosts = new Map<number, string>()
/** 방금 browser_open으로 연 사이트: 다음에 처음 보는 탭이 그 사이트 */
let openedHost: string | undefined
/** 일하는 카드에서 앞 단계까지 펼쳤는지 (차례마다 처음엔 접힘) */
let workAllSteps = false
/** 두리가 보고 있는 화면을 펼쳐 둘지 (기본은 접힘, 펼쳐 두면 다음 일에도 그대로) */
const PEEK_KEY = 'dool2.workPeek'
const peekOpen = () => localStorage.getItem(PEEK_KEY) === '1'

/** 사이트 주소 → 연결 카드 이름 (catchtable.co.kr → 캐치테이블), 없으면 주소 */
function siteName(host: string): string {
  return cardForHost(host, placeCards())?.name ?? bareHost(host)
}

function placeCards(): PlaceCard[] {
  return (st.services ?? []).map((s) => ({
    id: s.card.id,
    name: s.card.name,
    ...(s.card.site ? { site: s.card.site } : {}),
  }))
}

function secs(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ''}`
}

/** 줄 왼쪽 아이콘: 서비스 로고(없으면 첫 글자), PC 앱·파일·두리 일은 선 아이콘. 모서리에 빙글빙글/체크 */
function groupMark(g: WorkGroup, state: 'done' | 'doing'): HTMLElement {
  const glyph: IconName | undefined =
    g.kind === 'app' ? 'pc' : g.kind === 'file' ? 'note' : g.kind === 'doori' ? 'brain' : undefined
  const mark = h('span', { class: `svc-mark ws-mark${glyph ? ' plain' : ''}`, text: glyph ? '' : g.letter })
  if (glyph) mark.append(icon(glyph, 'i'))
  else withLogo(mark, g.cardId)
  return h(
    'span',
    { class: 'ws-ico' },
    mark,
    h('span', { class: `ws-badge ${state}` }, state === 'done' ? icon('check', 'i') : ''),
  )
}

/** 서비스 한 줄: 아이콘 · 이름 / 하는 일 · 걸린 시간 */
function groupRow(g: WorkGroup, state: 'done' | 'doing'): HTMLElement {
  const sub = state === 'doing' ? g.act : g.kind === 'doori' ? '' : doneLine(g)
  return h(
    'li',
    { class: `ws ${state}` },
    groupMark(g, state),
    h(
      'span',
      { class: 'wt' },
      h('b', { text: g.title }),
      sub && sub !== g.title ? h('span', { class: 'wsub', text: sub }) : '',
    ),
    h('span', { class: 't', text: state === 'done' && g.ms !== undefined ? secs(g.ms) : '' }),
  )
}

/** 같은 줄인지 (다시 그릴 때 그대로 둘지) */
const groupSig = (g: WorkGroup, state: string) => `${g.key}|${g.title}|${g.act}|${g.count}|${state}`

/** 지금 하는 일의 줄들 (끝난 줄은 걸린 시간까지) */
function liveGroups(): WorkGroup[] {
  const steps = st.steps.map((text, i) => {
    const next = stepAt[i + 1]
    const at = stepAt[i]
    const info = stepInfo[i]
    return {
      text,
      act: info?.act ?? text,
      ...(info?.place ? { place: info.place } : {}),
      ...(next && at ? { ms: next - at } : {}),
    }
  })
  return groupSteps(steps, placeCards())
}

/** 두리 혼잣말 가운데 마지막 것 (도구 이름이 아닌 것) */
function lastNarration(): string | undefined {
  for (let i = st.steps.length - 1; i >= 0; i--) {
    const t = st.steps[i] as string
    if (t !== stepInfo[i]?.act) return t
  }
  return undefined
}

function clockText() {
  const from = stepAt[0]
  if (!from) return ''
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 대화 안 일하는 카드: 두리 + 지금 하는 말 · 서비스별 줄(빙글빙글 → 체크) · 접힌 '두리가 보고 있는 화면'.
 * 화면은 기본 접힘(작은 미리보기 + 지금 점), 누르면 펼쳐지고 펼친 화면을 누르면 크게 본다
 */
function workPanel(): HTMLElement {
  const toggle = h(
    'button',
    { class: 'wp-peek-bar', label: '두리가 보고 있는 화면 펼치기' },
    h('img', { class: 'work-thumb' }),
    h('span', { class: 'wp-peek-t', text: '두리가 보고 있는 화면' }),
    h('span', { class: 'wp-live', text: '지금' }),
    icon('chevron', 'i wp-chev'),
  )
  const big = h(
    'button',
    {
      class: 'wp-peek wp-peek-in',
      label: '두리 화면 크게 보기',
      onclick: () => st.work.tabId !== undefined && openRemote(st.work.tabId),
    },
    h('img', { class: 'work-shot' }),
    h('span', { class: 'wp-hint', text: '누르면 크게 보고 직접 누를 수 있어요' }),
  )
  const wrap = h('div', { class: 'wp-view' }, toggle, h('div', { class: 'wp-shot-box' }, h('div', {}, big)))
  const setOpen = (open: boolean) => {
    wrap.classList.toggle('open', open)
    toggle.setAttribute('aria-expanded', String(open))
  }
  setOpen(peekOpen())
  toggle.addEventListener('click', () => {
    const open = !wrap.classList.contains('open')
    localStorage.setItem(PEEK_KEY, open ? '1' : '0')
    setOpen(open)
  })
  const clock = h('span', { class: 'wp-clock' })
  const card = h(
    'div',
    { class: 'work-panel' },
    h('div', { class: 'wp-head' }, doori('thinking', 26), h('b', { class: 'wp-title' }), clock),
    h('ol', { class: 'wp-steps' }),
    wrap,
  )
  // 걸린 시간: 카드가 화면에 있는 동안만 1초마다
  const tick = () => {
    if (!card.isConnected && clock.textContent) return
    clock.textContent = clockText()
    setTimeout(tick, 1000)
  }
  tick()
  updateWorkPanel(card)
  return card
}

function updateWorkPanel(card: HTMLElement) {
  const title = lastNarration() ?? '부탁하신 일을 하는 중'
  const t = card.querySelector('.wp-title')
  if (t && t.textContent !== title) t.textContent = title
  // 지금 화면: 웹에서 일하고 그림이 왔을 때만
  const view = card.querySelector<HTMLElement>('.wp-view')
  const shot = st.work.web ? st.work.shot : undefined
  if (view) view.hidden = !shot
  if (shot) {
    const src = `data:image/jpeg;base64,${shot}`
    for (const img of card.querySelectorAll<HTMLImageElement>('.work-shot, .work-thumb'))
      if (img.src !== src) img.src = src
  }
  // 줄: 바뀐 것만. 새 줄은 아래에서 떠오르고, 방금 끝난 줄은 체크가 톡
  const list = card.querySelector<HTMLElement>('.wp-steps')
  if (!list) return
  const groups = liveGroups()
  const hidden = workAllSteps ? 0 : Math.max(0, groups.length - 4)
  const shown = groups.slice(hidden)
  const more = list.querySelector<HTMLElement>('.ws.more')
  if (hidden) {
    const text = `앞 단계 ${hidden}개`
    if (!more)
      list.prepend(
        h(
          'li',
          { class: 'ws more' },
          h('button', {
            text,
            label: '앞 단계 펼치기',
            onclick: () => {
              workAllSteps = true
              updateWorkPanel(card)
            },
          }),
        ),
      )
    else if (more.textContent !== text) (more.firstElementChild as HTMLElement).textContent = text
  } else more?.remove()
  // 줄은 곳(key)마다 하나: 있던 줄은 옮기고(다시 간 곳은 맨 아래로), 바뀐 줄만 새로 그린다
  const old = new Map<string, HTMLElement>()
  // 같은 key 줄이 둘이면 하나만 남긴다 (남은 줄은 다시 지워지지 않고 쌓인다)
  for (const r of list.querySelectorAll<HTMLElement>('.ws:not(.more)')) {
    const k = r.dataset.key ?? ''
    if (old.has(k)) r.remove()
    else old.set(k, r)
  }
  const keep = new Set(shown.map((g) => g.key))
  for (const [k, r] of old) if (!keep.has(k)) r.remove()
  shown.forEach((g, i) => {
    const state = i === shown.length - 1 ? 'doing' : 'done'
    const sig = groupSig(g, state)
    const row = old.get(g.key)
    let el = row
    if (row?.dataset.sig !== sig) {
      el = groupRow(g, state)
      el.dataset.key = g.key
      el.dataset.sig = sig
      if (row) row.replaceWith(el)
    }
    if (!el) return
    // 제자리가 아니면 옮긴다 (더 보기 줄 뒤로 i번째)
    const at = list.querySelectorAll('.ws:not(.more)')[i]
    if (at !== el) list.insertBefore(el, at ?? null)
    if (!row && (i > 0 || groups.length > 1))
      springTo(
        el,
        [
          { opacity: 0, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'none' },
        ],
        'item',
      )
    else if (row && state === 'done' && row.classList.contains('doing')) {
      const s = el.querySelector('.ws-badge')
      if (s) springTo(s, [{ transform: 'scale(0.4)' }, { transform: 'scale(1)' }], 'pop')
    }
  })
}

/**
 * 연결이 사람을 기다리는지: 마지막 단계가 계정·인증번호를 묻고 있고 그 요청이 아직 열려 있으면.
 * 단계를 못 받았으면(앱을 나중에 열었거나 예전 PC) 연결용 로그인 요청이 열려 있는지로 본다
 */
function connectWaiting(id: string): ConnectStep['ask'] | undefined {
  const open = (a: NonNullable<ConnectStep['ask']>) =>
    a.kind === 'confirm'
      ? st.connecting.has(id)
      : a.kind === 'login'
        ? st.logins.get(a.id)?.status === 'pending'
        : st.infos.has(a.id)
  const last = st.connectSteps.get(id)?.at(-1)?.ask
  if (last) return open(last) ? last : undefined
  if (!st.connecting.has(id)) return undefined
  const login = [...st.logins.values()].find((l) => l.status === 'pending' && l.connect)
  if (login) return { kind: 'login', id: login.id, label: `${login.site} 넣기` }
  const info = [...st.infos.values()].at(-1)
  return info ? { kind: 'info', id: info.id, label: `${info.label} 넣기` } : undefined
}

/**
 * 연결이 끝까지 못 갔을 때 카드: 까닭 + 바로 할 수 있는 것 하나.
 * 사람 차례(보안문자·본인인증)는 [화면 열기] — 마치면 두리가 알아서 연결로 표시한다
 */
function connectFailCard(
  c: ConnectionItem['card'],
  fail: NonNullable<ReturnType<typeof st.connectFails.get>>,
  mark: HTMLElement,
): HTMLElement {
  const tab = fail.tabId
  const openScreen = () => tab !== undefined && openRemote(tab, c.id)
  const retry = () => openOverlay({ kind: 'connect', id: c.id })
  // 자동 로그인이 멈춰 두리가 대화에서 이어받은 동안: 실패가 아니라 하는 중이다 (진행은 바로 아래 일하는 카드에 보인다)
  if (agentOn(fail))
    return h(
      'div',
      { class: 'card approve-card connect-card' },
      h(
        'div',
        { class: 'approve-head' },
        mark,
        h(
          'div',
          {},
          h('strong', { text: '두리가 화면을 보며 이어서 하고 있어요' }),
          h('span', {
            class: 'meta',
            text: '로그인 화면이 예상과 달라서, 직접 읽어 가며 로그인하는 중이에요',
          }),
        ),
        h('span', { class: 'spin' }),
      ),
      tab !== undefined
        ? h(
            'div',
            { class: 'approve-actions' },
            h('button', { class: 'btn-ghost', text: '화면 보며 직접', onclick: openScreen }),
          )
        : undefined,
    )
  const view =
    fail.reason === 'wrong'
      ? {
          title: '아이디나 비밀번호가 맞지 않아요',
          meta: '다시 넣어 주시면 두리가 바로 다시 해 볼게요',
          main: h('button', { class: 'btn', text: '다시 넣기', onclick: retry }),
          sub:
            tab !== undefined
              ? h('button', { class: 'btn-ghost', text: '화면 보며 직접', onclick: openScreen })
              : undefined,
        }
      : fail.reason === 'human'
        ? {
            title: '이 단계는 직접 해 주셔야 해요',
            meta: `${fail.message.replace(/\.?\s*화면을 열어 직접 마쳐 주세요\.?$/, '')}. 마치시면 두리가 알아서 연결해요`,
            main:
              tab !== undefined
                ? h('button', { class: 'btn', text: '화면 열기', onclick: openScreen })
                : undefined,
            sub: h('button', { class: 'btn-ghost', text: '처음부터 다시', onclick: retry }),
          }
        : {
            title: `${c.name} 로그인을 끝까지 못 했어요`,
            meta:
              tab !== undefined ? `${fail.message} 화면에서 마치시면 두리가 알아서 연결해요` : fail.message,
            main:
              tab !== undefined
                ? h('button', { class: 'btn', text: '화면 보며 직접', onclick: openScreen })
                : undefined,
            sub: h('button', { class: 'btn-ghost', text: '다시 해 보기', onclick: retry }),
          }
  return h(
    'div',
    { class: 'card approve-card connect-card ask' },
    h(
      'div',
      { class: 'approve-head' },
      mark,
      h('div', {}, h('strong', { text: view.title }), h('span', { class: 'meta', text: view.meta })),
    ),
    h('div', { class: 'approve-actions' }, view.sub, view.main),
  )
}

/** 자동 로그인이 멈춘 뒤 두리가 이어받아 하는 중인가 (답하는 중이거나, 넘겨받은 지 20초 안) */
function agentOn(fail: { agent?: boolean; at?: number }): boolean {
  return Boolean(fail.agent) && (st.busy || Date.now() - (fail.at ?? 0) < 20_000)
}

/** 연결 카드 설명: 그 서비스가 실제로 되는 방법대로 (간편 로그인만 되는 곳에 "아이디·비밀번호"라고 하지 않는다) */
function connectHow(c: ConnectionItem['card']): string {
  const social = (c.social ?? []).slice(0, 2).map((p) => SOCIAL_LABEL[p])
  const idLogin = /아이디|비밀번호|이메일/.test(c.login ?? '')
  if (social.length && !idLogin) return `${social.join('·')} 간편 로그인으로 두리가 PC에서 연결해요`
  if (social.length) return `아이디·비밀번호나 ${social.join('·')} 간편 로그인으로 연결해요`
  return '아이디·비밀번호를 넣으면 두리가 PC에서 로그인해요'
}

/** 연결하는 동안 단계: 끝난 단계는 ✓와 걸린 시간, 지금 단계는 도는 동그라미 */
function connectStepList(id: string, waiting = false): HTMLElement | undefined {
  const all = st.connectSteps.get(id)
  // 사람을 기다릴 때는 카드 제목이 "○○이 필요해요"라서 같은 말의 마지막 단계는 뺀다
  const steps = waiting && all?.at(-1)?.ask ? all.slice(0, -1) : all
  if (!steps?.length) return undefined
  const list = h('ol', { class: 'wp-steps connect-steps' })
  steps.forEach((s, i) => {
    const next = steps[i + 1]
    list.append(stepRow(s.text, next ? 'done' : 'doing', next ? next.at - s.at : undefined))
  })
  // 새로 온 단계만 아래에서 떠오른다
  const last = list.lastElementChild
  if (last && steps.length > 1)
    springTo(
      last,
      [
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'none' },
      ],
      'item',
    )
  return list
}

/** 연결하는 동안 단계 한 줄: 끝난 단계는 ✓와 걸린 시간, 지금 단계는 도는 동그라미 */
function stepRow(text: string, state: 'done' | 'doing', ms?: number) {
  return h(
    'li',
    { class: `ws ${state}` },
    h('span', { class: 's' }, state === 'done' ? icon('check', 'i') : ''),
    h('span', { class: 'wt', text }),
    h('span', { class: 't', text: ms !== undefined ? secs(ms) : '' }),
  )
}

/**
 * 끝난 뒤: 답 위에 접힌 한 줄 "아이콘 묶음 · 4곳 살펴봤어요 · 41초" (누르면 서비스별 줄이 펼쳐진다).
 * 예전 기록(곳 정보 없음)은 "일한 과정 · N단계"
 */
function workDone(rec: WorkRecordMessage): HTMLElement {
  const groups = groupSteps(rec.steps, placeCards())
  const places = [
    ...new Map(
      groups.filter((g) => g.kind === 'web' || g.kind === 'service').map((g) => [g.key, g]),
    ).values(),
  ]
  const list = h('ol', { class: 'wp-steps' })
  if (rec.count > rec.steps.length)
    list.append(h('li', { class: 'ws more', text: `앞의 ${rec.count - rec.steps.length}단계는 줄였어요` }))
  for (const g of groups) list.append(groupRow(g, 'done'))
  list.hidden = true
  const lead = places.length
    ? h(
        'span',
        { class: 'wd-stack' },
        ...places
          .slice(0, 4)
          .map((g) => withLogo(h('span', { class: 'svc-mark', text: g.letter }), g.cardId)),
      )
    : h('span', { class: 'wd-ok' }, icon('check', 'i'))
  const title = places.length
    ? places.length === 1
      ? `${places[0]?.title}에서 일했어요`
      : `${places.length}곳 살펴봤어요`
    : rec.host
      ? `${siteName(rec.host)}에서 일했어요`
      : '일한 과정'
  const head = h(
    'button',
    { class: 'wd-head', label: '일한 과정 펼치기' },
    lead,
    h('span', { class: 'wd-title', text: title }),
    h('span', {
      class: 'wd-meta',
      text: places.length ? secs(rec.ms) : `${rec.count}단계 · ${secs(rec.ms)}`,
    }),
    icon('chevron', 'i wd-chev'),
  )
  head.setAttribute('aria-expanded', 'false')
  const card = h('div', { class: 'work-panel done' }, head, list)
  head.addEventListener('click', () => {
    const open = list.hidden !== false
    list.hidden = !open
    card.classList.toggle('open', open)
    head.setAttribute('aria-expanded', String(open))
    if (open)
      springTo(
        list,
        [
          { opacity: 0, transform: 'translateY(-6px)' },
          { opacity: 1, transform: 'none' },
        ],
        'item',
      )
  })
  return card
}

// ── 알림 ──

/** 알림 막대 (누를 수 있으면 onTap: 예를 들어 [화면 열기]) */
let toastTap: (() => void) | undefined
function toast(text: string, onTap?: () => void) {
  mark(`알림 ${text}`)
  st.toast = text
  toastTap = onTap
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

/**
 * PC에서 온 소식으로 다시 그릴 때: 한 프레임에 한 번만 그린다.
 * 답이 흘러오는 동안에는 소식이 초당 수십 번 와서, 올 때마다 그리면 화면 전체가 그만큼 다시 만들어졌다
 */
let renderQueued = 0
function renderSoon() {
  if (renderQueued) return
  renderQueued = requestAnimationFrame(() => {
    renderQueued = 0
    render()
  })
}

function render() {
  if (renderQueued) {
    cancelAnimationFrame(renderQueued)
    renderQueued = 0
  }
  keepConv()
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
    app.replaceChildren(view, t, ...(s.name === 'side' ? sideOverlay() : []))
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
    shell.toast.classList.toggle('tap', Boolean(toastTap))
    shell.toast.onclick = toastTap
      ? () => {
          const f = toastTap
          toastTap = undefined
          st.toast = undefined
          f?.()
        }
      : null
  }
  // 다시 그린 뒤: 칸 하이라이트·스위치 손잡이를 앞 자리에서 새 자리로 움직인다
  playSeg()
  playFlip()
}

function buildShell() {
  const top = h('header', { class: 'app-top' })
  const page = h('main', { class: 'app-page' })
  const chat = h('div', { class: 'chat-list' })
  page.addEventListener(
    'scroll',
    () => {
      // 아래 탭은 내려도 숨기지 않는다: 숨으면 다른 탭으로 갈 길이 안 보였다 (사용자 의견)
      if (st.tab === 'chat') stickToBottom = page.scrollHeight - page.scrollTop - page.clientHeight < 80
      // 피드·보관함: 아래 끝 가까이 내리면 다음 페이지
      else if (page.scrollHeight - page.scrollTop - page.clientHeight < 600) visiblePager()?.more()
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
  return suggestRest({
    draft,
    talk: recentTalk(st.conv),
    mine: (st.life?.ideas ?? []).map((i) => i.text),
    catalog: ideaCatalog(st.services ?? []).flatMap((g) => g.items.map((i) => i.ask)),
  })
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
  matchTextBox(g, t)
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
  // 넘칠 때만 오른쪽을 흐린다 (다 들어가면 마지막 글자까지 또렷하게)
  restEl.classList.toggle('clip', restEl.scrollWidth > restEl.clientWidth + 1)
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
  mark(`탭 ${tab}`)
  st.tab = tab
  st.overlay = undefined
  if (tab === 'chat') stickToBottom = true
  if (tab === 'connect') st.connectDetail = undefined
  render()
  const page = shell?.page
  if (!page) return
  page.scrollTo({ top: tab === 'chat' ? page.scrollHeight : 0 })
  if (tab === 'chat') {
    pollWork()
    pollConnect()
  }
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
  const pcOn = st.online && !st.pcSilent
  const pcName = shortPc(st.saved?.pcName)
  // 바뀐 것이 없으면 그대로 둔다. 답이 흘러오는 동안 매번 버튼을 새로 만들면
  // 누르는 사이에 버튼이 사라져서 메뉴·두리 버튼이 안 눌리는 일이 생겼다
  const sig = [mood, status, waiting ? 1 : 0, pcOn ? 1 : 0, pcName].join('|')
  if (t.dataset.sig === sig && t.childElementCount) return
  t.dataset.sig = sig
  if (!t.childElementCount)
    t.replaceChildren(
      h(
        'button',
        { class: 'fbtn', label: '메뉴', onclick: () => openOverlay({ kind: 'drawer' }) },
        icon('menu'),
      ),
      h(
        'button',
        { class: 'agent', label: '두리 패널 열기', onclick: () => openOverlay({ kind: 'agent' }) },
        h('span', { class: 'agent-av' }),
        h('span', { class: 'agent-tag' }),
      ),
      h(
        'button',
        { class: 'fpill', label: '내 PC', onclick: () => setTab('settings') },
        h('span', { class: 'dot' }),
        h('span', { class: 'fpill-name' }),
      ),
    )
  const av = t.querySelector<HTMLElement>('.agent-av')
  if (av && av.dataset.mood !== mood) {
    av.dataset.mood = mood
    av.replaceChildren(doori(mood))
  }
  t.querySelector('.fpill .dot')?.classList.toggle('work', pcOn)
  const nameEl = t.querySelector('.fpill-name')
  if (nameEl && nameEl.textContent !== pcName) nameEl.textContent = pcName
  // 상태 섬: 글이 바뀌면 앞 크기에서 새 크기로 스프링 (가로가 먼저 닿고 세로가 따라온다), 글은 흐려졌다 또렷해진다
  const old = t.querySelector<HTMLElement>('.agent-tag')
  if (!old || old.dataset.status === status) return
  const before = old.dataset.status !== undefined ? { w: old.offsetWidth, h: old.offsetHeight } : undefined
  const tag = h(
    'span',
    { class: 'agent-tag' },
    '두리',
    status && h('span', { class: waiting ? 'ask' : !pcOn ? 'off' : '', text: status }),
  )
  tag.dataset.status = status
  old.replaceWith(tag)
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
  mark(o ? `열기 ${o.kind}` : '닫기')
  // 금고 시트를 닫으면 보여 준 비밀번호를 바로 지운다
  if (o?.kind !== 'vault') st.vaultShown = undefined
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
  // 기다리는 입력 카드를 닫았으면 입력창 위에 다시 여는 줄
  let slot = composerBox.querySelector<HTMLElement>(':scope > .info-wait-slot')
  if (!slot) {
    slot = h('div', { class: 'info-wait-slot' })
    composerBox.prepend(slot)
  }
  slot.replaceChildren(...infoWaitBar())
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
    pageDrawn = ''
    if (page.firstChild !== chat || page.childNodes.length !== 1) page.replaceChildren(chat)
    syncChat()
    // (그 사이 다른 탭으로 갔으면 그 탭을 끝으로 내리지 않는다)
    if (stickToBottom)
      requestAnimationFrame(() => {
        if (st.tab === 'chat') page.scrollTo({ top: page.scrollHeight })
      })
    return
  }
  const ctx = lifeCtx()
  const view =
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
              : connectView()
  // 모양이 그대로면 손대지 않는다. PC에서 소식이 올 때마다 탭 화면을 통째로 다시 꽂으면
  // 그림이 깜빡이고, 찾기 칸에 쓰던 글자의 커서와 키보드가 사라진다
  const drawn = `${st.tab}\n${view.outerHTML}`
  if (drawn === pageDrawn && page.firstChild && page.firstChild !== chat) return
  pageDrawn = drawn
  const y = page.scrollTop
  const typing = typingIn(page)
  page.replaceChildren(view)
  page.scrollTop = y
  typing?.()
}

/** 마지막으로 그린 탭 화면의 모양 (대화 탭은 바뀐 말만 따로 맞춘다) */
let pageDrawn = ''

/** 탭 화면이 스스로 일부를 다시 그렸을 때(찾기): 지금 모양을 기억해 둔다 (다음 소식에 통째로 다시 꽂지 않게) */
function pageSettled() {
  const view = shell?.page.firstElementChild
  if (view && st.tab !== 'chat') pageDrawn = `${st.tab}\n${view.outerHTML}`
}

/**
 * 다시 그리기 전에: 그 안에서 글을 쓰는 중이면 쓰던 글자·커서를 기억했다가 새 칸에 돌려준다.
 * (id가 있는 칸만. 새 칸이 이미 값을 갖고 그려졌으면 그 값을 둔다)
 */
function typingIn(box: HTMLElement): (() => void) | undefined {
  const fields = [...box.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[id], textarea[id]')]
    .filter((f) => f.type !== 'file' && f.value)
    .map((f) => ({ id: f.id, value: f.value }))
  const a = document.activeElement
  const active =
    (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) && a.id && box.contains(a)
      ? { id: a.id, at: safeCaret(a) }
      : undefined
  if (!fields.length && !active) return undefined
  return () => {
    for (const f of fields) {
      const el = document.getElementById(f.id) as HTMLInputElement | null
      if (!el || !box.contains(el) || el.value) continue
      el.value = f.value
      // 칸을 보고 그리는 것(인증번호 상자)이 따라오게
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    if (!active) return
    const el = document.getElementById(active.id) as HTMLInputElement | null
    if (!el || !box.contains(el)) return
    el.focus({ preventScroll: true })
    if (active.at !== null)
      try {
        el.setSelectionRange(active.at, active.at)
      } catch {}
  }
}

/** 커서 자리 (이메일·숫자 칸은 물으면 오류가 난다) */
function safeCaret(el: HTMLInputElement | HTMLTextAreaElement): number | null {
  try {
    return el.selectionStart
  } catch {
    return null
  }
}

// ── 대화: 바뀐 말만 ──

/** i번째 기록 다음에 사용자가 한 말 (보내는 중인 말 포함). 없으면 undefined */
function saidAfter(i: number): string | undefined {
  for (const m of st.conv.slice(i + 1)) if (m.role === 'user') return readAppNote(m.text) ?? m.text
  return st.pending[0]?.text
}

/** 결과 블록(빠른 답·목록 줄·결과 한 장·보낼 글)이 쓰는 것: 말 보내기, 바깥 주소 열기, 사진, 복사 */
const blockEnv: BlockEnv = {
  send: (text) => ask(text),
  open: (url) => openOutside(url),
  thumb: (url) => thumbOf(url),
  copy: (text) =>
    navigator.clipboard?.writeText(text).then(
      () => true,
      () => false,
    ) ?? Promise.resolve(false),
}

/** 앱 밖 브라우저(또는 그 서비스 앱)로 연다 */
function openOutside(url: string) {
  try {
    mark(`바깥 열기 ${new URL(url).host}`)
  } catch {}
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.click()
}

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
  let lastNote = ''
  const superseded = oldConnectCards()
  for (const [i, m] of st.conv.entries()) {
    // 같은 알림이 이어서 여러 번 남았으면(예전 기록) 하나만 보인다
    const noteText = m.role !== 'assistant' && m.role !== 'tool' ? readAppNote(m.text) : undefined
    if (noteText !== undefined && noteText === lastNote) continue
    lastNote = noteText ?? ''
    if (m.role === 'tool') {
      // 같은 서비스 연결 카드가 여럿이면 마지막 것만 살아 움직인다 (앞의 것은 한 줄로)
      const old = superseded.has(m.id)
      // 빠른 답·여러 개 고르기는 사용자가 그다음에 한 말을 알아야 흐리게·잠가 그린다
      const used = /"kind":"quick"|"pick":"multi"/.test(m.text) ? saidAfter(i) : undefined
      items.push({
        key: m.id,
        sig: `${old ? 'old:' : ''}${toolSig(m.text)}:${st.services ? 1 : 0}:${used ?? ''}`,
        make: () => toolCard(m.text, !old, used),
      })
    } else if (m.role === 'user') {
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
    const shot = st.work.web && st.busy && st.work.tabId !== undefined && st.work.shot
    // 일하는 과정은 카드 하나로: 지금 보는 화면 + 단계 (랜딩의 "○○을 살펴보는 중")
    if (st.busy && (st.steps.length || shot)) items.push({ key: 'work', sig: '', make: workPanel })
    if (st.live) items.push({ key: 'live', sig: '', make: liveBubble })
    else if (!st.steps.length)
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
    } else if (el && it.key === 'work') {
      // 일하는 카드는 새 단계만 붙인다 (지금 화면 그림은 그대로 두고)
      updateWorkPanel(el)
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
      // 승인 카드에서 고른 결제 수단·카드·할부도 넣는다. 빠지면 칩을 눌러도 카드를 다시 그리지 않아 고른 게 안 바뀌었다 (실측)
      const picked = a
        ? [...st.choice]
            .filter(([k]) => k === a.id || k.startsWith(`${a.id}:`))
            .map(([k, v]) => `${k}=${v}`)
            .join(',')
        : ''
      return `${a?.id}:${a?.status}:${a ? (st.decided.get(a.id)?.message ?? '') : ''}:${picked}`
    }
    if (rec.kind === 'login') {
      const l = loginFor(rec as LoginRecordMessage)
      const link = l ? loginLink(l.origin) : undefined
      const steps = link ? (st.connectSteps.get(link.cid)?.length ?? 0) : 0
      return `${l?.id}:${l?.status}:${link?.busy ?? ''}:${link?.fail?.reason ?? ''}:${steps}`
    }
    if (rec.kind === 'tell')
      return `tell:${feedPager.items.find((f) => f.id === (rec as TellRecordMessage).id)?.answered ?? ''}`
    if (rec.kind === 'connect') {
      const it = connectFor(rec as ConnectRecordMessage)
      const steps = it ? (st.connectSteps.get(it.card.id)?.length ?? 0) : 0
      const wait = it ? (connectWaiting(it.card.id)?.kind ?? '') + (connectWaiting(it.card.id)?.id ?? '') : ''
      const f = it ? st.connectFails.get(it.card.id) : undefined
      const fail = f ? `${f.reason}${agentOn(f) ? ':agent' : ''}` : ''
      const peek = it && st.connectLive.get(it.card.id)?.shot ? 1 : 0
      return `${it?.card.id}:${it?.connectedAt ?? ''}:${it && st.connecting.has(it.card.id)}:${steps}:${wait}:${fail}:${peek}`
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

/** 뒤에 같은 서비스 연결 카드가 또 있는 카드들 (메시지 id) */
function oldConnectCards(): Set<string> {
  const lastFor = new Map<string, string>()
  const out = new Set<string>()
  for (const m of st.conv) {
    if (m.role !== 'tool' || !m.text.includes('"kind":"connect"')) continue
    try {
      const rec = JSON.parse(m.text) as ConnectRecordMessage
      const id = connectFor(rec)?.card.id ?? rec.service
      const prev = lastFor.get(id)
      if (prev) out.add(prev)
      lastFor.set(id, m.id)
    } catch {}
  }
  return out
}

function toolCard(raw: string, live = true, used?: string): HTMLElement {
  let rec:
    | HandoffRecord
    | ApprovalRecordMessage
    | LoginRecordMessage
    | ConnectRecordMessage
    | WorkRecordMessage
    | TellRecordMessage
    | CardsRecordMessage
  try {
    rec = JSON.parse(raw)
  } catch {
    return h('span')
  }
  const block = blockView(rec as { kind?: string }, blockEnv, used)
  if (block) return block
  if (rec.kind === 'approval') return approvalInline(rec)
  if (rec.kind === 'login') return loginInline(rec)
  if (rec.kind === 'connect') return connectInline(rec, live)
  if (rec.kind === 'work') return workDone(rec)
  if (rec.kind === 'tell') return tellInline(rec)
  if (rec.kind === 'cards') return cardsInline(rec)
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
    itemsList(a, 5),
    choseRow(a),
    choiceRow(a),
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

/** 승인할 목록 (PC 파일 옮기기·출력): 앞 max줄과 남은 개수 */
function itemsList(a: ApprovalView, max: number): HTMLElement | undefined {
  if (!a.items?.length) return undefined
  return h(
    'ul',
    { class: 'approve-items' },
    ...a.items.slice(0, max).map((line) => h('li', { text: line })),
    ...(a.items.length > max ? [h('li', { class: 'meta', text: `… 외 ${a.items.length - max}개` })] : []),
  )
}

function approveQuestion(a: ApprovalView) {
  if (a.kind === 'money') return '결제할까요?'
  if (a.kind === 'contact') return '보낼까요?'
  if (a.kind === 'app') return '이 PC 앱을 다뤄도 될까요?'
  if (a.kind === 'file')
    return `이대로 ${a.label === '옮기기' ? '옮길까요' : a.label === '되살리기' ? '되살릴까요' : '받을까요'}?`
  if (a.kind === 'print') return '출력할까요?'
  if (a.kind === 'pc') return `${a.label}를 할까요?`
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
/** 먼저 챙긴 일 (ADR 0019): 피드 카드와 같은 내용·같은 답. [해 줘]는 그 부탁을 대화로 보낸다 */
// ── 답에 붙는 카드 (상품·숙소·식당) ──
// 사진은 폰이 바깥 서버에 직접 붙지 않고 PC에 부탁해 data: 주소로 받는다 (한 번 받은 건 앱을 켜 둔 동안 기억)
const thumbCache = new Map<string, string | null>()
const thumbAsked = new Set<string>()
function wantThumb(url: string) {
  if (thumbCache.has(url) || thumbAsked.has(url)) return
  thumbAsked.add(url)
  void send({ kind: 'thumb', url })
}
/** 사진을 기다리는 블록들 (결과 블록은 Promise로 받는다) */
const thumbWaiting = new Map<string, ((data: string | undefined) => void)[]>()
function thumbOf(url: string): Promise<string | undefined> {
  const have = thumbCache.get(url)
  if (have !== undefined) return Promise.resolve(have ?? undefined)
  return new Promise((done) => {
    thumbWaiting.set(url, [...(thumbWaiting.get(url) ?? []), done])
    wantThumb(url)
  })
}
function gotThumb(url: string, data: string | undefined) {
  thumbAsked.delete(url)
  thumbCache.set(url, data ?? null)
  for (const done of thumbWaiting.get(url) ?? []) done(data)
  thumbWaiting.delete(url)
  if (!data) return
  for (const img of document.querySelectorAll<HTMLImageElement>('img[data-thumb]'))
    if (img.dataset.thumb === url) showThumb(img, data)
}
function showThumb(img: HTMLImageElement, data: string) {
  img.onload = () => img.classList.add('on')
  img.src = data
}

function cardsInline(rec: CardsRecordMessage): HTMLElement {
  return h(
    'div',
    { class: rec.shape === 'portrait' ? 'pick-cards portrait' : 'pick-cards' },
    ...rec.cards.map((c) => {
      let img: HTMLImageElement | undefined
      if (c.image) {
        img = document.createElement('img')
        img.alt = ''
        img.dataset.thumb = c.image
      }
      if (img && c.image) {
        const have = thumbCache.get(c.image)
        if (have) showThumb(img, have)
        else wantThumb(c.image)
      }
      return h(
        'div',
        { class: 'pick-card' },
        h(
          'div',
          { class: 'pick-photo' },
          img ?? icon('box', 'i'),
          c.badge ? h('span', { class: 'pick-badge', text: c.badge }) : undefined,
        ),
        h(
          'div',
          { class: 'pick-body' },
          h('span', { class: 'pick-title', text: c.title }),
          // 비어 있어도 자리는 둔다 (카드마다 가격·정보 줄이 같은 높이에)
          h('span', { class: 'pick-price', text: c.price ?? '' }),
          h('span', { class: 'pick-note', text: c.note ?? '' }),
        ),
        h(
          'div',
          { class: 'pick-actions' },
          c.url
            ? h('button', {
                text: '보기',
                onclick: () => {
                  mark(`카드 보기 ${new URL(c.url ?? '').host}`)
                  // 앱 밖 브라우저(또는 그 서비스 앱)로 연다
                  const a = document.createElement('a')
                  a.href = c.url ?? ''
                  a.target = '_blank'
                  a.rel = 'noopener noreferrer'
                  a.click()
                },
              })
            : undefined,
          h('button', {
            class: 'go',
            text: '이걸로',
            onclick: () => ask(`이걸로 할게: ${c.title}${c.price ? ` (${c.price})` : ''}`),
          }),
        ),
      )
    }),
  )
}

function tellInline(rec: TellRecordMessage): HTMLElement {
  const answered = feedPager.items.find((f) => f.id === rec.id)?.answered
  const say = rec.ask
  return h(
    'div',
    { class: 'card tell-card' },
    h('div', { class: 'card-label' }, doori('', 22), '먼저 챙겼어요'),
    h('strong', { class: 'tell-title', text: rec.title }),
    rec.body ? h('div', { class: 'tell-body rich' }, rich(rec.body)) : undefined,
    rec.from ? h('p', { class: 'meta', text: rec.from }) : undefined,
    say
      ? answered
        ? h('p', { class: 'meta tell-done', text: answered === 'yes' ? '맡겼어요' : '넘겼어요' })
        : h(
            'div',
            { class: 'tell-actions' },
            h('button', {
              class: 'btn small',
              text: rec.askLabel || '해 줘',
              onclick: () => {
                lifeAct({ action: 'feed-answer', id: rec.id, answer: 'yes' })
                ask(say)
              },
            }),
            h('button', {
              class: 'btn-ghost small',
              text: '괜찮아요',
              onclick: () => lifeAct({ action: 'feed-answer', id: rec.id, answer: 'no' }),
            }),
          )
      : undefined,
  )
}

function connectInline(rec: ConnectRecordMessage, live = true): HTMLElement {
  const it = connectFor(rec)
  // 서비스 목록이 아직 안 왔으면(앱을 막 열었을 때) 조용히 자리만 둔다. 오면 다시 그린다
  if (!it && !st.services) return h('p', { class: 'done-line connect-line' }, icon('link'), '연결 카드')
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
  if (!live) return h('p', { class: 'done-line connect-line' }, mark(), `${c.name} 연결 카드`)
  const busy = st.connecting.has(c.id)
  // 공식 연동(지메일 등)도 준비되기 전까지는 PC Chrome에 로그인해서 쓴다: 브라우저 연결과 같은 카드
  const browser = c.how === 'browser' || c.how === 'official'
  // 계정·인증번호를 기다리면: 무엇이 필요한지와 [넣기] 버튼 (빙글빙글만 돌지 않게)
  const fail = busy ? undefined : st.connectFails.get(c.id)
  if (fail) return connectFailCard(c, fail, mark(true))
  const wait = busy ? connectWaiting(c.id) : undefined
  if (wait?.kind === 'confirm') {
    // 휴대폰 앱에서 승인: 넣을 건 없고, 누르면 두리가 알아서 이어 간다
    const step = st.connectSteps.get(c.id)?.at(-1)?.text ?? '휴대폰에서 확인을 눌러 주세요'
    return h(
      'div',
      { class: 'card approve-card connect-card ask' },
      h(
        'div',
        { class: 'approve-head' },
        mark(true),
        h('div', {}, h('strong', { text: step }), h('span', { class: 'meta', text: wait.detail ?? '' })),
        h('span', { class: 'spin' }),
      ),
      connectStepList(c.id, true),
      h(
        'div',
        { class: 'approve-actions' },
        h('button', {
          class: 'btn-ghost',
          text: 'PC 화면 보기',
          onclick: () => openRemote(Number(wait.id), c.id),
        }),
      ),
    )
  }
  if (wait?.label === '고르기') {
    // 하나 고르기 (어느 계정으로 할지 등): 질문 그대로 보여 주고 [고르기]
    const ask = st.connectSteps.get(c.id)?.at(-1)?.text ?? '하나 골라 주세요'
    return h(
      'div',
      { class: 'card approve-card connect-card ask' },
      h(
        'div',
        { class: 'approve-head' },
        mark(true),
        h(
          'div',
          {},
          h('strong', { text: ask }),
          h('span', { class: 'meta', text: `고르시면 두리가 이어서 ${c.name}에 로그인해요` }),
        ),
      ),
      connectStepList(c.id, true),
      h(
        'div',
        { class: 'approve-actions' },
        h('button', {
          class: 'btn',
          text: '고르기',
          onclick: () => openOverlay({ kind: 'info', id: wait.id }),
        }),
      ),
    )
  }
  if (wait) {
    const what = wait.label.replace(/ 넣기$/, '')
    return h(
      'div',
      { class: 'card approve-card connect-card ask' },
      h(
        'div',
        { class: 'approve-head' },
        mark(true),
        h(
          'div',
          {},
          h('strong', { text: `${josa(what, '이/가')} 필요해요` }),
          h('span', { class: 'meta', text: `넣어 주시면 두리가 이어서 ${c.name}에 로그인해요` }),
        ),
      ),
      connectStepList(c.id, true),
      h(
        'div',
        { class: 'approve-actions' },
        h('button', {
          class: 'btn',
          text: wait.label,
          onclick: () => openOverlay({ kind: wait.kind === 'login' ? 'login' : 'info', id: wait.id }),
        }),
      ),
    )
  }
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
            ? 'PC에서 두리가 하고 있어요. 아래 화면에서 지켜볼 수 있어요'
            : browser
              ? connectHow(c)
              : '연결 화면에서 켜요',
        }),
      ),
      busy && !st.connectSteps.get(c.id)?.length ? h('span', { class: 'spin' }) : undefined,
    ),
    busy ? connectPeek(c.id) : undefined,
    busy
      ? connectStepList(c.id)
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

/**
 * 로그인 요청(두리가 일하다 띄운 카드)과 같은 사이트의 연결 상태.
 * 간편 로그인으로 이어서 하는 중이거나 사람 차례로 멈췄으면, 로그인 카드도 그 상태를 보여 준다 (제자리 돌기 막기)
 */
function loginLink(origin: string) {
  const cid = cardIdFor(origin)
  if (!cid) return undefined
  const busy = st.connecting.has(cid)
  const fail = st.connectFails.get(cid)
  return busy || fail ? { cid, busy, fail } : undefined
}

/** 나를 기다려요의 로그인 카드를 눌렀을 때: 사람 차례면 그 화면, 하는 중이면 대화(카드), 아니면 로그인 화면 */
function openLogin(l: LoginRequestView) {
  const link = loginLink(l.origin)
  if (link?.fail?.tabId !== undefined && link.fail.reason === 'human')
    return openRemote(link.fail.tabId, link.cid)
  if (link?.busy) return setTab('chat')
  openOverlay({ kind: 'login', id: l.id })
}

function loginInline(rec: LoginRecordMessage): HTMLElement {
  const r = loginFor(rec)
  // 같은 사이트를 간편 로그인으로 잇는 중·멈춤: 연결 카드와 같은 모양(단계·까닭·[화면 열기])
  const link = r?.status === 'pending' ? loginLink(r.origin) : undefined
  if (link) return connectInline({ kind: 'connect', service: link.cid }, true)
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
    for (const l of logins) {
      const link = loginLink(l.origin)
      const state = link?.busy
        ? (st.connectSteps.get(link.cid)?.at(-1)?.text ?? '두리가 로그인하는 중이에요')
        : link?.fail?.reason === 'human'
          ? '직접 해 주셔야 해요 · 눌러서 화면 열기'
          : link?.fail?.reason === 'wrong'
            ? '아이디나 비밀번호가 맞지 않아요'
            : link?.fail
              ? '로그인을 끝까지 못 했어요'
              : '로그인이 필요해요'
      box.append(
        h(
          'button',
          { class: 'task-card ask', onclick: () => openLogin(l) },
          h(
            'span',
            { class: 'meta' },
            h('span', { class: `dot ${link?.busy ? 'work pulse' : 'ask'}` }),
            state,
          ),
          h('strong', { text: `${l.site} 로그인` }),
          h('span', { class: 'meta', text: hostOf(l.origin) }),
        ),
      )
    }
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

// ── 긴 목록: 첫 페이지는 life로 오고, 아래로 내리면 life-page로 다음 페이지를 받아 이어 붙인다 ──
const feedPager = new Pager<FeedItem>(
  (f) => f.at,
  (before) => void send({ kind: 'life-page', list: 'feed', ...(before ? { before } : {}) }),
  () => renderSoon(),
)
const libPager = (tab: 'made' | 'files') =>
  new Pager<LibraryItem>(
    (it) => it.savedAt,
    (before) => void send({ kind: 'life-page', list: 'library', tab, ...(before ? { before } : {}) }),
    () => renderSoon(),
  )
const libPagers = { made: libPager('made'), files: libPager('files') }
/** 두리 판 활동: 끝낸 일·예약한 일만 (첫 페이지도 따로 받는다) */
const activityPager = new Pager<FeedItem>(
  (f) => f.at,
  (before) =>
    void send({ kind: 'life-page', list: 'feed', kinds: ['done', 'routine'], ...(before ? { before } : {}) }),
  () => renderSoon(),
)
let activityAskedAt = 0
/** 보관함 하나의 전체 글 (목록에는 앞부분만 온다) */
const fullItems = new Map<string, LibraryItem>()

/** 받은 첫 페이지를 목록마다 맞춘다 (더 받아 둔 건 그대로) */
function takeLife(life: LifeState) {
  st.life = life
  feedPager.take(undefined, { items: life.feed, ...(life.feedNext ? { next: life.feedNext } : {}) })
  for (const tab of ['made', 'files'] as const) {
    const next = life.libraryNext?.[tab]
    libPagers[tab].take(undefined, {
      items: life.library.filter((it) => (tab === 'files' ? it.kind === 'file' : it.kind !== 'file')),
      ...(next ? { next } : {}),
    })
  }
  // 보관함 글이 바뀌었을 수 있다: 다시 열 때 새로 받는다
  fullItems.clear()
  if (activityPager.started) activityPager.refresh()
}

/** 지금 보이는 긴 목록 (아래로 내리면 더 받는다) */
function visiblePager(): Pager<{ id: string }> | undefined {
  if (st.tab === 'feed') return feedPager
  if (st.tab === 'library') return libPagers[st.librarySeg === 'media' ? 'files' : 'made']
  return undefined
}

function lifeAct(a: LifeAction) {
  // 첫 페이지 밖에서 누른 것도 바로 바뀌어 보이게 (PC가 보내는 새 첫 페이지는 그 앞만 맞춘다)
  for (const p of [feedPager, activityPager]) {
    if (a.action === 'feed-react')
      p.patch(a.id, (f) => {
        const { reaction: _r, ...rest } = f
        return a.reaction ? { ...rest, reaction: a.reaction } : rest
      })
    if (a.action === 'feed-answer') p.patch(a.id, (f) => (f.answered ? f : { ...f, answered: a.answer }))
  }
  if (a.action === 'library-delete') for (const p of Object.values(libPagers)) p.remove(a.id)
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
    feedList: feedPager,
    libraryList: libPagers[st.librarySeg === 'media' ? 'files' : 'made'],
    fullItem: (id) => {
      const full = fullItems.get(id)
      if (full) return full
      const it = [...libPagers.made.items, ...libPagers.files.items].find((x) => x.id === id)
      // 앞부분만 받은 글이면 전체를 부탁한다 (오면 시트를 다시 그린다)
      if (it?.cut) void send({ kind: 'life-item', id })
      return it
    },
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
  const t = stripLinks(text)
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
    connectInChat(it.service.id)
    return
  }
  // 채울 게 있는 부탁(이 상품·사진 보낼게…)은 보내지 않고 입력칸에 넣는다
  if (it.fill) {
    composeDraft(it.fill)
    return
  }
  ask(it.ask)
}

/** 대화 입력칸에 글을 넣고 커서를 끝에 둔다 (보내지는 않는다) */
function composeDraft(text: string) {
  st.draft = text
  st.tab = 'chat'
  render()
  requestAnimationFrame(() => {
    const ta = shell?.textarea
    if (!ta) return
    ta.value = text
    ta.dispatchEvent(new Event('input'))
    ta.focus()
    ta.setSelectionRange(text.length, text.length)
  })
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
    needsConnect(it)
      ? h('span', { class: 'idea-tag', text: '연결' })
      : it.fill
        ? h('span', { class: 'idea-tag', text: '채워서' })
        : undefined,
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
    pageSettled()
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
    pageSettled()
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
    cat: st.connectCat,
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
      // 목록은 연결 화면이 제자리에서 다시 그렸다: 찾는 말만 기억한다
      st.connectQuery = q
      pageSettled()
    },
    setCat: (c) => {
      st.connectCat = c
      pageSettled()
    },
    open: (id) => connectInChat(id),
    mark: (id, on) => void send({ kind: 'connect', id, action: on ? 'mark' : 'unmark' }),
    tryAsk: (text) => ask(text),
  }
}

function connectView() {
  return st.connectDetail ? serviceView(connectCtx(), st.connectDetail) : connectionsView(connectCtx())
}

// ── 겹쳐 뜨는 것: 메뉴 서랍 · 두리 패널 · 승인 시트 · 로그인 시트 ──

/** 마지막으로 그린 겹침 화면의 모양 (같으면 다시 꽂지 않는다) */
let overlayDrawn = ''
/** 닫히는 움직임 (닫히는 중에 다시 열면 그만둔다) */
let overlayClosing: Animation[] = []

function renderOverlay() {
  const o = shell?.overlay
  if (!o) return
  const ov = st.overlay
  if (!ov) return closeOverlay(o)
  for (const a of overlayClosing) a.cancel()
  overlayClosing = []
  delete o.dataset.closing
  o.hidden = false
  // 꾹 누르는 중·보내는 중에 다시 그리면 버튼이 처음으로 돌아가서, 그동안은 그대로 둔다
  const key = 'id' in ov ? `${ov.kind}:${ov.id}` : ov.kind
  if (o.dataset.key === key && o.querySelector('.hold.holding, .hold.busy, .hold.done')) return
  const opening = o.dataset.key !== key
  const putBack = holdLive(o)
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
                      : ov.kind === 'profile'
                        ? profileSheet()
                        : ov.kind === 'vault'
                          ? vaultSheet()
                          : ov.kind === 'pay'
                            ? paySheet()
                            : ov.kind === 'pay-add'
                              ? payAddSheet()
                              : ov.kind === 'report'
                                ? reportSheet()
                                : loginSheet(ov.id)
  // 열려 있는 동안에도 PC에서 소식이 올 때마다 여기로 온다. 모양이 그대로면 손대지 않는다:
  // 새로 꽂으면 올라오는 움직임이 처음부터 또 돌아 시트·메뉴가 두세 번씩 튀고, 쓰던 글자와 스크롤도 사라진다
  const drawn = body.outerHTML
  if (!opening && drawn === overlayDrawn && o.childElementCount) return putBack()
  overlayDrawn = drawn
  o.dataset.key = key
  o.dataset.kind = ov.kind
  // 입력 카드는 바깥을 눌러도 닫히지 않는다 (실수로 내려 막혔다). [나중에 할게요]로만 닫는다
  const scrim = h('div', { class: 'scrim', onclick: () => ov.kind !== 'info' && openOverlay(undefined) })
  // 내용만 바뀐 것이면 제자리에서 바꾼다 (올라오는 움직임은 처음 열 때 한 번만)
  if (!opening) {
    scrim.classList.add('still')
    body.classList.add('still')
  }
  const was = o.lastElementChild
  const y = !opening && was instanceof HTMLElement ? was.scrollTop : 0
  const typing = opening ? undefined : typingIn(o)
  o.replaceChildren(scrim, body)
  if (y) body.scrollTop = y
  // 처음 열 때만: 메뉴 줄이 하나씩 떠오른다
  if (opening) riseIn(body.querySelectorAll(':scope > .set-row, :scope > .navi, :scope > .row'))
  typing?.()
}

/**
 * 움직이는 두리처럼 새로 만들지 않고 옮겨 쓰는 부품이 지금 있는 자리.
 * 새 화면을 만들면 그 부품이 새 화면으로 옮겨 가므로, 새 화면을 버릴 때는 제자리로 돌려놓는다
 */
function holdLive(box: HTMLElement): () => void {
  const spots = [...box.querySelectorAll<HTMLElement>('[data-live-slot]')].map((el) => ({
    el,
    parent: el.parentNode,
    next: el.nextSibling,
  }))
  return () => {
    for (const s of spots) if (s.el.parentNode !== s.parent) s.parent?.insertBefore(s.el, s.next)
  }
}

/** 닫기: 열릴 때의 반대로 내려가며 사라진다 (뚝 끊기지 않게) */
function closeOverlay(o: HTMLElement) {
  if (o.hidden || o.dataset.closing) return
  const done = () => {
    o.replaceChildren()
    o.hidden = true
    delete o.dataset.closing
    overlayClosing = []
  }
  // 같은 것을 바로 다시 열어도 처음 여는 것으로 본다
  delete o.dataset.key
  overlayDrawn = ''
  const els = [...o.children] as HTMLElement[]
  if (!els.length || reducedMotion()) return done()
  o.dataset.closing = '1'
  overlayClosing = els.map((el) =>
    el.animate(
      el.classList.contains('scrim')
        ? [{ opacity: 1 }, { opacity: 0 }]
        : el.classList.contains('drawer')
          ? [{ transform: 'none' }, { transform: 'translateX(-100%)' }]
          : [
              { transform: 'none', opacity: 1 },
              { transform: 'translateY(24px)', opacity: 0 },
            ],
      { duration: 170, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    ),
  )
  const closing = overlayClosing
  const end = () => {
    if (overlayClosing === closing) done()
  }
  void Promise.all(closing.map((a) => a.finished)).then(end, () => {})
  // 화면이 가려져 움직임이 멈춰도(앱이 뒤로 감) 닫히다 만 채로 남지 않게
  setTimeout(end, 600)
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
    ...sideMenu(),
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
    row(
      'lock',
      '금고',
      '저장된 아이디·비밀번호 보기·고치기 · 볼 때마다 폰 잠금 확인',
      icon('chevron'),
      () => {
        void send({ kind: 'vault-get' })
        openOverlay({ kind: 'vault' })
      },
    ),
    row('hand', '문제 알리기', '방금 이상했던 일을 내 PC에 남겨요 · 7일 뒤 지워져요', icon('chevron'), () =>
      openOverlay({ kind: 'report' }),
    ),
    row('close', '다른 PC와 다시 연결', '이 폰의 연결을 지우고 QR을 다시 찍어요', undefined, () => {
      if (confirm('이 폰의 PC 연결을 지울까요? PC에서 QR을 다시 찍으면 다시 연결돼요.')) void forgetPc()
    }),
  )
  // 내 정보·결제 수단: 예약·주문 칸을 두리가 채울 때 쓰는 것. 값은 PC 금고에만, 여기서도 가린 값만 보인다
  if (!st.profile) void send({ kind: 'profile-get' })
  const have = Object.keys(st.profile?.have ?? {})
  box.append(
    h('h2', { class: 'over', text: '내 정보 · 결제' }),
    row(
      'note',
      '내 정보',
      !st.profile
        ? '불러오는 중…'
        : have.length
          ? `${have.map((k) => PROFILE_LABEL[k] ?? k).join('·')} · 예약·주문 칸을 두리가 채워요`
          : '아직 없어요 · 처음 예약할 때 한 번만 물어봐요',
      icon('chevron'),
      () => openOverlay({ kind: 'profile' }),
    ),
  )
  const mine = st.profile?.payMethods
  const pays = Object.entries(st.profile?.payChoices ?? {})
  if (mine) {
    // 내 결제 수단 (ADR 0023): 맨 위가 주 결제 수단. 사이트마다 기억한 것은 시트 안에
    const first = mine[0]
    box.append(
      row(
        'card',
        '결제 수단',
        first
          ? `주 결제 수단 · ${payMethodLabel(first)}${mine.length > 1 ? ` 외 ${mine.length - 1}개` : ''}`
          : '아직 없어요 · 주로 쓰는 결제 수단을 등록해 두세요',
        icon('chevron'),
        () => openOverlay({ kind: 'pay' }),
      ),
    )
  } else if (pays.length)
    for (const [host, label] of pays)
      box.append(
        row(
          'card',
          `${label}`,
          `${host.replace(/^www\./, '')} · 다음에도 이 수단을 먼저 골라 둬요`,
          h('span', { class: 'meta', text: '잊기' }),
          () => void send({ kind: 'pay-choice-forget', host }),
        ),
      )
  else
    box.append(
      row('card', '결제 수단', '결제할 때 고른 수단을 사이트마다 기억해요 · 카드 번호는 저장하지 않아요'),
    )
  // 시험용 PC에서만: 새 사용자처럼 처음부터 다시 해 보기
  if (st.pc?.dev)
    box.append(
      h('h2', { class: 'over', text: '시험용' }),
      row(
        'trash',
        '처음부터 다시',
        'PC의 대화·기억·목표·보관함을 지우고 새로 시작해요',
        undefined,
        () => void resetAll(),
      ),
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

const PROFILE_LABEL: Record<string, string> = {
  name: '이름',
  name_en_last: '영문 성',
  name_en_first: '영문 이름',
  email: '이메일',
  phone: '휴대폰 번호',
  birth: '생년월일',
  zip: '우편번호',
  address: '주소',
  address_detail: '상세 주소',
  rrn_back: '주민번호 뒷자리',
  auth_app: '간편인증 앱',
  carrier: '통신사',
}

/** 설정 > 내 정보: 있는 항목은 가린 값만 보이고, 새로 넣은 칸만 바뀐다 (빈 칸은 그대로) */
function profileSheet() {
  const sheet = h('section', { class: 'sheet float app-sheet rise info-sheet' })
  const p = st.profile
  sheet.append(
    h(
      'div',
      { class: 'approve-head' },
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: '내 정보' }),
        h('span', { class: 'meta', text: '예약·주문 칸을 두리가 채울 때 써요' }),
      ),
    ),
  )
  if (!p) {
    sheet.append(h('p', { class: 'meta', text: '불러오는 중…' }))
    return sheet
  }
  const inputs = Object.entries(PROFILE_LABEL).map(([key, label]) => {
    const input = h('input', { class: 'field' })
    input.name = key
    if (key === 'auth_app' || key === 'carrier') {
      // 간편인증 앱·통신사는 고르기 (비밀값이 아니라 지금 고른 것이 그대로 보인다)
      input.type = 'hidden'
      const opts = key === 'carrier' ? CARRIERS : AUTH_APPS
      return { key, label, input, chips: choiceChips(opts, p.have[key] ?? '', (v) => (input.value = v)) }
    }
    input.placeholder = p.have[key] ? `${p.have[key]} (바꿀 때만 넣기)` : '없음'
    input.setAttribute('aria-label', label)
    if (key === 'phone') input.type = 'tel'
    if (key === 'email') input.type = 'email'
    if (key === 'rrn_back') {
      input.type = 'password'
      input.inputMode = 'numeric'
      input.autocomplete = 'off'
    }
    autoHyphen(input, key)
    return { key, label, input, chips: undefined as HTMLElement | undefined }
  })
  const go = h('button', { class: 'btn lg', text: '저장' })
  go.type = 'submit'
  const form = h(
    'form',
    { class: 'cred-form profile-form' },
    ...inputs.map(({ label, input, chips }) =>
      chips
        ? h('div', { class: 'field-label' }, h('span', { class: 'meta', text: label }), chips, input)
        : h('label', { class: 'field-label' }, h('span', { class: 'meta', text: label }), input),
    ),
    go,
  )
  form.onsubmit = (e) => {
    e.preventDefault()
    const values: Record<string, string> = {}
    for (const { key, input } of inputs) if (input.value.trim()) values[key] = input.value.trim()
    if (!Object.keys(values).length) return openOverlay(undefined)
    void send({ kind: 'profile-set', values })
    openOverlay(undefined)
  }
  sheet.append(
    form,
    h(
      'p',
      { class: 'lock-note' },
      icon('lock'),
      '값은 이 PC의 두리 금고에만 있어요. 여기와 두리(AI)에게는 가린 값만 보여요.',
    ),
    h('button', {
      class: 'btn-text cred-direct',
      text: '내 정보 모두 지우기',
      onclick: () => {
        if (!confirm('내 정보를 모두 지울까요? 다음 예약 때 다시 물어봐요.')) return
        void send({ kind: 'profile-clear' })
        openOverlay(undefined)
      },
    }),
  )
  return sheet
}

/**
 * 설정 > 금고 (ADR 0026): 저장된 로그인 목록. [보기]는 폰 잠금(지문·얼굴·PIN)을 확인한 뒤 PC에 부탁하고 30초만 보여 준다.
 * [고치기]는 아이디·비밀번호를 바꾼다(빈 칸은 그대로). 두리(AI)에게는 비밀번호가 가지 않는다
 */
function vaultSheet() {
  const sheet = h('section', { class: 'sheet float app-sheet rise info-sheet' })
  sheet.append(
    h(
      'div',
      { class: 'approve-head' },
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: '금고' }),
        h('span', { class: 'meta', text: '두리가 로그인할 때 쓰는 아이디·비밀번호예요' }),
      ),
    ),
  )
  const list = st.vault
  if (!list) {
    sheet.append(h('p', { class: 'meta', text: '불러오는 중…' }))
    return sheet
  }
  if (!list.length) sheet.append(h('p', { class: 'meta', text: '아직 저장된 로그인이 없어요.' }))
  const site = (o: string) => {
    try {
      return new URL(o).hostname.replace(/^www\./, '')
    } catch {
      return o
    }
  }
  for (const e of list) {
    const shown = st.vaultShown?.id === e.id ? st.vaultShown : undefined
    const view = h('button', {
      text: shown ? '숨기기' : '보기',
      onclick: async () => {
        if (shown) {
          st.vaultShown = undefined
          render()
          return
        }
        const ok = await confirmDevice(
          '비밀번호 보기',
          `${e.name ?? site(e.origin)} 비밀번호를 보려면 확인해 주세요`,
        )
        if (ok === 'ok') void send({ kind: 'vault-reveal', id: e.id })
        else if (ok === 'no-lock') toast('폰에 화면 잠금(지문·PIN)을 설정하면 볼 수 있어요')
        else if (ok === 'web') toast('두리 앱에서만 볼 수 있어요')
      },
    })
    const edit = h('button', {
      text: '고치기',
      onclick: () => {
        st.vaultEdit = st.vaultEdit === e.id ? undefined : e.id
        render()
      },
    })
    const del = h('button', {
      class: 'danger',
      text: '지우기',
      onclick: () => {
        if (
          !confirm(
            `${e.name ?? site(e.origin)} 로그인을 금고에서 지울까요? 다음에 로그인할 때 다시 물어봐요.`,
          )
        )
          return
        void send({ kind: 'vault-delete', id: e.id })
      },
    })
    const card = h(
      'div',
      { class: 'vault-row' },
      h(
        'div',
        { class: 'row-text' },
        h('strong', { class: 'row-t', text: e.name ?? site(e.origin) }),
        h('span', { class: 'row-d', text: `${shown?.username ?? e.username} · ${site(e.origin)}` }),
        ...(shown ? [h('code', { class: 'vault-pw', text: shown.password })] : []),
      ),
      h('div', { class: 'vault-acts' }, view, edit, del),
    )
    if (st.vaultEdit === e.id) {
      const user = h('input', { class: 'field' }) as HTMLInputElement
      user.placeholder = `아이디 (${e.username})`
      user.autocomplete = 'off'
      const pw = h('input', { class: 'field' }) as HTMLInputElement
      pw.type = 'password'
      pw.placeholder = '새 비밀번호 (바꿀 때만)'
      pw.autocomplete = 'new-password'
      const save = h('button', { class: 'btn sm', text: '저장' })
      save.type = 'submit'
      const form = h('form', { class: 'cred-form' }, user, pw, save)
      form.onsubmit = (ev) => {
        ev.preventDefault()
        if (!user.value.trim() && !pw.value) return
        void send({
          kind: 'vault-set',
          id: e.id,
          ...(user.value.trim() ? { username: user.value.trim() } : {}),
          ...(pw.value ? { password: pw.value } : {}),
        })
      }
      card.append(form)
    }
    sheet.append(card)
  }
  sheet.append(
    h(
      'p',
      { class: 'lock-note' },
      icon('lock'),
      '비밀번호는 이 PC 금고에만 있어요. 볼 때마다 폰 잠금을 확인하고 30초 뒤 가려요. 두리(AI)에게는 가지 않아요.',
    ),
  )
  return sheet
}

/** 결제 수단 표시: 간편결제는 첫 글자 색 칸, 카드는 카드 그림 */
const PAY_LETTER: Partial<Record<PayKind, string>> = {
  naverpay: 'N',
  kakaopay: 'K',
  tosspay: 'T',
  payco: 'P',
  samsungpay: 'S',
  applepay: 'A',
  smilepay: 'S',
  ssgpay: 'S',
  lpay: 'L',
}

function payMark(kind: PayKind): HTMLElement {
  const letter = PAY_LETTER[kind]
  const mark = h('span', { class: `pay-mark pay-${kind}`, text: letter ?? '' })
  if (!letter) mark.append(icon('card', 'i'))
  return mark
}

/** 목록을 통째로 PC에 보낸다 (PC가 검사하고 저장한 목록을 돌려준다) */
function savePayMethods(list: PayMethod[]) {
  if (st.profile) st.profile = { ...st.profile, payMethods: list }
  void send({ kind: 'pay-methods-set', methods: list })
  render()
}

/** 설정 > 결제 수단: 맨 위가 주 결제 수단. 결제 때 사이트가 받는 것 중 위에 있는 것부터 골라 둔다 */
function paySheet() {
  const sheet = h('section', { class: 'sheet float app-sheet rise info-sheet pay-sheet' })
  sheet.append(
    h(
      'div',
      { class: 'approve-head' },
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: '결제 수단' }),
        h('span', { class: 'meta', text: '결제할 때 사이트가 받는 것 중 위에 있는 것부터 골라 둬요' }),
      ),
    ),
  )
  const list = st.profile?.payMethods
  if (!list) {
    sheet.append(h('p', { class: 'meta', text: '불러오는 중…' }))
    return sheet
  }
  if (!list.length)
    sheet.append(
      h('p', {
        class: 'pay-empty',
        text: '아직 없어요. 네이버페이·카카오페이·카드처럼 주로 쓰는 것을 등록해 두세요.',
      }),
    )
  const ul = h('ul', { class: 'pay-list' })
  list.forEach((m, i) => {
    const detail = payMethodDetail(m)
    ul.append(
      h(
        'li',
        { class: 'pay-row' },
        payMark(m.kind),
        h(
          'span',
          { class: 'row-text' },
          h(
            'span',
            { class: 'row-t' },
            payMethodTitle(m),
            i === 0 ? h('span', { class: 'pay-main', text: '주 결제 수단' }) : '',
          ),
          detail ? h('span', { class: 'row-d', text: detail }) : '',
        ),
        i > 0
          ? h('button', {
              class: 'btn-text',
              text: '주로 쓰기',
              onclick: () => savePayMethods([m, ...list.filter((x) => x.id !== m.id)]),
            })
          : '',
        h('button', {
          class: 'btn-text danger',
          text: '지우기',
          onclick: () => {
            if (!confirm(`${payMethodLabel(m)}을(를) 지울까요?`)) return
            savePayMethods(list.filter((x) => x.id !== m.id))
          },
        }),
      ),
    )
  })
  if (list.length) sheet.append(ul)
  sheet.append(
    h('button', {
      class: 'btn lg',
      text: '결제 수단 추가',
      onclick: () => {
        st.payDraft = { inner: '', issuer: '', nickname: '', last4: '' }
        openOverlay({ kind: 'pay-add' })
      },
    }),
  )
  // 사이트마다 지난번에 고른 것 (내 결제 수단이 그 사이트에 없을 때 쓴다)
  const pays = Object.entries(st.profile?.payChoices ?? {})
  if (pays.length) {
    sheet.append(h('h3', { class: 'over', text: '사이트마다 지난번에 고른 것' }))
    for (const [host, label] of pays)
      sheet.append(
        h(
          'div',
          { class: 'pay-row' },
          h(
            'span',
            { class: 'row-text' },
            h('span', { class: 'row-t', text: label }),
            h('span', { class: 'row-d', text: host.replace(/^www\./, '') }),
          ),
          h('button', {
            class: 'btn-text',
            text: '잊기',
            onclick: () => void send({ kind: 'pay-choice-forget', host }),
          }),
        ),
      )
  }
  sheet.append(
    h(
      'p',
      { class: 'lock-note' },
      icon('lock'),
      '카드 번호·결제 비밀번호는 받지 않아요. 무엇으로 낼지만 내 PC에 기억하고, 결제는 매번 승인을 받아요.',
    ),
  )
  return sheet
}

/** 결제 수단 추가: 종류 고르기 → 간편결제는 그 안에서 쓰는 것(선택), 카드는 카드사·별칭·끝 4자리 */
function payAddSheet() {
  const d = st.payDraft
  const sheet = h('section', { class: 'sheet float app-sheet rise info-sheet pay-sheet' })
  sheet.append(
    h(
      'div',
      { class: 'approve-head' },
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: '결제 수단 추가' }),
        h('span', { class: 'meta', text: '주로 쓰는 것부터 등록해 두세요' }),
      ),
    ),
  )
  const pick = (kind: PayKind) => {
    st.payDraft = { ...d, kind }
    render()
  }
  sheet.append(
    h(
      'div',
      { class: 'approve-choices' },
      h('span', { class: 'meta', text: '무엇으로 낼까요?' }),
      h(
        'div',
        { class: 'chip-row' },
        ...(Object.keys(PAY_KINDS) as PayKind[]).map((k) =>
          h('button', {
            class: `chip${d.kind === k ? ' on' : ''}`,
            text: PAY_KINDS[k],
            onclick: () => pick(k),
          }),
        ),
      ),
    ),
  )
  if (!d.kind) return sheet
  const field = (id: string, label: string, key: 'inner' | 'nickname' | 'last4', placeholder: string) => {
    const input = h('input', { class: 'field' })
    input.id = id
    input.value = d[key]
    input.placeholder = placeholder
    input.setAttribute('aria-label', label)
    input.oninput = () => {
      st.payDraft[key] = input.value
    }
    if (key === 'last4') {
      input.inputMode = 'numeric'
      input.maxLength = 4
    }
    return h('label', { class: 'field-label' }, h('span', { class: 'meta', text: label }), input)
  }
  const form = h('form', { class: 'cred-form profile-form' })
  if (d.kind === 'card') {
    form.append(
      h(
        'div',
        { class: 'approve-choices' },
        h('span', { class: 'meta', text: '카드사' }),
        h(
          'div',
          { class: 'chip-row' },
          ...CARD_ISSUERS.map((c) =>
            h('button', {
              class: `chip${d.issuer === c ? ' on' : ''}`,
              text: c,
              onclick: (e: Event) => {
                e.preventDefault()
                st.payDraft = { ...st.payDraft, issuer: c }
                render()
              },
            }),
          ),
        ),
      ),
      field('pay-nickname', '별칭 (선택)', 'nickname', '예: 생활비, 회사 카드'),
      field('pay-last4', '끝 4자리 (선택)', 'last4', '예: 1234'),
    )
  } else
    form.append(
      field('pay-inner', `${PAY_KINDS[d.kind]} 안에서 쓰는 것 (선택)`, 'inner', '예: 신한카드(1234), 머니'),
    )
  const go = h('button', { class: 'btn lg', text: '등록' })
  go.type = 'submit'
  form.append(go)
  form.onsubmit = (e) => {
    e.preventDefault()
    const now = st.payDraft
    if (!now.kind) return
    if (now.kind === 'card' && !now.issuer) return toast('카드사를 골라 주세요')
    if (now.last4 && !/^\d{4}$/.test(now.last4.trim())) return toast('끝 4자리는 숫자 4개로 적어 주세요')
    const m: PayMethod = {
      id: crypto.randomUUID(),
      kind: now.kind,
      addedAt: new Date().toISOString(),
      ...(now.kind === 'card'
        ? {
            issuer: now.issuer,
            ...(now.nickname.trim() ? { nickname: now.nickname.trim() } : {}),
            ...(now.last4.trim() ? { last4: now.last4.trim() } : {}),
          }
        : now.inner.trim()
          ? { inner: now.inner.trim() }
          : {}),
    }
    savePayMethods([...(st.profile?.payMethods ?? []), m])
    openOverlay({ kind: 'pay' })
  }
  sheet.append(
    form,
    h(
      'p',
      { class: 'lock-note' },
      icon('lock'),
      '카드 번호·유효기간·CVC·결제 비밀번호는 넣지 마세요. 두리는 받지도 저장하지도 않아요.',
    ),
  )
  return sheet
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
    // 처음 열 때 첫 페이지를 부탁한다 (답이 안 오면 10초 뒤 다시)
    if (!activityPager.started && Date.now() - activityAskedAt > 10_000) {
      activityAskedAt = Date.now()
      activityPager.refresh()
    }
    const done = activityPager.items
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
    const more = moreRow(activityPager)
    if (more) body.append(more)
    if (!done.length && !st.busy)
      body.append(
        activityPager.started
          ? h('p', { class: 'meta seg-empty', text: '아직 한 일이 없어요' })
          : h('p', { class: 'wait' }, h('span', { class: 'spin' }), 'PC에서 받는 중…'),
      )
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
          () => openLogin(l),
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
  const pc = a.kind === 'file' || a.kind === 'print' || a.kind === 'pc'
  row(pc ? '알아 두기' : '취소 조건', a.cancel)
  if (a.kind !== 'app' && !pc) row('누를 버튼', `"${finalLabel(a)}"`)
  const items = itemsList(a, 100)
  if (items)
    rows.append(
      h('dt', { text: a.kind === 'print' ? '파일' : `목록 ${a.items?.length}개` }),
      h('dd', {}, items),
    )
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
  const chose = choseRow(a)
  if (chose) sheet.append(chose)
  const pick = a.status === 'pending' ? choiceRow(a) : undefined
  if (pick) sheet.append(pick)
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
      text:
        a.kind === 'file'
          ? '목록이 맞는지 봐 주세요. 승인하면 두리가 이 목록대로만 하고, 덮어쓰거나 지우지 않아요.'
          : a.kind === 'pc'
            ? '승인하면 두리가 바로 해요.'
            : a.kind === 'print'
              ? '파일과 매수가 맞는지 봐 주세요. 승인하면 두리가 이 파일만 프린터로 보내요.'
              : '"얼마"·"무엇을"은 두리가 읽어 적은 것이라 화면과 맞는지 봐 주세요. 승인하면 두리가 이 버튼 하나만 눌러요.',
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
  social?: { provider: SocialProvider; hint?: string; onclick(): void }[]
  /** 연결되면 바로 시작할 부탁 */
  next?: string
  /** 로고를 보여 줄 연결 카드 id */
  logo?: string
  /** 카카오·네이버 같은 공급자 계정이면 그 로고 */
  brand?: SocialProvider
  /** 간편 로그인만 되는 곳 (아이디·비밀번호 로그인이 없다): 아이디 칸을 보여 주지 않는다 */
  socialOnly?: boolean
  /** "처음이에요 · 가입해 주세요" 버튼 (두리에게 회원가입을 부탁한다) */
  signup?: () => void
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
              // 이어 쓰면 새 계정이 안 생기는 공급자 표시 (최근 사용·N곳에서 사용)
              if (x.hint) b.append(h('span', { class: 'social-hint', text: x.hint }))
              return b
            }),
          ),
          ...(t.socialOnly
            ? []
            : [h('p', { class: 'social-or' }, h('span', { text: '또는 아이디·비밀번호로' }))]),
        ]
      : []),
    ...(t.socialOnly && t.social?.length ? [] : [form]),
    h(
      'p',
      { class: 'lock-note' },
      icon('lock'),
      'PC의 두리 금고(키체인)에만 암호화해 저장돼요. 두리(AI)·대화 기록·중계 서버 어디에도 남지 않아요.',
    ),
    ...(t.signup
      ? [
          h('button', {
            class: 'btn-text cred-signup',
            text: '처음이에요 · 가입해 주세요',
            onclick: t.signup,
          }),
        ]
      : []),
    ...(t.direct
      ? [h('button', { class: 'btn-text cred-direct', text: t.direct.text, onclick: t.direct.onclick })]
      : []),
  )
  return sheet
}

/** 문제 알리기: 한 줄 적고(안 적어도 됨) 보내면, 앱에서 방금 있었던 일이 PC의 일한 기록에 남는다 */
function reportSheet() {
  const note = h('textarea', { class: 'field report-note' })
  note.id = 'report-note'
  note.rows = 3
  note.maxLength = 500
  note.placeholder = '무슨 일이 있었나요? (안 적어도 돼요)'
  const go = h('button', { class: 'btn lg', text: st.online ? '보내기' : 'PC와 연결되면 보낼 수 있어요' })
  go.disabled = !st.online
  go.onclick = () => {
    void send({
      kind: 'report',
      trail: [...trail],
      ...(note.value.trim() ? { note: note.value.trim() } : {}),
      app: navigator.userAgent,
    })
    mark('문제 알리기 보냄')
    st.overlay = undefined
    toast('남겼어요. 내 PC에만 7일 보관돼요')
  }
  return h(
    'section',
    { class: 'sheet float app-sheet rise report-sheet' },
    h(
      'button',
      { class: 'fbtn small sheet-x', label: '닫기', onclick: () => openOverlay(undefined) },
      icon('close'),
    ),
    h(
      'div',
      { class: 'approve-head' },
      h('span', { class: 'tile sm mint' }, icon('hand', 'i')),
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: '문제 알리기' }),
        h('span', { class: 'meta', text: `${st.saved?.pcName ?? '내 PC'}에 남겨요` }),
      ),
    ),
    note,
    go,
    h(
      'p',
      { class: 'lock-note' },
      icon('lock'),
      '앱에서 누른 것과 받은 신호의 종류·시각만 가요. 대화 내용·비밀번호는 가지 않아요. 내 PC에만 남고 7일 뒤 지워져요.',
    ),
  )
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
      h('strong', {
        class: 'title-2',
        text:
          q.field === 'otp'
            ? '인증번호를 넣어 주세요'
            : q.field === 'form'
              ? '내 정보를 한 번만 넣어 주세요'
              : q.label,
      }),
      h('span', {
        class: 'meta',
        text: q.field === 'form' ? '예약·주문 칸을 두리가 알아서 채워요' : `${q.site} · ${q.host}`,
      }),
    ),
  )
  const body: Node[] = []
  if (q.hint) body.push(h('p', { class: 'info-hint', text: q.hint.replace(/^\s*#+\s*/, '') }))
  // 보안문자: 두리가 고른 그림을 보여 주고 그 글자를 받는다 (PC 화면을 보지 않아도 된다)
  if (q.image) {
    const img = h('img', { class: 'captcha-img' }) as HTMLImageElement
    img.src = `data:image/jpeg;base64,${q.image}`
    img.alt = '보안문자 그림'
    body.push(img)
  }
  if (q.field === 'choice' && q.options?.length) {
    // 하나 고르기 (예: 구글 계정이 여럿일 때). 고른 글을 그대로 답한다
    body.push(
      h(
        'div',
        { class: 'choice-list' },
        ...q.options.map((o, i) =>
          h('button', {
            class: `${i === 0 ? 'btn' : 'btn-ghost'} lg choice-btn`,
            text: o,
            onclick: () => answer(o),
          }),
        ),
      ),
      h('button', { class: 'btn-link', text: '나중에 할게요', onclick: () => answer() }),
    )
    sheet.append(head, ...body)
    return sheet
  }
  if (q.field === 'form' && q.fields?.length) {
    // 내 정보 카드: 여러 칸을 한 번에 받는다. 값은 PC 금고에만, 두리(AI)는 가린 값만 본다
    const inputs = q.fields.map((f) => {
      const input = h('input', { class: 'field' })
      input.name = f.key
      if (f.type === 'choice' && f.options?.length) {
        // 하나 고르기 (간편인증 앱): 칩을 누르면 숨은 칸에 그 이름이 들어간다
        input.type = 'hidden'
        return { f, input, chips: choiceChips(f.options, '', (v) => (input.value = v)) }
      }
      input.placeholder = f.example ? `예: ${f.example}` : f.label
      input.setAttribute('aria-label', f.label)
      if (f.type === 'tel') {
        input.type = 'tel'
        input.inputMode = 'tel'
        input.autocomplete = 'tel'
      } else if (f.type === 'email') {
        input.type = 'email'
        input.inputMode = 'email'
        input.autocomplete = 'email'
      } else if (f.type === 'date') {
        input.inputMode = 'numeric'
        input.setAttribute('autocomplete', 'bday')
      } else if (f.key === 'name') input.autocomplete = 'name'
      else if (f.key === 'name_en_last') input.autocomplete = 'family-name'
      else if (f.key === 'name_en_first') input.autocomplete = 'given-name'
      else if (f.key === 'zip') input.autocomplete = 'postal-code'
      else if (f.key === 'address') input.autocomplete = 'street-address'
      autoHyphen(input, f.key)
      return { f, input, chips: undefined as HTMLElement | undefined }
    })
    const go = h('button', { class: 'btn lg', text: '저장하고 이어서 하기' })
    go.type = 'submit'
    const form = h(
      'form',
      { class: 'cred-form profile-form' },
      ...inputs.map(({ f, input, chips }) =>
        chips
          ? h('div', { class: 'field-label' }, h('span', { class: 'meta', text: f.label }), chips, input)
          : h('label', { class: 'field-label' }, h('span', { class: 'meta', text: f.label }), input),
      ),
      go,
    )
    form.onsubmit = (e) => {
      e.preventDefault()
      // 칸마다 형식 검사: 맞지 않으면 그 칸 아래에 안내를 띄우고 멈춘다 (빈 칸은 넘긴다)
      let bad: HTMLInputElement | undefined
      for (const { f, input } of inputs) {
        const v = input.value.trim()
        input.parentElement?.querySelector('.field-err')?.remove()
        input.classList.remove('invalid')
        if (!v || !f.pattern || new RegExp(f.pattern).test(v)) continue
        input.classList.add('invalid')
        input.insertAdjacentElement(
          'afterend',
          h('span', { class: 'field-err', text: f.patternHint || `${f.label} 형식을 확인해 주세요` }),
        )
        bad ??= input
      }
      if (bad) {
        bad.focus()
        return
      }
      const value: Record<string, string> = {}
      for (const { f, input } of inputs) if (input.value.trim()) value[f.key] = input.value.trim()
      if (Object.keys(value).length) answer(JSON.stringify(value))
    }
    body.push(form)
    queueMicrotask(() => inputs.find((x) => !x.chips)?.input.focus())
  } else if (q.field === 'password') {
    // 사용자가 정하는 새 비밀번호: 두 번 넣어 맞는지 보고 PC 금고로만 보낸다 (두리·기록에는 남지 않는다)
    const mk = (ph: string) => {
      const i = h('input', { class: 'field' }) as HTMLInputElement
      i.type = 'password'
      i.autocomplete = 'new-password'
      i.placeholder = ph
      i.setAttribute('aria-label', ph)
      return i
    }
    const pw1 = mk('새 비밀번호')
    const pw2 = mk('한 번 더')
    const err = h('p', { class: 'field-err', text: '' })
    const show = h('button', { class: 'btn-text', text: '보기' })
    show.type = 'button'
    show.onclick = () => {
      const t = pw1.type === 'password' ? 'text' : 'password'
      pw1.type = t
      pw2.type = t
      show.textContent = t === 'password' ? '보기' : '숨기기'
    }
    const go = h('button', { class: 'btn lg', text: '정하기' })
    go.type = 'submit'
    const form = h('form', { class: 'cred-form' }, pw1, pw2, show, err, go)
    form.onsubmit = (e) => {
      e.preventDefault()
      const v = pw1.value
      if (q.pattern && !new RegExp(q.pattern).test(v)) {
        err.textContent = q.patternHint || '형식을 확인해 주세요'
        return
      }
      if (v !== pw2.value) {
        err.textContent = '두 칸이 달라요. 같게 넣어 주세요'
        return
      }
      answer(v)
    }
    body.push(form)
    queueMicrotask(() => pw1.focus())
  } else if (q.field === 'secret') {
    // 주민번호 뒷자리처럼 저장하지 않는 값: 폰 키보드 대신 숫자 위치를 섞은 보안 키패드로 받는다
    body.push(securePad(q.pattern, q.patternHint, (v) => answer(v)))
  } else if (q.field === 'otp') {
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
    if (q.image) {
      input.autocomplete = 'off'
      input.setAttribute('autocapitalize', 'off')
      input.setAttribute('autocorrect', 'off')
      input.spellcheck = false
      input.placeholder = '그림의 글자'
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
      q.field === 'form'
        ? '넣은 값은 이 PC의 두리 금고에만 저장돼요. 두리(AI)는 가린 값(홍*동)만 봐요.'
        : q.field === 'secret' || q.field === 'password'
          ? '넣은 값은 이 PC 금고에 암호화해 저장해요. 두리(AI)는 보지 않아요.'
          : '넣은 값은 그 칸에만 들어가요. 저장하지 않고, 두리(AI)도 보지 않아요.',
    ),
    h('button', { class: 'btn-text cred-direct', text: '지금은 안 할게요', onclick: () => answer() }),
  )
  return sheet
}

/** 휴대폰·생년월일 칸은 숫자만 쳐도 하이픈이 들어간다 */
function autoHyphen(input: HTMLInputElement, key: string) {
  if (key !== 'phone' && key !== 'birth') return
  input.inputMode = 'numeric'
  input.addEventListener('input', () => {
    input.value = hyphenate(key, input.value)
  })
}

/**
 * 보안 키패드 (은행 앱처럼): 숫자 자리를 섞고, 누르면 누른 키와 다른 숫자 하나가 함께 반짝여
 * 어깨너머로 봐도 어떤 숫자인지 모르게 한다. 값은 이 함수 안에만 있고 [넣기]를 누를 때만 넘긴다
 */
function securePad(
  pattern: string | undefined,
  hint: string | undefined,
  onDone: (v: string) => void,
): HTMLElement {
  const max = Number(/\{(\d+)\}\$?$/.exec(pattern ?? '')?.[1] ?? '') + 1 || 7
  let value = ''
  const dots = h('div', { class: 'pad-dots' })
  const err = h('p', { class: 'field-err pad-err', text: '' })
  const go = h('button', { class: 'btn lg', text: '넣기' }) as HTMLButtonElement
  const grid = h('div', { class: 'pad-grid' })
  const paint = () => {
    dots.replaceChildren(
      ...Array.from({ length: max }, (_, i) => h('span', { class: i < value.length ? 'on' : '' })),
    )
    go.disabled = value.length < max
    err.textContent = ''
  }
  // 누른 키와 함께 다른 숫자 키 하나도 눌린 것처럼 보인다
  const flash = (el: HTMLElement) => {
    const others = [...grid.querySelectorAll<HTMLElement>('.pad-key.num')].filter((k) => k !== el)
    const decoy = others[Math.floor(Math.random() * others.length)]
    for (const k of [el, decoy]) {
      if (!k) continue
      k.classList.remove('pressed')
      void k.offsetWidth
      k.classList.add('pressed')
      setTimeout(() => k.classList.remove('pressed'), 160)
    }
    navigator.vibrate?.(8)
  }
  const key = (label: string | Element, on: (el: HTMLElement) => void, cls: string, aria?: string) => {
    const b = h('button', { class: `pad-key ${cls}` })
    b.append(label)
    b.type = 'button'
    if (aria) b.setAttribute('aria-label', aria)
    b.onpointerdown = (e) => {
      e.preventDefault()
      on(b)
    }
    return b
  }
  const layout = () => {
    const digits = [...'0123456789'].sort(() => Math.random() - 0.5)
    const num = (d: string) =>
      key(
        d,
        (el) => {
          flash(el)
          if (value.length < max) value += d
          paint()
        },
        'num',
      )
    grid.replaceChildren(
      ...digits.slice(0, 9).map(num),
      key('재배열', () => layout(), 'fn', '숫자 자리 다시 섞기'),
      num(digits[9] as string),
      key(
        icon('back'),
        () => {
          value = value.slice(0, -1)
          paint()
        },
        'fn',
        '하나 지우기',
      ),
    )
  }
  go.onclick = () => {
    if (pattern && !new RegExp(pattern).test(value)) {
      err.textContent = hint || '형식을 확인해 주세요'
      return
    }
    onDone(value)
    value = ''
  }
  layout()
  paint()
  return h('div', { class: 'secure-pad' }, dots, err, grid, go)
}

/** 하나 고르기 칩 (간편인증 앱 등). 누른 칩만 켜지고 onPick으로 알린다 */
function choiceChips(options: readonly string[], current: string, onPick: (v: string) => void): HTMLElement {
  const box = h('div', { class: 'choice-chips' })
  for (const o of options) {
    const b = h('button', { class: `chip${o === current ? ' on' : ''}`, text: o })
    b.type = 'button'
    b.onclick = () => {
      for (const c of box.querySelectorAll('.chip')) c.classList.toggle('on', c === b)
      onPick(o)
    }
    box.append(b)
  }
  return box
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
    // 계정이 없으면 두리가 가입해 줘요: 이 사이트 가입을 고른 것으로 알리고, 대화로 부탁을 보낸다
    signup: () => {
      void send({ kind: 'signup', site: r.origin, loginId: r.id })
      void send({ kind: 'ask', text: `${r.site} 회원가입해서 이어서 해 줘` })
      st.overlay = undefined
      st.tab = 'chat'
      toast(`${r.site} 가입을 두리가 해 볼게요`)
    },
    // 연결 카드가 있는 사이트면 간편 로그인도 같이 (연결하기 화면과 같은 선택지)
    ...loginChoices(cardIdFor(r.origin)),
  })
}

/** 연결 카드의 간편 로그인 버튼 (로그인 요청 카드·연결하기 화면이 같은 선택지를 쓴다) */
function loginChoices(cardId: string | undefined): Pick<CredTarget, 'social' | 'socialOnly'> {
  const it = cardId ? st.services?.find((x) => x.card.id === cardId) : undefined
  if (!it?.card.social?.length) return {}
  const id = it.card.id
  return {
    socialOnly: !/아이디|비밀번호|이메일/.test(it.card.login ?? ''),
    social: socialOrder(it.card, st.services).map(({ provider, hint }) => ({
      provider,
      ...(hint ? { hint } : {}),
      onclick: () => {
        // 공급자 쪽이 PC Chrome에 로그인돼 있으면 두리가 버튼·동의만 넘기고, 아니면 그 화면을 넘겨 드려요
        void send({ kind: 'connect-social', id, provider })
        st.overlay = undefined
        st.connecting.add(id)
        if (st.tab !== 'chat')
          toast(`${SOCIAL_LABEL[provider]}로 ${it.card.name}에 로그인해 볼게요. 끝나면 대화로 알려 드릴게요`)
        render()
      },
    })),
  }
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
      if (st.tab !== 'chat')
        toast(`${it.card.name} 로그인은 두리가 PC에서 할게요. 끝나면 대화로 알려 드릴게요`)
    },
    ...(st.afterConnect?.id === id ? { next: st.afterConnect.text } : {}),
    logo: id,
    // 간편 로그인·문자 인증만 되는 곳(캐치테이블·에이블리): 아이디 칸은 헷갈리기만 한다
    socialOnly: Boolean(it.card.social?.length) && !/아이디|비밀번호|이메일/.test(it.card.login ?? ''),
    social: socialOrder(it.card, st.services).map(({ provider, hint }) => ({
      provider,
      ...(hint ? { hint } : {}),
      onclick: () => {
        // 공급자 쪽(카카오 등)이 PC Chrome에 로그인돼 있으면 두리가 버튼·동의만 넘기고, 아니면 그 화면을 넘겨 드려요
        void send({ kind: 'connect-social', id, provider })
        st.overlay = undefined
        st.connecting.add(id)
        if (st.tab !== 'chat')
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
    // 계정이 없으면 두리가 가입해 줘요: 대화로 부탁을 보내고 두리가 가입 흐름을 한다
    signup: () => {
      if (it.card.site) void send({ kind: 'signup', site: it.card.site })
      void send({ kind: 'ask', text: `${it.card.name} 회원가입해서 이어서 해 줘` })
      st.overlay = undefined
      st.tab = 'chat'
      toast(`${it.card.name} 가입을 두리가 해 볼게요`)
    },
  })
}

// ── 따로 하는 대화 ──

function sideThreads() {
  return (st.pc?.threads ?? []).filter((t) => t.side && t.title !== '두리 피드')
}

/** 메뉴의 따로 하는 대화: 최근 몇 개만 보여 주고 나머지는 '더 보기'로 펼친다 (서랍은 통째로 스크롤된다) */
function sideMenu(): Node[] {
  const all = sideThreads()
  // 답하는 중인 대화는 접어 둔 쪽에 있어도 보이게 앞으로
  const pinned = all.filter((t) => t.busy)
  const rest = all.filter((t) => !pinned.includes(t))
  const ordered = [...pinned, ...rest]
  const shown = st.sideAll ? ordered : ordered.slice(0, SIDE_THREAD_PEEK)
  const more = ordered.length - shown.length
  const items: Node[] = shown.map((t) =>
    h(
      'button',
      { class: 'navi side-item', onclick: () => openSide(t.id, t.title) },
      h('span', { class: t.busy ? 'dot work pulse' : 'dot' }),
      h('span', { class: 'side-name', text: t.title }),
    ),
  )
  if (!all.length)
    items.push(h('p', { class: 'meta side-empty', text: '여행·이사처럼 길게 이어질 일은 따로 이야기해요' }))
  if (more > 0 || (st.sideAll && ordered.length > SIDE_THREAD_PEEK))
    items.push(
      h(
        'button',
        {
          class: 'navi side-more',
          onclick: () => {
            st.sideAll = !st.sideAll
            renderOverlay()
          },
        },
        h('span', { text: st.sideAll ? '접기' : `${more}개 더 보기` }),
        icon('chevron', st.sideAll ? 'i more-chev open' : 'i more-chev'),
      ),
    )
  return items
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
      const label = narrationLine(sd.live) ?? `${ev.event.title ?? toolLabel(ev.event.name)} 중`
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

/**
 * 기다리는 입력 카드가 있는데 닫혀 있으면 다시 여는 줄 (실수로 내리면 다시 열 길이 없었다)
 */
function infoWaitBar(): HTMLElement[] {
  const open = st.overlay?.kind === 'info' ? (st.overlay as { id: string }).id : undefined
  const q = [...st.infos.values()].filter((x) => x.status === 'pending' && x.id !== open).at(-1)
  if (!q) return []
  return [
    h(
      'button',
      { class: 'info-wait-bar', onclick: () => openOverlay({ kind: 'info', id: q.id }) },
      h('span', { text: `넣을 것이 있어요 · ${q.label}` }),
      h('strong', { text: '열기' }),
    ),
  ]
}

/**
 * 따로 하는 대화 화면에서도 사람에게 묻는 카드(내 정보·보안 키패드·인증번호·승인·로그인)를 띄운다.
 * 이 화면은 소식이 올 때마다 다시 그려서, 같은 카드면 만들어 둔 것을 그대로 쓴다 (넣던 값이 날아가지 않게)
 */
let sideSheet: { key: string; el: HTMLElement } | undefined
function sideOverlay(): HTMLElement[] {
  const ov = st.overlay
  if (!ov || !('id' in ov) || !['info', 'approval', 'login'].includes(ov.kind)) {
    sideSheet = undefined
    return []
  }
  const key = `${ov.kind}:${ov.id}`
  if (sideSheet?.key !== key) {
    const body =
      ov.kind === 'info'
        ? infoSheet(ov.id)
        : ov.kind === 'approval'
          ? approvalSheet(ov.id)
          : loginSheet(ov.id)
    const box = h('div', { class: 'app-overlay' })
    box.dataset.kind = ov.kind
    // 입력 카드는 바깥을 눌러도 닫히지 않는다 (실수로 내려 막혔다). [나중에 할게요]로만 닫는다
    box.append(
      h('div', { class: 'scrim', onclick: () => ov.kind !== 'info' && openOverlay(undefined) }),
      body,
    )
    sideSheet = { key, el: box }
  }
  return [sideSheet.el]
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
    } else if (m.role === 'tool') {
      // 빠른 답은 큰 대화로 보내지므로 따로 하는 대화에서는 그리지 않는다
      if (!m.text.includes('"kind":"quick"')) list.append(toolCard(m.text))
    }
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
    ...infoWaitBar(),
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
      // 열기 전 화면으로 (대화의 연결 카드에서 열었으면 대화로, 연결 화면에서 열었으면 그 서비스로)
      st.tab = remoteFrom
      if (v.connectId && remoteFrom === 'connect') st.connectDetail = v.connectId
      render()
    }
    remoteUi = createRemote({
      tabId: v.tabId,
      ...(v.connectId ? { connectId: v.connectId } : {}),
      input: (i) => remote(i),
      back,
      handBack: back,
      done: () => {
        // 연결: 눌렀다고 바로 연결로 치지 않는다. PC가 정말 로그인됐는지 보고 알려 준다
        if (v.connectId) {
          st.connecting.add(v.connectId)
          void send({ kind: 'connect', id: v.connectId, action: 'verify' })
          toast('로그인됐는지 확인할게요')
        } else ask('다 했어요. 이어서 해 주세요.')
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
    // 보던 화면(일하는 화면·연결 중 화면)을 다시 받아 오기 시작한다
    pollWork()
    pollConnect()
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
  // 앱 안에서 난 오류도 방금 있었던 일에 적어 둔다 (문제 알리기를 누르면 같이 간다)
  window.addEventListener('error', (e) => mark(`오류 ${e.message}`))
  window.addEventListener('unhandledrejection', (e) =>
    mark(`오류 ${String((e.reason as Error | undefined)?.message ?? e.reason)}`),
  )
  document.addEventListener('visibilitychange', () => mark(`앱 ${document.visibilityState}`))
  mark('앱 켬')
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
  // 지난번 대화를 먼저 보여 준다 (PC 연결을 기다리는 동안 빈 화면이 아니게)
  if (saved.paired) st.conv = (await loadConv().catch(() => undefined)) ?? []
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
