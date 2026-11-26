// Phone app core: shared state (st), the app root, sending to the PC, the activity trail and the locale text used everywhere
import type {
  ApprovalView,
  ConnectStep,
  InfoRequestView,
  LifeState,
  LoginRequestView,
  PcToPhone,
  PhoneToPc,
  StoredMessage,
  TaskView,
  VaultEntry,
} from '@dool2/protocol'
import type { ConnectionItem } from '@dool2/protocol/connect'
import { LINK_VERSION, seal } from '@dool2/protocol/e2e'
import type { LinkClient } from '@dool2/protocol/link'
import type { PayKind, PayMethod } from '@dool2/protocol/pay-methods'
import { lang } from '../lang.js'
import { approvalText } from '../locales/main-b-approval.js'
import { chatText } from '../locales/main-b-chat.js'
import { shellText } from '../locales/main-b-shell.js'
import { smsText } from '../locales/main-b-sms.js'
import { mainCCards } from '../locales/main-c-cards.js'
import { mainCFeed } from '../locales/main-c-feed.js'
import { mainCSettings } from '../locales/main-c-settings.js'
import type { Shot } from '../remote.js'
import { type Saved, save } from '../store.js'

export const app = document.getElementById('app') as HTMLElement

// ── State ──
/** Five tab bar slots plus pages opened from the menu (connect, settings) */
export type Tab = 'chat' | 'feed' | 'ideas' | 'goals' | 'library' | 'connect' | 'settings'
export type Screen =
  | { name: 'intro' }
  | { name: 'unsupported' }
  | { name: 'pairing'; code: string; pcName: string; rejected?: boolean }
  | { name: 'app' }
  | { name: 'remote'; tabId: number; connectId?: string }
  /** One side conversation */
  | { name: 'side'; id: string }
export type Overlay =
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

export const st: {
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
  /** Tasks handed over in the conversation (ADR 0038), by id */
  tasks: Map<string, TaskView>
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
  /** Connections whose look ended in "the ID and password are needed": the card opens the entry directly */
  needCreds: Set<string>
  connectFails: Map<
    string,
    {
      /** other-account: Chrome is signed in to another account (shown like an unknown failure: its message says what to do) */
      reason: 'human' | 'wrong' | 'unknown' | 'other-account'
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
  tasks: new Map(),
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
  needCreds: new Set(),
  connectFails: new Map(),
  work: { web: false },
  ideaQuery: '',
  agentSeg: 'activity',
  librarySeg: 'made',
  draft: '',
}
export const coreVars = { pendingSeq: 0 }

// ── Connection ──

// Sending is queued in a single line. If another message slips in while the sequence number is raised and we wait for saving and encryption, it
// would go out with the same number or in the wrong order, and the PC would take the later one for a resend and drop it
let sending = Promise.resolve()
export function send(body: PhoneToPc): Promise<void> {
  if (!QUIET_SEND.has(body.kind)) mark(`sent ${body.kind}${'action' in body ? `:${body.action}` : ''}`)
  sending = sending.then(() => sendNow(body)).catch(() => {})
  return sending
}

// ── What just happened in the app (for reporting a problem) ──
// Only the kind and time of taps and received signals are kept in phone memory, up to 300 lines. Chat content and entered values are not stored.
// Sent to the PC only when [Report a problem] is tapped, and kept in the PC's activity log for a few days
export const trail: { at: number; what: string }[] = []
export function mark(what: string) {
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

export const tShell = shellText(lang)
export const tChat = chatText(lang)
/** Answers whose folded earlier answers the user opened */
export const openEarlier = new Set<string>()
export const tSms = smsText(lang)
export const tAppr = approvalText(lang)
export const mCards = mainCCards(lang)
export const mFeed = mainCFeed(lang)
export const mSet = mainCSettings(lang)
