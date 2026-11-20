import { describe, expect, it } from 'vitest'
import { kidScore, layoutFrames, screenOrder } from './frames.js'
import type { KidBox } from './page.js'

const kid = (
  src: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<KidBox> = {},
): KidBox => ({
  src,
  srcdoc: false,
  name: '',
  x,
  y,
  w,
  h,
  shown: true,
  ...extra,
})

describe('화면 안 액자 자리 맞추기', () => {
  it('겹친 액자(결제 → 배송지 추가 → 주소 찾기)는 단계마다 바깥 상자를 더한다 (실측 11-20 G마켓)', () => {
    const root = {
      self: { w: 1200, h: 900 },
      kids: [kid('https://pay.example.com/checkout', 100, 50, 800, 700)],
    }
    const nodes = [
      {
        frameId: 5,
        parentFrameId: 0,
        url: 'https://pay.example.com/checkout?step=2',
        self: { w: 800, h: 700 },
        kids: [kid('https://addr.example.kr/popup', 20, 30, 500, 400)],
      },
      {
        frameId: 9,
        parentFrameId: 5,
        url: 'https://addr.example.kr/popup',
        self: { w: 500, h: 400 },
        kids: [kid('https://juso.example.go.kr/search', 10, 60, 300, 200)],
      },
      {
        frameId: 12,
        parentFrameId: 9,
        url: 'https://juso.example.go.kr/search?q=1',
        self: { w: 300, h: 200 },
      },
    ]
    const p = layoutFrames(nodes, root)
    expect(p.get(5)).toMatchObject({ x: 100, y: 50, shown: true })
    expect(p.get(9)).toMatchObject({ x: 120, y: 80 })
    expect(p.get(12)).toMatchObject({ x: 130, y: 140, w: 300, h: 200, shown: true })
  })

  it('about:blank 액자는 자기 상자(frameElement)로 맞추고, 주소 없는 액자 상자와 짝짓는다', () => {
    const root = {
      self: { w: 1000, h: 800 },
      kids: [kid('', 0, 0, 1, 1, { shown: false }), kid('', 200, 300, 400, 200)],
    }
    const nodes = [
      {
        frameId: 3,
        parentFrameId: 0,
        url: 'about:blank',
        self: { w: 400, h: 200, owner: { x: 200, y: 300, w: 400, h: 200 } },
      },
      { frameId: 4, parentFrameId: 0, url: 'about:blank', self: { w: 1, h: 1 } },
    ]
    const p = layoutFrames(nodes, root)
    expect(p.get(3)).toMatchObject({ x: 200, y: 300, kid: 1, shown: true })
    // 남은 1×1 추적용 빈 액자는 남은 상자와 짝지어지고, 보이지 않는다
    expect(p.get(4)).toMatchObject({ kid: 0, shown: false })
  })

  it('주소가 같아도 크기가 다르면 크기로 가린다', () => {
    const src = 'https://ads.example.com/slot'
    const root = { self: { w: 1000, h: 800 }, kids: [kid(src, 0, 0, 300, 250), kid(src, 0, 400, 728, 90)] }
    const p = layoutFrames([{ frameId: 7, parentFrameId: 0, url: src, self: { w: 728, h: 90 } }], root)
    expect(p.get(7)).toMatchObject({ y: 400, kid: 1 })
    expect(p.get(7)?.guess).toBeUndefined()
  })

  it('주소·크기가 같은 액자가 여럿이면 순서로 짝짓고 짐작이라고 남긴다', () => {
    const src = 'https://pg.example.com/field'
    const root = { self: { w: 1000, h: 800 }, kids: [kid(src, 0, 100, 200, 40), kid(src, 0, 200, 200, 40)] }
    const p = layoutFrames(
      [
        { frameId: 21, parentFrameId: 0, url: src, self: { w: 200, h: 40 } },
        { frameId: 22, parentFrameId: 0, url: src, self: { w: 200, h: 40 } },
      ],
      root,
    )
    expect(p.get(21)).toMatchObject({ y: 100, guess: true })
    expect(p.get(22)).toMatchObject({ y: 200, guess: true })
  })

  it('바깥 액자 자리를 모르면 안쪽도 모른다 (0,0으로 짐작하지 않는다)', () => {
    const root = { self: { w: 1000, h: 800 }, kids: [] }
    const p = layoutFrames(
      [
        { frameId: 2, parentFrameId: 0, url: 'https://x.example.com/' },
        { frameId: 3, parentFrameId: 2, url: 'https://y.example.com/' },
      ],
      root,
    )
    expect(p.has(2)).toBe(false)
    expect(p.has(3)).toBe(false)
  })

  it('화면 순서: 보이는 것을 위에서 아래로, 자리를 모르는 것은 뒤로', () => {
    const root = {
      self: { w: 1000, h: 800 },
      kids: [
        kid('https://a.example.com/', 0, 500, 100, 100),
        kid('https://b.example.com/', 0, 100, 100, 100),
      ],
    }
    const p = layoutFrames(
      [
        { frameId: 2, parentFrameId: 0, url: 'https://a.example.com/' },
        { frameId: 3, parentFrameId: 0, url: 'https://b.example.com/' },
        { frameId: 4, parentFrameId: 0, url: 'https://c.example.com/' },
      ],
      root,
    )
    expect(screenOrder([4, 2, 3], p)).toEqual([3, 2, 4])
  })

  it('점수: 전체 주소 > 주소+경로 > 출처, 크기가 맞으면 더한다', () => {
    const k = kid('https://pay.example.com/a?x=1', 0, 0, 300, 200)
    expect(kidScore(k, 'https://pay.example.com/a?x=1')).toBe(4)
    expect(kidScore(k, 'https://pay.example.com/a?x=2')).toBe(3)
    expect(kidScore(k, 'https://pay.example.com/b')).toBe(2)
    expect(kidScore(k, 'https://other.example.com/a')).toBe(0)
    expect(kidScore(k, 'https://other.example.com/a', { w: 300, h: 200 })).toBe(2)
    expect(kidScore(kid('', 0, 0, 1, 1, { srcdoc: true }), 'about:srcdoc')).toBe(3)
  })
})
