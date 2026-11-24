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
  uses: number
  lastAt: string
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

  /** Keeps a route. The same start and clicks are one route (its title and time are refreshed). Returns the id */
  record(r: { start: string; steps: string[]; title: string }): string | undefined {
    const start = routeStart(r.start)
    if (!start || r.steps.length < MIN_STEPS || r.steps.length > MAX_STEPS) return undefined
    if (!r.steps.every(stepNameOk)) return undefined
    const host = new URL(start).host
    const at = this.now().toISOString()
    const key = (x: { start: string; steps: string[] }) => `${x.start}\n${x.steps.join('\n')}`
    const same = this.routes.find((x) => key(x) === key({ start, steps: r.steps }))
    if (same) {
      same.title = r.title.slice(0, 80)
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
      ...list.map(
        (r) => `- [${r.id}] ${r.title || '(no title)'}: ${r.steps.map((s) => `'${s}'`).join(' → ')}`,
      ),
    ].join('\n')
  }

  private save() {
    if (!this.file) return
    try {
      writeFileSync(this.file, JSON.stringify({ routes: this.routes }, null, 1))
    } catch {}
  }
}
