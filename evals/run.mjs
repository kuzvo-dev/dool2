// 3층 시험 (실제 AI·실제 사이트): 시나리오의 부탁을 두리 본체의 '따로 하는 대화'로 보내고, 과정(도구·승인·카드·답)을 기록한다.
// 결제·보내기는 하지 않는다: 이 시험 중에 생긴 승인 요청은 기록한 뒤 바로 거절한다. 대화는 끝나면 지운다 (메인 대화에 섞이지 않는다).
//
// 사용:
//   node evals/run.mjs --daemon http://127.0.0.1:8833 --token <화면 토큰> [고르기] [--out evals/out/<날짜>]
// 고르기: --ids a#1,b#2 | --where type=실행+승인,now=ok,pri=3 | --n 30 (가족마다 하나씩 고르게 섞음) --seed 1 | --per-family 1
// --repeat 3: 같은 시나리오를 세 번 (흔들림을 줄여 비교한다)
// 이미 기록이 있는 시나리오는 건너뛴다 (--again 이면 다시)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVALS, scenarios } from './lib/bank.mjs'

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 ? process.argv[i + 1] : d
}
const flag = (k) => process.argv.includes(`--${k}`)
const daemon = arg('daemon', 'http://127.0.0.1:8833')
const token = arg('token', process.env.DOOL2_TOKEN)
if (!token) {
  console.error('화면 토큰이 필요해요: --token 또는 DOOL2_TOKEN')
  process.exit(2)
}
const out = arg('out', join(EVALS, 'out', new Date().toISOString().slice(0, 10)))
const timeoutMs = Number(arg('timeout', '420')) * 1000
mkdirSync(out, { recursive: true })

const api = async (path, init = {}) => {
  const r = await fetch(daemon + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const t = await r.text()
  try {
    return JSON.parse(t)
  } catch {
    return { status: r.status, text: t }
  }
}

/** 고르기: 같은 seed면 같은 순서 */
function pick(all) {
  const ids = arg('ids')
  if (ids) {
    const want = new Set(ids.split(','))
    return all.filter((s) => want.has(s.id))
  }
  let list = all
  for (const cond of (arg('where') ?? '').split(',').filter(Boolean)) {
    const [k, v] = cond.split('=')
    list = list.filter((s) => String(s[k]) === v || (k === 'perturb' && v === '기본' && !s.perturb))
  }
  // 가족마다 몇 개씩 (같은 일의 말투만 다른 것보다 다른 일을 많이)
  const per = Number(arg('per-family', '1'))
  let seed = Number(arg('seed', '1'))
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return seed / 2 ** 31
  }
  const byFam = new Map()
  for (const s of list) byFam.set(s.fid, [...(byFam.get(s.fid) ?? []), s])
  const chosen = []
  for (const group of byFam.values()) {
    const g = [...group].sort(() => rand() - 0.5)
    chosen.push(...g.slice(0, per))
  }
  chosen.sort(() => rand() - 0.5)
  return chosen.slice(0, Number(arg('n', String(chosen.length))))
}

/** 대화 하나 돌리기: 따로 하는 대화를 만들어 부탁을 보내고 흐름(SSE)을 끝까지 읽는다 */
/** 생활 데이터의 id들 (목표·보관함·기억). 시험이 만든 것은 끝나고 지운다 */
async function lifeIds() {
  const s = await api('/api/life')
  return {
    routine: new Map((s.routines ?? []).map((x) => [x.id, x])),
    library: new Map((s.library ?? []).map((x) => [x.id, x])),
    memory: new Map((s.memory ?? []).map((x) => [x.id, x])),
    feed: new Set((s.feed ?? []).map((x) => x.id)),
  }
}

