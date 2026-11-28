import { describe, expect, it } from 'vitest'
import type { ActionEnvelope } from './envelope.js'
import { generateDeviceKeyPair, signApproval, verifyApproval } from './sign.js'

const keys = generateDeviceKeyPair()

const envelope: ActionEnvelope = {
  tier: 'pay',
  label: 'Pay 50,000 won',
  amountKrw: 50_000,
  merchant: 'Coupang',
  nonce: 'n-1',
  createdAt: 1_000,
}

describe('signApproval / verifyApproval', () => {
  it('round-trips sign -> verify for the exact action', () => {
    const sig = signApproval(envelope, keys.privateKeyPem)
    expect(verifyApproval(envelope, sig, keys.publicKeyPem)).toBe(true)
  })

  it('does not verify for a modified amount', () => {
    const sig = signApproval(envelope, keys.privateKeyPem)
    expect(verifyApproval({ ...envelope, amountKrw: 60_000 }, sig, keys.publicKeyPem)).toBe(false)
  })

  it('does not verify for a modified merchant', () => {
    const sig = signApproval(envelope, keys.privateKeyPem)
    expect(verifyApproval({ ...envelope, merchant: 'Attacker' }, sig, keys.publicKeyPem)).toBe(false)
  })

  it('does not verify for a modified tier', () => {
    const sig = signApproval(envelope, keys.privateKeyPem)
    expect(verifyApproval({ ...envelope, tier: 'contact' }, sig, keys.publicKeyPem)).toBe(false)
  })

  it('does not verify under a different device public key', () => {
    const sig = signApproval(envelope, keys.privateKeyPem)
    const other = generateDeviceKeyPair()
    expect(verifyApproval(envelope, sig, other.publicKeyPem)).toBe(false)
  })

  it('returns false (not throws) on malformed signature or key', () => {
    expect(verifyApproval(envelope, 'not-base64!!', keys.publicKeyPem)).toBe(false)
    expect(verifyApproval(envelope, signApproval(envelope, keys.privateKeyPem), 'not-a-pem')).toBe(false)
  })
})
