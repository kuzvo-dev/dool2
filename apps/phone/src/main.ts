// Dool2 phone app (v2 design: docs/design/screens/soft). Talks to Dool2 on the PC through the relay with end-to-end encryption (ADR 0012).
// Screens: connect (pairing) -> app (one chat · tasks · ideas · connections) + menu drawer · Dool2 panel · approval and login sheets · PC screen
// The header, tabs and input are built once, and the chat only appends changed messages (so a redraw does not flicker or jump the scroll).

import { LANG_NAMES, LANGS } from '@dool2/i18n'
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
  LeftRecordMessage,
  LibraryItem,
  LifeAction,
  LifeState,
  LoginRecordMessage,
  LoginRequestView,
  MadeImageRecordMessage,
  PairInvite,
  PcToPhone,
  PhoneCap,
  PhoneToPc,
  StoredMessage,
  TellRecordMessage,
  WorkRecordMessage,
} from '@dool2/protocol'
import {
  AUTH_APPS,
  agentLabel,
  CARRIERS,
  FILE_CHUNK,
  SIDE_THREAD_PEEK,
  type VaultEntry,
} from '@dool2/protocol'
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
import { approvalSignText, autoApproveSignText, LinkClient, resetSignText } from '@dool2/protocol/link'
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
  dropEnglishLines,
  finishProgress,
  hyphenate,
  interimAnswers,
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
  setFileOpener,
  shortTime,
  withLogo,
} from './dom.js'
import { matchTextBox, recentTalk, ghostRest as suggestRest } from './ghost.js'
import { lang, setLang } from './lang.js'
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
import { mainApproval } from './locales/main-a-approval.js'
import { mainCore } from './locales/main-a-core.js'
import { mainWork } from './locales/main-a-work.js'
import { approvalText } from './locales/main-b-approval.js'
import { chatText } from './locales/main-b-chat.js'
import { shellText } from './locales/main-b-shell.js'
import { smsText } from './locales/main-b-sms.js'
import { mainCCards } from './locales/main-c-cards.js'
import { mainCFeed } from './locales/main-c-feed.js'
import { mainCSettings } from './locales/main-c-settings.js'
import { mdCred } from './locales/main-d-cred.js'
import { mdSheets } from './locales/main-d-sheets.js'
import { mdSide } from './locales/main-d-side.js'
import { swText } from './locales/sw.js'
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
  type SmsPerson,
  saveFile,
  scanQr,
  shareFile,
  smsAvailable,
  smsFind,
  smsPermissions,
  smsSend,
} from './native.js'
import { ID_LOGIN, OPEN_SCREEN_TAIL, PREFERRED_INSTALLMENT } from './region/kr/main-a-chat.js'
import {
  HONORIFIC_RE,
  MY_ADDRESS_PREFIX,
  MY_ADDRESS_PREFIX_RE,
  PEOPLE_LABEL_RE,
  REQUEST_LABEL_RE,
  TICKET_LABEL_RE,
  TIME_LABEL_RE,
  WHEN_LABEL_RE,
} from './region/kr/main-b-approval.js'
import { ENTER_SUFFIX, FILE_MOVE_LABEL, FILE_RESTORE_LABEL, PICK_LABEL } from './region/kr/main-c-labels.js'
import {
  AUTH_DONE_OPTION,
  DIGITS_RE,
  FEED_THREAD_TITLE,
  ID_PASSWORD_LOGIN_RE,
  PAY_SECRET_RE,
} from './region/kr/main-d.js'
import { createRemote, type RemoteScreen, type Shot } from './remote.js'
import { clear, clearConv, load, loadConv, type Saved, save, saveConv } from './store.js'

// Screen readers and CSS (:lang) follow the UI language (ADR 0029)
document.documentElement.lang = lang
document.title = swText(lang).appName

const app = document.getElementById('app') as HTMLElement

// ── State ──
/** Five tab bar slots plus pages opened from the menu (connect, settings) */
type Tab = 'chat' | 'feed' | 'ideas' | 'goals' | 'library' | 'connect' | 'settings'
type Screen =
  | { name: 'intro' }
  | { name: 'unsupported' }
  | { name: 'pairing'; code: string; pcName: string; rejected?: boolean }
  | { name: 'app' }
  | { name: 'remote'; tabId: number; connectId?: string }
  /** One side conversation */
  | { name: 'side'; id: string }
type Overlay =
  | { kind: 'drawer' }
  | { kind: 'agent' }
  | { kind: 'approval'; id: string }
  /** Sheet for picking the delivery place and payment method on a payment card */
  | { kind: 'pick-ship'; id: string; back?: boolean }
  | { kind: 'pick-pay'; id: string; back?: boolean }
  | { kind: 'login'; id: string }
  /** What the screen asks for during login (verification code and so on) */
  | { kind: 'info'; id: string }
  /** Connect a service: ID and password -> Dool2 logs in for you */
  | { kind: 'connect'; id: string }
  | { kind: 'goal'; id: string }
  | { kind: 'item'; id: string }
  /** On long-press of a reply: save to library, copy */
  | { kind: 'msg'; id: string }
  /** Report a problem: leaves what just happened in the PC's log */
  | { kind: 'report' }
  /** Settings > My info: view masked values, edit, delete */
  | { kind: 'profile' }
  /** Settings > Vault: view saved logins (after phone lock check), edit, delete (ADR 0026) */
  | { kind: 'vault' }
  /** Settings > Payment methods: my methods (the top one is the main one) and adding (ADR 0023) */
  | { kind: 'pay' }
  | { kind: 'pay-add' }
  /** Input box +: quick menu */
  | { kind: 'plus' }
  | undefined

