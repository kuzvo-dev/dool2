import { describe, expect, it } from 'vitest'
import type { ActionEnvelope } from './envelope.js'
import { type ExecutedAction, matchesApproved } from './match.js'

const approved: ActionEnvelope = {
  tier: 'pay',
  label: 'Pay 50,000 won',
  amountKrw: 50_000,
  merchant: 'Coupang',
  nonce: 'n-1',
  createdAt: 1_000,
}

describe('matchesApproved', () => {
  it('matches the same action', () => {
    const executed: ExecutedAction = {
      tier: 'pay',
      label: 'Pay 50,000 won',
      amountKrw: 50_000,
      merchant: 'Coupang',
    }
    expect(matchesApproved(executed, approved)).toEqual({ ok: true })
  })

  it('rejects a different amount (0 tolerance)', () => {
    const executed: ExecutedAction = {
      tier: 'pay',
      label: 'Pay 50,001 won',
      amountKrw: 50_001,
      merchant: 'Coupang',
    }
    const r = matchesApproved(executed, approved)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('amount')
  })

  it('rejects a different merchant (payee swap after approval)', () => {
    const executed: ExecutedAction = {
      tier: 'pay',
      label: 'Pay 50,000 won',
      amountKrw: 50_000,
      merchant: 'Attacker',
    }
    const r = matchesApproved(executed, approved)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('merchant')
  })

  it('rejects a different tier', () => {
    const executed: ExecutedAction = {
      tier: 'contact',
      label: 'Pay 50,000 won',
      amountKrw: 50_000,
      merchant: 'Coupang',
    }
    const r = matchesApproved(executed, approved)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('tier')
  })

  it('matches a contact action on recipient', () => {
    const contactApproved: ActionEnvelope = {
      tier: 'contact',
      label: 'Message Jane',
      recipient: 'jane@example.com',
      nonce: 'n-2',
      createdAt: 1_000,
    }
    const same: ExecutedAction = { tier: 'contact', label: 'Message Jane', recipient: 'jane@example.com' }
    const swapped: ExecutedAction = {
      tier: 'contact',
      label: 'Message Jane',
      recipient: 'mallory@example.com',
    }
    expect(matchesApproved(same, contactApproved)).toEqual({ ok: true })
    expect(matchesApproved(swapped, contactApproved).ok).toBe(false)
  })

  it('rejects when the approval pinned a site the execution does not present', () => {
    const siteApproved: ActionEnvelope = { ...approved, site: 'coupang.com' }
    const executed: ExecutedAction = {
      tier: 'pay',
      label: 'Pay 50,000 won',
      amountKrw: 50_000,
      merchant: 'Coupang',
      site: 'evil.com',
    }
    expect(matchesApproved(executed, siteApproved).ok).toBe(false)
  })
})
