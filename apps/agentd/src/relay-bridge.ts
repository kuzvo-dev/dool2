// The daemon's relay bridge: the path that lets a REAL phone (a separate device, over the internet) pair and sign
// approvals without the daemon opening any inbound port. The daemon connects OUTWARD to a relay (ADR 0012) as the
// "pc" party of its own room, and speaks the small pairing/approval RPC (@dool2/protocol/pair-rpc) with phones that
// join the same room. Every message is end-to-end encrypted (e2e.ts): the relay moves ciphertext only — it cannot
// read a card or a secret, and, lacking the phone's device signing key, it cannot forge an approval.
//
// What it does NOT do: it never puts the daemon's loopback admin token on the wire. Pairing is authorized by the
// short CODE the desktop shows (single-use, short-TTL); on success the daemon mints a SCOPED token (capabilities
// `pending`+`approve`, bound to that device) and returns it to the phone over the relay. Every later pending/approve
// request carries that scoped token, which can do nothing admin. The daemon's own loopback HTTP guard (http.ts) is
// untouched and stays strict — the phone never touches it.

import { randomBytes } from 'node:crypto'
import { type DeviceKeys, type Envelope, generateDevice, linkKey, open, seal } from '@dool2/protocol/e2e'
import { LinkClient, type LinkOptions } from '@dool2/protocol/link'
import {
  type Capability,
  PAIRING_OFFER_VERSION,
  type PairingOffer,
  type PairRpcCard,
  type PairRpcRequest,
  type PairRpcResponse,
  PHONE_SCOPE,
  pairingUrl,
  RELAY_RPC_KIND,
} from '@dool2/protocol/pair-rpc'
import type { Agentd, ApprovalCard } from './agentd.js'

/** Default life of a pairing code once the bridge starts offering it: long enough to scan, short enough to matter. */
const DEFAULT_PAIRING_TTL_MS = 10 * 60_000

/** The shared end-to-end key type, taken from linkKey so we never name a DOM/global CryptoKey directly. */
type LinkKey = Awaited<ReturnType<typeof linkKey>>

export interface RelayBridgeOptions {
  /** The daemon this bridge pairs phones with and clears approvals through. */
  agentd: Agentd
  /** The relay base URL (http(s)://…). The daemon opens an OUTBOUND WebSocket to it; no inbound port is needed. */
  relayUrl: string
  /** The short pairing code the desktop shows the user. Single-use: spent on the first successful pair. */
  pairingCode: string
  /** How long the code stays valid after the bridge starts. Default 10 minutes. */
  pairingTtlMs?: number
  /** The relay identity keypair. Generated (extractable, keychain-style) when omitted. */
  keys?: DeviceKeys
  /** Clock seam (unix ms). Defaults to Date.now. */
  now?: () => number
  /** One-line log sink. */
  log?: (line: string) => void
  /** Mint a scoped token. Defaults to a 32-byte random hex. */
  mintToken?: () => string
  /** WebSocket implementation (Node passes `ws`; the browser uses the global). */
  WebSocketImpl?: LinkOptions['WebSocketImpl']
}

export interface RelayBridge {
  /** The relay room the phone joins (the daemon's relay device id). */
  readonly room: string
  /** The daemon's X25519 public key (base64url) the phone needs to derive the shared key. */
  readonly boxPub: string
  /** Build the QR/offer the desktop shows: relay + room + boxPub + the current pairing code. */
  offer(): PairingOffer
  /** The offer as the phone-app URL the QR encodes (`<appBaseUrl>/#d2p=…`). */
  offerUrl(appBaseUrl: string): string
  /** Whether a phone has paired (a device key is registered on the daemon). */
  paired(): boolean
  /** Tear down the relay connection. */
  close(): void
}

interface TokenGrant {
  caps: Set<Capability>
  device: string
}

