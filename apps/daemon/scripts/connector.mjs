// Tool to build and fix service tools (connectors) (ADR 0018, .claude/skills/connector).
// Loads the Dool2 extension into a test Chrome (Chrome for Testing) and runs connectors on real sites with the real daemon.
//
//   pnpm build
//   export DOOL2_TEST_CHROME=".../Google Chrome for Testing"
//   pnpm connector check [id…]                     check format and safety rules (no Chrome)
//   pnpm connector try <id> <tool> '<input JSON>'     run once and see the result (text and structured)
//   pnpm connector canary [id…]                    run every lookup tool with example input (real-site test)
//   pnpm connector page <url> [selector]              read a page / try pulling a list by selector (inspect the page before writing a connector)
//   pnpm connector try|canary … --pc               in the real Chrome of the running test PC instead of the test Chrome
//                                                  (DOOL2_TOOL_TOKEN, DOOL2_PC; also works for sites that block the test Chrome)
//
// Tools that need login: keep the same profile with DOOL2_DEV_PROFILE=<folder> and sign in by hand in that Chrome
// (add --connected to try to treat it as connected). This tool never handles passwords.

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
      problems.push(
        ...checkConnector(id, c, [card.site, ...(card.alsoSites ?? [])].filter(Boolean), card.category),
      )
    }
    if (problems.length) {
      bad++
      console.log(`✗ ${id}\n  ${problems.join('\n  ')}`)
    } else if (c) console.log(`✓ ${id} (${c.tools.map((t) => `${t.name}:${t.status}`).join(', ')})`)
  }
  console.log(`${count} connectors, ${bad} problems`)
  process.exit(bad ? 1 : 0)
}

// ── --pc: in the real Chrome of the running test PC daemon (works for sites that block the test Chrome) ──
// DOOL2_PC (default http://127.0.0.1:8833) and DOOL2_TOOL_TOKEN. The daemon must run with DOOL2_DEV_RESET=1 (test PC).
// Passes the repo's skills/<id>/tools.json as is, so a fixed definition can be checked without installing it
if (flags.has('--pc')) {
  const base = process.env.DOOL2_PC ?? 'http://127.0.0.1:8833'
  const token = process.env.DOOL2_TOOL_TOKEN
  if (!token) {
    console.error('Set DOOL2_TOOL_TOKEN to the daemon tool token')
    process.exit(2)
  }
  // Exit after the output is fully written (process.exit cuts large output when piped)
  const exit = (code) => process.stdout.write('', () => process.exit(code))
  const run = async (id, tool, input, close = false) => {
    const res = await fetch(`${base}/api/tools/service/try`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ connector: toolsOf(id), tool, input, close }),
      signal: AbortSignal.timeout(180_000),
    })
    if (!res.ok) throw new Error(`The daemon refused (${res.status}): ${(await res.text()).slice(0, 200)}`)
    return res.json()
  }
  const show = (r) => {
    for (const c of r.content ?? []) if (c.type === 'text') console.log(c.text)
    if (r.structuredContent)
      console.log(`\nStructured result:\n${JSON.stringify(r.structuredContent, null, 2)}`)
  }
  if (cmd === 'try') {
    const [id, name, json] = args
    const t0 = Date.now()
    const r = await run(id, name, json ? JSON.parse(json) : {})
    show(r)
    console.log(
      `\n${r.isError ? '✗ failed' : '✓ ok'} (${((Date.now() - t0) / 1000).toFixed(1)}s, user Chrome)`,
    )
    exit(r.isError ? 1 : 0)
    await new Promise(() => {})
  }
  if (cmd === 'canary') {
    const results = []
    for (const id of args.length ? args : services()) {
      const c = toolsOf(id)
      for (const t of c?.tools ?? []) {
        if (t.tier !== 'lookup' || (t.login && !flags.has('--connected'))) continue
        const ex = (t.examples ?? [{}])[0] ?? {}
        const t0 = Date.now()
        const r = await run(id, t.name, ex, true).catch((e) => ({
          isError: true,
          content: [{ type: 'text', text: e.message }],
        }))
        const lists = Object.values(r.structuredContent ?? {}).filter(Array.isArray)
        const rows = lists.flat().filter((x) => x && typeof x === 'object')
        const pics = rows.filter((x) => typeof x.image === 'string' && x.image).length
        const links = rows.filter((x) => typeof x.link === 'string' && x.link).length
        const text = (r.content ?? []).map((x) => x.text).join(' ')
        const ok = !r.isError && !/결과 칸이 비어/.test(text)
        results.push({
          id,
          tool: t.name,
          ok,
          rows: rows.length,
          pics,
          links,
          ms: Date.now() - t0,
          error: ok ? undefined : text.slice(0, 300),
        })
        console.log(
          `${ok ? '✓' : '✗'} ${id}_${t.name} (${((Date.now() - t0) / 1000).toFixed(1)}s, ${rows.length} rows, photos ${pics}, links ${links})${ok ? '' : `\n  ${text.split('\n')[0].slice(0, 200)}`}`,
        )
      }
    }
    const jsonOut = rest.find((a) => a.startsWith('--json='))?.slice(7)
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
    console.log(`${results.length} run, ${results.filter((x) => !x.ok).length} failed (user Chrome)`)
    exit(0)
    await new Promise(() => {})
  }
  console.error('--pc only works with try and canary')
  process.exit(2)
}

