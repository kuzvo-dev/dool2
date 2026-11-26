import { describe, expect, it } from 'vitest'
import { aggregateHarness, dist, kindOf, renderHarness, targetRows } from './harness-report.js'
import type { JournalEntry } from './journal.js'

const at = (m: number) => new Date(Date.UTC(2026, 10, 25, 0, m)).toISOString()
const e = (kind: string, fields: Record<string, unknown> = {}, m = 0): JournalEntry => ({
  at: at(m),
  kind,
  ...fields,
})

describe('harness report', () => {
  it('reads the kind of session from the log, or where the turn ran in older lines', () => {
    expect(kindOf(e('turn', { where: 'main', session: 'conversation' }))).toBe('conversation')
    expect(kindOf(e('turn', { where: 'side', task: 't1' }))).toBe('task')
    expect(kindOf(e('turn', { where: 'feed' }))).toBe('feed')
    expect(kindOf(e('turn'))).toBe('unknown')
  })

  it('percentiles by nearest rank', () => {
    expect(dist([])).toEqual({ n: 0 })
    expect(dist([5, 1, 3, 2, 4])).toEqual({ n: 5, p50: 3, p95: 5, max: 5 })
  })

  it('aggregates turns, results, tasks, the finish check, approvals and handoffs', () => {
    const n = aggregateHarness([
      e('turn', {
        where: 'main',
        session: 'conversation',
        tools: ['task_start'],
        answered: true,
        ackMs: 300,
        firstMs: 2000,
      }),
      e(
        'turn',
        {
          where: 'side',
          session: 'task',
          task: 't1',
          tools: ['browser_open', 'browser_click', 'browser_request_approval'],
          chars: [7000, 500, null],
          answered: true,
        },
        1,
      ),
      e('turn', { where: 'side', session: 'task', task: 't1', tools: ['browser_click'], chars: [400] }, 2),
      // An older line: no session, no sizes
      e('turn', { where: 'main', tools: ['service_call'], answered: true, firstMs: 4000 }, 3),
      e('cache', { session: 'conversation', input: 10_000, cached: 0 }, 4),
      e('cache', { session: 'conversation', input: 10_000, cached: 9_000, gapMs: 60_000 }, 5),
      e('cache', { session: 'task', input: 20_000, cached: 19_000, gapMs: 2 * 3600_000 }, 6),
      e('task', { id: 't1', event: 'start' }, 7),
      e('task', { id: 't1', event: 'done', ms: 60_000, steps: 4 }, 8),
      e('finish-check', { result: 'done' }, 9),
      e('finish-check', { result: 'again', because: 'asked' }, 10),
      e('finish-check', { result: 'stop' }, 11),
      e('finish-check', { result: 'skip', reason: 'simple' }, 12),
      e('finish-check', { result: 'accepted' }, 13),
      e('auto-approve', { approval: 'app', ok: false, held: 'unchecked' }, 14),
      // Written before the fix: the approval's kind replaced the line's kind
      e('contact', { ok: true, sms: true }, 14),
      e('money', { host: 'shop', left: 1 }, 14),
      e('handoff', { made: true, ms: 100, turns: 5 }, 15),
      e('handoff', { made: true, ms: 100, turns: 7 }, 16),
      e('segment', { reason: 'idle', handoff: 'ready' }, 17),
      { at: 3 as unknown as string, kind: 'turn' },
    ])
    expect(n.turns).toEqual({ conversation: 1, task: 2, main: 1 })
    expect(n.input.conversation?.all).toMatchObject({ n: 2, p50: 10_000 })
    expect(n.input.conversation?.opening.n).toBe(1)
    expect(n.cacheByGap).toEqual({
      opening: { n: 1, share: 0 },
      '< 5 min': { n: 1, share: 90 },
      '>= 60 min': { n: 1, share: 95 },
    })
    expect(n.results.browser_open).toMatchObject({ n: 1, total: 7000 })
    expect(n.results.browser_click).toMatchObject({ n: 2, total: 900 })
    expect(n.resultCalls).toBe(3)
    expect(n.resultOver6000).toBe(1)
    expect(n.tasks).toMatchObject({ started: 1, ended: { done: 1 } })
    expect(n.tasks.turns.p50).toBe(2)
    expect(n.tasks.toolCalls.p50).toBe(4)
    expect(n.tasks.resultChars.p50).toBe(7900)
    expect(n.tasks.approvals.p50).toBe(1)
    expect(n.ackMs).toEqual({ conversation: { n: 1, p50: 300, p95: 300, max: 300 } })
    expect(n.firstMs.main?.p50).toBe(4000)
    expect(n.finish).toEqual({
      judged: 3,
      done: 1,
      again: 1,
      stop: 1,
      simple: 1,
      accepted: 1,
      because: { asked: 1, unlabeled: 1 },
    })
    expect(n.approvals).toEqual({ asked: 1, askedInTasks: 1, auto: 2, autoHeld: 1 })
    expect(n.handoffs).toEqual({ made: 2, notMade: 0, used: 1 })
    expect(n.from).toBe(at(0))
  })

  it('compares with the targets and an earlier run', () => {
    const before = aggregateHarness([e('turn', { task: 't', tools: ['browser_open'], chars: [10_000] })])
    const now = aggregateHarness([e('turn', { task: 't', tools: ['browser_open'], chars: [5_000] })])
    const rows = targetRows(
      now,
      {
        prompt: { conversation: 4000, task: 9000 },
        tools: { conversation: { count: 20, bytes: 29_000 }, task: { count: 40, bytes: 50_000 } },
        endAnswer: { total: 3, explained: 3 },
      },
      { baseline: before },
    )
    const row = (name: string) => rows.find((r) => r[0] === name)
    expect(row('Conversation prompt template')?.[3]).toBe('ok')
    expect(row('Task prompt template')?.[3]).toBe('over')
    expect(row('Conversation tool list')?.[3]).toBe('ok')
    expect(row('Task tool list')?.[3]).toBe('over')
    expect(row('Tool result text per task (p50)')?.slice(2)).toEqual(['5,000 chars (-50%)', 'ok'])
    expect(row('Tool results over 6,000 chars')?.[3]).toBe('ok')
    expect(row('"End this answer" results without what is left / next')?.[3]).toBe('ok')
  })

  it('splits requests done by whether their steps were new, seen before or offered (ADR 0042)', () => {
    const n = aggregateHarness([
      e('recipe', { event: 'done', ms: 20_000, tools: 6, before: 0, offered: 0 }),
      e('recipe', { event: 'done', ms: 12_000, tools: 4, before: 1, offered: 0 }),
      e('recipe', { event: 'offered', n: 1 }),
      e('recipe', { event: 'done', ms: 5_000, tools: 2, before: 2, offered: 1, followed: true }),
      e('recipe', { event: 'forgot', id: 'k1' }),
    ])
    expect(n.recipes.first.ms.p50).toBe(20_000)
    expect(n.recipes.again.tools.p50).toBe(4)
    expect(n.recipes.offered.ms.p50).toBe(5_000)
    expect(n.recipes).toMatchObject({ followed: 1, offers: 1, forgot: 1 })
    expect(renderHarness(n, {})).toContain('offered on 1 messages · followed 1 · forgotten 1')
  })

  it('renders an empty log without failing', () => {
    const out = renderHarness(aggregateHarness([]), {})
    expect(out).toContain('no records')
    expect(out).toContain('n/a')
  })
})
