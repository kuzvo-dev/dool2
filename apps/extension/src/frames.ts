// Tree of frames (iframes) on the page: fit where each frame is drawn on the page viewport (reading order, visibility, placeholders in the text).
// On a page read, each document gives its "frame boxes inside it (kids)" and "own size, and its own box if same-origin (self)";
// pair the outer document's frame boxes with the inner documents and add them up step by step (nested frames like payment -> add delivery address -> address search).
// Pure functions with no judgment, so tests pin them (the real measuring is in page.ts, the caller is background.ts)
import type { FrameSelf, KidBox } from './page.js'

export interface FrameNode {
  frameId: number
  parentFrameId: number
  url: string
  /** What was received when the frame was read (absent if it could not be read) */
  self?: FrameSelf
  kids?: KidBox[]
}

export interface FramePlace {
  /** Inner box relative to the page (outermost) viewport */
  x: number
  y: number
  w: number
  h: number
  /** Position in the outer document's frame list (kids) */
  kid?: number
  /** Has a size, is not hidden, and overlaps the outer viewport */
  shown: boolean
  /** Several frames share the URL and size, so they were paired by order (checked again when clicking) */
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

/** Score for an outer document's frame box being the frame with this URL and size (same rule as pageFrameBox in page.ts). Below 2 means no */
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
 * Page viewport position of each frame. root: self and kids of the outermost document.
 * If the outer frame's position is unknown, so is the frame inside it (not in the map = position unknown)
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
      // 1) A frame that is same-origin and measured its own box directly
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
      // 2) A frame whose URL and size score settles on one
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
      // 3) Several with the same score: pair by document order and frame number order (a guess for reading order. Checked again when clicking)
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

/** Screen order (top to bottom, left to right). Frames with unknown position go last (getAllFrames order is not screen order) */
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
