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
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkConnectCard } from '@dool2/protocol/connect'
import { checkConnector, connectorToolName } from '@dool2/protocol/connector'
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
    let fail = 0
    let n = 0
    for (const id of args.length ? args : services()) {
      const c = toolsOf(id)
      for (const t of c?.tools ?? []) {
        if (t.tier !== '찾아보기' || t.login || t.status.startsWith('막힘')) continue
        for (const ex of t.examples) {
          n++
          const t0 = Date.now()
          const r = await connectors.call(connectorToolName(id, t.name), ex)
          const s = ((Date.now() - t0) / 1000).toFixed(1)
          const rows = Object.values(r.structuredContent ?? {}).find(Array.isArray)
          if (r.isError) {
            fail++
            console.log(
              `✗ ${connectorToolName(id, t.name)} ${JSON.stringify(ex)} (${s}초)\n  ${r.content[0]?.text}`,
            )
          } else
            console.log(
              `✓ ${connectorToolName(id, t.name)} ${JSON.stringify(ex)} (${s}초${rows ? `, ${rows.length}줄` : ''})`,
            )
        }
      }
    }
    console.log(`${n}개 중 실패 ${fail}`)
    await done(fail ? 1 : 0)
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
