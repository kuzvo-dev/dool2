import { envelopeForAction, envelopeHash, verifyApproval } from '@dool2/approvals'
import { describe, expect, it } from 'vitest'
import { InMemoryKeyStore } from './keystore.js'
import { type DeviceRegistrar, pairDevice } from './pairing.js'
import { signCard } from './sign.js'

/** A minimal daemon that just stores the registered device public key, as the real daemon does at pairing. */
function fakeRegistrar(): DeviceRegistrar & { stored?: string } {
  const state: DeviceRegistrar & { stored?: string } = {
    registerDevice(publicKeyPem: string) {
      state.stored = publicKeyPem
    },
  }
  return state
}

describe('pairing registers the device pubkey; later signatures verify against it', () => {
  it('sends the public key (never the private key) and the daemon stores it', async () => {
    const keystore = new InMemoryKeyStore()
    const daemon = fakeRegistrar()

    const result = await pairDevice(daemon, keystore, { label: 'Test iPhone', deviceId: 'dev-1', now: 42 })

    expect(result.response.ok).toBe(true)
    expect(result.request.deviceId).toBe('dev-1')
    expect(result.request.label).toBe('Test iPhone')
    expect(result.request.pairedAt).toBe(42)
    // The request carries the public key, and it is what the daemon stored.
    expect(result.request.publicKeyPem).toBe(await keystore.getPublicKeyPem())
    expect(daemon.stored).toBe(result.request.publicKeyPem)
    // The request is a public message: no private key anywhere in it.
    expect(JSON.stringify(result.request)).not.toContain('PRIVATE')
  })

  it('a signature made after pairing verifies against the registered key', async () => {
    const keystore = new InMemoryKeyStore()
    const daemon = fakeRegistrar()
    await pairDevice(daemon, keystore)

    const envelope = envelopeForAction({
      tier: 'pay',
      label: 'Pay 12,000 won',
      amountKrw: 12_000,
      merchant: 'Baemin',
    })
    const signature = await signCard({ hash: envelopeHash(envelope), envelope }, keystore)

    // The daemon verifies against exactly the key pairing stored.
    expect(daemon.stored).toBeDefined()
    expect(verifyApproval(envelope, signature, daemon.stored as string)).toBe(true)
    // A different device's key does not verify this signature.
    const other = await new InMemoryKeyStore().getPublicKeyPem()
    expect(verifyApproval(envelope, signature, other)).toBe(false)
  })

  it('fails closed with a reason when the daemon rejects registration', async () => {
    const keystore = new InMemoryKeyStore()
    const daemon: DeviceRegistrar = {
      registerDevice() {
        throw new Error('daemon offline')
      },
    }
    const result = await pairDevice(daemon, keystore)
    expect(result.response.ok).toBe(false)
    expect(result.response.reason).toBe('daemon offline')
  })
})
