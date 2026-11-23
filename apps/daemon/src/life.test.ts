import type { Routine } from '@dool2/protocol'
import { describe, expect, it } from 'vitest'
import {
  Life,
  nextRun,
  parseSchedule,
  readRun,
  routineAsk,
  ruleLabel,
  scheduleLabel,
  tellDelay,
  watchPrompt,
} from './life.js'

function kv() {
  const m = new Map<string, unknown>()
  return { getSetting: (k: string) => m.get(k), setSetting: (k: string, v: unknown) => void m.set(k, v) }
}
// 2026-11-16 월요일 08:00 (한국) = 2026-11-15T23:00Z
const MON_8AM = new Date('2026-11-15T23:00:00Z')

describe('언제', () => {
  it('매일·요일·한 번·간격', () => {
    expect(nextRun({ kind: 'daily', time: '07:30' }, MON_8AM)?.toISOString()).toBe('2026-11-16T22:30:00.000Z')
    expect(nextRun({ kind: 'daily', time: '09:00' }, MON_8AM)?.toISOString()).toBe('2026-11-16T00:00:00.000Z')
    // 수요일(3) 09:00
    expect(nextRun({ kind: 'weekly', time: '09:00', days: [3] }, MON_8AM)?.toISOString()).toBe(
      '2026-11-18T00:00:00.000Z',
    )
    expect(nextRun({ kind: 'once', at: '2026-11-15T00:00:00Z' }, MON_8AM)).toBeUndefined()
    expect(nextRun({ kind: 'every', minutes: 60 }, MON_8AM)?.toISOString()).toBe('2026-11-16T00:00:00.000Z')
  })
  it('사람이 읽는 말', () => {
    expect(scheduleLabel({ kind: 'daily', time: '07:30' })).toBe('매일 오전 7:30')
    expect(scheduleLabel({ kind: 'weekly', time: '18:00', days: [1, 2, 3, 4, 5] })).toBe('평일 오후 6:00')
    expect(scheduleLabel({ kind: 'every', minutes: 180 })).toBe('3시간마다')
  })
  it('AI가 준 값 정리', () => {
    expect(parseSchedule({ schedule: 'daily', time: '7:05' })).toEqual({ kind: 'daily', time: '07:05' })
    expect(parseSchedule({ schedule: 'weekly', time: '09:00', days: [1, 1, 9] })).toEqual({
      kind: 'weekly',
      time: '09:00',
      days: [1],
    })
    expect(parseSchedule({ schedule: 'every', minutes: 5 })).toBeUndefined()
  })
})

describe('Life', () => {
  it('정해진 때가 되면 꺼내고 다음 시각을 정한다', () => {
    let now = MON_8AM
    const life = new Life(kv(), () => now)
    const due: string[] = []
    life.onDue = (r) => due.push(r.title)
    life.run('goal_create', { title: '아침 브리핑', prompt: '날씨', schedule: 'daily', time: '08:30' })
    expect(life.tick()).toHaveLength(0)
    now = new Date('2026-11-15T23:31:00Z')
    life.tick()
    expect(due).toEqual(['아침 브리핑'])
    expect(life.routines()[0]?.nextRunAt).toBe('2026-11-16T23:30:00.000Z')
    // 한 번짜리는 하고 나면 꺼진다
    life.run('goal_create', {
      title: '치과',
      prompt: '알려 줘',
      schedule: 'once',
      at: '2026-11-16T09:00:00+09:00',
    })
    now = new Date('2026-11-16T00:01:00Z')
    life.tick()
    expect(life.routines().find((r) => r.title === '치과')?.enabled).toBe(false)
  })

  it('목표: 분류·계획·진행 기록', () => {
    const life = new Life(kv(), () => MON_8AM)
    life.run('goal_create', {
      title: '주 3회 운동',
      prompt: '운동했는지 물어봐',
      category: '건강',
      plan: ['헬스장 찾기', '등록'],
    })
    const g = life.routines()[0]
    expect(g?.category).toBe('건강')
    expect(g?.schedule).toBeUndefined()
    life.run('goal_update', { id: g?.id.slice(0, 8), done: [0], log: '집 앞 헬스장 찾음' })
    expect(life.routines()[0]?.plan?.[0]?.done).toBe(true)
    expect(life.routines()[0]?.log?.[0]?.text).toBe('집 앞 헬스장 찾음')
  })

  it('보관함·기억·피드·피드 지시', () => {
    const life = new Life(kv(), () => MON_8AM)
    life.run('library_save', { kind: 'product', title: '제주 귤 3kg', body: '무료 배송', price: '15,900원' })
    expect(life.library()[0]).toMatchObject({ kind: 'product', price: '15,900원' })
    life.run('memory_save', { text: '출퇴근은 동탄역 SRT' })
    life.run('memory_save', { text: '출퇴근은 동탄역 SRT' })
    expect(life.memory()).toHaveLength(1)
    expect(life.memoryPrompt()).toContain('동탄역')
    life.run('memory_forget', { text: '동탄' })
    expect(life.memory()).toHaveLength(0)
    life.act({ action: 'feed-prompt', text: '매일 아침 날씨와 택배' })
    expect(life.routines().find((r) => r.target === 'feed')?.schedule).toEqual({
      kind: 'daily',
      time: '07:30',
    })
    expect(life.state().feedPrompt).toBe('매일 아침 날씨와 택배')
    const f = life.feed({ kind: 'post', title: '오늘 날씨' })
    life.act({ action: 'feed-react', id: f.id, reaction: 'up' })
    expect(life.feedItems()[0]?.reaction).toBe('up')
  })
})

