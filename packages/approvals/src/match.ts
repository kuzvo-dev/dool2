// "The daemon presses only the one button that was approved." A valid signature proves the user approved SOME action;
// this check proves the action the daemon is about to execute is THAT action and not another. Both halves are needed:
// a signature without this match would let a page swap the payee after approval; this match without a signature would
// trust an unsigned claim. The gate (@dool2/core) decides a `pay`/`contact`/`delete` needs a signature; verifyApproval
// (sign.ts) proves the signature; matchesApproved proves the execution matches.

import type { GatedAction } from '@dool2/core'
import type { ActionEnvelope } from './envelope.js'

/**
 * The action the daemon is about to execute, as it knows it at execution time. It is a `GatedAction` (so the sandbox's
 * action passes straight through) widened with the identifying facts the daemon reads off the page it is about to act
 * on — the merchant it is paying, the recipient it is contacting, the site. Those are what the approval bound to, so
 * they are what must match.
 */
export interface ExecutedAction extends GatedAction {
  merchant?: string
  recipient?: string
  site?: string
}

/** The outcome of a match: ok, or not-ok with a short machine reason for the activity log. */
export type MatchResult = { ok: true } | { ok: false; reason: string }

/**
 * Does the action about to execute match the approved envelope? Same tier, same amount (0 tolerance), and the same
 * merchant/recipient/site wherever the envelope pinned one. Returns a reason on the first mismatch so the daemon can
 * log why it refused to press. This is a pure comparison; the signature is checked separately by verifyApproval.
 */
export function matchesApproved(executed: ExecutedAction, approved: ActionEnvelope): MatchResult {
  if (executed.tier !== approved.tier) {
    return { ok: false, reason: `tier ${executed.tier} != approved ${approved.tier}` }
  }
  // Amount: 0 tolerance. Both sides must agree, including "no amount".
  if (executed.amountKrw !== approved.amountKrw) {
    return { ok: false, reason: `amount ${fmt(executed.amountKrw)} != approved ${fmt(approved.amountKrw)}` }
  }
  // Merchant/recipient/site: whatever the approval pinned, the execution must present the same value.
  if (approved.merchant !== undefined && executed.merchant !== approved.merchant) {
    return { ok: false, reason: `merchant ${fmt(executed.merchant)} != approved ${fmt(approved.merchant)}` }
  }
  if (approved.recipient !== undefined && executed.recipient !== approved.recipient) {
    return {
      ok: false,
      reason: `recipient ${fmt(executed.recipient)} != approved ${fmt(approved.recipient)}`,
    }
  }
  if (approved.site !== undefined && executed.site !== approved.site) {
    return { ok: false, reason: `site ${fmt(executed.site)} != approved ${fmt(approved.site)}` }
  }
  return { ok: true }
}

function fmt(v: string | number | undefined): string {
  return v === undefined ? '(none)' : String(v)
}
