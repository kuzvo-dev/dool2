// State around a single approval: whether the gate's decision needs one at all, and the pending record that expires
// and can be consumed only once. Expiry and single-use are the replay defences — an approval the user left on the
// table past its window is dead, and a signature cannot be replayed to press the same button twice.

import type { GateDecision } from '@dool2/core'
import { type ActionEnvelope, envelopeHash } from './envelope.js'
import { verifyApproval } from './sign.js'

/**
 * Whether a gate decision needs a phone signature from this package. Only `sign` does. `review` goes to the small
 * reviewer, not here; `run`/`notify` already proceed; `block` refuses. The daemon routes by this so a `review` is
 * never mistaken for an approvable action.
 */
export function approvalRequired(decision: GateDecision): boolean {
  return decision === 'sign'
}

/** Default life of a pending approval: 3 minutes. Past this the envelope is expired and cannot be approved. */
export const DEFAULT_TTL_MS = 3 * 60_000

/** A pending approval: the envelope the phone was asked to sign, its hash, and its validity window. */
export interface PendingApproval {
  envelope: ActionEnvelope
  /** sha256 hex of the envelope — the value the phone signs. Cached so the daemon and card show the same hash. */
  hash: string
  /** Unix ms the envelope was minted (its `createdAt`). */
  createdAt: number
  /** Unix ms after which the approval is dead. */
  expiresAt: number
}

/** Build a pending record for an envelope, with expiry measured from the envelope's own `createdAt`. */
export function pendingApproval(envelope: ActionEnvelope, ttlMs: number = DEFAULT_TTL_MS): PendingApproval {
  return {
    envelope,
    hash: envelopeHash(envelope),
    createdAt: envelope.createdAt,
    expiresAt: envelope.createdAt + ttlMs,
  }
}

/** Why a consume attempt failed. */
export type ConsumeFailure =
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'nonce-reused' }
  | { ok: false; reason: 'bad-signature' }

/** The result of consuming an approval: ok (and now spent), or a reason it was rejected. */
export type ConsumeResult = { ok: true } | ConsumeFailure

/**
 * Tracks which approval nonces have been spent and enforces expiry + single-use. One store lives in the daemon for
 * the life of the process (or longer, if persisted). It holds only nonces and their expiry — no secrets, no envelope
 * bodies.
 *
 * `verifyAndConsume` is the single entry point an approval passes through before the daemon presses the button:
 *   1. not expired,
 *   2. nonce not already spent,
 *   3. signature valid for this exact envelope (verifyApproval recomputes the hash),
 * and only then is the nonce marked spent so it can never be replayed. A later `matchesApproved` still has to confirm
 * the action about to run matches this envelope.
 */
export class ApprovalStore {
  readonly #ttlMs: number
  /** nonce -> the ms after which its record may be forgotten (kept at least until expiry to block replay). */
  readonly #spent = new Map<string, number>()

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.#ttlMs = ttlMs
  }

  /** Whether a nonce has already been spent (and is still within the window where that matters). */
  isSpent(nonce: string): boolean {
    return this.#spent.has(nonce)
  }

  /**
   * Verify a signed approval and, on success, spend its nonce. Returns ok only when the envelope is unexpired, its
   * nonce is unspent, and the signature verifies for this exact envelope. Idempotent on failure; single-use on success.
   */
  verifyAndConsume(
    envelope: ActionEnvelope,
    signature: string,
    devicePublicKeyPem: string,
    now: number = Date.now(),
  ): ConsumeResult {
    if (now > envelope.createdAt + this.#ttlMs) return { ok: false, reason: 'expired' }
    if (this.#spent.has(envelope.nonce)) return { ok: false, reason: 'nonce-reused' }
    if (!verifyApproval(envelope, signature, devicePublicKeyPem))
      return { ok: false, reason: 'bad-signature' }
    this.#spent.set(envelope.nonce, envelope.createdAt + this.#ttlMs)
    return { ok: true }
  }

  /** Drop spent-nonce records whose window has passed, to keep the set from growing without bound. */
  prune(now: number = Date.now()): void {
    for (const [nonce, deadAt] of this.#spent) {
      if (now > deadAt) this.#spent.delete(nonce)
    }
  }
}