describe('보관함 꺼내 보기 (library_find)', () => {
  const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n')
  function filled() {
    let now = MON_8AM
    const life = new Life(kv(), () => now)
    const save = (a: Record<string, unknown>) => {
      life.run('library_save', a)
      now = new Date(now.getTime() + 3600_000)
    }
    save({
      kind: 'place',
      title: '성수 카페 어니언',
      body: '성동구 아차산로9길 8 · 빵이 맛있음',
      url: 'https://map.kakao.com/1',
    })
    save({
      kind: 'product',
      title: '제주 귤 3kg',
      body: '무료 배송',
      price: '15,900원',
      url: 'https://www.coupang.com/vp/1',
    })
    save({ kind: 'note', title: '부산 여행 일정', body: '1일차 해운대\n2일차 광안리' })
    save({ kind: 'place', title: '서울숲 산책길', body: '성수역 4번 출구에서 걸어서 10분' })
    return life
  }

  it('제목·메모에서 찾고, 많이 맞은 것·최근 것부터', () => {
    const life = filled()
    const r = life.run('library_find', { query: '성수' })
    const t = text(r)
    expect(r.isError).toBeUndefined()
    expect(t).toContain("보관함에서 '성수' 2개를 찾았어요")
    // 둘 다 한 낱말씩 맞으면 최근 저장한 서울숲이 먼저
    expect(t.indexOf('서울숲 산책길')).toBeLessThan(t.indexOf('성수 카페 어니언'))
    expect(t).toContain('[장소] 성수 카페 어니언 · 2026-11-16 저장')
    expect(t).toContain('링크: https://map.kakao.com/1')
    expect(t).toContain('메모: 성동구 아차산로9길 8')
    expect(t).toContain('show_list')
    expect(t).not.toContain('제주 귤')
    // 두 낱말 다 맞은 것이 먼저
    const t2 = text(life.run('library_find', { query: '성수 카페' }))
    expect(t2.indexOf('성수 카페 어니언')).toBeLessThan(t2.indexOf('서울숲 산책길'))
  })

  it('비우면 최근 것, 종류만 골라 보기, 몇 개까지', () => {
    const life = filled()
    const all = text(life.run('library_find', {}))
    expect(all).toContain('최근 것 4개를 찾았어요')
    expect(all.indexOf('서울숲')).toBeLessThan(all.indexOf('부산 여행'))
    const products = text(life.run('library_find', { kind: 'product' }))
    expect(products).toContain('[상품] 제주 귤 3kg')
    expect(products).toContain('가격: 15,900원')
    expect(products).not.toContain('[장소]')
    const one = text(life.run('library_find', { limit: 1 }))
    expect(one).toContain('(맞는 것 4개 중 1개)')
    expect(one).not.toContain('부산 여행')
  })

  it('못 찾으면 이유와 저장된 것 목록, 비었으면 다른 길', () => {
    const life = filled()
    const r = life.run('library_find', { query: '강릉' })
    const t = text(r)
    expect(r.isError).toBeUndefined()
    expect(t).toContain(
      "보관함에 '강릉'으로 저장된 게 없어요. 저장된 것 4개, 최근: 서울숲 산책길 (장소 · 2026-11-16)",
    )
    expect(t).toContain('conversation_search')
    expect(text(life.run('library_find', { query: '부산', kind: 'place' }))).toContain(
      "보관함의 장소 중에 '부산'으로 저장된 게 없어요",
    )
    const none = new Life(kv(), () => MON_8AM)
    expect(text(none.run('library_find', { query: '성수' }))).toContain('보관함이 비어 있어요')
  })
})

describe('피드 글', () => {
  it('답 첫 줄이 제목이 된다', () => {
    const life = new Life(kv(), () => MON_8AM)
    life.act({ action: 'feed-prompt', text: '날씨' })
    const r = life.routines().find((x) => x.target === 'feed')
    life.noteRun(r?.id ?? '', '**11/16 서울 날씨**\n- 맑아요\n- 최고 17°')
    expect(life.feedItems()[0]).toMatchObject({
      kind: 'post',
      title: '11/16 서울 날씨',
      body: '- 맑아요\n- 최고 17°',
    })
  })
})

