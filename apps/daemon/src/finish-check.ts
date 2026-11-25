import type { Lang } from '@dool2/i18n'
import { FINISH_CHECK_MARK } from '@dool2/protocol/rich'
import { FINISH_CHECK_TEXT } from './locales/finish-check.js'
import { CLAIM_KR, DENIAL_KR, DONE_PAGE_KR } from './region/kr/finish-claims.js'

/**
 * Check before finishing (ADR 0027): when Dool's turn of tool work ends, a separately called AI judges
 * "is it done against the request, and is what is left really the person's part?". If not done, it sends the work back into the same conversation.
 * The number of rounds varies per job: 2 by default, up to 4 if new tools were used (progress); it stops when blocked twice for the same reason or after 10 minutes.
 */

/**
 * Whether the daemon asks a judge by default (chats with the user; never feed posts or scheduled tasks). Off
 * 2026-11-24 to 11-25 because answers vanished and started over on screen; on again with the draft design: the screens
 * keep the answer as a draft in the progress card until the verdict, so no answer the person saw is taken back
 */
export const FINISH_CHECK_ON = true

/** Why work was sent back, as a fixed list so the reasons can be counted per week (scripts/finish-reasons.mjs) */
export const SEND_BACK_KINDS = [
  /** Asked the person for something Dool2 could still find or estimate */
  'asked-user',
  /** Told the person to call, use an app or check it themselves while a way was left */
  'handed-off',
  /** Said something was done (sent, booked) without the action or without checking the result */
  'unverified',
  /** Part of the request is missing (fewer places compared, a step not done) */
  'missing-part',
  /** Stopped at a blocker (sign-in, a window, an error) without trying another way */
  'blocked',
  'other',
] as const
export type SendBackKind = (typeof SEND_BACK_KINDS)[number]

export interface Verdict {
  done: boolean
  why: string
  next?: string
  /** Only when not done */
  kind?: SendBackKind
}

/** What the daemon saw during the request, given to the judge as evidence and used by the code check */
export interface Evidence {
  /** Approval requests created since the request began (also auto-approved ones) */
  approvals: number
  /** The last page Dool2 read, and whether any page read since the request began showed a finished action */
  lastPage?: { title: string; url: string }
  donePage?: boolean
}

/** One turn as the check sees it */
export interface TurnFacts {
  answer: string
  /** Tool names used this turn */
  tools: string[]
  /** Calls that only looked something up (lookup-tier service tools, Dool2's read-only tools, not the browser) */
  lookups?: number
  /** Tool calls that failed this turn */
  failures?: number
}

export interface FinishCheckOptions {
  /**
   * Sends the judging text and gets the answer (a new session without tools). undefined on failure.
   * signal: aborted when the user stops the request while it is being judged
   */
  ask: (prompt: string, signal: AbortSignal, threadId: string) => Promise<string | undefined>
  now?: () => number
  /** Rounds to send back when there is no progress */
  baseCycles?: number
  /** Maximum rounds when there is progress */
  maxCycles?: number
  /** After this much time since the request, stop sending it back */
  maxMs?: number
  /** Language of the note people see (default: Korean) */
  lang?: () => Lang
  /** What the daemon knows since a time (approvals, pages read). Without it the judge gets no evidence */
  evidence?: (since: number) => Evidence
}

interface AskState {
  gen: number
  ask: string
  started: number
  /** Rounds sent back so far */
  cycles: number
  /** Tools used so far */
  tools: Set<string>
  /** Tool calls so far, and how many of them were lookups (a request of one or two lookups is not judged) */
  calls: number
  lookups: number
  whys: string[]
  /** A task's done-when conditions (ADR 0038) */
  doneWhen?: string[]
}

/** source: the judge AI, or the code check that caught a claimed action with nothing behind it */
export type CheckResult =
  | { kind: 'skip'; reason: string }
  | { kind: 'done'; why: string; cycles: number; ms: number }
  | {
      kind: 'stop'
      why: string
      next?: string
      cycles: number
      reason: string
      because?: SendBackKind
      source: 'judge' | 'code'
      ms: number
    }
  | {
      kind: 'again'
      why: string
      next?: string
      cycles: number
      note: string
      because: SendBackKind
      source: 'judge' | 'code'
      ms: number
    }

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
  'Facts from the daemon (approval requests, the last page read, tool failures) are records, not claims: trust them over the answer.',
  'The person sees "why" and "next" while Dool keeps working: write them in the language of the user request, in plain everyday words, without tool names. "next" says what Dool will do now, like "compare 2 more insurers".',
  `If not done, "kind" is one of: ${SEND_BACK_KINDS.join(', ')}.`,
  'Answer with one line of JSON only: {"done": true|false, "why": "one sentence on what is left or why it is done", "next": "if not done, what Dool does next", "kind": "if not done"}',
].join('\n')

