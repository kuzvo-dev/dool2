import { describe, expect, it } from 'vitest'
import { CLOSE_AFTER_MS, MAX_TABS, RECENT_MS, SLEEP_AFTER_MS, tidyPlan } from './tidy.js'

const now = 10_000_000
const min = 60_000

describe('두리 탭 정리', () => {
  it('최근에 쓴 탭 몇 개는 그대로 둔다', () => {
    const tabs = [1, 2, 3].map((id) => ({ id, usedAt: now - id * min }))
    expect(tidyPlan(tabs, now)).toEqual({ close: [], sleep: [] })
  })

  it('한동안 안 쓴 탭은 잠재우고, 아주 오래 안 쓴 탭은 닫는다', () => {
    const plan = tidyPlan(
      [
        { id: 1, usedAt: now - SLEEP_AFTER_MS },
        { id: 2, usedAt: now - CLOSE_AFTER_MS },
        { id: 3, usedAt: now },
      ],
      now,
    )
    expect(plan).toEqual({ close: [2], sleep: [1] })
  })

  it('너무 많으면 가장 오래 안 쓴 것부터 닫아 개수를 맞춘다', () => {
    const tabs = Array.from({ length: MAX_TABS + 3 }, (_, i) => ({ id: i + 1, usedAt: now - i * min }))
    const plan = tidyPlan(tabs, now)
    expect(plan.close.sort()).toEqual([MAX_TABS + 1, MAX_TABS + 2, MAX_TABS + 3])
  })

  it('방금(1분 안) 연 탭은 너무 많아도 닫지 않는다 — 로그인 버튼이 연 카카오 창 (실측)', () => {
    // 사람을 기다리느라 남겨 둔 탭 3개 + 사이트 탭(방금 연 것) + 카카오 창(방금 넘겨받은 것)
    const tabs = [
      { id: 1, usedAt: now - 5 * min, keep: true },
      { id: 2, usedAt: now - 4 * min, keep: true },
      { id: 3, usedAt: now - 3 * min, keep: true },
      { id: 4, usedAt: now - 2_000, keep: true },
      { id: 5, usedAt: now - 1_000 },
    ]
    expect(tidyPlan(tabs, now).close).toEqual([])
    // 1분이 지나면 그때는 정리 대상
    expect(tidyPlan(tabs, now + RECENT_MS + 2_000).close).toEqual([5])
  })

  it('폰에서 보고 있거나 방금 연 탭은 오래됐어도 건드리지 않는다', () => {
    const tabs = Array.from({ length: MAX_TABS + 1 }, (_, i) => ({
      id: i + 1,
      usedAt: now - CLOSE_AFTER_MS - i,
      keep: i === MAX_TABS,
    }))
    const plan = tidyPlan(tabs, now)
    expect(plan.close).not.toContain(MAX_TABS + 1)
    expect(plan.sleep).not.toContain(MAX_TABS + 1)
  })

  it('앞에 나와 있거나 이미 잠든 탭은 잠재우지 않는다', () => {
    const plan = tidyPlan(
      [
        { id: 1, usedAt: now - SLEEP_AFTER_MS, active: true },
        { id: 2, usedAt: now - SLEEP_AFTER_MS, discarded: true },
      ],
      now,
    )
    expect(plan.sleep).toEqual([])
  })

  it('결제 창을 띄운 주문서와 그 결제 창(가족 탭)은 오래되거나 많아도 닫거나 재우지 않는다 (실측 11-20 G마켓)', () => {
    const tabs = [
      { id: 1, usedAt: now - CLOSE_AFTER_MS, family: true },
      { id: 2, usedAt: now - SLEEP_AFTER_MS, family: true },
      ...Array.from({ length: MAX_TABS }, (_, i) => ({ id: 10 + i, usedAt: now - 2 * min - i })),
    ]
    const plan = tidyPlan(tabs, now)
    expect(plan.close).not.toContain(1)
    expect(plan.close).not.toContain(2)
    expect(plan.sleep).not.toContain(2)
    // 가족이 아닌 탭으로 개수를 맞춘다
    expect(plan.close.length).toBe(2)
  })
})
