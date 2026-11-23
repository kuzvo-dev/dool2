// Fetching long lists (feed, library, activity) in pages. The core slices with pageOf, and the phone and PC screens chain pages with Pager.
// The order is always "newest first, and for the same time, larger id first", so items created in the same millisecond are neither skipped nor repeated.
// The cursor is "<time>|<id>" (a time alone also works: everything before that time). The screens load modules unbundled, so this file imports no other module

/** One page. No next means the end (nothing more) */
export interface Page<T> {
  items: T[]
  next?: string
}

/** Default number of items per request */
export const PAGE_SIZE = 30
/** The most items one request can return */
export const PAGE_MAX = 100

/** The cursor to fetch what comes after this item */
export const cursorOf = (at: string, id: string) => `${at}|${id}`

function readCursor(c: string): { at: string; id?: string } {
  const i = c.indexOf('|')
  return i < 0 ? { at: c } : { at: c.slice(0, i), id: c.slice(i + 1) || undefined }
}

/** Negative if a comes before b (is newer) */
function order(aAt: string, aId: string, bAt: string, bId: string): number {
  if (aAt !== bAt) return aAt < bAt ? 1 : -1
  return aId === bId ? 0 : aId < bId ? 1 : -1
}

/** Whether it comes after the cursor (is older) */
export function isAfter(at: string, id: string, cursor: string): boolean {
  const c = readCursor(cursor)
  if (at !== c.at) return at < c.at
  return c.id !== undefined && id < c.id
}

/** Sort newest first (for the same time, larger id first) */
export function newestFirst<T extends { id: string }>(items: T[], at: (t: T) => string): T[] {
  return [...items].sort((a, b) => order(at(a), a.id, at(b), b.id))
}

/** Cut one page: the first limit items among those after before (the cursor) */
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
 * Fits a freshly fetched first page (head) onto the list already fetched.
 * The range head covers (from the very start to head's last item) is whatever head says (deleted items drop out, changed ones become the new version).
 * Anything older than that keeps what was fetched earlier, and the cursor after it carries on
 */
export function mergeHead<T extends { id: string }>(
  head: Page<T>,
  loaded: Page<T>,
  at: (t: T) => string,
): Page<T> {
  const last = head.items.at(-1)
  // If head holds everything (or is empty), head is the whole list
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
 * One long list on a screen: the first page arrives with the state (life), and scrolling down asks for the next page with more().
 * Replies go in with take() (the PC right away, the phone when the reply comes through the relay)
 */
export class Pager<T extends { id: string }> {
  items: T[] = []
  next?: string
  loading = false
  /** Whether anything was fetched even once (before that, "That's all" is not shown) */
  started = false
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly at: (t: T) => string,
    /** Ask for the next page (the first page when before is missing) */
    private readonly ask: (before?: string) => void,
    private readonly changed: () => void = () => {},
  ) {}

  /** Nothing more */
  get end(): boolean {
    return this.started && !this.next
  }

  /** Put in a fetched page. Without before it is the first page (refresh); with before it is appended only if it is the next page after the current cursor */
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

  /** Ask for the next page (does nothing if already asked or at the end). If no reply comes, it can be pressed again after 10 seconds */
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

  /** Fetch the first page again (for lists whose first page does not come with the state: activity) */
  refresh() {
    this.ask(undefined)
  }

  /** Change one item (when a reaction or reply must show on screen right away) */
  patch(id: string, f: (t: T) => T) {
    this.items = this.items.map((t) => (t.id === id ? f(t) : t))
  }

  /** Remove one item (after deleting: items outside the first page stay even when a new first page arrives, so remove it right away) */
  remove(id: string) {
    this.items = this.items.filter((t) => t.id !== id)
  }
}
