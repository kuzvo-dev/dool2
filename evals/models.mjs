// Compare runs of the same scenarios on different agents or models (ADR 0037), one row per run folder:
//   node evals/run.mjs --replay evals/out/tape-base --model haiku --out evals/out/replay-haiku
//   node evals/score.mjs evals/out/replay-haiku --judge
//   node evals/models.mjs evals/out/replay-sonnet evals/out/replay-haiku
// Only scenarios present in every folder are counted, so the rows compare the same work.
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Records of one run folder: scenario id → records (several with --repeat) */
export function loadRun(dir) {
  const byId = new Map()
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue
    let r
    try {
      r = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      continue
    }
    if (!r?.scenario || r.final_verdict === 'na') continue
    byId.set(r.id, [...(byId.get(r.id) ?? []), r])
  }
  return byId
}

const median = (xs) => {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** One row: score, pass count, time and how often the finish check sent the work back */
export function summarize(label, byId, ids) {
  const recs = ids.flatMap((id) => byId.get(id) ?? [])
  const scores = recs.map((r) => r.judge?.score).filter((x) => typeof x === 'number')
  const agents = [...new Set(recs.map((r) => [r.agent, r.model].filter(Boolean).join(' · ')).filter(Boolean))]
  return {
    label,
    ai: agents.join(', ') || '(default)',
    runs: recs.length,
    score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : undefined,
    pass: recs.filter((r) => r.final_verdict === 'pass').length,
    medianSec: recs.length ? Math.round(median(recs.map((r) => r.ms ?? 0)) / 1000) : undefined,
    sentBackRate: recs.length ? recs.filter((r) => (r.sentBack ?? 0) > 0).length / recs.length : undefined,
    rounds: recs.reduce((a, r) => a + (r.sentBack ?? 0), 0),
  }
}

export function table(rows) {
  const head = ['run', 'agent · model', 'runs', 'AI score', 'pass', 'median s', 'sent back', 'rounds']
  const body = rows.map((r) => [
    r.label,
    r.ai,
    String(r.runs),
    r.score === undefined ? '-' : r.score.toFixed(2),
    `${r.pass}/${r.runs}`,
    r.medianSec === undefined ? '-' : String(r.medianSec),
    r.sentBackRate === undefined ? '-' : `${Math.round(r.sentBackRate * 100)}%`,
    String(r.rounds),
  ])
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(w[i])).join('  ')
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...body.map(line)].join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2)
  if (dirs.length < 1) {
    console.error('Usage: node evals/models.mjs <run folder> [<run folder> ...]')
    process.exit(2)
  }
  const runs = dirs.map((d) => [d, loadRun(d)])
  const ids = [...runs[0][1].keys()].filter((id) => runs.every(([, m]) => m.has(id)))
  console.log(`Same scenarios in every folder: ${ids.length}`)
  console.log(table(runs.map(([d, m]) => summarize(basename(d), m, ids))))
}
