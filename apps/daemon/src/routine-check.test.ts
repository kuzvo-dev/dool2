import type { Routine } from '@dool2/protocol'
import { describe, expect, it } from 'vitest'
import { printOf, runQuickCheck } from './routine-check.js'

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  title: 'Cancelled tickets',
  prompt: 'Tell me when a ticket shows up',
  enabled: true,
  createdAt: '2026-11-24T00:00:00.000Z',
  check: { tool: 'shop_search', input: { date: '2026-12-01' } },
  ...over,
})

function setup(results: { structuredContent?: unknown; text?: string; isError?: boolean }[]) {
  let print: string | undefined
  let text: string | undefined
  let fails = 0
  const woke: string[] = []
  let i = 0
  const deps = {
    call: async () => {
      const r = results[i++] ?? results.at(-1)!
      return {
        ...(r.isError ? { isError: true } : {}),
        ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
        content: [{ type: 'text', text: r.text ?? '' }],
      }
    },
    noteCheck: (_id: string, p: string, t: string) => {
      const first = print === undefined
      const out = {
        first,
        changed: !first && p !== print,
        ...(text !== undefined ? { before: text } : {}),
        now: t,
      }
      print = p
      text = t
      fails = 0
      return out
    },
    noteCheckFail: () => ++fails,
    wake: async (_r: Routine, note: string) => {
      woke.push(note)
    },
  }
  return { deps, woke }
}

describe('runQuickCheck', () => {
  it('takes the first result as the baseline and wakes Dool2 only when the result changes', async () => {
    const { deps, woke } = setup([
      { structuredContent: { list: [] }, text: 'No seats' },
      { structuredContent: { list: [] }, text: 'No seats (result from 2 min ago)' },
      { structuredContent: { list: [{ time: '19:00' }] }, text: '1 seat at 19:00' },
    ])
    expect(await runQuickCheck(routine(), deps)).toBe('baseline')
    // only the wording changed: not a change
    expect(await runQuickCheck(routine(), deps)).toBe('same')
    expect(await runQuickCheck(routine(), deps)).toBe('changed')
    expect(woke).toHaveLength(1)
    expect(woke[0]).toContain('Before: No seats')
    expect(woke[0]).toContain('Now: 1 seat at 19:00')
  })

  it('tells Dool2 after 3 failures in a row, not before', async () => {
    const { deps, woke } = setup([{ isError: true, text: 'The page did not load' }])
    for (let n = 0; n < 2; n++) expect(await runQuickCheck(routine(), deps)).toBe('failed')
    expect(woke).toHaveLength(0)
    expect(await runQuickCheck(routine(), deps)).toBe('failed')
    expect(woke).toHaveLength(1)
    expect(woke[0]).toContain('failed 3 times in a row: The page did not load')
  })

  it('does nothing for a task without a quick check', async () => {
    const { deps, woke } = setup([{ text: 'x' }])
    expect(await runQuickCheck(routine({ check: undefined }), deps)).toBe('busy')
    expect(woke).toHaveLength(0)
  })

  it('uses the structured result regardless of key order, else the first text', () => {
    expect(printOf({ structuredContent: { a: 1, b: [1, 2] } })).toBe(
      printOf({ structuredContent: { b: [1, 2], a: 1 } }),
    )
    expect(printOf({ content: [{ type: 'text', text: 'x' }] })).not.toBe(
      printOf({ content: [{ type: 'text', text: 'y' }] }),
    )
  })
})