describe('먼저 챙기기', () => {
  // 한국 시간을 UTC로 (hh:mm, 2026-11-16 월요일 기준 + 일)
  const kst = (h: number, m = 0, day = 0) => new Date(Date.UTC(2026, 10, 16 + day, h - 9, m))
  const setup = (start: Date, sources = ['coupang']) => {
    let now = start
    const life = new Life(kv(), () => now)
    life.watchSources = () => sources
    let runs = 0
    life.onWatch = () => {
      runs++
    }
    return {
      life,
      runs: () => runs,
      at: (d: Date) => {
        now = d
      },
    }
  }

  it('아침 6시부터 밤 10시까지 매시 정각이 지나면 한 번씩 살펴본다', () => {
    const t = setup(kst(5, 50))
    t.life.tick()
    expect(t.runs()).toBe(0)
    t.at(kst(6, 1))
    t.life.tick()
    expect(t.runs()).toBe(1)
    // 살펴보는 동안·끝난 뒤 같은 시간 안에서는 다시 하지 않는다
    t.life.tick()
    t.life.watchDone()
    t.at(kst(6, 59))
    t.life.tick()
    expect(t.runs()).toBe(1)
    t.at(kst(7, 2))
    t.life.tick()
    expect(t.runs()).toBe(2)
    t.life.watchDone()
    // 밤 10시대까지는 하고, 11시부터는 쉰다
    t.at(kst(22, 5))
    t.life.tick()
    expect(t.runs()).toBe(3)
    t.life.watchDone()
    t.at(kst(23, 5))
    t.life.tick()
    expect(t.runs()).toBe(3)
  })

  it('밤에는 하지 않고, 연결한 서비스가 없거나 끄면 하지 않는다', () => {
    const night = setup(kst(23, 0))
    night.life.tick()
    expect(night.runs()).toBe(0)
    const none = setup(kst(9, 0), [])
    none.life.tick()
    none.life.act({ action: 'watch-now' })
    expect(none.runs()).toBe(0)
    const off = setup(kst(9, 0))
    off.life.act({ action: 'watch', on: false })
    off.life.tick()
    expect(off.runs()).toBe(0)
    expect(off.life.state().watch).toEqual({ on: false })
    off.life.act({ action: 'watch-now' })
    expect(off.runs()).toBe(1)
    expect(off.life.state().watch?.busy).toBe(true)
  })

  it('먼저 챙긴 일: 피드에 올리고 알리며, 같은 일은 다시 올리지 않고 한 번에 3개까지', () => {
    const t = setup(kst(9, 0))
    const told: string[] = []
    t.life.onTell = (f) => told.push(f.title)
    t.life.watchNow()
    const first = t.life.run('feed_tell', {
      title: '어제 주문한 러닝화, 내일 오전에 도착해요',
      from: '쿠팡 주문 내역을 보고',
      key: 'Coupang-123-도착',
    })
    expect(first.isError).toBeUndefined()
    expect(t.life.feedItems()[0]).toMatchObject({
      kind: 'suggest',
      from: '쿠팡 주문 내역을 보고',
      key: 'coupang-123-도착',
    })
    expect(
      t.life.run('feed_tell', { title: '러닝화가 내일 와요', key: 'coupang-123-도착' }).content[0]?.text,
    ).toContain('이미 알린')
    t.life.run('feed_tell', {
      title: '토요일이 엄마 생신이에요',
      key: 'memory-엄마생신-2026',
      ask: '엄마 생신 선물 3만 원대로 골라 줘',
      ask_label: '골라 줘',
    })
    expect(t.life.feedItems()[0]).toMatchObject({
      ask: '엄마 생신 선물 3만 원대로 골라 줘',
      askLabel: '골라 줘',
    })
    t.life.run('feed_tell', { title: '내일 9시 치과 예약', key: 'cal-치과' })
    expect(t.life.run('feed_tell', { title: '네 번째', key: 'x' }).isError).toBe(true)
    expect(told).toHaveLength(3)
    expect(t.life.recentTells().map((f) => f.key)).toEqual([
      'cal-치과',
      'memory-엄마생신-2026',
      'coupang-123-도착',
    ])
  })

  it('제안에 답하면 고른 것만 남고, 다시 답할 수 없다', () => {
    const t = setup(kst(9, 0))
    t.life.tell({ title: '엄마 생신', key: 'm', ask: '선물 골라 줘' })
    t.life.tell({ title: '택배 도착', key: 'p' })
    const [gift, parcel] = [t.life.feedItems()[1], t.life.feedItems()[0]]
    t.life.act({ action: 'feed-answer', id: gift?.id ?? '', answer: 'yes' })
    t.life.act({ action: 'feed-answer', id: gift?.id ?? '', answer: 'no' })
    t.life.act({ action: 'feed-answer', id: parcel?.id ?? '', answer: 'yes' })
    expect(t.life.feedItems().map((f) => f.answered)).toEqual([undefined, 'yes'])
  })

  it('살펴보기 부탁: 연결한 서비스와 이미 알린 것을 담는다', () => {
    const card = {
      id: 'coupang',
      name: '쿠팡',
      abilities: [
        { title: '배송 조회', say: '', tier: '찾아보기' },
        { title: '장바구니 담기', say: '', tier: '채워 두기' },
      ],
    }
    const text = watchPrompt(
      [{ card, connectedAt: '2026-11-16T00:00:00Z' } as never],
      [{ id: '1', kind: 'suggest', title: '러닝화 내일 도착', key: 'coupang-123', at: '' }],
      kst(8, 30),
    )
    expect(text).toContain('11월 16일 월요일 8시')
    expect(text).toContain('- 쿠팡(coupang): 배송 조회')
    expect(text).not.toContain('장바구니')
    expect(text).toContain('- 러닝화 내일 도착 [coupang-123]')
    expect(text).toContain('feed_tell')
  })

  it('챙길 때가 된 한 일이 있으면 연결한 서비스가 없어도 살펴보고, 부탁 맨 앞에 담는다', () => {
    const t = setup(kst(9, 0), [])
    t.life.run('know_save', {
      kind: 'done',
      title: '레뷰 센티크 체험단 신청',
      value: '신청함',
      source: '레뷰',
      next: '2026-11-16T09:00:00+09:00',
      next_what: '당첨 발표 확인',
    })
    t.life.tick()
    expect(t.runs()).toBe(1)
    const text = watchPrompt([], [], kst(9, 0), t.life.knowDue(), kst(8, 0).toISOString())
    expect(text).toContain('챙길 때가 된 일')
    expect(text).toContain('레뷰 센티크 체험단 신청: 신청함 (레뷰')
    expect(text).toContain('당첨 발표 확인')
    expect(text).toContain('지난번에 살핀 때: 60분 전')
    expect(text).toContain('know_update')
  })
})

