#!/usr/bin/env node
// Self-improve loop runner (.claude/skills/self-improve): sends scenarios one at a time to a running Dool2 daemon's
// main conversation (the one the maintainer watches on the phone), waits for each to settle, and writes one compact
// row per scenario: time, tools, finish-check verdicts, replies the person sees, and the answer (emails masked).
//
//   node scripts/loop/run.mjs <scenarios.json> <out.json> [--from N] [--to N] [--api <api.json>] [--data <data dir>]
//
// scenarios.json: [{ "q": "...", "area": "lookup", "pick": true }] (pick: answer a choice card on the phone, such as
// which Google account: true takes the first option, a string the first option that starts with it).
// api.json: { "url", "token" } of the daemon (the test PC writes it via DOOL2_API_INFO). Default $DOOL2_LOOP_API.
// data dir: the daemon's data folder, for its logs. Default $DOOL2_DATA_DIR.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    api: { type: 'string' },
    data: { type: 'string' },
    timeout: { type: 'string' },
  },
})
const [scenFile, outFile] = positionals
if (!scenFile || !outFile) {
  console.error(
    'usage: node scripts/loop/run.mjs <scenarios.json> <out.json> [--from N] [--to N] [--api f] [--data d]',
  )
  process.exit(1)
}
const expand = (p) => p?.replace(/^~(?=\/)/, homedir())
const apiFile = expand(values.api ?? process.env.DOOL2_LOOP_API)
const dataDir = expand(values.data ?? process.env.DOOL2_DATA_DIR)
if (!apiFile || !existsSync(apiFile)) {
  console.error(
    'Give the daemon address and screen token: --api <file with {"url","token"}> or DOOL2_LOOP_API',
  )
  process.exit(1)
}
const from = Number(values.from ?? 1)
const to = Number(values.to ?? 9999)
const limitMs = Number(values.timeout ?? 480) * 1000

const scenarios = JSON.parse(readFileSync(scenFile, 'utf8')).map((s) =>
  Array.isArray(s) ? { q: s[0], pick: s[1] ?? undefined } : s,
)

async function call(method, path, body) {
  const { url, token } = JSON.parse(readFileSync(apiFile, 'utf8'))
  const r = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const t = await r.text()
  return t ? JSON.parse(t) : {}
}

/** Journal lines since a time (the daemon writes one file per local day) */
function logsSince(iso) {
  if (!dataDir) return []
  const day = new Date().toLocaleDateString('sv-SE')
  const f = join(dataDir, 'logs', `${day}.jsonl`)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .flatMap((l) => {
      try {
        const d = JSON.parse(l)
        return d.at >= iso ? [d] : []
      } catch {
        return []
      }
    })
}

const mask = (s) => s.replace(/([A-Za-z0-9._-])[A-Za-z0-9._-]*@/g, '$1***@')
const CHECK_NOTE = '(Check before finishing)'

/** Replies the person sees: a later answer replaces one sent back by the check, a task's result its hand-over */
function visibleCount(msgs) {
  let shown = []
  let folded = false
  let taskOpen = false
  let acks = []
  for (const m of msgs) {
    if (m.role === 'user' && m.text.includes(CHECK_NOTE)) {
      folded = true
      continue
    }
    if (m.role === 'tool' && m.text.startsWith('{"kind":"task"')) {
      taskOpen = true
      acks = []
      continue
    }
    if (m.role !== 'assistant') continue
    if (folded) {
      shown = []
      folded = false
    }
    if (taskOpen && acks.length) {
      shown = shown.filter((id) => !acks.includes(id))
      taskOpen = false
      acks = []
    } else if (taskOpen) acks.push(m.id)
    shown.push(m.id)
  }
  return shown.length
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows =
  existsSync(outFile) && from > 1 ? JSON.parse(readFileSync(outFile, 'utf8')).filter((r) => r.n < from) : []

for (const [i, s] of scenarios.entries()) {
  const n = i + 1
  if (n < from || n > to) continue
  const startIso = new Date().toISOString()
  const t0 = Date.now()
  const before = (await call('GET', '/api/conversation')).messages ?? []
  const lastId = before.at(-1)?.id
  await call('POST', '/api/conversation/messages', { text: s.q })
  let idle = 0
  let picked = false
  let fresh = []
  let requests = []
  while (Date.now() - t0 < limitMs) {
    await sleep(4000)
    const c = await call('GET', '/api/conversation')
    const ids = c.messages.map((m) => m.id)
    fresh = lastId && ids.includes(lastId) ? c.messages.slice(ids.indexOf(lastId) + 1) : c.messages.slice(-4)
    requests = (await call('GET', '/api/info')).requests ?? []
    if (requests.length && s.pick && !picked) {
      const opts = requests[0].options ?? []
      const opt = s.pick === true ? opts[0] : opts.find((o) => o.startsWith(String(s.pick)))
      if (opt) {
        await call('POST', `/api/info/${requests[0].id}`, { value: opt })
        picked = true
        continue
      }
    }
    const running = (c.tasks ?? []).some((t) => ['working', 'waiting', 'checking'].includes(t.status))
    idle = !c.busy && !running ? idle + 1 : 0
    const answered = fresh.some((m) => m.role === 'assistant')
    if (idle >= 2 && answered && (!s.pick || picked || !requests.length)) break
    if (idle >= 3 && requests.length) break
  }
  const ev = logsSince(startIso)
  const answers = fresh.filter((m) => m.role === 'assistant').map((m) => m.text)
  const full = mask(answers.join('\n---\n') || '(no answer)').slice(0, 2500)
  const row = {
    n,
    q: s.q,
    secs: Math.round((Date.now() - t0) / 1000),
    tools: ev
      .filter((d) => d.kind === 'turn')
      .flatMap((d) => d.tools ?? [])
      .slice(0, 14),
    checks: ev.filter((d) => d.kind === 'finish-check' && d.result !== 'skip').map((d) => d.result),
    answers: answers.length,
    visible: visibleCount(fresh),
    waiting: requests.map((r) => String(r.label ?? '').slice(0, 40)),
    full,
  }
  rows.push(row)
  const { full: _, ...brief } = row
  console.log(JSON.stringify({ ...brief, start: full.replace(/\n/g, ' ').slice(0, 200) }))
  writeFileSync(outFile, JSON.stringify(rows, null, 1))
}
const one = rows.filter((r) => r.visible === 1).length
console.log(`done: ${rows.length} scenarios, ${one} answered in one visible reply`)
