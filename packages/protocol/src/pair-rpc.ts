// Relay-backed pairing + approval RPC (ADR 0012 relay, ADR 0043/0047 approvals). Shared wire shapes for the small
// request/response protocol the phone and the daemon speak OVER the relay, inside the end-to-end encrypted envelopes
// (e2e.ts). The relay only ever carries the sealed ciphertext of these messages, so it can read none of them and,
// lacking the phone's device signing key, cannot forge an approval.
//
// How it fits the relay: the daemon joins its own relay room as the "pc" party (room = its relay device id); the phone
// joins the SAME room (it learns the room id + the daemon's X25519 public key + a short pairing code from the QR the
// desktop shows). Every message below travels as the body of an {@link Envelope} with kind {@link RELAY_RPC_KIND},
// sealed with the shared link key. The daemon authorizes pairing with the short CODE (not the daemon's loopback admin
// token), then mints a SCOPED token the phone uses for pending/approve — never the raw admin token.
//
// These are just the shapes + the QR offer encoding. The daemon's dispatch + token/capability checks live in
// @dool2/agentd (relay-bridge.ts); the phone's client lives in @dool2/phone (relay-client.ts).

/** The envelope kind that carries a pairing/approval RPC message (never a live screen; it is queued if the peer is briefly away). */
export const RELAY_RPC_KIND = 'pair-rpc'

/** The current QR/offer format version, so an older phone app can refuse an offer it does not understand. */
export const PAIRING_OFFER_VERSION = 1

/**
 * What a scoped phone token is allowed to do. The daemon mints a token with exactly `['pending', 'approve']` at
 * pairing, so a paired phone can read cards and sign them but can NEVER drive a turn, change the autonomy level or the
 * spending cap, or do anything else the loopback admin token can. `admin` exists only so that boundary is testable:
 * no token minted over the relay ever carries it.
 */
export type Capability = 'pending' | 'approve' | 'admin'

/** The capability set every scoped phone token gets at pairing (read cards + sign them; nothing admin). */
export const PHONE_SCOPE: readonly Capability[] = ['pending', 'approve']

/**
 * The pairing offer the desktop puts in the QR (and shows the 6-digit code beside, as a fallback). It is NOT secret
 * on its own — it carries no token and no private key — but the `code` is single-use and short-lived, so a scan only
 * pairs while the screen is showing it.
 */
export interface PairingOffer {
  v: number
  /** The relay base URL (http(s)://…); the phone opens a WebSocket to it. */
  relay: string
  /** The relay room to join — the daemon's relay device id. */
  room: string
  /** The daemon's X25519 public key (base64url), so the phone can derive the shared end-to-end key. */
  boxPub: string
  /** The short pairing code the user sees on the PC; the daemon checks it before it trusts the phone's key. */
  code: string
}

const enc = (s: string): string => btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const dec = (s: string): string => atob(s.replaceAll('-', '+').replaceAll('_', '/'))

/** Encode a pairing offer as a compact base64url(JSON) token for a QR or a link fragment. */
export function encodeOffer(offer: PairingOffer): string {
  return enc(JSON.stringify(offer))
}

/** Decode a base64url(JSON) offer token. Returns undefined when it is malformed or the wrong version. */
export function decodeOffer(token: string): PairingOffer | undefined {
  try {
    const o = JSON.parse(dec(token)) as Partial<PairingOffer>
    if (
      o.v === PAIRING_OFFER_VERSION &&
      typeof o.relay === 'string' &&
      typeof o.room === 'string' &&
      typeof o.boxPub === 'string' &&
      typeof o.code === 'string'
    ) {
      return o as PairingOffer
    }
  } catch {
    // fall through
  }
  return undefined
}

/**
 * The URL the QR encodes: the phone app served by the relay, with the offer in the fragment (`#d2p=…`). The fragment
 * stays on the phone (browsers never send it to a server), so the offer is read locally by the phone app.
 */
export function pairingUrl(appBaseUrl: string, offer: PairingOffer): string {
  return `${appBaseUrl.replace(/#.*$/, '').replace(/\/+$/, '')}/#d2p=${encodeOffer(offer)}`
}

/** Pull an offer out of a URL fragment (`#d2p=…`) or a bare token. Returns undefined when there is none. */
export function offerFromHash(hash: string): PairingOffer | undefined {
  const m = /[#&]d2p=([^&]+)/.exec(hash) ?? (/^[A-Za-z0-9\-_]+$/.test(hash) ? [hash, hash] : null)
  return m?.[1] ? decodeOffer(m[1]) : undefined
}

// ── RPC messages (phone → daemon) ────────────────────────────────────────────

/** Pair this phone: prove the short code and hand over the device PUBLIC key. No private key, no token. */
export interface PairReq {
  rid: string
  t: 'pair'
  code: string
  /** A stable device id so a re-pair replaces the same device. */
  deviceId: string
  /** The device public key (SPKI Ed25519 PEM) the daemon stores and verifies approvals against. */
  publicKeyPem: string
  label?: string
}

/** Read the cards awaiting a signature. Needs a scoped token with the `pending` capability. */
export interface PendingReq {
  rid: string
  t: 'pending'
  token: string
}

/** Send a signature back for one card. Needs a scoped token with the `approve` capability. */
export interface ApproveReq {
  rid: string
  t: 'approve'
  token: string
  hash: string
  signature: string
}

/** An admin operation (drive a turn, change level, …). The relay bridge only accepts this with an `admin` token,
 *  which a scoped phone token is NOT — so this always fails over the relay. It exists to make that boundary testable. */
export interface AdminReq {
  rid: string
  t: 'admin'
  token: string
  op: string
}

export type PairRpcRequest = PairReq | PendingReq | ApproveReq | AdminReq

// ── RPC messages (daemon → phone) ────────────────────────────────────────────

/** One approval card as it crosses the relay: the hash + the public-fact envelope, nothing secret. */
export interface PairRpcCard {
  hash: string
  /** The canonical ActionEnvelope (@dool2/approvals). Typed loosely here so this module stays dependency-free. */
  envelope: unknown
  expiresAt?: number
}

export type PairRpcResponse =
  | { rid: string; t: 'paired'; ok: true; token: string; scope: Capability[]; deviceId: string }
  | { rid: string; t: 'paired'; ok: false; reason: string }
  | { rid: string; t: 'pending'; ok: true; cards: PairRpcCard[] }
  | { rid: string; t: 'pending'; ok: false; reason: string }
  | { rid: string; t: 'approve'; ok: boolean; reason?: string }
  | { rid: string; t: 'admin'; ok: false; reason: string }
  | { rid: string; t: 'error'; reason: string }
