// Org policy: a declarative config an admin delivers (over MDM) that constrains a member's Dool2. It never loosens
// what the user chose — it only tightens it. The policy is applied by a pure function, `applyOrgPolicy`, which folds
// the org's constraints into the user's own choice and returns the effective settings the daemon then enforces in
// code (master plan workstream H). The key composition is with the per-user autonomy gate in `@dool2/core`: an org
// that caps autonomy at `auto` makes `full` (full-auto) unreachable no matter what the user picked.

import { type ActionContext, type ActionTier, type AutonomyLevel, decide, type GateResult } from '@dool2/core'
import { matchUrlGlob } from '@dool2/skill-sdk'

/** Where a member's data and model calls are allowed to live. `on-device` is the stricter of the two. */
export type DataResidency = 'on-device' | 'cloud-ok'

/** How much telemetry the org permits. `off` is the stricter of the two. */
export type TelemetryMode = 'off' | 'metrics'

/**
 * The admin/MDM-delivered policy. Every field is optional: an absent field means "the org does not constrain this",
 * so the user's own choice stands. A present field can only make the effective setting the same or stricter.
 */
export interface OrgPolicy {
  /** Cap the autonomy level org-wide. Setting this to `auto` (or `ask`) forbids full-auto for every member. */
  maxAutonomyLevel?: AutonomyLevel
  /** Allow-list of site globs (see `@dool2/skill-sdk` `matchUrlGlob`). When present and non-empty, only matching
   *  sites may be used. An empty/absent list means no allow-list restriction. */
  allowedSites?: string[]
  /** Block-list of site globs. A blocked site is refused even if it also matches `allowedSites` (block wins). */
  blockedSites?: string[]
  /** Spending ceiling in won. The effective cap is the smaller of this and the user's own cap. */
  spendingCapKrw?: number
  /** Tiers that must always get a phone signature, regardless of the autonomy level (forces `sign`). */
  requireApprovalTiers?: ActionTier[]
  /** Where data/model calls may live. Composed to the stricter of user and org. */
  dataResidency?: DataResidency
  /** Telemetry the org permits. Composed to the stricter of user and org. */
  telemetry?: TelemetryMode
}

/** The settings a user picked for themselves, before the org policy is folded in. */
export interface UserChoice {
  autonomyLevel: AutonomyLevel
  /** The user's own spending cap in won, if they set one. */
  spendingCapKrw?: number
  dataResidency?: DataResidency
  telemetry?: TelemetryMode
}

/** The settings that actually take effect after `applyOrgPolicy`. This is what the daemon enforces. */
export interface EffectiveSettings {
  autonomyLevel: AutonomyLevel
  /** The smaller of the user and org caps, or whichever one is set, or undefined if neither is set. */
  spendingCapKrw?: number
  /** Tiers forced to a phone signature by the org. Always an array (possibly empty). */
  requireApprovalTiers: ActionTier[]
  dataResidency: DataResidency
  telemetry: TelemetryMode
  /** Carried through from the policy so site checks can run against the effective settings. */
  allowedSites?: string[]
  blockedSites?: string[]
}

/** ask < auto < full. Used to clamp the user's level down to the org maximum. */
const LEVEL_RANK: Record<AutonomyLevel, number> = { ask: 0, auto: 1, full: 2 }

/** Clamp `user` down to `max`: returns the user's level if it is within the cap, otherwise the cap. */
export function clampAutonomy(user: AutonomyLevel, max: AutonomyLevel): AutonomyLevel {
  return LEVEL_RANK[user] <= LEVEL_RANK[max] ? user : max
}