const st: {
  saved?: Saved
  key?: CryptoKey
  client?: LinkClient
  online: boolean
  /** Connected to the relay but the PC does not answer (the PC is off, or this phone's link was removed on the PC) */
  pcSilent: boolean
  screen: Screen
  tab: Tab
  overlay: Overlay
  pc?: Extract<PcToPhone, { kind: 'state' }>
  /** One conversation */
  conv: StoredMessage[]
  convLoaded: boolean
  hasMore: boolean
  busy: boolean
  /** The last answer is a draft being checked before it is final (ADR 0027) */
  checking: boolean
  /** When the current request started working (the progress card's elapsed time spans check rounds) */
  workFrom?: number
  queued: string[]
  /** Text and actions from the current reply */
  live: string
  steps: string[]
  /** Messages sent but not yet confirmed by the PC (shown on screen right away) */
  pending: { id: number; text: string; photo?: string }[]
  /** Photo to send (shrunk JPEG, base64) */
  attach?: string
  approvals: Map<string, ApprovalView & { shot?: string }>
  decided: Map<string, { ok: boolean; message: string }>
  /** Option picked on an approval card (payment method): approval id -> option id */
  choice: Map<string, string>
  /** Settings > My info (masked values) and the last payment method per site (asked from the PC) */
  profile?: {
    have: Record<string, string>
    missing: string[]
    payChoices: Record<string, string>
    /** My payment methods (undefined on an older PC: hides registration) */
    payMethods?: PayMethod[]
  }
  /** Settings > Vault list (no passwords) */
  vault?: (VaultEntry & { name?: string })[]
  /** Password shown briefly (cleared after 30 seconds or when the sheet closes) */
  vaultShown?: { id: string; username: string; password: string }
  /** Item being edited */
  vaultEdit?: string
  /** What the add-payment-method sheet is filling in */
  payDraft: { kind?: PayKind; inner: string; issuer: string; nickname: string; last4: string }
  logins: Map<string, LoginRequestView>
  infos: Map<string, InfoRequestView>
  loginDraft: { id: string; user: string; pw: string; busy?: boolean; error?: string }
  /** Service whose login on our behalf did not finish -> its screen (tab) */
  connectTabs: Map<string, number>
  /** Tab Dool2 is logging in on while connecting, and its screen (shown small and live on the connect card) */
  connectLive: Map<string, { tabId: number; shot?: string }>
  services?: ConnectionItem[]
  connectQuery: string
  connectCat: string
  /** Ideas tab: the chosen category ('all' = everything) and the search text */
  ideaCat: string
  /** Services the Dool2 daemon is logging in to right now */
  connecting: Set<string>
  /** Steps the daemon reported while connecting (service id -> steps) */
  connectSteps: Map<string, ConnectStep[]>
  /** Why a connection did not finish (the card stays as "finish it yourself" or "enter again") */
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
  /** Working screen: live view of the tab shown in the chat while Dool2 works on the web */
  work: { tabId?: number; web: boolean; shot?: string; url?: string }
  ideaQuery: string
  /** Idea to send right after connecting (when an idea for an unconnected service was tapped) */
  afterConnect?: { id: string; text: string; at: number }
  connectDetail?: string
  opening?: string
  agentSeg: 'upcoming' | 'memory' | 'screen' | 'activity' | 'approvals'
  /** Goals, library, memory and feed (from the PC daemon) */
  life?: LifeState
  /** Side conversations that are open */
  side?: {
    id: string
    title: string
    messages: StoredMessage[]
    live: string
    steps: string[]
    busy: boolean
    draft: string
  }
  /** A new side conversation was requested (opened as soon as it exists) */
  sideWanted?: boolean
  /** Showing every side conversation in the menu */
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
  checking: false,
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

// ── Connection ──

// Sending is queued in a single line. If another message slips in while the sequence number is raised and we wait for saving and encryption, it
// would go out with the same number or in the wrong order, and the PC would take the later one for a resend and drop it
let sending = Promise.resolve()
function send(body: PhoneToPc): Promise<void> {
  if (!QUIET_SEND.has(body.kind)) mark(`sent ${body.kind}${'action' in body ? `:${body.action}` : ''}`)
  sending = sending.then(() => sendNow(body)).catch(() => {})
  return sending
}

// ── What just happened in the app (for reporting a problem) ──
// Only the kind and time of taps and received signals are kept in phone memory, up to 300 lines. Chat content and entered values are not stored.
// Sent to the PC only when [Report a problem] is tapped, and kept in the PC's activity log for a few days
const trail: { at: number; what: string }[] = []
function mark(what: string) {
  trail.push({ at: Date.now(), what: what.slice(0, 160) })
  if (trail.length > 300) trail.splice(0, trail.length - 300)
}
/** Signals that come too often to log */
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

/** Clears this phone's connection and returns to the start (scan QR) */
/**
 * Reset data: asks twice, checks the phone lock, and sends a request signed with this phone's key. The PC erases only
 * after verifying the signature
 */
async function resetAll() {
  const s = st.saved
  if (!s) return
  if (!confirm(mainCore(lang).resetAsk)) return
  const services = confirm(mainCore(lang).resetServicesAsk)
  if ((await confirmDevice(mSet.startOver)) === 'cancel') return
  mark(`reset (services ${services ? 'included' : 'kept'})`)
  const at = Date.now()
  const sig = await signText(s.keys.signPriv, resetSignText(at, services))
  toast(mainCore(lang).resetting)
  await send({ kind: 'reset', at, services, sig })
}

/** Auto-approve on or off (ADR 0030). Turning it on asks twice (a dialog and the phone lock); the request is signed */
async function setAutoApprove(on: boolean) {
  const s = st.saved
  if (!s) return
  if (on) {
    if (!confirm(mSet.autoApproveAsk)) return
    if ((await confirmDevice(mSet.autoApproveDevice)) === 'cancel') return
  }
  mark(`auto-approve ${on ? 'on' : 'off'}`)
  const at = Date.now()
  const sig = await signText(s.keys.signPriv, autoApproveSignText(on, at))
  await send({ kind: 'auto-approve', on, at, sig })
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
      if (st.online !== (state === 'ready')) mark(`relay ${state}`)
      st.online = state === 'ready'
      clearTimeout(silentTimer)
      if (state === 'ready' && st.saved?.paired) {
        // If the PC says nothing within 7 seconds, tell the user (so it does not sit on an empty screen)
        heard = false
        silentTimer = setTimeout(() => {
          if (heard || !st.online) return
          st.pcSilent = true
          render()
        }, 7000)
        hello()
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
      toast(mainCore(lang).paired)
      st.screen = { name: 'app' }
      // Fetch the same things as on reconnect (so feed, goals and ideas do not look empty)
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
      // If the PC name was changed on the PC or another phone, follow it
      if (msg.pcName && msg.pcName !== s.pcName) {
        s.pcName = msg.pcName
        await save(s)
      }
      for (const a of msg.approvals) if (!st.approvals.has(a.id)) st.approvals.set(a.id, a)
      for (const l of msg.logins ?? []) st.logins.set(l.id, l)
      // The pending logins the PC sent are the whole list: one not in it has finished on the PC (daemon restarted, timed out) or is gone
      // (a Kurly login card used to stay under "waiting for me" even after connecting)
      for (const l of st.logins.values())
        if (l.status === 'pending' && !(msg.logins ?? []).some((x) => x.id === l.id))
          st.logins.set(l.id, { ...l, status: 'expired' })
      for (const q of msg.infos ?? []) st.infos.set(q.id, q)
      for (const id of st.infos.keys()) if (!(msg.infos ?? []).some((q) => q.id === id)) st.infos.delete(id)
      st.connecting = new Set(msg.connecting ?? [])
      // If the app was reopened mid-work: get the tab Dool2 is looking at and keep showing the working screen
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
      if (!msg.before) st.checking = msg.state.checking === true
      st.busy = msg.state.busy
      st.queued = msg.state.queued
      // Drop from "sending" any message already in the re-fetched record or already queued (otherwise it shows twice)
      if (!msg.before) {
        const mine = new Set(
          msg.state.messages.filter((m) => m.role === 'user').map((m) => splitPhoto(m.text).text),
        )
        st.pending = st.pending.filter((p) => !mine.has(p.text) && !msg.state.queued.includes(p.text))
      }
      // If the re-fetched record is finished, clear a "replying" state left by a missed end signal
      if (!msg.before && !msg.state.busy) {
        st.live = ''
        st.steps = []
      }
      break
    case 'conversation-status':
      st.busy = msg.busy
      st.checking = msg.checking === true
      if (st.busy) st.workFrom ??= Date.now()
      else st.workFrom = undefined
      st.queued = msg.queued
      // A message that moved to the queue is dropped from "sending"
      st.pending = st.pending.filter((p) => !msg.queued.includes(p.text))
      if (!msg.busy) {
        st.live = ''
        st.steps = []
      }
      break
    case 'stream':
      // Progress of a side conversation goes to its own screen, the rest to the main chat
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
        notify(mainCore(lang).approvalWaiting, msg.approval.what, `approval-${msg.approval.id}`)
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
      // Also clear the conversation pieces and recent log kept on this phone, and relaunch as if the app was opened for the first time (PC link and theme stay)
      await clearConv().catch(() => undefined)
      trail.splice(0)
      setTimeout(() => location.reload(), 1200)
      break
    }
    case 'decided': {
      st.decided.set(msg.id, { ok: msg.ok, message: msg.message })
      const a = st.approvals.get(msg.id)
      if (a && msg.ok) st.approvals.set(msg.id, { ...a, status: a.status === 'pending' ? 'done' : a.status })
      // On success the card changes right away, so no toast bar is shown
      if (!msg.ok) toast(msg.message)
      void send({ kind: 'approval', id: msg.id })
      break
    }
    case 'info-request':
      // What the screen asks for while connecting: open the input screen right away (no need to find the PC screen and type there)
      st.infos.set(msg.request.id, msg.request)
      openOverlay({ kind: 'info', id: msg.request.id })
      break
    case 'info-done':
      st.infos.delete(msg.id)
      if (st.overlay?.kind === 'info' && st.overlay.id === msg.id) st.overlay = undefined
      break
    case 'login-request':
      st.logins.set(msg.request.id, msg.request)
      // An account Dool2 asked for while connecting a service (Kakao and so on): open the input screen right away
      if (msg.request.connect) openOverlay({ kind: 'login', id: msg.request.id })
      notify(
        mainCore(lang).loginNeeded,
        mainCore(lang).loginNeededBody(msg.request.site),
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
        // Login screen inside a connect card: only swap the image
        const first = !live.shot
        live.shot = msg.shot
        const img = document.querySelector<HTMLImageElement>(`.connect-shot[data-tab="${msg.tabId}"]`)
        if (img) img.src = `data:image/jpeg;base64,${msg.shot}`
        if (first) renderSoon()
        return
      }
      if (st.screen.name !== 'remote' && msg.tabId === st.work.tabId && msg.shot) {
        // Working screen in the chat: only swap the image
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
      // Live screen: only swap the image (the whole screen is not redrawn, so it does not flicker)
      // The remote screen is built once, and only its image and info are swapped
      if (remoteUi?.tabId === msg.tabId && hadShot) {
        remoteUi.update(st.screenShot, fps())
        return
      }
      break
    }
    case 'connections': {
      st.services = msg.services
      // Even when a person or Dool2 finished the login on the screen and it connected, send the postponed request (start right after connecting)
      if (st.afterConnect && msg.services.some((s) => s.card.id === st.afterConnect?.id && s.connectedAt))
        runAfterConnect(st.afterConnect.id)
      // If the PC confirms the login while logging in on the remote screen, go back to that service
      const v = st.screen
      // Whether opened from a connect card or handed over by Dool2 (the same login tab): close it once that service is connected.
      // Left open, the site's first screen after login (a search box and so on) would be drawn as a "field needed" (measured on 11st)
      const ownerOf = (tabId: number) =>
        [...st.connectTabs.entries()].find(([, t]) => t === tabId)?.[0] ??
        [...st.connectFails.entries()].find(([, f]) => f.tabId === tabId)?.[0]
      const remoteFor = v.name === 'remote' ? (v.connectId ?? ownerOf(v.tabId)) : undefined
      if (v.name === 'remote' && remoteFor) {
        const done = msg.services.find((x) => x.card.id === remoteFor && x.connectedAt)
        if (done) {
          // Go back to the chat: the connect card turns to "connected" and the follow-up work shows there
          // (to that service's screen only if it started from the connect screen)
          st.screen = { name: 'app' }
          st.tab = remoteFrom === 'connect' ? 'connect' : 'chat'
          if (st.tab === 'connect') st.connectDetail = done.card.id
          else stickToBottom = true
          toast(mainCore(lang).serviceConnected(done.card.name))
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
      // Next page of the request list (without before, fetch the first page again)
      if (msg.list === 'library') libPagers[msg.tab === 'files' ? 'files' : 'made'].take(msg.before, msg)
      else (msg.kinds?.length ? activityPager : feedPager).take(msg.before, msg)
      break
    case 'life-item':
      if (msg.item) fullItems.set(msg.id, msg.item)
      break
    case 'file-chunk':
      fileChunkWaits.get(`${msg.id}:${msg.offset}`)?.(msg)
      break
    case 'work-tab': {
      // Dool2 started working on this tab (browser tool or service tool): if it is replying, show that screen in the chat.
      // It used to open only when the tool name was browser_, so the screen did not show when working with service tools
      const fresh = msg.tabId !== st.work.tabId
      // If it is a new tab of the site just opened, remember that site for the tab
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
      // Starting again clears the last failure
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
        // Turn the card to "connected" even before the connection list arrives (so it does not briefly look unconnected)
        const it = st.services?.find((x) => x.card.id === msg.id)
        if (it && !it.connectedAt) it.connectedAt = new Date().toISOString()
      } else
        st.connectFails.set(msg.id, {
          reason: msg.reason ?? (msg.human ? 'human' : 'unknown'),
          message: msg.message,
          ...(msg.tabId !== undefined ? { tabId: msg.tabId } : {}),
          // If Dool2 took over, from then on (so the moment before it starts replying also reads as "carrying on")
          ...(msg.agent ? { agent: true, at: Date.now() } : {}),
        })
      if (msg.ok) {
        st.connectTabs.delete(msg.id)
        if (st.overlay?.kind === 'connect') st.overlay = undefined
        // If the chat is on screen, the card turning to "connected" is enough (do not say the same thing twice)
        if (st.tab !== 'chat' || st.screen.name !== 'app') toast(msg.message)
        runAfterConnect(msg.id)
      } else if (st.tab !== 'chat' || st.screen.name !== 'app') {
        // Do not switch screens on our own: only notify. If it is the person's turn, tapping the toast opens that screen
        const tab = msg.tabId
        if (tab !== undefined && msg.reason === 'human')
          toast(mainCore(lang).tapToOpen(msg.message), () => openRemote(tab, msg.id))
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

/** One line per received signal (kind only, no content; streamed text and screen images are not logged) */
function markReceived(msg: PcToPhone) {
  if (msg.kind === 'screen' || msg.kind === 'form') return
  if (msg.kind === 'stream') {
    const ev = msg.event
    if (ev.type === 'agent') {
      if (ev.event.type === 'tool') mark(`received tool ${ev.event.name}`)
      return
    }
    return mark(`received stream:${ev.type}${ev.type === 'saved' ? `:${ev.message.role}` : ''}`)
  }
  if (msg.kind === 'connect-result')
    return mark(
      `received connect-result ${msg.id} ${msg.ok ? 'ok' : (msg.reason ?? 'fail')}${msg.agent ? ' taken-over' : ''}`,
    )
  if (msg.kind === 'connect-progress')
    return mark(`received connect-progress ${msg.id} ${msg.steps.length} steps`)
  if (msg.kind === 'connect-status')
    return mark(`received connect-status ${msg.connecting.join(',') || 'none'}`)
  if (msg.kind === 'conversation-status')
    return mark(`received conversation-status ${msg.busy ? 'replying' : 'idle'}`)
  if (msg.kind === 'error') return mark(`received error ${msg.message}`)
  mark(`received ${msg.kind}`)
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
    st.workFrom ??= Date.now()
    if (ev.event.type === 'text') st.live += ev.event.delta
    else if (ev.event.type === 'tool') {
      // When work on the web starts, show that screen in the chat
      // (Service tools announce their tab with work-tab when the daemon opens it. Using another tool briefly does not turn the view off)
      if (/browser_/.test(ev.event.name) && !st.work.web) {
        st.work = { ...st.work, web: true }
        pollWork()
      }
      // What is said before a tool is not a reply but the current action. Keep that single line as a step and clear the bubble
      const act = mainCore(lang).doing(ev.event.title ?? toolLabel(ev.event.name, lang))
      const label = narrationLine(st.live, lang) ?? act
      st.live = ''
      // Where it worked: the opened address, or for web tools without one, the site of the screen being viewed
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
    hello()
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

// ── Tasks ──

/** Send a request: show my message right away and send it to the PC */
function ask(text: string) {
  const photo = st.attach
  const t = text.trim() || (photo ? mainCore(lang).photoDefault : '')
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
 * Connecting happens in the chat: show my message "Connect X" right away, and the PC leaves a connect card in the chat.
 * Login continues on that card, and progress and results stay in the same chat (no waiting on the connect screen)
 */
function connectInChat(id: string) {
  const it = st.services?.find((s) => s.card.id === id)
  // Services used by logging in (browser, before an official integration) all connect in the chat. Only phone permissions (device) are turned on from the connect screen
  if (!it || it.card.how === 'device' || it.card.how === 'open') return openOverlay({ kind: 'connect', id })
  if (!st.online) return toast(mainCore(lang).needPcOnline)
  // If the same connect card is already near the end of the chat, go to it instead of stacking a new one
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
  st.pending.push({ id: ++pendingSeq, text: mainCore(lang).connectAsk(it.card.name) })
  setTab('chat')
  void send({ kind: 'connect', id, action: 'chat' })
}

let convSaveTimer: ReturnType<typeof setTimeout> | undefined
let convSavedLast = ''
/** Keeps the last 40 conversation lines on the phone (only when changed, batched for 1 second) */
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

/** Shrinks a photo to a JPEG of at most 1024px and 300KB (so one relay message can carry it) */
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
  throw new Error(mainCore(lang).photoTooBig)
}

/** + > Send a photo */
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

/** Option picked when approving (payment method). If none, the card's default */
function chosenOf(a: ApprovalView): string | undefined {
  if (!a.choices?.length) return undefined
  return st.choice.get(a.id) ?? a.choice ?? a.choices[0]?.id
}

/** What was picked in a sub-choice (registered card, installments). If none, what was preselected on the payment screen */
function subChosenOf(
  a: ApprovalView,
  g: NonNullable<ApprovalView['subChoices']>[number],
): string | undefined {
  return st.choice.get(`${a.id}:${g.key}`) ?? g.choice ?? g.options[0]?.id
}

/** Only the sub-choices of the current payment method (registered cards and installments exist only for cards) */
function subsFor(a: ApprovalView) {
  const main = chosenOf(a)
  return (a.subChoices ?? []).filter((g) => !g.when || !main || g.when === main)
}

/** What was picked for the delivery place (default: the current address a0) */
function shipChosenOf(a: ApprovalView): string | undefined {
  if (!a.shipOptions?.length) return undefined
  return st.choice.get(`${a.id}:ship`) ?? 'a0'
}

/** All picks to sign and send: payment method, sub-choices and a changed delivery place, comma-joined ("c2,s1o3,a1") */
function choiceString(a: ApprovalView): string | undefined {
  const ship = shipChosenOf(a)
  const parts = [
    chosenOf(a),
    ...subsFor(a).map((g) => subChosenOf(a, g)),
    ship && ship !== 'a0' && ship !== 'n:' ? ship : undefined,
  ].filter((x): x is string => !!x)
  return parts.length ? parts.join(',') : undefined
}

/** Delivery place: the current address on one line plus [Change]; expanded, it lists other saved addresses (everything is decided on one payment approval) */
function shipRow(a: ApprovalView): HTMLElement | undefined {
  const opts = a.shipOptions
  if (!opts?.length) return undefined
  const now = shipChosenOf(a)
  const cur = opts.find((o) => o.id === now) ?? opts[0]
  const key = `${a.id}:ship`
  // If it differs from the address in My info, open it from the start with a warning
  const open = st.choice.has(`${key}:open`) || Boolean(a.shipWarn)
  if (!open)
    return h(
      'div',
      { class: 'approve-choices one-line' },
      h('span', { class: 'meta', text: mainApproval(lang).shipTo(cur?.label ?? '') }),
      h('button', {
        class: 'chip chip-more',
        text: mainApproval(lang).change,
        onclick: () => {
          st.choice.set(`${key}:open`, '1')
          render()
        },
      }),
    )
  // New address: deliver somewhere that site does not have yet (Dool2 adds it to the site's addresses, then pays)
  const isNew = now?.startsWith('n:')
  const input = h('input', { class: 'field' }) as HTMLInputElement
  input.placeholder = mainApproval(lang).newAddressPlaceholder
  input.value = isNew ? decodeURIComponent(now?.slice(2) ?? '') : ''
  input.onchange = () => {
    const v = input.value.trim()
    if (v) st.choice.set(key, `n:${encodeURIComponent(v.slice(0, 100))}`)
  }
  return h(
    'div',
    { class: 'approve-choices' },
    h('span', { class: 'meta', text: mainApproval(lang).shipWhere }),
    ...(a.shipWarn ? [h('p', { class: 'field-err ship-warn', text: `⚠ ${a.shipWarn}` })] : []),
    h(
      'div',
      { class: 'choice-list' },
      ...opts.map((o) =>
        h('button', {
          class: `chip${o.id === now ? ' on' : ''}`,
          text: o.label,
          onclick: () => {
            st.choice.set(key, o.id)
            render()
          },
        }),
      ),
      h('button', {
        class: `chip${isNew ? ' on' : ''}`,
        text: mainApproval(lang).newAddress,
        onclick: () => {
          if (!isNew) st.choice.set(key, 'n:')
          render()
        },
      }),
    ),
    ...(isNew ? [input] : []),
  )
}

async function decide(a: ApprovalView, decision: 'approve' | 'reject', quiet = false) {
  const s = st.saved
  if (!s) return
  // The chosen payment method, card and installment are signed too (nobody in between can swap them)
  const choice = decision === 'approve' ? choiceString(a) : undefined
  // The approval content is signed with this phone's key. The PC verifies it with the public key it received at pairing
  const sig = await signText(s.keys.signPriv, approvalSignText(a, decision, choice))
  // Hold-to-approve folds the card after showing the check (markDecided is called later)
  if (!quiet) markDecided(a, decision)
  await send({ kind: 'decide', id: a.id, decision, sig, ...(choice ? { choice } : {}) })
}

/** Final button label that follows the chosen payment method ("Pay by card" becomes "Pay with Naver Pay" when that is picked) */
function finalLabel(a: ApprovalView): string {
  const now = a.choices?.find((c) => c.id === chosenOf(a))
  if (!now) return a.label
  const from = a.choices?.find((c) => a.label.startsWith(c.label))
  return from ? `${now.label}${a.label.slice(from.label.length)}` : a.label
}

/** The "which payment method?" row of an approval card (only methods the site accepts; default is the last one used on this site) */
/**
 * With many options (12-month installments and so on) show the common ones first: the current pick, pay-in-full and interest-free, a few from the top. The rest sit behind [More]
 * (measured on Coupang installments: 12 chips from pay-in-full to 12 months made the approval card long)
 */
function shown<T extends { id: string; label: string }>(
  options: T[],
  now: string | undefined,
  key: string,
): T[] {
  if (options.length <= 6 || st.choice.get(`${key}:more`)) return options
  const keep = options.filter((o, i) => i < 3 || PREFERRED_INSTALLMENT.test(o.label)).slice(0, 5)
  // The current pick is always shown
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
    // With many options (registered cards, installments, banks) use one select box instead of chips (real use on 11-20: a long row of chips was hard to choose from)
    options.length > 4
      ? selectRow(title, options, now, (id) => {
          st.choice.set(key, id)
          render()
        })
      : h(
          'div',
          { class: 'approve-choices' },
          h('span', { class: 'meta', text: title }),
          h(
            'div',
            { class: 'chip-row' },
            ...shown(options, now, key).map((c) => {
              // A chip that matches my payment method gets a dot (ADR 0023)
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
              if (c.mine) chip.setAttribute('aria-label', mainApproval(lang).mineAria(c.label, c.mine ?? ''))
              return chip
            }),
            ...(shown(options, now, key).length < options.length
              ? [
                  h('button', {
                    class: 'chip chip-more',
                    text: mainApproval(lang).more(options.length - shown(options, now, key).length),
                    onclick: () => {
                      st.choice.set(`${key}:more`, '1')
                      render()
                    },
                  }),
                ]
              : []),
          ),
        )
  // If nothing was changed yet, summarize on one line (Card · Shinhan Card · Pay in full [Change]). Tapping [Change] opens the chips
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
              ? mainApproval(lang).titleMine(a.choiceTitle ?? mainApproval(lang).payMethod)
              : mainApproval(lang).titleAsk(a.choiceTitle ?? mainApproval(lang).payMethod),
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
      h('span', {
        class: 'meta',
        text: mainApproval(lang).titleSummary(a.choiceTitle ?? mainApproval(lang).payMethod, summary),
      }),
      h('button', {
        class: 'chip chip-more',
        text: mainApproval(lang).change,
        onclick: () => {
          st.choice.set(`${a.id}:open`, '1')
          render()
        },
      }),
    )
  }
  return h('div', {}, ...groups.map((g) => row(g.title, g.options, g.now, g.key)))
}

/** Select box row: a title and a list to pick from (the phone's own picker opens). My payment methods get a ● */
function selectRow(
  title: string,
  options: { id: string; label: string; mine?: string }[],
  now: string | undefined,
  onPick: (id: string) => void,
): HTMLElement {
  const sel = h('select', { class: 'field select-field' }) as HTMLSelectElement
  for (const o of options) {
    const opt = document.createElement('option')
    opt.value = o.id
    opt.textContent = `${o.mine ? '● ' : ''}${o.label}`
    if (o.id === now) opt.selected = true
    sel.append(opt)
  }
  sel.setAttribute('aria-label', title)
  sel.onchange = () => onPick(sel.value)
  return h('label', { class: 'approve-choices select-row' }, h('span', { class: 'meta', text: title }), sel)
}

/** Shows what Dool2 picked by itself before paying (no insurance, terms accepted and so on) as its own line */
function choseRow(a: ApprovalView): HTMLElement | undefined {
  if (!a.chose?.length) return undefined
  return h(
    'div',
    { class: 'approve-chose' },
    h('span', { class: 'meta', text: mainApproval(lang).choseTitle }),
    h('p', { text: a.chose.join(' · ') }),
  )
}

function markDecided(a: ApprovalView, decision: 'approve' | 'reject') {
  if (st.decided.has(a.id)) return
  st.decided.set(a.id, {
    ok: true,
    message: decision === 'approve' ? mainApproval(lang).approveSent : mainApproval(lang).rejectSent,
  })
  render()
}

const pendingApprovals = () =>
  [...st.approvals.values()].filter((a) => a.status === 'pending' && !st.decided.has(a.id))
/** Pending logins, minus expired ones and ones whose service is already connected */
const pendingLogins = () =>
  [...st.logins.values()].filter((l) => {
    if (l.status !== 'pending' || Date.parse(l.expiresAt) <= Date.now()) return false
    const cid = cardIdFor(l.origin)
    const svc = cid ? st.services?.find((x) => x.card.id === cid) : undefined
    return !(svc?.connectedAt && Date.parse(svc.connectedAt) >= Date.parse(l.createdAt))
  })

// ── Remote screen: see and tap the PC tab Dool2 handed over, from the phone (turned into a live view in the next step) ──

let screenTimer: ReturnType<typeof setTimeout> | undefined
/** Live screen: when an image arrives, ask for the next one right away (3 to 5 per second). If none comes in 2 seconds, ask again */
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

/** Images per second (last 2 seconds) */
function fps() {
  const now = performance.now()
  while (frameTimes.length && now - (frameTimes[0] ?? 0) > 2000) frameTimes.shift()
  return Math.max(1, Math.round(frameTimes.length / 2))
}

/** Tab before the remote screen opened (closing returns there: to the chat if opened from the chat) */
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

// ── Working screen: while Dool2 works on the web, that tab shown small and live in the chat ──

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

/** While connecting: the screen Dool2 is logging in on, shown small and live on the chat's connect card */
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

/** Login screen inside a connect card (tap to open it large and do it yourself) */
function connectPeek(id: string): HTMLElement | undefined {
  const l = st.connectLive.get(id)
  if (!l?.shot) return undefined
  const img = h('img', { class: 'connect-shot' })
  img.dataset.tab = String(l.tabId)
  img.src = `data:image/jpeg;base64,${l.shot}`
  return h(
    'button',
    { class: 'wp-peek', label: mainWork(lang).loginPeekLabel, onclick: () => openRemote(l.tabId, id) },
    h(
      'span',
      { class: 'wp-bar' },
      h('span', { text: mainWork(lang).loginPeekTitle }),
      h('span', { class: 'wp-live', text: mainWork(lang).now }),
    ),
    img,
  )
}

/** When each step started (same order as st.steps) */
const stepAt: number[] = []
/** What the tool did and where, per step (same order as st.steps) */
const stepInfo: { act: string; place?: string }[] = []
/** Last site opened (used by browser_ tools that do not know their tab) */
let workHost: string | undefined
/** Tab id -> that tab's site. Filled from screen image addresses and "new tab right after opening" notices (so rows stay right across many tabs) */
const tabHosts = new Map<number, string>()
/** Site just opened with browser_open: the next new tab belongs to it */
let openedHost: string | undefined
/** Whether earlier steps are expanded on the working card (folded at the start of each turn) */
let workAllSteps = false
/** Whether the view Dool2 is looking at stays expanded (folded by default; once expanded it stays so for the next task) */
const PEEK_KEY = 'dool2.workPeek'
const peekOpen = () => localStorage.getItem(PEEK_KEY) === '1'

/** Site address -> connect card name (catchtable.co.kr -> CatchTable), or the address if none */
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
  return mainWork(lang).secs(Math.max(1, Math.round(ms / 1000)))
}

/** Icon at the left of a row: service logo (first letter if none), line icons for PC apps, files and Dool2's own work. A spinner or check sits in the corner */
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

/** One service row: icon · name / what it does · time taken */
function groupRow(g: WorkGroup, state: 'done' | 'doing'): HTMLElement {
  const sub = state === 'doing' ? g.act : g.kind === 'doori' ? '' : doneLine(g, lang)
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

/** Whether it is the same row (so a redraw can leave it alone) */
const groupSig = (g: WorkGroup, state: string) => `${g.key}|${g.title}|${g.act}|${g.count}|${state}`

/** Rows for the current work (finished rows include time taken) */
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
  return groupSteps(steps, placeCards(), lang)
}

/** Last of Dool2's narration lines (not a tool name) */
function lastNarration(): string | undefined {
  for (let i = st.steps.length - 1; i >= 0; i--) {
    const t = st.steps[i] as string
    if (t !== stepInfo[i]?.act) return t
  }
  return undefined
}

function clockText() {
  const from = st.workFrom ?? stepAt[0]
  if (!from) return ''
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Working card in the chat: Dool2 + what it is saying now · per-service rows (spinner -> check) · a folded "what Dool2 is looking at" view.
 * The view is folded by default (small preview + live dot); tap to expand, tap the expanded view to open it large
 */
function workPanel(): HTMLElement {
  const toggle = h(
    'button',
    { class: 'wp-peek-bar', label: mainWork(lang).viewExpand },
    h('img', { class: 'work-thumb' }),
    h('span', { class: 'wp-peek-t', text: mainWork(lang).viewTitle }),
    h('span', { class: 'wp-live', text: mainWork(lang).now }),
    icon('chevron', 'i wp-chev'),
  )
  const big = h(
    'button',
    {
      class: 'wp-peek wp-peek-in',
      label: mainWork(lang).viewBig,
      onclick: () => st.work.tabId !== undefined && openRemote(st.work.tabId),
    },
    h('img', { class: 'work-shot' }),
    h('span', { class: 'wp-hint', text: mainWork(lang).viewHint }),
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
  const draft = h('details', { class: 'wc-draft' }, h('summary', {}), h('div', { class: 'rich' }))
  const take = h('button', {
    class: 'btn-ghost sm wp-take',
    text: tChat.takeAsIs,
    onclick: () => void send({ kind: 'conversation-accept' }),
  })
  const card = h(
    'div',
    { class: 'work-panel' },
    h('div', { class: 'wp-head' }, doori('thinking', 26), h('b', { class: 'wp-title' }), clock),
    h('ol', { class: 'wp-steps' }),
    draft,
    wrap,
    h(
      'div',
      { class: 'wp-foot' },
      take,
      h('span', { class: 'grow' }),
      h('button', {
        class: 'btn-text sm wc-stop',
        text: tChat.stopWork,
        onclick: () => void send({ kind: 'conversation-cancel' }),
      }),
    ),
  )
  // Time taken: updated every second only while the card is on screen
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
  const fp = finishProgress(st.conv, { running: st.busy, checking: st.checking })
  const draftMsg = fp?.draft ? st.conv.find((m) => m.id === fp.draft) : undefined
  // Text written after tools is the draft of the answer
  const writing = st.live && st.steps.length ? dropEnglishLines(st.live, lang) : ''
  const title = st.checking
    ? tChat.checkingTitle
    : fp?.rounds
      ? fp.next
        ? tChat.continuingTitle(fp.next)
        : tChat.continuingPlain
      : writing
        ? tChat.writingTitle
        : (lastNarration() ?? mainWork(lang).workingTitle)
  const draftBox = card.querySelector<HTMLDetailsElement>('.wc-draft')
  const draftText = writing || draftMsg?.text || ''
  if (draftBox) {
    draftBox.hidden = !draftText
    const sum = draftBox.querySelector('summary')
    const label = fp?.rounds && !st.checking ? tChat.earlierDraft : tChat.seeDraft
    if (sum && sum.textContent !== label) sum.textContent = label
    const body = draftBox.querySelector<HTMLElement>('.rich')
    if (body && body.dataset.text !== draftText) {
      body.dataset.text = draftText
      body.replaceChildren(rich(draftText))
    }
  }
  const take = card.querySelector<HTMLElement>('.wp-take')
  if (take) take.hidden = !draftMsg
  const t = card.querySelector('.wp-title')
  if (t && t.textContent !== title) t.textContent = title
  // Current screen: only when working on the web and an image has arrived
  const view = card.querySelector<HTMLElement>('.wp-view')
  const shot = st.work.web ? st.work.shot : undefined
  if (view) view.hidden = !shot
  if (shot) {
    const src = `data:image/jpeg;base64,${shot}`
    for (const img of card.querySelectorAll<HTMLImageElement>('.work-shot, .work-thumb'))
      if (img.src !== src) img.src = src
  }
  // Rows: only what changed. New rows rise in from below, and a row that just finished pops its check
  const list = card.querySelector<HTMLElement>('.wp-steps')
  if (!list) return
  const groups = liveGroups()
  const hidden = workAllSteps ? 0 : Math.max(0, groups.length - 4)
  const shown = groups.slice(hidden)
  const more = list.querySelector<HTMLElement>('.ws.more')
  if (hidden) {
    const text = mainWork(lang).earlier(hidden)
    if (!more)
      list.prepend(
        h(
          'li',
          { class: 'ws more' },
          h('button', {
            text,
            label: mainWork(lang).earlierExpand,
            onclick: () => {
              workAllSteps = true
              updateWorkPanel(card)
            },
          }),
        ),
      )
    else if (more.textContent !== text) (more.firstElementChild as HTMLElement).textContent = text
  } else more?.remove()
  // One row per place (key): existing rows are moved (a place visited again goes to the bottom) and only changed rows are redrawn
  const old = new Map<string, HTMLElement>()
  // If two rows share a key keep only one (a leftover row would never be removed and would pile up)
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
    // If it is not in place, move it (to position i after the "more" row)
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
 * Whether the connection is waiting for a person: the last step asks for an account or verification code and that request is still open.
 * If no steps arrived (the app opened later, or an older PC), check for an open login request for connecting instead
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
  if (login) return { kind: 'login', id: login.id, label: mainWork(lang).enter(login.site) }
  const info = [...st.infos.values()].at(-1)
  return info ? { kind: 'info', id: info.id, label: mainWork(lang).enter(info.label) } : undefined
}

/**
 * Card for a connection that did not finish: the reason plus one thing to do right away.
 * When it is the person's turn (CAPTCHA, identity check) the card offers [Open screen]; once done, Dool2 marks it connected by itself
 */
function connectFailCard(
  c: ConnectionItem['card'],
  fail: NonNullable<ReturnType<typeof st.connectFails.get>>,
  mark: HTMLElement,
): HTMLElement {
  const tab = fail.tabId
  const openScreen = () => tab !== undefined && openRemote(tab, c.id)
  const retry = () => openOverlay({ kind: 'connect', id: c.id })
  // If Dool2 raised an ID and password card, that comes first: it is the user's turn (measured 11-21 Asiana: the card was hidden behind "carrying on")
  const waiting = [...st.logins.values()].find((l) => l.status === 'pending' && cardIdFor(l.origin) === c.id)
  if (waiting)
    return h(
      'div',
      { class: 'card approve-card connect-card ask' },
      h(
        'div',
        { class: 'approve-head' },
        mark,
        h(
          'div',
          {},
          h('strong', { text: mainWork(lang).enterCreds(c.name) }),
          h('span', { class: 'meta', text: mainWork(lang).enterCredsMeta }),
        ),
      ),
      h(
        'div',
        { class: 'approve-actions' },
        h('button', {
          class: 'btn',
          text: mainWork(lang).enterBtn,
          onclick: () => openOverlay({ kind: 'login', id: waiting.id }),
        }),
      ),
    )
  // While Dool2 carries on in the chat after the automatic login stopped: it is not a failure but work in progress (progress shows on the working card right below)
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
          h('strong', { text: mainWork(lang).takingOver }),
          h('span', {
            class: 'meta',
            text: mainWork(lang).takingOverMeta,
          }),
        ),
        h('span', { class: 'spin' }),
      ),
    )
  const view =
    fail.reason === 'wrong'
      ? {
          title: mainWork(lang).wrongTitle,
          meta: mainWork(lang).wrongMeta,
          main: h('button', { class: 'btn', text: mainWork(lang).reenter, onclick: retry }),
          sub: undefined,
        }
      : fail.reason === 'human'
        ? {
            title: mainWork(lang).humanTitle,
            meta: mainWork(lang).humanMeta(fail.message.replace(OPEN_SCREEN_TAIL, '')),
            main:
              tab !== undefined
                ? h('button', { class: 'btn', text: mainWork(lang).openScreen, onclick: openScreen })
                : undefined,
            sub: h('button', { class: 'btn-ghost', text: mainWork(lang).startOver, onclick: retry }),
          }
        : {
            title: mainWork(lang).failTitle(c.name),
            meta: fail.message,
            // Viewing the screen directly is left off the card and shows only when trying again (the login screen) fails: not needing it is best (user feedback)
            main: h('button', { class: 'btn', text: mainWork(lang).retry, onclick: retry }),
            sub: undefined,
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

/** Whether Dool2 is carrying on after the automatic login stopped (replying, or took over within 20 seconds) */
function agentOn(fail: { agent?: boolean; at?: number }): boolean {
  return Boolean(fail.agent) && (st.busy || Date.now() - (fail.at ?? 0) < 20_000)
}

/** Connect card description, matching how the service really works (never say "ID and password" for a social-login-only service) */
function connectHow(c: ConnectionItem['card']): string {
  const social = (c.social ?? []).slice(0, 2).map((p) => SOCIAL_LABEL[p])
  const idLogin = ID_LOGIN.test(c.login ?? '')
  if (social.length && !idLogin) return mainWork(lang).howSocialOnly(social.join('·'))
  if (social.length) return mainWork(lang).howSocialOrId(social.join('·'))
  return mainWork(lang).howId
}

/** Steps while connecting: finished steps get a ✓ and time taken, the current step a spinner */
function connectStepList(id: string, waiting = false): HTMLElement | undefined {
  const all = st.connectSteps.get(id)
  // When waiting for a person the card title already says "X needed", so the last step with the same words is dropped
  const steps = waiting && all?.at(-1)?.ask ? all.slice(0, -1) : all
  if (!steps?.length) return undefined
  const list = h('ol', { class: 'wp-steps connect-steps' })
  steps.forEach((s, i) => {
    const next = steps[i + 1]
    list.append(stepRow(s.text, next ? 'done' : 'doing', next ? next.at - s.at : undefined))
  })
  // Only the newly arrived step rises in from below
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

/** One step row while connecting: finished steps get a ✓ and time taken, the current step a spinner */
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
 * After it ends: a folded line above the reply, "icon stack · Looked at 4 places · 41s" (tap to open the per-service rows).
 * Older records (no place info) read "How it worked · N steps"
 */
function workDone(rec: WorkRecordMessage): HTMLElement {
  const groups = groupSteps(rec.steps, placeCards(), lang)
  const places = [
    ...new Map(
      groups.filter((g) => g.kind === 'web' || g.kind === 'service').map((g) => [g.key, g]),
    ).values(),
  ]
  const list = h('ol', { class: 'wp-steps' })
  if (rec.count > rec.steps.length)
    list.append(h('li', { class: 'ws more', text: mainWork(lang).trimmed(rec.count - rec.steps.length) }))
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
      ? mainWork(lang).workedAt(places[0]?.title ?? '')
      : mainWork(lang).lookedAt(places.length)
    : rec.host
      ? mainWork(lang).workedAt(siteName(rec.host))
      : mainWork(lang).process
  const head = h(
    'button',
    { class: 'wd-head', label: mainWork(lang).processExpand },
    lead,
    h('span', { class: 'wd-title', text: title }),
    h('span', {
      class: 'wd-meta',
      text: places.length ? secs(rec.ms) : `${mainWork(lang).stepCount(rec.count)} · ${secs(rec.ms)}`,
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

// ── Toast ──

/** Toast bar (onTap when it can be tapped, for example [Open screen]) */
let toastTap: (() => void) | undefined
function toast(text: string, onTap?: () => void) {
  mark(`toast ${text}`)
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

const tShell = shellText(lang)
const tChat = chatText(lang)
/** Answers whose folded earlier answers the user opened */
const openEarlier = new Set<string>()
const tSms = smsText(lang)
const tAppr = approvalText(lang)

function notify(title: string, body: string, tag?: string) {
  // Only while the app is in the background. The tag matches the push notification from the PC, so the two never double up
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

/** If notifications are allowed, subscribe to push with this PC's key and tell the PC */
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
    // Browsers that cannot get a notification address (e.g. iPhone Safari without Add to Home Screen)
  } finally {
    syncing = false
  }
}

/** If opened from a notification (#a=approval id, #t=chat), go to that screen */
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

// ── Pairing ──

async function startPairing(raw: string) {
  let invite: PairInvite
  try {
    invite = JSON.parse(new TextDecoder().decode(fromB64u(raw))) as PairInvite
  } catch {
    toast(tShell.qrInvalid)
    return
  }
  // If the invite is from the PC we are already connected to, keep the current connection (same link opened again)
  if (st.saved?.paired && st.saved.pcId === invite.pc) {
    history.replaceState(null, '', location.pathname)
    toast(tShell.alreadyPaired(st.saved.pcName ?? 'PC'))
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
  // Pairing request: carry this phone's X25519 public key in the header so the PC can derive the key
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
  if (/iPhone/.test(ua)) return tShell.devIphone
  if (/iPad/.test(ua)) return tShell.devIpad
  if (/Android/.test(ua)) return tShell.devAndroid
  return tShell.devPhone
}

// ── Screens ──

/** While viewing the bottom of the chat, stay at the bottom when new messages arrive */
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
 * When re-rendering for news from the PC: draw once per frame.
 * While a reply streams in, news arrives dozens of times a second, and drawing on each one rebuilt the whole screen that often
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
      // Keep the same remote screen as is (re-inserting it closes the keyboard)
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
  // After re-rendering: move the segment highlight and switch knob from the old spot to the new one
  playSeg()
  playFlip()
}

function buildShell() {
  const top = h('header', { class: 'app-top' })
  const page = h('main', { class: 'app-page' })
  const chat = h('div', { class: 'chat-list' })
  // A date that floats on top while scrolling to show when the visible message was sent (fades when scrolling stops)
  const dayPill = h('div', { class: 'day-pill' })
  dayPill.setAttribute('aria-hidden', 'true')
  let dayPillTimer: ReturnType<typeof setTimeout> | undefined
  page.addEventListener(
    'scroll',
    () => {
      // The bottom tabs are not hidden on scroll: hidden, there was no visible way to other tabs (user feedback)
      if (st.tab === 'chat') {
        stickToBottom = page.scrollHeight - page.scrollTop - page.clientHeight < 80
        const label = dayAtTop(page, chat)
        dayPill.textContent = label
        dayPill.classList.toggle('on', !!label)
        clearTimeout(dayPillTimer)
        dayPillTimer = setTimeout(() => dayPill.classList.remove('on'), 1400)
      }
      // Feed and library: near the bottom, load the next page
      else if (page.scrollHeight - page.scrollTop - page.clientHeight < 600) visiblePager()?.more()
    },
    { passive: true },
  )
  const textarea = h('textarea')
  textarea.rows = 1
  textarea.placeholder = tShell.askPlaceholder
  textarea.setAttribute('aria-label', tShell.askLabel)
  textarea.addEventListener('input', () => {
    st.draft = textarea.value
    autosize(textarea)
    renderComposer()
  })
  textarea.addEventListener('keydown', (e) => {
    // Accept the continuation suggestion: Tab, or → at the end of the text
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
    { class: 'cbtn plus', label: tShell.more, onclick: () => openOverlay({ kind: 'plus' }) },
    icon('plus', 'i md'),
  )
  const sendBtn = h('button', { class: 'send-btn', label: tShell.send })
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
  const tabs = h('nav', { class: 'tabs app-tabs', label: tShell.tabsLabel })
  const overlay = h('div', { class: 'app-overlay' })
  const toast = h('div', { class: 'toast float-toast' })
  toast.setAttribute('role', 'status')
  app.replaceChildren(h('div', { class: 'app-shell' }, top, page, dayPill, composerBox, tabs, overlay, toast))
  shell = { top, page, chat, composerBox, textarea, sendBtn, tabs, overlay, toast }
  ghostEl = ghost
  pullToRefresh(page)
}

// ── Continuation suggestion: if what is typed matches the start of an idea, show the rest faded (tap or press Tab to accept) ──

let ghostEl: HTMLElement | undefined
let ghostRest = ''

function ghostFor(draft: string): string {
  return suggestRest({
    draft,
    talk: recentTalk(st.conv),
    mine: (st.life?.ideas ?? []).map((i) => i.text),
    catalog: ideaCatalog(st.services ?? [], lang).flatMap((g) => g.items.map((i) => i.ask)),
  })
}

function updateGhost() {
  const g = ghostEl
  const t = shell?.textarea
  if (!g || !t) return
  const rest = ghostFor(st.draft)
  // Only on one line: once the text wraps to two lines the letters no longer line up, so it is hidden
  const oneLine = t.scrollHeight <= Number.parseFloat(getComputedStyle(t).minHeight) + 2
  if (!rest || !oneLine) {
    ghostRest = ''
    g.hidden = true
    g.replaceChildren()
    return
  }
  if (rest === ghostRest && !g.hidden) return
  ghostRest = rest
  // Drawn on top with the same font and padding as the input
  matchTextBox(g, t)
  const typed = h('span', { class: 'ghost-typed', text: st.draft })
  const letters = [...rest].map((ch) => h('span', { class: 'g', text: ch }))
  const restEl = h('span', { class: 'ghost-rest', onclick: takeGhost }, ...letters)
  const key = h(
    'button',
    { class: 'ghost-key', label: tShell.ghostKey, onclick: takeGhost },
    icon('chevron', 'i'),
  )
  g.replaceChildren(typed, restEl, key)
  g.hidden = false
  // Fade the right edge only when it overflows (if it all fits, keep the last letter sharp)
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
  // The faded letters light up from the left with a pop, then are swapped for the real text
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

/** Input height: springs when lines are added or removed */
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
  mark(`tab ${tab}`)
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
  // Slide in from the side in tab order
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

/** Header: menu · Dool2 (what it is doing now) · my PC */
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
    ? tShell.pcConnecting
    : st.pcSilent
      ? tShell.pcSilent
      : waiting
        ? pendingApprovals().length
          ? tShell.waitApproval
          : tShell.waitLogin
        : st.busy || st.pending.length
          ? (st.steps.at(-1) ?? tShell.answering)
          : ''
  const pcOn = st.online && !st.pcSilent
  const pcName = shortPc(st.saved?.pcName)
  // Leave it alone if nothing changed. Rebuilding the buttons on every update while a reply streams in
  // made them vanish mid-tap, so the menu and Dool2 buttons sometimes could not be pressed
  const sig = [mood, status, waiting ? 1 : 0, pcOn ? 1 : 0, pcName].join('|')
  if (t.dataset.sig === sig && t.childElementCount) return
  t.dataset.sig = sig
  if (!t.childElementCount)
    t.replaceChildren(
      h(
        'button',
        { class: 'fbtn', label: tShell.menu, onclick: () => openOverlay({ kind: 'drawer' }) },
        icon('menu'),
      ),
      h(
        'button',
        { class: 'agent', label: tShell.openAgent, onclick: () => openOverlay({ kind: 'agent' }) },
        h('span', { class: 'agent-av' }),
        h('span', { class: 'agent-tag' }),
      ),
      h(
        'button',
        { class: 'fpill', label: tShell.myPc, onclick: () => setTab('settings') },
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
  // Status island: when the text changes, spring from the old size to the new one (width lands first, height follows); the text fades out and back in
  const old = t.querySelector<HTMLElement>('.agent-tag')
  if (!old || old.dataset.status === status) return
  const before = old.dataset.status !== undefined ? { w: old.offsetWidth, h: old.offsetHeight } : undefined
  const tag = h(
    'span',
    { class: 'agent-tag' },
    tShell.agentName,
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
  if (!name) return tShell.myPc
  return name.length > 8 ? `${name.slice(0, 7)}…` : name
}

function openOverlay(o: Overlay) {
  mark(o ? `open ${o.kind}` : 'close')
  // Closing the vault sheet clears any password that was shown
  if (o?.kind !== 'vault') st.vaultShown = undefined
  st.overlay = o
  render()
}

let pillStop: (() => void) | undefined
/** Number of steps of the current task already shown (only new steps animate) */
let shownSteps = 0

function renderTabs() {
  const t = shell?.tabs
  if (!t) return
  const waiting = pendingApprovals().length + pendingLogins().length
  const items: [Tab, IconName, string][] = [
    ['chat', 'chat', tShell.tabChat],
    ['feed', 'feed', tShell.tabFeed],
    ['ideas', 'idea', tShell.tabIdeas],
    ['goals', 'goal', tShell.tabGoals],
    ['library', 'library', tShell.tabLibrary],
  ]
  // Build the buttons once: rebuilding would cut the animation
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
  // On tablets the tab bar is a vertical bar on the left: the pill moves up and down
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
  // If the screen is mid-change and a cell has size 0, measure again next time
  if (!size(active)) return
  pill.style[P] = `${pos(active)}px`
  pill.style[S] = `${size(active)}px`
  t.dataset.ready = '1'
  if (!ready || !changed || reducedMotion()) return
  // Pill: the leading edge lands first and the trailing edge follows later, so it stretches and then shrinks while moving
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
  // The other tabs spring back into place; the chosen tab's icon squashes then pops, and its name floats up (reference values: bar 340 28, squash 520 14)
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
  // A line above the composer to reopen a waiting input card that was closed
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
    img.alt = tShell.photoToSend
    attachBox.replaceChildren(
      img,
      h(
        'button',
        {
          class: 'fbtn small',
          label: tShell.removePhoto,
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
  // Send <-> stop: the old icon spins and shrinks, and the new icon pops in
  const mode = stop ? 'stop' : 'send'
  if (sendBtn.dataset.mode !== mode) {
    const first = !sendBtn.dataset.mode
    sendBtn.dataset.mode = mode
    const ic = icon(mode, 'i md')
    sendBtn.replaceChildren(ic)
    if (!first)
      springTo(ic, [{ transform: `scale(0) rotate(${stop ? -90 : 90}deg)` }, { transform: 'none' }], 'morph')
  }
  sendBtn.setAttribute('aria-label', stop ? tShell.stop : tShell.send)
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
    // (If the user went to another tab meanwhile, do not scroll that tab to the end)
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
  // Do not touch it if the shape is unchanged. Re-inserting the whole tab on every news item from the PC
  // makes the picture flicker and drops the cursor and keyboard of text typed in the search box
  const drawn = `${st.tab}\n${view.outerHTML}`
  if (drawn === pageDrawn && page.firstChild && page.firstChild !== chat) return
  pageDrawn = drawn
  const y = page.scrollTop
  const typing = typingIn(page)
  page.replaceChildren(view)
  page.scrollTop = y
  typing?.()
}

/** Shape of the tab screen drawn last (the chat tab syncs only changed messages separately) */
let pageDrawn = ''

/** When a tab screen redraws part of itself (search): remember the current shape (so the next news does not re-insert it whole) */
function pageSettled() {
  const view = shell?.page.firstElementChild
  if (view && st.tab !== 'chat') pageDrawn = `${st.tab}\n${view.outerHTML}`
}

/**
 * Before re-rendering: if the user is typing inside, remember the text and cursor and give them back to the new field.
 * (Only fields with an id. If the new field was drawn with a value already, keep that value)
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
      // So things drawn from a field (the verification code box) follow along
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

/** Cursor position (asking an email or number field throws an error) */
function safeCaret(el: HTMLInputElement | HTMLTextAreaElement): number | null {
  try {
    return el.selectionStart
  } catch {
    return null
  }
}

// ── Chat: only changed messages ──

/** What the user said after record i (including a message being sent). undefined if none */
function saidAfter(i: number): string | undefined {
  for (const m of st.conv.slice(i + 1)) if (m.role === 'user') return readAppNote(m.text) ?? m.text
  return st.pending[0]?.text
}

/** What result blocks (quick replies, list rows, result card, draft to send) use: send a message, open an outside link, photos, copy */
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

/** Open in the browser outside the app (or that service's app) */
function openOutside(url: string) {
  try {
    mark(`open external ${new URL(url).host}`)
  } catch {}
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.click()
}

/** Date of the message at the top of the screen. Empty if that day's date line is still visible, so they do not overlap */
function dayAtTop(page: HTMLElement, chat: HTMLElement): string {
  const top = page.getBoundingClientRect().top + 120
  let label = ''
  for (const sep of chat.querySelectorAll<HTMLElement>(':scope > .day-sep')) {
    const y = sep.getBoundingClientRect().top
    if (y > top) {
      // If the next date line has scrolled up right under the floating date, hide the floating one
      if (y < top + 36) return ''
      break
    }
    label = sep.textContent ?? ''
  }
  return label
}

/** Date key (YYYY-M-D in this phone's time zone) */
function dayKey(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** Date line text: Today · Yesterday · Thursday, November 20 (with the year if not this year) */
function dayLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const key = dayKey(iso)
  if (key === dayKey(now.toISOString())) return tChat.today
  if (key === dayKey(new Date(now.getTime() - 86_400_000).toISOString())) return tChat.yesterday
  return d.toLocaleDateString(tChat.locale, {
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
}

/** Time beside a bubble (6:14 PM). If the same person kept talking in the same minute, only on the last bubble */
function bubbleTime(i: number): string {
  const m = st.conv[i]
  if (!m) return ''
  const minute = (iso: string) => iso.slice(0, 16)
  const next = st.conv[i + 1]
  if (
    next &&
    next.role === m.role &&
    minute(next.createdAt) === minute(m.createdAt) &&
    (m.role !== 'user' || readAppNote(next.text) === undefined)
  )
    return ''
  const d = new Date(m.createdAt)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(tChat.locale, { hour: 'numeric', minute: '2-digit' })
}

/** What the chat list should contain (key, signature, build). Unchanged if the signature is the same */
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
          text: tChat.earlier,
          onclick: () => void send({ kind: 'conversation', before: first.createdAt }),
        }),
    })
  if (st.convLoaded && !st.conv.length && !st.pending.length)
    items.push({ key: 'hello', sig: st.saved?.pcName ?? '', make: helloCard })
  let lastNote = ''
  let lastDay = ''
  const superseded = oldConnectCards()
  // One answer per request: answers the finish check sent back and replaced are folded (open with "show earlier answers")
  const fold = interimAnswers(st.conv, { running: st.busy })
  // The answer being checked or continued stays in the progress card as a draft, never as a message first (ADR 0027)
  const progress = finishProgress(st.conv, { running: st.busy, checking: st.checking })
  if (progress?.draft) fold.hidden.add(progress.draft)
  const revealed = new Set([...fold.replaced].filter(([f]) => openEarlier.has(f)).flatMap(([, ids]) => ids))
  const roleOf = new Map(st.conv.map((m) => [m.id, m.role]))
  for (const [i, m] of st.conv.entries()) {
    if (fold.hidden.has(m.id) && !revealed.has(m.id)) continue
    const earlier = fold.replaced.get(m.id)
    if (earlier) {
      const n = earlier.filter((id) => roleOf.get(id) === 'assistant').length
      const open = openEarlier.has(m.id)
      items.push({
        key: `earlier:${m.id}`,
        sig: open ? '1' : '0',
        make: () =>
          h('button', {
            class: 'btn-text earlier-answers',
            text: open ? tChat.hideEarlierAnswers : tChat.showEarlierAnswers(n),
            onclick: () => {
              if (open) openEarlier.delete(m.id)
              else openEarlier.add(m.id)
              render()
            },
          }),
      })
    }
    // If the same notice was recorded several times in a row (old records), show only one
    const noteText = m.role !== 'assistant' && m.role !== 'tool' ? readAppNote(m.text) : undefined
    if (noteText !== undefined && noteText === lastNote) continue
    lastNote = noteText ?? ''
    // When the day changes, a date line in the middle (while scrolling, the floating date follows)
    const day = dayKey(m.createdAt)
    if (day && day !== lastDay) {
      lastDay = day
      const label = dayLabel(m.createdAt)
      items.push({ key: `day:${day}`, sig: label, make: () => h('p', { class: 'day-sep', text: label }) })
    }
    if (m.role === 'tool') {
      // If there are several connect cards for the same service, only the last stays live (earlier ones collapse to one line)
      const old = superseded.has(m.id)
      // Quick replies and multi-select need to know what the user said next, to draw faded and locked
      const used = /"kind":"quick"|"pick":"multi"/.test(m.text) ? saidAfter(i) : undefined
      items.push({
        key: m.id,
        sig: `${old ? 'old:' : ''}${toolSig(m.text)}:${st.services ? 1 : 0}:${used ?? ''}`,
        make: () => toolCard(m.text, !old, used),
      })
    } else if (m.role === 'user') {
      // Notices the Dool2 app sent to the AI (approval results, etc.) are not my words, so show them as a small centered line
      const note = readAppNote(m.text)
      const time = note === undefined ? bubbleTime(i) : ''
      items.push({
        key: m.id,
        sig: time,
        make: () => {
          if (note !== undefined) return h('p', { class: 'msg note' }, note)
          const b = meBubble(m.text)
          if (time) b.dataset.time = time
          return b
        },
      })
    } else if (m.role === 'assistant') {
      const time = bubbleTime(i)
      items.push({
        key: m.id,
        sig: time,
        make: () => {
          const b = h('div', { class: 'bubble rich' })
          b.append(rich(m.text))
          if (time) b.dataset.time = time
          onLongPress(b, () => openOverlay({ kind: 'msg', id: m.id }))
          // For a reply that just arrived, money and percentages roll into place (loaded older chat stays as is)
          if (Date.now() - Date.parse(m.createdAt) < 60_000) rollNumbers(b)
          return b
        },
      })
    } else {
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
          h('span', { class: 'meta', text: tChat.continued }),
        ),
    })
  })
  if (st.busy || st.pending.length) {
    const shot = st.work.web && st.busy && st.work.tabId !== undefined && st.work.shot
    // The work process is one card: the screen being viewed + steps (like the landing page's "Looking at ...")
    // While the answer is a draft (being written after tools, checked, or continued) it lives in this card too
    const card = st.busy && (st.steps.length || shot || progress)
    if (card) items.push({ key: 'work', sig: '', make: workPanel })
    // Until the reply text starts streaming, keep "•••" under the work card too, so it feels like it is writing (user request, 11-22)
    if (st.live && !card) items.push({ key: 'live', sig: '', make: liveBubble })
    else if (!progress && !st.live)
      items.push({
        key: 'typing',
        sig: '',
        make: thinkingDots,
      })
  }
  return items
}

/** My bubble: if a photo was sent, the photo (right after sending) or a "Photo" chip */
function meBubble(raw: string, photo?: string, cls = 'bubble me') {
  const { text, photo: name } = splitPhoto(raw)
  const b = h('div', { class: `${cls}${photo || name ? ' with-photo' : ''}` })
  if (photo) {
    const img = h('img', { class: 'sent-photo' })
    img.src = `data:image/jpeg;base64,${photo}`
    img.alt = tChat.photoSent
    b.append(img)
  } else if (name) {
    // Photos from earlier messages or other devices: ask the PC and show them (a "Photo" chip before they arrive or if they fail)
    const chip = h('span', { class: 'photo-chip' }, icon('image', 'i'), tChat.photo)
    b.append(chip)
    void thumbOf(`photo:${name}`).then((data) => {
      if (!data) return
      const img = h('img', { class: 'sent-photo' })
      img.src = data
      img.alt = tChat.photoSent
      chip.replaceWith(img)
    })
  }
  if (text) b.append(h('span', { text }))
  return b
}

/** Long press (phone) · right click (desktop browser) */
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

/** Thinking: three dots bounce in turn and stretch into each other with a gooey filter */
function thinkingDots() {
  gooFilter()
  return h(
    'span',
    { class: 'typing goo', label: tChat.thinking },
    h('span', { class: 'goo-dots' }, h('i'), h('i'), h('i')),
  )
}

function liveBubble() {
  const b = h('div', { class: 'bubble rich streaming' })
  b.append(rich(dropEnglishLines(st.live, lang)))
  riseWords(b)
  return b
}

/**
 * Streaming reply: only newly arrived words float up from below and sharpen.
 * Words are wrapped on every redraw, and only those after the count of words already shown move
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
      // A streaming reply only swaps the text
      el.replaceChildren(rich(dropEnglishLines(st.live, lang)))
      riseWords(el)
    } else if (el && it.key === 'work') {
      // The work card only appends new steps (leaving the current screen picture as is)
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

/** When the PC is not answering: the reason and what to do, instead of a blank screen */
function silentCard() {
  const pc = st.saved?.pcName ?? 'PC'
  return h(
    'div',
    { class: 'card ask-card silent-card' },
    h('div', { class: 'card-label' }, doori('sleeping', 22), tChat.pcSilentTitle(pc)),
    h('p', {
      class: 'card-text',
      text: tChat.pcSilentBody,
    }),
    h(
      'div',
      { class: 'approve-actions' },
      h('button', { class: 'btn-ghost', text: tChat.retry, onclick: () => connect() }),
      h('button', { class: 'btn', text: tChat.reconnect, onclick: () => void forgetPc() }),
    ),
  )
}

function helloCard() {
  return h(
    'div',
    { class: 'hello' },
    h('div', { class: 'bubble', text: tChat.hello(st.saved?.pcName ?? tShell.myPc) }),
    h('div', {
      class: 'bubble',
      text: tChat.helloBody,
    }),
    h(
      'div',
      { class: 'quick' },
      ...[tChat.quick1, tChat.quick2, tChat.quick3].map((q) =>
        h('button', { text: q, onclick: () => ask(q) }),
      ),
    ),
    h(
      'div',
      { class: 'card start-card' },
      h('strong', { text: tChat.startTitle }),
      ...(
        [
          ['apps', '1', tChat.start1, () => setTab('connect')],
          ['feed', '2', tChat.start2, () => setTab('feed')],
          ['goal', '3', tChat.start3, () => setTab('goals')],
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
      // Also include the payment method, card and installments chosen on the approval card. Without them, tapping a chip did not redraw the card and the choice did not change (measured)
      const picked = a
        ? [...st.choice]
            .filter(([k]) => k === a.id || k.startsWith(`${a.id}:`))
            .map(([k, v]) => `${k}=${v}`)
            .join(',')
        : ''
      // Text card: also the recipient search result, the chosen person and the error (leave out the number being typed, or the field is redrawn and typing breaks)
      const sms = a && isSms(a) ? smsStates.get(a.id) : undefined
      const smsSig = sms ? `${sms.state}:${sms.people.length}:${sms.pick}:${sms.error ?? ''}` : ''
      return `${a?.id}:${a?.status}:${a ? (st.decided.get(a.id)?.message ?? '') : ''}:${picked}:${smsSig}`
    }
    if (rec.kind === 'login') {
      const l = loginFor(rec as LoginRecordMessage)
      const link = l ? loginLink(l.origin) : undefined
      const steps = link ? (st.connectSteps.get(link.cid)?.length ?? 0) : 0
      const agent = link?.fail && agentOn(link.fail) ? 'agent' : ''
      return `${l?.id}:${l?.status}:${link?.busy ?? ''}:${link?.fail?.reason ?? ''}:${agent}:${steps}`
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
      // Whether that service's ID and password card is showing (the connect card points to it)
      const login = it
        ? ([...st.logins.values()].find((l) => l.status === 'pending' && cardIdFor(l.origin) === it.card.id)
            ?.id ?? '')
        : ''
      return `${it?.card.id}:${it?.connectedAt ?? ''}:${it && st.connecting.has(it.card.id)}:${steps}:${wait}:${fail}:${peek}:${login}`
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

/** Cards that have another connect card for the same service after them (message ids) */
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
  const block = blockView(rec as { kind?: string }, blockEnv, used, lang)
  if (block) return block
  if (rec.kind === 'approval') return approvalInline(rec)
  if (rec.kind === 'login') return loginInline(rec)
  if (rec.kind === 'connect') return connectInline(rec, live)
  if (rec.kind === 'work') return workDone(rec)
  if ((rec as { kind?: string }).kind === 'left') return leftInline(rec as unknown as LeftRecordMessage, live)
  if (rec.kind === 'tell') return tellInline(rec)
  if (rec.kind === 'cards') return cardsInline(rec)
  if ((rec as { kind?: string }).kind === 'made') return madeInline(rec as unknown as MadeImageRecordMessage)
  // Your turn
  const tabId = rec.tabId
  return h(
    'div',
    { class: 'card ask-card' },
    h('div', { class: 'card-label' }, doori('asking', 22), tChat.handTitle),
    h('p', { class: 'card-text', text: rec.reason }),
    tabId !== undefined &&
      h('button', { class: 'btn-ghost', text: tChat.openPc, onclick: () => openRemote(tabId) }),
  )
}

/** What the before-finishing check left at its limit, with [Continue] (only until the next message) */
function leftInline(rec: LeftRecordMessage, live: boolean): HTMLElement {
  const go = h('button', {
    class: 'btn-ghost sm',
    text: tChat.continueLeft,
    onclick: () => {
      go.setAttribute('disabled', '')
      void send({ kind: 'conversation-continue' })
    },
  })
  if (!live || st.busy) go.setAttribute('disabled', '')
  return h(
    'div',
    { class: 'card quiet left-card' },
    h('div', { class: 'card-label', text: tChat.leftTitle }),
    h('p', { text: rec.why }),
    go,
  )
}

/** Approval card in the chat: what · how much · [Decline][Approve] */
// ── Sending a text (from my own number) ─────────────────────────────
// The PC (Dool2) sends only the recipient's name and the text. This phone finds the number in contacts and never sends it out.
// When the user holds to approve, this phone sends it right away (no other app opens), then tells the PC the result, then the approval signature

/** What this app can do (so the PC knows whether it may hand off texting) */
const capsReady: Promise<PhoneCap[]> = smsAvailable().then((ok) => (ok ? ['sms'] : []))
function hello() {
  void capsReady.then((caps) => send({ kind: 'hello', caps }))
}

interface SmsState {
  state: 'finding' | 'found' | 'none' | 'denied'
  people: SmsPerson[]
  pick: number
  manual: string
  error?: string
}
const smsStates = new Map<string, SmsState>()
const isSms = (a: ApprovalView) => a.url.startsWith('sms:')
const smsTo = (a: ApprovalView) => a.url.slice(4)
/** If it looks like a number (8 or more digits), use it as is without searching contacts */
const phoneLike = (v: string) => v.replace(/[^0-9]/g, '').length >= 8 && /^[0-9+\-\s().]+$/.test(v)
const maskNumber = (n: string) => {
  const d = n.replace(/[^0-9]/g, '')
  return d.length >= 8 ? `${d.slice(0, 3)}-****-${d.slice(-4)}` : n
}
const showNumber = (n: string) => {
  const d = n.replace(/[^0-9]/g, '')
  return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : n
}

function smsState(a: ApprovalView): SmsState {
  let s = smsStates.get(a.id)
  if (s) return s
  const to = smsTo(a)
  if (phoneLike(to)) {
    s = { state: 'found', people: [{ name: '', number: to, label: '' }], pick: 0, manual: '' }
    smsStates.set(a.id, s)
    autoSendSms(a, s)
    return s
  }
  s = { state: 'finding', people: [], pick: 0, manual: '' }
  smsStates.set(a.id, s)
  const mine = s
  // When the card first shows, ask for contacts and text permission at once, then search
  void smsPermissions()
    // Search without the Korean honorific suffix (see region/kr/main-b-approval.ts)
    .then(() => smsFind(to.replace(HONORIFIC_RE, '').trim()))
    .then((r) => {
      mine.people = r.people
      mine.state = r.denied ? 'denied' : r.people.length ? 'found' : 'none'
      autoSendSms(a, mine)
      render()
    })
  return s
}

/**
 * Auto-approve (ADR 0030): a text flagged auto is sent without the long press once the recipient is clear (one
 * match or a number). Several matches or none still wait for the user on the card
 */
const autoSent = new Set<string>()
function autoSendSms(a: ApprovalView, s: SmsState) {
  if (!a.auto || a.status !== 'pending' || autoSent.has(a.id)) return
  if (s.state !== 'found' || s.people.length !== 1) return
  autoSent.add(a.id)
  mark('sms auto-send')
  void sendSms(a)
    .then(() => markDecided(a, 'approve'))
    .catch(() => render())
}

/** Number to send to and the recipient's name (undefined if not decided) */
function smsTarget(s: SmsState): { name: string; number: string } | undefined {
  if (s.manual.replace(/[^0-9]/g, '').length >= 8) return { name: '', number: s.manual }
  const p = s.state === 'found' ? s.people[s.pick] : undefined
  return p ? { name: p.name, number: p.number } : undefined
}

/** Text plugin failure code -> message for the user */
function smsWhy(reason?: string, detail?: string): string {
  switch (reason) {
    case 'denied':
      return tSms.denied
    case 'bad':
      return tSms.bad
    case 'no-phone':
      return tSms.noPhone
    case 'no-service':
      return tSms.noSignal
    case 'radio-off':
      return tSms.airplane
    case 'carrier':
      return tSms.carrier(detail)
    case 'timeout':
      return tSms.timeout
    default:
      return detail ? tSms.failedWith(detail) : tSms.unknown
  }
}

async function sendSms(a: ApprovalView) {
  const s = smsState(a)
  const t = smsTarget(s)
  if (!t) {
    s.error = tSms.pickNumber
    render()
    throw new Error(s.error)
  }
  if (Date.parse(a.expiresAt) <= Date.now()) {
    s.error = tSms.expired
    render()
    throw new Error(s.error)
  }
  s.error = undefined
  if (!(await smsPermissions()).sms) {
    s.error = tSms.needPerm
    render()
    throw new Error(s.error)
  }
  const r = await smsSend(t.number, a.what)
  const who = t.name ? `${t.name}(${maskNumber(t.number)})` : maskNumber(t.number)
  const message = r.ok ? tSms.sent(who) : tSms.notSent(who, smsWhy(r.reason, r.message))
  // Result first, then the approval signature (the PC records this result as final only when the signature is valid)
  await send({ kind: 'sms-result', id: a.id, ok: r.ok, message })
  await decide(a, 'approve', true)
  if (!r.ok) toast(message)
}

function smsCard(a: ApprovalView, big = false): HTMLElement {
  const s = smsState(a)
  const to = smsTo(a)
  const who = h('div', { class: 'approve-choices sms-to' })
  const label = (t: string) => h('span', { class: 'meta', text: t })
  if (s.state === 'finding') who.append(label(tSms.finding(to)))
  else if (s.state === 'found' && s.people.length === 1) {
    const p = s.people[0] as SmsPerson
    who.append(
      label(tSms.to),
      h('strong', { text: [p.name, showNumber(p.number)].filter(Boolean).join(' · ') }),
      ...(p.label ? [h('span', { class: 'meta', text: p.label })] : []),
    )
  } else if (s.state === 'found') {
    who.append(
      label(tSms.many(to)),
      h(
        'div',
        { class: 'choice-list' },
        ...s.people.map((p, i) =>
          h('button', {
            class: `chip${i === s.pick && !s.manual ? ' on' : ''}`,
            text: `${p.name} · ${p.number.replace(/[^0-9]/g, '').slice(-4)}`,
            onclick: () => {
              s.pick = i
              s.manual = ''
              render()
            },
          }),
        ),
      ),
    )
  }
  if (s.state === 'none' || s.state === 'denied') {
    who.append(label(s.state === 'denied' ? tSms.noAccess(to) : tSms.notFound(to)))
    const input = h('input', { class: 'field' }) as HTMLInputElement
    input.type = 'tel'
    input.inputMode = 'tel'
    input.placeholder = '010-0000-0000'
    input.value = s.manual
    input.oninput = () => {
      s.manual = input.value.trim().slice(0, 20)
    }
    who.append(input)
  }
  return h(
    'div',
    { class: `card approve-card sms-card${big ? ' big' : ''}` },
    h(
      'div',
      { class: 'approve-head' },
      h('span', { class: 'tile amber' }, icon('mail', 'i md')),
      h('div', {}, h('strong', { text: tSms.askTitle }), h('span', { class: 'meta', text: tSms.askMeta })),
    ),
    heldLine(a),
    who,
    h('p', { class: 'approve-what sms-text', text: a.what }),
    s.error ? h('p', { class: 'field-err', text: s.error }) : undefined,
    h(
      'div',
      { class: 'approve-actions' },
      h('button', { class: 'btn-ghost', text: tAppr.reject, onclick: () => void decide(a, 'reject') }),
      holdButton({
        label: tSms.hold,
        done: tSms.done,
        cls: 'btn btn-approve',
        onDone: () => sendSms(a),
        after: () => markDecided(a, 'approve'),
      }),
    ),
  )
}

/** Why auto-approve sent this one as a card (ADR 0030 amendment). Nothing when it was a normal request */
function heldLine(a: ApprovalView): HTMLElement | undefined {
  if (!a.held) return undefined
  return h('p', {
    class: 'approve-held',
    text: a.held === 'unrelated' ? tAppr.heldUnrelated : tAppr.heldUnchecked,
  })
}

function approvalInline(rec: ApprovalRecordMessage): HTMLElement {
  const a = approvalFor(rec)
  const decided = a ? st.decided.get(a.id) : undefined
  if (!a || a.status !== 'pending' || decided) {
    // Once decided, one line: Approved · 15,900 won · Jeju tangerines 3kg, buy now
    const what = a?.what || rec.what || tAppr.request
    const failed = (decided && !decided.ok) || a?.status === 'failed'
    const sms = a ? isSms(a) : rec.ref === 'sms'
    const head = failed
      ? sms
        ? tAppr.notSent
        : tAppr.notTapped
      : a?.status === 'rejected'
        ? tAppr.rejected
        : a?.status === 'expired'
          ? tAppr.expired
          : a?.auto && !sms
            ? tAppr.autoDone
            : a || decided
              ? sms
                ? tAppr.sent
                : tAppr.approved
              : ''
    return h(
      'p',
      { class: `done-line${failed ? ' warn' : ''}` },
      icon(failed || a?.status === 'rejected' ? 'close' : 'check'),
      [head, a?.amount, failed ? (decided?.message ?? what) : what].filter(Boolean).join(' · '),
    )
  }
  if (a.kind === 'money') return checkoutCard(a)
  if (isSms(a)) return smsCard(a)
  const tone: IconName = a.kind === 'contact' ? 'mail' : 'hand'
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
    heldLine(a),
    a.amount && h('p', { class: 'approve-amount', text: a.amount }),
    h('p', { class: 'approve-what', text: a.what }),
    itemsList(a, 5),
    choseRow(a),
    shipRow(a),
    choiceRow(a),
    h(
      'div',
      { class: 'approve-actions' },
      h('button', { class: 'btn-ghost', text: tAppr.reject, onclick: () => void decide(a, 'reject') }),
      holdButton({
        label: tAppr.holdApprove,
        done: tAppr.approved,
        cls: 'btn btn-approve',
        onDone: () => decide(a, 'approve', true),
        after: () => markDecided(a, 'approve'),
      }),
    ),
    h('button', {
      class: 'btn-link',
      text: tAppr.viewScreen,
      onclick: () => openOverlay({ kind: 'approval', id: a.id }),
    }),
  )
}

/**
 * Checkout card (user mockup, 11-20): the same frame for every payment. Shop, goods, amount, delivery address, payment method, info rows, and a big pay button at the bottom.
 * Tapping a whole delivery or payment row opens a picker sheet. Approval happens once, on this card
 */
function checkoutCard(a: ApprovalView & { shot?: string }, inSheet = false): HTMLElement {
  const host = hostOf(a.url)
  const name = a.where || host
  // One arrival or usage time goes in the header line (not repeated in the row list)
  const when = (a.info ?? []).find((x) => WHEN_LABEL_RE.test(x.label))
  const head = h(
    'div',
    { class: 'co-head' },
    withLogo(h('span', { class: 'svc-mark lg', text: [...name][0] ?? '' }), cardIdFor(a.url)),
    h(
      'div',
      { class: 'co-head-t' },
      h('strong', { text: a.title || name }),
      h('span', {
        class: 'meta',
        text: [a.title ? name : host, when?.value].filter(Boolean).join(' · '),
      }),
    ),
  )
  const goods = (a.goods ?? []).length
    ? h(
        'div',
        { class: 'co-goods' },
        ...(a.goods ?? []).map((g) => {
          const th = h('span', { class: 'co-th' }, icon('box', 'i'))
          if (g.image)
            void thumbOf(g.image).then((data) => {
              if (!data) return
              const img = h('img', { class: 'co-th' }) as HTMLImageElement
              img.src = data
              img.alt = ''
              th.replaceWith(img)
            })
          return h(
            'div',
            { class: 'co-good' },
            th,
            h(
              'div',
              { class: 'co-good-t' },
              h('span', { class: 'co-nm', text: g.name }),
              ...(g.option || g.qty
                ? [h('span', { class: 'meta', text: [g.option, g.qty].filter(Boolean).join(' · ') })]
                : []),
            ),
            ...(g.price ? [h('span', { class: 'co-pr', text: g.price })] : []),
          )
        }),
      )
    : h('p', { class: 'co-what', text: a.what })
  const amount = h(
    'div',
    { class: 'co-amt' },
    ...(a.lines ?? []).map((l) =>
      h(
        'div',
        { class: `co-ln${l.kind === 'discount' ? ' minus' : ''}` },
        h('span', { text: l.label }),
        h('span', { text: l.value }),
      ),
    ),
    ...(a.amount
      ? [h('div', { class: 'co-tot' }, h('span', { text: tAppr.total }), h('b', { text: a.amount }))]
      : []),
  )
  const row = (ic: IconName, k: string, v: string, onclick?: () => void, warn = false) =>
    h(
      onclick ? 'button' : 'div',
      { class: `co-row${warn ? ' warn' : ''}${onclick ? ' tap' : ''}`, ...(onclick ? { onclick } : {}) },
      icon(ic, 'i co-ic'),
      h(
        'span',
        { class: 'co-row-t' },
        h('span', { class: 'co-k', text: k }),
        h('span', { class: 'co-v', text: v }),
      ),
      ...(onclick ? [icon('chevron', 'i co-chev')] : []),
    )
  const rows: HTMLElement[] = []
  const ship = shipChosenOf(a)
  if (a.shipOptions?.length) {
    const cur = ship?.startsWith('n:')
      ? tAppr.newAddr(decodeURIComponent(ship.slice(2)))
      : (a.shipOptions.find((o) => o.id === ship) ?? a.shipOptions[0])?.label.replace(
          MY_ADDRESS_PREFIX_RE,
          '',
        )
    const warn = Boolean(a.shipWarn) && (ship ?? 'a0') === 'a0'
    rows.push(
      row(
        'place',
        warn ? tAppr.shipWarn : tAppr.ship,
        cur ?? '',
        () => openOverlay({ kind: 'pick-ship', id: a.id, back: inSheet }),
        warn,
      ),
    )
  }
  for (const x of a.info ?? []) {
    if (x === when) continue
    const ic: IconName = REQUEST_LABEL_RE.test(x.label)
      ? 'chat'
      : TIME_LABEL_RE.test(x.label)
        ? 'clock'
        : PEOPLE_LABEL_RE.test(x.label)
          ? 'users'
          : TICKET_LABEL_RE.test(x.label)
            ? 'ticket'
            : 'note'
    rows.push(row(ic, x.label, x.value))
  }
  if (a.choices?.length || subsFor(a).length) {
    const main = a.choices?.find((c) => c.id === chosenOf(a))
    const subs = subsFor(a)
      .map((g) => g.options.find((o) => o.id === subChosenOf(a, g))?.label ?? '')
      .filter(Boolean)
    rows.push(
      row(
        'card',
        a.choiceTitle ?? tAppr.payMethod,
        [main?.label, ...subs].filter(Boolean).join(' · ') || tAppr.choose,
        () => openOverlay({ kind: 'pick-pay', id: a.id, back: inSheet }),
      ),
    )
  }
  const fine = [a.cancel, a.chose?.length ? tAppr.chose(a.chose.join(' · ')) : ''].filter(Boolean).join(' · ')
  const shot =
    inSheet && a.shot
      ? (() => {
          const img = h('img', { class: 'sheet-shot' }) as HTMLImageElement
          img.alt = tAppr.pcScreenAlt
          img.src = `data:image/jpeg;base64,${a.shot}`
          return h(
            'details',
            { class: 'co-shot' },
            h('summary', { class: 'meta', text: tAppr.viewPcCheckout }),
            img,
          )
        })()
      : undefined
  return h(
    'div',
    { class: `card co-card${inSheet ? ' in-sheet' : ''}` },
    head,
    goods,
    amount,
    ...(rows.length ? [h('div', { class: 'co-rows' }, ...rows)] : []),
    ...(fine ? [h('p', { class: 'co-fine', text: fine })] : []),
    ...(shot ? [shot] : []),
    h(
      'div',
      { class: 'co-actions' },
      h('button', { class: 'btn-ghost', text: tAppr.reject, onclick: () => void decide(a, 'reject') }),
      holdButton({
        label: tAppr.holdPay(a.amount),
        done: tAppr.approved,
        cls: 'btn btn-approve',
        onDone: () => decide(a, 'approve', true),
        after: () => markDecided(a, 'approve'),
      }),
    ),
    h('p', { class: 'co-lock' }, icon('lock', 'i'), tAppr.afterNote(a.after)),
    ...(inSheet
      ? []
      : [
          h('button', {
            class: 'btn-link',
            text: tAppr.viewPcCheckout,
            onclick: () => openOverlay({ kind: 'approval', id: a.id }),
          }),
        ]),
  )
}

/** Delivery address picker sheet: address on screen, saved address, my info address, new address */
function shipPicker(id: string, back = false): HTMLElement {
  const a = st.approvals.get(id)
  const sheet = h('section', { class: 'sheet float app-sheet rise pick-sheet' })
  if (!a?.shipOptions?.length) return sheet
  const key = `${a.id}:ship`
  const now = shipChosenOf(a) ?? 'a0'
  const isNew = now.startsWith('n:')
  const input = h('input', { class: 'field' }) as HTMLInputElement
  input.placeholder = tAppr.addrPlaceholder
  input.value = isNew ? decodeURIComponent(now.slice(2)) : ''
  const opt = (
    on: boolean,
    title: string,
    sub: string | undefined,
    tag: string | undefined,
    pick: () => void,
    extra?: HTMLElement,
  ) =>
    h(
      'button',
      { class: `pick-opt${on ? ' on' : ''}`, onclick: pick },
      h('span', { class: 'pick-radio' }),
      h(
        'span',
        { class: 'pick-t' },
        h(
          'span',
          { class: 'pick-name' },
          title,
          ...(tag ? [h('span', { class: 'pick-tag', text: tag })] : []),
        ),
        ...(sub ? [h('span', { class: 'meta', text: sub })] : []),
        ...(extra ? [extra] : []),
      ),
    )
  sheet.append(
    h('h3', { class: 'title-2', text: tAppr.whereTitle }),
    ...(a.shipWarn ? [h('p', { class: 'field-err', text: `⚠ ${a.shipWarn}` })] : []),
    ...a.shipOptions.map((o, i) => {
      const mine = o.label.startsWith(MY_ADDRESS_PREFIX)
      return opt(
        now === o.id,
        mine ? tAppr.home : i === 0 ? tAppr.screenAddr : tAppr.savedAddr,
        o.label.replace(MY_ADDRESS_PREFIX_RE, ''),
        mine ? tAppr.myInfo : undefined,
        () => {
          st.choice.set(key, o.id)
          render()
        },
      )
    }),
    opt(
      isNew,
      tAppr.newAddrBtn,
      undefined,
      undefined,
      () => {
        if (!isNew) st.choice.set(key, 'n:')
        render()
        queueMicrotask(() => document.querySelector<HTMLInputElement>('.pick-sheet .field')?.focus())
      },
      isNew ? input : undefined,
    ),
    h('button', {
      class: 'btn lg',
      text: tAppr.useAddr,
      onclick: () => {
        if (isNew) {
          const v = input.value.trim()
          if (!v) return toast(tAppr.enterAddr)
          st.choice.set(key, `n:${encodeURIComponent(v.slice(0, 100))}`)
        }
        // If opened from the checkout sheet, go back to that card
        openOverlay(back ? { kind: 'approval', id } : undefined)
      },
    }),
  )
  return sheet
}

/** Payment method picker sheet: one row per method, with card and installments inside the chosen method as select boxes */
function payPicker(id: string, back = false): HTMLElement {
  const a = st.approvals.get(id)
  const sheet = h('section', { class: 'sheet float app-sheet rise pick-sheet' })
  if (!a) return sheet
  const main = chosenOf(a)
  const groups = (forMain: string | undefined) =>
    (a.subChoices ?? []).filter((g) => !g.when || !forMain || g.when === forMain)
  const subsOf = (forMain: string | undefined) =>
    groups(forMain).map((g) => {
      const sel = h('select', { class: 'field select-field' }) as HTMLSelectElement
      for (const o of g.options) {
        const el = document.createElement('option')
        el.value = o.id
        el.textContent = o.label
        if (o.id === subChosenOf(a, g)) el.selected = true
        sel.append(el)
      }
      sel.onclick = (e) => e.stopPropagation()
      sel.onchange = () => {
        st.choice.set(`${a.id}:${g.key}`, sel.value)
        render()
      }
      return h('label', { class: 'pick-sub' }, h('span', { class: 'meta', text: g.title }), sel)
    })
  const list = a.choices?.length ? a.choices : [{ id: '', label: mCards.nowPayMethod }]
  sheet.append(
    h('h3', { class: 'title-2', text: mCards.howToPay }),
    ...list.map((c) =>
      h(
        'button',
        {
          class: `pick-opt${c.id === (main ?? '') ? ' on' : ''}`,
          onclick: () => {
            if (c.id) st.choice.set(a.id, c.id)
            render()
          },
        },
        h('span', { class: 'pick-radio' }),
        h(
          'span',
          { class: 'pick-t' },
          h(
            'span',
            { class: 'pick-name' },
            c.label,
            ...(c.mine ? [h('span', { class: 'pick-tag', text: mCards.myPayMethod })] : []),
          ),
          ...(c.id === (main ?? '') ? subsOf(c.id || undefined) : []),
        ),
      ),
    ),
    h('button', {
      class: 'btn lg',
      text: mCards.useThis,
      onclick: () => openOverlay(back ? { kind: 'approval', id } : undefined),
    }),
  )
  return sheet
}

const mCards = mainCCards(lang)

/** Items to approve (PC file moves and prints): the first max lines and how many are left */
function itemsList(a: ApprovalView, max: number): HTMLElement | undefined {
  if (!a.items?.length) return undefined
  return h(
    'ul',
    { class: 'approve-items' },
    ...a.items.slice(0, max).map((line) => h('li', { text: line })),
    ...(a.items.length > max
      ? [h('li', { class: 'meta', text: mCards.moreItems(a.items.length - max) })]
      : []),
  )
}

function approveQuestion(a: ApprovalView) {
  if (a.kind === 'money') return mCards.qMoney
  if (a.kind === 'contact') return isSms(a) ? mCards.qSms : mCards.qSend
  if (a.kind === 'app') return mCards.qApp
  if (a.kind === 'file')
    return a.label === FILE_MOVE_LABEL
      ? mCards.qFileMove
      : a.label === FILE_RESTORE_LABEL
        ? mCards.qFileRestore
        : mCards.qFileSave
  if (a.kind === 'print') return mCards.qPrint
  if (a.kind === 'pc') return mCards.qPc(a.label)
  return mCards.qGo
}

/** Which connect card's site a login address belongs to (for the logo) */
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

// ── Cards attached to a reply (products, stays, restaurants) ──
// The phone does not talk to outside servers for photos. It asks the PC and gets a data: URL (kept while the app is open)
const thumbCache = new Map<string, string | null>()
const thumbAsked = new Set<string>()
function wantThumb(url: string) {
  if (thumbCache.has(url) || thumbAsked.has(url)) return
  thumbAsked.add(url)
  void send({ kind: 'thumb', url })
}
/** Blocks waiting for a photo (result blocks get a Promise) */
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

/** A picture made by the image AI: large under the reply, tap to fill the screen */
function madeInline(rec: MadeImageRecordMessage): HTMLElement {
  const box = h('button', { class: 'made-photo', label: mCards.viewBig(rec.title) }, icon('image', 'i'))
  let src = ''
  void thumbOf(`photo:${rec.photo}`).then((data) => {
    if (!data) return
    src = data
    const img = h('img', {}) as HTMLImageElement
    img.src = data
    img.alt = rec.title
    box.replaceChildren(img)
  })
  box.addEventListener('click', () => {
    if (!src) return
    mark('Open made image full screen')
    openViewer(src, rec.title, rec.path)
  })
  return h('div', { class: 'made' }, box)
}

/** Full-screen picture view: tap anywhere to close */
function openViewer(src: string, title: string, path?: string) {
  const img = h('img', {}) as HTMLImageElement
  img.src = src
  img.alt = title
  const close = () => view.remove()
  const view = h(
    'div',
    { class: 'viewer', onclick: close },
    h(
      'div',
      { class: 'viewer-top' },
      h('span', { text: title }),
      h('button', { class: 'icon-btn', label: mCards.close, onclick: close }, icon('close', 'i')),
    ),
    img,
    path ? h('p', { class: 'viewer-note', text: mCards.originalOnPc(path) }) : undefined,
  )
  document.body.append(view)
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
          // Keep the slot even when empty (so price and info lines line up across cards)
          h('span', { class: 'pick-price', text: c.price ?? '' }),
          h('span', { class: 'pick-note', text: c.note ?? '' }),
        ),
        h(
          'div',
          { class: 'pick-actions' },
          c.url
            ? h('button', {
                text: mCards.view,
                onclick: () => {
                  mark(`Card view ${new URL(c.url ?? '').host}`)
                  // Open in the browser outside the app (or that service's app)
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
            text: mCards.pickThis,
            onclick: () => ask(mCards.pickThisAsk(c.title, c.price ?? '')),
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
    h('div', { class: 'card-label' }, doori('', 22), mCards.tellLabel),
    h('strong', { class: 'tell-title', text: rec.title }),
    rec.body ? h('div', { class: 'tell-body rich' }, rich(rec.body)) : undefined,
    rec.from ? h('p', { class: 'meta', text: rec.from }) : undefined,
    say
      ? answered
        ? h('p', {
            class: 'meta tell-done',
            text: answered === 'yes' ? mCards.tellHandedOver : mCards.tellPassed,
          })
        : h(
            'div',
            { class: 'tell-actions' },
            h('button', {
              class: 'btn small',
              text: rec.askLabel || mCards.tellDoIt,
              onclick: () => {
                lifeAct({ action: 'feed-answer', id: rec.id, answer: 'yes' })
                ask(say)
              },
            }),
            h('button', {
              class: 'btn-ghost small',
              text: mCards.tellNoThanks,
              onclick: () => lifeAct({ action: 'feed-answer', id: rec.id, answer: 'no' }),
            }),
          )
      : undefined,
  )
}

function connectInline(rec: ConnectRecordMessage, live = true): HTMLElement {
  const it = connectFor(rec)
  // If the service list has not arrived yet (app just opened), quietly hold the spot and redraw when it does
  if (!it && !st.services)
    return h('p', { class: 'done-line connect-line' }, icon('link'), mCards.connectCard)
  if (!it) return h('p', { class: 'done-line' }, icon('link'), mCards.connectNotFound(rec.service))
  const c = it.card
  const mark = (big = false) =>
    withLogo(
      h('span', {
        class: big ? 'svc-mark' : 'svc-mark sm',
        text: /^\d+/.exec(c.name)?.[0] ?? [...c.name][0] ?? '',
      }),
      c.id,
    )
  if (it.connectedAt) return h('p', { class: 'done-line connect-line' }, mark(), mCards.isConnected(c.name))
  if (!live) return h('p', { class: 'done-line connect-line' }, mark(), mCards.cardOf(c.name))
  const busy = st.connecting.has(c.id)
  // Official integrations (Gmail and so on) log in through PC Chrome until they are ready: same card as a browser connection
  const browser = c.how === 'browser' || c.how === 'official'
  // When waiting for an account or code: show what is needed and an enter button (not just a spinner)
  const fail = busy ? undefined : st.connectFails.get(c.id)
  if (fail) return connectFailCard(c, fail, mark(true))
  const wait = busy ? connectWaiting(c.id) : undefined
  if (wait?.kind === 'confirm') {
    // Approval in a phone app: nothing to enter, and Dool2 carries on by itself once tapped
    const step = st.connectSteps.get(c.id)?.at(-1)?.text ?? mCards.tapConfirmOnPhone
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
          text: mCards.viewPcScreen,
          onclick: () => openRemote(Number(wait.id), c.id),
        }),
      ),
    )
  }
  if (wait?.label === PICK_LABEL) {
    // Pick one (which account to use and so on): show the question as is, with a pick button
    const ask = st.connectSteps.get(c.id)?.at(-1)?.text ?? mCards.pickOne
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
          h('span', { class: 'meta', text: mCards.afterPick(c.name) }),
        ),
      ),
      connectStepList(c.id, true),
      h(
        'div',
        { class: 'approve-actions' },
        h('button', {
          class: 'btn',
          text: mCards.pick,
          onclick: () => openOverlay({ kind: 'info', id: wait.id }),
        }),
      ),
    )
  }
  if (wait) {
    const what = wait.label.replace(ENTER_SUFFIX, '')
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
          h('strong', { text: mCards.isNeeded(what, josa(what, '이/가')) }),
          h('span', { class: 'meta', text: mCards.afterEnter(c.name) }),
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
        h('strong', { text: busy ? mCards.loggingIn(c.name) : mCards.connectTitle(c.name) }),
        h('span', {
          class: 'meta',
          text: busy ? mCards.watchBelow : browser ? connectHow(c) : mCards.turnOnInConnect,
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
          h('button', {
            class: 'btn',
            text: mCards.connectDo,
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
 * Connection state for the same site as a login request (a card Dool2 raised while working).
 * If an easy login is in progress or stopped on the person's turn, the login card shows that state too (no going in circles)
 */
function loginLink(origin: string) {
  const cid = cardIdFor(origin)
  if (!cid) return undefined
  const busy = st.connecting.has(cid)
  const fail = st.connectFails.get(cid)
  return busy || fail ? { cid, busy, fail } : undefined
}

/** Tapping a login card under "waiting for me": the screen if it is the person's turn, the chat (card) if in progress, else the login sheet */
function openLogin(l: LoginRequestView) {
  const link = loginLink(l.origin)
  if (link?.fail?.tabId !== undefined && link.fail.reason === 'human')
    return openRemote(link.fail.tabId, link.cid)
  if (link?.busy) return setTab('chat')
  openOverlay({ kind: 'login', id: l.id })
}

function loginInline(rec: LoginRecordMessage): HTMLElement {
  const r = loginFor(rec)
  // Same site being linked by easy login, or stopped: same look as the connect card (steps, reason, open screen)
  const link = r?.status === 'pending' ? loginLink(r.origin) : undefined
  if (link) return connectInline({ kind: 'connect', service: link.cid }, true)
  if (!r || r.status !== 'pending')
    return h(
      'p',
      { class: 'done-line' },
      icon('lock'),
      r?.status === 'saved' ? mCards.loginSaved(r.site) : mCards.loginDone(rec.site || mCards.siteFallback),
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
        h('strong', { text: mCards.loginNeeded(r.site) }),
        h('span', { class: 'meta', text: hostOf(r.origin) }),
      ),
    ),
    h(
      'div',
      { class: 'approve-actions' },
      h('button', {
        class: 'btn',
        text: mCards.loginDo,
        onclick: () => openOverlay({ kind: 'login', id: r.id }),
      }),
    ),
  )
}

// ── Tasks ──

/** Top of the feed: what is waiting for me, what is being done now, and what is next */
const mFeed = mainCFeed(lang)

function waitingCards(): HTMLElement[] {
  const box = h('div', { class: 'waiting' })
  const approvals = pendingApprovals()
  const logins = pendingLogins()
  if (approvals.length || logins.length) {
    box.append(h('h2', { class: 'over', text: mFeed.waitingForMe }))
    for (const a of approvals)
      box.append(
        h(
          'button',
          { class: 'task-card ask', onclick: () => openOverlay({ kind: 'approval', id: a.id }) },
          h('span', { class: 'meta' }, h('span', { class: 'dot ask' }), mFeed.waitingApproval),
          h('strong', { text: [a.what, a.amount].filter(Boolean).join(' · ') }),
          h('span', { class: 'meta', text: a.where }),
        ),
      )
    for (const l of logins) {
      const link = loginLink(l.origin)
      const state = link?.busy
        ? (st.connectSteps.get(link.cid)?.at(-1)?.text ?? mFeed.doriLoggingIn)
        : link?.fail?.reason === 'human'
          ? mFeed.doYourself
          : link?.fail?.reason === 'wrong'
            ? mFeed.wrongLogin
            : link?.fail
              ? mFeed.loginNotFinished
              : mFeed.loginNeeded
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
          h('strong', { text: mFeed.siteLogin(l.site) }),
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
      // When a new step arrives: the circle of the step just finished pops, and the new step rises from below
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
      h('h2', { class: 'over', text: mFeed.workingNow }),
      h(
        'div',
        { class: 'task-card' },
        h('span', { class: 'meta' }, h('span', { class: 'dot work pulse' }), mFeed.working),
        h('strong', { text: lastUserText() ?? mFeed.yourRequest }),
        st.steps.length ? log : h('span', { class: 'meta', text: mFeed.writingReply }),
        h('button', {
          class: 'btn-text',
          text: mFeed.stop,
          onclick: () => void send({ kind: 'conversation-cancel' }),
        }),
      ),
    )
  }
  if (st.queued.length) {
    box.append(h('h2', { class: 'over', text: mFeed.upNext }))
    for (const q of st.queued) box.append(h('div', { class: 'row' }, h('span', { class: 'row-t', text: q })))
  }
  return box.childNodes.length ? [box] : []
}

// ── Long lists: the first page comes with life, scrolling down fetches the next pages with life-page ──
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
/** Dool2 panel activity: finished and scheduled tasks only (the first page is fetched separately) */
const activityPager = new Pager<FeedItem>(
  (f) => f.at,
  (before) =>
    void send({ kind: 'life-page', list: 'feed', kinds: ['done', 'routine'], ...(before ? { before } : {}) }),
  () => renderSoon(),
)
let activityAskedAt = 0
/** Full text of one library item (the list only has the beginning) */
const fullItems = new Map<string, LibraryItem>()

/** Fit the first page we got into each list (pages fetched later stay as they are) */
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
  // Library items may have changed: fetch again when reopened
  fullItems.clear()
  if (activityPager.started) activityPager.refresh()
}

/** The long list in view (scrolling down fetches more) */
function visiblePager(): Pager<{ id: string }> | undefined {
  if (st.tab === 'feed') return feedPager
  if (st.tab === 'library') return libPagers[st.librarySeg === 'media' ? 'files' : 'made']
  return undefined
}

function lifeAct(a: LifeAction) {
  // Show taps outside the first page right away (a new first page from the PC only fixes the part before it)
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
      // If only the beginning arrived, ask for the whole text (the sheet is redrawn when it comes)
      if (it?.cut) void send({ kind: 'life-item', id })
      return it
    },
    fileAction: (it, how) => void fileAction(it, how),
    view: (src, title, path) => openViewer(src, title, path),
    librarySeg: st.librarySeg,
    setLibrarySeg: (seg) => {
      st.librarySeg = seg
      render()
    },
  }
}

/** Waiting for chunks of a library file original ("id:offset" -> what to call when it arrives) */
const fileChunkWaits = new Map<string, (m: Extract<PcToPhone, { kind: 'file-chunk' }>) => void>()
let fileBusy = false

// PC file links inside a reply: tapping gets the file from the PC and saves it on the phone (the daemon checks the path is inside the user's folders)
let fileLinkSeq = 0
setFileOpener((path, name) => void fileAction({ id: `link-${++fileLinkSeq}`, title: name, path }, 'save'))

/**
 * Gets the original from the PC in chunks and saves or shares it on the phone (192KB at a time because of the relay envelope limit).
 * Library items are asked for by id, file links inside replies by path (the id marks which chunk we wait for)
 */
async function fileAction(it: Pick<LibraryItem, 'id' | 'title' | 'path'>, how: 'save' | 'share') {
  if (fileBusy) return toast(mFeed.fileBusy)
  if (!st.online) return toast(mFeed.pcOffNoFile)
  fileBusy = true
  mark(how === 'save' ? 'Library file save' : 'Library file share')
  toast(mFeed.receivingFile)
  try {
    const parts: string[] = []
    let offset = 0
    let size = 0
    let name = it.title
    let mime = 'application/octet-stream'
    do {
      const at = offset
      const m = await new Promise<Extract<PcToPhone, { kind: 'file-chunk' }>>((done, fail) => {
        const key = `${it.id}:${at}`
        const timer = setTimeout(() => {
          fileChunkWaits.delete(key)
          fail(new Error(mFeed.pcNoAnswer))
        }, 30_000)
        fileChunkWaits.set(key, (x) => {
          clearTimeout(timer)
          fileChunkWaits.delete(key)
          done(x)
        })
        void send({
          kind: 'file-chunk',
          id: it.id,
          offset: at,
          // The daemon finds library items by id. Only links inside replies use a path
          ...(it.id.startsWith('link-') && it.path ? { path: it.path } : {}),
        })
      })
      if (m.error || !m.data) throw new Error(m.error ?? mFeed.fileFailed)
      size = m.size ?? 0
      name = m.name ?? name
      mime = m.mime ?? mime
      parts.push(m.data)
      offset += FILE_CHUNK
    } while (offset < size)
    const data = parts.join('')
    const said = how === 'save' ? await saveFile(name, mime, data) : await shareFile(name, mime, data)
    if (said) toast(said)
  } catch (e) {
    toast((e as Error).message)
  } finally {
    fileBusy = false
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

/** A reply as a one-line preview: drop bold and list marks, squeeze whitespace */
function plainPreview(text: string, max = 80) {
  const t = stripLinks(text)
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * Task list (latest 6). One request is one task:
 * - A follow-up answer to something Dool2 asked ("Dongtan Station") and app notes (approval results) are not new tasks. They attach to the one before
 * - The title is the first request, the description is the last reply
 */
function recentDone() {
  const out: { ask: string; answer: string; at: string; id: string }[] = []
  let open: { ask: string; asked: boolean } | undefined
  let last: { text: string; at: number } | undefined
  for (const m of st.conv) {
    if (m.role === 'user') {
      // A short answer right after Dool2 asked ("Dongtan Station") continues the previous task
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

/** Go to the chat tab so that message is in view */
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

// ── Ideas ──

/** Send the idea we put off until connecting (only if connected within 10 minutes) */
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
  // A request with blanks to fill (this product, I'll send a photo…) goes into the input box instead of being sent
  if (it.fill) {
    composeDraft(it.fill)
    return
  }
  ask(it.ask)
}

/** Put text in the chat input and place the cursor at the end (does not send) */
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
      ? h('span', { class: 'idea-tag', text: mFeed.tagConnect })
      : it.fill
        ? h('span', { class: 'idea-tag', text: mFeed.tagFill })
        : undefined,
  )
}

function ideasView() {
  const groups = ideaCatalog(st.services ?? [], lang)
  const box = h(
    'section',
    { class: 'tab-page' },
    h('h1', { class: 'ptitle', text: mFeed.ideasTitle }),
    h('p', { class: 'psub', text: mFeed.ideasSub(ideaCount(groups)) }),
  )
  // Things Dool2 found to do on its own (from memory, goals and connections, fresh every morning)
  const ideas = st.life?.ideas ?? []
  const busy = Boolean(st.life?.ideasBusy)
  const refresh = h('button', {
    class: 'btn-ghost small',
    text: busy ? mFeed.searching : ideas.length ? mFeed.findAgain : mFeed.findForMe,
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
          h('span', { class: 'row-t', text: mFeed.todaysPick }),
          h('span', { class: 'row-d', text: mFeed.todaysPickSub }),
        ),
        refresh,
      ),
      // Two or more become a card stack: swipe right to hand it over, left for later
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

  // Search and categories. Redrawing the whole page on every keystroke breaks Hangul composition, so only the list below is redrawn
  const wasTyping = document.activeElement?.id === 'idea-search'
  const search = h('input', { class: 'field idea-search' })
  search.id = 'idea-search'
  search.type = 'search'
  search.placeholder = mFeed.searchPlaceholder
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
    chips.replaceChildren(chip('all', mFeed.all), ...groups.map((g) => chip(g.section.id, g.section.label)))
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
            h('span', { class: 'row-t', text: mFeed.askAsIs(q) }),
            h('span', {
              class: 'row-d',
              text: found.length ? mFeed.justSay : mFeed.noMatch,
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
            h('span', { class: 'meta', text: mFeed.count(g.items.length) }),
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
        h('h2', { class: 'over', text: mFeed.readyNow }),
        list(ready.map((item) => ({ section: g.section, item }))),
      )
    if (later.length)
      body.append(
        h('h2', { class: 'over', text: mFeed.afterConnect }),
        h('p', {
          class: 'meta idea-later',
          text: mFeed.afterConnectNote,
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
      h('div', { class: 'card-label' }, doori('asking', 22), mFeed.doItYourself),
      h('p', {
        class: 'card-text',
        text: mFeed.doItYourselfText,
      }),
    ),
  )
  return box
}

// ── Connections (connections.ts) ──

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
        back && h('button', { class: 'fbtn small', label: mSet.back, onclick: back }, icon('back')),
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
      // The connections screen redrew the list in place: only remember the search text
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

// ── Overlays: menu drawer, Dool2 panel, approval sheet, login sheet ──
const mSet = mainCSettings(lang)

/** Shape of the overlay drawn last (if it is the same, do not insert it again) */
let overlayDrawn = ''
/** Closing animations (cancelled if reopened while closing) */
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
  // Redrawing while a button is held or sending resets it, so leave it alone meanwhile
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
          : ov.kind === 'pick-ship'
            ? shipPicker(ov.id, ov.back)
            : ov.kind === 'pick-pay'
              ? payPicker(ov.id, ov.back)
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
  // While open, this runs every time news arrives from the PC. If the shape is the same, leave it alone:
  // inserting anew replays the rise animation, so sheets and menus bounce two or three times and lose typed text and scroll
  const drawn = body.outerHTML
  if (!opening && drawn === overlayDrawn && o.childElementCount) return putBack()
  overlayDrawn = drawn
  o.dataset.key = key
  o.dataset.kind = ov.kind
  // Input cards do not close when tapping outside (a slip blocked it). Only the "later" button closes them
  const scrim = h('div', { class: 'scrim', onclick: () => ov.kind !== 'info' && openOverlay(undefined) })
  // If only the content changed, swap it in place (the rise animation runs once, on first open)
  if (!opening) {
    scrim.classList.add('still')
    body.classList.add('still')
  }
  const was = o.lastElementChild
  const y = !opening && was instanceof HTMLElement ? was.scrollTop : 0
  const typing = opening ? undefined : typingIn(o)
  o.replaceChildren(scrim, body)
  if (y) body.scrollTop = y
  // Only on first open: menu rows rise one by one
  if (opening) riseIn(body.querySelectorAll(':scope > .set-row, :scope > .navi, :scope > .row'))
  typing?.()
}

/**
 * Where parts that are moved instead of rebuilt (like the animated Dool2) are right now.
 * Building a new screen moves those parts into it, so when a new screen is thrown away they are put back
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

/** Close: slides away in reverse of opening (not an abrupt cut) */
function closeOverlay(o: HTMLElement) {
  if (o.hidden || o.dataset.closing) return
  const done = () => {
    o.replaceChildren()
    o.hidden = true
    delete o.dataset.closing
    overlayClosing = []
  }
  // Opening the same one again right away counts as a first open
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
  // Even if the animation stops because the screen is hidden (app went to background), do not stay half closed
  setTimeout(end, 600)
}

function drawerView() {
  const tabs: [Tab, IconName, string][] = [
    ['chat', 'chat', mSet.tabChat],
    ['feed', 'feed', mSet.tabFeed],
    ['ideas', 'idea', mSet.tabIdeas],
    ['goals', 'goal', mSet.tabGoals],
    ['library', 'library', mSet.tabLibrary],
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
    h('div', { class: 'drawer-title' }, doori('', 28), mSet.appName),
    ...tabs.map(([t, ic, label]) => navi(t, ic, label)),
    h(
      'div',
      { class: 'drawer-sec side-head' },
      h('span', { class: 'over', text: mSet.sideChats }),
      h('button', { class: 'fbtn small', label: mSet.newChat, onclick: newSide }, icon('pencil')),
    ),
    ...sideMenu(),
    h('p', { class: 'over drawer-sec', text: mSet.settings }),
    navi(
      'connect',
      'apps',
      mSet.connections,
      connected ? h('span', { class: 'meta navi-count', text: mSet.placesCount(connected) }) : undefined,
    ),
    navi('settings', 'gear', mSet.settings),
    h(
      'div',
      { class: 'navi static' },
      icon('pc', 'i md'),
      h(
        'span',
        { class: 'row-text' },
        h('span', { text: st.saved?.pcName ?? mSet.myPc }),
        h('span', {
          class: 'meta',
          text: !st.online ? mSet.pcConnecting : st.pcSilent ? mSet.pcSilent : mSet.pcConnected,
        }),
      ),
    ),
    h('p', { class: 'meta drawer-foot', text: mSet.drawerFoot }),
  )
}

/** Rename my PC: saved in the PC settings, so other phones connected to the same PC see the new name too */
function renamePc() {
  if (!st.online) return toast(mSet.renameNeedsOnline)
  const name = prompt(mSet.renamePrompt, st.saved?.pcName ?? '')?.trim()
  if (!name || name === st.saved?.pcName) return
  void send({ kind: 'rename-pc', name: name.slice(0, 40) })
  toast(mSet.renamed(name.slice(0, 40)))
}

/** Settings (menu > settings): notifications, display, my PC, promises */
// Settings follows the PC settings page (apps/desktop setup.ts): the same sections in the same order and words
// (general → AI · browser → connection → vault → my info · payment → about), each a boxed list, on/off as switches.
// What only the PC can change (which AI, the extension) shows as status with where to change it
function settingsView() {
  const box = h('section', { class: 'tab-page settings' }, h('h1', { class: 'ptitle', text: mSet.settings }))
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
  const toggle = (on: boolean) => {
    const sw = h('span', { class: on ? 'switch on' : 'switch' })
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-checked', String(on))
    return sw
  }
  const link = (ic: IconName, title: string, sub: string, href: string) => {
    const a = h(
      'a',
      { class: 'set-row' },
      h('span', { class: 'tile sm blue' }, icon(ic, 'i')),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: title }),
        h('span', { class: 'row-d', text: sub }),
      ),
      icon('chevron'),
    )
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener'
    return a
  }
  /** One section: a small title and its rows in a box, like the PC settings */
  const sec = (title: string, ...rows: (Node | undefined)[]) =>
    box.append(
      h('h2', { class: 'over', text: title }),
      h('div', { class: 'set-list' }, ...rows.filter((x): x is Node => Boolean(x))),
    )
  const chev = () => icon('chevron')

  // ── General (PC: general) ──
  // Auto-approve (ADR 0030): everything except payments without a card. Turned on with the phone lock and a signed request
  const auto = st.pc?.autoApprove === true
  sec(
    mSet.secFinal,
    row(
      'hand',
      mSet.autoApprove,
      auto ? mSet.autoApproveOnSub : mSet.autoApproveOffSub,
      toggle(auto),
      () => void setAutoApprove(!auto),
    ),
  )
  const perm = 'Notification' in window ? Notification.permission : 'denied'
  sec(
    mSet.notifications,
    row(
      'bell',
      mSet.phoneNotif,
      perm === 'granted' ? mSet.notifOn : perm === 'denied' ? mSet.notifBlocked : mSet.notifOff,
      toggle(perm === 'granted'),
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
    ['auto', mSet.themeAuto],
    ['light', mSet.themeLight],
    ['dark', mSet.themeDark],
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
  box.append(h('h2', { class: 'over', text: mSet.screen }), seg)
  // Language of this phone (ADR 0029). Each device keeps its own; changing it reloads the app
  const langSeg = h('div', { class: 'seg' })
  for (const id of LANGS)
    langSeg.append(segBtn(lang === id, { text: LANG_NAMES[id], onclick: () => setLang(id) }))
  box.append(h('h2', { class: 'over', text: mSet.language }), langSeg)

  // ── AI · browser (PC: AI · browser): status only, changed on the PC ──
  const agent = st.pc?.defaultAgent ?? st.pc?.agents[0]
  sec(
    mSet.secAi,
    row('brain', mSet.aiRow, agent ? mSet.aiSub(agentLabel(agent, lang)) : mSet.aiNone),
    row('globe', mSet.browserRow, st.pc?.extension ? mSet.browserOn : mSet.browserOff),
    row(
      'apps',
      mSet.connectedServices,
      mSet.connectedServicesSub((st.services ?? []).filter((x) => x.connectedAt).length),
      chev(),
      () => setTab('connect'),
    ),
  )

  // ── Connection (PC: phone connection) ──
  sec(
    mSet.secPc,
    row(
      'pc',
      st.saved?.pcName ?? mSet.myPc,
      !st.online ? mSet.pcConnecting : st.pcSilent ? mSet.pcSilent : mSet.pcRunning,
      h('span', { class: 'meta', text: mSet.rename }),
      () => renamePc(),
    ),
    row('close', mSet.repair, mSet.repairSub, undefined, () => {
      if (confirm(mSet.repairConfirm)) void forgetPc()
    }),
  )

  // ── Dool2 vault (PC: Dool2 vault) ──
  sec(
    mSet.secVault,
    row('lock', mSet.vaultRow, mSet.vaultSub, chev(), () => {
      void send({ kind: 'vault-get' })
      openOverlay({ kind: 'vault' })
    }),
  )

  // ── My info · payment (PC: my info · payment) ──
  // Used when Dool2 fills booking and order fields. Values stay in the PC vault, and only masked values show here
  if (!st.profile) void send({ kind: 'profile-get' })
  const have = Object.keys(st.profile?.have ?? {})
  const infoRow = row(
    'note',
    mSet.myInfo,
    !st.profile
      ? mSet.loading
      : have.length
        ? mSet.myInfoHave(have.map((k) => PROFILE_LABEL[k] ?? k).join('·'))
        : mSet.myInfoNone,
    chev(),
    () => openOverlay({ kind: 'profile' }),
  )
  const mine = st.profile?.payMethods
  const pays = Object.entries(st.profile?.payChoices ?? {})
  // My payment methods (ADR 0023): the top one is the main method. What is remembered per site is inside the sheet
  const payRows: Node[] = mine
    ? [
        row(
          'card',
          mSet.payMethods,
          mine[0] ? mSet.payMain(payMethodLabel(mine[0], lang), mine.length - 1) : mSet.payNone,
          chev(),
          () => openOverlay({ kind: 'pay' }),
        ),
      ]
    : pays.length
      ? pays.map(([host, label]) =>
          row(
            'card',
            `${label}`,
            mSet.payRemembered(host.replace(/^www\./, '')),
            h('span', { class: 'meta', text: mSet.forget }),
            () => void send({ kind: 'pay-choice-forget', host }),
          ),
        )
      : [row('card', mSet.payMethods, mSet.payRememberNote)]
  sec(mSet.infoAndPay, infoRow, ...payRows)

  // ── About Dool2 (PC: about) ──
  sec(
    mSet.secAbout,
    row('hand', mSet.reportProblem, mSet.reportProblemSub, chev(), () => openOverlay({ kind: 'report' })),
    link('globe', mSet.siteLink, 'dool2.com', 'https://dool2.com'),
    link('link', mSet.sourceLink, 'github.com/kuzvo-dev/dool2', 'https://github.com/kuzvo-dev/dool2'),
  )

  // Reset data (PC: About Dool2 > Reset data): start over like a new user. The vault and the phone link stay
  sec(
    mSet.secReset,
    row('trash', mSet.startOver, mSet.startOverSub, chev(), () => void resetAll()),
  )

  box.append(h('h2', { class: 'over', text: mSet.promises }))
  const promises = h('div', { class: 'set-list' })
  for (const [ic, t] of [
    ['card', mSet.promise1],
    ['lock', mSet.promise2],
    ['pc', mSet.promise3],
    ['hand', mSet.promise4],
  ] as [IconName, string][])
    promises.append(
      h(
        'div',
        { class: 'set-row' },
        h('span', { class: 'tile sm mint' }, icon(ic, 'i')),
        h('span', { class: 'row-t', text: t }),
      ),
    )
  box.append(promises)
  return box
}

const PROFILE_LABEL: Record<string, string> = Object.fromEntries(
  [
    'name',
    'name_en_last',
    'name_en_first',
    'email',
    'phone',
    'birth',
    'zip',
    'address',
    'address_detail',
    'rrn_back',
    'auth_app',
    'carrier',
    'passport_no',
    'passport_issued',
    'passport_expiry',
    'sex',
    'birth_city',
    'car_no',
  ].map((k) => [k, mSet.profileLabel(k)]),
)

/** Settings > my info: existing items only show masked values, and only newly filled fields change (empty ones stay) */
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
        h('strong', { class: 'title-2', text: mSet.myInfo }),
        h('span', { class: 'meta', text: mSet.profileSub }),
      ),
    ),
  )
  if (!p) {
    sheet.append(h('p', { class: 'meta', text: mSet.loading }))
    return sheet
  }
  const inputs = Object.entries(PROFILE_LABEL).map(([key, label]) => {
    const input = h('input', { class: 'field' })
    input.name = key
    if (key === 'auth_app' || key === 'carrier') {
      // Verification app and carrier are picked from a list (not secret, so the current pick shows as is)
      input.type = 'hidden'
      const opts = key === 'carrier' ? CARRIERS : AUTH_APPS
      return { key, label, input, chips: choiceChips(opts, p.have[key] ?? '', (v) => (input.value = v)) }
    }
    input.placeholder = p.have[key] ? mSet.profileChange(p.have[key]) : mSet.profileEmpty
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
  const go = h('button', { class: 'btn lg', text: mSet.save })
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
    h('p', { class: 'lock-note' }, icon('lock'), mSet.profileNote),
    h('button', {
      class: 'btn-text cred-direct',
      text: mSet.profileClear,
      onclick: () => {
        if (!confirm(mSet.profileClearConfirm)) return
        void send({ kind: 'profile-clear' })
        openOverlay(undefined)
      },
    }),
  )
  return sheet
}

/**
 * Settings > vault (ADR 0026): the list of saved logins. Show checks the phone lock (fingerprint, face, PIN), asks the PC, and shows it for 30 seconds only.
 * Edit changes the ID and password (empty fields stay). Dool2 (the AI) never gets the password
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
        h('strong', { class: 'title-2', text: mSet.vault }),
        h('span', { class: 'meta', text: mSet.vaultSheetSub }),
      ),
    ),
  )
  const list = st.vault
  if (!list) {
    sheet.append(h('p', { class: 'meta', text: mSet.loading }))
    return sheet
  }
  if (!list.length) sheet.append(h('p', { class: 'meta', text: mSet.vaultEmpty }))
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
      text: shown ? mSet.hide : mSet.show,
      onclick: async () => {
        if (shown) {
          st.vaultShown = undefined
          render()
          return
        }
        const ok = await confirmDevice(mSet.showPassword, mSet.showPasswordWhy(e.name ?? site(e.origin)))
        if (ok === 'ok') void send({ kind: 'vault-reveal', id: e.id })
        else if (ok === 'no-lock') toast(mSet.noLock)
        else if (ok === 'web') toast(mSet.onlyInApp)
      },
    })
    const edit = h('button', {
      text: mSet.edit,
      onclick: () => {
        st.vaultEdit = st.vaultEdit === e.id ? undefined : e.id
        render()
      },
    })
    const del = h('button', {
      class: 'danger',
      text: mSet.remove,
      onclick: () => {
        if (!confirm(mSet.vaultDeleteConfirm(e.name ?? site(e.origin)))) return
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
      user.placeholder = mSet.idPlaceholder(e.username)
      user.autocomplete = 'off'
      const pw = h('input', { class: 'field' }) as HTMLInputElement
      pw.type = 'password'
      pw.placeholder = mSet.newPassword
      pw.autocomplete = 'new-password'
      const save = h('button', { class: 'btn sm', text: mSet.save })
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
  sheet.append(h('p', { class: 'lock-note' }, icon('lock'), mSet.vaultNote))
  return sheet
}

/** Payment method mark: pay apps get a colored first letter, cards get a card picture */
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

/** Send the whole list to the PC (the PC checks it, saves it and returns the saved list) */
function savePayMethods(list: PayMethod[]) {
  if (st.profile) st.profile = { ...st.profile, payMethods: list }
  void send({ kind: 'pay-methods-set', methods: list })
  render()
}

/** Settings > payment methods: the top one is the main method. At payment, the first one the site accepts is picked */
function paySheet() {
  const sheet = h('section', { class: 'sheet float app-sheet rise info-sheet pay-sheet' })
  sheet.append(
    h(
      'div',
      { class: 'approve-head' },
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: mSet.payMethods }),
        h('span', { class: 'meta', text: mSet.paySub }),
      ),
    ),
  )
  const list = st.profile?.payMethods
  if (!list) {
    sheet.append(h('p', { class: 'meta', text: mSet.loading }))
    return sheet
  }
  if (!list.length)
    sheet.append(
      h('p', {
        class: 'pay-empty',
        text: mSet.payEmpty,
      }),
    )
  const ul = h('ul', { class: 'pay-list' })
  list.forEach((m, i) => {
    const detail = payMethodDetail(m, lang)
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
            payMethodTitle(m, lang),
            i === 0 ? h('span', { class: 'pay-main', text: mSet.payMainTag }) : '',
          ),
          detail ? h('span', { class: 'row-d', text: detail }) : '',
        ),
        i > 0
          ? h('button', {
              class: 'btn-text',
              text: mSet.makeMain,
              onclick: () => savePayMethods([m, ...list.filter((x) => x.id !== m.id)]),
            })
          : '',
        h('button', {
          class: 'btn-text danger',
          text: mSet.remove,
          onclick: () => {
            if (!confirm(mSet.removePayConfirm(payMethodLabel(m, lang)))) return
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
      text: mSet.payAdd,
      onclick: () => {
        st.payDraft = { inner: '', issuer: '', nickname: '', last4: '' }
        openOverlay({ kind: 'pay-add' })
      },
    }),
  )
  // What was picked last time for each site (used when my payment methods are not on that site)
  const pays = Object.entries(st.profile?.payChoices ?? {})
  if (pays.length) {
    sheet.append(h('h3', { class: 'over', text: mSet.lastChosen }))
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
            text: mSet.forget,
            onclick: () => void send({ kind: 'pay-choice-forget', host }),
          }),
        ),
      )
  }
  sheet.append(h('p', { class: 'lock-note' }, icon('lock'), mSet.payNote))
  return sheet
}

/** Add payment method: pick a type, then for pay apps what is used inside (optional), for cards the issuer, nickname and last 4 digits */
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
        h('strong', { class: 'title-2', text: mSet.payAdd }),
        h('span', { class: 'meta', text: mSet.payAddSub }),
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
      h('span', { class: 'meta', text: mdSheets.payHow }),
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
        h('span', { class: 'meta', text: mdSheets.issuer }),
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
      field('pay-nickname', mdSheets.nicknameLabel, 'nickname', mdSheets.nicknamePh),
      field('pay-last4', mdSheets.last4Label, 'last4', mdSheets.last4Ph),
    )
  } else form.append(field('pay-inner', mdSheets.innerLabel(PAY_KINDS[d.kind]), 'inner', mdSheets.innerPh))
  const go = h('button', { class: 'btn lg', text: mdSheets.register })
  go.type = 'submit'
  form.append(go)
  form.onsubmit = (e) => {
    e.preventDefault()
    const now = st.payDraft
    if (!now.kind) return
    if (now.kind === 'card' && !now.issuer) return toast(mdSheets.pickIssuer)
    if (now.last4 && !/^\d{4}$/.test(now.last4.trim())) return toast(mdSheets.last4Err)
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
  sheet.append(form, h('p', { class: 'lock-note' }, icon('lock'), mdSheets.noSecrets))
  return sheet
}

/** Composer + menu: ideas, goals, feed, separate chat, connections */
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
    item('image', 'blue', mdSheets.plusPhoto, mdSheets.plusPhotoSub, () => pickPhoto()),
    item('idea', 'amber', mdSheets.plusIdeas, mdSheets.plusIdeasSub, () => setTab('ideas')),
    item('goal', 'rose', mdSheets.plusGoals, mdSheets.plusGoalsSub, () => setTab('goals')),
    item('feed', 'blue', mdSheets.plusFeed, mdSheets.plusFeedSub, () => setTab('feed')),
    item('pencil', 'violet', mdSheets.plusSide, mdSheets.plusSideSub, () => newSide()),
    item('apps', 'mint', mdSheets.plusConnect, mdSheets.plusConnectSub, () => setTab('connect')),
  )
}

