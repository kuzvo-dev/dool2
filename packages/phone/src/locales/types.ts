// The shape every language's card copy fills. Keeping it in its own module lets each locale file import the type
// without importing another language. Keys follow the gate's ActionTier vocabulary (@dool2/core).

import type { ActionTier } from '@dool2/core'

export interface CardCopy {
  /** The card headline, by action tier ("결제 승인" / "Approve payment"). */
  title: Record<ActionTier, string>
  /** The tier's own short name ("결제" / "Payment"). */
  tier: Record<ActionTier, string>
  /** The three question labels the card lays out. */
  field: { what: string; where: string; amount: string }
  /** The approve button. */
  approve: string
  /** The deny button. */
  deny: string
  /** Format a won amount for display. */
  amount: (won: number) => string
}

/** The languages the card ships in. Korean is the reference copy; English must be complete. */
export type CardLang = 'ko' | 'en'