describe('두리가 알아 둔 것 (조회 기억·한 일 장부)', () => {
  it('같은 이름은 새 값으로 바꾸고, 날짜·기준 시점과 함께 지침에 붙는다 (쓸지는 AI가 판단)', () => {
    let now = new Date('2026-11-20T03:00:00Z')
    const life = new Life(kv(), () => now)
    life.run('know_save', {
      kind: 'fact',
      title: '2025년 귀속 총급여',
      value: '약 7,700만 원',
      source: '홈택스',
      basis: '2025년 귀속',
    })
    life.run('know_save', {
      kind: 'fact',
      title: '2025년 귀속 총급여',
      value: '약 7,750만 원',
      source: '홈택스',
      basis: '2025년 귀속',
    })
    expect(life.know()).toHaveLength(1)
    expect(life.know()[0]?.value).toBe('약 7,750만 원')
    now = new Date('2027-03-02T03:00:00Z')
    const prompt = life.knowPrompt()
    expect(prompt).toContain('오늘 2027-03-02')
    expect(prompt).toContain('2025년 귀속 총급여: 약 7,750만 원 (홈택스 · 2025년 귀속 · 본 날 2026-11-20')
    expect(prompt).toContain('네가 판단')
    const found = life.run('know_find', { query: '총급여' }).content[0]?.text ?? ''
    expect(found).toContain('약 7,750만 원')
    expect(life.run('know_find', { query: '보험' }).content[0]?.text).toContain('알아 둔 것이 없어요')
  })

  it('한 일은 취소·완료되면 지우지 않고 끝남으로, 끝나면 더 챙기지 않는다', () => {
    const now = new Date('2026-11-20T03:00:00Z')
    const life = new Life(kv(), () => now)
    life.run('know_save', {
      kind: 'done',
      title: '제주 숙소 예약',
      value: '12/12~14 2박',
      source: '여기어때',
      next: '2026-11-20',
      next_what: '무료취소 마감 알리기',
    })
    expect(life.knowDue()).toHaveLength(1)
    const id = life.know()[0]?.id ?? ''
    life.run('know_update', { id: id.slice(0, 8), state: 'done', value: '예약 취소함' })
    expect(life.know()[0]).toMatchObject({ state: 'done', value: '예약 취소함' })
    expect(life.know()[0]?.next).toBeUndefined()
    expect(life.knowDue()).toHaveLength(0)
    expect(life.knowPrompt()).not.toContain('진행 중인 일')
    life.act({ action: 'know-delete', id })
    expect(life.know()).toHaveLength(0)
  })
})

describe('매달 (말일·월말 넘김)', () => {
  const at = (iso: string) => new Date(iso)
  it('매달 1일: 이번 달 1일이 지났으면 다음 달 1일', () => {
    // 11/16 08:00 → 12/1 09:00 (한국) = 12/1 00:00Z
    expect(nextRun({ kind: 'monthly', time: '09:00', day: 1 }, MON_8AM)?.toISOString()).toBe(
      '2026-12-01T00:00:00.000Z',
    )
    // 11/16 08:00, 16일 09:00은 아직 → 오늘
    expect(nextRun({ kind: 'monthly', time: '09:00', day: 16 }, MON_8AM)?.toISOString()).toBe(
      '2026-11-16T00:00:00.000Z',
    )
  })
  it('31일은 그 날이 없는 달엔 말일 (2월 28일, 윤년 29일, 4월 30일)', () => {
    const last = { kind: 'monthly' as const, time: '09:00', day: 31 }
    // 1/31 10:00 한국 → 2/28 09:00
    expect(nextRun(last, at('2026-01-31T01:00:00Z'))?.toISOString()).toBe('2026-02-28T00:00:00.000Z')
    // 2/28 10:00 → 3/31
    expect(nextRun(last, at('2026-02-28T01:00:00Z'))?.toISOString()).toBe('2026-03-31T00:00:00.000Z')
    // 윤년 2028년 2월은 29일
    expect(nextRun(last, at('2028-02-01T00:00:00Z'))?.toISOString()).toBe('2028-02-29T00:00:00.000Z')
    expect(nextRun(last, at('2026-04-01T00:00:00Z'))?.toISOString()).toBe('2026-04-30T00:00:00.000Z')
    // 30일도 2월엔 말일
    expect(
      nextRun({ kind: 'monthly', time: '09:00', day: 30 }, at('2026-01-31T00:00:00Z'))?.toISOString(),
    ).toBe('2026-02-28T00:00:00.000Z')
  })
  it('해를 넘긴다 (12월 → 1월)', () => {
    // 12/15 10:00 한국 → 다음 해 1/10 09:00
    expect(
      nextRun({ kind: 'monthly', time: '09:00', day: 10 }, at('2026-12-15T01:00:00Z'))?.toISOString(),
    ).toBe('2027-01-10T00:00:00.000Z')
  })
  it('한국 시간 자정 무렵: UTC로는 전날이어도 한국 날짜로 센다', () => {
    // 한국 12/1 00:30 = 11/30 15:30Z → 그날 07:00
    expect(
      nextRun({ kind: 'monthly', time: '07:00', day: 1 }, at('2026-11-30T15:30:00Z'))?.toISOString(),
    ).toBe('2026-11-30T22:00:00.000Z')
  })
  it('사람이 읽는 말과 AI 값 정리', () => {
    expect(scheduleLabel({ kind: 'monthly', time: '09:00', day: 1 })).toBe('매달 1일 오전 9:00')
    expect(scheduleLabel({ kind: 'monthly', time: '21:00', day: 31 })).toBe('매달 말일 오후 9:00')
    expect(scheduleLabel({ kind: 'monthly', time: '09:00', day: 30 })).toBe(
      '매달 30일(없는 달은 말일) 오전 9:00',
    )
    expect(scheduleLabel({ kind: 'weekly', time: '07:00', days: [5, 1, 3] })).toBe('월·수·금 오전 7:00')
    expect(parseSchedule({ schedule: 'monthly', time: '9:00', day: 1 })).toEqual({
      kind: 'monthly',
      time: '09:00',
      day: 1,
    })
    expect(parseSchedule({ schedule: 'monthly', time: '09:00', day: 32 })).toBeUndefined()
    expect(parseSchedule({ schedule: 'monthly', time: '09:00' })).toBeUndefined()
  })
})

