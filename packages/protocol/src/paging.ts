// 긴 목록(피드·보관함·활동) 나눠 받기. 본체는 pageOf로 자르고, 폰·PC 화면은 Pager로 이어 붙인다.
// 순서는 언제나 "최근 것부터, 같은 시각이면 id 큰 것부터"라 같은 밀리초에 생긴 것도 빠지거나 겹치지 않는다.
// 커서는 "<시각>|<id>" (시각만 줘도 된다: 그 시각보다 앞의 것). 화면은 묶지 않고 불러오므로 다른 모듈을 부르지 않는다

/** 한 페이지. next가 없으면 끝(더 없음) */
export interface Page<T> {
  items: T[]
  next?: string
}

/** 한 번에 보내는 기본 개수 */
export const PAGE_SIZE = 30
/** 한 번에 보낼 수 있는 가장 많은 개수 */
export const PAGE_MAX = 100

/** 이 항목 다음부터 받을 커서 */
export const cursorOf = (at: string, id: string) => `${at}|${id}`

function readCursor(c: string): { at: string; id?: string } {
  const i = c.indexOf('|')
  return i < 0 ? { at: c } : { at: c.slice(0, i), id: c.slice(i + 1) || undefined }
}

/** a가 b보다 앞(최근)이면 음수 */
function order(aAt: string, aId: string, bAt: string, bId: string): number {
  if (aAt !== bAt) return aAt < bAt ? 1 : -1
  return aId === bId ? 0 : aId < bId ? 1 : -1
}

/** 커서보다 뒤(더 오래된 것)인지 */
export function isAfter(at: string, id: string, cursor: string): boolean {
  const c = readCursor(cursor)
  if (at !== c.at) return at < c.at
  return c.id !== undefined && id < c.id
}

/** 최근 것부터 줄 세우기 (같은 시각이면 id 큰 것부터) */
export function newestFirst<T extends { id: string }>(items: T[], at: (t: T) => string): T[] {
  return [...items].sort((a, b) => order(at(a), a.id, at(b), b.id))
}

/** 한 페이지 자르기: before(커서)보다 뒤의 것 중 앞에서 limit개 */
export function pageOf<T extends { id: string }>(
  items: T[],
  at: (t: T) => string,
  o: { before?: string; limit?: number } = {},
): Page<T> {
  const limit = Math.min(Math.max(1, Math.floor(o.limit ?? PAGE_SIZE) || PAGE_SIZE), PAGE_MAX)
  const before = o.before
  const sorted = newestFirst(items, at)
  const rest = before ? sorted.filter((t) => isAfter(at(t), t.id, before)) : sorted
  const page = rest.slice(0, limit)
  const last = page.at(-1)
  return rest.length > limit && last ? { items: page, next: cursorOf(at(last), last.id) } : { items: page }
}

/**
 * 새로 받은 첫 페이지(head)를 이미 받아 둔 목록에 맞춘다.
 * head가 덮는 범위(맨 앞 ~ head의 마지막)는 head가 맞다(지워진 건 빠지고 바뀐 건 새 것으로).
 * 그보다 오래된 것은 앞서 받아 둔 것을 그대로 두고, 그 뒤 커서도 이어 쓴다
 */
export function mergeHead<T extends { id: string }>(
  head: Page<T>,
  loaded: Page<T>,
  at: (t: T) => string,
): Page<T> {
  const last = head.items.at(-1)
  // head가 끝까지 다 담았으면(또는 비었으면) head가 전부다
  if (!head.next || !last) return { items: [...head.items], ...(head.next ? { next: head.next } : {}) }
  const edge = cursorOf(at(last), last.id)
  const ids = new Set(head.items.map((t) => t.id))
  const older = loaded.items.filter((t) => !ids.has(t.id) && isAfter(at(t), t.id, edge))
  if (!older.length) return { items: [...head.items], next: head.next }
  return {
    items: [...head.items, ...newestFirst(older, at)],
    ...(loaded.next ? { next: loaded.next } : {}),
  }
}

/**
 * 화면의 긴 목록 하나: 첫 페이지는 상태(life)로 오고, 아래로 내리면 more()로 다음 페이지를 부탁한다.
 * 답은 take()로 넣는다 (PC는 바로, 폰은 중계로 온 답을 받았을 때)
 */
export class Pager<T extends { id: string }> {
  items: T[] = []
  next?: string
  loading = false
  /** 한 번이라도 받았는지 (받기 전엔 "여기까지예요"를 보이지 않는다) */
  started = false
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly at: (t: T) => string,
    /** 다음 페이지를 부탁한다 (before 없으면 첫 페이지) */
    private readonly ask: (before?: string) => void,
    private readonly changed: () => void = () => {},
  ) {}

  /** 더 없음 */
  get end(): boolean {
    return this.started && !this.next
  }

  /** 받은 페이지 넣기. before가 없으면 첫 페이지(새로 고침), 있으면 지금 커서의 다음 페이지일 때만 붙인다 */
  take(before: string | undefined, page: Page<T>) {
    if (before === undefined) {
      const m = mergeHead(page, { items: this.items, ...(this.next ? { next: this.next } : {}) }, this.at)
      this.items = m.items
      this.next = m.next
      this.started = true
    } else {
      if (before !== this.next) return
      const ids = new Set(this.items.map((t) => t.id))
      this.items = [...this.items, ...page.items.filter((t) => !ids.has(t.id))]
      this.next = page.next
      this.loading = false
      clearTimeout(this.timer)
    }
    this.changed()
  }

  /** 다음 페이지 부탁 (이미 부탁했거나 끝이면 하지 않는다). 답이 안 오면 10초 뒤 다시 누를 수 있게 */
  more(): boolean {
    if (this.loading || !this.next) return false
    this.loading = true
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.loading = false
      this.changed()
    }, 10_000)
    this.ask(this.next)
    this.changed()
    return true
  }

  /** 첫 페이지 다시 받기 (상태로 첫 페이지가 오지 않는 목록: 활동) */
  refresh() {
    this.ask(undefined)
  }

  /** 하나만 바꾸기 (반응·답처럼 화면에서 바로 바뀌어 보여야 할 때) */
  patch(id: string, f: (t: T) => T) {
    this.items = this.items.map((t) => (t.id === id ? f(t) : t))
  }

  /** 하나 빼기 (지웠을 때: 첫 페이지 밖의 것은 새 첫 페이지가 와도 남아 있으니 바로 뺀다) */
  remove(id: string) {
    this.items = this.items.filter((t) => t.id !== id)
  }
}
