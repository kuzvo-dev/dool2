// Phone-signed daemon settings changes beyond per-action approvals (ADR 0047). Two things live here, both signed by
// the phone's secure chip (Ed25519, ADR 0043) the same way an ActionEnvelope is, and both verified by the daemon with
// the paired device public key before the daemon changes a setting that removes a brake:
//
//   - ConsentEnvelope / signConsent / verifyConsent — the one-time consent that unlocks full-auto. The signed text
//     must be the exact canonical wording (fullAutoConsent.ko); a tampered text changes the hash and fails to verify.
//   - CapUpdateEnvelope / signCapUpdate / verifyCapUpdate — a phone-signed change to the spending cap after onboarding.
//
// As in sign.ts, the signature is made over a sha256 HASH of a canonical, deterministic string, and verify recomputes
// that hash from the envelope it is given, so a signature validates only for the exact value it was made for. The
// daemon never holds the private key; signConsent/signCapUpdate run on the phone (and in tests). Secrets never appear.

import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto'
import type { CapPeriod } from '@dool2/core'
import { fullAutoConsent } from './locales/consent.js'

export { type ConsentLang, fullAutoConsent } from './locales/consent.js'

/** The exact text the full-auto consent signs. Canonical = the Korean reference copy (ADR 0047, 0029). */
export const FULL_AUTO_CONSENT_TEXT = fullAutoConsent.ko

/** A deterministic, sorted `[key, value]` JSON string for any flat record. Stable under key reordering. */
function canonicalize(fields: readonly string[], obj: Record<string, unknown>): string {
  const pairs: [string, unknown][] = []
  for (const key of [...fields].sort()) {
    const value = obj[key]
    if (value !== undefined) pairs.push([key, value])
  }
  return JSON.stringify(pairs)
}

/** The 32 raw hash bytes a signature covers, so sign and verify agree on exactly these bytes. */
function signingBytes(canonical: string): Buffer {
  return Buffer.from(createHash('sha256').update(canonical, 'utf8').digest('hex'), 'hex')
}

function signCanonical(canonical: string, deviceKeyPem: string): string {
  const key = createPrivateKey(deviceKeyPem)
  return sign(null, signingBytes(canonical), key).toString('base64')
}

function verifyCanonical(canonical: string, signature: string, devicePublicKeyPem: string): boolean {
  try {
    const key = createPublicKey(devicePublicKeyPem)
    return verify(null, signingBytes(canonical), key, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

// --- full-auto consent ----------------------------------------------------------------------------------------------

/**
 * The one-time consent that unlocks full-auto. `text` is the wording the user agreed to (must equal
 * FULL_AUTO_CONSENT_TEXT), `nonce` makes it single-use against a nonce store, and `createdAt` drives optional expiry.
 */
export interface ConsentEnvelope {
  text: string
  nonce: string
  createdAt: number
}

const CONSENT_FIELDS = ['createdAt', 'nonce', 'text'] as const

export function canonicalizeConsent(env: ConsentEnvelope): string {
  return canonicalize(CONSENT_FIELDS, env as unknown as Record<string, unknown>)
}

export function consentHash(env: ConsentEnvelope): string {
  return createHash('sha256').update(canonicalizeConsent(env), 'utf8').digest('hex')
}

/** A fresh full-auto consent envelope carrying the canonical text. The phone signs it; the daemon verifies it. */
export function newConsentEnvelope(now: number = Date.now()): ConsentEnvelope {
  return { text: FULL_AUTO_CONSENT_TEXT, nonce: randomUUID(), createdAt: now }
}

/** Sign a consent envelope with the device private key (PEM). Runs on the phone / in tests, never on the daemon. */
export function signConsent(env: ConsentEnvelope, deviceKeyPem: string): string {
  return signCanonical(canonicalizeConsent(env), deviceKeyPem)
}

export type ConsentVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'wrong-text' | 'expired' | 'bad-signature' }

export interface ConsentVerifyOptions {
  now?: number
  /** Max age in ms a signed consent stays valid; omit for no expiry. */
  maxAgeMs?: number
}

/**
 * Verify a consent signature with the paired device public key. Returns ok only when the text is the exact canonical
 * wording, the (optional) age is within maxAgeMs, and the signature verifies for this exact envelope. Any malformed
 * input fails closed rather than throwing — a bad consent is simply not a consent.
 */
export function verifyConsent(
  env: ConsentEnvelope,
  signature: string,
  devicePublicKeyPem: string,
  opts: ConsentVerifyOptions = {},
): ConsentVerifyResult {
  if (env.text !== FULL_AUTO_CONSENT_TEXT) return { ok: false, reason: 'wrong-text' }
  if (opts.maxAgeMs !== undefined && (opts.now ?? Date.now()) - env.createdAt > opts.maxAgeMs) {
    return { ok: false, reason: 'expired' }
  }
  return verifyCanonical(canonicalizeConsent(env), signature, devicePublicKeyPem)
    ? { ok: true }
    : { ok: false, reason: 'bad-signature' }
}

// --- phone-signed spending-cap change -------------------------------------------------------------------------------

/** A phone-signed change to the spending cap (ADR 0047). Onboarding sets the first cap unsigned; later changes sign. */
export interface CapUpdateEnvelope {
  amountKrw: number
  period: CapPeriod
  nonce: string
  createdAt: number
}

const CAP_FIELDS = ['amountKrw', 'createdAt', 'nonce', 'period'] as const

export function canonicalizeCapUpdate(env: CapUpdateEnvelope): string {
  return canonicalize(CAP_FIELDS, env as unknown as Record<string, unknown>)
}

export function capUpdateHash(env: CapUpdateEnvelope): string {
  return createHash('sha256').update(canonicalizeCapUpdate(env), 'utf8').digest('hex')
}

/** A fresh cap-update envelope the phone signs to change the cap to `amountKrw`/`period`. */
export function newCapUpdateEnvelope(
  amountKrw: number,
  period: CapPeriod,
  now: number = Date.now(),
): CapUpdateEnvelope {
  return { amountKrw, period, nonce: randomUUID(), createdAt: now }
}

export function signCapUpdate(env: CapUpdateEnvelope, deviceKeyPem: string): string {
  return signCanonical(canonicalizeCapUpdate(env), deviceKeyPem)
}

/** Verify a cap-update signature with the paired device public key. False (fail closed) on any malformed input. */
export function verifyCapUpdate(
  env: CapUpdateEnvelope,
  signature: string,
  devicePublicKeyPem: string,
): boolean {
  return verifyCanonical(canonicalizeCapUpdate(env), signature, devicePublicKeyPem)
}