describe('끝나는 때·조건에 맞을 때만 알리기', () => {
  it('매달 1일 알림: 정한 것을 한 줄로 돌려주고 매일 돌지 않는다', () => {
    const life = new Life(kv(), () => MON_8AM)
    const r = life.run('goal_create', {
      title: '초코 심장사상충 약',
      prompt: '초코 심장사상충 약 먹일 날이라고 알려 줘',
      schedule: 'monthly',
      day: 1,
      time: '09:00',
    })
    const text = r.content[0]?.text ?? ''
    expect(text).toContain('정한 것: 매달 1일 오전 9:00에 해요 · 끝나는 때 없음(지울 때까지) · 매번 알려요')
    expect(text).toContain('처음은 12월 1일(화) 오전 9:00')
    expect(life.routines()[0]?.nextRunAt).toBe('2026-12-01T00:00:00.000Z')
  })
  it('빠뜨리기 쉬운 것을 결과에 담는다: 지켜보기인데 끝이 없음 · 조건이 있는데 매번 알림', () => {
    const life = new Life(kv(), () => MON_8AM)
    const watch = life.run('goal_create', {
      title: '취소표',
      prompt: 'KTX 11/30 부산행 취소표 나오면 알려 줘',
      schedule: 'every',
      minutes: 30,
      notify: 'when_found',
    }).content[0]?.text
    expect(watch).toContain('끝나는 때가 없어요')
    expect(watch).toContain('until')
    const shop = life.run('goal_create', {
      title: '쇼핑 경고',
      prompt: '이번 달 쇼핑 합계가 30만 원 넘으면 알려 줘',
      schedule: 'daily',
      time: '20:00',
    }).content[0]?.text
    expect(shop).toContain('notify: "when_found"')
  })
  it('지난 끝나는 날·한 번도 못 도는 끝나는 날은 만들지 않는다', () => {
    const life = new Life(kv(), () => MON_8AM)
    const past = { title: 'x', prompt: 'x', schedule: 'daily', time: '09:00' }
    expect(life.run('goal_create', { ...past, until: '2026-11-15' }).isError).toBe(true)
    expect(
      life.run('goal_create', { ...past, schedule: 'monthly', day: 1, until: '2026-11-30' }).isError,
    ).toBe(true)
    expect(life.run('goal_create', { ...past, notify: 'sometimes' }).isError).toBe(true)
    expect(life.routines()).toHaveLength(0)
  })
  it('until 날짜: 그날까지 하고 스스로 꺼진다', () => {
    let now = MON_8AM
    const life = new Life(kv(), () => now)
    const due: string[] = []
    life.onDue = (r) => due.push(r.title)
    const text = life.run('goal_create', {
      title: '쇼핑 경고',
      prompt: '30만 원 넘었으면 알려 줘',
      schedule: 'daily',
      time: '20:00',
      notify: 'when_found',
      until: '2026-11-17',
    }).content[0]?.text
    expect(text).toContain(
      '11월 17일까지 하고 스스로 꺼져요 · 조건에 맞을 때만 알리고 아니면 조용히 넘어가요',
    )
    expect(text).not.toContain('끝나는 때가 없어요')
    // 11/16 20:00 한국
    now = new Date('2026-11-16T11:01:00Z')
    life.tick()
    expect(life.routines()[0]?.nextRunAt).toBe('2026-11-17T11:00:00.000Z')
    // 11/17 20:00: 마지막 차례. 하고 나면 꺼진다
    now = new Date('2026-11-17T11:01:00Z')
    life.tick()
    expect(due).toEqual(['쇼핑 경고', '쇼핑 경고'])
    const r = life.routines()[0]
    expect(r?.enabled).toBe(false)
    expect(r?.endedAt).toBeTruthy()
    expect(r?.nextRunAt).toBeUndefined()
    // 다시 켜면 지난 끝나는 날은 지운다
    life.act({ action: 'routine-toggle', id: r?.id ?? '', on: true })
    expect(life.routines()[0]?.until).toBeUndefined()
    expect(life.routines()[0]?.endedAt).toBeUndefined()
  })
  it('PC가 꺼져 있다 끝나는 날이 지나서 켜지면 하지 않고 끈다', () => {
    let now = MON_8AM
    const life = new Life(kv(), () => now)
    const due: string[] = []
    life.onDue = (r) => due.push(r.title)
    life.run('goal_create', {
      title: 'a',
      prompt: 'a',
      schedule: 'daily',
      time: '09:00',
      until: '2026-11-16',
    })
    now = new Date('2026-11-20T00:00:00Z')
    life.tick()
    expect(due).toEqual([])
    expect(life.routines()[0]?.enabled).toBe(false)
  })
  it('when_found: "알릴 것 없음"이면 피드에 올리지 않고, 맞으면 올린다', () => {
    const life = new Life(kv(), () => MON_8AM)
    life.run('goal_create', {
      title: '쇼핑 경고',
      prompt: '30만 원 넘었으면 알려 줘',
      schedule: 'daily',
      time: '20:00',
      notify: 'when_found',
      until: '2026-11-30',
    })
    const id = life.routines()[0]?.id ?? ''
    const before = life.feedItems().length
    expect(life.noteRun(id, '**알릴 것 없음**')?.quiet).toBe(true)
    expect(life.noteRun(id, '알릴 것 없음 — 지금 12만 원이에요.')?.quiet).toBe(true)
    expect(life.feedItems()).toHaveLength(before)
    expect(life.routines()[0]?.lastResult).toContain('12만 원')
    const hit = life.noteRun(id, '이번 달 쇼핑이 31만 2천 원이에요. 30만 원을 넘었어요.')
    expect(hit?.quiet).toBe(false)
    expect(hit?.item?.body).toContain('31만')
    expect(life.feedItems()).toHaveLength(before + 1)
  })
  it('매번 알리는 일은 "알릴 것 없음"이어도 그대로 올린다', () => {
    const life = new Life(kv(), () => MON_8AM)
    life.run('goal_create', { title: '브리핑', prompt: '날씨', schedule: 'daily', time: '07:00' })
    const id = life.routines()[0]?.id ?? ''
    expect(life.noteRun(id, '알릴 것 없음')?.quiet).toBe(false)
  })
  it('until 조건: 답 끝에 [끝]이 오면 꺼지고 표시는 지운다', () => {
    const life = new Life(kv(), () => MON_8AM)
    life.run('goal_create', {
      title: '공지',
      prompt: '수강신청 공지 떴는지 봐 줘',
      schedule: 'daily',
      time: '10:00',
      notify: 'when_found',
      until: '공지가 떠서 알리면',
    })
    const r = life.routines()[0]
    expect(routineAsk(r as Routine)).toContain('알릴 것 없음')
    expect(routineAsk(r as Routine)).toContain('[끝]')
    const run = life.noteRun(r?.id ?? '', '수강신청 공지가 떴어요: 12/2 10시부터. [끝]')
    expect(run).toMatchObject({ quiet: false, ended: true })
    expect(life.routines()[0]?.enabled).toBe(false)
    expect(life.routines()[0]?.lastResult).not.toContain('[끝]')
    expect(readRun({}, '[끝]').ended).toBe(false)
  })
  it('지켜보기는 지난번에 알린 것을 넘겨 같은 소식을 또 알리지 않는다 (조용한 차례는 덮지 않음)', () => {
    const life = new Life(kv(), () => MON_8AM)
    life.run('goal_create', {
      title: '동네',
      prompt: '망원동 새 소식',
      schedule: 'daily',
      time: '08:00',
      notify: 'when_found',
    })
    const id = life.routines()[0]?.id ?? ''
    expect(routineAsk(life.routines()[0] as Routine)).not.toContain('지난번에 이미 알린 것')
    life.noteRun(id, '- 망원시장 축제 (뉴스)')
    life.noteRun(id, '알릴 것 없음')
    const r = life.routines()[0] as Routine
    expect(r.lastResult).toBe('알릴 것 없음')
    expect(routineAsk(r)).toContain('지난번에 이미 알린 것')
    expect(routineAsk(r)).toContain('망원시장 축제')
  })
  it('goal_create preview면 지금 한 번 해 보여 달라고 돌려준다', () => {
    const life = new Life(kv(), () => MON_8AM)
    const text = (x: unknown) => JSON.stringify(x)
    expect(
      text(
        life.run('goal_create', {
          title: 'a',
          prompt: '뉴스',
          schedule: 'daily',
          time: '07:30',
          preview: true,
        }),
      ),
    ).toContain('미리 보기')
    expect(
      text(life.run('goal_create', { title: 'b', prompt: '약', schedule: 'daily', time: '21:00' })),
    ).not.toContain('미리 보기')
  })
  it('goal_update로 끝나는 때·알리기·언제를 채운다', () => {
    const life = new Life(kv(), () => MON_8AM)
    life.run('goal_create', { title: '취소표', prompt: '취소표 나오면', schedule: 'every', minutes: 30 })
    const id = life.routines()[0]?.id.slice(0, 8) ?? ''
    const text = life.run('goal_update', { id, notify: 'when_found', until: '2026-11-30' }).content[0]?.text
    expect(text).toContain('정한 것: 30분마다 해요 · 11월 30일까지 하고 스스로 꺼져요 · 조건에 맞을 때만')
    expect(life.routines()[0]?.notify).toBe('when_found')
    life.run('goal_update', {
      id,
      until: '',
      notify: 'always',
      schedule: 'weekly',
      time: '09:00',
      days: [1, 3],
    })
    const r = life.routines()[0]
    expect(r?.until).toBeUndefined()
    expect(r?.notify).toBeUndefined()
    expect(r?.schedule).toEqual({ kind: 'weekly', time: '09:00', days: [1, 3] })
    expect(life.run('goal_list', {}).content[0]?.text).toContain('월·수 오전 9:00')
  })
  it('시각만 주면 매일·요일은 그대로 두고 시각만 바꾼다, 바꿀 게 없으면 고쳤다고 하지 않는다', () => {
    const life = new Life(kv(), () => MON_8AM)
    life.run('goal_create', { title: '뉴스', prompt: '뉴스 요약', schedule: 'daily', time: '07:30' })
    const id = life.routines()[0]?.id.slice(0, 8) ?? ''
    const t = life.run('goal_update', { id, time: '07:00' }).content[0]?.text
    expect(life.routines()[0]?.schedule).toEqual({ kind: 'daily', time: '07:00' })
    expect(t).toContain('매일 오전 7:00')
    const r = life.run('goal_update', { id })
    expect(r.isError).toBe(true)
  })
  it('밤새 해 두고 아침에 알림: tell_at을 남기고 폰 알림만 그 시각까지 미룬다', () => {
    const life = new Life(kv(), () => MON_8AM)
    const t = life.run('goal_create', {
      title: '밤새 처리',
      prompt: '숙소 비교, 메일 정리',
      schedule: 'once',
      at: '2026-11-18T03:00:00+09:00',
      tell_at: '7:00',
    }).content[0]?.text
    expect(life.routines()[0]?.tellAt).toBe('07:00')
    expect(t).toContain('폰 알림은 오전 7:00까지 미뤄요')
    expect(
      life.run('goal_create', { title: 'x', prompt: 'y', schedule: 'daily', time: '09:00', tell_at: '7시' })
        .isError,
    ).toBe(true)
    const id = life.routines()[0]?.id ?? ''
    life.run('goal_update', { id, tell_at: '' })
    expect(life.routines()[0]?.tellAt).toBeUndefined()
    // 새벽에 해 두고 "아침에" 알려 달라는 일은 말하지 않아도 7시로, 깨워 달라는 알림은 그대로
    life.run('goal_create', {
      title: '밤새 정리',
      prompt: '메일 정리해서 아침에 알려 줘',
      schedule: 'once',
      at: '2026-11-18T03:00:00+09:00',
    })
    expect(life.routines()[0]?.tellAt).toBe('07:00')
    life.run('goal_create', {
      title: '비행기',
      prompt: '공항 갈 시간이라고 깨워 줘',
      schedule: 'once',
      at: '2026-11-18T04:30:00+09:00',
    })
    expect(life.routines()[0]?.tellAt).toBeUndefined()
    // 새벽 3시(한국) 끝 → 7시까지 4시간, 아침 8시에 끝나면 바로
    expect(tellDelay('07:00', new Date('2026-11-20T18:00:00Z'))).toBe(4 * 3600_000)
    expect(tellDelay('07:00', new Date('2026-11-20T23:00:00Z'))).toBe(0)
    expect(tellDelay(undefined, new Date())).toBe(0)
  })
  it('화면에 보이는 끝나는 때 한 줄', () => {
    expect(ruleLabel({ until: '2026-12-31', notify: 'when_found' })).toBe('12월 31일까지 · 맞을 때만 알림')
    expect(ruleLabel({ until: '교체했다고 하면' })).toBe('끝: 교체했다고 하면')
    expect(ruleLabel({})).toBe('')
  })
})

