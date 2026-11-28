// v1-compat phone link (ADR 0012, 0043). This is the daemon-side handler that lets the ALREADY-SHIPPED Capacitor
// phone app (apps/phone on origin/main) pair with and sign approvals against the v2 daemon, WITHOUT rebuilding the app
// and without touching the relay wire or the e2e crypto (both byte-identical between v1 and v2). The v2 relay bridge
// (relay-bridge.ts) speaks the new `pair-rpc` protocol; this sits alongside it and speaks the v1 envelope kinds the
// shipped app sends: `pair`, `approve-keys`, `decide`, plus the CONVERSATION subset (`hello`/`ping`, `conversation`,
// `ask`, `cancel`/`conversation-cancel`, the `conversation-accept`/`continue`/`unqueue` queue controls, `use-agent`).
// It is a reduced port of apps/daemon/src/link.ts (PhoneLink): pairing + approval + chat. Screens (`screen`/`remote`),
// connections (`connect*`), `life`, vault/`login`/`profile`/`sms` and `push` are still out of scope (a later PR); a
// tab that sends one of those stays empty for now.
//
// Chat core: a `conversation` request is answered with the current ConversationState (history + busy + queued), and an
// `ask` runs one v2 engine turn (Agentd.send) whose events are mapped to the v1 `stream` shape the app renders — text
// chunks -> `{type:'agent',event:{type:'text',delta}}`, tool calls -> a subtle `{type:'tool'}` working step, the final
// answer -> a `saved` assistant message then `end`, framed by `conversation-status` (busy). Approvals still surface as
// cards (announceApproval -> `decide` -> approveVerified), unchanged. The v2 engine has no external abort seam yet, so
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
import type {
  ApprovalView,
  ConversationState,
  DaemonStreamEvent,
  PairInvite,
  PcHealth,
  PcToPhone,
  PhoneToPc,
  StoredMessage,
} from '@dool2/protocol'
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
import type { Agentd, AgentdEvent, ApprovalCard } from './agentd.js'

/** The thread id the shipped app's MAIN conversation runs under. Anything not in `state.threads` (we send none) and
 *  not the open side thread is treated as the main chat by the app (threads.ts isSideThread), so a stable constant is
 *  enough: every `stream`/`conversation` reply carries it and the app routes it to the main conversation screen. */
const MAIN_THREAD = 'main'

/** How many conversation messages one `conversation` reply carries by default (the shipped app asks with no limit). */
const CONV_DEFAULT_LIMIT = 60
const CONV_MAX_LIMIT = 200

/** The shipped app caps a sent message at 4000 chars (apps/daemon link.ts `ask`); mirror it so replies match. */
const ASK_MAX = 4000

/** A P-256 approve-key as SPKI DER in base64url (~122 chars). The same guard the v1 daemon used (apps/daemon link.ts). */
const SPKI_RE = /^[\w-]{100,200}$/

/** How long a signed v1 request (`approve-keys`) may be in the past/future before it is a stale replay. */
const FRESH_MS = 120_000

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
  /** The turn answering now, if any. `aborted` is flipped by a `cancel` so its streamed output is dropped. */
  #turn: { aborted: boolean } | undefined

  constructor(opts: LegacyPhoneLinkOptions) {
    this.#keys = opts.keys
    this.#agentd = opts.agentd
    this.#secret = opts.secret
    this.#relayUrl = opts.relayUrl
    this.#send = opts.send
    this.#pcName = opts.pcName || hostname().replace(/\.local$/, '')
    this.#onApproved = opts.onApproved
    this.#now = opts.now ?? Date.now
    this.#log = opts.log ?? (() => {})
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
      // Screens, connections, life, vault/login/profile/sms and push are out of scope for THIS PR; ignore them quietly
      // so the shipped app's reconnect fetches do not error. (Later PRs wire them.)
      default:
        return
    }
  }

  // --- conversation --------------------------------------------------------------------------------------------------

  /** A minimal, truthful PcHealth so the app can show "connected" instead of guessing the PC is silent. */
  #health(): PcHealth {
    return { at: this.#now(), issues: [], lagMs: 0, load: 0, agents: 1 }
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
    const turn: { aborted: boolean } = { aborted: false }
    this.#turn = turn
    this.#busy = true

    const user = this.#addMessage('user', text)
    await this.#broadcastStream({ type: 'saved', message: user })
    await this.#broadcastStatus()

    let answer = ''
    try {
      await this.#agentd.send(text, {
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
   * Map one v2 turn event to the v1 wire. Text becomes a streamed assistant chunk (and is accumulated for the saved
   * answer); a tool call becomes a subtle working step; an approval surfaces as a card through the existing path.
   * Everything else (thinking, tool results, gate logs, blocked, drafts, turn_end) is internal and not shown as chat.
   * Once the turn is cancelled, nothing more is forwarded.
   */
  async #onEvent(
    turn: { aborted: boolean },
    ev: AgentdEvent,
    appendAnswer: (chunk: string) => void,
  ): Promise<void> {
    if (turn.aborted) return
    switch (ev.type) {
      case 'text':
        if (!ev.text) return
        appendAnswer(ev.text)
        return this.#broadcastStream({ type: 'agent', event: { type: 'text', delta: ev.text } })
      case 'tool_call':
        return this.#broadcastStream({
          type: 'agent',
          event: { type: 'tool', name: ev.name, input: ev.args },
        })
      case 'approvalNeeded':
        return this.announceApproval(ev.card)
      default:
        // thinking / tool_result / notice / gate / blocked / draft / turn_end: not part of the rendered chat.
        return
    }
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

  // --- broadcasting --------------------------------------------------------------------------------------------------

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
    const state: Extract<PcToPhone, { kind: 'state' }> = {
      kind: 'state',
      pcName: this.#pcName,
      agents: [],
      extension: false,
      threads: [],
      approvals,
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