export function judgePrompt(i: {
  ask: string
  /** A task's done-when conditions (ADR 0038): the yardstick instead of the request alone */
  doneWhen?: string[]
  answer: string
  tools: string[]
  cycle: number
  evidence?: Evidence
  failures?: number
}): string {
  const tools = [...new Set(i.tools)].slice(0, 30).join(', ') || '(none)'
  const e = i.evidence
  const facts = [
    e ? `Approval requests during this request: ${e.approvals || 'none'}` : '',
    e?.lastPage
      ? `Last page read: ${e.lastPage.title.slice(0, 120) || '(no title)'} — ${e.lastPage.url.slice(0, 200)}`
      : '',
    e?.donePage ? 'A page read during this request showed a finished action.' : '',
    i.failures ? `Tool calls that failed this turn: ${i.failures}` : '',
  ].filter(Boolean)
  return [
    `User request:\n${i.ask.slice(0, 1500)}`,
    i.doneWhen?.length
      ? `Done when (the conditions this task was given; it is done only when each holds, or what is left of it is the person's part):\n${i.doneWhen
          .slice(0, 6)
          .map((c) => `- ${c.slice(0, 200)}`)
          .join('\n')}`
      : '',
    `Tools Dool has used so far: ${tools}`,
    facts.length ? `Facts from the daemon:\n${facts.map((f) => `- ${f}`).join('\n')}` : '',
    i.cycle > 0
      ? `(Already sent back ${i.cycle} time(s). Answer false only if there is really more to try)`
      : '',
    `Dool's last answer:\n${i.answer.slice(0, 3000)}`,
    "Is this request fully done, including Dool's part? Answer with one line of JSON only.",
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Claims of a finished outside action in English answers */
const CLAIM_EN =
  /\b(?:I|I've|I have|we've|we have)\s+(?:just\s+|now\s+|already\s+)?(?:booked|reserved|applied|sent|ordered|paid|purchased|bought|submitted|placed|cancell?ed|registered|transferred)\b|\b(?:has|have)\s+been\s+(?:booked|reserved|sent|ordered|paid|submitted|placed|cancell?ed|transferred)\b|\b(?:booking|reservation|order|payment|application)\s+(?:is\s+)?(?:complete|confirmed|placed|done)\b/i
const DONE_PAGE_EN =
  /\b(?:order|booking|reservation|payment|application|purchase)\s+(?:is\s+)?(?:complete|completed|confirmed|successful|received|placed)\b|\bthank you for your (?:order|booking|purchase)\b/i

/**
 * Whether the answer says Dool2 finished an action outside (booked, applied, sent, ordered, paid). Denials ("could not
 * send", "did not book") do not count. Korean and English (the two languages of the product today)
 */
export function claimsDone(answer: string): boolean {
  if (CLAIM_EN.test(answer)) return true
  const re = new RegExp(CLAIM_KR.source, 'g')
  for (const m of answer.matchAll(re)) {
    const before = answer.slice(Math.max(0, m.index - 4), m.index)
    if (!DENIAL_KR.test(before)) return true
  }
  return false
}

/** Whether a page (title, address or text) shows a finished action */
export function donePage(page: { title?: string; url?: string; text?: string }): boolean {
  const t = `${page.title ?? ''}\n${page.text?.slice(0, 4000) ?? ''}`
  return (
    DONE_PAGE_KR.test(t) ||
    DONE_PAGE_EN.test(t) ||
    /\/(?:order|booking|reservation|payment|checkout)[\w/-]*(?:complete|done|success|finish)/i.test(
      page.url ?? '',
    )
  )
}

export function parseVerdict(text: string | undefined): Verdict | undefined {
  const m = text?.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try {
    const v = JSON.parse(m[0]) as Partial<Verdict>
    if (typeof v.done !== 'boolean') return undefined
    const why = typeof v.why === 'string' ? v.why.trim().slice(0, 200) : ''
    const next = typeof v.next === 'string' && v.next.trim() ? v.next.trim().slice(0, 200) : undefined
    const kind = v.done
      ? undefined
      : SEND_BACK_KINDS.includes(v.kind as SendBackKind)
        ? (v.kind as SendBackKind)
        : 'other'
    return { done: v.done, why, ...(next ? { next } : {}), ...(kind ? { kind } : {}) }
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
  /** Verdicts being asked right now, so stopping can end them at once */
  private readonly judging = new Map<string, AbortController>()
  private gen = 0
  private readonly now: () => number

  constructor(private readonly opts: FinishCheckOptions) {
    this.now = opts.now ?? Date.now
  }

  /**
   * The user made a new request (a message, not an app notification), or a task session began (ADR 0038): then the
   * spec's done-when conditions are what the judge compares the answer with
   */
  begin(threadId: string, ask: string, o: { doneWhen?: string[] } = {}): void {
    this.asks.set(threadId, {
      gen: ++this.gen,
      ask,
      started: this.now(),
      cycles: 0,
      tools: new Set(),
      calls: 0,
      lookups: 0,
      whys: [],
      ...(o.doneWhen?.length ? { doneWhen: o.doneWhen } : {}),
    })
  }

  /** When the request being checked began (to count evidence since then) */
  startedAt(threadId: string): number | undefined {
    return this.asks.get(threadId)?.started
  }

  /** Text of the request being worked on */
  askOf(threadId: string): string | undefined {
    return this.asks.get(threadId)?.ask
  }

  /** The user stopped it: do not continue this request */
  drop(threadId: string): void {
    this.asks.delete(threadId)
    this.judging.get(threadId)?.abort()
    this.judging.delete(threadId)
  }

  /** Rounds the current request was sent back so far */
  rounds(threadId: string): number {
    return this.asks.get(threadId)?.cycles ?? 0
  }

  /** Number of the current request (to see whether a new one arrived while judging) */
  current(threadId: string): number | undefined {
    return this.asks.get(threadId)?.gen
  }

  async check(threadId: string, turn: TurnFacts): Promise<CheckResult> {
    const s = this.asks.get(threadId)
    if (!s) return { kind: 'skip', reason: 'no request' }
    const fresh = turn.tools.filter((t) => !s.tools.has(t))
    for (const t of turn.tools) s.tools.add(t)
    s.calls += turn.tools.length
    s.lookups += turn.lookups ?? 0
    if (!s.tools.size) return { kind: 'skip', reason: 'no tools used' }
    if (!turn.answer.trim()) return { kind: 'skip', reason: 'no answer' }
    const evidence = this.opts.evidence?.(s.started)
    const began = this.now()
    // Code check first, without the AI: an answer that says it booked, sent or paid while nothing in this request
    // asked for approval and no page showed it finished is sent back at once (the most dangerous wrong answer)
    let v: Verdict | undefined
    let source: 'judge' | 'code' = 'judge'
    const finished = evidence?.donePage || s.tools.has('browser_order_done')
    if (evidence && !evidence.approvals && !finished && claimsDone(turn.answer)) {
      const t = FINISH_CHECK_TEXT[this.opts.lang?.() ?? 'ko']
      v = { done: false, why: t.claimWhy, next: t.claimNext, kind: 'unverified' }
      source = 'code'
    }
    // A request that took one or two lookups and nothing else is a simple answer: not judged
    if (!v && s.cycles === 0 && s.calls <= 2 && s.lookups >= s.calls)
      return { kind: 'skip', reason: 'simple' }
    // With progress (a tool not used before) go up to the maximum, otherwise up to the default rounds
    const limit = fresh.length > 0 ? (this.opts.maxCycles ?? 4) : (this.opts.baseCycles ?? 2)
    if (!v) {
      const ac = new AbortController()
      this.judging.set(threadId, ac)
      let said: string | undefined
      try {
        said = await this.opts.ask(
          judgePrompt({
            ask: s.ask,
            ...(s.doneWhen ? { doneWhen: s.doneWhen } : {}),
            answer: turn.answer,
            tools: [...s.tools],
            cycle: s.cycles,
            ...(evidence ? { evidence } : {}),
            ...(turn.failures ? { failures: turn.failures } : {}),
          }),
          ac.signal,
          threadId,
        )
      } finally {
        if (this.judging.get(threadId) === ac) this.judging.delete(threadId)
      }
      // Stopped (or a new request began) while judging: this verdict no longer counts
      if (ac.signal.aborted || this.asks.get(threadId) !== s) return { kind: 'skip', reason: 'stopped' }
      v = parseVerdict(said)
      if (!v) return { kind: 'skip', reason: 'judge failed' }
    }
    const ms = this.now() - began
    if (v.done) {
      this.asks.delete(threadId)
      return { kind: 'done', why: v.why, cycles: s.cycles, ms }
    }
    const because = v.kind ?? 'other'
    const stop = (reason: string): CheckResult => {
      this.asks.delete(threadId)
      return {
        kind: 'stop',
        why: v.why,
        ...(v.next ? { next: v.next } : {}),
        cycles: s.cycles,
        reason,
        because,
        source,
        ms,
      }
    }
    if (s.cycles >= limit) return stop('rounds')
    if (this.now() - s.started > (this.opts.maxMs ?? 10 * 60_000)) return stop('time')
    if (s.whys.some((w) => sameBlocker(w, v.why))) return stop('same blocker')
    s.whys.push(v.why)
    s.cycles++
    return {
      kind: 'again',
      why: v.why,
      ...(v.next ? { next: v.next } : {}),
      cycles: s.cycles,
      note: againNote(v, this.opts.lang?.()),
      because,
      source,
      ms,
    }
  }
}

/** Note sent back (only the first sentence shows on screen, the rest is for the AI only) */
export function againNote(v: Verdict, lang: Lang = 'ko'): string {
  // One part per line: the screen reads "A way to try:" back as the step it shows while Dool2 continues (finishNext)
  return [
    `${FINISH_CHECK_TEXT[lang].again} ${FINISH_CHECK_MARK}`,
    `Something is still left: ${v.why}`,
    v.next ? `A way to try: ${v.next}` : '',
    'Do not repeat the same method; continue another way. If only the user knows it, first look in mail, connected places and memory or estimate it, and ask only if it really is not there, gathering all questions in one message. When done, report once in the order result, what was done, what is left. Your next answer replaces your earlier answer to this request on screen (the earlier one is folded away), so write it as the one complete answer: keep what still matters from before, not only the new part. Reply to the user in their language.',
  ]
    .filter(Boolean)
    .join('\n')
}
