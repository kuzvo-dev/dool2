// The browser device key (WebCryptoKeyStore) must produce signatures the daemon accepts, and hash the envelope to the
// exact same bytes as the Node path (@dool2/approvals). These run in Node's WebCrypto (globalThis.crypto.subtle), which
// is the same API the phone WebView uses, so the test exercises the real browser signing path.

import type { ActionEnvelope } from '@dool2/approvals'
import { envelopeHash, verifyApproval } from '@dool2/approvals'
import { signingBytes } from '@dool2/phone'
import { describe, expect, it } from 'vitest'
import { signCardWeb } from './sign.js'
import { hashEnvelopeBytes, hashEnvelopeHex, WebCryptoKeyStore } from './webcrypto.js'

const envelope: ActionEnvelope = {
  tier: 'pay',
  label: 'Train ticket',
  amountKrw: 59_800,
  merchant: 'Train booking',
  nonce: 'n-42',
  createdAt: 0,
}

describe('WebCryptoKeyStore (the phone WebView device key)', () => {
  it('exports an SPKI public-key PEM and never the private key', async () => {
    const keystore = await WebCryptoKeyStore.create()
    const pem = await keystore.getPublicKeyPem()
    expect(pem).toContain('BEGIN PUBLIC KEY')
    expect(pem).not.toContain('PRIVATE')
  })

  it('hashes the envelope to the SAME bytes as @dool2/approvals (phone and daemon agree)', async () => {
    expect(await hashEnvelopeHex(envelope)).toBe(envelopeHash(envelope))
    const mine = await hashEnvelopeBytes(envelope)
    expect(Buffer.from(mine).equals(signingBytes(envelope))).toBe(true)
  })

  it('produces a signature the daemon verifies (verifyApproval) — the key stays in WebCrypto', async () => {
    const keystore = await WebCryptoKeyStore.create()
    const pem = await keystore.getPublicKeyPem()
    const signature = await signCardWeb({ hash: envelopeHash(envelope), envelope }, keystore)
    expect(verifyApproval(envelope, signature, pem)).toBe(true)
    // A different action's signature must not verify for this envelope.
    const other: ActionEnvelope = { ...envelope, amountKrw: 1 }
    const otherSig = await signCardWeb({ hash: envelopeHash(other), envelope: other }, keystore)
    expect(verifyApproval(envelope, otherSig, pem)).toBe(false)
  })
})
