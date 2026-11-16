import { describe, expect, it } from 'vitest'
import { InfoRequests } from './info-requests.js'

describe('InfoRequests', () => {
  it('폰의 답을 기다렸다가 돌려준다', async () => {
    const q = new InfoRequests()
    const seen: string[] = []
    q.onCreate = (r) => {
      seen.push(r.label)
      setTimeout(() => q.answer(r.id, ' 123456 '), 5)
    }
    const v = await q.ask({ site: '쿠팡', host: 'login.coupang.com', field: 'otp', label: '인증번호' })
    expect(v).toBe('123456')
    expect(seen).toEqual(['인증번호'])
    expect(q.pending()).toEqual([])
  })

  it('취소·시간 초과면 undefined', async () => {
    const q = new InfoRequests(Date.now, 20)
    q.onCreate = (r) => setTimeout(() => q.answer(r.id, ''), 5)
    expect(await q.ask({ site: 'a', host: 'a', field: 'text', label: 'x' })).toBeUndefined()
    const q2 = new InfoRequests(Date.now, 20)
    expect(await q2.ask({ site: 'a', host: 'a', field: 'tel', label: 'x' })).toBeUndefined()
  })
})
