// What changed on a page between two reads, for the results of clicks and typing.
//
// Before, every click and every typed word re-read the page and gave the AI the whole text again (up to 8,000
// characters), although most clicks change a small part (an option list opens, a counter goes up, a message shows).
// Page re-reads after clicks were the largest share of all text the tools gave the AI. Now the daemon keeps the last
// page the AI saw per tab and, after a click or typing on the same page, gives only the lines that changed. The refs
// (e12) of lines that did not change still point at the same elements, so the AI can keep using what it read.
//
// When the page changed as a whole (another URL, or most lines differ), the whole page is given as before.

/** The last page the AI saw in a tab (a whole read, not a part read with view, from or skip) */
export interface SeenPage {
  url: string
  text: string
  /** The text was cut at the read's size limit (the last line may be cut, and more lines follow) */
  truncated: boolean
  /** When it was read (ms) */
  at: number
}

export interface PageDiff {
  /** Lines of the new page and how many of them are new or changed */
  lines: number
  changed: number
  /** Text to give the AI in place of the page text ('' when nothing changed) */
  text: string
}

/** Above this share of changed lines the page counts as replaced and is given whole */
export const DIFF_MAX_SHARE = 0.5
/** A diff longer than this share of the page text saves little: the whole page is given */
export const DIFF_MAX_SIZE = 0.7
/** Above this many line pairs left to compare, the page is given whole (the comparison grows with lines squared) */
const MAX_PAIRS = 2_000_000
/** Removed lines shown per changed region (the rest are counted) */
const GONE_SHOWN = 3

/**
 * Lines that changed between the page the AI saw and the page now. undefined when the page should be given whole:
 * another address, most lines changed, or the diff would be nearly as long as the page.
 */
export function pageDiff(
  seen: Pick<SeenPage, 'url' | 'text' | 'truncated'>,
  now: { url: string; text: string; truncated: boolean },
): PageDiff | undefined {
  if (seen.url !== now.url) return undefined
  const a = comparable(seen.text, seen.truncated)
  const b = comparable(now.text, now.truncated)
  const ops = lineOps(a, b)
  if (!ops) return undefined
  // Changed regions: runs of lines that are new in b or gone from a
  const regions: { added: number[]; gone: string[]; at: number }[] = []
  let cur: (typeof regions)[number] | undefined
  for (const op of ops) {
    if (op.kind === 'same') {
      cur = undefined
      continue
    }
    if (!cur) {
      cur = { added: [], gone: [], at: op.kind === 'add' ? op.b : op.bAt }
      regions.push(cur)
    }
    if (op.kind === 'add') cur.added.push(op.b)
    else cur.gone.push(a[op.a] as string)
  }
  // When the new read was cut at the size limit, lines at the end can be pushed below the cut by lines added above:
  // they are not gone from the page
  const last = regions.at(-1)
  if (now.truncated && last && !last.added.length && last.at >= b.length) regions.pop()
  else if (now.truncated && last && last.at + last.added.length >= b.length) last.gone = []
  const changed = regions.reduce((n, r) => n + r.added.length, 0)
  const gone = regions.reduce((n, r) => n + r.gone.length, 0)
  if (!regions.some((r) => r.added.length || r.gone.length)) return { lines: b.length, changed: 0, text: '' }
  // Share of lines that differ, counted on both pages (a page whose lines all changed counts 1)
  if ((changed + gone) / (a.length + b.length) > DIFF_MAX_SHARE) return undefined
  const out: string[] = []
  for (const r of regions) {
    if (!r.added.length && !r.gone.length) continue
    const head = headingAbove(b, r.at)
    out.push(head ? `… under ${clip(head, 100)}` : '…')
    for (const i of r.added) out.push(b[i] as string)
    for (const g of r.gone.slice(0, GONE_SHOWN)) out.push(`(gone) ${clip(g, 120)}`)
    if (r.gone.length > GONE_SHOWN) out.push(`(gone) … ${r.gone.length - GONE_SHOWN} more lines`)
  }
  const text = out.join('\n')
  if (text.length > now.text.length * DIFF_MAX_SIZE) return undefined
  return { lines: b.length, changed, text }
}

/** Lines to compare: without the last line of a read cut at the size limit (it may be cut in the middle) */
function comparable(text: string, truncated: boolean): string[] {
  const lines = text.split('\n')
  if (truncated && lines.length > 1) lines.pop()
  return lines
}

/** The nearest heading line (# …) above line i of the page, for where a change is */
function headingAbove(lines: string[], i: number): string | undefined {
  for (let k = Math.min(i, lines.length) - 1; k >= 0; k--)
    if (/^#{1,6} /.test(lines[k] as string)) return lines[k]
  return undefined
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

type Op =
  | { kind: 'same'; a: number; b: number }
  | { kind: 'add'; b: number }
  | { kind: 'gone'; a: number; bAt: number }

/** Line-by-line comparison (longest common subsequence). Lines that are the same at the start and end are skipped first */
export function lineOps(a: string[], b: string[]): Op[] | undefined {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  if (n * m > MAX_PAIRS) return undefined
  // lcs[i][j] = common lines of a[start+i..endA) and b[start+j..endB)
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (lcs[i] as Uint16Array)[j] =
        a[start + i] === b[start + j]
          ? ((lcs[i + 1] as Uint16Array)[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as Uint16Array)[j] as number, (lcs[i] as Uint16Array)[j + 1] as number)
  const ops: Op[] = []
  for (let k = 0; k < start; k++) ops.push({ kind: 'same', a: k, b: k })
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push({ kind: 'same', a: start + i, b: start + j })
      i++
      j++
    } else if (
      j < m &&
      (i >= n || ((lcs[i] as Uint16Array)[j + 1] as number) >= ((lcs[i + 1] as Uint16Array)[j] as number))
    ) {
      ops.push({ kind: 'add', b: start + j })
      j++
    } else {
      ops.push({ kind: 'gone', a: start + i, bAt: start + j })
      i++
    }
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ kind: 'same', a: endA + k, b: endB + k })
  return ops
}
