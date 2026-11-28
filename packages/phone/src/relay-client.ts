// RelayPhoneClient: the phone-side client that reaches a RUNNING daemon THROUGH A RELAY, so a real phone on another
// network can pair and sign approvals without ever reaching the daemon's loopback HTTP. It is the relay twin of
// DaemonHttpClient (http-client.ts): it satisfies the same two seams the rest of the package drives —
//
//   - DeviceRegistrar (pairing.ts):  registerDevice(publicKeyPem) -> a code-gated `pair` RPC over the relay. Only the
//                                    PUBLIC key crosses the wire; the daemon checks the short pairing code and, on
//                                    success, returns a SCOPED token (pending+approve only), kept privately here. The
//                                    phone never holds the daemon's loopback admin token.
//   - ApprovalTransport (sign.ts):   approve(hash, signature) -> an `approve` RPC carrying the scoped token. So
//                                    `respond`/`approveCard`/`PhoneSimulator` work over the relay unchanged.
//
// Every message is end-to-end encrypted (@dool2/protocol e2e) inside a relay envelope; the relay moves ciphertext
// only. This client holds the phone's RELAY keypair (for the link) and the scoped token (opaque to it), never a
// device signing key and never a secret — the approval signature is made by the keystore seam elsewhere and only
// passed through here.

import type { ActionEnvelope } from '@dool2/approvals'
import { type DeviceKeys, type Envelope, generateDevice, linkKey, open, seal } from '@dool2/protocol/e2e'
import { LinkClient, type LinkOptions } from '@dool2/protocol/link'
import {
  type Capability,
  type PairingOffer,
  type PairRpcRequest,
  type PairRpcResponse,
  RELAY_RPC_KIND,
} from '@dool2/protocol/pair-rpc'
import type { ApprovalNeeded } from './approval-card.js'
import type { DeviceRegistrar } from './pairing.js'
import type { ApprovalTransport, RespondResult } from './sign.js'

type LinkKey = Awaited<ReturnType<typeof linkKey>>

export interface RelayPhoneClientOptions {
  /** The pairing offer scanned from the desktop QR (or read from the app URL): relay + room + boxPub + code. */
  offer: PairingOffer
  /** The phone's relay identity keypair. A fresh non-extractable one is minted when omitted. */
  keys?: DeviceKeys
  /** A stable device id sent at pairing, so a re-pair replaces the same device. Random if omitted. */
  deviceId?: string
  /** A human device name for the daemon's device list. Optional. */
  label?: string
  /** WebSocket implementation (Node passes `ws`; the browser uses the global). */
  WebSocketImpl?: LinkOptions['WebSocketImpl']
  /** How long to wait for a reply to one RPC before giving up. Default 10 s. */
  requestTimeoutMs?: number
}

interface Waiter {
  resolve: (res: PairRpcResponse) => void
  timer: ReturnType<typeof setTimeout>
}

/** A phone client over the relay. Implements DeviceRegistrar + ApprovalTransport, so it drops into pairDevice,
 *  respond, approveCard and PhoneSimulator just like DaemonHttpClient does for loopback. */
export class RelayPhoneClient implements DeviceRegistrar, ApprovalTransport {
  readonly #offer: PairingOffer
  readonly #deviceId: string
  readonly #label: string | undefined
  readonly #timeout: number
  readonly #waiters = new Map<string, Waiter>()
  #keys: DeviceKeys | undefined
  #presetKeys: DeviceKeys | undefined
  #link: LinkClient | undefined
  readonly #WebSocketImpl: LinkOptions['WebSocketImpl'] | undefined
  #key: LinkKey | undefined
  #ready: Promise<void> | undefined
  #rid = 0
  #seq = 0
  /** The scoped token the daemon issued at pairing. Opaque to the phone; carried on every later request. */
  #token: string | undefined
  #scope: Capability[] = []

  constructor(opts: RelayPhoneClientOptions) {
    this.#offer = opts.offer
    this.#presetKeys = opts.keys
    this.#deviceId = opts.deviceId ?? cryptoRandomId()
    this.#label = opts.label
    this.#WebSocketImpl = opts.WebSocketImpl
    this.#timeout = opts.requestTimeoutMs ?? 10_000
  }

  /** The device id this client pairs under. */
  get deviceId(): string {
    return this.#deviceId
  }

  /** The scoped token issued at pairing (undefined before pairing). The phone treats it as opaque. */
  get token(): string | undefined {
    return this.#token
  }

  /** The capabilities the scoped token carries (as the daemon reported them). */
  get scope(): readonly Capability[] {
    return this.#scope
  }

  /** Open the relay connection and derive the shared end-to-end key. Idempotent. */
  async connect(): Promise<void> {
    this.#ready ??= this.#open()
    return this.#ready
  }

