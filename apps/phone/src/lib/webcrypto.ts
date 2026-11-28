// The phone's device key, implemented with WebCrypto for the browser (the phone app runs in a WebView, not Node).
//
// This is the browser twin of @dool2/phone's InMemoryKeyStore: it satisfies the same `KeyStore` seam, so it drops
// straight into pairDevice and the signing path. The difference is where the key lives — here it is a WebCrypto
// Ed25519 CryptoKeyPair, created non-extractable so the private half CANNOT be read back out (the native iOS/Android
// shell will later back this with the Secure Enclave / StrongBox; the contract is identical). Only the PUBLIC key is
// ever exported, as the SPKI PEM the daemon stores at pairing. Signing happens inside WebCrypto; the private key never
// leaves it, exactly as on real hardware.
//
// The bytes signed are the 32 raw bytes of the envelope's sha256 hash — identical to @dool2/approvals signingBytes —
// so a signature made here verifies on the daemon through verifyApproval unchanged. We compute that hash with
// WebCrypto (crypto.subtle.digest) over the SAME canonical string @dool2/approvals canonicalize() produces, so the
// phone and the daemon always agree on the bytes.

import type { ActionEnvelope } from '@dool2/approvals'
import { canonicalize } from '@dool2/approvals'
import type { KeyStore } from '@dool2/phone'

const ED25519 = { name: 'Ed25519' } as const

/** The 32 raw sha256 bytes of the envelope's canonical form — the exact value the device key signs (ADR 0043). */
export async function hashEnvelopeBytes(envelope: ActionEnvelope): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(canonicalize(envelope))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return new Uint8Array(digest)
}

/** The envelope hash as a hex string — identical to @dool2/approvals envelopeHash, computed with WebCrypto so it
 *  runs in the phone WebView. This is the value the daemon looks an approval up by. */
export async function hashEnvelopeHex(envelope: ActionEnvelope): Promise<string> {
  const bytes = await hashEnvelopeBytes(envelope)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Wrap a raw key body in a PEM envelope so it matches the SPKI PEM the daemon stores and @dool2/approvals parses. */
function toPem(der: ArrayBuffer, label: string): string {
  const b64 = toBase64(new Uint8Array(der))
  const lines = b64.match(/.{1,64}/g) ?? [b64]
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/**
 * A `KeyStore` backed by a WebCrypto Ed25519 keypair. The private key is generated non-extractable, so only the
 * browser's crypto engine can ever use it to sign; this app never holds the private bytes. Reuse a `CryptoKeyPair`
 * (e.g. one restored from IndexedDB) or let the constructor seam mint a fresh one via `WebCryptoKeyStore.create()`.
 */
export class WebCryptoKeyStore implements KeyStore {
  readonly #keyPair: CryptoKeyPair

  constructor(keyPair: CryptoKeyPair) {
    this.#keyPair = keyPair
  }

  /** Mint a fresh non-extractable device keypair. The private key cannot be exported after this point. */
  static async create(): Promise<WebCryptoKeyStore> {
    const keyPair = (await crypto.subtle.generateKey(ED25519, false, ['sign', 'verify'])) as CryptoKeyPair
    return new WebCryptoKeyStore(keyPair)
  }

  /** The device public key as an SPKI Ed25519 PEM — the only half that ever leaves the phone (at pairing). */
  async getPublicKeyPem(): Promise<string> {
    const der = await crypto.subtle.exportKey('spki', this.#keyPair.publicKey)
    return toPem(der, 'PUBLIC KEY')
  }

  /** Sign the given bytes inside WebCrypto with the private key, returning a base64 Ed25519 signature. */
  async sign(bytes: Uint8Array): Promise<string> {
    const sig = await crypto.subtle.sign(ED25519, this.#keyPair.privateKey, bytes as unknown as BufferSource)
    return toBase64(new Uint8Array(sig))
  }
}

/**
 * A `KeyStore` that mints its WebCryptoKeyStore only on first use (pairing or signing), so merely rendering the app
 * never generates a key. The same device key is reused for the life of the app session. Handy because an offline/demo
 * render must not depend on WebCrypto Ed25519 being available — only an actual pair or approve does.
 */
export class LazyKeyStore implements KeyStore {
  #inner: Promise<WebCryptoKeyStore> | undefined

  #get(): Promise<WebCryptoKeyStore> {
    this.#inner ??= WebCryptoKeyStore.create()
    return this.#inner
  }

  async getPublicKeyPem(): Promise<string> {
    return (await this.#get()).getPublicKeyPem()
  }

  async sign(bytes: Uint8Array): Promise<string> {
    return (await this.#get()).sign(bytes)
  }
}