/** Intersect two optional caps: the smaller when both are set, the one that is set otherwise, else undefined. */
function intersectCap(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

/** Compose two residencies to the stricter one (`on-device` wins); default `cloud-ok`. */
function stricterResidency(a: DataResidency | undefined, b: DataResidency | undefined): DataResidency {
  if (a === 'on-device' || b === 'on-device') return 'on-device'
  return a ?? b ?? 'cloud-ok'
}

/** Compose two telemetry modes to the stricter one (`off` wins); default `metrics`. */
function stricterTelemetry(a: TelemetryMode | undefined, b: TelemetryMode | undefined): TelemetryMode {
  if (a === 'off' || b === 'off') return 'off'
  return a ?? b ?? 'metrics'
}

/**
 * Fold an org policy into a user's own choice and return the settings that take effect. Pure and total.
 *
 * - autonomy: clamped down to `maxAutonomyLevel` when the org sets one (so a `full` user under an `auto` org is `auto`).
 * - spending cap: the smaller of the user and org caps (intersection).
 * - approval tiers: taken straight from the policy (the tiers the org forces to always sign).
 * - data residency / telemetry: the stricter of user and org.
 * - site globs: carried through for `isSiteAllowed`.
 */
export function applyOrgPolicy(user: UserChoice, policy: OrgPolicy): EffectiveSettings {
  const settings: EffectiveSettings = {
    autonomyLevel: policy.maxAutonomyLevel
      ? clampAutonomy(user.autonomyLevel, policy.maxAutonomyLevel)
      : user.autonomyLevel,
    spendingCapKrw: intersectCap(user.spendingCapKrw, policy.spendingCapKrw),
    requireApprovalTiers: policy.requireApprovalTiers ? [...policy.requireApprovalTiers] : [],
    dataResidency: stricterResidency(user.dataResidency, policy.dataResidency),
    telemetry: stricterTelemetry(user.telemetry, policy.telemetry),
  }
  if (policy.allowedSites) settings.allowedSites = [...policy.allowedSites]
  if (policy.blockedSites) settings.blockedSites = [...policy.blockedSites]
  return settings
}

/** The minimal shape `isSiteAllowed` needs — satisfied by both `OrgPolicy` and `EffectiveSettings`. */
export interface SiteRules {
  allowedSites?: string[]
  blockedSites?: string[]
}

/**
 * Decide whether a site URL may be used under the given rules. Pure.
 * Block-list wins over allow-list: a URL that matches any `blockedSites` glob is refused even if it also matches an
 * `allowedSites` glob. When `allowedSites` is present and non-empty, the URL must match one of its globs; otherwise
 * (no allow-list) any non-blocked site is allowed.
 */
export function isSiteAllowed(rules: SiteRules, url: string): boolean {
  if (rules.blockedSites?.some((glob) => matchUrlGlob(url, glob))) return false
  if (rules.allowedSites && rules.allowedSites.length > 0) {
    return rules.allowedSites.some((glob) => matchUrlGlob(url, glob))
  }
  return true
}

/**
 * Decide an action under effective org settings, composing with the per-user autonomy gate (`decide` in
 * `@dool2/core`). Pure. `read` is never gated. A tier in `requireApprovalTiers` is forced to `sign` regardless of the
 * autonomy level. For `pay`, when the org cap is set and the caller passed an `amountKrw` but no explicit `underCap`,
 * the cap check is filled in from the effective cap before delegating to the core gate.
 */
export function decideWithPolicy(
  settings: EffectiveSettings,
  tier: ActionTier,
  ctx: ActionContext = {},
): GateResult {
  if (tier === 'read') return { decision: 'run', reason: 'read' }
  if (settings.requireApprovalTiers.includes(tier)) {
    return { decision: 'sign', reason: `org:require-approval:${tier}` }
  }
  const merged: ActionContext = { ...ctx }
  if (
    tier === 'pay' &&
    settings.spendingCapKrw !== undefined &&
    ctx.amountKrw !== undefined &&
    merged.underCap === undefined
  ) {
    merged.underCap = ctx.amountKrw <= settings.spendingCapKrw
  }
  return decide(settings.autonomyLevel, tier, merged)
}
