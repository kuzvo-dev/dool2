// Usage stats (only when the user agrees, numbers only). To see whether the beta is used well, daily numbers go to dool2.com/api/stats.
// What is sent: a random device number (made on this PC, not linked to a name or account), the date, app version and operating system,
// that day's number of requests, answers, tool successes/failures and pre-finish check results, whether an AI and the extension are connected, and the number of connected services,
// and how long answers took (median and slowest 10% of a whole answer, median time to the first word), tool calls per day and remembered routes taken.
// Conversation content, sites, file names and service names are never sent. While on, today's numbers are re-sent every hour (the same day is overwritten)
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JournalEntry } from './journal.js'

export const STATS_URL = 'https://dool2.com/api/stats'

export interface DayStats {
  iid: string
  day: string
  version: string
  platform: string
  arch: string
  turns: number
  answered: number
  toolsOk: number
  toolsFail: number
  finishDone: number
  finishAgain: number
  /** Whole answer, median and slowest 10% (ms). 0 = no answer that day */
  turnMsP50: number
  turnMsP90: number
  /** Time to the first word or tool (ms, median). 0 = not measured (before 0.4.4) */
  firstMsP50: number
  /** Tool calls in the day's answers, and how many were remembered routes (ADR 0034) */
  toolCalls: number
  routes: number
  agents: string[]
  extension: boolean
  connections: number
}

/** Date on this PC (YYYY-MM-DD, local time) */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Nearest-rank percentile of whole milliseconds (0 when empty) */
function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0)
}

/** Counts only numbers from that day's log */
export function countDay(entries: JournalEntry[], day: string) {
  const c = { turns: 0, answered: 0, toolsOk: 0, toolsFail: 0, finishDone: 0, finishAgain: 0 }
  // Answers the person waited for (not feed posts written in the background)
  const turnMs: number[] = []
  const firstMs: number[] = []
  let toolCalls = 0
  let routes = 0
  for (const e of entries) {
    if (localDay(new Date(e.at)) !== day) continue
    if (e.kind === 'turn') {
      c.turns++
      if (e.answered === true) c.answered++
      if (e.answered === true && e.where !== 'feed') {
        if (typeof e.ms === 'number') turnMs.push(e.ms)
        if (typeof e.firstMs === 'number') firstMs.push(e.firstMs)
        const tools = Array.isArray(e.tools) ? (e.tools as unknown[]) : []
        toolCalls += tools.length
        routes += tools.filter((t) => t === 'browser_route').length
      }
    } else if (e.kind === 'tool' || e.kind === 'file-tool') {
      if (e.ok === false) c.toolsFail++
      else if (e.ok === true) c.toolsOk++
    } else if (e.kind === 'finish-check') {
      if (e.result === 'done') c.finishDone++
      else if (e.result === 'again') c.finishAgain++
    }
  }
  return {
    ...c,
    turnMsP50: percentile(turnMs, 50),
    turnMsP90: percentile(turnMs, 90),
    firstMsP50: percentile(firstMs, 50),
    toolCalls,
    routes,
  }
}

export interface StatsDeps {
  /** Folder for the device number and the last day sent (the data folder) */
  dir: string
  /** Whether the user agreed (setting usageStats === true) */
  enabled: () => boolean
  version: string
  entries: () => JournalEntry[]
  /** Current state (logged-in AI ids, extension connection, number of connected services) */
  status: () => Promise<{ agents: string[]; extension: boolean; connections: number }>
  fetch?: typeof fetch
  now?: () => Date
  url?: string
}

export class StatsReporter {
  private timer?: NodeJS.Timeout
  constructor(private readonly d: StatsDeps) {}

  private async state(): Promise<{ iid: string; sent?: string }> {
    const file = join(this.d.dir, 'stats.json')
    if (existsSync(file)) {
      try {
        const s = JSON.parse(await readFile(file, 'utf8')) as { iid?: string; sent?: string }
        if (s.iid) return { iid: s.iid, ...(s.sent ? { sent: s.sent } : {}) }
      } catch {}
    }
    const s = { iid: randomUUID() }
    await writeFile(file, JSON.stringify(s), { mode: 0o600 })
    return s
  }

  private async save(s: { iid: string; sent?: string }) {
    await writeFile(join(this.d.dir, 'stats.json'), JSON.stringify(s), { mode: 0o600 }).catch(() => undefined)
  }

  /** The numbers to send (also used by the consent screen's 'What is sent?' view) */
  async build(day: string, iid = 'example'): Promise<DayStats> {
    const st = await this.d.status().catch(() => ({ agents: [], extension: false, connections: 0 }))
    return {
      iid,
      day,
      version: this.d.version,
      platform: process.platform,
      arch: process.arch,
      ...countDay(this.d.entries(), day),
      agents: st.agents,
      extension: st.extension,
      connections: st.connections,
    }
  }

  /** Sends today's numbers. If the day changed, yesterday's once more as the last (days it was off are filled from the log) */
  async tick(): Promise<number> {
    if (!this.d.enabled()) return 0
    const now = (this.d.now ?? (() => new Date()))()
    const today = localDay(now)
    const s = await this.state()
    const days = [today]
    if (s.sent && s.sent !== today) days.unshift(s.sent)
    let sent = 0
    for (const day of days) {
      const body = await this.build(day, s.iid)
      const r = await (this.d.fetch ?? fetch)(this.d.url ?? STATS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined)
      if (r?.ok) sent++
    }
    if (sent) await this.save({ iid: s.iid, sent: today })
    return sent
  }

  start() {
    const run = () => void this.tick().catch(() => undefined)
    setTimeout(run, 60_000).unref?.()
    this.timer = setInterval(run, 60 * 60_000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }
}
