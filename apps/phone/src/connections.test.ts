import { describe, expect, it } from 'vitest'
import { whenLabel } from './connections.js'

describe('서비스 연결 (폰)', () => {
  it('연결한 날을 오늘·어제·날짜로', () => {
    const now = new Date(2026, 10, 15, 9)
    expect(whenLabel(new Date(2026, 10, 15, 1).toISOString(), now)).toBe('오늘')
    expect(whenLabel(new Date(2026, 10, 14, 23).toISOString(), now)).toBe('어제')
    expect(whenLabel(new Date(2026, 10, 2).toISOString(), now)).toBe('11월 2일')
  })
})
