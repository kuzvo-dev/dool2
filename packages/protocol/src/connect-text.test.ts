import { describe, expect, it } from 'vitest'
import type { ConnectCard } from './connect.js'
import { matchesCard, safetyLines } from './connect-text.js'

const card: ConnectCard = {
  id: 'demo',
  name: '데모몰',
  site: 'demo.co.kr',
  category: 'shopping',
  how: 'browser',
  login: '카카오 간편 로그인',
  summary: '데모몰을 연결하면 주문까지 맡길 수 있어요.',
  example: { ask: '시켜 줘', working: '찾는 중', reply: '주문할까요?' },
  abilities: [
    { title: '배송 조회', say: '언제 와?', tier: 'lookup' },
    { title: '주문', say: '시켜 줘', tier: 'pay' },
  ],
}

describe('연결 화면 문구', () => {
  it('찾기는 이름·분류·할 수 있는 일로', () => {
    expect(matchesCard(card, '')).toBe(true)
    expect(matchesCard(card, '데모')).toBe(true)
    expect(matchesCard(card, '쇼핑')).toBe(true)
    expect(matchesCard(card, '배송')).toBe(true)
    expect(matchesCard(card, '항공')).toBe(false)
  })

  it('안전 안내는 연결 방식과 등급에서', () => {
    expect(safetyLines(card)[1]).toContain('카카오 간편 로그인')
    expect(safetyLines(card)[0]).toContain('금고')
    expect(safetyLines(card).at(-1)).toContain('폰에서 승인')
    expect(
      safetyLines({
        ...card,
        how: 'open',
        abilities: [card.abilities[0] as ConnectCard['abilities'][number]],
      }),
    ).toHaveLength(1)
  })
})
