import type { Lang } from '@dool2/i18n'
import { FINISH_CHECK_TEXT } from './locales/finish-check.js'

/**
 * Check before finishing (ADR 0027): when Dool's turn of tool work ends, a separately called AI judges
 * "is it done against the request, and is what is left really the person's part?". If not done, it sends the work back into the same conversation.
 * The number of rounds varies per job: 2 by default, up to 4 if new tools were used (progress); it stops when blocked twice for the same reason or after 20 minutes.
 */

export interface Verdict {
  done: boolean
  why: string
  next?: string
}

export interface FinishCheckOptions {
  /** Sends the judging text and gets the answer (a new session without tools). undefined on failure */
  ask: (prompt: string) => Promise<string | undefined>
  now?: () => number
  /** Rounds to send back when there is no progress */
  baseCycles?: number
  /** Maximum rounds when there is progress */
  maxCycles?: number
  /** After this much time since the request, stop sending it back */
  maxMs?: number
  /** Language of the note people see (default: Korean) */
  lang?: () => Lang
}

interface AskState {
  gen: number
  ask: string
  started: number
  /** Rounds sent back so far */
  cycles: number
  /** Tools used so far */
  tools: Set<string>
  whys: string[]
}

export type CheckResult =
  | { kind: 'skip'; reason: string }
  | { kind: 'done'; why: string; cycles: number }
  | { kind: 'stop'; why: string; cycles: number; reason: string }
  | { kind: 'again'; why: string; next?: string; cycles: number; note: string }

/** Instructions for the judging AI */
export const JUDGE_SYSTEM = [
  'You review the work of a personal assistant AI named "Dool". You have no tools; you only judge.',
  "What Dool can do: look up and operate sites the user is signed in to and services they connected, using the browser on the user's PC; find mail; search the web; find and save memory (user info); find or create accounts; get official documents; make drafts; compare, calculate and estimate.",
  'Only these may be handed to the person: payment approval, identity verification (SMS, certificate, simple auth), approval to send something out (inquiry, application, mail, posting), and facts only the user knows (taste, decisions, passwords for places that are not connected).',
  "Even if something looks like only the user knows it, it is Dool's part if a way remains to find or estimate it from mail, connected services, memory, bills or payment history.",
  'If facts for a request or application going to others (address, date, symptoms) are known only to the user, gathering them, asking, and stopping counts as done. Do not tell it to send with made-up values.',
  'If the answer claims it finished, like "I booked it" or "I applied", but the tool record has no such action (click, approval), it is not done: make it verify that it really happened.',
  'If it ended with "please call", "do it in the app" or "check yourself" while Dool still has a way to try on the web, it is not done.',
  'If something the request asked for is missing (e.g. compare 3 places, up to booking, fill in the application), it is not done. If an approval card is shown and it is waiting, count it as done.',
  'Answer with one line of JSON only: {"done": true|false, "why": "one sentence on what is left or why it is done", "next": "if not done, one sentence on another way Dool can try"}',
].join('\n')

