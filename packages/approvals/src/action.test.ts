import type { GatedAction } from '@dool2/core'
import { describe, expect, it } from 'vitest'
import { type ActionForEnvelope, envelopeForAction } from './action.js'
import { envelopeHash } from './envelope.js'

const pay: GatedAction = { tier: 'pay', label: 'Pay 50,000 won', amountKrw: 50_000 }

describe('envelopeForAction — the single, deterministic builder', () => {
  it('is deterministic: the same action always hashes the same (so the engine can reproduce it in a resume turn)', () => {
    const a = envelopeHash(envelopeForAction(pay))
    const b = envelopeHash(envelopeForAction({ ...pay }))
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('pins createdAt out of the hash so the timestamp cannot make two mints of the same action differ', () => {
    const env = envelopeForAction(pay)
    expect(env.createdAt).toBe(0)
    // Even if something handed it a real createdAt, the hash depends only on the bound facts + the derived nonce.
    expect(envelopeHash(env)).toBe(envelopeHash(envelopeForAction(pay)))
  })

  it('changes the hash when any bound fact changes', () => {
    const base = envelopeHash(envelopeForAction(pay))
    expect(envelopeHash(envelopeForAction({ ...pay, amountKrw: 50_001 }))).not.toBe(base)
    expect(envelopeHash(envelopeForAction({ ...pay, label: 'Pay more' }))).not.toBe(base)
    expect(envelopeHash(envelopeForAction({ ...pay, tier: 'contact' }))).not.toBe(base)
    const withMerchant: ActionForEnvelope = { ...pay, merchant: 'Coupang' }
    expect(envelopeHash(envelopeForAction(withMerchant))).not.toBe(base)
  })

  it('derives a stable nonce from the facts (same action -> same nonce, so a replayed signature is caught)', () => {
    expect(envelopeForAction(pay).nonce).toBe(envelopeForAction(pay).nonce)
    expect(envelopeForAction(pay).nonce).not.toBe(envelopeForAction({ ...pay, amountKrw: 1 }).nonce)
  })
})
