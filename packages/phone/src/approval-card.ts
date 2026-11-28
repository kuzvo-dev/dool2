// The approval card the phone shows the user. The daemon sends an approvalNeeded payload — an ActionEnvelope, its
// hash, and the facts to display — and this turns it into the human fields the app renders: what, where, and how
// much (the field labels are localized in the locale files). It reads only the public facts the envelope carries
// (tier, label, amount, merchant,
// recipient, site); there are no secret fields to show, because the phone never receives a password, card number or
// PIN (ADR 0047). The hash is carried through so the signed value is the exact one the daemon minted.

import type { ActionEnvelope } from '@dool2/approvals'
import type { ActionTier } from '@dool2/core'
import { type CardCopy, type CardLang, DEFAULT_CARD_LANG, locales } from './locales/index.js'

/**
 * The approvalNeeded payload the daemon sends the phone. It is structurally the daemon's ApprovalCard
 * (@dool2/agentd), so a real card can be passed straight in: the envelope and its hash are what matter; the rest are
 * conveniences the envelope already carries.
 */
export interface ApprovalNeeded {
  /** sha256 hex of the canonical envelope — the value the phone signs and the daemon looks the approval up by. */
  hash: string
  /** The canonical action the signature binds to. The single source for every displayed fact below. */
  envelope: ActionEnvelope
  /** Unix ms after which the approval is dead and must be re-requested. Shown so the user knows it can expire. */
  expiresAt?: number
}

/**
 * The rendered card: the headline, the three labelled facts, the formatted amount, and the hash/expiry the signing
 * step needs. Every field here is public; none is a secret. The app lays these out and offers approve/deny.
 */
export interface CardView {
  hash: string
  tier: ActionTier
  /** The card headline for this tier (localized, e.g. the Korean "approve payment"). */
  title: string
  /** The three question labels, localized, for the app to render beside the values. */
  fieldLabels: { what: string; where: string; amount: string }
  /** what the action does — the envelope's human label. */
  what: string
  /** where it happens — merchant, else recipient, else site. Undefined when the envelope pinned none. */
  where?: string
  /** the amount, formatted for display (e.g. "50,000 won"). Undefined for non-pay actions. */
  amountText?: string
  /** The raw won amount, for the app that wants to format it itself. */
  amountKrw?: number
  /** The approve/deny button labels, localized. */
  buttons: { approve: string; deny: string }
  expiresAt?: number
}

/** The where-value: whatever the envelope pinned, in the order that reads best on a card. */
function whereOf(envelope: ActionEnvelope): string | undefined {
  return envelope.merchant ?? envelope.recipient ?? envelope.site
}

/**
 * Build the human card from an approvalNeeded payload. Pure: the same payload and language always produce the same
 * card. Reads only the envelope's public facts; it cannot surface a secret because none is present.
 */
export function buildCard(payload: ApprovalNeeded, lang: CardLang = DEFAULT_CARD_LANG): CardView {
  const copy: CardCopy = locales[lang]
  const { envelope } = payload
  const where = whereOf(envelope)
  return {
    hash: payload.hash,
    tier: envelope.tier,
    title: copy.title[envelope.tier],
    fieldLabels: { ...copy.field },
    what: envelope.label,
    ...(where !== undefined ? { where } : {}),
    ...(envelope.amountKrw !== undefined ? { amountText: copy.amount(envelope.amountKrw) } : {}),
    ...(envelope.amountKrw !== undefined ? { amountKrw: envelope.amountKrw } : {}),
    buttons: { approve: copy.approve, deny: copy.deny },
    ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
  }
}
