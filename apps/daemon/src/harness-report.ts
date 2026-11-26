// Harness numbers in one place (`pnpm report:harness`): what every request carries (prompt, tool list), what tools
// return, how fast answers start, how often the finish check sends work back, and how tasks go. Reads the work log
// on this PC and prints aggregate numbers only (counts, sizes, times), never text from the log, so the output can be
// shared. Older log lines lack fields added later (session kind, result sizes, ack time): those show as "n/a".
import type { JournalEntry } from './journal.js'

/** Numbers read from the code, not the log (scripts/report-harness.mjs fills them from the built packages) */
export interface HarnessStatic {
  /** Prompt template characters per kind of session. shared: one template serves every kind */
  prompt?: { conversation?: number; task?: number; shared?: boolean }
  /** Visible tool list per kind: tool count and JSON size (as the budget tests count it) */
  tools?: Partial<Record<'conversation' | 'task' | 'all', { count: number; bytes: number }>>
  /** Tool results in the source that tell the AI to end its answer, and how many of them say what is left and what comes next */
  endAnswer?: { total: number; explained: number }
}

export interface Dist {
  n: number
  p50?: number
  p95?: number
  max?: number
}

export interface HarnessNumbers {
  from?: string
  to?: string
  turns: Record<string, number>
  /** First AI call input tokens per kind: every turn, and turns that open a segment (no earlier turn to reuse the cache) */
  input: Record<string, { all: Dist; opening: Dist }>
  /** Cache share of the first AI call by time since the segment's previous turn */
  cacheByGap: Record<string, { n: number; share?: number }>
  /** Result characters per tool (calls whose size is known) */
  results: Record<string, Dist & { total: number }>
  resultCalls: number
  resultOver6000: number
  tasks: {
    started: number
    ended: Record<string, number>
    /** Per task, from turns that carry the task's id */
    turns: Dist
    toolCalls: Dist
    resultChars: Dist
    steps: Dist
    ms: Dist
    approvals: Dist
  }
  /** Turn start to the status on screen, and to the first word or tool, per kind (answered turns, not the feed) */
  ackMs: Record<string, Dist>
  firstMs: Record<string, Dist>
  finish: {
    judged: number
    done: number
    again: number
    stop: number
    simple: number
    accepted: number
    because: Record<string, number>
  }
  approvals: { asked: number; askedInTasks: number; auto: number; autoHeld: number }
  handoffs: { made: number; notMade: number; used?: number }
  /**
   * Recipes (ADR 0042): requests that ended done, split by how many times their steps had got a request done before
   * (first = new steps, again = seen before, offered = a recipe was on the message), with time and tool calls per request
   */
  recipes: {
    first: { ms: Dist; tools: Dist }
    again: { ms: Dist; tools: Dist }
    offered: { ms: Dist; tools: Dist }
    followed: number
    offers: number
    forgot: number
  }
}

/** Tools that put an approval card in front of the person */
const APPROVAL_TOOL = /_request_approval$|_prepare_|^browser_checkout$/

/**
 * Auto-approve decisions. Lines written before the fix carry the approval's kind (money, contact …) as the line's kind,
 * told apart from other lines with those kinds by the decision field (ok)
 */
