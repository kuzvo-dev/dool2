import { describe, expect, it } from 'vitest'
import { cursorOf, mergeHead, Pager, pageOf } from './paging.js'

interface It {
  id: string
  at: string
}
const at = (t: It) => t.at
const T = (min: number) => new Date(Date.UTC(2026, 10, 19, 12, 0) - min * 60_000).toISOString()
/** n개, 최근 것부터 (분 단위로 하나씩) */
const make = (n: number, from = 0): It[] =>
  Array.from({ length: n }, (_, i) => ({ id: `i${from + i}`, at: T(from + i) }))

/** 커서를 따라 끝까지 받기 */
function all(items: It[], limit: number) {
  const out: It[] = []
  let before: string | undefined
  for (let i = 0; i < 100; i++) {
    const p = pageOf(items, at, { limit, ...(before ? { before } : {}) })
    out.push(...p.items)
    if (!p.next) return { out, pages: i + 1 }
    before = p.next
  }
  throw new Error('끝나지 않아요')
}

describe('긴 목록 나눠 받기 (pageOf)', () => {
  it('빈 목록은 빈 페이지, 다음 없음', () => {
    expect(pageOf([], at)).toEqual({ items: [] })
  })

  it('딱 맞게 떨어지는 마지막 페이지는 다음이 없다 (빈 페이지를 더 받지 않는다)', () => {
    const p1 = pageOf(make(60), at, { limit: 30 })
    expect(p1.items).toHaveLength(30)
    expect(p1.next).toBe(cursorOf(T(29), 'i29'))
    const p2 = pageOf(make(60), at, { limit: 30, before: p1.next })
    expect(p2.items.map((t) => t.id)[0]).toBe('i30')
    expect(p2.next).toBeUndefined()
    expect(pageOf(make(30), at, { limit: 30 }).next).toBeUndefined()
  })

  it('같은 시각에 생긴 것도 페이지 경계에서 빠지거나 겹치지 않는다', () => {
    const same = new Date(Date.UTC(2026, 10, 19)).toISOString()
    const items: It[] = [
      ...make(3),
      ...Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, at: same })),
      ...make(3, 5000),
    ]
    // 저장 순서가 섞여 있어도
    const shuffled = [...items].reverse()
    for (const limit of [1, 2, 3, 4, 5, 13]) {
      const { out } = all(shuffled, limit)
      expect(out).toHaveLength(items.length)
      expect(new Set(out.map((t) => t.id)).size).toBe(items.length)
    }
  })

  it('최근 것부터 · 시각만 준 커서는 그 시각보다 앞의 것 · 지워진 커서도 이어 간다', () => {
    const items = make(10)
    expect(pageOf(items.slice().reverse(), at, { limit: 3 }).items.map((t) => t.id)).toEqual([
      'i0',
      'i1',
      'i2',
    ])
    expect(pageOf(items, at, { before: T(4), limit: 2 }).items.map((t) => t.id)).toEqual(['i5', 'i6'])
    // 커서였던 i4를 지운 뒤에도 그다음부터
    const gone = items.filter((t) => t.id !== 'i4')
    expect(pageOf(gone, at, { before: cursorOf(T(4), 'i4'), limit: 2 }).items.map((t) => t.id)).toEqual([
      'i5',
      'i6',
    ])
  })

  it('개수는 1~100으로 맞춘다', () => {
    expect(pageOf(make(150), at, { limit: 0 }).items).toHaveLength(30)
    expect(pageOf(make(150), at, { limit: 500 }).items).toHaveLength(100)
  })
})

describe('새 첫 페이지 맞추기 (mergeHead)', () => {
  it('새 것이 생겨 첫 페이지에서 밀려난 것도 받아 둔 목록에 남는다', () => {
    const items = make(90)
    const head = pageOf(items, at, { limit: 30 })
    const second = pageOf(items, at, { limit: 30, before: head.next })
    const loaded = { items: [...head.items, ...second.items], next: second.next }
    // 새 것 하나가 맨 앞에: 예전 i29는 이제 첫 페이지 밖
    const fresh = [{ id: 'new', at: T(-1) }, ...items]
    const m = mergeHead(pageOf(fresh, at, { limit: 30 }), loaded, at)
    expect(m.items.map((t) => t.id).slice(0, 2)).toEqual(['new', 'i0'])
    expect(m.items.map((t) => t.id)).toContain('i29')
    expect(m.items).toHaveLength(61)
    expect(m.next).toBe(second.next)
  })

  it('첫 페이지 범위에서 지워진 것은 빠지고, 다 지워졌으면(처음부터 다시) 비운다', () => {
    const items = make(60)
    const loaded = { items, next: undefined }
    const m = mergeHead(
      pageOf(
        items.filter((t) => t.id !== 'i3'),
        at,
        { limit: 30 },
      ),
      loaded,
      at,
    )
    expect(m.items.map((t) => t.id)).not.toContain('i3')
    expect(m.items).toHaveLength(59)
    expect(mergeHead({ items: [] }, loaded, at)).toEqual({ items: [] })
  })
})

describe('화면 목록 (Pager)', () => {
  it('첫 페이지 → 더 받기 → 끝. 늦게 온 같은 페이지·옛 커서의 답은 버린다', () => {
    const items = make(65)
    const asked: (string | undefined)[] = []
    const p = new Pager<It>(at, (before) => asked.push(before))
    expect(p.end).toBe(false)
    p.take(undefined, pageOf(items, at, { limit: 30 }))
    expect(p.more()).toBe(true)
    expect(p.more()).toBe(false) // 이미 부탁함
    const b1 = asked[0] as string
    p.take(b1, pageOf(items, at, { limit: 30, before: b1 }))
    p.take(b1, pageOf(items, at, { limit: 30, before: b1 })) // 같은 답이 또 옴
    expect(p.items).toHaveLength(60)
    p.more()
    const b2 = asked[1] as string
    p.take(b2, pageOf(items, at, { limit: 30, before: b2 }))
    expect(p.items).toHaveLength(65)
    expect(p.end).toBe(true)
    expect(p.more()).toBe(false)
    expect(new Set(p.items.map((t) => t.id)).size).toBe(65)
  })
})
