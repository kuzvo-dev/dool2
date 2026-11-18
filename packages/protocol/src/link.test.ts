import { describe, expect, it } from 'vitest'
import { approvalSignText } from './link.js'

describe('승인 서명 글', () => {
  const a = {
    id: 'x',
    label: '네이버페이로 예약하기',
    url: 'https://kr.hotels.com/checkout/s',
    what: '슈피리어 더블룸 3박',
    amount: '₩519,720',
    expiresAt: '2026-11-18T12:00:00.000Z',
  }

  it('고르는 것이 없으면 예전 폰과 같은 글이다 (옛 폰 서명이 그대로 통한다)', () => {
    expect(approvalSignText(a, 'approve')).toBe(approvalSignText(a, 'approve', undefined))
    expect(approvalSignText(a, 'approve')).not.toContain('choice')
  })

  it('고른 결제 수단이 서명 글에 묶인다 (다른 수단으로 바꾸면 서명이 맞지 않는다)', () => {
    const c1 = approvalSignText(a, 'approve', 'c1')
    const c2 = approvalSignText(a, 'approve', 'c2')
    expect(c1).toContain(`["choice","c1"]`)
    expect(c1).not.toBe(c2)
  })
})
