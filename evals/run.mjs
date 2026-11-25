// 3층 시험 (실제 AI·실제 사이트): 시나리오의 부탁을 두리 본체의 '따로 하는 대화'로 보내고, 과정(도구·승인·카드·답)을 기록한다.
// 결제·보내기는 하지 않는다: 이 시험 중에 생긴 승인 요청은 기록한 뒤 바로 거절한다. 대화는 끝나면 지운다 (메인 대화에 섞이지 않는다).
//
// 사용:
//   node evals/run.mjs --daemon http://127.0.0.1:8833 --token <화면 토큰> [고르기] [--out evals/out/<날짜>]
// 고르기: --ids a#1,b#2 | --where type=실행+승인,now=ok,pri=3 | --n 30 (가족마다 하나씩 고르게 섞음) --seed 1 | --per-family 1
// --repeat 3: 같은 시나리오를 세 번 (흔들림을 줄여 비교한다)
// 이미 기록이 있는 시나리오는 건너뛴다 (--again 이면 다시)
// Agent and model axis (ADR 0037): --agent claude|codex|opencode picks the AI of the test chat, --model <name> runs the
// requests on that model (test PC daemon only). Replay the same tape per model, then compare with evals/models.mjs
// Main conversation (ADR 0038): --main on|off sends each scenario to a fresh segment of the main conversation with task
// sessions on or off (test PC daemon only), so the conversation/task split runs as it does for the user. It follows the
// tasks the conversation starts until each ends or waits for the person, and records their tools and chats too
// A scenario's "seed.task" (a task_start spec with status working or needs-you, and what it is doing now) is put in
// place as a running task before the request, with --main on only. It never runs: what the conversation passes on to
// it (task_steer) and how it ended (task_stop) are recorded as seedTask
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EVALS, scenarios } from './lib/bank.mjs'

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 ? process.argv[i + 1] : d
}
const flag = (k) => process.argv.includes(`--${k}`)
let daemon = arg('daemon', 'http://127.0.0.1:8833')
// --token-file: 본체가 다시 켜지면 토큰이 바뀐다(다른 작업이 시험 PC를 다시 켤 수 있다). 그때 이 파일에서 다시 읽는다
// (본체 로그처럼 "토큰: …" 줄이 있으면 그 값, 아니면 파일 전체)
const tokenFile = arg('token-file')
// 시험 판(live.mjs)의 /tmp/dool2-live.json이면 {daemon, token}: 본체를 다시 켜면 포트도 바뀌니 주소도 같이 읽는다
const readToken = () => {
  if (!tokenFile || !existsSync(tokenFile)) return undefined
  const t = readFileSync(tokenFile, 'utf8')
  try {
    const j = JSON.parse(t)
    if (j?.token) {
      if (j.daemon && !process.argv.includes('--daemon')) daemon = j.daemon
      return j.token
    }
  } catch {}
  return (/토큰:\s*(\w+)/.exec(t)?.[1] ?? t.trim()) || undefined
}
let token = arg('token', process.env.DOOL2_TOKEN) ?? readToken()
if (!token) {
  console.error('화면 토큰이 필요해요: --token, --token-file 또는 DOOL2_TOKEN')
  process.exit(2)
}
const agent = arg('agent')
const model = arg('model')
const axis = [agent, model].filter(Boolean).join('-')
const out = arg(
  'out',
  join(
    EVALS,
    'out',
    `${new Date().toISOString().slice(0, 10)}${axis ? `-${axis.replace(/[^\w.-]+/g, '_')}` : ''}`,
  ),
)
// Layer 2 (needs a test PC daemon, DOOL2_DEV_RESET=1):
// --record keeps every tool answer of the run in the record (tape).
// --replay <dir> runs the scenarios that have a tape in <dir> again, with the daemon answering each tool call from
// the tape instead of running it. Sites, logins and the browser stay out of it, so the difference between two
// replays is the AI's judgment (after a persona, tool description or harness change).
const recordTape = flag('record')
const replayDir = arg('replay')
/** scenario id → tape entries recorded in the replay folder (first round of each) */
const tapes = new Map()
if (replayDir && !existsSync(replayDir)) {
  console.error(`No such folder: ${replayDir}`)
  process.exit(2)
}
if (replayDir)
  for (const f of readdirSync(replayDir)) {
    if (!f.endsWith('.json') || f.startsWith('_') || f.includes('~')) continue
    try {
      const rec = JSON.parse(readFileSync(join(replayDir, f), 'utf8'))
      if (rec?.id && Array.isArray(rec.tape) && rec.tape.length) tapes.set(rec.id, rec.tape)
    } catch {}
  }
