import { describe, expect, it } from 'vitest'
import { CLOSE_AFTER_MS, MAX_TABS, SLEEP_AFTER_MS, tidyPlan } from './tidy.js'

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
})
