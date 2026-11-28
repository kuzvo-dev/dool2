import { describe, expect, it } from 'vitest'
import { ScryptAesGcmCrypto, type SealedSecret } from './crypto.js'

const crypto = new ScryptAesGcmCrypto()

describe('ScryptAesGcmCrypto — reference at-rest encryption', () => {
  it('round-trips seal → open with the right password', async () => {
    const box = await crypto.seal('super-secret-pw', 'master-password')
    expect(box.ct).not.toContain('super-secret-pw')
    const opened = await crypto.open(box, 'master-password')
    expect(opened).toBe('super-secret-pw')
  })

  it('fails to open with the wrong password (GCM auth)', async () => {
    const box = await crypto.seal('card-4111', 'master-password')
    await expect(crypto.open(box, 'wrong-password')).rejects.toThrow()
  })

  it('uses a fresh salt and IV per seal', async () => {
    const a = await crypto.seal('x', 'pw')
    const b = await crypto.seal('x', 'pw')
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('fails to open a tampered ciphertext', async () => {
    const box = await crypto.seal('x', 'pw')
    const flipped = Buffer.from(box.tag, 'base64')
    flipped.writeUInt8(flipped.readUInt8(0) ^ 0xff, 0)
    const tampered: SealedSecret = { ...box, tag: flipped.toString('base64') }
    await expect(crypto.open(tampered, 'pw')).rejects.toThrow()
  })

  it('derives a 32-byte key', async () => {
    const key = await crypto.deriveKey('pw', Buffer.from('salt'))
    expect(key).toHaveLength(32)
  })
})
