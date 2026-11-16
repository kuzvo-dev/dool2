import { describe, expect, it } from 'vitest'
import { boldNames, ghostRest, hasBatchim, recentTalk, talkFollowUps } from './ghost.js'

const NOW = Date.parse('2026-11-16T12:00:00Z')
const REPLY =
  '판교 기념일 식당으로 두 곳 골라 봤어요.\n\n' +
  '1. **세렌** — 판교역 5분, 창가 자리가 예쁜 코스 요리집이에요. **12만 원**\n' +
  '2. **라비떼** — 조용한 이탈리안, 디너 코스가 있어요.\n\n' +
  '**참고:** 주말은 일찍 차요.'
const ASK = '판교에서 기념일 식당 찾아 줘'
const CATALOG = [
  '이번 달 아이랑 갈 만한 전시 찾아 줘',
  '토요일 저녁 7시에 2명 식당 자리 찾아 줘',
  '다음 주 미용실 예약 가능한 시간 알려 줘',
  '매일 아침 7시 반에 날씨랑 오늘 일정 알려 줘',
]
const MINE = ['예약한 전시 언제였지?', '세탁소 문 여는 시간 알려 줘']
const talk = { reply: REPLY, ask: ASK, at: NOW - 60_000 }

describe('이어 쓰기 제안', () => {
  it('식당 답 바로 뒤 "예약"이면 전시가 아니라 예약 이어 말', () => {
    const rest = ghostRest({ draft: '예약', talk, mine: MINE, catalog: CATALOG, now: NOW })
    expect(rest).toBe(' 가능한 시간 알아봐 줘')
    expect(`예약${rest}`).not.toContain('전시')
  })

  it('굵은 가게 이름을 치면 그 가게 예약', () => {
    expect(ghostRest({ draft: '세렌', talk, mine: MINE, catalog: CATALOG, now: NOW })).toBe(' 예약해 줘')
    expect(ghostRest({ draft: '라비', talk, catalog: CATALOG, now: NOW })).toBe('떼 예약해 줘')
  })

  it('조사는 받침에 맞게', () => {
    const lines = talkFollowUps(talk)
    expect(lines).toContain('세렌이 몇 시까지 하는지 알려 줘')
    expect(lines).toContain('라비떼가 몇 시까지 하는지 알려 줘')
    const shop = talkFollowUps({ reply: '최저가는 **무선 청소기 A1**, 그다음 **에어 블로워**예요.' })
    expect(shop).toContain('무선 청소기 A1을 장바구니에 담아 줘')
    expect(shop).toContain('에어 블로워를 장바구니에 담아 줘')
    expect(shop).toContain('제일 싼 곳으로 담아 줘')
    expect(hasBatchim('세렌')).toBe(true)
    expect(hasBatchim('라비떼')).toBe(false)
    expect(hasBatchim('3')).toBe(true)
    expect(hasBatchim('2')).toBe(false)
  })

  it('굵은 글씨 중 값·머리말·문장은 이름으로 보지 않는다', () => {
    expect(boldNames(REPLY)).toEqual(['세렌', '라비떼'])
    expect(boldNames('**지금 바로 예약할 수 있어요**')).toEqual([])
  })

  it('최근 대화와 하나도 겹치지 않는 아이디어는 숨긴다', () => {
    expect(ghostRest({ draft: '이번', talk, catalog: CATALOG, now: NOW })).toBe('')
    // 겹치면 보여 준다 (식당)
    expect(ghostRest({ draft: '토요일', talk, catalog: CATALOG, now: NOW })).toBe(
      ' 저녁 7시에 2명 식당 자리 찾아 줘',
    )
  })

  it('최근 대화가 없으면 예전처럼 내 아이디어 → 카탈로그', () => {
    const old = { reply: REPLY, ask: ASK, at: NOW - 3 * 3600_000 }
    expect(ghostRest({ draft: '예약', talk: old, mine: MINE, catalog: CATALOG, now: NOW })).toBe(
      '한 전시 언제였지?',
    )
    expect(ghostRest({ draft: '이번', mine: MINE, catalog: CATALOG, now: NOW })).toBe(
      ' 달 아이랑 갈 만한 전시 찾아 줘',
    )
  })

  it('두 글자 미만·여러 줄이면 없음', () => {
    expect(ghostRest({ draft: '세', talk, catalog: CATALOG, now: NOW })).toBe('')
    expect(ghostRest({ draft: '안녕\n세렌', talk, catalog: CATALOG, now: NOW })).toBe('')
  })

  it('대화에서 마지막 두리 답과 내 말을 고르고 앱 알림은 뺀다', () => {
    const t = recentTalk([
      { role: 'user', text: ASK, createdAt: '2026-11-16T11:58:00Z' },
      { role: 'assistant', text: REPLY, createdAt: '2026-11-16T11:59:00Z' },
      { role: 'user', text: '[두리 앱 알림] 승인했어요.', createdAt: '2026-11-16T11:59:30Z' },
    ])
    expect(t).toEqual({ reply: REPLY, ask: ASK, at: Date.parse('2026-11-16T11:59:00Z') })
  })
})