/** Long-press on a reply: save to the library or copy */
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
          toast(mdSheets.savedToLibrary)
        },
      },
      h('span', { class: 'tile sm amber' }, icon('bookmark', 'i')),
      h('span', { class: 'row-t', text: mdSheets.saveToLibrary }),
    ),
    h(
      'button',
      {
        class: 'set-row',
        onclick: (e: MouseEvent) => {
          const row = e.currentTarget as HTMLElement
          void navigator.clipboard?.writeText(m.text).then(
            () => {
              // The copy icon shrinks as the check is drawn, and the label slides up to "Copied"
              const tile = row.querySelector('.tile') as HTMLElement
              const label = row.querySelector('.row-t') as HTMLElement
              const ok = icon('check', 'i')
              tile.replaceChildren(ok)
              tile.classList.replace('blue', 'mint')
              drawCheck(ok)
              label.textContent = mdSheets.copied
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
              toast(mdSheets.copyFailed)
              openOverlay(undefined)
            },
          )
        },
      },
      h('span', { class: 'tile sm blue' }, icon('copy', 'i')),
      h('span', { class: 'row-t', text: mdSheets.copy }),
    ),
    h('button', { class: 'btn-ghost wide', text: mdSheets.close, onclick: () => openOverlay(undefined) }),
  )
  return sheet
}

