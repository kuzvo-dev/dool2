// v1-compat phone link (ADR 0012, 0043). This is the daemon-side handler that lets the ALREADY-SHIPPED Capacitor
// phone app (apps/phone on origin/main) pair with and sign approvals against the v2 daemon, WITHOUT rebuilding the app
// and without touching the relay wire or the e2e crypto (both byte-identical between v1 and v2). The v2 relay bridge
// (relay-bridge.ts) speaks the new `pair-rpc` protocol; this sits alongside it and speaks the v1 envelope kinds the
// shipped app sends: `pair`, `approve-keys`, `decide`, plus the CONVERSATION subset (`hello`/`ping`, `conversation`,
// `ask`, `cancel`/`conversation-cancel`, the `conversation-accept`/`continue`/`unqueue` queue controls, `use-agent`).
// It is a reduced port of apps/daemon/src/link.ts (PhoneLink): pairing + approval + chat, plus service CONNECTIONS,
// phone-first LOGIN sheets and the VAULT (vault/profile) — the "Dool2 does it, the person only logs in" flow (ADR
// 0011/0014/0041/0047). Secrets the user types on the phone go phone->vault only; the AI sees only masked summaries.
// Still out of scope (a later PR): screens (`screen`/`remote`), `life`, `push` (FCM) and `sms`; a tab that sends one
// of those stays empty for now.
//
// Chat core: a `conversation` request is answered with the current ConversationState (history + busy + queued), and an
// `ask` runs one v2 engine turn (Agentd.send) whose events are mapped to the v1 `stream` shape the app renders so the
// phone shows live activity, not just the final answer (see #onEvent): `thinking` -> a "reasoning" status line, a
// `code`-hand `tool_call` -> a human Korean work step derived from the snippet (open a page / press / read the screen,
// wording from @dool2/protocol/rich codeHandLabel), `text` chunks -> the streamed answer, the final answer -> a `saved`
// assistant message then `end`, all framed by `conversation-status` (busy -> idle). Approvals still surface as cards
// (announceApproval -> `decide` -> approveVerified), unchanged, now with a short status leading into them. The v2 engine has no external abort seam yet, so
// a `cancel` stops streaming to the phone and clears busy immediately; the in-flight turn finishes but its output is
// dropped (a true mid-turn engine abort is a later PR, see the PR note).
//
// The crucial difference from the v2 approvals path: the v1 app signs a FREE-TEXT approval string
// (`approvalSignText`) with a P-256 secp256r1 secure-chip key (`SHA256withECDSA`), or, on a phone with no chip keys,
// with its Ed25519 pairing key — NOT the Ed25519-over-envelope-hash the v2 daemon verifies. So this module verifies
// the v1 signature itself (verifyP256 / verifyText from @dool2/protocol/e2e, both present and identical on v2) and,
// only on success, resumes the real gated action through Agentd.approveVerified(). The v2 signed-over-hash path
// (Agentd.approve) is left untouched.
//
// Secrets never cross this layer: envelopes carry only the public facts of an action (label, amount, site), and the
// v1 app knows no daemon token — pairing binds the phone's device key, and approvals ride the phone's own signature.

import { timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'
import type { ActionTier } from '@dool2/core'
import type { Lang } from '@dool2/i18n'
import type {
  ApprovalView,
  ConversationState,
  DaemonStreamEvent,
  InfoRequestView,
  LoginRequestView,
  PairInvite,
  PcHealth,
  PcToPhone,
  PhoneToPc,
  StepDetail,
  StoredMessage,
} from '@dool2/protocol'
import { type ConnectionItem, connectUrl } from '@dool2/protocol/connect'
import {
  b64u,
  type DeviceKeys,
  deviceId,
  type Envelope,
  LINK_VERSION,
  linkKey,
  open,
  SeqGuard,
  seal,
  verifyP256,
  verifyText,
} from '@dool2/protocol/e2e'
import { approvalSignText, approveKeysSignText } from '@dool2/protocol/link'
import { codeHandLabel, workStatus } from '@dool2/protocol/rich'
import type { Agentd, AgentdEvent, ApprovalCard } from './agentd.js'
import { type PhoneCopy, phoneCopy } from './locales/phone.js'
import type { InMemoryVault } from './vault.js'

/** The thread id the shipped app's MAIN conversation runs under. Anything not in `state.threads` (we send none) and
 *  not the open side thread is treated as the main chat by the app (threads.ts isSideThread), so a stable constant is
 *  enough: every `stream`/`conversation` reply carries it and the app routes it to the main conversation screen. */
const MAIN_THREAD = 'main'

/** How many conversation messages one `conversation` reply carries by default (the shipped app asks with no limit). */
const CONV_DEFAULT_LIMIT = 60
const CONV_MAX_LIMIT = 200

/** The shipped app caps a sent message at 4000 chars (apps/daemon link.ts `ask`); mirror it so replies match. */
const ASK_MAX = 4000

/**
 * How many prior chat messages (user + assistant) one turn carries into the engine as context, newest-biased. Bounds
 * the prompt so a long conversation does not grow it without limit; ~20 messages is roughly ten exchanges, enough for
 * a short follow-up ("that one, not the other") to resolve without re-sending the whole history.
 */
const HISTORY_MAX = 20

/** A P-256 approve-key as SPKI DER in base64url (~122 chars). The same guard the v1 daemon used (apps/daemon link.ts). */
const SPKI_RE = /^[\w-]{100,200}$/

/** How long a signed v1 request (`approve-keys`) may be in the past/future before it is a stale replay. */
const FRESH_MS = 120_000

/** How long a mid-task login / info request the phone has not answered stays open before it is dropped as stale. */
const REQUEST_TTL_MS = 5 * 60_000

/** Cap on a phone-sent credential / field value (mirrors apps/daemon link.ts: 200 for id/value, 500 for password). */
const USERNAME_MAX = 200
const PASSWORD_MAX = 500

/** The shared end-to-end key type, taken from linkKey so we never name a DOM/global CryptoKey directly. */
type LinkKey = Awaited<ReturnType<typeof linkKey>>

/** A phone paired over the v1-compat path. Mirrors the fields of @dool2/protocol PairedPhone this layer needs. */
interface LegacyPhone {
  id: string
  name: string
  /** The phone's X25519 public key (base64url), from the pairing envelope header, used to seal replies. */
  boxPub: string
  /** The phone's Ed25519 pairing public key (base64url). Verifies text signatures when there are no chip keys. */
  signPub: string
  /** The phone's P-256 secure-chip approval keys (SPKI base64url), registered via `approve-keys` (ADR 0043). */
  approveKeys?: { plain: string; pay?: string }
  /** Whether a money approval must use the `pay` key (true once a pay key is registered). */
  payConfirm?: boolean
}

/**
 * The turn answering now. `aborted` is flipped by a `cancel` so its streamed output is dropped. `thinking` coalesces a
 * run of `thinking` events into a single reasoning status line: it is set when that line is shown and cleared by the next
 * tool/text/block, so a thinking pause after an action shows the line again (Dool2 thinking between steps).
 */
interface TurnState {
  aborted: boolean
  thinking?: boolean
}

export interface LegacyPhoneLinkOptions {
  /** The relay identity keypair — the SAME keys the relay bridge joined the room with (shared transport). */
  keys: DeviceKeys
  /** The daemon this links phones to: registers the device, holds pending approvals, resumes approved actions. */
  agentd: Agentd
  /** The one-time pairing secret carried in the v1 PairInvite QR; the phone echoes it in its `pair` message. */
  secret: string
  /** The relay base URL, put in the invite so the phone connects to the same relay (PairInvite.r). */
  relayUrl: string
  /** Send a sealed envelope out over the relay (the relay bridge passes its LinkClient.send here). */
  send: (env: Envelope) => void
  /** This PC's name, shown on the phone and put in the invite. Defaults to the hostname. */
  pcName?: string
  /** Called after a valid `approve` decision is verified and recorded, so the host can resume the gated action. */
  onApproved?: (approval: { hash: string; choice?: string }) => void
  /**
   * The engine's vault (the SAME InMemoryVault that backs the code hand's vault bridge). When set, the link serves the
   * phone-facing vault screen (vault-get/set/delete/reveal) over the relay WITHOUT ever leaking a secret, and wires the
   * phone-first login seam: a mid-task `fillLogin` with no stored credential shows a login sheet on the phone, the
   * phone's `login`/`connect-login` goes straight into this vault, and the running turn continues. Omitted => the
   * vault/login messages degrade to an empty list / a clear note (the app does not break).
   */
  vault?: InMemoryVault
  /**
   * Lists the service connections the phone shows (connected + connectable, from the service cards, ADR 0014). Read at
   * call time so a freshly downloaded card pack is seen. Omitted => an empty list (v2 ships no connect cards yet; the
   * app still renders the screen, just with nothing to connect — see the PR note).
   */
  connections?: () => ConnectionItem[] | Promise<ConnectionItem[]>
  /** How long an unanswered mid-task login/info request stays open. Defaults to {@link REQUEST_TTL_MS}. */
  requestTtlMs?: number
  /** The language for the short result messages the phone shows. Defaults to Korean (the reference copy). */
  lang?: Lang
  /** Clock seam (unix ms). Defaults to Date.now. */
  now?: () => number
  /** One-line log sink. */
  log?: (line: string) => void
}

/**
 * The v1-compat phone link. Construct it with the relay bridge's keys + send, feed it every non-`pair-rpc` envelope
 * (handle), and announce new approval cards (announceApproval) so a connected v1 phone sees them. It verifies v1
 * approvals and resumes them through Agentd.approveVerified().
 */
export class LegacyPhoneLink {
  readonly #keys: DeviceKeys
  readonly #agentd: Agentd
  readonly #secret: string
  readonly #relayUrl: string
  readonly #send: (env: Envelope) => void
  readonly #pcName: string
  readonly #onApproved: ((approval: { hash: string; choice?: string }) => void) | undefined
  readonly #vault: InMemoryVault | undefined
  readonly #connections: (() => ConnectionItem[] | Promise<ConnectionItem[]>) | undefined
  readonly #copy: PhoneCopy
  readonly #requestTtlMs: number
  readonly #now: () => number
  readonly #log: (line: string) => void

  readonly #phones = new Map<string, LegacyPhone>()
  readonly #keyCache = new Map<string, LinkKey>()
  readonly #guard = new SeqGuard()
  /** Per-target outgoing sequence number (monotonic; stops replays of our replies, as the v2 bridge does). */
  readonly #outSeq = new Map<string, number>()
  /**
   * The EXACT ApprovalView sent to the phone, keyed by its id (the envelope hash). The phone signs
   * approvalSignText(view, …) over the view it received, so verification must recompute the text from this same view —
   * never a freshly rebuilt one with a different createdAt. Built once per hash and reused thereafter.
   */
  readonly #views = new Map<string, ApprovalView>()

  /**
   * The main conversation, kept in memory for this session so a reconnecting app can restore it with a `conversation`
   * request. Only the chat the app renders lives here (user + assistant messages); the v2 engine itself is stateless
   * per turn, so this is the daemon's phone-visible record, not the engine's.
   */
  readonly #messages: StoredMessage[] = []
  /** Monotonic counter for stable StoredMessage ids within the session (the app dedupes by id). */
  #msgSeq = 0
  /** Whether a turn is answering now (the app shows a "working" status). */
  #busy = false
  /** Messages the app sent while a turn was answering, waiting their turn (texts, in order). */
  #queued: string[] = []
  /** The turn answering now, if any. See {@link TurnState}. */
  #turn: TurnState | undefined

  /** Service ids the user marked connected from the phone (merged into the connections list). In-memory this session. */
  readonly #connected = new Set<string>()
  /** The user's profile ("my info"): non-secret key→value. Returned masked; held here for the phone settings screen. */
  readonly #profile = new Map<string, string>()
  /** Open login requests awaiting the phone (a login sheet is showing), keyed by request id. */
  readonly #pendingLogins = new Map<
    string,
    {
      view: LoginRequestView
      resolve: (id: string | undefined) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  /** Open info requests awaiting the phone (otp / pick an account / a prompt), keyed by request id. */
  readonly #pendingInfos = new Map<
    string,
    {
      view: InfoRequestView
      resolve: (value: string | undefined) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  /** Monotonic counter for stable login/info request ids within the session. */
  #reqSeq = 0

  constructor(opts: LegacyPhoneLinkOptions) {
    this.#keys = opts.keys
    this.#agentd = opts.agentd
    this.#secret = opts.secret
    this.#relayUrl = opts.relayUrl
    this.#send = opts.send
    this.#pcName = opts.pcName || hostname().replace(/\.local$/, '')
    this.#onApproved = opts.onApproved
    this.#vault = opts.vault
    this.#connections = opts.connections
    this.#copy = phoneCopy(opts.lang)
    this.#requestTtlMs = opts.requestTtlMs ?? REQUEST_TTL_MS
    this.#now = opts.now ?? Date.now
    this.#log = opts.log ?? (() => {})
    // Wire the phone-first login seam: when the engine's vault bridge needs a login it does not hold, it asks the
    // phone through this link (a login sheet), and the phone's reply goes straight into this same vault. Passing the
    // vault is all it takes — no separate plumbing — because the vault bridge reads the requester off the vault.
    this.#vault?.setLoginRequester((ctx) => this.requestLogin({ url: ctx.url }))
  }

  /** The v1 PairInvite the desktop encodes into a QR for the shipped app's `startPairing`. */
  invite(): PairInvite {
    return { pc: this.#keys.id, k: this.#keys.boxPub, s: this.#secret, n: this.#pcName, r: this.#relayUrl }
  }

  /** The invite as the BARE base64url(JSON) token the shipped app's scanner/`startPairing` reads (no `#d2p=` wrapper). */
  inviteToken(): string {
    return b64u(new TextEncoder().encode(JSON.stringify(this.invite())))
  }

  /** Whether at least one v1 phone has paired. */
  paired(): boolean {
    return this.#phones.size > 0
  }

  /**
   * Handle one inbound relay envelope whose kind is NOT the v2 `pair-rpc`. Mirrors apps/daemon link.ts `receive`:
   * `pair` goes through the pairing path (its own key derivation); any other kind is opened with the paired phone's
   * key, checked for a matching kind and a fresh sequence number, then dispatched. Anything unparseable is dropped.
   */
  async handle(env: Envelope): Promise<void> {
    if (env.to !== this.#keys.id || env.v !== LINK_VERSION) return
    if (env.kind === 'pair') return this.#receivePair(env)
    const phone = this.#phones.get(env.from)
    if (!phone) return // unpaired device
    let msg: PhoneToPc
    try {
      msg = await open<PhoneToPc>(await this.#keyFor(phone.id, phone.boxPub), env)
    } catch {
      return
    }
    if (msg.kind !== env.kind) return
    if (!this.#guard.accept(phone.id, env.seq)) return
    await this.#dispatch(phone, msg)
  }

  /** Build an ApprovalView for a card and push it to every paired phone as a v1 `approval` message (ADR 0012). */
  async announceApproval(card: ApprovalCard): Promise<void> {
    const view = this.#viewFor(card)
    await Promise.all(
      [...this.#phones.values()].map((phone) => this.#send2(phone, { kind: 'approval', approval: view })),
    )
  }

  // --- pairing -------------------------------------------------------------------------------------------------------

  async #receivePair(env: Envelope): Promise<void> {
    if (typeof env.pub !== 'string') return
    let msg: Extract<PhoneToPc, { kind: 'pair' }>
    try {
      msg = await open(await linkKey(this.#keys.boxPriv, env.pub, [this.#keys.id, env.from]), env)
    } catch {
      return
    }
    // Constant-time secret compare, then prove the device id is derived from the signing key it hands over (so the
    // relay cannot register a key for a room it does not own). Exactly the v1 daemon's two checks.
    const a = Buffer.from(String(msg.secret))
    const b = Buffer.from(this.#secret)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return
    if ((await deviceId(msg.signPub)) !== env.from) return

    const phone: LegacyPhone = {
      id: env.from,
      name: String(msg.name ?? 'Phone').slice(0, 40),
      boxPub: env.pub,
      signPub: msg.signPub,
    }
    this.#phones.set(phone.id, phone)
    // Register the raw Ed25519 device key with the daemon (converted to SPKI PEM there) so hasDevice() is true and the
    // v2 paths stay uniform. The v1 phone's own approvals ride its secure-chip keys, verified here, not this key.
    this.#agentd.registerDevice(msg.signPub)
    this.#log(`v1 phone paired: ${phone.name} (${phone.id.slice(0, 8)}…)`)
    await this.#send2(phone, { kind: 'paired', pcName: this.#pcName })
    await this.#sendState(phone)
  }

  // --- messages ------------------------------------------------------------------------------------------------------

  async #dispatch(phone: LegacyPhone, msg: PhoneToPc): Promise<void> {
    switch (msg.kind) {
      case 'hello':
        // The app's first message after the relay is ready (and again after every turn ends): reply with the current
        // state (so it leaves "connecting" and shows pending cards) and a health frame (so it can say how the PC is).
        await this.#sendState(phone)
        return this.#send2(phone, { kind: 'health', health: this.#health() })
      case 'ping':
        // Sent every minute while the app is open. A cheap health reply keeps the "connected" status honest.
        return this.#send2(phone, { kind: 'health', health: this.#health() })
      case 'approve-keys':
        return this.#receiveApproveKeys(phone, msg)
      case 'decide':
        return this.#receiveDecide(phone, msg)
      case 'conversation':
        // A history fetch (on connect, on resync, and "load earlier"): reply with the current ConversationState.
        return this.#sendConversation(phone, msg)
      case 'ask':
        // The user sent a message. Run one v2 turn and stream it back in the v1 shape (or queue it if already busy).
        return this.#receiveAsk(msg)
      case 'cancel':
      case 'conversation-cancel':
        // Stop the run now. The engine has no external abort seam yet, so this stops streaming + clears busy; the
        // in-flight turn finishes internally but its output is dropped (see the module header / PR note).
        return this.#cancel()
      case 'conversation-unqueue':
        return this.#unqueue(typeof msg.text === 'string' ? msg.text : '')
      case 'conversation-accept':
      case 'conversation-continue':
        // v2 has no finish-check draft / "left" state (ADR 0027 is a v1 concept), so there is nothing to accept or
        // continue here. Re-broadcast the current status so the app stays consistent; a later PR wires the real
        // lifecycle if v2 grows one.
        return this.#broadcastStatus()
      case 'use-agent':
        // The v2 daemon runs the single brain it was constructed with; switching the AI is not wired yet. Acknowledge
        // with the current state (the app expects a `state` reply) so the picker does not hang. (A later PR.)
        return this.#sendState(phone)
      case 'connections':
        return this.#send2(phone, { kind: 'connections', services: await this.#listConnections() })
      case 'connect':
        return this.#receiveConnect(phone, msg)
      case 'connect-login':
        return this.#receiveConnectLogin(phone, msg)
      case 'connect-social':
        // One-tap sign-in (Kakao/Naver…) needs the provider's own screen handed to the phone's remote view, which is
        // out of scope for THIS PR (screen/remote). Degrade with a clear result instead of leaving the card spinning.
        return this.#send2(phone, {
          kind: 'connect-result',
          id: String(msg.id),
          ok: false,
          message: this.#copy.socialNotReady,
        })
      case 'login':
        return this.#receiveLogin(phone, msg)
      case 'signup':
      case 'forgot':
        // "Sign me up" / "I don't know my account": close the login sheet being waited on so the turn can move past it
        // (v2 has no auto signup / id-recovery yet; the turn continues with a clear note). Cancels by site/origin host.
        return this.#cancelLoginForSite(typeof msg.site === 'string' ? msg.site : '')
      case 'info-answer':
        return this.#receiveInfoAnswer(msg)
      case 'vault-get':
        return this.#send2(phone, { kind: 'vault', entries: this.#vault?.phoneEntries() ?? [] })
      case 'vault-set':
      case 'vault-delete':
        return this.#receiveVaultEdit(phone, msg)
      case 'vault-reveal':
        return this.#receiveVaultReveal(phone, msg)
      case 'profile-get':
      case 'profile-set':
      case 'profile-clear':
        return this.#receiveProfile(phone, msg)
      // Screens (`screen`/`remote`), `push` (FCM) and `sms` stay out of scope for THIS PR; ignore them quietly so the
      // shipped app's reconnect fetches do not error. (Later PRs wire them.)
      default:
        return
    }
  }

  // --- conversation --------------------------------------------------------------------------------------------------

  /** A minimal, truthful PcHealth so the app can show "connected" instead of guessing the PC is silent. */
  #health(): PcHealth {
    return { at: this.#now(), issues: [], lagMs: 0, load: 0, agents: 1 }
  }

  /**
   * The running conversation as engine history: the visible user + assistant chat text, oldest first, capped to the
   * most recent HISTORY_MAX messages. `tool`/`system` rows (never produced here, but allowed by StoredMessage) are
   * dropped, so only the chat the user actually saw is carried — no tool JSON, no internal events, no secrets.
   */
  #history(): { role: 'user' | 'assistant'; content: string }[] {
    const chat = this.#messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text }))
    return chat.slice(Math.max(0, chat.length - HISTORY_MAX))
  }

  /** The current conversation as the app reads it (ConversationState). */
  #conversationState(limit: number): ConversationState {
    const n = Math.min(limit, this.#messages.length)
    const messages = this.#messages.slice(this.#messages.length - n)
    return {
      messages,
      busy: this.#busy,
      queued: [...this.#queued],
      hasMore: this.#messages.length > n,
    }
  }

  /** Answer a `conversation` history fetch. `before` is echoed back as the app expects; our in-memory log is small, so
   *  paging just returns the most recent `limit` messages (the app merges by id and dedupes). */
  async #sendConversation(
    phone: LegacyPhone,
    msg: Extract<PhoneToPc, { kind: 'conversation' }>,
  ): Promise<void> {
    const before = typeof msg.before === 'string' ? msg.before.slice(0, 80) : undefined
    const limit = Math.min(Math.max(Number(msg.limit) || CONV_DEFAULT_LIMIT, 1), CONV_MAX_LIMIT)
    return this.#send2(phone, {
      kind: 'conversation',
      state: this.#conversationState(limit),
      ...(before ? { before } : {}),
    })
  }

  /** The user sent a message. Queue it if a turn is already answering; otherwise run it now. */
  async #receiveAsk(msg: Extract<PhoneToPc, { kind: 'ask' }>): Promise<void> {
    const text = String(msg.text ?? '').slice(0, ASK_MAX)
    if (!text) return
    if (this.#busy) {
      this.#queued.push(text)
      return this.#broadcastStatus()
    }
    return this.#runTurn(text)
  }

  /**
   * Run one v2 engine turn for `text` and stream it to every paired phone in the v1 shape. The user message is saved
   * first (so the app's optimistic "sending" bubble resolves), then Agentd.send's events are mapped to `stream`
   * messages, then the assistant answer is saved and the turn is closed with `end`. `conversation-status` frames busy.
   */
  async #runTurn(text: string): Promise<void> {
    const turn: TurnState = { aborted: false }
    this.#turn = turn
    this.#busy = true

    // Capture the conversation so far — BEFORE appending this new user message — as history for the engine turn, so the
    // brain remembers the back-and-forth instead of answering each phone message in isolation. The new message is sent
    // separately (as `text`) and the engine appends it after the history; the assistant answer is saved to #messages
    // below, so the NEXT turn's history includes both this message and this answer.
    const history = this.#history()

    const user = this.#addMessage('user', text)
    await this.#broadcastStream({ type: 'saved', message: user })
    await this.#broadcastStatus()

    let answer = ''
    try {
      await this.#agentd.send(text, {
        history,
        onEvent: (ev) => {
          void this.#onEvent(turn, ev, (chunk) => {
            answer += chunk
          })
        },
      })
    } catch (err) {
      this.#log(`v1 chat turn failed: ${(err as Error).message}`)
    }

    // Finalize. On a cancel we already cleared busy and sent `end`, and we drop the (now meaningless) answer.
    if (!turn.aborted) {
      if (answer) {
        const assistant = this.#addMessage('assistant', answer)
        await this.#broadcastStream({ type: 'saved', message: assistant })
      }
      await this.#broadcastStream({ type: 'end' })
      this.#busy = false
      this.#turn = undefined
      await this.#broadcastStatus()
    }

    // Drain the next queued message (if any), whether this turn ended normally or was cancelled.
    const next = this.#queued.shift()
    if (next !== undefined) {
      await this.#broadcastStatus()
      await this.#runTurn(next)
    }
  }

  /**
   * Map one v2 turn event to the v1 wire so the shipped app shows live activity, not just the final answer. The app
   * renders a "work line" under the assistant: a step list it builds from `stream` `agent` `tool` events (its label is
   * `doing(title)`, which appends a progressive suffix, so a title is a bare Korean verb stem) and the streamed `text` as the answer,
   * framed busy/idle by `conversation-status` (owned by {@link #runTurn}). Korean wording lives in
   * @dool2/protocol/rich (workStatus, codeHandLabel), not inline here (ADR 0029). We map:
   *   - `thinking`      -> one reasoning status step per thinking run (coalesced; no chain-of-thought crosses the wire).
   *   - `tool_call`     -> a human Korean step. For the `code` hand it is derived from what the snippet does (open a
   *                        page, press, read the screen, fetch data…); never the raw code, a ref, a typed value, or a
   *                        full URL — only a short host for the "how it worked" sheet. Other tools keep their own label.
   *   - `text`          -> a streamed assistant chunk, accumulated for the saved answer (coalesced by the engine).
   *   - `approvalNeeded`-> a short "waiting for approval" status that leads into the signable card (announceApproval).
   *   - `blocked`       -> a short status for a hard-cap refusal (the reason itself is internal, kept off the wire).
   * `tool_result`, `gate` (its user-facing outcome rides `approvalNeeded`/`blocked`), `notice`, `draft` and `turn_end`
   * stay internal: the shipped work line has no shape for per-step done/failed or a free status, and {@link #runTurn}
   * already clears busy and closes the stream when the turn ends. Once the turn is cancelled, nothing more is forwarded.
   * No secrets or tool JSON cross this layer: every step carries a fixed Korean phrase and, at most, a masked host.
   */
  async #onEvent(turn: TurnState, ev: AgentdEvent, appendAnswer: (chunk: string) => void): Promise<void> {
    if (turn.aborted) return
    switch (ev.type) {
      case 'text':
        if (!ev.text) return
        turn.thinking = false
        appendAnswer(ev.text)
        return this.#broadcastStream({ type: 'agent', event: { type: 'text', delta: ev.text } })
      case 'thinking':
        // Dool2 is reasoning before it acts: show one status line for the run (the app also dedups a repeated line).
        if (turn.thinking) return
        turn.thinking = true
        return this.#broadcastStep({ title: workStatus('thinking') })
      case 'tool_call': {
        turn.thinking = false
        const code = codeOf(ev.args)
        if (code !== undefined) {
          const { label, host } = codeHandLabel(code)
          return this.#broadcastStep({ title: label, ...(host ? { detail: [{ k: 'url', v: host }] } : {}) })
        }
        // A non-code tool (a service tool): let the app label it from the tool name, and send no args (no secrets).
        return this.#broadcastStep({ name: ev.name })
      }
      case 'approvalNeeded':
        // The signable card is the lasting surface; a short live status leads the eye into it.
        turn.thinking = false
        await this.#broadcastStep({ title: workStatus('awaitingApproval') })
        return this.announceApproval(ev.card)
      case 'blocked':
        // A hard-cap refusal: a short status the user understands (the answer text that follows says more).
        turn.thinking = false
        return this.#broadcastStep({ title: workStatus('blocked') })
      default:
        // tool_result / notice / gate / draft / turn_end: not part of the shipped app's live work line (see above).
        return
    }
  }

  /**
   * Push one work-line step to every paired phone as the v1 `stream` `agent` `tool` shape the app renders. `title` is a
   * bare Korean stem the app turns into a progressive phrase; we send `name: 'code'` and an empty `input` so no raw args, code,
   * or URL reach the wire (the app derives the step's place from the name, which for `code` is Dool2's own work, and
   * never from secrets). A non-code tool passes its real name so the app can label it from its own tool table.
   */
  async #broadcastStep(step: { title?: string; name?: string; detail?: StepDetail[] }): Promise<void> {
    return this.#broadcastStream({
      type: 'agent',
      event: {
        type: 'tool',
        name: step.name ?? 'code',
        input: {},
        ...(step.title ? { title: step.title } : {}),
        ...(step.detail ? { detail: step.detail } : {}),
      },
    })
  }

  /** Stop the current run: drop its streamed output, clear busy, and close the stream so the app leaves "working". */
  async #cancel(): Promise<void> {
    if (this.#turn) this.#turn.aborted = true
    this.#turn = undefined
    this.#busy = false
    await this.#broadcastStream({ type: 'end' })
    return this.#broadcastStatus()
  }

  /** Remove a still-queued message (the app's "take back" on a line not yet read). */
  async #unqueue(text: string): Promise<void> {
    const t = text.slice(0, ASK_MAX)
    const i = this.#queued.indexOf(t)
    if (i >= 0) this.#queued.splice(i, 1)
    return this.#broadcastStatus()
  }

  #addMessage(role: StoredMessage['role'], text: string): StoredMessage {
    const message: StoredMessage = {
      id: `m${++this.#msgSeq}`,
      threadId: MAIN_THREAD,
      role,
      text,
      createdAt: new Date(this.#now()).toISOString(),
    }
    this.#messages.push(message)
    return message
  }

  // --- connections ---------------------------------------------------------------------------------------------------

  /** The connection list the phone shows: the provider's cards (connected + connectable), with this session's marks. */
  async #listConnections(): Promise<ConnectionItem[]> {
    const base = (await this.#connections?.()) ?? []
    return base.map((item) =>
      this.#connected.has(item.card.id) && !item.connectedAt
        ? { ...item, connectedAt: new Date(this.#now()).toISOString() }
        : item,
    )
  }

  /** The service card for an id, from the connections provider (for the site to bind a stored login to). */
  async #cardFor(id: string): Promise<ConnectionItem | undefined> {
    return (await this.#listConnections()).find((c) => c.card.id === id)
  }

  /**
   * A `connect` action from the phone. `mark`/`unmark` toggle this session's connected marks; `start` begins a
   * phone-first connection (asks the phone for the id/password and stores it in the vault when it answers). `open`,
   * `verify` and `chat` need PC Chrome / the remote screen, which is out of scope for THIS PR — they degrade quietly.
   */
  async #receiveConnect(phone: LegacyPhone, msg: Extract<PhoneToPc, { kind: 'connect' }>): Promise<void> {
    const id = String(msg.id)
    switch (msg.action) {
      case 'mark':
        this.#connected.add(id)
        return this.#send2(phone, { kind: 'connections', services: await this.#listConnections() })
      case 'unmark':
        this.#connected.delete(id)
        return this.#send2(phone, { kind: 'connections', services: await this.#listConnections() })
      case 'start': {
        // Phone-first (ADR 0041): ask the phone for the login and store it in the vault when it answers, then mark
        // connected. Runs in the background (the login sheet is already on the phone); the connection list refreshes
        // on its reply. A card without a site cannot be bound, so it degrades to a clear result.
        const item = await this.#cardFor(id)
        const origin = item?.card ? connectUrl(item.card) : undefined
        if (!origin) {
          return this.#send2(phone, {
            kind: 'connect-result',
            id,
            ok: false,
            message: this.#copy.connectCantStart,
          })
        }
        void this.requestLogin({ url: origin, connect: true, serviceId: id }).then(async (newId) => {
          if (newId) this.#connected.add(id)
          await this.#broadcast({ kind: 'connections', services: await this.#listConnections() })
        })
        return
      }
      default:
        // open / verify / chat: need PC Chrome or the remote screen (out of scope). Do not error the app.
        return
    }
  }

  /**
   * `connect-login`: the id/password the user put in the connect sheet. The secret goes straight into the vault (bound
   * to the service's site), NEVER to the AI, then the service is marked connected and any login request waiting on
   * that site is resolved so a running turn continues. Mirrors apps/daemon link.ts `connectLogin`.
   */
  async #receiveConnectLogin(
    phone: LegacyPhone,
    msg: Extract<PhoneToPc, { kind: 'connect-login' }>,
  ): Promise<void> {
    const id = String(msg.id)
    const username = String(msg.username ?? '').slice(0, USERNAME_MAX)
    const password = String(msg.password ?? '').slice(0, PASSWORD_MAX)
    const item = await this.#cardFor(id)
    const site = item?.card.site
    if (!this.#vault || !site) {
      return this.#send2(phone, {
        kind: 'connect-result',
        id,
        ok: false,
        message: this.#copy.connectUnavailable,
      })
    }
    this.#vault.upsertLogin({ site, username, password })
    this.#connected.add(id)
    // Resolve a login request waiting on this site (e.g. a mid-task fillLogin), so the running turn resumes.
    this.#resolveLoginForSite(site)
    this.#log(`v1 connect-login stored for ${id} (secret -> vault, never the AI)`)
    await this.#send2(phone, { kind: 'connect-result', id, ok: true, message: this.#copy.connected })
    await this.#broadcast({ kind: 'connections', services: await this.#listConnections() })
  }

  // --- login / info (mid-task phone-first, ADR 0011/0014/0041) -------------------------------------------------------

  /**
   * Ask the phone for a login mid-task: show a login sheet (`login-request`), and resolve once the phone sends
   * `login`/`connect-login` with the credentials — which are stored in the vault (never the AI) — to the NEW item's
   * id. This is the seam the engine's vault bridge calls (wired in the constructor) so Dool2 keeps going instead of
   * giving up; a connector/skill can call it too. Resolves to undefined on cancel/timeout.
   */
  async requestLogin(ctx: {
    url: string
    connect?: boolean
    serviceId?: string
  }): Promise<string | undefined> {
    const id = `lr${++this.#reqSeq}`
    const now = this.#now()
    const site = hostOf(ctx.url)
    const view: LoginRequestView = {
      id,
      tabId: -1,
      origin: ctx.url,
      site,
      status: 'pending',
      ...(ctx.connect ? { connect: true } : {}),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#requestTtlMs).toISOString(),
    }
    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pendingLogins.delete(id)) {
          resolve(undefined)
          void this.#broadcastState()
        }
      }, this.#requestTtlMs)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      this.#pendingLogins.set(id, { view, resolve, timer })
      void this.#broadcast({ kind: 'login-request', request: view })
      void this.#broadcastState()
    })
  }

  /**
   * Ask the phone for one value mid-task (a verification code, a pick, a prompt) and resolve to what it sends through
   * `info-answer` (undefined on cancel/timeout). Available for connectors/skills that need a person during a turn; the
   * value goes into that field only and is not stored or shown to the AI. Mirrors v1 `info-request`/`info-answer`.
   */
  async requestInfo(req: Omit<InfoRequestView, 'id' | 'status' | 'expiresAt'>): Promise<string | undefined> {
    const id = `ir${++this.#reqSeq}`
    const view: InfoRequestView = {
      ...req,
      id,
      status: 'pending',
      expiresAt: new Date(this.#now() + this.#requestTtlMs).toISOString(),
    }
    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pendingInfos.delete(id)) {
          resolve(undefined)
          void this.#broadcastState()
        }
      }, this.#requestTtlMs)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      this.#pendingInfos.set(id, { view, resolve, timer })
      void this.#broadcast({ kind: 'info-request', request: view })
      void this.#broadcastState()
    })
  }

  /** A `login` reply from the phone: store the id/password in the vault and resume the turn that asked for it. */
  async #receiveLogin(phone: LegacyPhone, msg: Extract<PhoneToPc, { kind: 'login' }>): Promise<void> {
    const reqId = String(msg.id)
    const pending = this.#pendingLogins.get(reqId)
    const username = String(msg.username ?? '').slice(0, USERNAME_MAX)
    const password = String(msg.password ?? '').slice(0, PASSWORD_MAX)
    if (!pending || !this.#vault) {
      return this.#send2(phone, {
        kind: 'login-done',
        id: reqId,
        ok: false,
        message: this.#copy.loginExpired,
      })
    }
    clearTimeout(pending.timer)
    this.#pendingLogins.delete(reqId)
    const newId = this.#vault.upsertLogin({ site: pending.view.site, username, password })
    pending.resolve(newId)
    this.#log(`v1 login stored (secret -> vault, never the AI); turn resumes`)
    // Success is reflected in the refreshed state (the sheet closes); a login-done also tells the sheet it is saved.
    await this.#broadcast({ kind: 'login-done', id: reqId, ok: true, message: this.#copy.loginSaved })
    await this.#broadcastState()
  }

  /** An `info-answer` from the phone: feed the value back into the waiting request so the turn continues. */
  async #receiveInfoAnswer(msg: Extract<PhoneToPc, { kind: 'info-answer' }>): Promise<void> {
    const id = String(msg.id)
    const pending = this.#pendingInfos.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pendingInfos.delete(id)
    pending.resolve(typeof msg.value === 'string' ? msg.value : undefined)
    await this.#broadcast({ kind: 'info-done', id })
    await this.#broadcastState()
  }

  /** Resolve a pending login request bound to `site` (host-matched) with its freshly stored item — the turn resumes. */
  #resolveLoginForSite(site: string): void {
    const host = hostOf(`https://${site}`)
    for (const [id, pending] of this.#pendingLogins) {
      if (hostOf(`https://${pending.view.site}`) !== host) continue
      clearTimeout(pending.timer)
      this.#pendingLogins.delete(id)
      const item = this.#vault?.phoneEntries().find((e) => hostOf(e.origin) === host)
      pending.resolve(item?.id)
    }
  }

  /** Cancel any login request bound to `site` (the user chose sign-up / "I don't know my account"). Turn gets undefined. */
  #cancelLoginForSite(site: string): void {
    const host = hostOf(site.includes('://') ? site : `https://${site}`)
    for (const [id, pending] of this.#pendingLogins) {
      if (host && hostOf(`https://${pending.view.site}`) !== host) continue
      clearTimeout(pending.timer)
      this.#pendingLogins.delete(id)
      pending.resolve(undefined)
    }
    void this.#broadcastState()
  }

  // --- vault + profile (ADR 0011/0026; secrets never cross to the AI, only masked views over the relay) -------------

  /** `vault-set` (edit id/password) or `vault-delete`. Replies with the refreshed masked list and a short result. */
  async #receiveVaultEdit(
    phone: LegacyPhone,
    msg: Extract<PhoneToPc, { kind: 'vault-set' | 'vault-delete' }>,
  ): Promise<void> {
    const id = String(msg.id).slice(0, 60)
    const c = this.#copy
    let message: string
    if (!this.#vault) {
      message = c.vaultUnavailable
    } else if (msg.kind === 'vault-delete') {
      message = this.#vault.delete(id) ? c.vaultDeleted : c.vaultNoItem
    } else {
      const str = (v: unknown): string | undefined =>
        typeof v === 'string' && v ? v.slice(0, PASSWORD_MAX) : undefined
      const ok = this.#vault.setLogin(id, {
        ...(str(msg.username) ? { username: str(msg.username) } : {}),
        ...(str(msg.password) ? { password: str(msg.password) } : {}),
      })
      message = ok ? c.vaultSaved : c.vaultNoItem
    }
    return this.#send2(phone, { kind: 'vault', entries: this.#vault?.phoneEntries() ?? [], message })
  }

  /**
   * `vault-reveal`: show one password ON THE PHONE ONLY (never the AI). Gated on the vault being unlocked (ADR 0011);
   * when locked, no secret is returned — only the list with a note. The secret crosses to the already-trusted paired
   * phone over e2e, which is NOT the AI boundary.
   */
  async #receiveVaultReveal(
    phone: LegacyPhone,
    msg: Extract<PhoneToPc, { kind: 'vault-reveal' }>,
  ): Promise<void> {
    const id = String(msg.id).slice(0, 60)
    if (!this.#vault) {
      return this.#send2(phone, { kind: 'vault', entries: [], message: this.#copy.vaultUnavailable })
    }
    if (!this.#vault.isUnlocked()) {
      return this.#send2(phone, {
        kind: 'vault',
        entries: this.#vault.phoneEntries(),
        message: this.#copy.vaultLocked,
      })
    }
    const secret = this.#vault.reveal(id)
    if (!secret) {
      return this.#send2(phone, {
        kind: 'vault',
        entries: this.#vault.phoneEntries(),
        message: this.#copy.vaultNoItem,
      })
    }
    return this.#send2(phone, {
      kind: 'vault-secret',
      id,
      username: secret.username,
      password: secret.password,
    })
  }

  /** `profile-get/set/clear`: the user's "my info". Values are returned masked; nothing here is a password or card. */
  async #receiveProfile(
    phone: LegacyPhone,
    msg: Extract<PhoneToPc, { kind: 'profile-get' | 'profile-set' | 'profile-clear' }>,
  ): Promise<void> {
    if (msg.kind === 'profile-clear') {
      this.#profile.clear()
    } else if (msg.kind === 'profile-set') {
      const values = msg.values && typeof msg.values === 'object' ? msg.values : {}
      for (const [k, v] of Object.entries(values).slice(0, 20)) {
        if (typeof v === 'string') this.#profile.set(k.slice(0, 40), v.slice(0, 200))
      }
    }
    const have: Record<string, string> = {}
    for (const [k, v] of this.#profile) have[k] = maskValue(v)
    return this.#send2(phone, { kind: 'profile', have, missing: [], payChoices: {} })
  }

  // --- broadcasting --------------------------------------------------------------------------------------------------

  /** Push the current state to every paired phone (so open login/info requests and marks show up everywhere). */
  async #broadcastState(): Promise<void> {
    await Promise.all([...this.#phones.values()].map((phone) => this.#sendState(phone)))
  }

  /** Send one message to every paired phone (new approvals, streamed chat, status). No-op when none have paired. */
  async #broadcast(body: PcToPhone): Promise<void> {
    await Promise.all([...this.#phones.values()].map((phone) => this.#send2(phone, body)))
  }

  /** Stream one conversation event to every paired phone under the main thread. */
  async #broadcastStream(event: DaemonStreamEvent): Promise<void> {
    return this.#broadcast({ kind: 'stream', threadId: MAIN_THREAD, event })
  }

  /** Tell every paired phone whether the conversation is answering and what is queued. */
  async #broadcastStatus(): Promise<void> {
    return this.#broadcast({ kind: 'conversation-status', busy: this.#busy, queued: [...this.#queued] })
  }

  /**
   * Register this phone's P-256 secure-chip approval keys (ADR 0043), signed with its Ed25519 pairing key
   * (approveKeysSignText). Ported from apps/daemon link.ts: registered once and only a missing pay key may be added
   * later (same plain key), the request must be fresh, and the signature must verify. On success the phone's money
   * approvals must use these chip keys instead of the pairing key.
   */
  async #receiveApproveKeys(
    phone: LegacyPhone,
    msg: Extract<PhoneToPc, { kind: 'approve-keys' }>,
  ): Promise<void> {
    const keys = { plain: String(msg.plain ?? ''), ...(msg.pay ? { pay: String(msg.pay) } : {}) }
    const at = Number(msg.at)
    const fresh = !phone.approveKeys
    const addPay = Boolean(
      phone.approveKeys && !phone.approveKeys.pay && keys.pay && keys.plain === phone.approveKeys.plain,
    )
    if (
      (fresh || addPay) &&
      SPKI_RE.test(keys.plain) &&
      (!keys.pay || SPKI_RE.test(keys.pay)) &&
      Number.isFinite(at) &&
      Math.abs(this.#now() - at) <= FRESH_MS &&
      typeof msg.sig === 'string' &&
      (await verifyText(phone.signPub, approveKeysSignText(keys, at), msg.sig))
    ) {
      phone.approveKeys = keys
      phone.payConfirm = Boolean(keys.pay)
      this.#log(`v1 phone approve-keys registered: ${phone.name} (pay=${Boolean(keys.pay)})`)
    }
    return this.#sendState(phone)
  }

  /**
   * A `decide` on an approval. Find the exact view by id, verify the phone's free-text signature with the right key
   * (ported from apps/daemon link.ts `approvalSigned`), and, on an `approve`, resume the real gated action through
   * Agentd.approveVerified(). The chosen payment method/installment/delivery (`choice`) is bound into the signature,
   * so it is verified too; it is recorded and surfaced to the host, but v2's single-action ActionEnvelope cannot yet
   * carry a method/installment/delivery pick (see the PR note).
   */
  async #receiveDecide(phone: LegacyPhone, msg: Extract<PhoneToPc, { kind: 'decide' }>): Promise<void> {
    const view = this.#views.get(msg.id)
    if (!view) {
      return this.#send2(phone, { kind: 'decided', id: msg.id, ok: false, message: 'No such approval' })
    }
    const choice = typeof msg.choice === 'string' && msg.choice ? msg.choice : undefined
    const ok = await this.#approvalSigned(phone, view, msg.decision, choice, msg.sig, msg.key)
    if (!ok) {
      return this.#send2(phone, { kind: 'decided', id: msg.id, ok: false, message: 'Bad signature' })
    }
    if (msg.decision === 'reject') {
      this.#views.delete(msg.id)
      return this.#send2(phone, { kind: 'decided', id: msg.id, ok: true, message: 'Declined' })
    }
    const r = this.#agentd.approveVerified(view.id, this.#now())
    if (!r.ok) {
      return this.#send2(phone, { kind: 'decided', id: msg.id, ok: false, message: r.reason })
    }
    this.#views.delete(msg.id)
    this.#onApproved?.({ hash: view.id, ...(choice ? { choice } : {}) })
    this.#log(`v1 approval verified + resumed: ${view.label}${choice ? ` (choice ${choice})` : ''}`)
    return this.#send2(phone, { kind: 'decided', id: msg.id, ok: true, message: 'Approved' })
  }

  /**
   * Verify the phone's approval signature. Ported verbatim in intent from apps/daemon link.ts `approvalSigned`:
   * - no chip keys registered → the Ed25519 pairing key signs the text (verifyText);
   * - chip keys registered → the P-256 key signs the text (verifyP256, `SHA256withECDSA`). A money `approve` must use
   *   the `pay` key when one exists and payConfirm is on; everything else uses the `plain` key.
   */
  async #approvalSigned(
    phone: LegacyPhone,
    view: ApprovalView,
    decision: 'approve' | 'reject',
    choice: string | undefined,
    sig: string,
    key: 'pay' | 'plain' | undefined,
  ): Promise<boolean> {
    const text = approvalSignText(view, decision, choice)
    const keys = phone.approveKeys
    if (!keys) return verifyText(phone.signPub, text, sig)
    const needPay =
      decision === 'approve' && view.kind === 'money' && Boolean(keys.pay) && phone.payConfirm !== false
    const spki = key === 'pay' ? keys.pay : key === 'plain' && !needPay ? keys.plain : undefined
    return Boolean(spki) && verifyP256(spki as string, text, sig)
  }

  // --- views + sending -----------------------------------------------------------------------------------------------

  /** Map a v2 ApprovalCard to a v1 ApprovalView, memoized by hash so the daemon and phone hold identical bytes. */
  #viewFor(card: ApprovalCard): ApprovalView {
    const existing = this.#views.get(card.hash)
    if (existing) return existing
    const now = this.#now()
    const view: ApprovalView = {
      id: card.hash,
      tabId: -1,
      ref: '',
      role: '',
      label: card.label,
      url: card.envelope.site ?? '',
      kind: tierToKind(card.tier),
      reason: card.reason,
      what: card.reason || card.label,
      where: card.envelope.site ?? '',
      ...(card.amountKrw !== undefined ? { amount: String(card.amountKrw) } : {}),
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(card.expiresAt).toISOString(),
    }
    this.#views.set(card.hash, view)
    return view
  }

  /** A minimal v1 `state` message: enough for the shipped app to leave "connecting", show pending cards, and sync
   *  its secure-chip keys (its `state` handler calls syncApproveKeys). Chat/thread fields are empty (out of scope). */
  async #sendState(phone: LegacyPhone): Promise<void> {
    // Surface every pending approval as a (memoized) view, so a phone that reconnects sees the current queue.
    const approvals = this.#agentd.pending().map((card) => this.#viewFor(card))
    const logins = [...this.#pendingLogins.values()].map((p) => p.view)
    const infos = [...this.#pendingInfos.values()].map((p) => p.view)
    const state: Extract<PcToPhone, { kind: 'state' }> = {
      kind: 'state',
      pcName: this.#pcName,
      agents: [],
      extension: false,
      threads: [],
      approvals,
      ...(logins.length ? { logins } : {}),
      ...(infos.length ? { infos } : {}),
      approveKeys: Boolean(phone.approveKeys),
      payKey: Boolean(phone.approveKeys?.pay),
      payConfirm: Boolean(phone.approveKeys?.pay && phone.payConfirm !== false),
    }
    return this.#send2(phone, state)
  }

  async #keyFor(id: string, boxPub: string): Promise<LinkKey> {
    const cached = this.#keyCache.get(id)
    if (cached) return cached
    const k = await linkKey(this.#keys.boxPriv, boxPub, [this.#keys.id, id])
    this.#keyCache.set(id, k)
    return k
  }

  #nextSeq(to: string): number {
    const n = (this.#outSeq.get(to) ?? this.#now()) + 1
    this.#outSeq.set(to, n)
    return n
  }

  async #send2(phone: LegacyPhone, body: PcToPhone): Promise<void> {
    const k = await this.#keyFor(phone.id, phone.boxPub)
    const env = await seal(
      k,
      { v: LINK_VERSION, from: this.#keys.id, to: phone.id, kind: body.kind, seq: this.#nextSeq(phone.id) },
      body,
    )
    this.#send(env)
  }
}

/** Map a v2 ActionTier to the v1 ApprovalView.kind the shipped app understands. */
function tierToKind(tier: ActionTier): ApprovalView['kind'] {
  switch (tier) {
    case 'pay':
      return 'money'
    case 'contact':
      return 'contact'
    default:
      return 'irreversible'
  }
}

/** The lower-case host of an http(s) URL (for binding a login to a site), or '' when it is not parseable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Mask a profile value so the phone can show it without echoing it in full (never a secret, but still the user's). */
function maskValue(v: string): string {
  if (v.length <= 2) return '••'
  if (v.includes('@')) {
    const [name, domain] = v.split('@')
    return `${(name ?? '').slice(0, 1)}***@${domain ?? ''}`
  }
  return `${v.slice(0, 1)}${'•'.repeat(Math.min(6, Math.max(2, v.length - 2)))}${v.slice(-1)}`
}

/** The `code` string a `code`-hand tool call carries (`{ code: '…' }`), or undefined for any other tool. */
function codeOf(args: unknown): string | undefined {
  if (args && typeof args === 'object' && 'code' in args) {
    const c = (args as { code?: unknown }).code
    if (typeof c === 'string') return c
  }
  return undefined
}