async function runOne(sc) {
  const before = await lifeIds()
  const started = new Date()
  const { thread } = await api('/api/threads', { method: 'POST', body: JSON.stringify({ side: true }) })
  if (!thread?.id) throw new Error('대화를 만들지 못했어요')
  const rec = {
    id: sc.id,
    scenario: sc,
    startedAt: started.toISOString(),
    thread: thread.id,
    tools: [],
    text: '',
    errors: [],
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => {
    rec.errors.push('timeout')
    void api(`/api/threads/${thread.id}/cancel`, { method: 'POST' })
    ctl.abort()
  }, timeoutMs)
  try {
    const r = await fetch(`${daemon}/api/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: sc.ask }),
      signal: ctl.signal,
    })
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i = buf.indexOf('\n\n')
      while (i >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        i = buf.indexOf('\n\n')
        const line = chunk.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        let ev
        try {
          ev = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        const e = ev.event ?? ev
        const at = Date.now() - started.getTime()
        if (e.type === 'tool') rec.tools.push({ name: e.name, input: e.input, at })
        else if (e.type === 'tool_result') {
          const last = [...rec.tools]
            .reverse()
            .find((t) => t.ok === undefined && (!e.name || t.name === e.name))
          if (last) last.ok = e.ok
        } else if (e.type === 'text') rec.text += e.delta
        else if (e.type === 'done') rec.final = e.text
        else if (e.type === 'error') rec.errors.push(`${e.code}: ${e.message}`)
        else if (e.type === 'limit_reached') rec.errors.push(`limit: ${e.message}`)
        else if (e.type === 'cost') rec.cost = e
      }
    }
  } catch (e) {
    if (!ctl.signal.aborted) rec.errors.push(String(e.message ?? e))
  } finally {
    clearTimeout(timer)
  }
  rec.ms = Date.now() - started.getTime()
  // 이 대화 동안 생긴 승인 요청: 기록하고, 기다리는 것은 거절한다 (시험에서는 결제·보내기를 하지 않는다)
  const { approvals = [] } = await api('/api/approvals')
  rec.approvals = approvals
    .filter((a) => Date.parse(a.createdAt) >= started.getTime())
    .map(({ shot: _s, ...a }) => a)
  for (const a of rec.approvals)
    if (a.status === 'pending')
      await api(`/api/approvals/${a.id}`, { method: 'POST', body: JSON.stringify({ decision: 'reject' }) })
  // 이 대화 동안 생긴 정보 요청(인증번호·내 정보 카드)
  const info = await api('/api/info')
  rec.info = (info.requests ?? []).filter((q) => !q.createdAt || Date.parse(q.createdAt) >= started.getTime())
  // 시험이 만든 목표·보관함·기억: 무엇이 생겼는지 남기고 지운다 (사용자 데이터에 섞이지 않게). 피드 글은 지울 수 없어 기록만
  const after = await lifeIds()
  rec.created = { routine: [], library: [], memory: [], feed: [] }
  for (const kind of ['routine', 'library', 'memory']) {
    for (const [id, x] of after[kind]) {
      if (before[kind].has(id)) continue
      rec.created[kind].push(x)
      await api('/api/life/action', {
        method: 'POST',
        body: JSON.stringify({ action: `${kind}-delete`, id }),
      })
    }
  }
  const s2 = await api('/api/life')
  rec.created.feed = (s2.feed ?? []).filter((x) => !before.feed.has(x.id))
  const msgs = await api(`/api/threads/${thread.id}`)
  rec.messages = (msgs.messages ?? []).map((m) => ({ role: m.role, text: m.text ?? m.content }))
  await api(`/api/threads/${thread.id}`, { method: 'DELETE' })
  return rec
}

const list = pick(scenarios())
console.log(`시나리오 ${list.length}개 → ${out}`)
let n = 0
// 같은 시나리오를 여러 번 (AI 답은 매번 달라서 한 번으로는 좋아졌는지 알기 어렵다). 두 번째부터 파일 이름 뒤에 ~2, ~3
const repeat = Math.max(1, Number(arg('repeat', '1')))
const jobs = list.flatMap((sc) => Array.from({ length: repeat }, (_, i) => [sc, i + 1]))
let stop = false
for (const [sc, round] of jobs) {
  if (stop) break
  n++
  const file = join(out, `${sc.id.replace(/[^\w.-]+/g, '_')}${round > 1 ? `~${round}` : ''}.json`)
  if (existsSync(file) && !flag('again')) continue
  process.stdout.write(
    `[${n}/${jobs.length}] ${sc.id}${round > 1 ? ` (${round}번째)` : ''} ${sc.ask.slice(0, 40)} … `,
  )
  try {
    const rec = await runOne(sc)
    rec.round = round
    writeFileSync(file, JSON.stringify(rec, null, 1))
    console.log(
      `${Math.round(rec.ms / 1000)}초 · 도구 ${rec.tools.length} · 승인 ${rec.approvals.length}${rec.errors.length ? ` · 오류 ${rec.errors.join('/')}` : ''}`,
    )
    if (rec.errors.some((e) => e.startsWith('limit'))) {
      console.log('사용 한도에 닿아 멈춰요')
      stop = true
    }
  } catch (e) {
    console.log(`실패: ${e.message}`)
  }
}
// 다른 시험 기록과 섞지 않게 고른 목록을 남긴다
writeFileSync(join(out, '_picked.json'), JSON.stringify(list.map((s) => s.id)))
