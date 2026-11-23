#!/usr/bin/env node
// Connection test: with real accounts, connect each service -> check login -> run the tools that need login, and
// write the results to a table.
//
// Only asks a running Dool2 daemon (desktop app or test PC) over HTTP. Passwords never pass through this script:
// the daemon logs in again with the account the user put once on the app's connect card (vault)
// (POST /api/connections/<id>/relogin).
//
//   node scripts/connect-test.mjs --sheet sheet.csv          # every service marked 'has account: O' in the sheet
//   node scripts/connect-test.mjs kurly musinsa --method kurly=kakao
//   options: --base http://127.0.0.1:8833  --token <daemon token>  --tool-token <tool token>  --no-login (check only, no login attempt)
//
// Safeguards
// - At most 2 login attempts per service per day so accounts do not get locked (~/.dool2-connect-test/attempts.json)
// - By default only lookup tools run. fill (e.g. add to cart), pay and contact tools can fill in text or change state
//   on the site, so they run only with --deep, and even then tools that end in approve are skipped (an approval
//   request would pop up on the phone)
//   (in the first test, the Threads "prepare a post" tool filled sample text into the real compose box)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HANDOFF_RE, PROVIDERS_KO, SHEET_COLUMNS } from './region/kr/connect-test.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(homedir(), '.dool2-connect-test')
const MAX_TRIES_PER_DAY = 2
const DEFAULT_METHOD = 'ID/password'
const LOGGED_IN = 'logged in'
const ALREADY = 'already logged in'
const SKIPPED = 'skipped'
const REACHED = 'reached the page'
const OK = 'ok'
const passed = (outcome) => outcome === OK || outcome === REACHED
const PROVIDERS = { ...PROVIDERS_KO, kakao: 'kakao', naver: 'naver', google: 'google', apple: 'apple' }

const argv = process.argv.slice(2)
const opt = (k) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : undefined
}
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const valued = new Set(['--base', '--token', '--tool-token', '--sheet', '--method', '--report'])
const ids = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]))
const base = opt('--base') ?? 'http://127.0.0.1:8833'
const token = opt('--token') ?? process.env.DOOL2_TOKEN
const toolToken = opt('--tool-token') ?? process.env.DOOL2_TOOL_TOKEN ?? token
if (!token) {
  console.error('Daemon token required: --token or DOOL2_TOKEN')
  process.exit(2)
}

async function api(path, { method = 'GET', body, tool = false, timeoutMs = 180_000 } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${tool ? toolToken : token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  try {
    return { status: r.status, ...JSON.parse(text) }
  } catch {
    return { status: r.status, error: text.slice(0, 200) }
  }
}

// ── Sheet (CSV: service, has account, login method, 2FA, memo) ──
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') q = false
      else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows
}

const services = (await api('/api/connections')).services ?? []
const byName = new Map(services.map((s) => [s.card.name, s]))
const byId = new Map(services.map((s) => [s.card.id, s]))

/** id → { method, twoFactor, memo } */
const plan = new Map()
const sheet = opt('--sheet')
if (sheet) {
  const [head, ...rows] = parseCsv(readFileSync(sheet, 'utf8').replace(/^﻿/, ''))
  const col = (name) => head.findIndex((h) => h.startsWith(name))
  const [cName, cHas, cMethod, cTwo, cMemo] = SHEET_COLUMNS.map(col)
  for (const r of rows) {
    const s = byName.get(r[cName]?.trim())
    if (!s || !/^o$/i.test(r[cHas]?.trim() ?? '')) continue
    plan.set(s.card.id, {
      method: r[cMethod]?.trim() || DEFAULT_METHOD,
      twoFactor: r[cTwo]?.trim(),
      memo: r[cMemo]?.trim(),
    })
  }
}
for (const id of ids) if (byId.has(id) && !plan.has(id)) plan.set(id, { method: DEFAULT_METHOD })
for (const m of (opt('--method') ?? '').split(',').filter(Boolean)) {
  const [id, method] = m.split('=')
  if (plan.has(id)) plan.get(id).method = method
}
if (!plan.size) {
  console.error('No services to test (--sheet or service ids)')
  process.exit(2)
}

// ── Login attempts per day ──
mkdirSync(OUT, { recursive: true })
const triesFile = join(OUT, 'attempts.json')
const tries = existsSync(triesFile) ? JSON.parse(readFileSync(triesFile, 'utf8')) : {}
const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
const triedToday = (id) => (tries[id] ?? []).filter((d) => d === today).length
const noteTry = (id) => {
  tries[id] = [...(tries[id] ?? []).filter((d) => d >= today), today]
  writeFileSync(triesFile, JSON.stringify(tries, null, 2))
}

