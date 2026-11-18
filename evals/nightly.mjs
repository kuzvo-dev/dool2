// 밤 고리 (하네스 계획 ⑥의 안전한 핵심): 매일 시나리오 한 묶음을 돌려 성적표를 내고, 점수 추세를 쌓는다.
// 고치는 PR은 자동으로 만들지 않는다(사람이 아침 보고서를 보고 고친다).
//
// 사용: node evals/nightly.mjs --token <화면 토큰> [--n 40] [--repeat 2] [--out evals/out]
//   - 매일 다른 묶음이 돌도록 날짜로 섞는다(가족마다 하나씩, 우선순위 높은 것 먼저).
//   - 결과: <out>/<날짜>/ 기록·성적표, <out>/trend.csv 한 줄(날짜·통과·일부·실패·AI평균), <out>/latest.html 링크.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenarios } from './lib/bank.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 ? process.argv[i + 1] : d
}
const token = arg('token', process.env.DOOL2_TOKEN)
if (!token) {
  console.error('화면 토큰이 필요해요: --token 또는 DOOL2_TOKEN')
  process.exit(2)
}
const daemon = arg('daemon', 'http://127.0.0.1:8833')
const n = Number(arg('n', '40'))
const repeat = Number(arg('repeat', '2'))
const outRoot = arg('out', join(here, 'out'))
const day = new Date().toISOString().slice(0, 10)
const out = join(outRoot, day)
mkdirSync(out, { recursive: true })

// 매일 다른 묶음: 날짜를 씨앗으로 가족마다 하나씩 섞고, 우선순위 높은 것(pri)을 조금 더 자주 뽑는다
const seed = Number(day.replaceAll('-', '')) % 100000
let r = seed
const rand = () => (r = (r * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
const byFam = new Map()
for (const s of scenarios()) byFam.set(s.fid, [...(byFam.get(s.fid) ?? []), s])
const chosen = []
for (const group of byFam.values()) {
  const g = [...group].sort(() => rand() - 0.5)
  chosen.push(g[0])
}
chosen.sort((a, b) => b.pri - a.pri || rand() - 0.5)
const ids = chosen.slice(0, n).map((s) => s.id)
writeFileSync(join(out, '_nightly-ids.json'), JSON.stringify(ids))

const node = process.execPath
const run = (script, extra) =>
  execFileSync(node, [join(here, script), ...extra], { stdio: 'inherit', cwd: join(here, '..') })

console.log(`[밤 고리 ${day}] 시나리오 ${ids.length}개 × ${repeat}회`)
run('run.mjs', [
  '--daemon',
  daemon,
  '--token',
  token,
  '--ids',
  ids.join(','),
  '--repeat',
  String(repeat),
  '--out',
  out,
])
run('score.mjs', [out, '--judge', '--html', join(out, 'card.html')])

// 추세 한 줄 쌓기 + latest 링크
const rows = readdirSync(out)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => JSON.parse(readFileSync(join(out, f), 'utf8')))
  .filter((x) => x.scenario && x.final_verdict !== 'na')
const t = { pass: 0, part: 0, fail: 0, unknown: 0 }
let scoreSum = 0
let scoreN = 0
for (const x of rows) {
  t[x.final_verdict] = (t[x.final_verdict] ?? 0) + 1
  if (typeof x.judge?.score === 'number') {
    scoreSum += x.judge.score
    scoreN++
  }
}
const avg = scoreN ? (scoreSum / scoreN).toFixed(2) : ''
const trend = join(outRoot, 'trend.csv')
if (!existsSync(trend)) writeFileSync(trend, '날짜,시나리오,통과,일부,실패,미판정,AI평균\n')
appendFileSync(trend, `${day},${rows.length},${t.pass},${t.part},${t.fail},${t.unknown},${avg}\n`)
writeFileSync(
  join(outRoot, 'latest.txt'),
  `${day} · 통과 ${t.pass} 일부 ${t.part} 실패 ${t.fail} · AI평균 ${avg}\n`,
)
console.log(`[밤 고리 ${day}] 통과 ${t.pass} · 일부 ${t.part} · 실패 ${t.fail} · AI평균 ${avg}`)
console.log(`성적표 ${join(out, 'card.html')} · 추세 ${trend}`)
