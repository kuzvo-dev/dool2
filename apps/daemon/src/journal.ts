// Work journal (what to look at when finding a problem): how connecting, service tools, one turn of an answer and the extension link went, kept on this PC for a few days.
//
// - One file per day (<data folder>/logs/2026-11-18.jsonl), one event per line
// - The screen at the moment it stopped is kept as a picture (logs/shots/), for a shorter time than text
// - Deleted after a few days (text 7 days, pictures 3 days). If the total passes the set size, the oldest go first
// - IDs, passwords and verification codes are not written. Emails and long numbers mixed into text are masked too
// - Never leaves this PC (read only through the daemon API)
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { SECRET_KEY_KR } from './region/kr/journal.js'

/** Days to keep text records */
export const KEEP_DAYS = 7
/** Days to keep screen pictures */
export const SHOT_DAYS = 3
/** Size limit for all records */
export const MAX_BYTES = 40 * 1024 * 1024

export interface JournalEntry {
  /** When (ISO) */
  at: string
  /** What happened: connect-start · connect-step · connect-end · tool · turn · extension · note … */
  kind: string
  [field: string]: unknown
}

export interface JournalOptions {
  keepDays?: number
  shotDays?: number
  maxBytes?: number
  now?: () => Date
}

/** Field names whose value must not be written */
const SECRET_KEY = new RegExp(`pass|pw$|^pw|secret|token|otp|credential|${SECRET_KEY_KR}`, 'i')

/** Fields kept as they are (values the daemon made: picture file name, time) */
const PLAIN_KEY = new Set(['shot', 't'])

/** Mask personal info mixed into text: emails keep one leading letter, numbers over 6 digits (phone, codes, cards) become stars */
export function scrubText(text: string, max = 400): string {
  return text
    .replace(/([\w.+-])[\w.+-]*@([\w-]+\.[\w.-]+)/g, '$1***@$2')
    .replace(/\d[\d\s-]{4,}\d/g, (m) => (m.replace(/\D/g, '').length >= 6 ? '***' : m))
    .slice(0, max)
}

/** Cut the part after the question mark in an address (it carries search words and tokens) */
export function scrubUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`.slice(0, 200)
  } catch {
    return ''
  }
}

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return depth > 3 ? [] : value.slice(0, 40).map((v) => scrub(v, depth + 1))
  if (value && typeof value === 'object') {
    if (depth > 3) return {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      // Picture file names and times stay as they are (if number masking hit them, the picture could not be found and the time would be lost)
      out[k] = SECRET_KEY.test(k)
        ? '(hidden)'
        : PLAIN_KEY.has(k) && typeof v === 'string'
          ? v.slice(0, 80)
          : scrub(v, depth + 1)
    }
    return out
  }
  return undefined
}

const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export class Journal {
  private readonly keepDays: number
  private readonly shotDays: number
  private readonly maxBytes: number
  private readonly now: () => Date
  private timer?: ReturnType<typeof setInterval>
  private seq = 0

  /** Without dir nothing is kept (tests, audit mode) */
  constructor(
    private readonly dir?: string,
    opts: JournalOptions = {},
  ) {
    this.keepDays = opts.keepDays ?? KEEP_DAYS
    this.shotDays = opts.shotDays ?? SHOT_DAYS
    this.maxBytes = opts.maxBytes ?? MAX_BYTES
    this.now = opts.now ?? (() => new Date())
    if (!dir) return
    try {
      mkdirSync(join(dir, 'shots'), { recursive: true })
      this.prune()
      // So old records are deleted even if it stays on for days
      this.timer = setInterval(() => this.prune(), 6 * 3600_000)
      this.timer.unref?.()
    } catch {}
  }

  get shotsDir(): string | undefined {
    return this.dir ? join(this.dir, 'shots') : undefined
  }

  /** Write one line. If it cannot be written, the work goes on */
  write(kind: string, fields: Record<string, unknown> = {}) {
    if (!this.dir) return
    const at = this.now()
    const entry = { at: at.toISOString(), kind, ...(scrub(fields) as Record<string, unknown>) }
    try {
      appendFileSync(join(this.dir, `${day(at)}.jsonl`), `${JSON.stringify(entry)}\n`)
    } catch {}
  }

  /** Save a screen picture (JPEG base64). Returns the file name */
  shot(label: string, base64: string): string | undefined {
    if (!this.dir || !base64) return undefined
    const at = this.now()
    const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const name = `${stamp}-${String(++this.seq).padStart(2, '0')}-${label.replace(/[^\w-]/g, '').slice(0, 40) || 'shot'}.jpg`
    try {
      writeFileSync(join(this.dir, 'shots', name), Buffer.from(base64, 'base64'))
      return name
    } catch {
      return undefined
    }
  }

  /** Read recent records (oldest first). With kind, only those that start with it */
  read(o: { days?: number; kind?: string; limit?: number } = {}): JournalEntry[] {
    if (!this.dir) return []
    const days = Math.min(Math.max(o.days ?? 2, 1), this.keepDays)
    const from = day(new Date(this.now().getTime() - (days - 1) * 86_400_000))
    const out: JournalEntry[] = []
    for (const f of this.dayFiles()) {
      if (f.slice(0, 10) < from) continue
      let raw = ''
      try {
        raw = readFileSync(join(this.dir, f), 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        if (!line) continue
        try {
          const e = JSON.parse(line) as JournalEntry
          if (!o.kind || e.kind.startsWith(o.kind)) out.push(e)
        } catch {}
      }
    }
    return o.limit ? out.slice(-o.limit) : out
  }

  /** Delete records and pictures past their days, and if still too big, delete older ones */
  prune() {
    if (!this.dir) return
    const now = this.now().getTime()
    const oldest = day(new Date(now - (this.keepDays - 1) * 86_400_000))
    try {
      for (const f of this.dayFiles()) if (f.slice(0, 10) < oldest) rmSync(join(this.dir, f), { force: true })
      const shots = this.shotFiles()
      for (const s of shots) if (now - s.mtime > this.shotDays * 86_400_000) rmSync(s.path, { force: true })
      // Size limit: pictures first, then the oldest days
      const left = [
        ...this.shotFiles(),
        ...this.dayFiles()
          .slice(0, -1)
          .map((f) => {
            const path = join(this.dir as string, f)
            const st = statSync(path)
            return { path, size: st.size, mtime: st.mtimeMs }
          }),
      ]
      let total =
        left.reduce((n, f) => n + f.size, 0) +
        (this.dayFiles()
          .slice(-1)
          .map((f) => statSync(join(this.dir as string, f)).size)[0] ?? 0)
      for (const f of left) {
        if (total <= this.maxBytes) break
        rmSync(f.path, { force: true })
        total -= f.size
      }
    } catch {}
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private dayFiles(): string[] {
    if (!this.dir || !existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
  }

  private shotFiles(): { path: string; size: number; mtime: number }[] {
    const dir = this.shotsDir
    if (!dir || !existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .map((f) => {
        const path = join(dir, f)
        const st = statSync(path)
        return { path, size: st.size, mtime: st.mtimeMs }
      })
  }
}
