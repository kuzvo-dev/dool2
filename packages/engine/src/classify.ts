// Refine a sandbox GatedAction into the inputs the autonomy gate weighs (ADR 0047). The sandbox classifies an acting
// call conservatively (a click is `act`); the daemon refines it with page context — a click whose snapshot node reads
// like a pay button becomes `pay`, with the amount pulled from the label. This module holds that default refinement
// and the seam that lets the daemon (and tests) inject a richer one. The gate decision itself stays in @dool2/core.

import type { ActionContext, ActionTier, GatedAction } from '@dool2/core'
import type { PageSnapshot } from '@dool2/sandbox'

/** A refined action: the tier the gate should use plus the pay context it needs. */
export interface RefinedAction extends ActionContext {
  tier: ActionTier
}

/** Context the engine hands the classifier: the latest page snapshot, when one was taken this turn. */
export interface ClassifyContext {
  snapshot?: PageSnapshot
}

/** Turn a sandbox GatedAction into a gate-ready RefinedAction, using whatever page context the engine has. */
export type ActionClassifier = (action: GatedAction, ctx: ClassifyContext) => RefinedAction

/** Words in an actionable node's name that mark it as a payment step. English-only here; skills carry site terms. */
const PAY_WORDS = /\b(pay|payment|checkout|purchase|buy|order|subscribe|donate)\b/i

/** A currency amount in the node label: digits (with grouping) next to a won/KRW/₩ marker, either order. */
const AMOUNT_AFTER = /([\d][\d,]*)\s*(?:won|krw|₩)/i
const AMOUNT_BEFORE = /(?:₩|krw)\s*([\d][\d,]*)/i

function parseAmountKrw(label: string): number | undefined {
  const match = AMOUNT_AFTER.exec(label) ?? AMOUNT_BEFORE.exec(label)
  if (!match?.[1]) return undefined
  const n = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** The ref an acting page call targets, parsed from the GatedAction label (e.g. "click e2" -> "e2"). */
function refOf(label: string): string | undefined {
  const parts = label.trim().split(/\s+/)
  return parts.length > 1 ? parts[parts.length - 1] : undefined
}

/**
 * The default classifier. It keeps the sandbox's tier unless the acting node, as the latest snapshot describes it,
 * reads like a payment — then it upgrades to `pay` and attaches the amount. It never guesses merchant history or the
 * spending cap (those are the daemon's to supply); a real daemon classifier injected via {@link ActionClassifier}
 * fills `merchantKnown`/`underCap`. Left unknown, the gate errs safe (a pay action asks for a signature).
 */
export const defaultClassify: ActionClassifier = (action, ctx) => {
  const ref = refOf(action.label)
  const node = ref ? ctx.snapshot?.nodes.find((n) => n.ref === ref) : undefined
  const name = node?.name ?? action.label
  if (action.tier === 'pay' || PAY_WORDS.test(name)) {
    const amountKrw = parseAmountKrw(name) ?? action.amountKrw
    const refined: RefinedAction = { tier: 'pay' }
    if (amountKrw !== undefined) refined.amountKrw = amountKrw
    if (action.merchantKnown !== undefined) refined.merchantKnown = action.merchantKnown
    return refined
  }
  return { tier: action.tier }
}
