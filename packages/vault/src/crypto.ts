// At-rest encryption for the vault. This PR ships a simple, correct reference implementation (scrypt + AES-256-GCM)
// so the package is self-contained and testable. It is NOT the production key wrapping: in a later PR the derived
// key is wrapped by a hardware-held key (Secure Enclave / TPM) and the KDF moves to Argon2id. The `VaultCrypto`
// interface and the `KeyWrapper` seam below are where that lands; nothing else in the package needs to change.

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (password: string, salt: Uint8Array, keylen: number) => Promise<Buffer>

/** A sealed secret: self-describing so `open` needs only the box and the password. No plaintext, no key. */
export interface SealedSecret {
  v: 1
  kdf: 'scrypt'
  cipher: 'aes-256-gcm'
  /** base64 */
  salt: string
  /** base64 */
  iv: string
  /** base64 GCM auth tag */
  tag: string
  /** base64 ciphertext */
  ct: string
}

export interface VaultCrypto {
  /** Derive a 32-byte key from the password and salt. */
  deriveKey(password: string, salt: Uint8Array): Promise<Buffer>
  /** Encrypt plaintext under the password, returning a self-describing sealed box. */
  seal(plaintext: string, password: string): Promise<SealedSecret>
  /** Decrypt a sealed box with the password. Throws if the password is wrong (GCM auth fails). */
  open(box: SealedSecret, password: string): Promise<string>
}

/**
 * The seam for production key wrapping: the scrypt/Argon2id-derived key gets wrapped by a key held in the Secure
 * Enclave / TPM, so the at-rest key material never exists unwrapped outside hardware. Implemented in a later PR.
 */
export interface KeyWrapper {
  wrap(key: Uint8Array): Promise<Uint8Array>
  unwrap(wrapped: Uint8Array): Promise<Uint8Array>
}

const SALT_BYTES = 16
const IV_BYTES = 12
const KEY_BYTES = 32

/** Reference VaultCrypto: scrypt KDF + AES-256-GCM. Correct and testable; not the production key wrapping. */
export class ScryptAesGcmCrypto implements VaultCrypto {
  async deriveKey(password: string, salt: Uint8Array): Promise<Buffer> {
    return scrypt(password, salt, KEY_BYTES)
  }

  async seal(plaintext: string, password: string): Promise<SealedSecret> {
    const salt = randomBytes(SALT_BYTES)
    const iv = randomBytes(IV_BYTES)
    const key = await this.deriveKey(password, salt)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      v: 1,
      kdf: 'scrypt',
      cipher: 'aes-256-gcm',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ct.toString('base64'),
    }
  }

  async open(box: SealedSecret, password: string): Promise<string> {
    const salt = Buffer.from(box.salt, 'base64')
    const iv = Buffer.from(box.iv, 'base64')
    const key = await this.deriveKey(password, salt)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]).toString('utf8')
  }
}