const APPROVAL_KIND = new Set(['money', 'contact', 'irreversible', 'app', 'file', 'print', 'pc'])
const isAutoApprove = (e: JournalEntry) =>
  e.kind === 'auto-approve' || (APPROVAL_KIND.has(e.kind) && typeof e.ok === 'boolean' && !('host' in e))

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Nearest-rank percentile (same as the usage stats) */
function pct(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

export function dist(values: number[]): Dist {
  const s = [...values].sort((a, b) => a - b)
  const out: Dist = { n: s.length }
  if (!s.length) return out
  out.p50 = pct(s, 50)
  out.p95 = pct(s, 95)
  out.max = s[s.length - 1]
  return out
}

/**
 * Kind of session of a turn: the session field when the log has it (conversation / task, ADR 0038), else where it
 * ran (main / side / feed; "main" from before task sessions served every kind of work)
 */
export function kindOf(e: JournalEntry): string {
  if (e.session === 'conversation' || e.session === 'task') return e.session
  if (typeof e.task === 'string') return 'task'
  return typeof e.where === 'string' ? e.where : 'unknown'
}

function gapBucket(gapMs: number | undefined): string {
  // Opening turns have no gap; records from before the gap was logged land here too
  if (gapMs === undefined) return 'opening'
  if (gapMs < 5 * 60_000) return '< 5 min'
  if (gapMs < 60 * 60_000) return '5-60 min'
  return '>= 60 min'
}

const push = <T>(m: Record<string, T[]>, k: string, v: T) => {
  const list = m[k] ?? []
  list.push(v)
  m[k] = list
}

export function aggregateHarness(entries: JournalEntry[]): HarnessNumbers {
  const turns: Record<string, number> = {}
  const inputAll: Record<string, number[]> = {}
  const inputOpening: Record<string, number[]> = {}
  const gap: Record<string, { n: number; input: number; cached: number }> = {}
  const results: Record<string, number[]> = {}
  const ack: Record<string, number[]> = {}
  const first: Record<string, number[]> = {}
  const perTask = new Map<string, { turns: number; tools: number; chars: number; approvals: number }>()
  const taskSteps: number[] = []
  const taskMs: number[] = []
  const ended: Record<string, number> = {}
  let started = 0
  let over = 0
  let resultCalls = 0
  const finish = {
    judged: 0,
    done: 0,
    again: 0,
    stop: 0,
    simple: 0,
    accepted: 0,
    because: {} as Record<string, number>,
  }
  const approvals = { asked: 0, askedInTasks: 0, auto: 0, autoHeld: 0 }
  const handoffs: HarnessNumbers['handoffs'] = { made: 0, notMade: 0 }
  const req = { first: [[], []], again: [[], []], offered: [[], []] } as Record<
    'first' | 'again' | 'offered',
    [number[], number[]]
  >
  const recipeCounts = { followed: 0, offers: 0, forgot: 0 }
  let from: string | undefined
  let to: string | undefined

  for (const e of entries) {
    if (typeof e.at !== 'string') continue
    if (!from || e.at < from) from = e.at
    if (!to || e.at > to) to = e.at
    if (isAutoApprove(e)) {
      approvals.auto++
      if (e.ok === false) approvals.autoHeld++
      continue
    }
    switch (e.kind) {
      case 'turn': {
        const k = kindOf(e)
        turns[k] = (turns[k] ?? 0) + 1
        const tools = Array.isArray(e.tools)
          ? (e.tools as unknown[]).filter((t) => typeof t === 'string')
          : []
        const chars = Array.isArray(e.chars) ? (e.chars as unknown[]) : []
        let turnChars = 0
        tools.forEach((t, i) => {
          const c = num(chars[i])
          if (c === undefined) return
          resultCalls++
          turnChars += c
          if (c > 6000) over++
          push(results, t as string, c)
        })
        const asked = tools.filter((t) => APPROVAL_TOOL.test(t as string)).length
        approvals.asked += asked
        if (typeof e.task === 'string') {
          approvals.askedInTasks += asked
          const t = perTask.get(e.task) ?? { turns: 0, tools: 0, chars: 0, approvals: 0 }
          t.turns++
          t.tools += tools.length
          t.chars += turnChars
          t.approvals += asked
          perTask.set(e.task, t)
        }
        if (e.answered === true && e.where !== 'feed') {
          const a = num(e.ackMs)
          if (a !== undefined) push(ack, k, a)
          const f = num(e.firstMs)
          if (f !== undefined) push(first, k, f)
        }
        break
      }
      case 'cache': {
        const input = num(e.input)
        const cached = num(e.cached)
        if (input === undefined) break
        const k = e.session === 'conversation' || e.session === 'task' ? e.session : 'unknown'
        push(inputAll, k, input)
        const g = num(e.gapMs)
        if (g === undefined) push(inputOpening, k, input)
        const b = gapBucket(g)
        const slot = gap[b] ?? { n: 0, input: 0, cached: 0 }
        slot.n++
        slot.input += input
        slot.cached += cached ?? 0
        gap[b] = slot
        break
      }
      case 'task': {
        if (e.event === 'start') started++
        else if (e.event === 'done' || e.event === 'stopped' || e.event === 'failed') {
          ended[e.event] = (ended[e.event] ?? 0) + 1
          const s = num(e.steps)
          if (s !== undefined) taskSteps.push(s)
          const ms = num(e.ms)
          if (ms !== undefined) taskMs.push(ms)
        }
        break
      }
      case 'finish-check': {
        if (e.result === 'skip') {
          if (e.reason === 'simple') finish.simple++
          break
        }
        if (e.result === 'accepted') {
          finish.accepted++
          break
        }
        if (e.result !== 'done' && e.result !== 'again' && e.result !== 'stop') break
        finish.judged++
        finish[e.result]++
        if (e.result !== 'done') {
          const why = typeof e.because === 'string' ? e.because : 'unlabeled'
          finish.because[why] = (finish.because[why] ?? 0) + 1
        }
        break
      }
      case 'handoff': {
        if (e.made === true) handoffs.made++
        else handoffs.notMade++
        break
      }
      case 'recipe': {
        if (e.event === 'offered') recipeCounts.offers++
        else if (e.event === 'forgot') recipeCounts.forgot++
        else if (e.event === 'done') {
          const ms = num(e.ms)
          const tools = num(e.tools)
          if (ms === undefined || tools === undefined) break
          const before = num(e.before) ?? -1
          const k = (num(e.offered) ?? 0) > 0 ? 'offered' : before > 0 ? 'again' : 'first'
          req[k][0].push(ms)
          req[k][1].push(tools)
          if (e.followed === true) recipeCounts.followed++
        }
        break
      }
      case 'segment': {
        if (e.handoff === 'ready') handoffs.used = (handoffs.used ?? 0) + 1
        else handoffs.used ??= 0
        break
      }
    }
  }

  const per = (f: (t: { turns: number; tools: number; chars: number; approvals: number }) => number) =>
    dist([...perTask.values()].map(f))
  const dists = (m: Record<string, number[]>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, dist(v)]))
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    turns,
    input: Object.fromEntries(
      [...new Set([...Object.keys(inputAll), ...Object.keys(inputOpening)])].map((k) => [
        k,
        { all: dist(inputAll[k] ?? []), opening: dist(inputOpening[k] ?? []) },
      ]),
    ),
    cacheByGap: Object.fromEntries(
      Object.entries(gap).map(([k, v]) => [
        k,
        { n: v.n, ...(v.input ? { share: Math.round((v.cached / v.input) * 100) } : {}) },
      ]),
    ),
    results: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, { ...dist(v), total: v.reduce((a, b) => a + b, 0) }]),
    ),
    resultCalls,
    resultOver6000: over,
    tasks: {
      started,
      ended,
      turns: per((t) => t.turns),
      toolCalls: per((t) => t.tools),
      resultChars: per((t) => t.chars),
      approvals: per((t) => t.approvals),
      steps: dist(taskSteps),
      ms: dist(taskMs),
    },
    ackMs: dists(ack),
    firstMs: dists(first),
    finish,
    approvals,
    handoffs,
    recipes: {
      first: { ms: dist(req.first[0]), tools: dist(req.first[1]) },
      again: { ms: dist(req.again[0]), tools: dist(req.again[1]) },
      offered: { ms: dist(req.offered[0]), tools: dist(req.offered[1]) },
      ...recipeCounts,
    },
  }
}