describe('긴 목록 나눠 받기 (피드·보관함)', () => {
  const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n')
  /** 피드 n개를 1시간 간격으로 (마지막 것이 가장 최근) */
  function withFeed(n: number, start = MON_8AM) {
    let now = start
    const life = new Life(kv(), () => now)
    for (let i = 0; i < n; i++) {
      life.feed({ kind: i % 3 ? 'done' : 'post', title: `일 ${i}`, body: i % 2 ? '택배 도착' : '날씨 맑음' })
      now = new Date(now.getTime() + 3600_000)
    }
    return { life, setNow: (d: Date) => (now = d), now: () => now }
  }

  it('첫 화면은 피드 30개와 다음 커서, 커서를 따라가면 빠짐없이 끝까지 (끝이면 다음 없음)', () => {
    const { life } = withFeed(75)
    const s = life.state()
    expect(s.feed).toHaveLength(30)
    expect(s.feed[0]?.title).toBe('일 74')
    expect(s.feedNext).toBeTruthy()
    const p2 = life.feedPage({ before: s.feedNext })
    const p3 = life.feedPage({ before: p2.next })
    expect(p3.items).toHaveLength(15)
    expect(p3.next).toBeUndefined()
    const ids = [...s.feed, ...p2.items, ...p3.items].map((f) => f.id)
    expect(new Set(ids).size).toBe(75)
    // 빈 피드
    const empty = new Life(kv(), () => MON_8AM)
    expect(empty.state().feed).toEqual([])
    expect(empty.state().feedNext).toBeUndefined()
    expect(empty.feedPage()).toEqual({ items: [] })
  })

  it('같은 시각에 여러 개 생겨도 페이지 경계에서 겹치거나 빠지지 않는다', () => {
    const life = new Life(kv(), () => MON_8AM)
    for (let i = 0; i < 45; i++) life.feed({ kind: 'done', title: `같은 시각 ${i}` })
    const seen = new Set<string>()
    let before: string | undefined
    for (let i = 0; i < 10; i++) {
      const p = life.feedPage({ limit: 7, ...(before ? { before } : {}) })
      for (const f of p.items) seen.add(f.id)
      if (!p.next) break
      before = p.next
    }
    expect(seen.size).toBe(45)
  })

  it('종류만 골라 받기 (활동: 끝낸 일·예약한 일)', () => {
    const { life } = withFeed(40)
    const p = life.feedPage({ kinds: ['done', 'routine'], limit: 100 })
    expect(p.items.every((f) => f.kind === 'done')).toBe(true)
    expect(p.items).toHaveLength(26)
  })

  it('피드는 개수가 아니라 90일로 남긴다 (예전 300개 한도 없이)', () => {
    const { life, setNow, now } = withFeed(400, new Date(MON_8AM.getTime() - 200 * 86_400_000))
    // 400시간 ≈ 17일 동안 쌓인 400개: 모두 남는다
    expect(life.feedItems()).toHaveLength(400)
    // 90일 넘게 지나 새 소식이 오면 오래된 건 지운다
    setNow(new Date(now().getTime() + 91 * 86_400_000))
    life.feed({ kind: 'done', title: '새 일' })
    expect(life.feedItems().map((f) => f.title)).toEqual(['새 일'])
  })

  it('이번 주 두리가 한 일: 60일 날마다 개수 (먼저 챙긴 일은 세지 않는다)', () => {
    const life = new Life(kv(), () => MON_8AM)
    life.feed({ kind: 'done', title: '오늘 한 일' })
    life.feed({ kind: 'suggest', title: '먼저 챙김' })
    const days = life.state().feedDays ?? []
    expect(days).toHaveLength(60)
    expect(days.at(-1)).toBe(1)
    expect(days.slice(0, -1).every((n) => n === 0)).toBe(true)
  })

  it('보관함은 칸마다 첫 30개·개수·다음 커서, 긴 글은 앞부분만 보내고 하나 받기로 전체', () => {
    let now = MON_8AM
    const life = new Life(kv(), () => now)
    for (let i = 0; i < 35; i++) {
      life.save({ kind: 'note', title: `정리 ${i}`, body: i === 34 ? '가'.repeat(1000) : '짧은 글' })
      now = new Date(now.getTime() + 60_000)
    }
    life.save({ kind: 'file', title: '사진', body: '' })
    const s = life.state()
    expect(s.libraryCount).toEqual({ made: 35, files: 1 })
    expect(s.library.filter((x) => x.kind === 'note')).toHaveLength(30)
    expect(s.library.filter((x) => x.kind === 'file')).toHaveLength(1)
    expect(s.libraryNext?.made).toBeTruthy()
    expect(s.libraryNext?.files).toBeUndefined()
    const long = s.library.find((x) => x.title === '정리 34')
    expect(long?.cut).toBe(true)
    expect(long?.body).toHaveLength(400)
    expect(life.libraryItem(long?.id ?? '')?.body).toHaveLength(1000)
    const rest = life.libraryPage({ tab: 'made', before: s.libraryNext?.made })
    expect(rest.items.map((x) => x.title)).toEqual(['정리 4', '정리 3', '정리 2', '정리 1', '정리 0'])
    expect(rest.next).toBeUndefined()
  })

  it('보관함 목록에 작은 미리보기를 싣되 큰 그림은 빼고, 합쳐 250KB까지만', () => {
    let now = MON_8AM
    const life = new Life(kv(), () => now)
    for (let i = 0; i < 30; i++) {
      const it = life.save({ kind: 'file', title: `그림 ${i}`, body: '', image: 'I'.repeat(1000) })
      life.setThumb(it.id, 'T'.repeat(10_000))
      now = new Date(now.getTime() + 60_000)
    }
    const page = life.libraryPage({ tab: 'files' })
    expect(page.items.every((x) => x.image === undefined)).toBe(true)
    // 10KB × 25 = 250KB까지
    expect(page.items.filter((x) => x.thumb).length).toBe(25)
    expect(life.libraryItem(page.items[29]?.id ?? '')?.thumb).toHaveLength(10_000)
  })

  it('같은 PC 파일을 다시 만들면 예전 칸은 빼고 새 것만, 예전에 쌓인 것은 켤 때 하나로', () => {
    const store = kv()
    const life = new Life(store, () => MON_8AM)
    life.save({ kind: 'file', title: '영상.mp4', body: '1판', path: '~/Documents/두리/영상.mp4' })
    life.save({ kind: 'note', title: '메모', body: '글' })
    life.save({ kind: 'file', title: '영상.mp4', body: '2판', path: '~/Documents/두리/영상.mp4' })
    expect(life.library().map((x) => x.body)).toEqual(['2판', '글'])
    // 예전 판이 쌓아 둔 것 (고쳐 쓸 때마다 칸이 늘었다)
    const dup = (body: string) => ({
      id: body,
      kind: 'file',
      title: '그림.png',
      body,
      path: '~/Documents/두리/그림.png',
      savedAt: MON_8AM.toISOString(),
    })
    store.setSetting('library', [
      dup('새'),
      { ...dup('따로'), path: '~/Desktop/a.png' },
      dup('옛'),
      dup('더 옛'),
    ])
    const again = new Life(store, () => MON_8AM)
    expect(again.tidyLibrary()).toBe(2)
    expect(again.library().map((x) => x.body)).toEqual(['새', '따로'])
  })

  it('목표 진행 기록은 최근 것만 보낸다 (저장은 그대로)', () => {
    const life = new Life(kv(), () => MON_8AM)
    life.run('goal_create', { title: '걷기', prompt: '걸었는지', category: '건강' })
    const id = life.routines()[0]?.id ?? ''
    for (let i = 0; i < 30; i++) life.updateGoal(id, { log: `기록 ${i}` })
    expect(life.routines()[0]?.log).toHaveLength(30)
    expect(life.state().routines[0]?.log).toHaveLength(20)
    expect(life.state({ logs: 8 }).routines[0]?.log?.[0]?.text).toBe('기록 29')
    expect(life.state({ logs: 8 }).routines[0]?.log).toHaveLength(8)
  })

  it('feed_find: 기간·종류·낱말로 보고, 종류별 개수와 이어 보기 커서를 준다', () => {
    const { life, now } = withFeed(50)
    const all = text(life.run('feed_find', { days: 90, limit: 5 }))
    expect(all).toContain('맞는 것 50개')
    expect(all).toContain('끝낸 일 33')
    expect(all).toContain('[끝낸 일]')
    const cursor = /before: "([^"]+)"/.exec(all)?.[1] ?? ''
    expect(cursor).toBeTruthy()
    const next = text(life.run('feed_find', { days: 90, limit: 5, before: cursor }))
    expect(next).toContain('이어서 5개')
    expect(next).not.toContain(`일 49 `)
    // 낱말·종류
    const parcel = text(life.run('feed_find', { query: '택배', kinds: ['post'] }))
    expect(parcel).toContain('[소식]')
    expect(parcel).not.toContain('[끝낸 일]')
    // 이번 주(최근 1일)만
    expect(text(life.run('feed_find', { days: 1 }))).toContain('최근 1일')
    // 없으면 다음 길
    expect(text(life.run('feed_find', { query: '없는낱말' }))).toContain('맞는 게 없어요')
    expect(text(new Life(kv(), now).run('feed_find', {}))).toContain('피드가 비어 있어요')
    // 마지막 페이지 다음은 여기까지
    const last = text(life.run('feed_find', { limit: 30, before: life.feedPage({ limit: 49 }).next }))
    expect(last).toContain('여기까지예요')
  })

  it('library_find: skip으로 이어 보기', () => {
    let now = MON_8AM
    const life = new Life(kv(), () => now)
    for (let i = 0; i < 12; i++) {
      life.save({ kind: 'note', title: `메모 ${i}`, body: '' })
      now = new Date(now.getTime() + 60_000)
    }
    const first = text(life.run('library_find', { limit: 5 }))
    expect(first).toContain('이어서 보려면 같은 낱말로 skip: 5')
    const second = text(life.run('library_find', { limit: 5, skip: 10 }))
    expect(second).toContain('11~12번째')
    expect(second).toContain('11. [정리] 메모 1')
    expect(second).not.toContain('skip:')
    expect(text(life.run('library_find', { skip: 50 }))).toContain('여기까지예요')
  })
})
