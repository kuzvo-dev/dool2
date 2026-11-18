#!/usr/bin/env node
// 연결 시험: 실제 계정으로 서비스마다 연결 → 로그인 확인 → 로그인이 필요한 도구를 돌려 보고 표로 남긴다.
//
// 돌고 있는 두리 본체(PC 앱·시험 PC)에 HTTP로 묻기만 한다. 비밀번호는 이 스크립트를 지나지 않는다:
// 사용자가 앱의 연결 카드에 한 번 넣은 계정(금고)으로 본체가 다시 로그인한다 (POST /api/connections/<id>/relogin).
//
//   node scripts/connect-test.mjs --sheet 시트.csv            # 시트에서 '계정 있음 O'인 서비스 전부
//   node scripts/connect-test.mjs kurly musinsa --method kurly=카카오
//   옵션: --base http://127.0.0.1:8833  --token <본체 토큰>  --tool-token <도구 토큰>  --no-login(로그인 시도 없이 확인만)
//
// 지키는 것
// - 계정이 잠기지 않게 서비스마다 하루 로그인 시도 2번까지 (~/.dool2-connect-test/attempts.json)
// - 기본은 찾아보기 도구만 돌린다. 채워 두기(장바구니 담기 등)·돈 내기·연락하기는 사이트에 글을 채우거나
//   상태를 바꿀 수 있어서 --deep일 때만, 그때도 승인(approve)으로 끝나는 도구는 돌리지 않는다(폰에 승인 요청이 뜬다)
//   (처음 시험에서 스레드 '글 올리기 준비'가 진짜 글쓰기 창에 예시 글을 채웠다)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(homedir(), '.dool2-connect-test')
const MAX_TRIES_PER_DAY = 2
const PROVIDERS = { 카카오: 'kakao', 네이버: 'naver', 구글: 'google', 애플: 'apple' }

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
  console.error('본체 토큰이 필요해요: --token 또는 DOOL2_TOKEN')
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

// ── 시트 (CSV: 서비스·계정 있음·쓰는 로그인 방식·2단계 인증·메모) ──
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
  const [cName, cHas, cMethod, cTwo, cMemo] = [
    '서비스',
    '계정 있음',
    '쓰는 로그인 방식',
    '2단계',
    '메모',
  ].map(col)
  for (const r of rows) {
    const s = byName.get(r[cName]?.trim())
    if (!s || !/^o$/i.test(r[cHas]?.trim() ?? '')) continue
    plan.set(s.card.id, {
      method: r[cMethod]?.trim() || '아이디',
      twoFactor: r[cTwo]?.trim(),
      memo: r[cMemo]?.trim(),
    })
  }
}
for (const id of ids) if (byId.has(id) && !plan.has(id)) plan.set(id, { method: '아이디' })
for (const m of (opt('--method') ?? '').split(',').filter(Boolean)) {
  const [id, method] = m.split('=')
  if (plan.has(id)) plan.get(id).method = method
}
if (!plan.size) {
  console.error('시험할 서비스가 없어요 (--sheet 또는 서비스 id)')
  process.exit(2)
}

// ── 하루 로그인 시도 수 ──
mkdirSync(OUT, { recursive: true })
const triesFile = join(OUT, 'attempts.json')
const tries = existsSync(triesFile) ? JSON.parse(readFileSync(triesFile, 'utf8')) : {}
const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
const triedToday = (id) => (tries[id] ?? []).filter((d) => d === today).length
const noteTry = (id) => {
  tries[id] = [...(tries[id] ?? []).filter((d) => d >= today), today]
  writeFileSync(triesFile, JSON.stringify(tries, null, 2))
}