function agentPanel() {
  const waiting = pendingApprovals().length + pendingLogins().length
  const mood = !st.online || st.pcSilent ? 'sleeping' : waiting ? 'asking' : st.busy ? 'working' : ''
  const segs: [typeof st.agentSeg, IconName, string][] = [
    ['upcoming', 'clock', mdSheets.segUpcoming],
    ['memory', 'brain', mdSheets.segMemory],
    ['screen', 'pc', mdSheets.segScreen],
    ['activity', 'list', mdSheets.segActivity],
    ['approvals', 'hand', mdSheets.segApprovals],
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
        text: mdSheets.screenNote,
      }),
      tab !== undefined
        ? h('button', { class: 'btn wide', onclick: () => openRemote(tab) }, icon('pc'), mdSheets.viewScreen)
        : h('p', {
            class: 'meta seg-empty',
            text: mdSheets.noScreen,
          }),
    )
  } else if (st.agentSeg === 'activity') {
    if (st.busy)
      body.append(
        act(
          h('span', { class: 'tile sm mint' }, icon('globe', 'i')),
          st.steps.at(-1) ?? mdSheets.answering,
          lastUserText(),
        ),
      )
    // Ask for the first page when opened (retry after 10 seconds if no answer)
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
          ? h('p', { class: 'meta seg-empty', text: mdSheets.nothingDone })
          : h('p', { class: 'wait' }, h('span', { class: 'spin' }), mdSheets.receiving),
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
          mdSheets.waiting,
          () => openOverlay({ kind: 'approval', id: a.id }),
        ),
      )
    for (const l of logins)
      body.append(
        act(
          h('span', { class: 'tile sm amber' }, icon('lock', 'i')),
          mdSheets.loginOf(l.site),
          hostOf(l.origin),
          mdSheets.waiting,
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
          a.status === 'rejected'
            ? mdSheets.rejected
            : a.status === 'expired'
              ? mdSheets.expired
              : mdSheets.approved,
        ),
      )
    if (!approvals.length && !logins.length && !history.length)
      body.append(
        h('p', {
          class: 'meta seg-empty',
          text: mdSheets.noApprovals,
        }),
      )
  }
  const where = st.saved?.pcName ?? mdSheets.myPc
  return h(
    'section',
    { class: 'agent-panel rise' },
    h(
      'div',
      { class: 'panel-head' },
      h(
        'button',
        { class: 'fbtn', label: mdSheets.close, onclick: () => openOverlay(undefined) },
        icon('close'),
      ),
    ),
    h('div', { class: 'agent-big' }, liveDoori('agent', mood, 136)),
    h('h2', { class: 'agent-name', text: st.busy ? mdSheets.nameWorking : mdSheets.name }),
    h(
      'p',
      { class: 'agent-where' },
      h('span', { class: st.online ? 'dot work' : 'dot' }),
      st.online
        ? mdSheets.onPc(where, st.busy ? (st.steps.at(-1) ?? mdSheets.working) : mdSheets.resting)
        : mdSheets.connectingPc(where),
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
    { class: 'fbtn small sheet-x', label: mdSheets.close, onclick: () => openOverlay(undefined) },
    icon('close'),
  )
  if (!a) {
    sheet.append(close, h('p', { class: 'meta', text: mdSheets.loading }))
    return sheet
  }
  if (!a.shot && a.status === 'pending') void send({ kind: 'approval', id })
  if (a.kind === 'money' && a.status === 'pending' && !st.decided.get(id)) {
    sheet.append(close, checkoutCard(a, true))
    return sheet
  }
  if (isSms(a) && a.status === 'pending' && !st.decided.get(id)) {
    sheet.append(close, smsCard(a, true))
    return sheet
  }
  const rows = h('dl', { class: 'kv' })
  const row = (k: string, v?: string, cls?: string) =>
    v && rows.append(h('dt', { text: k }), h('dd', { text: v, ...(cls ? { class: cls } : {}) }))
  row(mdSheets.rowWhat, a.what)
  row(mdSheets.rowWhere, a.where)
  row(mdSheets.rowUrl, hostOf(a.url), 'host')
  const pc = a.kind === 'file' || a.kind === 'print' || a.kind === 'pc'
  row(pc ? mdSheets.rowKnow : mdSheets.rowCancel, a.cancel)
  if (a.kind !== 'app' && !pc) row(mdSheets.rowButton, `"${finalLabel(a)}"`)
  const items = itemsList(a, 100)
  if (items)
    rows.append(
      h('dt', { text: a.kind === 'print' ? mdSheets.rowFile : mdSheets.rowList(a.items?.length) }),
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
  const ship = a.status === 'pending' ? shipRow(a) : undefined
  if (ship) sheet.append(ship)
  const pick = a.status === 'pending' ? choiceRow(a) : undefined
  if (pick) sheet.append(pick)
  if (a.shot) {
    const img = h('img', { class: 'sheet-shot' })
    img.alt = mdSheets.pcScreen
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
            ? mdSheets.rejected
            : a.status === 'expired'
              ? mdSheets.expiredLong
              : mdSheets.handled),
      }),
    )
    return sheet
  }
  sheet.append(
    h('p', {
      class: 'meta',
      text:
        a.kind === 'file'
          ? mdSheets.hintFile
          : a.kind === 'pc'
            ? mdSheets.hintPc
            : a.kind === 'print'
              ? mdSheets.hintPrint
              : mdSheets.hintMoney,
    }),
    h(
      'div',
      { class: 'approve-actions' },
      h('button', { class: 'btn-ghost lg', text: mdSheets.reject, onclick: () => void decide(a, 'reject') }),
      holdButton({
        label: a.kind === 'app' ? mdSheets.holdAllow : mdSheets.holdApprove,
        done: a.kind === 'app' ? mdSheets.allowed : mdSheets.approved,
        cls: 'btn btn-approve lg',
        onDone: () => decide(a, 'approve', true),
        after: () => markDecided(a, 'approve'),
      }),
    ),
  )
  return sheet
}