/** Start the daemon's relay bridge: join the relay as the room's PC and serve pairing/approval RPC to phones. */
export async function startRelayBridge(opts: RelayBridgeOptions): Promise<RelayBridge> {
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  const mintToken = opts.mintToken ?? (() => randomBytes(32).toString('hex'))
  const keys = opts.keys ?? (await generateDevice(true))

  const codeState = {
    code: opts.pairingCode,
    expiresAt: now() + (opts.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS),
    used: false,
  }
  /** Scoped tokens the bridge has minted. token -> what it may do + which device it is for. */
  const tokens = new Map<string, TokenGrant>()
  /** Per-phone shared link key, cached by the phone's relay device id. */
  const linkKeys = new Map<string, LinkKey>()
  /** Per-target send sequence number (monotonic, stops replays of our replies). */
  const seq = new Map<string, number>()
  const nextSeq = (to: string): number => {
    const n = (seq.get(to) ?? 0) + 1
    seq.set(to, n)
    return n
  }

  const client = new LinkClient({
    relay: opts.relayUrl,
    role: 'pc',
    keys,
    onEnvelope: (env) => void onEnvelope(env),
    ...(opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}),
  })

  async function keyFor(env: Envelope): Promise<LinkKey | undefined> {
    const cached = linkKeys.get(env.from)
    if (cached) return cached
    if (typeof env.pub !== 'string') return undefined
    try {
      const k = await linkKey(keys.boxPriv, env.pub, [keys.id, env.from])
      linkKeys.set(env.from, k)
      return k
    } catch {
      return undefined
    }
  }

  async function onEnvelope(env: Envelope): Promise<void> {
    if (env.kind !== RELAY_RPC_KIND || env.to !== keys.id) return
    const k = await keyFor(env)
    if (!k) return
    let req: PairRpcRequest
    try {
      req = await open<PairRpcRequest>(k, env)
    } catch {
      return // undecryptable: a tampered or mis-keyed envelope is simply dropped
    }
    const res = dispatch(req)
    const reply = await seal(
      k,
      { v: 1, from: keys.id, to: env.from, kind: RELAY_RPC_KIND, seq: nextSeq(env.from) },
      res,
    )
    client.send(reply)
  }

  function dispatch(req: PairRpcRequest): PairRpcResponse {
    switch (req.t) {
      case 'pair':
        return doPair(req)
      case 'pending': {
        if (!can(req.token, 'pending')) return { rid: req.rid, t: 'pending', ok: false, reason: 'forbidden' }
        return { rid: req.rid, t: 'pending', ok: true, cards: opts.agentd.pending().map(toRpcCard) }
      }
      case 'approve': {
        if (!can(req.token, 'approve')) return { rid: req.rid, t: 'approve', ok: false, reason: 'forbidden' }
        const r = opts.agentd.approve(req.hash, req.signature, now())
        return { rid: req.rid, t: 'approve', ok: r.ok, ...(r.ok ? {} : { reason: r.reason }) }
      }
      case 'admin':
        // No token minted over the relay carries `admin`, so this is always refused. The scoped phone token cannot
        // drive a turn or change the level — those stay on the daemon's loopback HTTP, which the phone never touches.
        return { rid: req.rid, t: 'admin', ok: false, reason: 'forbidden' }
      default:
        return { rid: (req as { rid?: string }).rid ?? '', t: 'error', reason: 'unknown-request' }
    }
  }

  function doPair(req: Extract<PairRpcRequest, { t: 'pair' }>): PairRpcResponse {
    const fail = (reason: string): PairRpcResponse => ({ rid: req.rid, t: 'paired', ok: false, reason })
    if (typeof req.publicKeyPem !== 'string' || !req.publicKeyPem.includes('PUBLIC KEY')) {
      return fail('public-key-required')
    }
    if (req.publicKeyPem.includes('PRIVATE')) return fail('public-key-only')
    if (codeState.used) return fail('code-used')
    if (now() > codeState.expiresAt) return fail('code-expired')
    if (req.code !== codeState.code) return fail('bad-code')

    opts.agentd.registerDevice(req.publicKeyPem)
    codeState.used = true
    const token = mintToken()
    tokens.set(token, { caps: new Set(PHONE_SCOPE), device: req.deviceId })
    log(`relay paired device ${req.deviceId} — scoped token issued (${PHONE_SCOPE.join('+')})`)
    return { rid: req.rid, t: 'paired', ok: true, token, scope: [...PHONE_SCOPE], deviceId: req.deviceId }
  }

  function can(token: string, cap: Capability): boolean {
    return tokens.get(token)?.caps.has(cap) ?? false
  }

  client.start()

  const offer = (): PairingOffer => ({
    v: PAIRING_OFFER_VERSION,
    relay: opts.relayUrl,
    room: keys.id,
    boxPub: keys.boxPub,
    code: codeState.code,
  })

  return {
    room: keys.id,
    boxPub: keys.boxPub,
    offer,
    offerUrl: (appBaseUrl: string) => pairingUrl(appBaseUrl, offer()),
    paired: () => opts.agentd.hasDevice(),
    close: () => client.stop(),
  }
}

function toRpcCard(card: ApprovalCard): PairRpcCard {
  return {
    hash: card.hash,
    envelope: card.envelope,
    ...(card.expiresAt !== undefined ? { expiresAt: card.expiresAt } : {}),
  }
}
