import { describe, expect, it } from 'vitest'
import { socialOrder, whenLabel } from './connections.js'

describe('서비스 연결 (폰)', () => {
  it('연결한 날을 오늘·어제·날짜로', () => {
    const now = new Date(2026, 10, 15, 9)
    expect(whenLabel(new Date(2026, 10, 15, 1).toISOString(), now)).toBe('오늘')
    expect(whenLabel(new Date(2026, 10, 14, 23).toISOString(), now)).toBe('어제')
    expect(whenLabel(new Date(2026, 10, 2).toISOString(), now)).toBe('11월 2일')
  })
})

describe('간편 로그인 순서', () => {
  const card = { id: 'shop', social: ['kakao', 'naver', 'google'] as ('kakao' | 'naver' | 'google')[] }
  const svc = (id: string, via?: string) => ({ card: { id } as never, ...(via ? { via } : {}) })

  it('처음이면 카드 순서 그대로, 표시 없음', () => {
    expect(socialOrder(card, [])).toEqual([
      { provider: 'kakao' },
      { provider: 'naver' },
      { provider: 'google' },
    ])
  })

  it('다른 서비스에 많이 쓴 공급자를 맨 위로', () => {
    const r = socialOrder(card, [
      svc('a', 'social:google'),
      svc('b', 'social:google'),
      svc('c', 'social:naver'),
      svc('d', 'vault'),
    ])
    expect(r.map((x) => x.provider)).toEqual(['google', 'naver', 'kakao'])
    expect(r[0]?.hint).toBe('2곳에서 사용')
    expect(r[1]?.hint).toBeUndefined()
  })

  it('이 서비스에 전에 쓴 것이 가장 먼저', () => {
    const r = socialOrder(card, [
      svc('a', 'social:google'),
      svc('b', 'social:google'),
      svc('shop', 'social:naver'),
    ])
    expect(r[0]).toEqual({ provider: 'naver', hint: '최근 사용' })
    expect(r[1]?.hint).toBeUndefined()
  })
})
