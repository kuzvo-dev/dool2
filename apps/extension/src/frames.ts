// 화면 안 액자(iframe) 나무: 액자마다 페이지 화면의 어디에 그려지는지 맞춘다 (읽기 순서·보이는지·글 속 자리 표시).
// 페이지 읽기 때 문서마다 "안에 든 액자 상자들(kids)"과 "자기 크기·같은 주소면 자기 상자(self)"를 받아,
// 바깥 문서의 액자 상자와 안쪽 문서를 짝지어 단계마다 더한다 (결제 → 배송지 추가 → 주소 찾기처럼 겹친 액자).
// 판단 없는 순수 함수라 테스트로 고정한다 (실제 재기는 page.ts, 부르는 곳은 background.ts)
import type { FrameSelf, KidBox } from './page.js'

export interface FrameNode {
  frameId: number
  parentFrameId: number
  url: string
  /** 그 액자를 읽었을 때 받은 것 (못 읽었으면 없음) */
  self?: FrameSelf
  kids?: KidBox[]
}

export interface FramePlace {
  /** 페이지(맨 바깥) 화면 기준 안쪽 상자 */
  x: number
  y: number
  w: number
  h: number
  /** 바깥 문서의 액자 목록(kids)에서 몇 번째인지 */
  kid?: number
  /** 크기가 있고 숨지 않았고, 바깥 화면과 겹친다 */
  shown: boolean
  /** 주소·크기가 같은 액자가 여럿이라 순서로 짝지었다 (누를 때는 다시 확인한다) */
  guess?: boolean
}

function norm(u: string, full: boolean): string {
  try {
    const x = new URL(u)
    return full ? `${x.origin}${x.pathname}` : x.origin
  } catch {
    return u
  }
}

/** 바깥 문서의 액자 상자가 이 주소·크기의 액자일 점수 (page.ts pageFrameBox와 같은 규칙). 2 미만이면 아니다 */
export function kidScore(kid: KidBox, url: string, self?: FrameSelf): number {
  let s = 0
  if (url === 'about:srcdoc') s = kid.srcdoc ? 3 : 0
  else if (url === 'about:blank' || url === '')
    s = !kid.srcdoc && (!kid.src || kid.src === 'about:blank') ? 2 : 0
  else if (kid.src === url) s = 4
  else if (kid.src && norm(kid.src, true) === norm(url, true)) s = 3
  else if (kid.src && norm(kid.src, false) === norm(url, false)) s = 2
  if (self && self.w > 0 && self.h > 0 && Math.abs(kid.w - self.w) <= 2 && Math.abs(kid.h - self.h) <= 2)
    s += 2
  return s
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2

/**
 * 액자마다 페이지 화면 자리. root: 맨 바깥 문서의 self·kids.
 * 바깥 액자 자리를 모르면 그 안 액자도 모른다 (지도에 없음 = 자리 모름)
 */
export function layoutFrames(
  nodes: FrameNode[],
  root: { self: FrameSelf; kids: KidBox[] },
): Map<number, FramePlace> {
  const places = new Map<number, FramePlace>()
  places.set(0, { x: 0, y: 0, w: root.self.w, h: root.self.h, shown: true })
  const kidsOf = (id: number) => (id === 0 ? root.kids : (nodes.find((n) => n.frameId === id)?.kids ?? []))
  const vw = root.self.w
  const vh = root.self.h
  let todo = [0]
  const seen = new Set<number>()
  while (todo.length) {
    const next: number[] = []
    for (const pid of todo) {
      if (seen.has(pid)) continue
      seen.add(pid)
      const parent = places.get(pid)
      const children = nodes.filter((n) => n.parentFrameId === pid && n.frameId !== pid)
      next.push(...children.map((c) => c.frameId))
      if (!parent) continue
      const kids = kidsOf(pid)
      const taken = new Set<number>()
      const put = (
        c: FrameNode,
        k: number,
        box: { x: number; y: number; w: number; h: number },
        guess = false,
      ) => {
        taken.add(k)
        const kid = kids[k]
        const x = parent.x + box.x
        const y = parent.y + box.y
        const overlaps = x < vw && y < vh && x + box.w > 0 && y + box.h > 0
        places.set(c.frameId, {
          x,
          y,
          w: box.w,
          h: box.h,
          ...(k >= 0 ? { kid: k } : {}),
          shown: parent.shown && (kid?.shown ?? box.w > 2) && overlaps,
          ...(guess ? { guess } : {}),
        })
      }
      // 1) 같은 주소라 자기 상자를 직접 잰 액자
      const rest: FrameNode[] = []
      for (const c of children) {
        const own = c.self?.owner
        if (!own) {
          rest.push(c)
          continue
        }
        const k = kids.findIndex((kid, i) => !taken.has(i) && near(kid, own))
        put(c, k, own)
      }
      // 2) 주소·크기 점수가 하나로 정해지는 액자
      const ties: FrameNode[] = []
      for (const c of rest) {
        const scored = kids
          .map((kid, i) => ({ i, s: taken.has(i) ? 0 : kidScore(kid, c.url, c.self) }))
          .filter((x) => x.s >= 2)
        const best = Math.max(0, ...scored.map((x) => x.s))
        const top = scored.filter((x) => x.s === best)
        const one = top[0]
        if (top.length === 1 && one) put(c, one.i, kids[one.i] as KidBox)
        else if (top.length > 1) ties.push(c)
      }
      // 3) 같은 점수가 여럿: 문서 순서와 액자 번호 순서로 짝짓는다 (읽기 순서용 짐작. 누를 때는 다시 확인한다)
      for (const c of ties.sort((a, b) => a.frameId - b.frameId)) {
        const scored = kids
          .map((kid, i) => ({ i, s: taken.has(i) ? 0 : kidScore(kid, c.url, c.self) }))
          .filter((x) => x.s >= 2)
        const best = Math.max(0, ...scored.map((x) => x.s))
        const first = scored.find((x) => x.s === best)
        if (first) put(c, first.i, kids[first.i] as KidBox, true)
      }
    }
    todo = next
  }
  return places
}

/** 화면 순서(위→아래, 왼쪽→오른쪽). 자리를 모르는 액자는 맨 뒤 (getAllFrames 순서는 화면 순서가 아니다) */
export function screenOrder(ids: number[], places: Map<number, FramePlace>): number[] {
  return [...ids].sort((a, b) => {
    const pa = places.get(a)
    const pb = places.get(b)
    if (!pa || !pb) return pa ? -1 : pb ? 1 : a - b
    if (pa.shown !== pb.shown) return pa.shown ? -1 : 1
    if (Math.abs(pa.y - pb.y) > 4) return pa.y - pb.y
    return pa.x - pb.x || a - b
  })
}