if (replayDir && !tapes.size) {
  console.error(`No records with a tape in ${replayDir} (record them first with --record)`)
  process.exit(2)
}
/** Turns the daemon's tool tape on or off; fails loudly when the daemon is not a test PC */
async function tape(body) {
  const r = await api('/api/eval/tape', { method: 'POST', body: JSON.stringify(body) })
  if (r.status === 403) throw new Error('The tool tape needs a test PC daemon (DOOL2_DEV_RESET=1)')
  return r
}
/** Sets the model the daemon uses for the next requests (undefined: back to each agent's default) */
async function useModel(name) {
  const r = await api('/api/eval/model', {
    method: 'POST',
    body: JSON.stringify(name ? { model: name } : {}),
  })
  if (r.ok !== true)
    throw new Error(`--model needs a test PC daemon (DOOL2_DEV_RESET=1): ${r.error ?? r.text ?? r.status}`)
}
/** --main on|off: the main conversation with task sessions on or off (undefined: a separate chat, as before) */
const mainMode = arg('main')
if (mainMode !== undefined && mainMode !== 'on' && mainMode !== 'off') {
  console.error('--main takes on or off')
  process.exit(2)
}
/** A fresh main segment for the next scenario, task sessions on or off (null: back to the default) */
async function mainSegment(on) {
  const r = await api('/api/eval/segment', {
    method: 'POST',
    body: JSON.stringify({ taskSessions: on }),
  })
  if (r.ok !== true)
    throw new Error(
      `--main needs a test PC daemon (DOOL2_DEV_RESET=1) that is not busy: ${r.error ?? r.text ?? r.status}`,
    )
  return r
}
const ENDED = new Set(['done', 'stopped', 'failed', 'needs-you'])
/**
 * One scenario on the main conversation: send it, follow the live events of the conversation and of the tasks it
 * starts, and stop when the conversation is idle and every task ended or waits for the person
 */
async function followMain(sc, rec, started, signal, seededIds = new Set()) {
  const live = await fetch(`${daemon}/api/conversation/live`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  })
  const reader = live.body.getReader()
  const sent = await api('/api/conversation/messages', {
    method: 'POST',
    body: JSON.stringify({ text: sc.ask }),
  })
  if (sent.queued) rec.errors.push('queued')
  const taskThreads = new Map()
  let mainEnded = false
  const pump = (async () => {
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
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
        if (ev.kind === 'task') {
          if (seededIds.has(ev.task.id)) continue
          rec.tasks[ev.task.id] = ev.task
          taskThreads.set(ev.task.threadId, ev.task.id)
          continue
        }
        if (ev.kind !== 'turn' || ev.posted) continue
        // Side chats that are not this scenario's tasks (the feed) are not part of it
        const task = ev.side ? taskThreads.get(ev.threadId) : undefined
        if (ev.side && !task) continue
        const d = ev.event
        if (d.type === 'end' && !ev.side) mainEnded = true
        const e = d.type === 'agent' ? d.event : d
        const at = Date.now() - started.getTime()
        if (e.type === 'tool') rec.tools.push({ name: e.name, input: e.input, at, ...(task ? { task } : {}) })
        else if (e.type === 'tool_result') {
          const last = [...rec.tools]
            .reverse()
            .find((t) => t.ok === undefined && (!e.name || t.name === e.name) && t.task === task)
          if (last) last.ok = e.ok
        } else if (e.type === 'error') rec.errors.push(`${e.code}: ${e.message}`)
        else if (e.type === 'limit_reached') rec.errors.push(`limit: ${e.message}`)
        else if (e.type === 'cost') rec.cost = e
      }
    }
  })().catch(() => {})
  try {
    for (;;) {
      if (signal.aborted) break
      await new Promise((ok) => setTimeout(ok, 1000))
      if (!mainEnded) continue
      const s = await api('/api/conversation?limit=1')
      const mine = (s.tasks ?? []).filter(
        (t) => Date.parse(t.createdAt) >= started.getTime() && !seededIds.has(t.id),
      )
      for (const t of mine) rec.tasks[t.id] = t
      if (!s.busy && mine.every((t) => ENDED.has(t.status))) break
    }
  } finally {
    await reader.cancel().catch(() => {})
    await pump
  }
}
const timeoutMs = Number(arg('timeout', '420')) * 1000
mkdirSync(out, { recursive: true })

