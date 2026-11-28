// The code-enforced spending cap for full-auto (ADR 0047). A cap ALWAYS exists in full-auto; the daemon
// tracks how much has been spent in the current period and refuses a pay that would cross the effective cap — the
// smaller of the user's own cap and any org ceiling. Spend is recorded only when a pay actually runs (notify or an
// approved+resumed sign), never when it is merely weighed. This module is the daemon's in-memory ledger; secrets
// never reach it — only amounts in won. Persistence is a later seam (snapshot()/the constructor's initial spent).

import type { CapPeriod, SpendingCap } from '@dool2/core'

export type { CapPeriod, SpendingCap } from '@dool2/core'

/** The effective cap: min(userCap, orgCap). Either may be undefined; the stricter one wins. */
export function effectiveCapKrw(user: number | undefined, org: number | undefined): number | undefined {
  if (user === undefined) return org
  if (org === undefined) return user
  return Math.min(user, org)
}

/** The start (unix ms, local time) of the period `now` falls in. Day = local midnight; month = the 1st at midnight. */
export function periodStart(period: CapPeriod, now: number): number {
  const d = new Date(now)
  return period === 'day'
    ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    : new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/**
 * The spend ledger for one user. It holds the cap, the won spent in the current period, and the period it is in; a
 * read or a record in a later period rolls the window over and resets the spent total. All amounts are in won.
 */
export class SpendLedger {
  #cap: SpendingCap
  #spent: number
  #periodStart: number

  constructor(cap: SpendingCap, now: number = Date.now(), spent = 0) {
    this.#cap = cap
    this.#spent = spent
    this.#periodStart = periodStart(cap.period, now)
  }

  /** Roll the window to the period `now` is in, resetting the spent total when it is a new period. */
  #roll(now: number): void {
    const start = periodStart(this.#cap.period, now)
    if (start !== this.#periodStart) {
      this.#periodStart = start
      this.#spent = 0
    }
  }

  get cap(): SpendingCap {
    return this.#cap
  }

  /** Change the cap (onboarding or a phone-signed update). Spend carries over; the window is pinned to `now`. */
  setCap(cap: SpendingCap, now: number = Date.now()): void {
    this.#cap = cap
    this.#periodStart = periodStart(cap.period, now)
  }

  /** Won spent in the current period (rolling the window first). */
  spent(now: number = Date.now()): number {
    this.#roll(now)
    return this.#spent
  }

  /** Whether spending `amountKrw` more would cross `effectiveCapKrw` this period. */
  wouldExceed(amountKrw: number, effectiveCapKrw: number, now: number = Date.now()): boolean {
    return this.spent(now) + amountKrw > effectiveCapKrw
  }

  /** Record a pay that actually ran. Only called after the gate let the payment through. */
  record(amountKrw: number, now: number = Date.now()): void {
    this.#roll(now)
    this.#spent += amountKrw
  }
}