  async #open(): Promise<void> {
    const keys = this.#presetKeys ?? (await generateDevice(false))
    this.#keys = keys
    this.#key = await linkKey(keys.boxPriv, this.#offer.boxPub, [keys.id, this.#offer.room])
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay-connect-timeout')), this.#timeout)
      const link = new LinkClient({
        relay: this.#offer.relay,
        role: 'phone',
        keys,
        room: this.#offer.room,
        onEnvelope: (env) => void this.#onEnvelope(env),
        onState: (state) => {
          if (state === 'ready') {
            clearTimeout(timer)
            resolve()
          }
        },
        ...(this.#WebSocketImpl ? { WebSocketImpl: this.#WebSocketImpl } : {}),
      })
      this.#link = link
      link.start()
    })
  }

  async #onEnvelope(env: Envelope): Promise<void> {
    if (env.kind !== RELAY_RPC_KIND || !this.#key) return
    let res: PairRpcResponse
    try {
      res = await open<PairRpcResponse>(this.#key, env)
    } catch {
      return
    }
    const waiter = this.#waiters.get(res.rid)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.#waiters.delete(res.rid)
    waiter.resolve(res)
  }

  async #rpc(make: (rid: string) => PairRpcRequest): Promise<PairRpcResponse> {
    await this.connect()
    if (!this.#keys || !this.#key || !this.#link) throw new Error('relay not connected')
    const rid = `r${++this.#rid}`
    const req = make(rid)
    const env = await seal(
      this.#key,
      {
        v: 1,
        from: this.#keys.id,
        to: this.#offer.room,
        kind: RELAY_RPC_KIND,
        seq: ++this.#seq,
        pub: this.#keys.boxPub,
      },
      req,
    )
    const reply = new Promise<PairRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(rid)
        reject(new Error('relay-timeout'))
      }, this.#timeout)
      this.#waiters.set(rid, { resolve, timer })
    })
    this.#link.send(env)
    return reply
  }

  /**
   * DeviceRegistrar seam: run the code-gated `pair` RPC. Sends the pairing code (from the offer) + the device PUBLIC
   * key; on success stores the scoped token the daemon issues. Throws on failure so pairDevice reports the reason.
   */
  async registerDevice(publicKeyPem: string): Promise<void> {
    const res = await this.#rpc((rid) => ({
      rid,
      t: 'pair',
      code: this.#offer.code,
      deviceId: this.#deviceId,
      publicKeyPem,
      ...(this.#label !== undefined ? { label: this.#label } : {}),
    }))
    if (res.t !== 'paired' || !res.ok) {
      throw new Error(`pair failed: ${res.t === 'paired' ? res.reason : res.t}`)
    }
    this.#token = res.token
    this.#scope = res.scope
  }

  /** GET-like: the approval cards awaiting a signature, over the relay (needs the scoped token). */
  async pending(): Promise<ApprovalNeeded[]> {
    if (!this.#token) throw new Error('not paired')
    const res = await this.#rpc((rid) => ({ rid, t: 'pending', token: this.#token as string }))
    if (res.t !== 'pending' || !res.ok)
      throw new Error(`pending failed: ${res.t === 'pending' ? res.reason : res.t}`)
    return res.cards.map((c) => ({
      hash: c.hash,
      envelope: c.envelope as ActionEnvelope,
      ...(c.expiresAt !== undefined ? { expiresAt: c.expiresAt } : {}),
    }))
  }

  /** ApprovalTransport seam: send a signature back for one card (needs the scoped token). */
  async approve(hash: string, signature: string): Promise<RespondResult> {
    if (!this.#token) return { ok: false, reason: 'not-paired' }
    const res = await this.#rpc((rid) => ({
      rid,
      t: 'approve',
      token: this.#token as string,
      hash,
      signature,
    }))
    if (res.t !== 'approve') return { ok: false, reason: 'bad-response' }
    return { ok: res.ok, ...(res.reason !== undefined ? { reason: res.reason } : {}) }
  }

  /**
   * Attempt an admin operation with the scoped token. The relay bridge always refuses it (no relay token carries the
   * `admin` capability), so this returns `{ ok: false, reason: 'forbidden' }`. Exposed so the capability boundary is
   * exercised directly; the phone app never calls it.
   */
  async callAdmin(op: string): Promise<RespondResult> {
    if (!this.#token) return { ok: false, reason: 'not-paired' }
    const res = await this.#rpc((rid) => ({ rid, t: 'admin', token: this.#token as string, op }))
    if (res.t !== 'admin') return { ok: false, reason: 'bad-response' }
    return { ok: res.ok, reason: res.reason }
  }

  /** Close the relay connection. */
  close(): void {
    this.#link?.stop()
    for (const w of this.#waiters.values()) clearTimeout(w.timer)
    this.#waiters.clear()
  }
}

/** A random-ish device id without pulling node:crypto (works in the browser bundle too). */
function cryptoRandomId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