// 본체 요청은 1분 안에 답이 와야 한다 (본체가 다른 작업 중에 다시 켜지면 열린 요청이 끝없이 매달렸다. 실측 1시간 45분)
const api = async (path, init = {}) => {
  const r = await fetch(daemon + path, {
    signal: AbortSignal.timeout(60_000),
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (r.status === 401) throw new Error('본체가 토큰을 받지 않아요(401)')
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

// 시험이 PC에 만든 파일(file_write)은 지우지 않고 따로 옮겨 둔다 (같은 PC의 본체만, --keep-files면 그대로)
const FOLDERS = ['Desktop', 'Documents', 'Downloads'].map((d) => join(homedir(), d))
// 맥에서 바탕화면·문서·다운로드 읽기는 권한 확인 창이 뜨면 누가 누를 때까지 멈춘다(실측: 사람 없는 맥에서 1단계가 30분 넘게 멈춤).
// 그래서 따로(비동기로) 읽고 5초 안에 안 되면 이번 실행 동안 파일 옮기기는 건너뛴다
let filesOk = true
// 폴더 목록은 따로 띄운 ls로 읽는다: 권한 창에 막혀도 그 ls만 버리면 된다 (같은 프로세스에서 읽으면 막힌 읽기 때문에
// 프로세스가 끝나지도 못했다. 실측)
const lsDir = (d) =>
  new Promise((ok) => {
    const child = execFile('/bin/ls', ['-1', d], { timeout: 5_000, killSignal: 'SIGKILL' }, (err, out) =>
      ok(
        err
          ? null
          : out
              .split('\n')
              .filter(Boolean)
              .map((n) => join(d, n)),
      ),
    )
    child.unref()
  })
const listFiles = async () => {
  if (!filesOk) return new Set()
  const r = await Promise.all(FOLDERS.map((d) => (existsSync(d) ? lsDir(d) : [])))
  if (r.some((x) => x === null)) {
    filesOk = false
    console.log('\n(바탕화면·문서·다운로드를 못 읽어서(맥 권한 창?) 시험이 만든 파일 옮기기는 건너뛰어요)')
    return new Set()
  }
  return new Set(r.flat())
}
/** 파일을 다루는 시나리오만 폴더를 본다 (그 밖에는 권한 창을 부를 일이 없게) */
const touchesFiles = (sc) =>
  /PC·파일|회사·문서/.test(sc.cat ?? '') ||
  /file_|파일|폴더|사진|PDF|엑셀/.test(`${sc.tools ?? ''} ${sc.ask}`)
const local = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(daemon) && !flag('keep-files')

/** 시나리오 상황의 "기억: …"을 뽑는다 (시험 전에 넣었다가 끝나면 지운다) */
export function seedMemories(ctx) {
  return [...String(ctx ?? '').matchAll(/기억:\s*([^/()]+?)\s*(?:\)|\/|$)/g)]
    .map((m) => m[1].trim())
    .filter((t) => t.length >= 2)
}

async function runOne(sc) {
  // 시나리오가 가정한 기억을 먼저 넣는다 (시험 PC에 없던 기억 때문에 깎이지 않게)
  const seeded = []
  for (const text of seedMemories(sc.ctx)) {
    const r = await api('/api/life/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'memory-add', text }),
    })
    if (r.id) seeded.push({ id: r.id, text })
  }
  const files = local && touchesFiles(sc)
  const filesBefore = files ? await listFiles() : new Set()
  const before = await lifeIds()
  // 시험 전부터 떠 있던 카드(인증번호·내 정보)는 이 시나리오 것이 아니다
  const infoBefore = new Set(((await api('/api/info')).requests ?? []).map((q) => q.id))
  const started = new Date()
  const { thread, error } = mainMode
    ? { thread: { id: 'main', agent }, ...(await mainSegment(mainMode === 'on')) }
    : await api('/api/threads', {
        method: 'POST',
        body: JSON.stringify({ side: true, ...(agent ? { agent } : {}) }),
      })
  if (!thread?.id) throw new Error(`대화를 만들지 못했어요${error ? `: ${error}` : ''}`)
  // The task the scenario says is already running (only where tasks exist: the main conversation, task sessions on)
  let seedTask
  if (sc.seed?.task && mainMode === 'on') {
    const r = await api('/api/eval/task', { method: 'POST', body: JSON.stringify(sc.seed.task) })
    if (!r.task?.id)
      throw new Error(`Could not put the scenario's task in place: ${r.error ?? r.text ?? r.status}`)
    seedTask = r.task
  }
  const rec = {
    id: sc.id,
    scenario: sc,
    agent: thread.agent ?? agent,
    ...(model ? { model } : {}),
    startedAt: started.toISOString(),
    thread: thread.id,
    ...(mainMode ? { main: mainMode, tasks: {} } : {}),
    ...(sc.seed?.task && !seedTask
      ? { seedSkipped: 'the scenario needs a running task: run it with --main on' }
      : {}),
    tools: [],
    text: '',
    errors: [],
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => {
    rec.errors.push('timeout')
    if (mainMode) {
      void api('/api/conversation/cancel', { method: 'POST' })
      for (const t of Object.values(rec.tasks ?? {})) void api(`/api/tasks/${t.id}/stop`, { method: 'POST' })
    } else void api(`/api/threads/${thread.id}/cancel`, { method: 'POST' })
    ctl.abort()
  }, timeoutMs)
  if (replayDir) await tape({ mode: 'replay', entries: tapes.get(sc.id) })
  else if (recordTape) await tape({ mode: 'record' })
  try {
    if (mainMode) await followMain(sc, rec, started, ctl.signal, new Set(seedTask ? [seedTask.id] : []))
    else {
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
    }
  } catch (e) {
    if (!ctl.signal.aborted) rec.errors.push(String(e.message ?? e))
  } finally {
    clearTimeout(timer)
  }
  rec.ms = Date.now() - started.getTime()
  if (seedTask) {
    // How the seeded task ended up, and what it was told, then it ends so it does not hold the browser
    const r = await api(`/api/eval/task/${seedTask.id}`)
    rec.seedTask = {
      id: seedTask.id,
      before: { status: seedTask.status, now: seedTask.now },
      after: r.task ? { status: r.task.status, notes: r.task.notes ?? 0 } : undefined,
      told: r.told ?? [],
    }
    if (r.task && !['done', 'stopped', 'failed'].includes(r.task.status))
      await api(`/api/tasks/${seedTask.id}/stop`, { method: 'POST' })
  }
  let replayApprovals
  if (replayDir || recordTape) {
    const t = await tape({ mode: 'off' })
    if (recordTape) rec.tape = t.entries ?? []
    else {
      rec.layer = 2
      rec.replay = {
        from: replayDir,
        replayed: (t.replayed ?? []).length,
        loose: (t.replayed ?? []).filter((x) => x.match === 'loose').length,
        missed: t.missed ?? [],
      }
      // Nothing really ran, so approvals come from the replayed calls that created one when recorded
      replayApprovals = (t.replayed ?? []).flatMap((x) => x.approvals ?? [])
    }
  }
  // 이 대화 동안 생긴 승인 요청: 기록하고, 기다리는 것은 거절한다 (시험에서는 결제·보내기를 하지 않는다)
  const { approvals = [] } = await api('/api/approvals')
  // 같이 도는 다른 시나리오의 승인은 빼고: 이 대화가 다룬 탭의 승인만
  const myTabs = new Set(rec.tools.map((t) => t.input?.tabId).filter((x) => typeof x === 'number'))
  const myWhats = new Set(
    rec.tools.filter((t) => /request_approval$/.test(t.name)).map((t) => String(t.input?.what ?? '')),
  )
  rec.approvals = approvals
    .filter((a) => Date.parse(a.createdAt) >= started.getTime())
    .filter((a) => concurrency === 1 || myTabs.has(a.tabId) || myWhats.has(String(a.what ?? '')))
    .map(({ shot: _s, ...a }) => a)
  if (replayApprovals) rec.approvals = replayApprovals
  for (const a of rec.approvals)
    if (a.status === 'pending')
      await api(`/api/approvals/${a.id}`, { method: 'POST', body: JSON.stringify({ decision: 'reject' }) })
  // 이 대화 동안 생긴 정보 요청(인증번호·내 정보 카드)
  const info = await api('/api/info')
  rec.info = (info.requests ?? []).filter((q) => !infoBefore.has(q.id))
  rec.infoFresh = true
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
  if (files) {
    rec.created.files = []
    const keep = join(out, '_files', sc.id.replace(/[^\w.-]+/g, '_'))
    for (const p of await listFiles()) {
      if (filesBefore.has(p)) continue
      mkdirSync(keep, { recursive: true })
      const to = join(keep, p.split('/').pop())
      renameSync(p, to)
      rec.created.files.push({ from: p, to })
    }
  }
  for (const m of seeded)
    await api('/api/life/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'memory-delete', id: m.id }),
    })
  rec.seeded = seeded.map((m) => m.text)
  const s2 = await api('/api/life')
  rec.created.feed = (s2.feed ?? []).filter((x) => !before.feed.has(x.id))
  if (mainMode) {
    // What the person saw in the conversation since the scenario began (answers, cards, each task's one result), and
    // each task's own chat apart
    const conv = await api('/api/conversation?limit=200')
    const since = (conv.messages ?? []).filter((m) => Date.parse(m.createdAt) >= started.getTime())
    rec.thread = since[0]?.threadId ?? rec.thread
    rec.messages = since.map((m) => ({ role: m.role, text: m.text }))
    const answers = since.filter((m) => m.role === 'assistant')
    rec.final = answers.at(-1)?.text
    rec.text = answers.map((m) => m.text).join('\n\n')
    rec.tasks = Object.values(rec.tasks)
    rec.taskMessages = {}
    for (const t of rec.tasks) {
      const d = await api(`/api/threads/${t.threadId}`)
      rec.taskMessages[t.id] = (d.messages ?? []).map((m) => ({ role: m.role, text: m.text }))
    }
  } else {
    const msgs = await api(`/api/threads/${thread.id}`)
    rec.messages = (msgs.messages ?? []).map((m) => ({ role: m.role, text: m.text ?? m.content }))
  }
  // How many times the before-finishing check sent the work back (its notes are app notes with this marker)
  rec.sentBack = [rec.messages, ...Object.values(rec.taskMessages ?? {})]
    .flat()
    .filter((m) => m.role === 'user' && String(m.text).includes('(Check before finishing)')).length
  // The main conversation is the test PC's own; each scenario got a fresh segment instead
  if (!mainMode) await api(`/api/threads/${thread.id}`, { method: 'DELETE' })
  return rec
}

