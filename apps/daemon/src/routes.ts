// Remembered routes (ADR 0034): the clicks that took Dool2 from a page it opened to the page it needed, per site.
// The next time, browser_route walks the same clicks without asking the AI between them, at a person's pace.
// Only the start address (no query) and the names of the links and buttons pressed are kept: no typed text, no
// page content. Routes through payments are never kept.
import { readFileSync, writeFileSync } from 'node:fs'

export interface Route {
  id: string
  host: string
  /** Where the route starts: origin + path, without query or hash */
  start: string
  /** Names of the links and buttons pressed, in order (each one moved to another page) */
  steps: string[]
  /** Title of the page the route ends on */
  title: string
  /** Walks with browser_route that reached the end (successes). The name is kept for files written before counts */
  uses: number
  /** Walks with browser_route that stopped on the way (a click that did not go through, a page that did not move) */
  fails?: number
  /** Times the AI walked the same clicks by hand, the first walk included (missing in older files = 1) */
  seen?: number
  /** Last time the route was walked, by hand or with browser_route */
  lastAt: string
}

/** Times a route reached its page (with browser_route or by hand) and times it stopped (ADR 0034 follow-up) */
export function routeCounts(r: Route): { ok: number; failed: number } {
  return { ok: (r.uses || 0) + (r.seen ?? 1), failed: r.fails ?? 0 }
}

/** Most routes kept per site (the least recently used go first) */
export const ROUTES_PER_HOST = 6
/** Shortest and longest routes kept (one click is not worth remembering; long ones break easily) */
export const MIN_STEPS = 2
export const MAX_STEPS = 6

/** Names worth keeping: short menu words, not numbers (order numbers), addresses or emails */
export function stepNameOk(name: string): boolean {
  const n = name.trim()
  if (!n || n.length > 30) return false
  if (/[@/\\]/.test(n)) return false
  const digits = n.replace(/\D/g, '').length
  return digits <= 4 && digits * 2 <= n.length
}

/**
 * A typing step (ADR 0044 follow-up): typing into a named field, and pressing Enter after it when submit. What was
 * typed is never kept: the walk takes this time's value (browser_route inputs), so a search route works for any word
 */
export const TYPE_MARK = '✎'
const SUBMIT_MARK = '⏎'
export function typedStep(field: string, submit: boolean): string {
  return `${TYPE_MARK}${submit ? SUBMIT_MARK : ''}${field.trim()}`
}
export type RouteStep = { kind: 'click'; name: string } | { kind: 'type'; field: string; submit: boolean }
export function readStep(s: string): RouteStep {
  if (!s.startsWith(TYPE_MARK)) return { kind: 'click', name: s }
  const rest = s.slice(TYPE_MARK.length)
  const submit = rest.startsWith(SUBMIT_MARK)
  return { kind: 'type', field: submit ? rest.slice(SUBMIT_MARK.length) : rest, submit }
}
/** Fields a route types into, in order (each takes one browser_route input) */
export function routeFields(r: { steps: string[] }): string[] {
  return r.steps.flatMap((s) => {
    const x = readStep(s)
    return x.kind === 'type' ? [x.field] : []
  })
}
const stepOk = (s: string) => {
  const x = readStep(s)
  return stepNameOk(x.kind === 'type' ? x.field : x.name)
}

/** Origin + path of an address (undefined if it is not http(s)) */
export function routeStart(url: string): string | undefined {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    // An address with a member or order number or an email in its path is personal, not a place on the site
    if (/\d{5,}|@|%40/.test(u.pathname)) return undefined
    return `${u.origin}${u.pathname}`
  } catch {
    return undefined
  }
}

export class RouteBook {
  private routes: Route[] = []
  private seq = 0

  constructor(
    private readonly file?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { routes?: Route[] }
      this.routes = Array.isArray(raw.routes) ? raw.routes : []
    } catch {}
    for (const r of this.routes) this.seq = Math.max(this.seq, Number(r.id.slice(1)) || 0)
  }

  forHost(host: string): Route[] {
    return this.routes
      .filter((r) => r.host === host)
      .sort((a, b) => b.uses - a.uses || b.lastAt.localeCompare(a.lastAt))
  }

  get(id: string): Route | undefined {
    return this.routes.find((r) => r.id === id)
  }

  /**
   * Keeps a route. The same start and clicks are one route (its title and time are refreshed, and a walk by hand is
   * counted). byHand is false for the clicks of a browser_route walk, which counts itself. Returns the id
   */
  record(r: { start: string; steps: string[]; title: string }, byHand = true): string | undefined {
    const start = routeStart(r.start)
    if (!start || r.steps.length < MIN_STEPS || r.steps.length > MAX_STEPS) return undefined
    if (!r.steps.every(stepOk)) return undefined
    // Typing alone is not a route (a search URL does that); it needs at least one click by name
    if (!r.steps.some((s) => readStep(s).kind === 'click')) return undefined
    const host = new URL(start).host
    const at = this.now().toISOString()
    const key = (x: { start: string; steps: string[] }) => `${x.start}\n${x.steps.join('\n')}`
    const same = this.routes.find((x) => key(x) === key({ start, steps: r.steps }))
    if (same) {
      same.title = r.title.slice(0, 80)
      if (byHand) same.seen = (same.seen ?? 1) + 1
      same.lastAt = at
      this.save()
      return same.id
    }
    const route: Route = {
      id: `r${++this.seq}`,
      host,
      start,
      steps: [...r.steps],
      title: r.title.slice(0, 80),
      uses: 0,
      seen: byHand ? 1 : 0,
      lastAt: at,
    }
    this.routes.push(route)
    const mine = this.forHost(host)
    if (mine.length > ROUTES_PER_HOST) {
      const drop = new Set(
        [...mine]
          .sort((a, b) => a.lastAt.localeCompare(b.lastAt))
          .slice(0, mine.length - ROUTES_PER_HOST)
          .map((x) => x.id),
      )
      this.routes = this.routes.filter((x) => !drop.has(x.id))
    }
    this.save()
    return route.id
  }

  used(id: string) {
    const r = this.get(id)
    if (!r) return
    r.uses++
    r.lastAt = this.now().toISOString()
    this.save()
  }

  /** A walk with browser_route that stopped on the way (the route is kept: the link was still there) */
  failed(id: string) {
    const r = this.get(id)
    if (!r) return
    r.fails = (r.fails ?? 0) + 1
    r.lastAt = this.now().toISOString()
    this.save()
  }

  /** A route that no longer works (a step was not on the page) */
  forget(id: string) {
    this.routes = this.routes.filter((r) => r.id !== id)
    this.save()
  }

  /** Lines added to a page read on that site */
  hint(host: string): string | undefined {
    const list = this.forHost(host)
    if (!list.length) return undefined
    return [
      'Routes Dool2 took on this site before (browser_route goes there without asking you at each click):',
      ...list.map((r) => {
        const fields = routeFields(r)
        const walk = r.steps
          .map((s) => {
            const x = readStep(s)
            return x.kind === 'click' ? `'${x.name}'` : `type in '${x.field}'${x.submit ? ' + Enter' : ''}`
          })
          .join(' → ')
        const needs = fields.length ? ` (inputs: ${fields.map((f) => `'${f}'`).join(', ')})` : ''
        return `- [${r.id}] ${r.title || '(no title)'}: ${walk}${needs}`
      }),
    ].join('\n')
  }

  private save() {
    if (!this.file) return
    try {
      writeFileSync(this.file, JSON.stringify({ routes: this.routes }, null, 1))
    } catch {}
  }
}
