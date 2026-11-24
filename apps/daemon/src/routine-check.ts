// Quick checks for watches (ADR 0031). A watch like "tell me when a cancelled ticket shows up" names a lookup
// service tool and its input. At each set time the daemon runs that tool by itself, without the AI, and compares the
// result with the last one. Dool2 (the AI) is woken only when it changed, so checking every minute costs no AI turn,
// does not block the conversation, and does not use subscription quota.
//
// - The first result is only the baseline (what exists when the watch is made was already shown by the AI then).
// - A change is judged on the tool's structured result (the rows it returns), not on its wording, so notes such as
//   "this is from 3 minutes ago" do not count as a change.
// - If the check fails 3 times in a row (site changed, signed out), Dool2 is woken once to look the usual way.
import { createHash } from 'node:crypto'
import type { Routine } from '@dool2/protocol'

interface ToolLikeResult {
  content?: { type: string; text?: string }[]
  structuredContent?: unknown
  isError?: boolean
}

export type CheckOutcome = 'baseline' | 'same' | 'changed' | 'failed' | 'busy'

/** Failures in a row after which Dool2 is told (then again every this many) */
export const CHECK_FAILS_TELL = 3

export interface QuickCheckDeps {
  /** Runs a service tool (connectors.call) */
  call: (tool: string, input: Record<string, unknown>) => Promise<ToolLikeResult>
  noteCheck: (
    id: string,
    print: string,
    text: string,
  ) => { first: boolean; changed: boolean; before?: string; now: string } | undefined
  noteCheckFail: (id: string) => number
  /** Wakes Dool2 for this watch with a note on what the quick check found */
  wake: (r: Routine, note: string) => Promise<void>
  log?: (entry: Record<string, unknown>) => void
}

const running = new Set<string>()

export async function runQuickCheck(r: Routine, deps: QuickCheckDeps): Promise<CheckOutcome> {
  if (!r.check) return 'busy'
  // A slow site can take longer than the interval: skip until the last check is done
  if (running.has(r.id)) return 'busy'
  running.add(r.id)
  try {
    const result = await deps
      .call(r.check.tool, r.check.input)
      .catch((e: Error): ToolLikeResult => ({ isError: true, content: [{ type: 'text', text: e.message }] }))
    if (result.isError) {
      const n = deps.noteCheckFail(r.id)
      deps.log?.({ id: r.id, tool: r.check.tool, outcome: 'failed', fails: n })
      if (n % CHECK_FAILS_TELL === 0)
        await deps.wake(
          r,
          `The quick check (${r.check.tool}) has failed ${n} times in a row: ${firstText(result).slice(0, 300)}. Look the usual way this time (browser tools or another service). If it keeps failing, tell the user in one line what is blocked.`,
        )
      return 'failed'
    }
    const seen = deps.noteCheck(r.id, printOf(result), firstText(result))
    if (!seen) return 'busy'
    const outcome: CheckOutcome = seen.first ? 'baseline' : seen.changed ? 'changed' : 'same'
    deps.log?.({ id: r.id, tool: r.check.tool, outcome })
    if (outcome === 'changed')
      await deps.wake(
        r,
        [
          `The quick check (${r.check.tool}) found a change.`,
          `Before: ${seen.before ?? '(none)'}`,
          `Now: ${seen.now}`,
          'Judge from this whether the condition the user asked for is met now (look again with the tool if needed). Notify only when it is.',
        ].join('\n'),
      )
    return outcome
  } finally {
    running.delete(r.id)
  }
}

/** What counts for "changed": the structured result if there is one, else the first text block */
export function printOf(result: ToolLikeResult): string {
  const basis =
    result.structuredContent !== undefined ? stableJson(result.structuredContent) : firstText(result)
  return createHash('sha256').update(basis).digest('hex')
}

function firstText(result: ToolLikeResult): string {
  return result.content?.find((x) => x.type === 'text' && typeof x.text === 'string')?.text ?? ''
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
