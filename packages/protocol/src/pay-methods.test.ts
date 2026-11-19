import { describe, expect, it } from 'vitest'
import {
  cleanPayMethod,
  type PayMethod,
  payMethodLabel,
  payMethodMatches,
  pickPayMethod,
} from './pay-methods.js'

const NOW = '2026-11-19T00:00:00.000Z'
const m = (x: Partial<PayMethod> & Pick<PayMethod, 'kind'>): PayMethod => ({ id: x.kind, addedAt: NOW, ...x })

describe('내 결제 수단 검사', () => {
  it('간편결제는 종류와 그 안에서 쓰는 것, 카드는 카드사·별칭·끝 4자리만 받는다', () => {
    expect(cleanPayMethod({ kind: 'naverpay', inner: ' 신한카드(1234) ' }, 'a', NOW)).toEqual({
      id: 'a',
      kind: 'naverpay',
      inner: '신한카드(1234)',
      addedAt: NOW,
    })
    expect(
      cleanPayMethod(
        { kind: 'card', issuer: '현대카드', nickname: '생활비', last4: '5678', inner: 'x' },
        'b',
        NOW,
      ),
    ).toEqual({ id: 'b', kind: 'card', issuer: '현대카드', nickname: '생활비', last4: '5678', addedAt: NOW })
  })

  it('카드 번호처럼 숫자가 길면 어느 칸이든 받지 않는다', () => {
    expect(cleanPayMethod({ kind: 'card', issuer: '신한카드', last4: '1234 5678' }, 'a', NOW)).toContain(
      '카드 번호',
    )
    expect(
      cleanPayMethod({ kind: 'card', issuer: '신한카드', nickname: '5412-7500-1234-5678' }, 'a', NOW),
    ).toContain('카드 번호')
    expect(cleanPayMethod({ kind: 'kakaopay', inner: '카드 541275001234' }, 'a', NOW)).toContain('카드 번호')
    expect(cleanPayMethod({ kind: 'card', issuer: '신한카드', last4: '12a4' }, 'a', NOW)).toContain(
      '숫자 4개',
    )
  })

  it('모르는 종류·카드사 없는 카드는 받지 않는다', () => {
    expect(typeof cleanPayMethod({ kind: 'bitcoin' }, 'a', NOW)).toBe('string')
    expect(cleanPayMethod({ kind: 'card' }, 'a', NOW)).toBe('카드사를 골라 주세요')
    expect(typeof cleanPayMethod(null, 'a', NOW)).toBe('string')
  })

  it('한 줄 이름', () => {
    expect(payMethodLabel(m({ kind: 'naverpay', inner: '신한카드(1234)' }))).toBe(
      '네이버페이 · 신한카드(1234)',
    )
    expect(payMethodLabel(m({ kind: 'card', issuer: '현대카드', nickname: '생활비', last4: '5678' }))).toBe(
      '현대카드 · 생활비 · 끝 5678',
    )
    expect(payMethodLabel(m({ kind: 'tosspay' }))).toBe('토스페이')
  })
})

describe('결제 화면 칸과 맞추기', () => {
  // 실측 야놀자 결제 화면의 칸 이름 (승인 카드에 실리는 모양)
  const nol = ['NOL 머니 2% 포인트 적립', 'NOL 카드 페이', '카카오페이', '토스페이', '다른 결제 수단']

  it('간편결제는 이름으로, 카드는 일반 카드 칸으로 맞춘다', () => {
    expect(payMethodMatches(m({ kind: 'kakaopay' }), '카카오페이 혜택')).toBe(true)
    expect(payMethodMatches(m({ kind: 'naverpay' }), 'N pay')).toBe(true)
    expect(payMethodMatches(m({ kind: 'card', issuer: '신한카드' }), '신용/체크카드')).toBe(true)
    expect(payMethodMatches(m({ kind: 'card', issuer: '신한카드' }), '일반 결제')).toBe(true)
    expect(payMethodMatches(m({ kind: 'card', issuer: '신한카드' }), 'NOL 카드 페이')).toBe(false)
    expect(payMethodMatches(m({ kind: 'card', issuer: '신한카드' }), '카카오페이')).toBe(false)
  })

  it('맨 위(주 결제 수단)를 사이트가 안 받으면 다음 것을 고른다', () => {
    const mine = [m({ kind: 'naverpay' }), m({ kind: 'tosspay' }), m({ kind: 'kakaopay' })]
    expect(pickPayMethod(mine, nol)).toEqual({ option: 3, method: mine[1] })
    expect(pickPayMethod([m({ kind: 'naverpay' })], nol)).toBeUndefined()
    expect(pickPayMethod([], nol)).toBeUndefined()
    // 카드는 야놀자의 '다른 결제 수단' 안에 있다
    expect(pickPayMethod([m({ kind: 'card', issuer: '신한카드' })], nol)?.option).toBe(4)
  })
})
