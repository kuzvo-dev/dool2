// Loop guard: notices when Dool2 calls the same tool with the same input and gets the same result again and again,
// and adds a line to that result telling it to take another route.
//
// Every tool call of every agent (Claude Code, Codex, OpenCode) passes through the daemon's tool address, so this is
// the one place that sees all of them. The agent's own loop cannot be changed (it is the official program), so the
// guard does not stop or block a call: the call still runs, and only its result gets the extra line. What the AI
// does next stays its own judgment.
//
// - Same call = same tool + same input + same text result. A page that changed between two reads is not a repeat.
// - Counted within a time window (default 15 minutes), across turns, so a turn sent back by the finish check
//   (ADR 0027) that repeats the same dead end is caught too.
// - Waiting tools (a person approving on the phone, a page loading) are expected to return the same thing while
//   they wait, so they are not counted.
import { createHash } from 'node:crypto'

export interface LoopGuardOptions {
  /** Window in which identical calls are counted (ms). Default 15 minutes */
  windowMs?: number
  /** From which identical call the note is added. Default 3 (the third) */
  repeat?: number
  now?: () => number
}

interface ToolLikeResult {
  content?: { type: string; text?: string }[]
  isError?: boolean
}

/** Tools that are expected to give the same answer while they wait */
const WAITING = /wait/

export class LoopGuard {
  private seen = new Map<string, number[]>()
  private windowMs: number
  private repeat: number
  private now: () => number

  constructor(opts: LoopGuardOptions = {}) {
    this.windowMs = opts.windowMs ?? 15 * 60_000
    this.repeat = opts.repeat ?? 3
    this.now = opts.now ?? Date.now
  }

  /**
   * Records one tool call and its result. Returns how many times this exact call has now happened within the
   * window when it has reached the repeat threshold, otherwise undefined.
   */
  see(tool: string, args: unknown, result: unknown): number | undefined {
    if (WAITING.test(tool)) return undefined
    const text = resultText(result)
    if (text === undefined) return undefined
    const key = createHash('sha256')
      .update(tool)
      .update('\0')
      .update(stableJson(args))
      .update('\0')
      .update(text)
      .digest('hex')
    const now = this.now()
    this.prune(now)
    const times = (this.seen.get(key) ?? []).concat(now)
    this.seen.set(key, times)
    return times.length >= this.repeat ? times.length : undefined
  }

  /** Adds the loop note to a tool result when this call is a repeat. Returns the result unchanged otherwise. */
  check<T>(tool: string, args: unknown, result: T): { result: T; count?: number } {
    const count = this.see(tool, args, result)
    if (!count) return { result }
    const r = result as ToolLikeResult
    if (!Array.isArray(r.content)) return { result }
    return { result: { ...r, content: [...r.content, { type: 'text', text: loopNote(count) }] } as T, count }
  }

  private prune(now: number) {
    for (const [key, times] of this.seen) {
      const kept = times.filter((t) => now - t < this.windowMs)
      if (kept.length) this.seen.set(key, kept)
      else this.seen.delete(key)
    }
  }
}

/** The line added to a repeated call's result (the AI reads it, so it is English like other tool results) */
export function loopNote(count: number): string {
  return (
    `\n🔁 Loop check: this is the ${ordinal(count)} call of this tool with the same input and the same result in the last few minutes. ` +
    'Calling it again will not change anything. Take another route that does the same job (another tool, another service, ' +
    'different search words, or the browser tools). If every route is blocked, tell the user in one sentence what is blocked ' +
    'and what Dool2 can do instead. If the user asked you to check again, just report this result.'
  )
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${s}`
}

/** Text parts of a tool result; undefined when there is no text to compare (only images, or not a tool result) */
function resultText(result: unknown): string | undefined {
  const content = (result as ToolLikeResult | undefined)?.content
  if (!Array.isArray(content)) return undefined
  const texts = content.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text)
  if (!texts.length) return undefined
  return `${(result as ToolLikeResult).isError ? 'error\0' : ''}${texts.join('\n')}`
}

/** JSON with object keys sorted, so the same input in a different key order counts as the same call */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