// ── 커넥터 도구 ──
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
    row.connect = '해당 없음'
    row.detail = card.how === 'device' ? '폰 권한으로 켜는 서비스' : '공식 연결(OAuth) 서비스'
    console.log(row.connect)
    continue
  }

  // 1) 이미 로그인돼 있나
  let v = await api(`/api/connections/${id}/verify`, { method: 'POST' })
  if (v.ok) row.connect = '이미 로그인돼 있음'
  else if (flags.has('--no-login')) row.connect = '로그인 안 됨 (시도 안 함)'
  else if (triedToday(id) >= MAX_TRIES_PER_DAY)
    row.connect = `오늘 로그인 시도 ${MAX_TRIES_PER_DAY}번을 다 씀`
  else {
    // 2) 로그인: 간편 로그인이면 그 공급자로, 아니면 금고 계정으로
    noteTry(id)
    const provider = PROVIDERS[p.method]
    const r = provider
      ? await api(`/api/connections/${id}/social`, { method: 'POST', body: { provider } })
      : await api(`/api/connections/${id}/relogin`, { method: 'POST' })
    if (r.ok) row.connect = '로그인 성공'
    else if (r.status === 404) row.connect = '금고에 계정 없음 (앱 연결 카드에 한 번 넣어 주세요)'
    else if (r.reason === 'human' || r.human) row.connect = '사람 차례'
    else if (r.reason === 'wrong') row.connect = '아이디·비밀번호 틀림'
    else row.connect = '로그인 실패'
    row.detail = r.message ?? r.error ?? ''
    if (!r.ok) {
      // 화면은 로그인됐는데 판정만 틀렸을 수도 있다
      v = await api(`/api/connections/${id}/verify`, { method: 'POST' })
      if (v.ok) row.connect += ' → 다시 보니 로그인돼 있음 (판정 고칠 것)'
    } else v = { ok: true }
  }
  console.log(`${row.connect}${row.detail ? ` · ${row.detail}` : ''}`)
  if (!v.ok) continue

  // 3) 로그인이 필요한 도구
  for (const t of toolsOf(id)) {
    if (!t.login) continue
    if (t.tier !== '찾아보기' && !flags.has('--deep')) {
      row.tools.push({ tool: name(id, t.name), title: t.title, outcome: '건너뜀', note: `${t.tier} 도구 (--deep일 때만)` })
      continue
    }
    if (t.steps.some((st) => 'approve' in st)) {
      row.tools.push({
        tool: name(id, t.name),
        title: t.title,
        outcome: '건너뜀',
        note: '승인으로 끝나는 도구',
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
      const handoff = /handoff|이어서 해|AI에게/.test(text) && !r.isError
      const outcome = r.isError
        ? '실패'
        : r.structuredContent?.blocked
          ? '사이트가 막음'
          : r.structuredContent?.stopped
            ? '멈춤'
            : handoff
              ? '화면까지 감'
              : '성공'
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
        `   ${outcome === '성공' || outcome === '화면까지 감' ? '✓' : '✗'} ${t.title} ${outcome}${list ? ` ${list.length}줄` : ''} — ${text.split('\n')[0].slice(0, 100)}`,
      )
    }
  }
}

// ── 결과 ──
const at = new Date().toISOString()
writeFileSync(join(OUT, `${today}.json`), JSON.stringify({ at, results }, null, 2))
const esc = (x) =>
  String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const good = (c) => /성공|이미 로그인/.test(c)
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>두리 연결 시험</title>
<style>body{font:14px -apple-system,sans-serif;margin:24px;background:#111318;color:#e8e8ea}h1{font-size:20px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #2a2d35;padding:6px 8px;text-align:left;vertical-align:top}
.ok{color:#7ee2b8}.bad{color:#ffb4a8}.sum{color:#a8acb6;margin:8px 0 16px}small{color:#a8acb6}</style></head><body>
<h1>두리 연결 시험</h1><p class="sum">${esc(at)} · 서비스 ${results.length}곳 · 연결됨 ${results.filter((r) => good(r.connect)).length}곳</p>
<table><tr><th>서비스</th><th>로그인 방식</th><th>연결</th><th>로그인 도구</th></tr>${results
  .map(
    (r) =>
      `<tr><td>${esc(r.name)}<br><small>${esc(r.id)}</small></td><td>${esc(r.method)}${r.twoFactor ? `<br><small>2단계: ${esc(r.twoFactor)}</small>` : ''}</td><td class="${good(r.connect) ? 'ok' : 'bad'}">${esc(r.connect)}${r.detail ? `<br><small>${esc(r.detail)}</small>` : ''}</td><td>${r.tools
        .map(
          (t) =>
            `<div class="${/성공|화면까지/.test(t.outcome) ? 'ok' : t.outcome === '건너뜀' ? '' : 'bad'}">${esc(t.title)} · ${esc(t.outcome)}${t.rows !== undefined ? ` · ${t.rows}줄` : ''}${t.ms ? ` · ${(t.ms / 1000).toFixed(1)}초` : ''}<br><small>${esc(t.note)}</small></div>`,
        )
        .join('')}</td></tr>`,
  )
  .join('')}</table></body></html>`
const report = opt('--report') ?? join(OUT, 'latest.html')
writeFileSync(report, html)
console.log(`\n보고서: ${report}`)