// ---- Rendering ----

const fmt = (v: number | undefined) => (v === undefined ? 'n/a' : Math.round(v).toLocaleString('en-US'))
const secs = (v: number | undefined) => (v === undefined ? 'n/a' : `${(v / 1000).toFixed(1)} s`)
const distLine = (d: Dist, f: (v: number | undefined) => string = fmt) =>
  d.n ? `n ${d.n} · p50 ${f(d.p50)} · p95 ${f(d.p95)} · max ${f(d.max)}` : 'n/a (no data)'

function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))) ?? []
  return rows.map((r) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd(),
  )
}

type Check = 'ok' | 'over' | 'n/a'
const check = (now: number | undefined, max: number): Check =>
  now === undefined ? 'n/a' : now <= max ? 'ok' : 'over'
const worst = (...cs: Check[]): Check => (cs.includes('over') ? 'over' : cs.includes('n/a') ? 'n/a' : 'ok')

export interface RenderOptions {
  days?: number
  /** Numbers from an earlier run (`--json` output), to compare result text per task */
  baseline?: HarnessNumbers
}

/** The targets of the round-2 harness plan with what the code and the log show now */
export function targetRows(n: HarnessNumbers, s: HarnessStatic, o: RenderOptions = {}): string[][] {
  const rows: string[][] = [['Metric', 'Target', 'Now', '']]
  const p = s.prompt
  const shared = p?.shared ? ' (one template for all)' : ''
  rows.push([
    'Conversation prompt template',
    '<= 5,000 chars',
    `${fmt(p?.conversation)}${shared}`,
    check(p?.conversation, 5000),
  ])
  rows.push(['Task prompt template', '<= 8,000 chars', `${fmt(p?.task)}${shared}`, check(p?.task, 8000)])
  for (const [kind, maxN, maxB] of [
    ['conversation', 25, 30_000],
    ['task', 35, 55_000],
  ] as const) {
    const t = s.tools?.[kind]
    rows.push([
      `${kind === 'task' ? 'Task' : 'Conversation'} tool list`,
      `<= ${maxN} tools, <= ${fmt(maxB)} B`,
      t ? `${t.count} tools, ${fmt(t.bytes)} B` : 'n/a',
      t ? worst(check(t.count, maxN), check(t.bytes, maxB)) : 'n/a',
    ])
  }
  const perTask = n.tasks.resultChars.p50
  const base = o.baseline?.tasks.resultChars.p50
  const change = perTask !== undefined && base ? Math.round(((perTask - base) / base) * 100) : undefined
  rows.push([
    'Tool result text per task (p50)',
    '-40% vs main',
    `${fmt(perTask)} chars${change !== undefined ? ` (${change > 0 ? '+' : ''}${change}%)` : base ? '' : ' (no baseline)'}`,
    change === undefined ? 'n/a' : change <= -40 ? 'ok' : 'over',
  ])
  rows.push([
    'Tool results over 6,000 chars',
    '0',
    n.resultCalls ? `${n.resultOver6000} of ${fmt(n.resultCalls)}` : 'n/a',
    n.resultCalls ? (n.resultOver6000 ? 'over' : 'ok') : 'n/a',
  ])
  const e = s.endAnswer
  rows.push([
    '"End this answer" results without what is left / next',
    '0',
    e ? `${e.total - e.explained} of ${e.total} (source scan)` : 'n/a',
    e ? (e.total - e.explained ? 'over' : 'ok') : 'n/a',
  ])
  const sent = n.finish.again + n.finish.stop
  const rate = n.finish.judged ? Math.round((sent / n.finish.judged) * 100) : undefined
  rows.push([
    'Finish check send-back rate',
    '< 30%',
    rate === undefined ? 'n/a' : `${rate}% (${sent} of ${n.finish.judged})`,
    rate === undefined ? 'n/a' : rate < 30 ? 'ok' : 'over',
  ])
  rows.push([
    'Reviewer / small judge on every runtime',
    'Claude, Codex, pay-as-you-go',
    'not in the log',
    'n/a',
  ])
  rows.push(['One command prints the harness numbers', 'pnpm report:harness', 'this report', 'ok'])
  return rows
}