// ── Connector tools ──
function toolsOf(id) {
  const f = join(ROOT, 'skills', id, 'tools.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).tools : []
}
const name = (id, t) => `${id.replace(/-/g, '_')}_${t}`

const results = []
for (const [id, p] of plan) {
  const s = byId.get(id)
  const card = s.card
  const row = {
    id,
    name: card.name,
    method: p.method,
    twoFactor: p.twoFactor,
    connect: '',
    detail: '',
    tools: [],
  }
  results.push(row)
  process.stdout.write(`\n■ ${card.name} (${id}, ${p.method}) `)
  if (card.how === 'device' || (card.how === 'official' && !toolsOf(id).length)) {
    row.connect = 'n/a'
    row.detail = card.how === 'device' ? 'turned on with phone permissions' : 'official connection (OAuth)'
    console.log(row.connect)
    continue
  }

  // 1) Already logged in?
  let v = await api(`/api/connections/${id}/verify`, { method: 'POST' })
  if (v.ok) row.connect = ALREADY
  else if (flags.has('--no-login')) row.connect = 'not logged in (no attempt)'
  else if (triedToday(id) >= MAX_TRIES_PER_DAY)
    row.connect = `used all ${MAX_TRIES_PER_DAY} login attempts today`
  else {
    // 2) Log in: with the provider for social login, otherwise with the vault account
    noteTry(id)
    const provider = PROVIDERS[p.method]
    const r = provider
      ? await api(`/api/connections/${id}/social`, { method: 'POST', body: { provider } })
      : await api(`/api/connections/${id}/relogin`, { method: 'POST' })
    if (r.ok) row.connect = LOGGED_IN
    else if (r.status === 404) row.connect = "no account in the vault (add it once on the app's connect card)"
    else if (r.reason === 'human' || r.human) row.connect = "person's turn"
    else if (r.reason === 'wrong') row.connect = 'wrong ID or password'
    else row.connect = 'login failed'
    row.detail = r.message ?? r.error ?? ''
    if (!r.ok) {
      // The page may be logged in and only the check was wrong
      v = await api(`/api/connections/${id}/verify`, { method: 'POST' })
      if (v.ok) row.connect += ' -> logged in after all (fix the check)'
    } else v = { ok: true }
  }
  console.log(`${row.connect}${row.detail ? ` · ${row.detail}` : ''}`)
  if (!v.ok) continue

  // 3) Tools that need login
  for (const t of toolsOf(id)) {
    if (!t.login) continue
    if (t.tier !== 'lookup' && !flags.has('--deep')) {
      row.tools.push({
        tool: name(id, t.name),
        title: t.title,
        outcome: SKIPPED,
        note: `${t.tier} tool (only with --deep)`,
      })
      continue
    }
    if (t.steps.some((st) => 'approve' in st)) {
      row.tools.push({
        tool: name(id, t.name),
        title: t.title,
        outcome: SKIPPED,
        note: 'tool ends in approval',
      })
      continue
    }
    for (const ex of t.examples.slice(0, 1)) {
      const t0 = Date.now()
      const r = await api('/api/tools/service/call', {
        method: 'POST',
        tool: true,
        body: { tool: name(id, t.name), input: ex },
      })
      const text = (r.content ?? []).map((c) => c.text ?? '').join('\n')
      const list = Object.values(r.structuredContent ?? {}).find(Array.isArray)
      const handoff = HANDOFF_RE.test(text) && !r.isError
      const outcome = r.isError
        ? 'failed'
        : r.structuredContent?.blocked
          ? 'blocked by site'
          : r.structuredContent?.stopped
            ? 'stopped'
            : handoff
              ? REACHED
              : OK
      row.tools.push({
        tool: name(id, t.name),
        title: t.title,
        input: ex,
        outcome,
        rows: list?.length,
        ms: Date.now() - t0,
        note: text.split('\n')[0].slice(0, 160),
      })
      console.log(
        `   ${passed(outcome) ? '✓' : '✗'} ${t.title} ${outcome}${list ? ` ${list.length} rows` : ''} — ${text.split('\n')[0].slice(0, 100)}`,
      )
    }
  }
}

// ── Results ──
const at = new Date().toISOString()
writeFileSync(join(OUT, `${today}.json`), JSON.stringify({ at, results }, null, 2))
const esc = (x) =>
  String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const good = (c) => c === LOGGED_IN || c === ALREADY
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dool2 connection test</title>
<style>body{font:14px -apple-system,sans-serif;margin:24px;background:#111318;color:#e8e8ea}h1{font-size:20px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #2a2d35;padding:6px 8px;text-align:left;vertical-align:top}
.ok{color:#7ee2b8}.bad{color:#ffb4a8}.sum{color:#a8acb6;margin:8px 0 16px}small{color:#a8acb6}</style></head><body>
<h1>Dool2 connection test</h1><p class="sum">${esc(at)} · ${results.length} services · ${results.filter((r) => good(r.connect)).length} connected</p>
<table><tr><th>Service</th><th>Login method</th><th>Connection</th><th>Tools needing login</th></tr>${results
  .map(
    (r) =>
      `<tr><td>${esc(r.name)}<br><small>${esc(r.id)}</small></td><td>${esc(r.method)}${r.twoFactor ? `<br><small>2FA: ${esc(r.twoFactor)}</small>` : ''}</td><td class="${good(r.connect) ? 'ok' : 'bad'}">${esc(r.connect)}${r.detail ? `<br><small>${esc(r.detail)}</small>` : ''}</td><td>${r.tools
        .map(
          (t) =>
            `<div class="${passed(t.outcome) ? 'ok' : t.outcome === SKIPPED ? '' : 'bad'}">${esc(t.title)} · ${esc(t.outcome)}${t.rows !== undefined ? ` · ${t.rows} rows` : ''}${t.ms ? ` · ${(t.ms / 1000).toFixed(1)}s` : ''}<br><small>${esc(t.note)}</small></div>`,
        )
        .join('')}</td></tr>`,
  )
  .join('')}</table></body></html>`
const report = opt('--report') ?? join(OUT, 'latest.html')
writeFileSync(report, html)
console.log(`\nReport: ${report}`)
