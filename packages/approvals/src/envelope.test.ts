import { describe, expect, it } from 'vitest'
import { type ActionEnvelope, canonicalize, envelopeHash, newNonce } from './envelope.js'

const base: ActionEnvelope = {
  tier: 'pay',
  label: 'Pay 50,000 won',
  amountKrw: 50_000,
  merchant: 'Coupang',
  nonce: 'n-1',
  createdAt: 1_000,
}

describe('canonicalize / envelopeHash', () => {
  it('is stable under key reordering', () => {
    const a: ActionEnvelope = {
      tier: 'pay',
      label: 'Pay 50,000 won',
      amountKrw: 50_000,
      merchant: 'Coupang',
      nonce: 'n-1',
      createdAt: 1_000,
    }
    // Same facts, keys written in a different order.
    const b: ActionEnvelope = {
      createdAt: 1_000,
      nonce: 'n-1',
      merchant: 'Coupang',
      amountKrw: 50_000,
      label: 'Pay 50,000 won',
      tier: 'pay',
    }
    expect(canonicalize(a)).toBe(canonicalize(b))
    expect(envelopeHash(a)).toBe(envelopeHash(b))
  })

  it('treats an explicit undefined field the same as an omitted one', () => {
    const withUndef: ActionEnvelope = { ...base, amountKrw: 50_000, recipient: undefined, site: undefined }
    const without: ActionEnvelope = {
      tier: 'pay',
      label: 'Pay 50,000 won',
      amountKrw: 50_000,
      merchant: 'Coupang',
      nonce: 'n-1',
      createdAt: 1_000,
    }
    expect(envelopeHash(withUndef)).toBe(envelopeHash(without))
  })

  it('changes the hash when any bound field changes', () => {
    const h = envelopeHash(base)
    expect(envelopeHash({ ...base, amountKrw: 50_001 })).not.toBe(h)
    expect(envelopeHash({ ...base, merchant: 'Other' })).not.toBe(h)
    expect(envelopeHash({ ...base, tier: 'contact' })).not.toBe(h)
    expect(envelopeHash({ ...base, nonce: 'n-2' })).not.toBe(h)
    expect(envelopeHash({ ...base, createdAt: 1_001 })).not.toBe(h)
  })

  it('produces a 64-hex-char sha256', () => {
    expect(envelopeHash(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('mints unique nonces', () => {
    expect(newNonce()).not.toBe(newNonce())
  })
})
