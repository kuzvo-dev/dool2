// The single place that turns a gated action into an ActionEnvelope. The engine and the daemon (agentd) both build
// the envelope through this one builder, so they always agree on the hash: the hash the engine computes for an action
// it is about to run is byte-for-byte the hash the daemon minted for the approval card the phone signed. That shared
// hash is what closes the "resume after a phone signature" loop (ADR 0047): the engine checks whether the action's
// hash is in the approved set before it lets the action run.
//
// For that check to work ACROSS turns (the action is gated in one turn, approved, then re-run in a later turn), the
// hash must be DETERMINISTIC from what the action does — the engine in the resume turn has only the GatedAction, not
// the random nonce/timestamp a first-turn mint might have picked. So this builder derives the envelope's `nonce`
// deterministically from the action's binding facts and pins `createdAt` to 0: the hash then depends only on tier,
// label, amount and the merchant/recipient/site the action is bound to. Freshness (expiry) and single-use live in the
// PendingApproval / ApprovalStore (pending.ts), measured from the real mint time the daemon records there — never from
// the hash. A deterministic nonce still binds the signature to the action and still hits the store's spent-nonce guard
// on a replay, because the same action produces the same nonce.

import { createHash } from 'node:crypto'
import type { GatedAction } from '@dool2/core'
import { type ActionEnvelope, canonicalize } from './envelope.js'

/** The identifying facts the daemon/engine read off the page for a gated action, beyond what GatedAction carries. */
export interface ActionBinding {
  /** The merchant/payee the money goes to, for `pay`. */
  merchant?: string
  /** The recipient of a `contact` action. */
  recipient?: string
  /** The site the action happens on (origin/host), when it helps bind the action. */
  site?: string
}

/** A gated action plus the binding facts the envelope pins. GatedAction already carries tier/label/amountKrw. */
export interface ActionForEnvelope extends GatedAction, ActionBinding {}

/** createdAt is pinned here so it never enters the hash; real freshness is tracked in the PendingApproval. */
const DETERMINISTIC_CREATED_AT = 0

/**
 * Derive a stable nonce from the action's binding facts. Same action -> same nonce, so the hash is reproducible in a
 * resume turn and a replayed signature meets the store's spent-nonce guard. It is a sha256 over the same canonical
 * fields the hash covers (minus the nonce itself), so it changes whenever any bound fact changes.
 */
function deterministicNonce(action: ActionForEnvelope): string {
  const facts: Omit<ActionEnvelope, 'nonce'> = {
    tier: action.tier,
    label: action.label,
    createdAt: DETERMINISTIC_CREATED_AT,
    ...(action.amountKrw !== undefined ? { amountKrw: action.amountKrw } : {}),
    ...(action.merchant !== undefined ? { merchant: action.merchant } : {}),
    ...(action.recipient !== undefined ? { recipient: action.recipient } : {}),
    ...(action.site !== undefined ? { site: action.site } : {}),
  }
  // canonicalize ignores the missing `nonce` (undefined fields are skipped), so this digest is over the bound facts.
  return createHash('sha256')
    .update(`nonce:${canonicalize(facts as ActionEnvelope)}`, 'utf8')
    .digest('hex')
}

/**
 * Build the canonical ActionEnvelope for a gated action. Deterministic: the same action always produces the same
 * envelope (and therefore the same {@link envelopeHash}). This is the single source of truth used by both the engine
 * (to decide whether an action was pre-approved) and agentd (to mint the approval card the phone signs).
 */
export function envelopeForAction(action: ActionForEnvelope): ActionEnvelope {
  return {
    tier: action.tier,
    label: action.label,
    ...(action.amountKrw !== undefined ? { amountKrw: action.amountKrw } : {}),
    ...(action.merchant !== undefined ? { merchant: action.merchant } : {}),
    ...(action.recipient !== undefined ? { recipient: action.recipient } : {}),
    ...(action.site !== undefined ? { site: action.site } : {}),
    nonce: deterministicNonce(action),
    createdAt: DETERMINISTIC_CREATED_AT,
  }
}
