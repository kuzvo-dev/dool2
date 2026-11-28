// card -> sign -> respond: the phone's signing step. The user has seen the card (approval-card.ts) and tapped
// approve; now the phone signs the exact envelope and sends the signature back to the daemon.
//
// The signature is made over the envelope HASH, reusing @dool2/approvals envelopeHash so the bytes are identical to
// what the daemon verifies. That is the whole point of binding to a hash: the daemon recomputes the hash from the
// envelope it is about to act on, and the signature validates only for that exact action (same amount, merchant,
// recipient, site, tier). The private key never leaves the keystore seam — signCard asks the chip to sign, it does
// not read a key.

import { type ActionEnvelope, envelopeHash } from '@dool2/approvals'
import type { ApprovalNeeded } from './approval-card.js'
import type { KeyStore } from './keystore.js'

/**
 * The exact bytes the device key signs: the 32 raw bytes of the envelope's sha256 hash. This mirrors the private
 * `signingBytes` in @dool2/approvals so a phone signature verifies there unchanged — keep the two in step.
 */
export function signingBytes(envelope: ActionEnvelope): Buffer {
  return Buffer.from(envelopeHash(envelope), 'hex')
}

/**
 * Sign an approval card with the device key. Returns a base64 Ed25519 signature the daemon verifies with
 * @dool2/approvals verifyApproval against the device public key it stored at pairing. The signature covers the
 * card's envelope hash, so it is bound to that one action.
 */
export async function signCard(card: ApprovalNeeded, keystore: KeyStore): Promise<string> {
  return keystore.sign(signingBytes(card.envelope))
}

/** The daemon's reply to a signed approval. The real Agentd.approve returns a richer shape that satisfies this. */
export interface RespondResult {
  ok: boolean
  reason?: string
}

/**
 * The daemon seam `respond` needs: take a hash and signature, verify + consume the approval. The real @dool2/agentd
 * Agentd satisfies this with `approve(hash, signature)`. A network transport implements it by POSTing to the
 * daemon's approve endpoint.
 */
export interface ApprovalTransport {
  approve(hash: string, signature: string): RespondResult | Promise<RespondResult>
}

/** Send a signature back to the daemon for a given approval hash. Returns the daemon's verify result. */
export async function respond(
  daemon: ApprovalTransport,
  hash: string,
  signature: string,
): Promise<RespondResult> {
  return daemon.approve(hash, signature)
}

/** Convenience: sign a card and send the signature in one step (card -> sign -> respond). */
export async function approveCard(
  daemon: ApprovalTransport,
  card: ApprovalNeeded,
  keystore: KeyStore,
): Promise<RespondResult> {
  const signature = await signCard(card, keystore)
  return respond(daemon, card.hash, signature)
}
