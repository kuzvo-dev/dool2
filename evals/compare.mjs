// 두 기록 비교: node evals/compare.mjs <전 폴더> <후 폴더>
// 시나리오마다 AI 점수 평균(여러 번 돌렸으면 그 평균)으로 견주고, 0.5점 넘게 오르내린 것을 보여 준다
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [a, b] = process.argv.slice(2)
if (!a || !b) {
  console.error('사용: node evals/compare.mjs <전 폴더> <후 폴더>')
  process.exit(2)
}
const load = (d) => {
  const m = new Map()
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue
    const r = JSON.parse(readFileSync(join(d, f), 'utf8'))
    if (!r.scenario || r.final_verdict === 'na') continue
    m.set(r.id, [...(m.get(r.id) ?? []), r])
  }
  return m
}
const mean = (rs) => {
  const s = rs.filter((r) => typeof r.judge?.score === 'number').map((r) => r.judge.score)
  return s.length ? s.reduce((x, y) => x + y, 0) / s.length : undefined
}
const A = load(a)
const B = load(b)
const both = [...B.keys()].filter((id) => A.has(id))
const avg = (M) => {
  const v = both.map((id) => mean(M.get(id))).filter((x) => x !== undefined)
  return v.reduce((x, y) => x + y, 0) / (v.length || 1)
}
const pass = (M) => both.filter((id) => M.get(id).every((r) => r.final_verdict === 'pass')).length
console.log(`같은 시나리오 ${both.length}개`)
console.log(`AI 평균 ${avg(A).toFixed(2)} → ${avg(B).toFixed(2)} · 모두 통과 ${pass(A)} → ${pass(B)}`)
const diffs = both
  .map((id) => ({ id, a: mean(A.get(id)), b: mean(B.get(id)), ask: B.get(id)[0].scenario.ask }))
  .filter((d) => d.a !== undefined && d.b !== undefined)
const up = diffs.filter((d) => d.b - d.a >= 0.5)
const down = diffs.filter((d) => d.a - d.b >= 0.5)
console.log(`좋아짐 ${up.length} · 나빠짐 ${down.length}`)
for (const d of down) console.log(`  ↓ ${d.id} ${d.a.toFixed(1)}→${d.b.toFixed(1)} ${d.ask.slice(0, 50)}`)
for (const d of up) console.log(`  ↑ ${d.id} ${d.a.toFixed(1)}→${d.b.toFixed(1)} ${d.ask.slice(0, 50)}`)
