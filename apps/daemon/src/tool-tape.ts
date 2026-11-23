// Tool tape for scenario tests (evals layer 2): records what each tool answered during a test run, and later plays
// those answers back instead of running the tools. With the tool answers fixed, a rerun shows only how the AI's
// judgment changed (after a persona, tool description or harness change), without real sites, logins or the
// browser, and without the noise of a site answering differently today.
//
// - Only on a test PC (DOOL2_DEV_RESET=1). The eval runner turns it on per scenario and off at the end; a tape left on
//   turns itself off after 30 minutes, so a stopped runner cannot leave the PC replaying.
// - Recording keeps the tool, its input, the result the AI got, and the approval requests the call created
//   (label, what, amount, kind), so a replay that reaches the same approval step counts as reaching approval.
// - Replay matches in two tiers: the exact same tool and input first (each recorded answer used once, then reused
//   if called again), then the same tool and input where only the search words (query, keyword …) differ (the AI
//   worded a search a bit differently). Refs, ids, addresses and button text must match exactly. Anything else is not on the tape: the AI gets "not recorded" and the call is listed
//   as missed, so the report shows where this run left the recorded path.
// - While replaying nothing runs: no browser, no files, no messages, no approvals are created.
import type { ApprovalView } from '@dool2/protocol'

export interface TapeApproval {
  label: string
  what?: string
  amount?: string
  kind: ApprovalView['kind']
}

export interface TapeEntry {
  /** Tool address part, e.g. "browser/click", "life/goal_create" */
  tool: string
  input: unknown
  /** The result exactly as the AI got it */
  result: unknown
  /** Approval requests this call created */
  approvals?: TapeApproval[]
}

export interface TapeReplayed {
  tool: string
  input: unknown
  /** exact = same input; loose = same tool and fields, different text */
  match: 'exact' | 'loose'
  approvals?: TapeApproval[]
}

export interface TapeReport {
  mode: TapeMode
  /** What was recorded (record mode) */
  entries: TapeEntry[]
  /** Calls answered from the tape (replay mode) */
  replayed: TapeReplayed[]
  /** Calls that were not on the tape (replay mode) */
  missed: { tool: string; input: unknown }[]
}

export type TapeMode = 'off' | 'record' | 'replay'

/** A tape left on (the runner stopped halfway) turns itself off after this long */
export const TAPE_MAX_MS = 30 * 60_000

export class ToolTape {
  private mode: TapeMode = 'off'
  private until = 0
  private entries: TapeEntry[] = []
  private used = new Set<number>()
  private replayed: TapeReplayed[] = []
  private missed: { tool: string; input: unknown }[] = []

  constructor(private readonly now: () => number = Date.now) {}

  get current(): TapeMode {
    if (this.mode !== 'off' && this.now() > this.until) this.stop()
    return this.mode
  }

  /** Starts recording (no entries) or replaying (the entries recorded before). Clears what was there */
  start(mode: Exclude<TapeMode, 'off'>, entries: TapeEntry[] = []) {
    this.mode = mode
    this.until = this.now() + TAPE_MAX_MS
    this.entries = mode === 'replay' ? entries.filter(isEntry) : []
    this.used.clear()
    this.replayed = []
    this.missed = []
  }

  /** Stops and returns what happened */
  stop(): TapeReport {
    const report: TapeReport = {
      mode: this.mode,
      entries: this.mode === 'record' ? this.entries : [],
      replayed: this.replayed,
      missed: this.missed,
    }
    this.mode = 'off'
    this.entries = []
    this.used.clear()
    this.replayed = []
    this.missed = []
    return report
  }

  /** Record mode: keeps one call */
  record(entry: TapeEntry) {
    if (this.mode !== 'record') return
    const { approvals, ...rest } = entry
    this.entries.push(approvals?.length ? { ...rest, approvals } : rest)
  }

  /** Replay mode: the recorded answer for this call, or a "not recorded" result */
  replay(tool: string, input: unknown): unknown {
    const i = this.find(tool, input)
    if (i === undefined) {
      this.missed.push({ tool, input })
      return notRecorded(tool)
    }
    const e = this.entries[i] as TapeEntry
    this.used.add(i)
    this.replayed.push({
      tool,
      input,
      match: same(e.input, input) ? 'exact' : 'loose',
      ...(e.approvals?.length ? { approvals: e.approvals } : {}),
    })
    return e.result
  }

  private find(tool: string, input: unknown): number | undefined {
    const tiers: ((e: TapeEntry) => boolean)[] = [
      (e) => e.tool === tool && same(e.input, input),
      (e) => e.tool === tool && sameShape(e.input, input),
    ]
    for (const fits of tiers) {
      // an answer not used yet first, in recorded order; then one already used (the AI asked again)
      let reuse: number | undefined
      for (let i = 0; i < this.entries.length; i++) {
        const e = this.entries[i] as TapeEntry
        if (!fits(e)) continue
        if (!this.used.has(i)) return i
        reuse ??= i
      }
      if (reuse !== undefined) return reuse
    }
    return undefined
  }
}

/** What the AI gets for a call that is not on the tape */
export function notRecorded(tool: string) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `(Replay test) This call (${tool} with this input) was not recorded, so there is no answer for it. Continue with what you have or take another route, as you would when a tool fails.`,
      },
    ],
  }
}

function isEntry(e: unknown): e is TapeEntry {
  return Boolean(e && typeof e === 'object' && typeof (e as TapeEntry).tool === 'string')
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

/** Fields where the AI phrases its own search words: these may differ in a loose match */
const SEARCH_FIELD = /^(q|query|keywords?|search|term|words)$/i

/** Same fields and same values, except search words (query, keyword …) may be worded differently */
function sameShape(a: unknown, b: unknown, key = ''): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a === b || SEARCH_FIELD.test(key)
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameShape(x, b[i]))
    )
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = (o: object) =>
      Object.keys(o)
        .filter((k) => (o as Record<string, unknown>)[k] !== undefined)
        .sort()
    const ka = keys(a)
    const kb = keys(b)
    return (
      ka.length === kb.length &&
      ka.every(
        (k, i) =>
          k === kb[i] && sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], k),
      )
    )
  }
  return same(a, b)
}

function canonical(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x)).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
