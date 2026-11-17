// 확장 끝-끝 확인: 시험용 Chrome(Chrome for Testing)에 확장을 올리고, 진짜 두리 본체와 native messaging으로 붙여
// 탭 열기 → 읽기 → 입력 → 클릭 → 화면 캡처까지 돌린다. 사용자 Chrome·프로필은 건드리지 않는다.
//
//   pnpm build
//   DOOL2_TEST_CHROME=".../Google Chrome for Testing" node apps/extension/scripts/e2e.mjs
//
// (일반 Chrome 137+는 --load-extension을 막아서 Chrome for Testing을 쓴다:
//  npx @puppeteer/browsers install chrome@stable)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserTools, memorySecrets, startDaemon, Vault } from '@dool2/daemon'

const chromeBin = process.env.DOOL2_TEST_CHROME
if (!chromeBin) {
  console.error('DOOL2_TEST_CHROME에 Chrome for Testing 실행 파일 경로를 넣어 주세요')
  process.exit(2)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.env.DOOL2_E2E_OUT ?? join(root, 'out')
mkdirSync(out, { recursive: true })

// ── 시험용 웹페이지 ──
const PAGES = {
  '/': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>두리 시험 가게</title>
<style>body{font:16px sans-serif;margin:40px}.hidden{display:none}</style></head><body>
<h1>두리 시험 가게</h1>
<p>오늘의 추천 상품을 찾아보세요.</p>
<form action="/search"><label for="q">검색어</label> <input id="q" name="q" placeholder="상품 이름"> <button>검색</button></form>
<ul><li>사과 1kg <b>9,900원</b> <button onclick="document.title='구매됨'">바로 구매</button></li><li>배 2kg <b>15,000원</b></li></ul>
<a href="/popup" target="_blank">새 창으로 보기</a>
<label>비밀번호 <input type="password" id="pw"></label>
<div class="hidden"><button>숨은 버튼</button></div>

</body></html>`,
  '/login': `<!doctype html><title>로그인</title><h1>로그인</h1>
<form action="/welcome" method="get"><label>아이디 <input name="id"></label> <label>비밀번호 <input type="password" name="pw"></label> <button>로그인</button></form>`,
  '/popup': '<!doctype html><title>새 창</title><h1>새 창이에요</h1>',
  // 휴대폰용 React 사이트 흉내 (캐치테이블): 목록 줄은 div + onClick 처리기만 있고 손가락 커서·role이 없다.
  // 검색칸은 입력을 조금 늦게 상태에 반영해서, 글을 넣자마자 Enter를 치면 빈 검색이 된다
  '/app': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>맛집 앱</title></head><body>
<input id="q" placeholder="어떤 맛집 찾으시나요?">
<div id="list"><div class="row"><span>성수 사위식당</span> <span>4.3 · 한식</span></div>
<div class="row"><span>성수 까망</span> <span>4.7 · 이탈리아음식</span></div></div>
<div role="radiogroup" aria-label="테이블 타입"><label role="radio" aria-checked="false" aria-label="홀" tabindex="0" id="hall"><input type="radio" name="seat" aria-hidden="true" tabindex="-1" style="appearance:none;position:absolute;width:0;height:0;margin:0;border:0"><span aria-hidden="true">홀</span></label><label role="radio" aria-checked="false" aria-disabled="true" aria-label="룸" tabindex="0">룸</label></div>
<div id="cards"><div class="card"><b>가게 가</b> <i>조용한 한식집</i> <span class="chip">27일 예약</span></div>
<div class="card"><b>가게 나</b> <i>시끄러운 술집</i> <span class="chip">27일 예약</span></div></div>
<button id="shuffle">섞기</button>
<div id="long">${'성수동 골목 이야기 '.repeat(20)}<span>끝 문장</span></div>
<script>
const props = (el, p) => { el['__reactProps$t3st'] = p; el.addEventListener('click', (e) => p.onClick?.(e)) }
for (const r of document.querySelectorAll('.row')) props(r, { onClick: () => { document.title = '고름: ' + r.firstChild.textContent } })
props(document.getElementById('long'), { onClick: () => {} })
const hall = document.getElementById('hall')
hall.addEventListener('click', () => hall.setAttribute('aria-checked', 'true'))
for (const c of document.querySelectorAll('.chip'))
  props(c, { onClick: () => { document.title = '예약: ' + c.parentElement.querySelector('b').textContent } })
// 목록 칸 재활용 흉내: 같은 칸(DOM)에 다른 가게를 그린다
document.getElementById('shuffle').addEventListener('click', () => {
  const [a, b] = document.querySelectorAll('.card')
  for (const sel of ['b', 'i']) {
    const t = a.querySelector(sel).textContent
    a.querySelector(sel).textContent = b.querySelector(sel).textContent
    b.querySelector(sel).textContent = t
  }
})
let kw = ''
const q = document.getElementById('q')
q.addEventListener('input', () => setTimeout(() => { kw = q.value }, 100))
q.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.title = '검색: ' + (kw || '(빈칸)') })
</script></body></html>`,
  '/captcha':
    '<!doctype html><title>확인</title><h1>로그인</h1><p>자동입력 방지 문자를 입력해 주세요</p><img src="/x" alt="보안문자">',
}
const site = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/welcome') {
    const ok = url.searchParams.get('id') === 'duri' && url.searchParams.get('pw') === 'pw-금고-123'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(
      `<!doctype html><title>${ok ? '환영해요' : '실패'}</title><h1>${ok ? '로그인 성공' : '로그인 실패'}</h1>`,
    )
  }
  if (url.pathname === '/search') {
    const q = url.searchParams.get('q') ?? ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(
      `<!doctype html><title>검색 결과</title><h1>"${q.replace(/[<>&"]/g, '')}" 검색 결과</h1><p>사과 1kg 9,900원</p>`,
    )
  }
  const body = PAGES[url.pathname]
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body ?? 'not found')
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${site.address().port}`

// ── 두리 본체 + 시험용 Chrome ──
const tmp = mkdtempSync(join(tmpdir(), 'dool2-e2e-'))
const profile = join(tmp, 'profile')
const daemon = await startDaemon({
  dataDir: join(tmp, 'data'),
  // DOOL2_E2E_AGENT=claude|codex면 진짜 AI로 대화까지 돌린다 (그 AI의 로그인·사용량을 쓴다)
  ...(process.env.DOOL2_E2E_AGENT ? {} : { runtimes: {} }),
  nativeHost: { defaultTargets: false, extraDirs: [join(profile, 'NativeMessagingHosts')] },
})
const chrome = spawn(
  chromeBin,
  [
    `--user-data-dir=${profile}`,
    `--load-extension=${join(root, 'dist')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const step = async (name, fn) => {
  const t = Date.now()
  try {
    const r = await fn()
    console.log(`✓ ${name} (${Date.now() - t}ms)`)
    return r
  } catch (e) {
    console.log(`✗ ${name}: ${e.message}`)
    throw e
  }
}
const call = (cmd, args) => daemon.browser.call(cmd, args)

let failed = false
try {
  await step('확장이 본체에 붙는다', async () => {
    for (let i = 0; i < 150 && !daemon.browser.status.connected; i++)
      await new Promise((r) => setTimeout(r, 200))
    assert.equal(daemon.browser.status.connected, true, '30초 안에 연결되지 않았어요')
    console.log(`  ${JSON.stringify(daemon.browser.status)}`)
  })

  const { tabId } = await step('탭 열기', async () => {
    const r = await call('open', { url: base })
    assert.equal(r.title, '두리 시험 가게')
    return r
  })

  const snap = await step('페이지 읽기', async () => {
    const r = await call('snapshot', { tabId })
    writeFileSync(join(out, 'e2e-snapshot.txt'), r.text)
    assert.match(r.text, /# 두리 시험 가게/)
    assert.match(r.text, /사과 1kg 9,900원/)
    assert.match(r.text, /\[e\d+ 입력칸 "검색어"\]/)
    assert.match(r.text, /\[e\d+ 비밀번호칸 "비밀번호"\]/)
    assert.doesNotMatch(r.text, /숨은 버튼/)
    assert.equal(r.captcha, false)
    return r
  })
  const ref = (re) => {
    const m = snap.text.match(re)
    assert.ok(m, `${re} 를 찾지 못했어요`)
    return m[1]
  }

  await step('비밀번호 칸에는 입력하지 않는다', async () => {
    await assert.rejects(call('type', { tabId, ref: ref(/\[(e\d+) 비밀번호칸/), text: 'x' }), /금고/)
  })

  await step('입력하고 Enter', async () => {
    const r = await call('type', { tabId, ref: ref(/\[(e\d+) 입력칸 "검색어"/), text: '사과', submit: true })
    assert.match(r.url, /\/search\?q=%EC%82%AC%EA%B3%BC/)
    assert.equal(r.title, '검색 결과')
  })

  await step('화면 캡처', async () => {
    const r = await call('screenshot', { tabId })
    assert.equal(r.mime, 'image/jpeg')
    writeFileSync(join(out, 'e2e-search.jpg'), Buffer.from(r.data, 'base64'))
  })

  await step('뒤로 가서 링크 클릭 → 새 탭도 두리 탭', async () => {
    await call('back', { tabId })
    const s = await call('snapshot', { tabId })
    const link = s.text.match(/\[(e\d+) 링크 "새 창으로 보기"\]/)?.[1]
    assert.ok(link)
    const t = Date.now()
    const r = await call('click', { tabId, ref: link })
    assert.ok(Date.now() - t < 3000, `클릭이 너무 느려요 (${Date.now() - t}ms)`)
    assert.ok(r.newTabId, '새 탭 id가 없어요')
    const p = await call('snapshot', { tabId: r.newTabId })
    assert.match(p.text, /새 창이에요/)
    // 새 탭이 앞에 있는 동안에도 원래 탭의 버튼을 누를 수 있다 (뒤 탭은 입력을 받지 않아서 앞으로 돌린다)
    const buy = s.text.match(/\[(e\d+) 버튼 "바로 구매"\]/)?.[1]
    const bought = await call('click', { tabId, ref: buy })
    assert.equal(bought.title, '구매됨')
    await call('close', { tabId: r.newTabId })
  })

  await step('스크롤', async () => {
    await call('scroll', { tabId, direction: 'down' })
  })

  await step('React 클릭 상자도 누를 수 있게 읽고, 늦게 받는 칸도 Enter로 검색된다', async () => {
    await call('navigate', { tabId, url: `${base}/app` })
    const s = await call('snapshot', { tabId })
    writeFileSync(join(out, 'e2e-app-snapshot.txt'), s.text)
    const row = s.text.match(/\[(e\d+) 버튼 "성수 까망 4\.7 · 이탈리아음식"\]/)?.[1]
    assert.ok(row, `목록 줄에 표시가 없어요:\n${s.text}`)
    // 긴 상자는 표시만 붙이고 안의 글은 그대로 읽는다
    assert.match(s.text, /끝 문장/)
    const picked = await call('click', { tabId, ref: row })
    assert.equal(picked.title, '고름: 성수 까망')
    const q = s.text.match(/\[(e\d+) 입력칸 "어떤 맛집 찾으시나요\?"\]/)?.[1]
    const r = await call('type', { tabId, ref: q, text: '성수', submit: true })
    assert.equal(r.title, '검색: 성수')
  })

  await step('숨은 칸을 품은 라디오 라벨을 읽고, 칸이 재활용되면 엉뚱한 것을 누르지 않는다', async () => {
    await call('navigate', { tabId, url: `${base}/app` })
    const s = await call('snapshot', { tabId })
    const hall = s.text.match(/\[(e\d+) 라디오 "홀"\]/)?.[1]
    assert.ok(hall, `라디오 "홀"이 없어요:\n${s.text}`)
    assert.match(s.text, /라디오 "룸" 비활성/)
    await call('click', { tabId, ref: hall })
    assert.match((await call('snapshot', { tabId })).text, /라디오 "홀" 선택됨/)
    const s2 = await call('snapshot', { tabId })
    const chipA = s2.text.match(/가게 가 조용한 한식집 \[(e\d+) 버튼 "27일 예약"\]/)?.[1]
    assert.ok(chipA, `가게 가의 날짜 칸이 없어요:\n${s2.text}`)
    await call('click', { tabId, ref: s2.text.match(/\[(e\d+) 버튼 "섞기"\]/)?.[1] })
    await assert.rejects(call('click', { tabId, ref: chipA }), /다시 읽/)
    const s3 = await call('snapshot', { tabId })
    const chip = s3.text.match(/가게 가 조용한 한식집 \[(e\d+) 버튼 "27일 예약"\]/)?.[1]
    const r = await call('click', { tabId, ref: chip })
    assert.equal(r.title, '예약: 가게 가')
  })

  await step('캡차 화면을 알아챈다', async () => {
    await call('navigate', { tabId, url: `${base}/captcha` })
    const r = await call('snapshot', { tabId })
    assert.equal(r.captcha, true)
  })

  await step('위험한 주소는 열지 않는다', async () => {
    await assert.rejects(call('navigate', { tabId, url: 'javascript:alert(1)' }), /http·https/)
    await assert.rejects(call('open', { url: 'file:///etc/passwd' }), /http·https/)
  })

  await step('두리가 열지 않은 탭은 다루지 않는다', async () => {
    await assert.rejects(call('snapshot', { tabId: 1 }), /두리가 연 탭이 아니에요/)
  })

  await step('두리 금고로 로그인 (AI에게 값이 가지 않는다)', async () => {
    const vault = new Vault(memorySecrets())
    await vault.add({ url: `${base}/login`, username: 'duri', password: 'pw-금고-123' })
    const tools = new BrowserTools(daemon.browser, vault)
    const text = (r) => r.content.map((c) => c.text ?? '').join('\n')
    await call('navigate', { tabId, url: `${base}/login` })
    const page = text(await tools.run('read', { tabId }))
    const user = page.match(/\[(e\d+) 입력칸 "아이디"\]/)?.[1]
    const pw = page.match(/\[(e\d+) 비밀번호칸 "비밀번호"\]/)?.[1]
    const login = page.match(/\[(e\d+) 버튼 "로그인"\]/)?.[1]
    const filled = await tools.run('login', { tabId, usernameRef: user, passwordRef: pw })
    assert.equal(filled.isError, undefined, text(filled))
    assert.doesNotMatch(text(filled), /pw-금고-123|값="duri"/)
    assert.match(text(filled), /금고로 채워짐/)
    const after = await tools.run('click', { tabId, ref: login })
    assert.match(text(after), /로그인 성공/)
  })

  await step('탭 닫기', async () => {
    await call('close', { tabId })
  })

  const agent = process.env.DOOL2_E2E_AGENT
  if (agent) {
    const api = async (path, body) => {
      const res = await fetch(`${daemon.url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!(res.headers.get('content-type') ?? '').includes('event-stream')) return res.json()
      const events = []
      const reader = res.body.getReader()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += Buffer.from(value).toString()
        const parts = buf.split('\n\n')
        buf = parts.pop()
        for (const p of parts) if (p.startsWith('data: ')) events.push(JSON.parse(p.slice(6)))
      }
      return events
    }
    const ask = async (text) => {
      const { thread } = await api('/api/threads', { agent })
      const events = await api(`/api/threads/${thread.id}/messages`, { text })
      const tools = events
        .filter((e) => e.event?.type === 'tool')
        .map((e) => `${e.event.name} ${JSON.stringify(e.event.input)}`)
      const done = events.find((e) => e.event?.type === 'done')
      const err = events.find((e) => e.event?.type === 'error')
      const answer = done?.event.text ?? err?.event.message ?? ''
      console.log(`  > ${text}\n${tools.map((t) => `    도구: ${t}`).join('\n')}\n  두리: ${answer}`)
      return { tools, answer }
    }
    await step(`AI(${agent})가 가게에서 사과 값을 찾는다`, async () => {
      const r = await ask(`${base} 에서 사과 1kg 가격 알려줘`)
      assert.ok(
        r.tools.some((t) => t.includes('browser_open')),
        '브라우저를 쓰지 않았어요',
      )
      assert.match(r.answer, /9,?900/)
    })
    await step(`AI(${agent})는 구매 버튼을 승인 요청하고, 승인하면 본체가 누른다`, async () => {
      const r = await ask(`${base} 에서 사과 바로 구매 버튼 눌러줘`)
      assert.ok(
        r.tools.some((t) => t.includes('browser_request_approval')),
        '승인을 요청하지 않았어요',
      )
      assert.ok(!r.tools.some((t) => /browser_click .*"바로 구매"/.test(t)))
      const pending = daemon.approvals.list().find((x) => x.status === 'pending')
      assert.ok(pending, '기다리는 승인 요청이 없어요')
      console.log(
        `  승인 카드: ${JSON.stringify({ what: pending.what, amount: pending.amount, label: pending.label })}`,
      )
      const res = await fetch(`${daemon.url}/api/approvals/${pending.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      })
      const out = await res.json()
      console.log(`  승인 결과: ${out.message}`)
      assert.equal(out.ok, true)
      assert.match(out.message, /구매됨/)
      writeFileSync(join(out ? join(root, 'out') : '', 'e2e-agent.txt'), JSON.stringify(r, null, 2))
    })
    await step(`AI(${agent})가 캡차 화면에서 사람에게 넘긴다`, async () => {
      const r = await ask(`${base}/captcha 에서 로그인해줘`)
      assert.ok(
        r.tools.some((t) => t.includes('browser_handoff')),
        '사람에게 넘기지 않았어요',
      )
    })
  }
} catch {
  failed = true
} finally {
  chrome.kill()
  await daemon.close()
  site.close()
  await new Promise((r) => setTimeout(r, 500))
  rmSync(tmp, { recursive: true, force: true })
}
console.log(failed ? '실패' : '모두 통과')
process.exit(failed ? 1 : 0)
