// Sign and verify an approval with the phone's device key (Ed25519, ADR 0043). The device keypair lives in the
// phone's secure chip: the private key never leaves the hardware, and signing takes a fingerprint/face/PIN. This
// package only holds the verify side the daemon runs plus a sign helper for the phone app and for tests — key
// storage and the biometric gate are the phone app's job. That seam is `deviceKeyPem` in / `devicePublicKeyPem` out.
//
// A signature is made over the envelope HASH, and verify RECOMPUTES the hash from the envelope it is given. So a
// signature validates only for the exact action it was made for: change the amount, merchant or tier and the hash
// changes, and the signature no longer verifies.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { type ActionEnvelope, envelopeHash } from './envelope.js'

/** The 32 raw hash bytes the signature covers. Internal: sign and verify must agree on exactly these bytes. */
function signingBytes(envelope: ActionEnvelope): Buffer {
  return Buffer.from(envelopeHash(envelope), 'hex')
}

/**
 * Sign an envelope with the device private key (PEM, PKCS#8 Ed25519). Returns a base64 signature. In production this
 * runs inside the phone's secure chip after the user confirms; here it is used by the phone app and by tests. The
 * daemon never holds the private key and never calls this.
 */
export function signApproval(envelope: ActionEnvelope, deviceKeyPem: string): string {
  const key = createPrivateKey(deviceKeyPem)
  // Ed25519: a null algorithm signs the message directly (no external digest). The message is the envelope hash.
  return sign(null, signingBytes(envelope), key).toString('base64')
}

/**
 * Verify a base64 signature against an envelope and the device public key (PEM, SPKI Ed25519). Recomputes the hash
 * from the envelope, so it returns true only when the signature was made for this EXACT action. Any malformed input
 * (bad PEM, bad base64) returns false rather than throwing — a bad approval is simply not approved.
 */
export function verifyApproval(
  envelope: ActionEnvelope,
  signature: string,
  devicePublicKeyPem: string,
): boolean {
  try {
    const key = createPublicKey(devicePublicKeyPem)
    return verify(null, signingBytes(envelope), key, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

/** A device keypair as PEM strings. The real one is generated in the phone's secure chip; this shape is the seam. */
export interface DeviceKeyPair {
  /** PKCS#8 Ed25519 private key PEM. In production this never leaves the secure chip. */
  privateKeyPem: string
  /** SPKI Ed25519 public key PEM. Shared with the daemon so it can verify the phone's signatures. */
  publicKeyPem: string
}

/**
 * Generate an Ed25519 device keypair. For tests and for the phone app's dev path; the production key is minted and
 * held by the secure chip, which only ever exports the public half to the daemon.
 */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}
