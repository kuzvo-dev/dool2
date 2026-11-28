// v1-compat phone link (ADR 0012, 0043). This is the daemon-side handler that lets the ALREADY-SHIPPED Capacitor
// phone app (apps/phone on origin/main) pair with and sign approvals against the v2 daemon, WITHOUT rebuilding the app
// and without touching the relay wire or the e2e crypto (both byte-identical between v1 and v2). The v2 relay bridge
// (relay-bridge.ts) speaks the new `pair-rpc` protocol; this sits alongside it and speaks the v1 envelope kinds the
// shipped app sends: `pair`, `approve-keys`, `decide`. It is a reduced port of apps/daemon/src/link.ts (PhoneLink):
// pairing + approval only — chat, screens, connections and the rest are out of scope (a later PR).
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
import type { ApprovalView, PairInvite, PcToPhone, PhoneToPc } from '@dool2/protocol'
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
import type { Agentd, ApprovalCard } from './agentd.js'

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
        return this.#sendState(phone)
      case 'ping':
        return
      case 'approve-keys':
        return this.#receiveApproveKeys(phone, msg)
      case 'decide':
        return this.#receiveDecide(phone, msg)
      // Chat, connections, life, screens and the rest are out of scope for this v1-compat PR; ignore them quietly so
      // the shipped app's reconnect fetches do not error. (A later PR wires chat.)
      default:
        return
    }
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