/** Sign-in sheet: what is typed is encrypted and goes only to the PC vault. It never reaches the AI or the chat history */
interface CredTarget {
  /** Whether automatic sign-in got stuck earlier: only then is "do it on the screen" shown */
  stuck?: boolean
  key: string
  site: string
  host: string
  busyText: string
  submitText: string
  submit(user: string, password: string): void
  direct?: { text: string; onclick(): void }
  /** Social sign-in buttons (connect with Kakao...): through the provider account, no ID or password */
  social?: { provider: SocialProvider; hint?: string; onclick(): void }[]
  /** Request to start right after connecting */
  next?: string
  /** Id of the connection card whose logo to show */
  logo?: string
  /** The provider's logo when this is a provider account such as Kakao or Naver */
  brand?: SocialProvider
  /** Only social sign-in works here (no ID/password login): the ID field is hidden */
  socialOnly?: boolean
  /** "First time, please sign me up" button (asks Dool2 to create an account) */
  signup?: () => void
  /** "I don't know my account, please find it" button (Dool2 recovers the ID or resets the password) */
  forgot?: () => void
}

/** ID and password sheet (sign-in card, connect a service). Values go only to the PC vault */
function credSheet(t: CredTarget) {
  const sheet = h('section', { class: 'sheet float app-sheet rise' })
  const d = st.loginDraft
  if (d.id !== t.key) Object.assign(d, { id: t.key, user: '', pw: '', busy: false, error: undefined })
  const user = h('input', { class: 'field' })
  user.id = 'login-user'
  user.placeholder = mdCred.idPh
  user.autocomplete = 'username'
  user.value = d.user
  user.oninput = () => {
    d.user = user.value
  }
  const pw = h('input', { class: 'field' })
  pw.id = 'login-pw'
  pw.type = 'password'
  pw.placeholder = mdCred.pwPh
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
      { class: 'fbtn small sheet-x', label: mdCred.close, onclick: () => openOverlay(undefined) },
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
        h('strong', { class: 'title-2', text: mdCred.signInTitle(t.site) }),
        h('span', {
          class: 'meta',
          text: mdCred.signInWhere(t.host, st.saved?.pcName ?? mdCred.myPc),
        }),
      ),
    ),
    ...(t.next ? [h('p', { class: 'cred-next' }, icon('idea'), mdCred.startAfter(t.next))] : []),
    ...(t.social?.length
      ? [
          h(
            'div',
            { class: 'social-list' },
            ...t.social.map((x) => {
              const b = h('button', { class: `btn-social ${x.provider}`, onclick: x.onclick })
              b.type = 'button'
              b.append(brandMark(x.provider), h('span', { text: SOCIAL_CTA[x.provider] }))
              // Mark providers that reuse an existing account instead of creating a new one (recently used, used on N sites)
              if (x.hint) b.append(h('span', { class: 'social-hint', text: x.hint }))
              return b
            }),
          ),
          ...(t.socialOnly ? [] : [h('p', { class: 'social-or' }, h('span', { text: mdCred.orWithId }))]),
        ]
      : []),
    ...(t.socialOnly && t.social?.length ? [] : [form]),
    // Find account | Sign up: a one-line link like on most sign-in screens (two big buttons felt busy, per user feedback)
    ...(t.forgot || t.signup
      ? [
          h(
            'div',
            { class: 'cred-links' },
            ...(t.forgot
              ? [h('button', { class: 'btn-text', text: mdCred.findAccount, onclick: t.forgot })]
              : []),
            ...(t.forgot && t.signup ? [h('span', { class: 'cred-sep' })] : []),
            ...(t.signup ? [h('button', { class: 'btn-text', text: mdCred.signUp, onclick: t.signup })] : []),
          ),
        ]
      : []),
    h('p', { class: 'lock-note' }, icon('lock'), mdCred.vaultNote),
    // Show "watch the screen" only when sign-in failed or the connection got stuck
    ...(t.direct && (d.error || t.stuck)
      ? [h('button', { class: 'btn-text cred-direct', text: t.direct.text, onclick: t.direct.onclick })]
      : []),
  )
  return sheet
}

