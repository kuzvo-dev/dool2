// 서비스 도구(커넥터) 만들기·고치기 도구 (ADR 0018, .claude/skills/connector).
// 시험용 Chrome(Chrome for Testing)에 두리 확장을 올리고 진짜 두리 본체로 커넥터를 실제 사이트에서 돌린다.
//
//   pnpm build
//   export DOOL2_TEST_CHROME=".../Google Chrome for Testing"
//   pnpm connector check [id…]                     형식·안전 규칙 검사 (Chrome 없이)
//   pnpm connector try <id> <도구> '<입력 JSON>'     한 번 돌려 결과(글·구조화)를 본다
//   pnpm connector canary [id…]                    찾아보기 도구를 예시 입력으로 모두 돌려 본다 (실제 사이트 시험)
//   pnpm connector page <주소> [선택자]              화면 읽기 / 선택자로 목록 뽑기 시험 (커넥터 쓰기 전 화면 살피기)
//
// 로그인이 필요한 도구: DOOL2_DEV_PROFILE=<폴더>로 같은 프로필을 계속 쓰고, 그 Chrome에서 직접 로그인해 둔다
// (try에 --connected를 붙이면 연결한 것으로 본다). 비밀번호는 이 도구가 다루지 않는다.

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkConnectCard } from '@dool2/protocol/connect'
import { checkConnector, connectorToolName, healthProblems } from '@dool2/protocol/connector'
import { BrowserTools, Connectors, startDaemon } from '../dist/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const skillsDir = join(repo, 'skills')
const [cmd, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter((a) => a.startsWith('--')))
const args = rest.filter((a) => !a.startsWith('--'))

const services = () =>
  readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const toolsOf = (id) => {
  try {
    return readJson(join(skillsDir, id, 'tools.json'))
  } catch {
    return undefined
  }
}

if (cmd === 'check' || !cmd) {
  let bad = 0
  let count = 0
  for (const id of args.length ? args : services()) {
    const card = readJson(join(skillsDir, id, 'connect.json'))
    const problems = checkConnectCard(id, card)
    const c = toolsOf(id)
    if (c) {
      count++
      problems.push(...checkConnector(id, c, card.site))
    }
    if (problems.length) {
      bad++
      console.log(`✗ ${id}\n  ${problems.join('\n  ')}`)
    } else if (c) console.log(`✓ ${id} (${c.tools.map((t) => `${t.name}:${t.status}`).join(', ')})`)
  }
  console.log(`${count}개 커넥터, 문제 ${bad}곳`)
  process.exit(bad ? 1 : 0)
}