/**
 * 본체가 꺼졌거나 다시 켜져 토큰이 바뀌었을 때: 새 토큰을 읽으며 최대 10분 기다린다.
 * 돌아오면 true(그 시나리오를 다시 돌린다), 아니면 false(실패 기록을 쌓지 않고 멈춘다)
 */
async function waitDaemon() {
  for (let i = 0; i < 60; i++) {
    token = readToken() ?? token
    try {
      const r = await fetch(`${daemon}/api/life`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (r.ok) return true
    } catch {}
    await new Promise((ok) => setTimeout(ok, 10_000))
  }
  return false
}
const DOWN = /fetch failed|ECONNREFUSED|401|socket|terminated|aborted|timeout/i

const list = pick(scenarios().filter((s) => !replayDir || tapes.has(s.id)))
console.log(`시나리오 ${list.length}개 → ${out}${axis ? ` (${axis})` : ''}`)
if (model) await useModel(model)
let n = 0
// 같은 시나리오를 여러 번 (AI 답은 매번 달라서 한 번으로는 좋아졌는지 알기 어렵다). 두 번째부터 파일 이름 뒤에 ~2, ~3
const repeat = Math.max(1, Number(arg('repeat', '1')))
const jobs = list.flatMap((sc) => Array.from({ length: repeat }, (_, i) => [sc, i + 1]))
let stop = false
const retried = new Set()
// 여러 개를 같이 돌린다 (따로 하는 대화를 동시에 N개). 기본 1
const concurrency = Math.max(1, Number(arg('concurrency', '1')))
// The tape is one per daemon, so recording or replaying runs one scenario at a time
if (mainMode && concurrency > 1) {
  console.error('--main runs one scenario at a time (there is one main conversation)')
  process.exit(2)
}
if ((recordTape || replayDir) && concurrency > 1) {
  console.error('--record and --replay run one scenario at a time (leave out --concurrency)')
  process.exit(2)
}
const queue = [...jobs]
async function runJob(job) {
  const [sc, round] = job
  n++
  const file = join(out, `${sc.id.replace(/[^\w.-]+/g, '_')}${round > 1 ? `~${round}` : ''}.json`)
  if (existsSync(file) && !flag('again')) return
  const head = `[${n}/${jobs.length}] ${sc.id}${round > 1 ? ` (${round}번째)` : ''} ${sc.ask.slice(0, 40)} … `
  if (concurrency === 1) process.stdout.write(head)
  const say = (t) => console.log(concurrency === 1 ? t : `${head}${t}`)
  try {
    // 시나리오 하나 전체에도 끝을 둔다 (대화 시간 + 앞뒤 정리 3분). 넘으면 본체가 멈춘 것으로 본다
    let watchdog
    const rec = await Promise.race([
      runOne(sc),
      new Promise((_, no) => {
        watchdog = setTimeout(
          () => no(new Error('socket: 시나리오가 끝나지 않아요(본체 멈춤)')),
          timeoutMs + 180_000,
        )
      }),
    ]).finally(() => clearTimeout(watchdog))
    // 두리가 "본체에 닿지 않아요"로 끝났으면 시험 PC가 버거웠던 것(메모리 부족 등): 두리 판단으로 셈하지 않고 다시 돌린다
    const said = rec.final || rec.text || ''
    const toolFails = rec.tools.filter((t) => t.ok === false).length
    if (
      toolFails >= 3 &&
      /본체(에|와|가)?\s*(요청이|연결이|연결)?\s*.{0,12}(닿지|안 돼|끊|응답하지)|시간 초과로\s*(끊|끝)/.test(
        said,
      )
    )
      throw new Error('socket: 시험 판 본체가 버거워 도구가 시간 초과로 끊김(기록하지 않고 다시)')
    rec.round = round
    if (concurrency > 1) rec.concurrency = concurrency
    writeFileSync(file, JSON.stringify(rec, null, 1))
    say(
      `${Math.round(rec.ms / 1000)}초 · 도구 ${rec.tools.length} · 승인 ${rec.approvals.length}${rec.errors.length ? ` · 오류 ${rec.errors.join('/')}` : ''}`,
    )
    if (rec.errors.some((e) => e.startsWith('limit'))) {
      console.log('사용 한도에 닿아 멈춰요')
      stop = true
    }
  } catch (e) {
    say(`실패: ${e.message}`)
    // 본체가 꺼졌거나 다시 켜졌다: 기다렸다가 같은 시나리오를 다시 (기록은 남기지 않았으니 다음 실행에서도 다시 돈다)
    if (DOWN.test(String(e.message))) {
      console.log('본체가 응답하지 않아요. 다시 켜질 때까지 기다려요(최대 10분)')
      if (!(await waitDaemon())) {
        console.log('본체가 돌아오지 않아 멈춰요. 다시 부르면 남은 것부터 이어서 해요')
        stop = true
      } else {
        console.log('본체가 돌아왔어요. 이어서 해요')
        // 한 번만 다시 (그 시나리오가 본체를 넘어뜨리는 것이면 되풀이하지 않게)
        if (!retried.has(file)) {
          retried.add(file)
          queue.unshift([sc, round])
        }
      }
    }
  }
}
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (!stop && queue.length) await runJob(queue.shift())
  }),
)
// 다른 시험 기록과 섞지 않게 고른 목록을 남긴다
writeFileSync(join(out, '_picked.json'), JSON.stringify(list.map((s) => s.id)))
// Leave the daemon on its default model for whatever runs next
if (model) await useModel(undefined).catch(() => {})
// …and task sessions as the build's default
if (mainMode) await mainSegment(null).catch(() => {})
// 권한 창에 막힌 폴더 읽기가 남아 있으면 프로세스가 끝나지 않는다: 일이 끝났으면 나간다
process.exit(0)
