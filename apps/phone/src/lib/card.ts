// The approval card the phone shows, as plain data (no DOM, no locale) so it is easy to test and the renderer can lay
// it out. It builds on @dool2/phone's ApprovalNeeded — the exact, signable payload the daemon sends — and adds the two
// display-only extras the design's bottom sheet shows but the signed envelope does not carry: a one-line source
// ("<service> · pays from your Mac") and the detail rows (train / leg / seat / card). Those are descriptive facts the
// daemon attaches for the human; they are NOT part of what the signature binds to, which stays the envelope hash.
//
// Nothing here is a secret. The card reads only the envelope's public facts plus masked display text (a card shows as
// "····4821", never a real number), so there is no way for a password/card/PIN to reach the screen.

import type { ApprovalNeeded, KeyStore } from '@dool2/phone'
import { signCardWeb } from './sign.js'

/** One name/value row under the headline (e.g. Train · Express 101). Display only; never signed. */
export interface CardRow {
  key: string
  value: string
}

/** A pending approval plus the display-only extras the sheet shows. `source`/`rows` are absent on a bare daemon card. */
export interface PendingCard extends ApprovalNeeded {
  /** The one-line source above the headline (e.g. "Train booking · pays from your Mac at home"). */
  source?: string
  /** The detail rows (train / route / seat / card). Masked where they would otherwise show a secret. */
  rows?: CardRow[]
}

/** The flat view the renderer lays out: the headline amount, the where/source line, and the rows. */
export interface CardView {
  hash: string
  tier: ApprovalNeeded['envelope']['tier']
  label: string
  amountKrw?: number
  where?: string
  source?: string
  rows: CardRow[]
}

/** Project a pending card to the flat view the sheet renders. Falls back to the envelope's own facts when a bare
 *  daemon card carries no display rows, so a live card still reads sensibly (what it buys, where, how much). */
export function cardView(card: PendingCard): CardView {
  const { envelope } = card
  const where = envelope.merchant ?? envelope.recipient ?? envelope.site
  return {
    hash: card.hash,
    tier: envelope.tier,
    label: envelope.label,
    ...(envelope.amountKrw !== undefined ? { amountKrw: envelope.amountKrw } : {}),
    ...(where !== undefined ? { where } : {}),
    ...(card.source !== undefined ? { source: card.source } : {}),
    rows: card.rows ?? [],
  }
}

/** Sign a card with the device key (the private key stays in the keystore). Exposed so the renderer and tests share
 *  one signing path; approving is this plus a POST /approve (see PhoneController.approve). */
export async function signPending(card: PendingCard, keystore: KeyStore): Promise<string> {
  return signCardWeb(card, keystore)
}