/** Report a problem: write a line (optional) and send, and what just happened in the app is saved in the PC's activity log */
function reportSheet() {
  const note = h('textarea', { class: 'field report-note' })
  note.id = 'report-note'
  note.rows = 3
  note.maxLength = 500
  note.placeholder = mdCred.reportPh
  const go = h('button', { class: 'btn lg', text: st.online ? mdCred.reportSend : mdCred.reportNeedPc })
  go.disabled = !st.online
  go.onclick = () => {
    void send({
      kind: 'report',
      trail: [...trail],
      ...(note.value.trim() ? { note: note.value.trim() } : {}),
      app: navigator.userAgent,
    })
    mark('report sent')
    st.overlay = undefined
    toast(mdCred.reportSaved)
  }
  return h(
    'section',
    { class: 'sheet float app-sheet rise report-sheet' },
    h(
      'button',
      { class: 'fbtn small sheet-x', label: mdCred.close, onclick: () => openOverlay(undefined) },
      icon('close'),
    ),
    h(
      'div',
      { class: 'approve-head' },
      h('span', { class: 'tile sm mint' }, icon('hand', 'i')),
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: mdCred.reportTitle }),
        h('span', { class: 'meta', text: mdCred.reportKeepOn(st.saved?.pcName ?? mdCred.myPc) }),
      ),
    ),
    note,
    go,
    h('p', { class: 'lock-note' }, icon('lock'), mdCred.reportNote),
  )
}

