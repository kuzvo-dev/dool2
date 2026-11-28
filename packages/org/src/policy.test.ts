import { describe, expect, it } from 'vitest'
import {
  applyOrgPolicy,
  clampAutonomy,
  decideWithPolicy,
  type EffectiveSettings,
  isSiteAllowed,
  type OrgPolicy,
  type UserChoice,
} from './policy.js'

describe('applyOrgPolicy (master plan workstream H)', () => {
  it('clamps autonomy: user "full" under an org max of "auto" becomes "auto"', () => {
    const user: UserChoice = { autonomyLevel: 'full' }
    const policy: OrgPolicy = { maxAutonomyLevel: 'auto' }
    expect(applyOrgPolicy(user, policy).autonomyLevel).toBe('auto')
  })

  it('leaves autonomy alone when it is already within the org cap', () => {
    expect(applyOrgPolicy({ autonomyLevel: 'ask' }, { maxAutonomyLevel: 'auto' }).autonomyLevel).toBe('ask')
    expect(applyOrgPolicy({ autonomyLevel: 'auto' }, {}).autonomyLevel).toBe('auto')
  })

  it('an org that caps at "auto" makes "full" unreachable for any user choice', () => {
    for (const level of ['ask', 'auto', 'full'] as const) {
      const eff = applyOrgPolicy({ autonomyLevel: level }, { maxAutonomyLevel: 'auto' })
      expect(eff.autonomyLevel).not.toBe('full')
    }
  })

  it('clampAutonomy orders ask < auto < full', () => {
    expect(clampAutonomy('full', 'ask')).toBe('ask')
    expect(clampAutonomy('auto', 'full')).toBe('auto')
    expect(clampAutonomy('full', 'full')).toBe('full')
  })

  it('intersects the spending cap to the smaller of user and org', () => {
    expect(
      applyOrgPolicy({ autonomyLevel: 'auto', spendingCapKrw: 100_000 }, { spendingCapKrw: 50_000 })
        .spendingCapKrw,
    ).toBe(50_000)
    expect(
      applyOrgPolicy({ autonomyLevel: 'auto', spendingCapKrw: 30_000 }, { spendingCapKrw: 50_000 })
        .spendingCapKrw,
    ).toBe(30_000)
  })

  it('uses whichever cap is set when only one side has one, undefined when neither does', () => {
    expect(applyOrgPolicy({ autonomyLevel: 'auto' }, { spendingCapKrw: 50_000 }).spendingCapKrw).toBe(50_000)
    expect(applyOrgPolicy({ autonomyLevel: 'auto', spendingCapKrw: 20_000 }, {}).spendingCapKrw).toBe(20_000)
    expect(applyOrgPolicy({ autonomyLevel: 'auto' }, {}).spendingCapKrw).toBeUndefined()
  })

  it('composes data residency and telemetry to the stricter side', () => {
    const eff = applyOrgPolicy(
      { autonomyLevel: 'auto', dataResidency: 'cloud-ok', telemetry: 'metrics' },
      { dataResidency: 'on-device', telemetry: 'off' },
    )
    expect(eff.dataResidency).toBe('on-device')
    expect(eff.telemetry).toBe('off')
    const open = applyOrgPolicy({ autonomyLevel: 'auto' }, {})
    expect(open.dataResidency).toBe('cloud-ok')
    expect(open.telemetry).toBe('metrics')
  })

  it('carries the approval tiers and site globs through to the effective settings', () => {
    const eff = applyOrgPolicy(
      { autonomyLevel: 'auto' },
      { requireApprovalTiers: ['delete'], allowedSites: ['*.gov.kr'], blockedSites: ['evil.com'] },
    )
    expect(eff.requireApprovalTiers).toEqual(['delete'])
    expect(eff.allowedSites).toEqual(['*.gov.kr'])
    expect(eff.blockedSites).toEqual(['evil.com'])
  })
})

describe('isSiteAllowed', () => {
  it('blockedSites overrides allowedSites', () => {
    const rules = { allowedSites: ['*.example.com'], blockedSites: ['secret.example.com'] }
    expect(isSiteAllowed(rules, 'https://app.example.com/home')).toBe(true)
    expect(isSiteAllowed(rules, 'https://secret.example.com/x')).toBe(false)
  })

  it('an allow-list restricts to matching sites', () => {
    const rules = { allowedSites: ['*.gov.kr'] }
    expect(isSiteAllowed(rules, 'https://www.gov.kr/portal')).toBe(true)
    expect(isSiteAllowed(rules, 'https://coupang.com/')).toBe(false)
  })

  it('no allow-list allows any non-blocked site', () => {
    expect(isSiteAllowed({}, 'https://anything.com/')).toBe(true)
    expect(isSiteAllowed({ blockedSites: ['bad.com'] }, 'https://bad.com/')).toBe(false)
    expect(isSiteAllowed({ blockedSites: ['bad.com'] }, 'https://good.com/')).toBe(true)
  })
})

describe('decideWithPolicy (composes with the @dool2/core autonomy gate)', () => {
  const base: EffectiveSettings = {
    autonomyLevel: 'auto',
    requireApprovalTiers: [],
    dataResidency: 'cloud-ok',
    telemetry: 'metrics',
  }

  it('requireApprovalTiers forces a signature regardless of level', () => {
    // At "auto", a plain act would normally just run.
    expect(decideWithPolicy(base, 'act').decision).toBe('run')
    const forced: EffectiveSettings = { ...base, requireApprovalTiers: ['act', 'contact'] }
    expect(decideWithPolicy(forced, 'act').decision).toBe('sign')
    expect(decideWithPolicy(forced, 'contact').decision).toBe('sign')
  })

  it('read is never gated even if listed in requireApprovalTiers', () => {
    const forced: EffectiveSettings = { ...base, requireApprovalTiers: ['read'] }
    expect(decideWithPolicy(forced, 'read').decision).toBe('run')
  })

  it('delegates to the core gate when no tier is forced', () => {
    // auto: contact goes through the reviewer, pay always signs.
    expect(decideWithPolicy(base, 'contact').decision).toBe('review')
    expect(decideWithPolicy(base, 'pay').decision).toBe('sign')
  })

  it('fills in underCap from the effective cap for pay in full-auto', () => {
    const full: EffectiveSettings = { ...base, autonomyLevel: 'full', spendingCapKrw: 50_000 }
    // Under the cap with a known merchant: runs with a notice.
    expect(decideWithPolicy(full, 'pay', { amountKrw: 10_000, merchantKnown: true }).decision).toBe('notify')
    // Over the cap: blocked.
    expect(decideWithPolicy(full, 'pay', { amountKrw: 90_000, merchantKnown: true }).decision).toBe('block')
  })
})
