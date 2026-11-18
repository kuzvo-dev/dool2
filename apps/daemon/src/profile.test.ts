import { describe, expect, it } from 'vitest'
import { maskValue, normalize, ProfileStore, profileValue } from './profile.js'

function memory() {
  const m = new Map<string, string>()
  return {
    get: async (k: string) => m.get(k),
    set: async (k: string, v: string | undefined) => {
      if (v === undefined) m.delete(k)
      else m.set(k, v)
    },
    m,
  }
}

describe('내 정보', () => {
  it('넣은 값을 다듬어 저장하고, 틀린 칸은 알려 준다', async () => {
    const s = new ProfileStore(memory())
    const r = await s.update({
      name: ' 홍길동 ',
      name_en_last: 'hong',
      name_en_first: 'gil dong',
      phone: '01012345678',
      birth: '900131',
      email: 'not-email',
    })
    expect(r.saved).toEqual(['name', 'name_en_last', 'name_en_first', 'phone', 'birth'])
    expect(r.bad).toEqual(['email'])
    const p = await s.get()
    expect(p).toMatchObject({
      name: '홍길동',
      name_en_last: 'HONG',
      phone: '010-1234-5678',
      birth: '1990-01-31',
    })
  })

  it('칸 모양에 맞게 만든다 (사이트마다 받는 모양이 다르다)', () => {
    const p = { name_en_last: 'HONG', name_en_first: 'GILDONG', phone: '010-1234-5678', birth: '1990-01-31' }
    expect(profileValue(p, 'name_en_full')).toBe('HONG GILDONG')
    expect(profileValue(p, 'phone_digits')).toBe('01012345678')
    expect(profileValue(p, 'phone_local')).toBe('1012345678')
    expect(profileValue(p, 'birth_digits')).toBe('19900131')
    expect(profileValue(p, 'birth6')).toBe('900131')
    expect(profileValue(p, 'email')).toBeUndefined()
  })

  it('AI에게는 가린 값만 보인다', async () => {
    const s = new ProfileStore(memory())
    await s.update({
      name: '홍길동',
      email: 'hong.gd@example.com',
      phone: '010-1234-5678',
      birth: '1990-01-31',
    })
    const { have, missing } = await s.masked()
    expect(have).toEqual({
      name: '홍*동',
      email: 'ho*****@example.com',
      phone: '010-****-5678',
      birth: '1990-**-**',
    })
    expect(missing).toContain('name_en_last')
    expect(JSON.stringify(have)).not.toContain('1234')
    expect(maskValue('address', '서울 강남구 테헤란로 123')).toBe('서울 강남구 ***')
    expect(normalize('phone', '123')).toBeUndefined()
  })

  it('빈 값은 그 칸을 지운다', async () => {
    const mem = memory()
    const s = new ProfileStore(mem)
    await s.update({ name: '홍길동', zip: '06236' })
    await s.update({ zip: '' })
    expect(await s.get()).toEqual({ name: '홍길동' })
    await s.update({ name: '' })
    expect(mem.m.size).toBe(0)
  })
})