/** What the page asks during sign-in (verification code, phone number): collected on the phone and typed into the PC field */
function infoSheet(id: string) {
  const q = st.infos.get(id)
  const sheet = h('section', { class: 'sheet float app-sheet rise info-sheet' })
  if (!q) return sheet
  const answer = (value?: string) => {
    void send({ kind: 'info-answer', id, ...(value ? { value } : {}) })
    st.infos.delete(id)
    st.overlay = undefined
    render()
    if (value) toast(mdCred.filled)
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
            ? mdCred.otpTitle
            : q.field === 'tap'
              ? mdCred.tapTitle
              : q.field === 'form'
                ? mdCred.formTitle
                : q.label,
      }),
      h('span', {
        class: 'meta',
        text: q.field === 'form' ? mdCred.formSub : `${q.site} \u00b7 ${q.host}`,
      }),
    ),
  )
  const body: Node[] = []
  if (q.hint) body.push(h('p', { class: 'info-hint', text: q.hint.replace(/^\s*#+\s*/, '') }))
  // Solve by tapping the image (robot check): taps are sent as 0-1000 ratios, and Dool2 clicks the same spot on the PC screen
  if (q.field === 'tap' && q.image) {
    const max = Math.max(1, q.maxTaps ?? 1)
    const points: [number, number][] = []
    const img = h('img', { class: 'tap-img' }) as HTMLImageElement
    img.src = `data:image/jpeg;base64,${q.image}`
    img.alt = mdCred.tapAlt
    img.draggable = false
    const dots = h('div', { class: 'tap-dots' })
    const done = h('button', { class: 'btn lg', text: mdCred.tapDone }) as HTMLButtonElement
    const redo = h('button', { class: 'btn-ghost lg', text: mdCred.tapRedo }) as HTMLButtonElement
    const draw = () => {
      dots.replaceChildren(
        ...points.map(([x, y], i) => {
          const d = h('span', { class: 'tap-dot', text: String(i + 1) })
          d.style.left = `${x / 10}%`
          d.style.top = `${y / 10}%`
          return d
        }),
      )
      done.disabled = points.length === 0
      done.textContent = max > 1 ? mdCred.tapDoneCount(points.length, max) : mdCred.tapHere
    }
    const box = h('div', { class: 'tap-box' }, img, dots)
    box.onclick = (e) => {
      const r = img.getBoundingClientRect()
      const x = Math.round(((e.clientX - r.left) / r.width) * 1000)
      const y = Math.round(((e.clientY - r.top) / r.height) * 1000)
      if (x < 0 || y < 0 || x > 1000 || y > 1000) return
      // When only one tap is needed, tapping again moves it
      if (max === 1) points.splice(0, points.length, [x, y])
      else if (points.length < max) points.push([x, y])
      draw()
    }
    redo.onclick = () => {
      points.splice(0)
      draw()
    }
    done.onclick = () => {
      if (points.length) answer(points.map(([x, y]) => `${x},${y}`).join(';'))
    }
    draw()
    sheet.append(
      head,
      ...body,
      box,
      h('div', { class: 'tap-actions' }, redo, done),
      h('button', { class: 'btn-link', text: mdCred.later, onclick: () => answer() }),
    )
    return sheet
  }
  // Security code: show the image Dool2 picked and take the letters (no need to look at the PC screen)
  if (q.image) {
    const img = h('img', { class: 'captcha-img' }) as HTMLImageElement
    img.src = `data:image/jpeg;base64,${q.image}`
    img.alt = mdCred.captchaAlt
    body.push(img)
  }
  if (q.field === 'choice' && q.options?.length) {
    // Pick one (e.g. several Google accounts). The chosen text is sent back as is
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
      h('button', { class: 'btn-link', text: mdCred.later, onclick: () => answer() }),
    )
    sheet.append(head, ...body)
    return sheet
  }
  if (q.field === 'form' && q.fields?.length) {
    // Personal info card: several fields at once. Values go only to the PC vault, and Dool2 (the AI) sees only masked values
    const inputs = q.fields.map((f) => {
      const input = h('input', { class: 'field' })
      input.name = f.key
      if (f.type === 'choice' && f.options?.length) {
        // Pick one (simple-auth app): tapping a chip puts its name in the hidden field
        input.type = 'hidden'
        return { f, input, chips: choiceChips(f.options, '', (v) => (input.value = v)) }
      }
      input.placeholder = f.example ? mdCred.example(f.example) : f.label
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
    const go = h('button', { class: 'btn lg', text: mdCred.saveContinue })
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
      // Check each field's format: if it doesn't match, show a hint under that field and stop (empty fields are skipped)
      let bad: HTMLInputElement | undefined
      for (const { f, input } of inputs) {
        const v = input.value.trim()
        input.parentElement?.querySelector('.field-err')?.remove()
        input.classList.remove('invalid')
        if (!v || !f.pattern || new RegExp(f.pattern).test(v)) continue
        input.classList.add('invalid')
        input.insertAdjacentElement(
          'afterend',
          h('span', { class: 'field-err', text: f.patternHint || mdCred.badFormatOf(f.label) }),
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
    // New password chosen by the user: typed twice to check, then sent only to the PC vault (never to Dool2 or the log)
    const mk = (ph: string) => {
      const i = h('input', { class: 'field' }) as HTMLInputElement
      i.type = 'password'
      i.autocomplete = 'new-password'
      i.placeholder = ph
      i.setAttribute('aria-label', ph)
      return i
    }
    const pw1 = mk(mdCred.newPw)
    const pw2 = mk(mdCred.onceMore)
    const err = h('p', { class: 'field-err', text: '' })
    const show = h('button', { class: 'btn-text', text: mdCred.show })
    show.type = 'button'
    show.onclick = () => {
      const t = pw1.type === 'password' ? 'text' : 'password'
      pw1.type = t
      pw2.type = t
      show.textContent = t === 'password' ? mdCred.show : mdCred.hide
    }
    const go = h('button', { class: 'btn lg', text: mdCred.setPw })
    go.type = 'submit'
    const form = h('form', { class: 'cred-form' }, pw1, pw2, show, err, go)
    form.onsubmit = (e) => {
      e.preventDefault()
      const v = pw1.value
      if (q.pattern && !new RegExp(q.pattern).test(v)) {
        err.textContent = q.patternHint || mdCred.badFormat
        return
      }
      if (v !== pw2.value) {
        err.textContent = mdCred.pwMismatch
        return
      }
      answer(v)
    }
    body.push(form)
    queueMicrotask(() => pw1.focus())
  } else if (q.field === 'secret') {
    // Values that are never stored, like the back digits of a resident number: taken on a secure keypad with shuffled digit positions instead of the phone keyboard
    // The same card keeps the same keypad when redrawn: reshuffling on each draw changed the digits 2-3 times,
    // and the positions moved at the moment of a tap so a different digit went in (measured: wrong payment PIN, 11-20)
    let pad = pads.get(q.id)
    if (!pad) {
      pad = securePad(q.pattern, q.patternHint, (v) => {
        pads.delete(q.id)
        answer(v)
      })
      // Mark it as a reusable part: when a redrawn sheet is discarded (the shape is the same so the old one stays), it goes back to the original sheet.
      // Without this it moved into the discarded new sheet and vanished, leaving the visible card without a keypad (measured 11-20, payment PIN in a shop)
      pad.dataset.liveSlot = 'pad'
      pads.set(q.id, pad)
    }
    body.push(pad)
  } else if (q.field === 'otp') {
    // Digit count: use it if the page hint ("4 digits") or the pattern says, else accept 4-8 digits and finish with [Enter]
    const said = `${q.label} ${q.hint ?? ''}`.match(DIGITS_RE)?.[1] ?? q.pattern?.match(/\\d\{(\d)\}/)?.[1]
    const len = said ? Number(said) : undefined
    const otp = otpBoxes({
      ...(len && len >= 4 && len <= 8 ? { length: len } : { flex: true }),
      onDone: (code) => setTimeout(() => answer(code), 500),
    })
    body.push(otp)
    body.push(
      h('p', {
        class: 'meta',
        text: otp.go ? mdCred.otpHintGo : mdCred.otpHintAuto,
      }),
    )
    if (otp.go) body.push(otp.go)
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
      input.placeholder = mdCred.imagePh
    }
    const go = h('button', { class: 'btn lg', text: mdCred.put })
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
        ? mdCred.noteForm
        : q.field === 'secret' && PAY_SECRET_RE.test(q.label)
          ? mdCred.notePay
          : q.field === 'secret' || q.field === 'password'
            ? mdCred.noteVault
            : mdCred.noteOther,
    ),
    h('button', { class: 'btn-text cred-direct', text: mdCred.notNow, onclick: () => answer() }),
  )
  return sheet
}

/** Phone and birth-date fields add hyphens as you type digits */
function autoHyphen(input: HTMLInputElement, key: string) {
  if (key !== 'phone' && key !== 'birth') return
  input.inputMode = 'numeric'
  input.addEventListener('input', () => {
    input.value = hyphenate(key, input.value)
  })
}

/**
 * Secure keypad (like banking apps): shuffles digit positions, and a tap flashes another digit too
 * so nobody looking over your shoulder can tell which one it was. The value stays inside this function and is handed over only on [Enter]
 */
/** Open secure keypads (by card id; positions and typed value survive a redraw) */
const pads = new Map<string, HTMLElement>()

function securePad(
  pattern: string | undefined,
  hint: string | undefined,
  onDone: (v: string) => void,
): HTMLElement {
  const max = Number(/\{(\d+)\}\$?$/.exec(pattern ?? '')?.[1] ?? '') + 1 || 7
  let value = ''
  const dots = h('div', { class: 'pad-dots' })
  const err = h('p', { class: 'field-err pad-err', text: '' })
  const go = h('button', { class: 'btn lg', text: mdCred.put }) as HTMLButtonElement
  const grid = h('div', { class: 'pad-grid' })
  const paint = () => {
    dots.replaceChildren(
      ...Array.from({ length: max }, (_, i) => h('span', { class: i < value.length ? 'on' : '' })),
    )
    go.disabled = value.length < max
    err.textContent = ''
  }
  // Another digit key looks pressed together with the tapped one
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
      key(mdCred.shuffle, () => layout(), 'fn', mdCred.shuffleAria),
      num(digits[9] as string),
      key(
        icon('back'),
        () => {
          value = value.slice(0, -1)
          paint()
        },
        'fn',
        mdCred.deleteAria,
      ),
    )
  }
  go.onclick = () => {
    if (pattern && !new RegExp(pattern).test(value)) {
      err.textContent = hint || mdCred.badFormat
      return
    }
    onDone(value)
    value = ''
  }
  layout()
  paint()
  return h('div', { class: 'secure-pad' }, dots, err, grid, go)
}

/** Pick-one chips (simple-auth app etc.). Only the tapped chip turns on and onPick is called */
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

/** The provider when the address is a provider account (accounts.kakao.com -> kakao) */
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
    busyText: mdCred.saving,
    submitText: mdCred.signIn,
    submit: (username, password) => void send({ kind: 'login', id: r.id, username, password }),
    direct: { text: mdCred.directLogin, onclick: () => openRemote(r.tabId) },
    stuck: Boolean(loginLink(r.origin)?.fail),
    // If the user doesn't know the ID or password, Dool2 recovers it: the sign-in card is withdrawn and the request goes to the chat (only identity-check codes use a phone card)
    forgot: () => {
      void send({ kind: 'forgot', site: r.origin, loginId: r.id })
      void send({ kind: 'ask', text: mdCred.forgotAsk(r.site) })
      st.overlay = undefined
      st.tab = 'chat'
      toast(mdCred.forgotToast(r.site))
    },
    // If there is no account, Dool2 signs up: report that sign-up was chosen for this site and send the request to the chat
    signup: () => {
      void send({ kind: 'signup', site: r.origin, loginId: r.id })
      void send({ kind: 'ask', text: mdCred.signupAsk(r.site) })
      st.overlay = undefined
      st.tab = 'chat'
      toast(mdCred.signupToast(r.site))
    },
    // For sites with a connection card, offer social sign-in too (same choices as the connect screen)
    ...loginChoices(cardIdFor(r.origin)),
  })
}

