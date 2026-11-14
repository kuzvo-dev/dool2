import { describe, expect, it } from 'vitest'
import {
  canonical,
  exportDevice,
  generateDevice,
  importDevice,
  linkKey,
  open,
  pairCode,
  SeqGuard,
  seal,
  signText,
  verifyText,
} from './e2e.js'

describe('폰 ↔ PC 암호화', () => {
  it('양쪽이 같은 키를 만들어 주고받고, 다른 기기는 열 수 없다', async () => {
    const pc = await generateDevice(true)
    const phone = await generateDevice(false)
    const stranger = await generateDevice(false)
    const kPhone = await linkKey(phone.boxPriv, pc.boxPub, [phone.id, pc.id])
    const kPc = await linkKey(pc.boxPriv, phone.boxPub, [pc.id, phone.id])
    const env = await seal(
      kPhone,
      { v: 1, from: phone.id, to: pc.id, kind: 'ask', seq: 1 },
      { text: '택배 조회해 줘' },
    )
    expect(env.ct).not.toContain('택배')
    expect(await open(kPc, env)).toEqual({ text: '택배 조회해 줘' })

    const kStranger = await linkKey(stranger.boxPriv, pc.boxPub, [stranger.id, pc.id])
    await expect(open(kStranger, env)).rejects.toThrow()
  })

  it('중계 서버가 머리(종류·순번·받는 이)를 바꾸면 열리지 않는다', async () => {
    const pc = await generateDevice(true)
    const phone = await generateDevice(false)
    const k = await linkKey(phone.boxPriv, pc.boxPub, [phone.id, pc.id])
    const env = await seal(k, { v: 1, from: phone.id, to: pc.id, kind: 'ask', seq: 7 }, { a: 1 })
    await expect(open(k, { ...env, kind: 'approve' })).rejects.toThrow()
    await expect(open(k, { ...env, seq: 8 })).rejects.toThrow()
  })

  it('페어링 확인 코드는 양쪽이 같고, 다른 기기와는 다르다', async () => {
    const pc = await generateDevice(true)
    const phone = await generateDevice(false)
    const other = await generateDevice(false)
    const a = await pairCode(phone.boxPriv, pc.boxPub)
    expect(a).toMatch(/^\d{6}$/)
    expect(await pairCode(pc.boxPriv, phone.boxPub)).toBe(a)
    expect(await pairCode(other.boxPriv, pc.boxPub)).not.toBe(a)
  })

  it('PC 키는 보관했다가 다시 불러올 수 있다', async () => {
    const pc = await generateDevice(true)
    const back = await importDevice(await exportDevice(pc))
    expect(back.id).toBe(pc.id)
    expect(back.boxPub).toBe(pc.boxPub)
    const phone = await generateDevice(false)
    const k1 = await linkKey(back.boxPriv, phone.boxPub, [back.id, phone.id])
    const k2 = await linkKey(phone.boxPriv, pc.boxPub, [phone.id, pc.id])
    expect(await open(k1, await seal(k2, { v: 1, from: phone.id, to: pc.id, kind: 'x', seq: 1 }, 'hi'))).toBe(
      'hi',
    )
  })

  it('승인 서명은 그 폰의 공개키로만 확인되고, 내용이 바뀌면 실패한다', async () => {
    const phone = await generateDevice(false)
    const other = await generateDevice(false)
    const text = canonical({
      id: 'a1',
      label: '결제하기',
      url: 'https://shop.example/pay',
      amount: '9,900원',
    })
    const sig = await signText(phone.signPriv, text)
    expect(await verifyText(phone.signPub, text, sig)).toBe(true)
    expect(await verifyText(other.signPub, text, sig)).toBe(false)
    expect(await verifyText(phone.signPub, text.replace('9,900', '99,000'), sig)).toBe(false)
  })

  it('같거나 작은 순번은 버린다', () => {
    const g = new SeqGuard()
    expect(g.accept('p', 1)).toBe(true)
    expect(g.accept('p', 1)).toBe(false)
    expect(g.accept('p', 3)).toBe(true)
    expect(g.accept('p', 2)).toBe(false)
    expect(g.accept('q', 1)).toBe(true)
  })

  it('canonical은 키 순서와 상관없이 같다', () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(canonical({ a: [2, { c: 4, d: 3 }], b: 1 }))
  })
})
