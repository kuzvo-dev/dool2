import { describe, expect, it } from 'vitest'
import { actDone, baseDomain, doneLine, groupSteps, type WorkGroup } from './work-steps.js'

const cards = [
  { id: 'naver-mail', name: '네이버 메일', site: 'mail.naver.com' },
  { id: 'cj-logistics', name: 'CJ대한통운', site: 'cjlogistics.com' },
  { id: 'cj', name: 'CJ', site: 'cj.net' },
  { id: 'catchtable', name: '캐치테이블', site: 'catchtable.co.kr' },
  { id: 'google-calendar', name: '구글 캘린더', site: 'calendar.google.com' },
]

describe('일하는 카드: 서비스별 줄', () => {
  it('같은 사이트에서 연달아 한 일은 한 줄, 도구 이름만 바뀐다', () => {
    const g = groupSteps(
      [
        { text: '가격부터 찾아볼게요', act: '웹페이지 여는 중', place: 'search.naver.com', ms: 4000 },
        { text: '페이지 읽는 중', act: '페이지 읽는 중', place: 'search.naver.com', ms: 2000 },
        {
          text: '실제 가격이 나온 페이지를 열어볼게요',
          act: '웹페이지 여는 중',
          place: 'www.sparkplus.co.kr',
          ms: 6000,
        },
        { text: '누르는 중', act: '누르는 중', place: 'www.sparkplus.co.kr', ms: 7000 },
        { text: '기억하는 중', act: '기억하는 중', ms: 1000 },
      ],
      cards,
    )
    expect(g.map((x) => [x.kind, x.title, x.act, x.ms, x.count])).toEqual([
      ['web', '네이버', '페이지 읽는 중', 6000, 2],
      ['web', 'sparkplus.co.kr', '누르는 중', 13000, 2],
      ['doori', '기억하는 중', '기억하는 중', 1000, 1],
    ])
    expect(doneLine(g[1] as WorkGroup)).toBe('웹페이지 열기 · 누르기')
  })

  it('연결 카드가 있는 사이트·서비스 도구는 카드 이름과 로고', () => {
    const g = groupSteps(
      [
        { text: '메일 열기', act: '웹페이지 여는 중', place: 'mail.naver.com' },
        { text: '조회', act: '조회하는 중', place: 'tool:cj_logistics_track' },
        { text: '찾기', act: '찾는 중', place: 'tool:catchtable_search' },
      ],
      cards,
    )
    expect(g.map((x) => [x.title, x.cardId, x.letter])).toEqual([
      ['네이버 메일', 'naver-mail', '네'],
      ['CJ대한통운', 'cj-logistics', 'C'],
      ['캐치테이블', 'catchtable', '캐'],
    ])
  })

  it('상위 도메인을 하위 사이트 카드로 보지 않는다 (구글 검색 ≠ 구글 캘린더)', () => {
    const g = groupSteps(
      [
        { text: '검색', act: '웹페이지 여는 중', place: 'www.google.com' },
        { text: '일정', act: '웹페이지 여는 중', place: 'calendar.google.com' },
      ],
      cards,
    )
    expect(g.map((x) => [x.title, x.cardId])).toEqual([
      ['구글', undefined],
      ['구글 캘린더', 'google-calendar'],
    ])
  })

  it('탭을 오가도 사이트마다 한 줄, 다시 간 곳은 맨 아래로', () => {
    const g = groupSteps([
      { text: 'a', act: '웹페이지 여는 중', place: 'www.sparkplus.co', ms: 1000 },
      { text: 'b', act: '웹페이지 여는 중', place: 'fastfive.co.kr', ms: 2000 },
      { text: 'c', act: '누르는 중', place: 'www.sparkplus.co', ms: 3000 },
      { text: 'd', act: '페이지 읽는 중', place: 'fastfive.co.kr', ms: 4000 },
      { text: 'e', act: '탭 닫는 중', place: 'fastfive.co.kr', ms: 500 },
    ])
    expect(g.map((x) => [x.title, x.ms, x.count])).toEqual([
      ['sparkplus.co', 4000, 2],
      ['fastfive.co.kr', 6500, 3],
    ])
    expect(doneLine(g[1] as WorkGroup)).toBe('웹페이지 열기 · 페이지 읽기')
  })

  it('예전 기록(act 없음)은 단계마다 한 줄', () => {
    const g = groupSteps([{ text: '웹페이지 여는 중' }, { text: '페이지 읽는 중' }])
    expect(g.map((x) => x.title)).toEqual(['웹페이지 여는 중', '페이지 읽는 중'])
  })

  it('도메인 묶기와 끝난 말', () => {
    expect(baseDomain('search.naver.com')).toBe('naver.com')
    expect(baseDomain('www.fastfive.co.kr')).toBe('fastfive.co.kr')
    expect(actDone('웹페이지 여는 중')).toBe('웹페이지 열기')
    expect(actDone('파일 만드는 중')).toBe('파일 만들기')
    expect(actDone('입력하는 중')).toBe('입력하기')
    expect(actDone('조회하는 중')).toBe('조회하기')
  })
})