// ── 시험용 Chrome + 두리 본체 ──
const chromeBin = process.env.DOOL2_TEST_CHROME
if (!chromeBin) {
  console.error(
    'DOOL2_TEST_CHROME에 Chrome for Testing 실행 파일 경로를 넣어 주세요 (npx @puppeteer/browsers install chrome@stable)',
  )
  process.exit(2)
}
const keep = process.env.DOOL2_DEV_PROFILE
const tmp = mkdtempSync(join(tmpdir(), 'dool2-conn-'))
const profile = keep ?? join(tmp, 'profile')
mkdirSync(profile, { recursive: true })
const daemon = await startDaemon({
  dataDir: join(tmp, 'data'),
  runtimes: {},
  skillsDir,
  nativeHost: { defaultTargets: false, extraDirs: [join(profile, 'NativeMessagingHosts')] },
})
const chrome = spawn(
  chromeBin,
  [
    `--user-data-dir=${profile}`,
    `--load-extension=${join(repo, 'apps', 'extension', 'dist')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)
const done = async (code) => {
  chrome.kill()
  await daemon.close()
  await new Promise((r) => setTimeout(r, 300))
  rmSync(tmp, { recursive: true, force: true })
  process.exit(code)
}
for (let i = 0; i < 150 && !daemon.browser.status.connected; i++) await new Promise((r) => setTimeout(r, 200))
if (!daemon.browser.status.connected) {
  console.error('확장이 30초 안에 본체에 붙지 않았어요 (apps/extension을 빌드했나요?)')
  await done(2)
}
const tools = new BrowserTools(daemon.browser)
const all = Object.fromEntries(services().map((id) => [id, 'dev']))
const connectors = new Connectors({
  dir: skillsDir,
  browser: daemon.browser,
  tools,
  connected: () => (flags.has('--connected') ? all : {}),
})
const show = (r) => {
  for (const c of r.content) if (c.type === 'text') console.log(c.text)
  if (r.structuredContent) console.log(`\n구조화된 결과:\n${JSON.stringify(r.structuredContent, null, 2)}`)
}

try {
  if (cmd === 'try') {
    const [id, name, json] = args
    const t0 = Date.now()
    const r = await connectors.call(connectorToolName(id, name), json ? JSON.parse(json) : {})
    show(r)
    console.log(`\n${r.isError ? '✗ 실패' : '✓ 성공'} (${((Date.now() - t0) / 1000).toFixed(1)}초)`)
    if (flags.has('--hold')) await new Promise((r) => setTimeout(r, 120_000))
    await done(r.isError ? 1 : 0)
  }
  if (cmd === 'canary') {
    // 실제 사이트 점검 (ADR 0020): 찾아보기 도구를 예시 입력으로 돌려 시끄러운 고장(막힘)과
    // 조용한 고장(줄 수·꼭 채워질 칸)을 함께 본다. --json 파일, --report HTML, --issues GitHub 이슈
    const opt = (name) => {
      const i = rest.indexOf(name)
      return i >= 0 ? rest[i + 1] : undefined
    }
    const ids = args.filter((a) => a !== opt('--json') && a !== opt('--report'))
    const results = []
    for (const id of ids.length ? ids : services()) {
      const c = toolsOf(id)
      for (const t of c?.tools ?? []) {
        if (t.tier !== '찾아보기' || t.login || t.status.startsWith('막힘')) continue
        const name = connectorToolName(id, t.name)
        for (const ex of t.examples) {
          const t0 = Date.now()
          const once = async () => {
            const r = await connectors
              .call(name, ex)
              .catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }))
            const stopped = Boolean(r.structuredContent?.stopped)
            const problems = r.isError
              ? []
              : stopped
                ? []
                : healthProblems(t, r.structuredContent ?? {}, true)
            return { r, problems, ok: !r.isError && !problems.length }
          }
          // 한 번 실패는 일시적일 수 있다 (브라우저 지연 등): 30초 쉬고 한 번 더 해 본 뒤에야 고장으로 본다
          let run = await once()
          let retried = false
          if (!run.ok) {
            retried = true
            await new Promise((res) => setTimeout(res, 30_000))
            run = await once()
          }
          const { r, problems, ok } = run
          const ms = Date.now() - t0
          const text = r.content.map((x) => x.text ?? '').join('\n')
          const rows = Object.values(r.structuredContent ?? {}).find(Array.isArray)
          results.push({
            service: id,
            tool: name,
            status: t.status,
            input: ex,
            ok,
            ms,
            rows: rows?.length ?? null,
            problems,
            retried,
            // 검증된 도구가 깨진 것만 고장(이슈·수리 대상). 초안은 보고서에만
            verified: String(t.status).startsWith('검증됨'),
            error: r.isError ? text.slice(0, 400) : undefined,
          })
          console.log(
            `${ok ? '✓' : '✗'} ${name} ${JSON.stringify(ex)} (${(ms / 1000).toFixed(1)}초${rows ? `, ${rows.length}줄` : ''})${ok ? '' : `\n  ${r.isError ? text.split('\n')[0] : problems.join(' · ')}`}`,
          )
        }
      }
    }
    const fail = results.filter((x) => !x.ok)
    console.log(`${results.length}개 중 실패 ${fail.length}`)
    const at = new Date().toISOString()
    const jsonOut = opt('--json')
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ at, results }, null, 2))
    const reportOut = opt('--report')
    if (reportOut) writeFileSync(reportOut, healthReport(at, results))
    if (flags.has('--issues')) await syncIssues(results)
    await done(fail.length ? 1 : 0)
  }
  if (cmd === 'page') {
    const [url, items] = args
    const { tabId } = await daemon.browser.call('open', { url }, 40_000)
    await new Promise((r) => setTimeout(r, 2500))
    if (items) {
      const r = await daemon.browser.call('extract', {
        tabId,
        spec: { items, fields: { text: {} }, limit: 10 },
      })
      console.log(`${r.total}개 중 앞 ${r.rows.length}개:`)
      for (const row of r.rows) console.log(`- ${String(row.text).replace(/\n/g, ' ⏎ ').slice(0, 300)}`)
    } else {
      const r = await tools.run('read', { tabId, maxChars: Number(process.env.MAX ?? 8000) })
      show(r)
    }
    if (flags.has('--hold')) await new Promise((r) => setTimeout(r, 300_000))
    await done(0)
  }
  console.error(`모르는 명령이에요: ${cmd}`)
  await done(2)
} catch (e) {
  console.error(e)
  await done(1)
}

// ── 점검 보고서 (HTML) ──
function healthReport(at, results) {
  const esc = (x) =>
    String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const by = new Map()
  for (const r of results) by.set(r.service, [...(by.get(r.service) ?? []), r])
  const bad = results.filter((r) => !r.ok && r.verified).length
  const draft = results.filter((r) => !r.ok && !r.verified).length
  const rows = [...by]
    .map(([svc, list]) =>
      list
        .map(
          (r, i) =>
            `<tr class="${r.ok ? 'ok' : 'bad'}">${i === 0 ? `<td rowspan="${list.length}">${esc(svc)}</td>` : ''}<td>${esc(r.tool)}</td><td>${esc(JSON.stringify(r.input))}</td><td>${r.ok ? (r.retried ? '정상(다시 해서)' : '정상') : r.verified ? '고장' : '초안·안 됨'}</td><td>${(r.ms / 1000).toFixed(1)}초</td><td>${r.rows ?? ''}</td><td>${esc(r.error?.split('\n')[0] ?? r.problems.join(' · '))}</td></tr>`,
        )
        .join(''),
    )
    .join('')
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>두리 서비스 도구 점검</title>
<style>body{font:14px -apple-system,sans-serif;margin:24px;background:#111318;color:#e8e8ea}h1{font-size:20px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #2a2d35;padding:6px 8px;text-align:left;vertical-align:top}tr.bad td{color:#ffb4a8}tr.ok td:nth-child(4){color:#7ee2b8}.sum{margin:8px 0 16px;color:#a8acb6}</style></head><body>
<h1>두리 서비스 도구 점검</h1><p class="sum">${esc(at)} · ${results.length}개 시험 · 고장 ${bad}개 · 초안이라 안 된 것 ${draft}개</p>
<table><tr><th>서비스</th><th>도구</th><th>입력</th><th>결과</th><th>시간</th><th>줄</th><th>문제</th></tr>${rows}</table></body></html>`
}

// ── GitHub 이슈 맞추기 (gh CLI, GH_TOKEN) ──
// 깨진 도구마다 이슈 하나 ([커넥터] 도구 이름, 라벨 connector-broken). 다시 되면 댓글 남기고 닫는다
async function syncIssues(results) {
  const repo = process.env.DOOL2_REPO ?? 'kuzvo-dev/dool2'
  const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', env: process.env })
  try {
    gh(
      'label',
      'create',
      'connector-broken',
      '--repo',
      repo,
      '--color',
      'E99695',
      '--description',
      '서비스 도구가 실제 사이트에서 깨짐 (ADR 0020)',
    )
  } catch {}
  const open = JSON.parse(
    gh(
      'issue',
      'list',
      '--repo',
      repo,
      '--label',
      'connector-broken',
      '--state',
      'open',
      '--json',
      'number,title',
      '--limit',
      '200',
    ),
  )
  const issueOf = (tool) => open.find((x) => x.title === `[커넥터] ${tool}`)
  const tools = new Map()
  for (const r of results) tools.set(r.tool, [...(tools.get(r.tool) ?? []), r])
  const today = new Date().toISOString().slice(0, 10)
  for (const [tool, list] of tools) {
    // 초안 도구는 아직 확인 전이라 이슈를 열지 않는다 (보고서에만)
    if (!list[0].verified) continue
    const bad = list.filter((r) => !r.ok)
    const issue = issueOf(tool)
    if (bad.length) {
      const svc = list[0].service
      const body = [
        `매일 점검(${today})에서 **${tool}** 이(가) 실제 사이트에서 깨졌어요.`,
        '',
        ...bad.map(
          (r) =>
            `- 입력 \`${JSON.stringify(r.input)}\`: ${r.error?.split('\n')[0] ?? r.problems.join(' · ')}`,
        ),
        '',
        '재현과 고치기 (`.claude/skills/connector`):',
        '```bash',
        `pnpm connector try ${svc} ${tool.slice(svc.replace(/-/g, '_').length + 1)} '${JSON.stringify(bad[0].input)}'`,
        `pnpm connector page "<그 화면 주소>"`,
        '```',
      ].join('\n')
      if (issue) gh('issue', 'comment', String(issue.number), '--repo', repo, '--body', body)
      else
        gh(
          'issue',
          'create',
          '--repo',
          repo,
          '--title',
          `[커넥터] ${tool}`,
          '--label',
          'connector-broken',
          '--body',
          body,
        )
      console.log(`이슈 ${issue ? `#${issue.number}에 댓글` : '새로'}: ${tool}`)
    } else if (issue) {
      gh(
        'issue',
        'close',
        String(issue.number),
        '--repo',
        repo,
        '--comment',
        `매일 점검(${today})에서 다시 잘 돼요. 닫을게요.`,
      )
      console.log(`이슈 #${issue.number} 닫음: ${tool}`)
    }
  }
}
