import { type FeedItem, GOAL_CATEGORIES, type Routine } from '@dool2/protocol'
import type { ConnectionItem } from '@dool2/protocol/connect'
import { scheduleLabel } from '@dool2/protocol/schedule'
import { describe, expect, it } from 'vitest'
import {
  continueText,
  dayLabel,
  GOAL_CATEGORY_LIST,
  GOAL_META,
  goalStarter,
  groupByDay,
  hostOf,
  libraryTab,
  personalIdeas,
  plain,
  routineWhen,
  sortRoutines,
  titleFrom,
  upcoming,
  whenLabel,
} from './life-model.js'

const now = new Date(2026, 10, 16, 9, 0) // 11월 16일 (월) 오전 9:00

const routine = (over: Partial<Routine>): Routine => ({
  id: 'r',
  title: '목표',
  prompt: '',
  enabled: true,
  createdAt: new Date(2026, 10, 1).toISOString(),
  ...over,
})

describe('life-model', () => {
  it('목표 분류는 protocol과 같다', () => {
    expect([...GOAL_CATEGORY_LIST]).toEqual([...GOAL_CATEGORIES])
    for (const c of GOAL_CATEGORIES) expect(GOAL_META[c].hint).toBeTruthy()
    expect(goalStarter('건강')).toBe('건강 목표를 세우고 싶어요: ')
  })

  it('시각을 오늘·내일·어제·날짜로 말한다', () => {
    expect(whenLabel(new Date(2026, 10, 16, 19, 30).toISOString(), now)).toBe('오늘 오후 7:30')
    expect(whenLabel(new Date(2026, 10, 17, 7, 5).toISOString(), now)).toBe('내일 오전 7:05')
    expect(whenLabel(new Date(2026, 10, 15, 12, 0).toISOString(), now)).toBe('어제 오후 12:00')
    expect(whenLabel(new Date(2026, 10, 20, 0, 0).toISOString(), now)).toBe('11월 20일 (금) 오전 12:00')
    expect(dayLabel(new Date(2026, 10, 16, 1).toISOString(), now)).toBe('오늘')
    expect(dayLabel(new Date(2026, 10, 14, 1).toISOString(), now)).toBe('11월 14일 (토)')
  })

  it('목표의 언제: 꺼 둠 · 정한 때 없음 · 일정과 다음 시각', () => {
    expect(routineWhen(routine({ enabled: false }), scheduleLabel, now)).toBe('꺼 둠')
    expect(routineWhen(routine({}), scheduleLabel, now)).toBe('정한 때 없음')
    expect(
      routineWhen(
        routine({
          schedule: { kind: 'weekly', time: '07:30', days: [1, 2, 3, 4, 5] },
          nextRunAt: new Date(2026, 10, 17, 7, 30).toISOString(),
        }),
        scheduleLabel,
        now,
      ),
    ).toBe('평일 오전 7:30 · 다음 내일 오전 7:30')
  })

  it('미리보기에 마크다운 기호가 남지 않는다', () => {
    expect(plain('## 오늘\n- **맑음** 14도\n1. `택배` [보기](https://a.b)')).toBe('오늘 맑음 14도 택배 보기')
    expect(plain('*별표* 하나')).toBe('별표 하나')
    expect(plain('가'.repeat(20), 10)).toHaveLength(10)
    expect(titleFrom('\n\n**무선 청소기** 최저가는\n- 첫째')).toBe('무선 청소기 최저가는')
    expect(continueText({ title: '**아침** 소식' })).toBe('"아침 소식" 이야기인데요, ')
  })

  it('켜 둔 것·다음 시각이 가까운 것부터, 예정은 켜 둔 것만', () => {
    const a = routine({ id: 'a', enabled: false })
    const b = routine({ id: 'b', nextRunAt: new Date(2026, 10, 18).toISOString() })
    const c = routine({ id: 'c', nextRunAt: new Date(2026, 10, 17).toISOString() })
    const d = routine({ id: 'd' })
    expect(sortRoutines([a, b, c, d]).map((r) => r.id)).toEqual(['c', 'b', 'd', 'a'])
    expect(upcoming([a, b, c, d]).map((r) => r.id)).toEqual(['c', 'b'])
  })

  it('피드를 날짜별로 묶는다 (새 것부터)', () => {
    const f = (id: string, d: Date): FeedItem => ({ id, kind: 'done', title: id, at: d.toISOString() })
    const groups = groupByDay(
      [
        f('어제1', new Date(2026, 10, 15, 8)),
        f('오늘', new Date(2026, 10, 16, 8)),
        f('어제2', new Date(2026, 10, 15, 20)),
      ],
      now,
    )
    expect(groups.map((g) => [g.day, g.items.map((i) => i.id)])).toEqual([
      ['오늘', ['오늘']],
      ['어제', ['어제2', '어제1']],
    ])
  })

  it('보관함은 만든 것 / 사진·파일로 나눈다', () => {
    const items = [
      { id: '1', kind: 'note' as const, title: '', body: '', savedAt: '2026-11-01' },
      { id: '2', kind: 'file' as const, title: '', body: '', savedAt: '2026-11-02' },
      { id: '3', kind: 'product' as const, title: '', body: '', savedAt: '2026-11-03' },
    ]
    expect(libraryTab(items, 'made').map((i) => i.id)).toEqual(['3', '1'])
    expect(libraryTab(items, 'files').map((i) => i.id)).toEqual(['2'])
    expect(hostOf('https://www.coupang.com/vp/1')).toBe('coupang.com')
    expect(hostOf('이상한 주소')).toBe('')
  })

  it('맞춤 아이디어: 제안 먼저, 연결한 서비스마다 돌아가며 찾아보기부터', () => {
    const svc = (id: string, name: string, at?: string): ConnectionItem =>
      ({
        card: {
          id,
          name,
          abilities: [
            { title: '다시 주문', say: `${name} 다시 주문`, tier: '돈 내기' },
            { title: '배송 조회', say: `${name} 배송 조회`, tier: '찾아보기' },
          ],
        },
        ...(at ? { connectedAt: at } : {}),
      }) as unknown as ConnectionItem
    const feed: FeedItem[] = [{ id: 's', kind: 'suggest', title: '**정기 결제** 정리', at: '2026-11-16' }]
    const ideas = personalIdeas(
      [svc('a', '가게', '2026-11-10'), svc('b', '메일', '2026-11-12'), svc('c', '안 씀')],
      feed,
    )
    expect(ideas.map((i) => i.text)).toEqual([
      '정기 결제 정리',
      '메일 배송 조회',
      '가게 배송 조회',
      '메일 다시 주문',
      '가게 다시 주문',
    ])
    expect(ideas[1]?.mark).toBe('메')
    expect(personalIdeas([], [])).toEqual([])
  })
})
