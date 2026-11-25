// 1층 시험 (AI 없이): 은행 형식 검사 + 시나리오마다 필요한 도구·서비스 카드가 레포에 있는지.
// 사용: node evals/static.mjs [--json 파일]   (형식 오류가 있으면 1로 끝난다 → CI에 쓸 수 있다)
import { writeFileSync } from 'node:fs'
import { families, gaps, neededTools, perturbs, scenarios, serviceIds, toolNames } from './lib/bank.mjs'

const TYPES = new Set([
  '조회',
  '실행',
  '실행+승인',
  '되묻기',
  '사람단계',
  '먼저챙기기',
  '반복',
  '범위밖',
  '기억',
  '안전',
  '정직',
  '연결',
  '교란',
])
const errors = []
const P = perturbs()
const G = new Set(gaps().map((g) => g.id))
const fids = new Set()
for (const f of families()) {
  const at = `${f.file} ${f.fid}`
  if (!f.fid || fids.has(f.fid)) errors.push(`${at}: fid가 없거나 겹쳐요`)
  fids.add(f.fid)
  for (const k of ['cat', 'title', 'type', 'asks', 'expect', 'now'])
    if (!f[k] || (Array.isArray(f[k]) && !f[k].length)) errors.push(`${at}: ${k}가 비었어요`)
  if (f.type && !TYPES.has(f.type)) errors.push(`${at}: 모르는 type '${f.type}'`)
  if (f.now && !['ok', 'part', 'no'].includes(f.now)) errors.push(`${at}: now는 ok·part·no`)
  for (const k of Object.keys(
    Array.isArray(f.perturb) ? Object.fromEntries(f.perturb.map((x) => [x, ''])) : (f.perturb ?? {}),
  ))
    if (!P[k]) errors.push(`${at}: 모르는 교란 '${k}'`)
  // A task put in place before the request (evals/run.mjs --main on): a task_start spec and its state
  const seed = f.seed?.task
  if (f.seed && !seed) errors.push(`${at}: seed has only "task"`)
  if (seed) {
    if (!seed.goal || !Array.isArray(seed.done_when) || !seed.done_when.length)
      errors.push(`${at}: seed.task needs goal and done_when, like task_start`)
    if (seed.status && !['working', 'needs-you'].includes(seed.status))
      errors.push(`${at}: seed.task.status is working or needs-you`)
  }
  for (const g of f.gaps ?? [])
    if (!G.has(g) && !String(g).startsWith('N+')) errors.push(`${at}: 모르는 빈틈 '${g}'`)
}

const all = scenarios()
const names = toolNames()
const ids = serviceIds()
const rows = all.map((sc) => {
  const n = neededTools(sc, ids)
  const missing = n.tools.filter((t) => !names.has(t))
  return {
    id: sc.id,
    now: sc.now,
    type: sc.type,
    pri: sc.pri,
    tools: n.tools,
    missing,
    noService: n.noService,
  }
})
const ready = (r) => !r.missing.length && !r.noService.length
const by = (k) => {
  const m = {}
  for (const r of rows) {
    const key = r[k]
    m[key] ??= { all: 0, ready: 0 }
    m[key].all++
    if (ready(r)) m[key].ready++
  }
  return m
}
const count = (list) => {
  const m = {}
  for (const x of list) m[x] = (m[x] ?? 0) + 1
  return Object.entries(m).sort((a, b) => b[1] - a[1])
}
const summary = {
  families: fids.size,
  scenarios: all.length,
  formatErrors: errors.length,
  toolsReady: rows.filter(ready).length,
  byNow: by('now'),
  missingTools: count(rows.flatMap((r) => r.missing)),
  noService: count(rows.flatMap((r) => r.noService)),
}
console.log(`가족 ${summary.families} · 시나리오 ${summary.scenarios} · 형식 오류 ${errors.length}`)
console.log(
  `필요한 도구·서비스가 다 있는 시나리오 ${summary.toolsReady} (${Math.round((summary.toolsReady / all.length) * 100)}%)`,
)
for (const [k, v] of Object.entries(summary.byNow)) console.log(`  now=${k}: ${v.ready}/${v.all}`)
if (summary.missingTools.length)
  console.log(`없는 도구: ${summary.missingTools.map(([t, n]) => `${t}(${n})`).join(' ')}`)
if (summary.noService.length)
  console.log(`카드 없는 서비스: ${summary.noService.map(([t, n]) => `${t}(${n})`).join(' ')}`)
for (const e of errors.slice(0, 30)) console.log(`형식 오류 ${e}`)
const out = process.argv.indexOf('--json')
if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify({ summary, rows }, null, 1))
process.exit(errors.length ? 1 : 0)
