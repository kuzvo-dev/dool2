import { describe, expect, it } from 'vitest'
import {
  canonicalizeConsent,
  FULL_AUTO_CONSENT_TEXT,
  fullAutoConsent,
  newCapUpdateEnvelope,
  newConsentEnvelope,
  signCapUpdate,
  signConsent,
  verifyCapUpdate,
  verifyConsent,
} from './consent.js'
import { generateDeviceKeyPair } from './sign.js'

describe('full-auto consent signing', () => {
  it('canonical text is the Korean reference copy', () => {
    expect(FULL_AUTO_CONSENT_TEXT).toBe('결과를 보장할 수 없고 모든 책임은 사용자에게 있습니다')
    expect(FULL_AUTO_CONSENT_TEXT).toBe(fullAutoConsent.ko)
  })

  it('a correctly signed consent verifies against the paired device key', () => {
    const device = generateDeviceKeyPair()
    const env = newConsentEnvelope(1000)
    const sig = signConsent(env, device.privateKeyPem)
    expect(verifyConsent(env, sig, device.publicKeyPem)).toEqual({ ok: true })
  })

  it('a tampered text fails (wrong-text), even with an otherwise valid signature', () => {
    const device = generateDeviceKeyPair()
    const env = newConsentEnvelope(1000)
    const sig = signConsent(env, device.privateKeyPem)
    const tampered = { ...env, text: 'I agree to everything' }
    expect(verifyConsent(tampered, sig, device.publicKeyPem)).toEqual({ ok: false, reason: 'wrong-text' })
  })

  it('a signature from an unpaired key fails (bad-signature)', () => {
    const paired = generateDeviceKeyPair()
    const attacker = generateDeviceKeyPair()
    const env = newConsentEnvelope(1000)
    const sig = signConsent(env, attacker.privateKeyPem)
    expect(verifyConsent(env, sig, paired.publicKeyPem)).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('an expired consent fails when a maxAgeMs is given', () => {
    const device = generateDeviceKeyPair()
    const env = newConsentEnvelope(1000)
    const sig = signConsent(env, device.privateKeyPem)
    expect(verifyConsent(env, sig, device.publicKeyPem, { now: 1000 + 10, maxAgeMs: 5 })).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(verifyConsent(env, sig, device.publicKeyPem, { now: 1000 + 3, maxAgeMs: 5 })).toEqual({ ok: true })
  })

  it('canonicalize is stable and includes the three bound fields', () => {
    const env = newConsentEnvelope(42)
    expect(canonicalizeConsent(env)).toContain('"createdAt"')
    expect(canonicalizeConsent(env)).toBe(canonicalizeConsent({ ...env }))
  })
})

describe('phone-signed cap update', () => {
  it('a correctly signed cap update verifies, a tampered amount does not', () => {
    const device = generateDeviceKeyPair()
    const env = newCapUpdateEnvelope(300_000, 'month', 1000)
    const sig = signCapUpdate(env, device.privateKeyPem)
    expect(verifyCapUpdate(env, sig, device.publicKeyPem)).toBe(true)
    expect(verifyCapUpdate({ ...env, amountKrw: 1 }, sig, device.publicKeyPem)).toBe(false)
  })
})
