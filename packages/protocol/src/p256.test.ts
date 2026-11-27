import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { derToRaw, verifyP256 } from './e2e.js'

describe('보안칩 서명 확인 (ADR 0043)', () => {
  const k = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const spki = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')

  it('Keystore 처럼 DER 로 만든 서명을 확인한다', async () => {
    for (let i = 0; i < 20; i++) {
      const text = `승인 ${i}`
      const sig = sign('sha256', Buffer.from(text), k.privateKey).toString('base64url')
      expect(await verifyP256(spki, text, sig)).toBe(true)
      expect(await verifyP256(spki, `${text}!`, sig)).toBe(false)
    }
  })

  it('다른 키·망가진 서명은 거절한다', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const sig = sign('sha256', Buffer.from('x'), other.privateKey).toString('base64url')
    expect(await verifyP256(spki, 'x', sig)).toBe(false)
    expect(await verifyP256(spki, 'x', 'AAAA')).toBe(false)
    expect(await verifyP256('bad', 'x', sig)).toBe(false)
    expect(derToRaw(new Uint8Array([0x30, 0x02, 0x05, 0x00]))).toBeUndefined()
  })
})