// ── Test Chrome + Dool2 daemon ──
const chromeBin = process.env.DOOL2_TEST_CHROME
if (!chromeBin) {
  console.error(
    'Set DOOL2_TEST_CHROME to the Chrome for Testing executable path (npx @puppeteer/browsers install chrome@stable)',
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
  console.error('The extension did not connect to the daemon within 30s (did you build apps/extension?)')
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
  if (r.structuredContent)
    console.log(`\nStructured result:\n${JSON.stringify(r.structuredContent, null, 2)}`)
}

try {
  if (cmd === 'try') {
    const [id, name, json] = args
    const t0 = Date.now()
    const r = await connectors.call(connectorToolName(id, name), json ? JSON.parse(json) : {})
    show(r)
    console.log(`\n${r.isError ? '✗ failed' : '✓ ok'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    if (flags.has('--hold')) await new Promise((r) => setTimeout(r, 120_000))
    await done(r.isError ? 1 : 0)
  }
  if (cmd === 'canary') {
    // Real-site check (ADR 0020): runs lookup tools with example input and looks at both loud failures (blocked) and
    // silent failures (row count, required fields). --json file, --report HTML, --issues GitHub issues
    const opt = (name) => {
      const i = rest.indexOf(name)
      return i >= 0 ? rest[i + 1] : undefined
    }
    const ids = args.filter((a) => a !== opt('--json') && a !== opt('--report'))
    const results = []
    for (const id of ids.length ? ids : services()) {
      const c = toolsOf(id)
      for (const t of c?.tools ?? []) {
        if (t.tier !== 'lookup' || t.login || t.status.startsWith('막힘')) continue
        const name = connectorToolName(id, t.name)
        for (const ex of t.examples) {
          const t0 = Date.now()
          const once = async () => {
            const r = await connectors
              .call(name, ex)
              .catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }))
            const stopped = Boolean(r.structuredContent?.stopped)
            // The site blocked this browser (nothing to fix in the connector): neither ok nor broken, but 'blocked'
            const blocked = Boolean(r.structuredContent?.blocked)
            const problems = r.isError
              ? []
              : stopped
                ? []
                : healthProblems(t, r.structuredContent ?? {}, true)
            return { r, problems, blocked, ok: !r.isError && !blocked && !problems.length }
          }
          // One failure can be temporary (browser lag, etc.): wait 30s and retry once before calling it broken
          let run = await once()
          let retried = false
          if (!run.ok) {
            retried = true
            await new Promise((res) => setTimeout(res, 30_000))
            run = await once()
          }
          const { r, problems, ok, blocked } = run
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
            blocked,
            // Only verified tools that broke count as broken (issue and repair target). Drafts go in the report only
            verified: String(t.status).startsWith('검증됨'),
            error: r.isError || blocked ? text.slice(0, 400) : undefined,
          })
          console.log(
            `${ok ? '✓' : blocked ? '⊘' : '✗'} ${name} ${JSON.stringify(ex)} (${(ms / 1000).toFixed(1)}s${rows ? `, ${rows.length} rows` : ''})${ok ? '' : `\n  ${r.isError || blocked ? text.split('\n')[0] : problems.join(' · ')}`}`,
          )
        }
      }
    }
    const fail = results.filter((x) => !x.ok && !x.blocked)
    const blockedN = results.filter((x) => x.blocked).length
    console.log(
      `${results.length} run, ${fail.length} failed${blockedN ? `, blocked by site ${blockedN}` : ''}`,
    )
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
      console.log(`First ${r.rows.length} of ${r.total}:`)
      for (const row of r.rows) console.log(`- ${String(row.text).replace(/\n/g, ' ⏎ ').slice(0, 300)}`)
    } else {
      const r = await tools.run('read', { tabId, maxChars: Number(process.env.MAX ?? 8000) })
      show(r)
    }
    if (flags.has('--hold')) await new Promise((r) => setTimeout(r, 300_000))
    await done(0)
  }
  console.error(`Unknown command: ${cmd}`)
  await done(2)
} catch (e) {
  console.error(e)
  await done(1)
}

// ── Check report (HTML) ──
function healthReport(at, results) {
  const esc = (x) =>
    String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const by = new Map()
  for (const r of results) by.set(r.service, [...(by.get(r.service) ?? []), r])
  const bad = results.filter((r) => !r.ok && !r.blocked && r.verified).length
  const draft = results.filter((r) => !r.ok && !r.blocked && !r.verified).length
  const blocked = results.filter((r) => r.blocked).length
  const rows = [...by]
    .map(([svc, list]) =>
      list
        .map(
          (r, i) =>
            `<tr class="${r.ok ? 'ok' : 'bad'}">${i === 0 ? `<td rowspan="${list.length}">${esc(svc)}</td>` : ''}<td>${esc(r.tool)}</td><td>${esc(JSON.stringify(r.input))}</td><td>${r.ok ? (r.retried ? 'ok (after retry)' : 'ok') : r.blocked ? 'blocked by site' : r.verified ? 'broken' : 'draft, not working'}</td><td>${(r.ms / 1000).toFixed(1)}s</td><td>${r.rows ?? ''}</td><td>${esc(r.error?.split('\n')[0] ?? r.problems.join(' · '))}</td></tr>`,
        )
        .join(''),
    )
    .join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dool2 service tool check</title>
<style>body{font:14px -apple-system,sans-serif;margin:24px;background:#111318;color:#e8e8ea}h1{font-size:20px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #2a2d35;padding:6px 8px;text-align:left;vertical-align:top}tr.bad td{color:#ffb4a8}tr.ok td:nth-child(4){color:#7ee2b8}.sum{margin:8px 0 16px;color:#a8acb6}</style></head><body>
<h1>Dool2 service tool check</h1><p class="sum">${esc(at)} · ${results.length} tested · ${bad} broken · ${draft} drafts not working · ${blocked} blocked by site</p>
<table><tr><th>Service</th><th>Tool</th><th>Input</th><th>Result</th><th>Time</th><th>Rows</th><th>Problem</th></tr>${rows}</table></body></html>`
}

// ── Sync GitHub issues (gh CLI, GH_TOKEN) ──
// One issue per broken tool ([커넥터] tool name, label connector-broken). When it works again, comment and close
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
      'Service tool broken on the real site (ADR 0020)',
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
    // Draft tools are not verified yet, so no issue is opened (report only)
    if (!list[0].verified) continue
    // If the site only blocked us, we cannot tell whether it is fixed: neither open nor close the issue
    if (list.every((r) => r.blocked)) continue
    const bad = list.filter((r) => !r.ok && !r.blocked)
    const issue = issueOf(tool)
    if (bad.length) {
      const svc = list[0].service
      const body = [
        `The daily check (${today}) found **${tool}** broken on the real site.`,
        '',
        ...bad.map(
          (r) =>
            `- input \`${JSON.stringify(r.input)}\`: ${r.error?.split('\n')[0] ?? r.problems.join(' · ')}`,
        ),
        '',
        'Reproduce and fix (`.claude/skills/connector`):',
        '```bash',
        `pnpm connector try ${svc} ${tool.slice(svc.replace(/-/g, '_').length + 1)} '${JSON.stringify(bad[0].input)}'`,
        `pnpm connector page "<that page url>"`,
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
      console.log(`Issue ${issue ? `#${issue.number} commented` : 'new'}: ${tool}`)
    } else if (issue) {
      gh(
        'issue',
        'close',
        String(issue.number),
        '--repo',
        repo,
        '--comment',
        `The daily check (${today}) passes again. Closing.`,
      )
      console.log(`Issue #${issue.number} closed: ${tool}`)
    }
  }
}
