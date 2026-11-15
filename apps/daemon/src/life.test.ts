import { describe, expect, it } from 'vitest'
import { Life, nextRun, parseSchedule, scheduleLabel } from './life.js'

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
