// The three autonomy levels the user chooses (ADR 0047) and the gate that turns an action into a decision.
// The gate is a pure function: the daemon enforces it in code, never the prompt. Secrets never reach the AI; this
// module only decides whether an action runs, needs a phone signature, a review, a notification, or is blocked.

/** ask / auto / full-auto */
export type AutonomyLevel = 'ask' | 'auto' | 'full'

/**
 * What an action does, from safest to hardest to undo.
 * - read: open/read/screenshot — never gated
 * - act: click/type that only moves through a screen
 * - contact: send a message, post, invite
 * - delete: remove or cancel something
 * - pay: spend money
 */
export type ActionTier = 'read' | 'act' | 'contact' | 'delete' | 'pay'

/**
 * - run: do it now
 * - sign: wait for a phone secure-chip signature over this exact action
 * - review: let the small reviewer judge; if unrelated it becomes a phone card (level 2)
 * - notify: do it now, but tell the person it happened (level 3)
 * - block: refuse (over a hard limit)
 */
export type GateDecision = 'run' | 'sign' | 'review' | 'notify' | 'block'

export interface ActionContext {
  /** Won spent, for pay actions */
  amountKrw?: number
  /** The merchant has been paid before (not a brand-new payee) */
  merchantKnown?: boolean
  /** The amount is within the user's onboarding-set spending cap (full-auto only) */
  underCap?: boolean
}

export interface GateResult {
  decision: GateDecision
  /** Short machine reason, for the activity log */
  reason: string
}

/**
 * Decide what happens to an action at a given autonomy level. Pure and total.
 *
 * ask: pay/contact/delete each wait for a phone signature; plain acts run.
 * auto: acts run; contact/delete go through the reviewer; payment still always signs.
 * full (full-auto): acts run; contact/delete run and notify; payment runs when the merchant is known and under the
 *   cap, otherwise a signature is still required (new merchant or over the cap); clearly over the cap is blocked.
 */
export function decide(level: AutonomyLevel, tier: ActionTier, ctx: ActionContext = {}): GateResult {
  if (tier === 'read') return { decision: 'run', reason: 'read' }

  if (level === 'ask') {
    if (tier === 'act') return { decision: 'run', reason: 'ask:act' }
    return { decision: 'sign', reason: `ask:${tier}` }
  }

  if (level === 'auto') {
    if (tier === 'act') return { decision: 'run', reason: 'auto:act' }
    if (tier === 'pay') return { decision: 'sign', reason: 'auto:pay-always-asks' }
    return { decision: 'review', reason: `auto:${tier}` }
  }

  // full (full-auto)
  if (tier === 'act') return { decision: 'run', reason: 'full:act' }
  if (tier === 'contact' || tier === 'delete') return { decision: 'notify', reason: `full:${tier}` }
  // pay
  if (ctx.underCap === false) return { decision: 'block', reason: 'full:pay-over-cap' }
  if (!ctx.merchantKnown) return { decision: 'sign', reason: 'full:pay-new-merchant' }
  return { decision: 'notify', reason: 'full:pay-known-under-cap' }
}

/** Whether a decision lets the action proceed without a person in the loop (for logging/telemetry). */
export function isAutonomous(d: GateDecision): boolean {
  return d === 'run' || d === 'notify'
}