/** Social sign-in buttons of a connection card (the sign-in request card and the connect screen share the same choices) */
function loginChoices(cardId: string | undefined): Pick<CredTarget, 'social' | 'socialOnly'> {
  const it = cardId ? st.services?.find((x) => x.card.id === cardId) : undefined
  if (!it?.card.social?.length) return {}
  const id = it.card.id
  return {
    socialOnly: !ID_PASSWORD_LOGIN_RE.test(it.card.login ?? ''),
    social: socialOrder(it.card, st.services, lang).map(({ provider, hint }) => ({
      provider,
      ...(hint ? { hint } : {}),
      onclick: () => {
        // If the provider is already signed in on the PC's Chrome, Dool2 only passes the button and consent; otherwise it hands over that screen
        void send({ kind: 'connect-social', id, provider })
        st.overlay = undefined
        st.connecting.add(id)
        if (st.tab !== 'chat') toast(mdCred.socialToast(SOCIAL_LABEL[provider], it.card.name))
        render()
      },
    })),
  }
}

/** Connect a service: after you enter the ID and password, Dool2 signs in on the PC's Chrome for you and reports back */
function connectSheet(id: string) {
  const it = st.services?.find((x) => x.card.id === id)
  if (!it) return h('section', { class: 'sheet float app-sheet rise' })
  return credSheet({
    key: `connect:${id}`,
    site: it.card.name,
    host: it.card.site ?? '',
    busyText: mdCred.connecting,
    submitText: mdCred.connect,
    submit: (username, password) => {
      // Don't wait: close the sheet and Dool2 signs in behind the scenes (reported in the chat or by notification)
      void send({ kind: 'connect-login', id, username, password })
      st.loginDraft.busy = false
      st.overlay = undefined
      st.connecting.add(id)
      if (st.tab !== 'chat') toast(mdCred.connectToast(it.card.name))
    },
    ...(st.afterConnect?.id === id ? { next: st.afterConnect.text } : {}),
    logo: id,
    // Places with only social sign-in or SMS verification: an ID field would only confuse
    socialOnly: Boolean(it.card.social?.length) && !ID_PASSWORD_LOGIN_RE.test(it.card.login ?? ''),
    social: socialOrder(it.card, st.services, lang).map(({ provider, hint }) => ({
      provider,
      ...(hint ? { hint } : {}),
      onclick: () => {
        // If the provider (Kakao etc.) is already signed in on the PC's Chrome, Dool2 only passes the button and consent; otherwise it hands over that screen
        void send({ kind: 'connect-social', id, provider })
        st.overlay = undefined
        st.connecting.add(id)
        if (st.tab !== 'chat') toast(mdCred.socialToast(SOCIAL_LABEL[provider], it.card.name))
      },
    })),
    stuck: st.connectFails.has(id),
    direct: {
      text: st.connectTabs.has(id) ? mdCred.keepOnPc : mdCred.directConnect,
      onclick: () => {
        const tab = st.connectTabs.get(id)
        if (tab !== undefined) return openRemote(tab, id)
        st.opening = id
        st.overlay = undefined
        render()
        void send({ kind: 'connect', id, action: 'open' })
      },
    },
    // If the user doesn't know the ID or password, Dool2 recovers it: the sign-in card is withdrawn and the request goes to the chat (only identity-check codes use a phone card)
    forgot: () => {
      void send({ kind: 'forgot', site: it.card.site ?? it.card.id })
      void send({ kind: 'ask', text: mdCred.forgotAsk(it.card.name) })
      st.overlay = undefined
      st.tab = 'chat'
      toast(mdCred.forgotToast(it.card.name))
    },
    // If there is no account, Dool2 signs up: the request goes to the chat and Dool2 runs the sign-up flow
    signup: () => {
      if (it.card.site) void send({ kind: 'signup', site: it.card.site })
      void send({ kind: 'ask', text: mdCred.signupAsk(it.card.name) })
      st.overlay = undefined
      st.tab = 'chat'
      toast(mdCred.signupToast(it.card.name))
    },
  })
}

// ── Separate chats ──

function sideThreads() {
  return (st.pc?.threads ?? []).filter((t) => t.side && t.title !== FEED_THREAD_TITLE)
}

/** Separate chats in the menu: show the latest few and expand the rest with "Show more" (the drawer scrolls as a whole) */
function sideMenu(): Node[] {
  const all = sideThreads()
  // Chats that are replying come first, so they show even when the list is folded
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
  if (!all.length) items.push(h('p', { class: 'meta side-empty', text: mdSide.sideEmpty }))
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
        h('span', { text: st.sideAll ? mdSide.fold : mdSide.showMore(more) }),
        icon('chevron', st.sideAll ? 'i more-chev open' : 'i more-chev'),
      ),
    )
  return items
}

function isSideThread(id: string) {
  return st.side?.id === id || (st.pc?.threads ?? []).some((t) => t.id === id && t.side)
}

function openSide(id: string, title = mdSide.sideTitle) {
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
      const label =
        narrationLine(sd.live, lang) ?? mdSide.stepSuffix(ev.event.title ?? toolLabel(ev.event.name, lang))
      sd.live = ''
      if (sd.steps.at(-1) !== label) sd.steps = [...sd.steps, label]
    }
  } else if (ev.type === 'end') {
    sd.busy = false
    sd.live = ''
    sd.steps = []
    void send({ kind: 'thread', id: sd.id })
    hello()
  }
}

/**
 * A bar that reopens a waiting input card when it is closed (there used to be no way to reopen one dismissed by mistake)
 */
function infoWaitBar(): HTMLElement[] {
  const open = st.overlay?.kind === 'info' ? (st.overlay as { id: string }).id : undefined
  const q = [...st.infos.values()].filter((x) => x.status === 'pending' && x.id !== open).at(-1)
  if (!q) return []
  return [
    h(
      'button',
      { class: 'info-wait-bar', onclick: () => openOverlay({ kind: 'info', id: q.id }) },
      h('span', { text: mdSide.waitingInput(q.label) }),
      h('strong', { text: mdSide.open }),
    ),
  ]
}

/**
 * The separate-chat screen also shows the cards that ask the person (personal info, secure keypad, verification code, approval, sign-in).
 * This screen redraws on every update, so the same card reuses what was already built (typed values aren't lost)
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
    // Input cards don't close when you tap outside (dismissing by mistake blocked people). Only [Later] closes them
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
      // Quick replies go to the main chat, so they are not drawn in a separate chat
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
        h('div', { class: 'card-label' }, doori('', 22), mdSide.sideIntro),
        h('p', {
          class: 'card-text',
          text: mdSide.sideIntroText,
        }),
      ),
    )
  const ta = h('textarea')
  ta.id = 'side-input'
  ta.rows = 1
  ta.placeholder = mdSide.askPh
  ta.value = sd?.draft ?? ''
  ta.oninput = () => {
    if (sd) sd.draft = ta.value
    autosize(ta)
  }
  const go = h('button', { class: 'send-btn ready', label: mdSide.send }, icon('send', 'i md'))
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
      h('button', { class: 'fbtn', label: mdSide.back, onclick: back }, icon('back')),
      h('strong', { class: 'side-title', text: sd?.title ?? mdSide.sideTitle }),
      h(
        'button',
        {
          class: 'fbtn',
          label: mdSide.delete,
          onclick: () => {
            if (!confirm(mdSide.confirmDelete)) return
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

// ── Screens before connecting ──

function introView() {
  return h(
    'section',
    { class: 'center-page' },
    liveDoori('intro', '', 120),
    h('h1', { class: 'display-s', text: mdSide.name }),
    h('p', { class: 'psub', text: mdSide.introSub }),
    h(
      'ol',
      { class: 'steps' },
      h('li', { text: mdSide.step1 }),
      h('li', { text: mdSide.step2 }),
      h('li', { text: isNative() ? mdSide.step3Native : mdSide.step3Web }),
    ),
    isNative() ? h('button', { class: 'btn', text: mdSide.scanQr, onclick: () => void scanInvite() }) : null,
    h('p', { class: 'meta', text: mdSide.encrypted }),
  )
}

/** App: scan the connection QR on the PC screen to start connecting */
async function scanInvite() {
  try {
    const text = await scanQr()
    if (!text) return
    const invite = inviteFrom(text)
    if (!invite) return toast(mdSide.notDoolQr)
    await startPairing(invite)
  } catch (e) {
    toast((e as Error).message || mdSide.scanFailed)
  }
}

/** Android back: closes the open sheet, then a separate chat or remote screen, then returns to the chat tab. Returns false when nothing is left to close */
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
          // The app's screens are drawn by the phone's WebView. Encryption (X25519, Ed25519) works on WebView 137 and later
          h('h1', { class: 'title-2', text: mdSide.updateTitle }),
          h('p', {
            class: 'psub',
            text: mdSide.updateText,
          }),
          h('button', {
            class: 'btn',
            text: mdSide.updateBtn,
            onclick: () => {
              location.href = 'https://play.google.com/store/apps/details?id=com.google.android.webview'
            },
          }),
        ]
      : [
          h('h1', { class: 'title-2', text: mdSide.browserTitle }),
          h('p', {
            class: 'psub',
            text: mdSide.browserText,
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
      h('h1', { class: 'title-2', text: mdSide.rejectedTitle }),
      h('p', { class: 'psub', text: mdSide.rejectedText }),
    )
  return h(
    'section',
    { class: 'center-page' },
    liveDoori('center', 'thinking', 104),
    h('h1', { class: 'title-2', text: mdSide.connectTo(v.pcName) }),
    h('p', { class: 'psub', text: mdSide.seeNumber }),
    h('p', { class: 'pair-code mono', text: v.code }),
    h('p', {
      class: 'meta',
      text: mdSide.pairHint,
    }),
  )
}

/** PC screen (one still image at a time for now; replaced by a live view at the sign-in step) */
let remoteUi: RemoteScreen | undefined
let remoteToast: HTMLElement | undefined

/** Remote screen: built once per tab, then only the image and info change (remote.ts) */
function remoteView(v: Extract<Screen, { name: 'remote' }>) {
  if (remoteUi?.tabId !== v.tabId) {
    const back = () => {
      st.screen = { name: 'app' }
      remoteUi = undefined
      // Back to where it was opened from (the chat if opened from a connection card, that service if opened from the connect screen)
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
        // Connect: tapping doesn't count as connected right away. The PC checks it is really signed in and reports back
        if (v.connectId) {
          st.connecting.add(v.connectId)
          void send({ kind: 'connect', id: v.connectId, action: 'verify' })
          toast(mdSide.checkingLogin)
        } else {
          // Don't write "done" in the chat; tell the PC instead: Dool2 checks the screen and carries on by itself
          void send({ kind: 'remote', tabId: v.tabId, action: 'done' })
          toast(mdSide.checkingContinue)
        }
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

// ── Start ──

// Scanning a new QR or tapping a notification while the app is open changes only the part after # in the address
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

// ── Resync: after the app was in the background or the signal dropped, show the same as the PC ──

let lastStreamAt = Date.now()

/** Fetch the chat, status, life and connections from the PC again */
function resync() {
  if (!st.online || !st.saved?.paired) return
  hello()
  void send({ kind: 'conversation' })
  void send({ kind: 'life' })
  void send({ kind: 'connections' })
  pollWork()
}

function startResync() {
  // When the app comes back to the front (while it was in the background the phone may have lost the connection or missed signals)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (st.client && !st.online) connect()
    else resync()
    // Start fetching the screen being watched (working screen, connecting screen) again
    pollWork()
    pollConnect()
    // If the user approved in an auth app (KakaoTalk, PASS) and came back, bring the [I verified] card to the front (measured 11-22 national checkup: it took 3 minutes to find the card)
    const auth = [...st.infos.values()].find(
      (q) => q.status === 'pending' && q.options?.includes(AUTH_DONE_OPTION),
    )
    if (auth && st.overlay?.kind !== 'info') {
      openOverlay({ kind: 'info', id: auth.id })
      navigator.vibrate?.(20)
    }
  })
  // Tell the PC every minute that the app is open (the PC streams replies only to phones that are open)
  setInterval(() => {
    if (st.online && st.saved?.paired && document.visibilityState === 'visible') void send({ kind: 'ping' })
  }, 60_000)
  // If a reply is in progress but no signal came for over 40 seconds, fetch the history again
  setInterval(() => {
    if (st.busy && Date.now() - lastStreamAt > 40_000) {
      lastStreamAt = Date.now()
      resync()
    }
  }, 10_000)
}

/** Pull to refresh: pulling down from the top of a list and releasing fetches again from the PC */
/**
 * Pull to refresh: it follows at half speed at first and gets heavier the further you pull (rubber band).
 * Past the threshold Dool2 pops bigger to show it, and on release it spins in place and springs back
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
      // Follows the finger directly
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
  // iPhone Safari ignores the viewport's zoom lock, so pinch zoom is blocked separately (the remote screen handles it itself)
  document.addEventListener('gesturestart', (e) => e.preventDefault())
  // Errors inside the app are noted too (they go along when the user reports a problem)
  window.addEventListener('error', (e) => mark(`error ${e.message}`))
  window.addEventListener('unhandledrejection', (e) =>
    mark(`error ${String((e.reason as Error | undefined)?.message ?? e.reason)}`),
  )
  document.addEventListener('visibilitychange', () => mark(`app ${document.visibilityState}`))
  mark('app started')
  document.documentElement.dataset.theme = 'auto'
  if (!globalThis.crypto?.subtle || !('indexedDB' in window)) {
    st.screen = { name: 'unsupported' }
    return render()
  }
  try {
    // Both encryption (X25519) and signing (Ed25519) are needed. Chrome and WebView support X25519 from 133 and Ed25519 from 137
    await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
    await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
  } catch {
    st.screen = { name: 'unsupported' }
    return render()
  }
  const theme = localStorage.getItem('dool2-theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  // The app doesn't use a service worker (the app code is already inside the app)
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
  // Show the previous chat first (so the screen isn't empty while waiting for the PC)
  if (saved.paired) st.conv = (await loadConv().catch(() => undefined)) ?? []
  st.key = await linkKey(saved.keys.boxPriv, saved.pcBoxPub, [saved.keys.id, saved.pcId])
  st.screen = saved.paired
    ? { name: 'app' }
    : { name: 'pairing', code: await pairCode(saved.keys.boxPriv, saved.pcBoxPub), pcName: saved.pcName }
  render()
  connect()
  startResync()
  // Re-place the tab pill when the tablet rotates or the window size changes
  // Unfolding, folding or rotating changes the tab bar shape (landscape or portrait, cell width).
  // Measuring mid-change misplaces the pill, so a moving pill stops and is measured again after layout settles
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
