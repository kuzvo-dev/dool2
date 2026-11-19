import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConnectCard } from './connect.js'
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
  it('아이디어 탭은 직접 고른 부탁만 (카드 할 일은 연결 화면에서)', () => {
    const groups = ideaCatalog(cards.map((card) => ({ card, connectedAt: '2026-11-19' })))
    const general = IDEA_SECTIONS.reduce((n, s) => n + s.asks.length, 0)
    expect(ideaCount(groups)).toBe(general)
    expect(general).toBeGreaterThan(100)
    expect(general).toBeLessThan(200)
    expect(groups.every((g) => g.items.every((i) => !i.service && !needsConnect(i)))).toBe(true)
  })

  it('분류 id와 일반 부탁이 겹치지 않는다', () => {
    const ids = IDEA_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const asks = IDEA_SECTIONS.flatMap((s) => s.asks.map((a) => a.text))
    expect(new Set(asks).size).toBe(asks.length)
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
    expect(searchIdeas(groups, '마일 리지').length).toBeGreaterThan(0)
    expect(searchIdeas(groups, '')).toEqual([])
  })
})
