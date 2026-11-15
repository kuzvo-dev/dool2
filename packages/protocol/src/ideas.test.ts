import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConnectCard, ConnectionItem } from './connect.js'
import {
  IDEA_SECTIONS,
  ideaCatalog,
  ideaCount,
  needsConnect,
  searchIdeas,
  serviceAsk,
  serviceMark,
} from './ideas.js'

const skillsDir = join(import.meta.dirname, '../../../skills')
const cards: ConnectCard[] = readdirSync(skillsDir)
  .filter((d) => !d.startsWith('_') && !d.includes('.'))
  .flatMap((d) => {
    try {
      return [JSON.parse(readFileSync(join(skillsDir, d, 'connect.json'), 'utf8')) as ConnectCard]
    } catch {
      return []
    }
  })

describe('아이디어 모음', () => {
  it('모든 연결 카드가 어느 분류엔가 들어간다', () => {
    const items: ConnectionItem[] = cards.map((card) => ({ card }))
    const groups = ideaCatalog(items)
    const placed = new Set(groups.flatMap((g) => g.items.map((i) => i.service?.id).filter(Boolean)))
    expect(cards.length).toBeGreaterThan(50)
    for (const c of cards) expect(placed.has(c.id), c.id).toBe(true)
    const general = IDEA_SECTIONS.reduce((n, s) => n + s.asks.length, 0)
    const abilities = cards.reduce((n, c) => n + c.abilities.length, 0)
    expect(ideaCount(groups)).toBe(general + abilities)
  })

  it('분류 id와 일반 부탁이 겹치지 않는다', () => {
    const ids = IDEA_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const asks = IDEA_SECTIONS.flatMap((s) => s.asks.map((a) => a.text))
    expect(new Set(asks).size).toBe(asks.length)
  })

  it('연결한 곳 → 일반 부탁 → 연결 안 한 곳 순서', () => {
    const coupang = cards.find((c) => c.id === 'coupang') as ConnectCard
    const gmarket = cards.find((c) => c.id === 'gmarket') as ConnectCard
    const groups = ideaCatalog([{ card: gmarket }, { card: coupang, connectedAt: '2026-11-16' }])
    const shop = groups.find((g) => g.section.id === 'shopping')
    expect(shop?.items[0]?.service?.id).toBe('coupang')
    expect(shop?.items.at(-1)?.service?.id).toBe('gmarket')
    expect(needsConnect(shop?.items[0] as never)).toBe(false)
    expect(needsConnect(shop?.items.at(-1) as never)).toBe(true)
  })

  it('보낼 말에 서비스 이름을 붙인다', () => {
    expect(serviceAsk({ name: '쿠팡', how: 'browser' }, '오늘 오는 거 뭐 있어?')).toBe(
      '쿠팡에서 오늘 오는 거 뭐 있어?',
    )
    expect(serviceAsk({ name: '야놀자(NOL)', how: 'browser' }, '방 찾아 줘')).toBe('야놀자에서 방 찾아 줘')
    expect(serviceAsk({ name: '쿠팡', how: 'browser' }, '쿠팡 장바구니 보여 줘')).toBe(
      '쿠팡 장바구니 보여 줘',
    )
    expect(serviceAsk({ name: '연락처', how: 'device' }, '엄마 번호 알려 줘')).toBe('엄마 번호 알려 줘')
    expect(serviceMark('11번가')).toBe('11')
    expect(serviceMark('쿠팡')).toBe('쿠')
  })

  it('띄어쓰기 없이도 찾는다', () => {
    const groups = ideaCatalog(cards.map((card) => ({ card })))
    expect(searchIdeas(groups, '항공 권').length).toBeGreaterThan(0)
    expect(searchIdeas(groups, '')).toEqual([])
  })
})
