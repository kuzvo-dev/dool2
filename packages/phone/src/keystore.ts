// The secure-chip seam. On a real phone the device keypair lives in hardware — iOS Secure Enclave or Android
// StrongBox — and the private key can never be read out: the OS signs bytes inside the chip only after the user
// clears a biometric/PIN gate. This module expresses that hardware as one small interface, `KeyStore`, with two
// operations the rest of the package depends on:
//
//   - getPublicKeyPem(): the public half, which the daemon stores at pairing to verify later signatures.
//   - sign(bytes):       an Ed25519 signature over exactly those bytes, produced by the chip.
//
// The native shell (iOS/Android, a later PR) implements `KeyStore` by calling the platform keychain/keystore APIs;
// it is the only place the biometric prompt and the hardware key live. Everything else in @dool2/phone — the card,
// signCard, the simulator — talks only to this interface and never sees a private key.
//
// For tests and a dev/simulator path we ship `InMemoryKeyStore`, a reference implementation that keeps an Ed25519
// keypair in process memory and signs with it. It produces byte-for-byte the same signature a hardware key would, so
// a signature it makes verifies on the daemon through @dool2/approvals verifyApproval. It is NOT secure storage: the
// private key is in memory, so it is only ever used in tests and local development, never in a shipped app.

import { createPrivateKey, sign } from 'node:crypto'
import { type DeviceKeyPair, generateDeviceKeyPair } from '@dool2/approvals'

/**
 * The device key as the rest of the phone client sees it: a public key to register at pairing, and a way to sign a
 * block of bytes. Both are async because a real secure chip signs behind a biometric/PIN prompt. The implementation
 * holds the private key (in hardware, in production); callers never receive it.
 */
export interface KeyStore {
  /** The device public key (SPKI Ed25519 PEM). Shared with the daemon at pairing so it can verify signatures. */
  getPublicKeyPem(): Promise<string>
  /** Sign the given bytes with the device private key, inside the chip. Returns a base64 Ed25519 signature. */
  sign(bytes: Uint8Array): Promise<string>
}

/**
 * Reference in-memory `KeyStore` for tests and local dev. Holds an Ed25519 keypair in process memory and signs with
 * it exactly as @dool2/approvals signApproval would, so its signatures verify on the daemon. Production uses the
 * native Secure Enclave / StrongBox implementation instead; this one never ships in an app.
 */
export class InMemoryKeyStore implements KeyStore {
  readonly #keypair: DeviceKeyPair

  /** Reuse an existing device keypair (e.g. one already paired) or mint a fresh Ed25519 one. */
  constructor(keypair: DeviceKeyPair = generateDeviceKeyPair()) {
    this.#keypair = keypair
  }

  async getPublicKeyPem(): Promise<string> {
    return this.#keypair.publicKeyPem
  }

  async sign(bytes: Uint8Array): Promise<string> {
    const key = createPrivateKey(this.#keypair.privateKeyPem)
    // Ed25519: a null algorithm signs the message directly (no external digest), matching @dool2/approvals.
    return sign(null, Buffer.from(bytes), key).toString('base64')
  }
}
