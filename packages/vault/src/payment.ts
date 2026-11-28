// The payment PIN, the one secret stored only in full-auto (ADR 0047). It is stored only while the user is in
// full-auto; the vault types it into the site's secure keypad; the AI never sees it. There is deliberately no path
// from the PIN to any agent-facing summary: toAgentSummary cannot carry it, and the getter below is the fill path
// only.

import type { AutonomyLevel } from '@dool2/core'
import type { PaymentPinItem, VaultItem } from './types.js'

/**
 * Whether the payment PIN may be used at all. True only at autonomy level 'full' (full-auto) and only for a
 * payment-pin item (ADR 0047). At every other level the PIN is not even stored, so this is the code-side guard that
 * matches the storage rule.
 */
export function paymentPinAvailable(item: VaultItem, autonomyLevel: AutonomyLevel): boolean {
  return item.kind === 'payment-pin' && autonomyLevel === 'full'
}

/**
 * FILL PATH ONLY — never return this value to the AI, a log, a summary, or any caller outside the vault's own fill
 * step. It exists so the vault can type the PIN into the secure keypad (see fillPaymentPin). It is intentionally
 * not part of AgentItemSummary and must never be.
 */
export function revealPaymentPinForFill(item: PaymentPinItem): string {
  return item.secret.pin
}

/**
 * The site's secure keypad, implemented by the daemon. The vault types the PIN into it; the value never passes
 * through the model. Like PageFiller, this returns void: nothing flows back up.
 */
export interface SecureKeypad {
  /** Type the PIN digits into the secure keypad. The value never leaves this call. */
  typePin(pin: string): Promise<void>
}

/**
 * Type the payment PIN into the secure keypad — the only sanctioned use of the PIN. Refuses unless the autonomy
 * level allows it (full-auto), so a mis-wired caller cannot drive the PIN at a lower level.
 */
export async function fillPaymentPin(
  item: PaymentPinItem,
  keypad: SecureKeypad,
  autonomyLevel: AutonomyLevel,
): Promise<void> {
  if (!paymentPinAvailable(item, autonomyLevel)) {
    throw new Error('payment PIN is available only in full-auto (ADR 0047)')
  }
  await keypad.typePin(revealPaymentPinForFill(item))
}
