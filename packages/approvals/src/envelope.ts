// The ActionEnvelope: a canonical, stable description of the one action to be approved. The phone's secure chip
// signs the envelope's hash, not a loose free-text label, so a signature is bound to the exact recipient, amount and
// merchant (ADR 0043, 0047). Two rules make that binding sound:
//   1. canonicalize() is deterministic — the same action produces the same string regardless of key order, so the
//      phone and the daemon compute the same hash from the same facts.
//   2. envelopeHash() is a sha256 over that string — changing any field (amount, merchant, tier, ...) changes the
//      hash, so a signature made for one action cannot validate for another.

import { createHash, randomUUID } from 'node:crypto'
import type { ActionTier } from '@dool2/core'

/**
 * The canonical description of one action awaiting (or carrying) a phone approval. Everything the signature binds to
 * lives here; nothing else is signed. `nonce` makes each envelope single-use (replay defence) and `createdAt` drives
 * expiry. Secrets never appear here — only the public facts of the action (who, how much, which merchant).
 */
export interface ActionEnvelope {
  /** What the action does, from @dool2/core's gate vocabulary (pay/contact/delete are the ones that reach here). */
  tier: ActionTier
  /** Human label for the approval card and the activity log, e.g. the button text or "Send 50,000 won". */
  label: string
  /** Won spent, for `pay` actions. */
  amountKrw?: number
  /** The merchant/payee the money goes to, for `pay`. */
  merchant?: string
  /** The recipient of a `contact` action (the person messaged, invited, posted to). */
  recipient?: string
  /** The site the action happens on, when it helps bind the action (origin/host). */
  site?: string
  /** One-time value: an envelope with this nonce can be approved and consumed exactly once. */
  nonce: string
  /** Unix ms when the envelope was minted. Expiry is measured from here. */
  createdAt: number
}

/** The fields the signature binds to, in a fixed order. `nonce`/`createdAt` are included so a replay is a new action. */
const FIELDS = ['amountKrw', 'createdAt', 'label', 'merchant', 'nonce', 'recipient', 'site', 'tier'] as const

/**
 * A deterministic string for an envelope: the defined fields as sorted `[key, value]` pairs, JSON-encoded. Stable
 * under key reordering (we sort), and an omitted field reads the same as an explicit `undefined` (we skip both), so
 * the phone and the daemon always agree on the bytes to hash.
 */
export function canonicalize(envelope: ActionEnvelope): string {
  const pairs: [string, unknown][] = []
  for (const key of FIELDS) {
    const value = (envelope as unknown as Record<string, unknown>)[key]
    if (value !== undefined) pairs.push([key, value])
  }
  return JSON.stringify(pairs)
}

/** sha256 hex of the canonical envelope. This is what the phone's secure chip signs (ADR 0043). */
export function envelopeHash(envelope: ActionEnvelope): string {
  return createHash('sha256').update(canonicalize(envelope), 'utf8').digest('hex')
}

/** A fresh nonce for a new envelope. The daemon mints one per action it asks the phone to sign. */
export function newNonce(): string {
  return randomUUID()
}
