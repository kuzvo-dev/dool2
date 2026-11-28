import { describe, expect, it } from 'vitest'
import type { ActionEnvelope } from './envelope.js'
import { ApprovalStore, approvalRequired, DEFAULT_TTL_MS, pendingApproval } from './pending.js'
import { generateDeviceKeyPair, signApproval } from './sign.js'

const keys = generateDeviceKeyPair()

function envelopeAt(createdAt: number, nonce = 'n-1'): ActionEnvelope {
  return { tier: 'pay', label: 'Pay 50,000 won', amountKrw: 50_000, merchant: 'Coupang', nonce, createdAt }
}

describe('approvalRequired', () => {
  it('is true only for sign', () => {
    expect(approvalRequired('sign')).toBe(true)
    expect(approvalRequired('run')).toBe(false)
    expect(approvalRequired('notify')).toBe(false)
    expect(approvalRequired('review')).toBe(false)
    expect(approvalRequired('block')).toBe(false)
  })
})

describe('pendingApproval', () => {
  it('derives the hash and the expiry from createdAt', () => {
    const env = envelopeAt(1_000)
    const p = pendingApproval(env, DEFAULT_TTL_MS)
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(p.createdAt).toBe(1_000)
    expect(p.expiresAt).toBe(1_000 + DEFAULT_TTL_MS)
  })
})

describe('ApprovalStore.verifyAndConsume', () => {
  it('accepts a valid, unexpired, unspent approval', () => {
    const env = envelopeAt(1_000)
    const sig = signApproval(env, keys.privateKeyPem)
    const store = new ApprovalStore()
    expect(store.verifyAndConsume(env, sig, keys.publicKeyPem, 1_500)).toEqual({ ok: true })
  })

  it('rejects an expired envelope', () => {
    const env = envelopeAt(1_000)
    const sig = signApproval(env, keys.privateKeyPem)
    const store = new ApprovalStore()
    const now = 1_000 + DEFAULT_TTL_MS + 1
    expect(store.verifyAndConsume(env, sig, keys.publicKeyPem, now)).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a reused nonce (single-use)', () => {
    const env = envelopeAt(1_000)
    const sig = signApproval(env, keys.privateKeyPem)
    const store = new ApprovalStore()
    expect(store.verifyAndConsume(env, sig, keys.publicKeyPem, 1_500)).toEqual({ ok: true })
    // Same nonce, even with a valid signature, cannot be spent twice.
    expect(store.verifyAndConsume(env, sig, keys.publicKeyPem, 1_600)).toEqual({
      ok: false,
      reason: 'nonce-reused',
    })
    expect(store.isSpent('n-1')).toBe(true)
  })

  it('rejects a signature made for a different envelope', () => {
    const env = envelopeAt(1_000)
    const sigForOther = signApproval({ ...env, amountKrw: 999_999 }, keys.privateKeyPem)
    const store = new ApprovalStore()
    expect(store.verifyAndConsume(env, sigForOther, keys.publicKeyPem, 1_500)).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
    // A rejected attempt does not spend the nonce.
    expect(store.isSpent('n-1')).toBe(false)
  })

  it('prune forgets records past their window', () => {
    const env = envelopeAt(1_000)
    const sig = signApproval(env, keys.privateKeyPem)
    const store = new ApprovalStore()
    store.verifyAndConsume(env, sig, keys.publicKeyPem, 1_500)
    store.prune(1_000 + DEFAULT_TTL_MS + 1)
    expect(store.isSpent('n-1')).toBe(false)
  })
})
