import { describe, expect, it } from 'vitest'
import {
  approvalLine,
  type ConnectCard,
  ConnectCardSchema,
  checkConnectCard,
  localizeCard,
  needsPcChrome,
  TierSchema,
} from './connect.js'

const card: ConnectCard = {
  id: 'demo',
  name: '데모몰',
  site: 'demo.co.kr',
  category: 'shopping',
  how: 'browser',
  login: '아이디·비밀번호',
  summary: '데모몰을 연결하면 주문부터 배송 확인까지 두리에게 맡길 수 있어요.',
  example: { ask: '주문한 거 언제 와?', working: '배송 조회 중', reply: '내일 오전에 도착해요.' },
  abilities: [
    { title: '배송 조회', say: '주문한 거 언제 와?', tier: 'lookup' },
    { title: '주문', say: '늘 사던 걸로 시켜 줘', tier: 'pay' },
    { title: '판매자 문의', say: '언제 보내는지 물어봐 줘', tier: 'contact' },
  ],
}

describe('연결 카드', () => {
  it('형식을 지키면 문제가 없다', () => {
    expect(checkConnectCard('demo', card)).toEqual([])
  })

  it('폴더 이름, 빠진 도메인·로그인, 따옴표, 모르는 등급을 잡는다', () => {
    expect(checkConnectCard('other', card)[0]).toContain('folder name')
    const { site: _s, login: _l, ...rest } = card
    const problems = checkConnectCard('demo', rest)
    expect(problems.some((p) => p.startsWith('site'))).toBe(true)
    expect(problems.some((p) => p.startsWith('login'))).toBe(true)
    const quoted = { ...card, abilities: [{ ...card.abilities[0], say: '“언제 와?”' }, card.abilities[1]] }
    expect(checkConnectCard('demo', quoted).some((p) => p.includes('quotes'))).toBe(true)
    const tier = { ...card, abilities: [{ ...card.abilities[0], tier: '마음대로' }, card.abilities[1]] }
    expect(checkConnectCard('demo', tier)).not.toEqual([])
  })

  it('폰 권한은 도메인 없이도 된다', () => {
    const { site: _s, login: _l, ...rest } = card
    expect(checkConnectCard('demo', { ...rest, how: 'device', category: 'device' })).toEqual([])
  })

  it('승인 문장은 등급에서 만든다', () => {
    expect(approvalLine(card)).toBe('주문, 판매자 문의 같은 일은 폰에서 승인한 뒤에만 해요.')
    expect(
      approvalLine({ abilities: [card.abilities[0] as ConnectCard['abilities'][number]] }),
    ).toBeUndefined()
  })
})

describe('TierSchema (ADR 0029)', () => {
  it('accepts the English keys', () => {
    for (const t of ['lookup', 'fill', 'pay', 'contact']) expect(TierSchema.parse(t)).toBe(t)
  })
  it('maps the Korean values used before ADR 0029', () => {
    expect(TierSchema.parse('찾아보기')).toBe('lookup')
    expect(TierSchema.parse('채워 두기')).toBe('fill')
    expect(TierSchema.parse('돈 내기')).toBe('pay')
    expect(TierSchema.parse('연락하기')).toBe('contact')
  })
  it('rejects anything else', () => {
    expect(() => TierSchema.parse('buy')).toThrow()
  })
})

describe('localizeCard (ADR 0029)', () => {
  const base = ConnectCardSchema.parse({
    id: 'demo',
    name: '데모몰',
    site: 'demo.example.com',
    category: 'shopping',
    how: 'browser',
    login: '아이디·비밀번호',
    summary: '데모몰을 연결하면 주문부터 배송 조회까지 맡길 수 있어요.',
    example: { ask: '주문한 거 언제 와?', working: '배송 조회 중', reply: '내일 도착해요.' },
    abilities: [
      { title: '배송 조회', say: '언제 와?', tier: 'lookup' },
      { title: '주문', say: '시켜 줘', tier: 'pay' },
    ],
    regions: ['global'],
    i18n: {
      en: {
        name: 'Demo Mall',
        summary: 'Connect Demo Mall to leave orders and delivery tracking to Dool2.',
        abilities: [
          { title: 'Track delivery', say: 'When does it arrive?' },
          { title: 'Order', say: 'Order it' },
        ],
      },
    },
  })
  it('replaces translated fields and keeps tiers', () => {
    const en = localizeCard(base, 'en')
    expect(en.name).toBe('Demo Mall')
    expect(en.abilities.map((a) => [a.title, a.tier])).toEqual([
      ['Track delivery', 'lookup'],
      ['Order', 'pay'],
    ])
    expect(en.login).toBe('아이디·비밀번호')
  })
  it('returns Korean as is', () => {
    expect(localizeCard(base, 'ko')).toBe(base)
  })
  it('rejects translations with a different number of abilities', () => {
    const bad = { ...base, i18n: { en: { abilities: [{ title: 'Only one', say: 'one' }] } } }
    expect(ConnectCardSchema.safeParse(bad).success).toBe(false)
  })
})

describe('services that run in the PC Chrome', () => {
  it('everything but phone features needs Chrome on the PC', () => {
    expect(needsPcChrome({ how: 'browser' })).toBe(true)
    expect(needsPcChrome({ how: 'official' })).toBe(true)
    expect(needsPcChrome({ how: 'open' })).toBe(true)
    expect(needsPcChrome({ how: 'device' })).toBe(false)
  })
})
