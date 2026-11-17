import { describe, expect, it } from 'vitest'
import { Life, nextRun, parseSchedule, scheduleLabel, watchPrompt } from './life.js'

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

  it('하루 두 번(8:30, 18:30)이 지나면 한 번씩 살펴본다', () => {
    const t = setup(kst(8, 0))
    t.life.tick()
    expect(t.runs()).toBe(0)
    t.at(kst(8, 31))
    t.life.tick()
    expect(t.runs()).toBe(1)
    // 살펴보는 동안·끝난 뒤 같은 칸에서는 다시 하지 않는다
    t.life.tick()
    t.life.watchDone()
    t.at(kst(12, 0))
    t.life.tick()
    expect(t.runs()).toBe(1)
    t.at(kst(18, 45))
    t.life.tick()
    expect(t.runs()).toBe(2)
    t.life.watchDone()
    // 다음 날 아침
    t.at(kst(9, 10, 1))
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
})