export function judgePrompt(i: { ask: string; answer: string; tools: string[]; cycle: number }): string {
  const tools = [...new Set(i.tools)].slice(0, 30).join(', ') || '(none)'
  return [
    `User request:\n${i.ask.slice(0, 1500)}`,
    `Tools Dool has used so far: ${tools}`,
    i.cycle > 0
      ? `(Already sent back ${i.cycle} time(s). Answer false only if there is really more to try)`
      : '',
    `Dool's last answer:\n${i.answer.slice(0, 3000)}`,
    "Is this request fully done, including Dool's part? Answer with one line of JSON only.",
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function parseVerdict(text: string | undefined): Verdict | undefined {
  const m = text?.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try {
    const v = JSON.parse(m[0]) as Partial<Verdict>
    if (typeof v.done !== 'boolean') return undefined
    const why = typeof v.why === 'string' ? v.why.trim().slice(0, 200) : ''
    const next = typeof v.next === 'string' && v.next.trim() ? v.next.trim().slice(0, 200) : undefined
    return { done: v.done, why, ...(next ? { next } : {}) }
  } catch {
    return undefined
  }
}

/** Whether two reasons are the same blocker (share of overlapping character pairs) */
export function sameBlocker(a: string, b: string): boolean {
  const grams = (s: string) => {
    const t = s.replace(/\s+/g, '')
    const out = new Set<string>()
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
    return out
  }
  const x = grams(a)
  const y = grams(b)
  if (!x.size || !y.size) return false
  let both = 0
  for (const g of x) if (y.has(g)) both++
  return both / Math.min(x.size, y.size) >= 0.6
}

export class FinishCheck {
  private readonly asks = new Map<string, AskState>()
  private gen = 0
  private readonly now: () => number

  constructor(private readonly opts: FinishCheckOptions) {
    this.now = opts.now ?? Date.now
  }

  /** The user made a new request (a message, not an app notification) */
  begin(threadId: string, ask: string): void {
    this.asks.set(threadId, {
      gen: ++this.gen,
      ask,
      started: this.now(),
      cycles: 0,
      tools: new Set(),
      whys: [],
    })
  }

  /** Text of the request being worked on */
  askOf(threadId: string): string | undefined {
    return this.asks.get(threadId)?.ask
  }

  /** The user stopped it: do not continue this request */
  drop(threadId: string): void {
    this.asks.delete(threadId)
  }

  /** Number of the current request (to see whether a new one arrived while judging) */
  current(threadId: string): number | undefined {
    return this.asks.get(threadId)?.gen
  }

  async check(threadId: string, turn: { answer: string; tools: string[] }): Promise<CheckResult> {
    const s = this.asks.get(threadId)
    if (!s) return { kind: 'skip', reason: 'no request' }
    const fresh = turn.tools.filter((t) => !s.tools.has(t))
    for (const t of turn.tools) s.tools.add(t)
    if (!s.tools.size) return { kind: 'skip', reason: 'no tools used' }
    if (!turn.answer.trim()) return { kind: 'skip', reason: 'no answer' }
    // With progress (a tool not used before) go up to the maximum, otherwise up to the default rounds
    const limit = fresh.length > 0 ? (this.opts.maxCycles ?? 4) : (this.opts.baseCycles ?? 2)
    const v = parseVerdict(
      await this.opts.ask(
        judgePrompt({ ask: s.ask, answer: turn.answer, tools: [...s.tools], cycle: s.cycles }),
      ),
    )
    if (!v) return { kind: 'skip', reason: 'judge failed' }
    if (v.done) {
      this.asks.delete(threadId)
      return { kind: 'done', why: v.why, cycles: s.cycles }
    }
    const stop = (reason: string): CheckResult => {
      this.asks.delete(threadId)
      return { kind: 'stop', why: v.why, cycles: s.cycles, reason }
    }
    if (s.cycles >= limit) return stop('rounds')
    if (this.now() - s.started > (this.opts.maxMs ?? 20 * 60_000)) return stop('time')
    if (s.whys.some((w) => sameBlocker(w, v.why))) return stop('same blocker')
    s.whys.push(v.why)
    s.cycles++
    return {
      kind: 'again',
      why: v.why,
      ...(v.next ? { next: v.next } : {}),
      cycles: s.cycles,
      note: againNote(v, this.opts.lang?.()),
    }
  }
}

/** Note sent back (only the first sentence shows on screen, the rest is for the AI only) */
export function againNote(v: Verdict, lang: Lang = 'ko'): string {
  return [
    FINISH_CHECK_TEXT[lang].again,
    `(Check before finishing) Something is still left: ${v.why}`,
    v.next ? `A way to try: ${v.next}` : '',
    'Do not repeat the same method; continue another way. If only the user knows it, first look in mail, connected places and memory or estimate it, and ask only if it really is not there, gathering all questions in one message. When done, report once in the order result, what was done, what is left. Reply to the user in their language.',
  ]
    .filter(Boolean)
    .join(' ')
}
