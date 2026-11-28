import {
  envelopeForAction,
  envelopeHash,
  generateDeviceKeyPair,
  signApproval,
  verifyApproval,
} from '@dool2/approvals'
import { describe, expect, it } from 'vitest'
import { InMemoryKeyStore } from './keystore.js'
import { signCard } from './sign.js'

describe('keystore sign -> @dool2/approvals verify', () => {
  it('a signature from the keystore verifies for the same envelope on the daemon side', async () => {
    const keystore = new InMemoryKeyStore()
    const pubkey = await keystore.getPublicKeyPem()
    const envelope = envelopeForAction({
      tier: 'pay',
      label: 'Pay 50,000 won',
      amountKrw: 50_000,
      merchant: 'Coupang',
    })
    const hash = envelopeHash(envelope)

    const signature = await signCard({ hash, envelope }, keystore)
    // The real verify path the daemon runs — not a stub.
    expect(verifyApproval(envelope, signature, pubkey)).toBe(true)
  })

  it('fails to verify for a modified envelope (the hash binds to the exact action)', async () => {
    const keystore = new InMemoryKeyStore()
    const pubkey = await keystore.getPublicKeyPem()
    const envelope = envelopeForAction({
      tier: 'pay',
      label: 'Pay 50,000 won',
      amountKrw: 50_000,
      merchant: 'Coupang',
    })
    const signature = await signCard({ hash: envelopeHash(envelope), envelope }, keystore)

    // Change the amount after signing: the daemon recomputes the hash, so the signature no longer verifies.
    const tampered = { ...envelope, amountKrw: 5_000_000 }
    expect(verifyApproval(tampered, signature, pubkey)).toBe(false)
  })

  it('produces the same Ed25519 signature as @dool2/approvals signApproval (the real path, deterministic)', async () => {
    const keypair = generateDeviceKeyPair()
    const keystore = new InMemoryKeyStore(keypair)
    const envelope = envelopeForAction({ tier: 'contact', label: 'Message Jisoo', recipient: 'Jisoo' })

    const viaKeystore = await signCard({ hash: envelopeHash(envelope), envelope }, keystore)
    const viaApprovals = signApproval(envelope, keypair.privateKeyPem)
    expect(viaKeystore).toBe(viaApprovals)
  })

  it('never exposes the private key — only a public key and a sign operation', async () => {
    const keystore = new InMemoryKeyStore()
    // The seam has exactly these two operations; there is no private-key getter.
    expect(typeof keystore.getPublicKeyPem).toBe('function')
    expect(typeof keystore.sign).toBe('function')
    expect((keystore as unknown as Record<string, unknown>).privateKeyPem).toBeUndefined()
    expect((keystore as unknown as Record<string, unknown>).getPrivateKeyPem).toBeUndefined()
  })
})