export function renderHarness(n: HarnessNumbers, s: HarnessStatic, o: RenderOptions = {}): string {
  const out: string[] = []
  const span = n.from && n.to ? `${n.from.slice(0, 10)} to ${n.to.slice(0, 10)}` : 'no records'
  out.push(`Dool2 harness report (work log ${span}${o.days ? `, last ${o.days} days` : ''})`)
  out.push('')
  out.push('Targets')
  out.push(...table(targetRows(n, s, o)).map((l) => `  ${l}`))

  out.push('')
  out.push('Turns per kind of session')
  const kinds = Object.entries(n.turns).sort((a, b) => b[1] - a[1])
  out.push(`  ${kinds.length ? kinds.map(([k, v]) => `${k} ${fmt(v)}`).join(' · ') : 'n/a'}`)

  out.push('')
  out.push('Fixed input: first AI call input tokens per kind (opening = first turn of a segment)')
  const inputs = Object.entries(n.input)
  if (!inputs.length) out.push('  n/a (no cache records)')
  for (const [k, v] of inputs) {
    out.push(`  ${k.padEnd(12)} all: ${distLine(v.all)}`)
    out.push(`  ${''.padEnd(12)} opening: ${distLine(v.opening)}`)
  }

  out.push('')
  out.push('Cache share by time since the previous turn')
  const gaps = ['opening', '< 5 min', '5-60 min', '>= 60 min'].filter((g) => n.cacheByGap[g])
  if (!gaps.length) out.push('  n/a (no cache records)')
  for (const g of gaps) {
    const v = n.cacheByGap[g]
    if (v) out.push(`  ${g.padEnd(10)} ${String(v.n).padStart(5)} turns · ${v.share ?? 0}% cached`)
  }

  out.push('')
  out.push('Result characters per tool (top 15 by total)')
  const res = Object.entries(n.results).sort((a, b) => b[1].total - a[1].total)
  const all = res.reduce((a, [, v]) => a + v.total, 0)
  if (!res.length) out.push('  n/a (no result sizes in the log yet)')
  else
    out.push(
      ...table([
        ['tool', 'calls', 'total', 'share', 'p50', 'p95', 'max'],
        ...res
          .slice(0, 15)
          .map(([t, v]) => [
            t,
            fmt(v.n),
            fmt(v.total),
            `${Math.round((v.total / all) * 100)}%`,
            fmt(v.p50),
            fmt(v.p95),
            fmt(v.max),
          ]),
      ]).map((l) => `  ${l}`),
    )

  out.push('')
  out.push('Tasks')
  const t = n.tasks
  const endedLine = Object.entries(t.ended)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ')
  out.push(`  started ${t.started}${endedLine ? ` · ${endedLine}` : ''}`)
  out.push(`  turns per task       ${distLine(t.turns)}`)
  out.push(`  tool calls per task  ${distLine(t.toolCalls)}`)
  out.push(`  result chars / task  ${distLine(t.resultChars)}`)
  out.push(`  approvals per task   ${distLine(t.approvals)}`)
  out.push(`  steps per task       ${distLine(t.steps)}`)
  out.push(`  time per task        ${distLine(t.ms, secs)}`)

  out.push('')
  out.push('Answer start (answered turns, not the feed)')
  const ackKinds = [...new Set([...Object.keys(n.ackMs), ...Object.keys(n.firstMs)])]
  if (!ackKinds.length) out.push('  n/a')
  for (const k of ackKinds) {
    out.push(`  ${k.padEnd(12)} ack:        ${distLine(n.ackMs[k] ?? { n: 0 }, secs)}`)
    out.push(`  ${''.padEnd(12)} first word: ${distLine(n.firstMs[k] ?? { n: 0 }, secs)}`)
  }

  out.push('')
  out.push('Finish check')
  const f = n.finish
  const back = f.again + f.stop
  out.push(
    `  judged ${f.judged} · done ${f.done} · sent back ${f.again} · stopped ${f.stop}` +
      ` · not judged (simple) ${f.simple} · taken as is ${f.accepted}`,
  )
  for (const [k, v] of Object.entries(f.because).sort((a, b) => b[1] - a[1]))
    out.push(`  ${k.padEnd(14)} ${String(v).padStart(4)}  ${Math.round((v / back) * 100)}%`)

  out.push('')
  out.push('Approvals')
  const a = n.approvals
  out.push(
    `  asked ${a.asked} (in tasks ${a.askedInTasks}) · auto-approve decisions ${a.auto} (held by the review ${a.autoHeld})`,
  )

  out.push('')
  out.push('Segment handoffs (summary made ahead)')
  const h = n.handoffs
  out.push(
    `  made ${h.made} · not made ${h.notMade} · used ${h.used ?? 'n/a'}` +
      ` · made but never used ${h.used === undefined ? 'n/a (no segment records yet)' : Math.max(0, h.made - h.used)}`,
  )

  out.push('')
  out.push('Recipes (requests that ended done, ADR 0042)')
  const r = n.recipes
  if (r) {
    for (const [k, label] of [
      ['first', 'new steps'],
      ['again', 'seen before'],
      ['offered', 'recipe offered'],
    ] as const) {
      out.push(`  ${label.padEnd(15)} time: ${distLine(r[k].ms, secs)}`)
      out.push(`  ${''.padEnd(15)} tool calls: ${distLine(r[k].tools)}`)
    }
    out.push(`  offered on ${r.offers} messages · followed ${r.followed} · forgotten ${r.forgot}`)
  } else out.push('  n/a')
  return out.join('\n')
}
