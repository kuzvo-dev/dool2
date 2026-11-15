// QA 한 바퀴: 설치한 두리 앱을 처음 쓰는 사람처럼 써 보며 화면·영상을 남긴다.
// 설치한 앱(/Applications/dool2.app)을 개발자 통로(--remote-debugging-port)로 열어 누르고 입력하고, 창을 녹화한다.
// 폰은 ego 브라우저로 폰 크기 화면을 찍는다. 사용자 Chrome은 건드리지 않는다(시험용 Chrome + 시험 가게).
//
//   node apps/phone/scripts/qa-walkthrough.mjs <결과 폴더>
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRelay } from '@dool2/relay'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const OUT = process.argv[2] ?? '/tmp/dool2-qa'
const FRAMES = join(OUT, 'frames')
const SHOTS = join(OUT, 'shots')
mkdirSync(FRAMES, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
const CHROME =
  process.env.DOOL2_TEST_CHROME ??
  join(
    homedir(),
    '.cache/dool2-test/chrome/mac_arm-157.0.8103.78/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  )
const APP = '/Applications/dool2.app'
const DATA = join(homedir(), 'Library', 'Application Support', 'dool2')
const PROFILE = join(OUT, 'test-chrome')
const API_INFO = join(OUT, 'api.json')
const PORT = 9333
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const steps = []
const note = (title, detail = '') => {
  steps.push({ title, detail, at: Date.now() })
  log('■', title, detail)
}

// ── 시험 가게 ──
const shop = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (req.url?.startsWith('/login')) {
    res.end(`<!doctype html><title>두리 시험 가게 로그인</title><h1>로그인</h1>
<form onsubmit="event.preventDefault();document.title='로그인 완료';document.body.innerHTML='<h1>로그인했어요</h1><p>'+this.id.value+'님 반가워요</p>'">
<p><input name="id" placeholder="아이디" style="font-size:20px;padding:8px"></p>
<p><input name="pw" type="password" placeholder="비밀번호" style="font-size:20px;padding:8px"></p>
<p><button style="font-size:20px;padding:8px 20px">로그인</button></p></form>`)
    return
  }
  res.end(`<!doctype html><title>두리 시험 가게</title><h1>두리 시험 가게</h1>
<p>오늘의 추천: 제주 귤 3kg <b>15,900원</b> (무료 배송, 배송 전 취소 가능)</p>
<button onclick="document.title='주문 완료';document.body.insertAdjacentHTML('beforeend','<h2>주문이 완료됐어요</h2>')">바로 구매</button>`)
})
await new Promise((r) => shop.listen(8790, '127.0.0.1', r))
// 두 번째 사이트 (폰에서 로그인 카드를 시험할 다른 주소)
const shop2 = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><title>두리 시험 쇼핑몰 로그인</title><h1>시험 쇼핑몰 로그인</h1>
<form onsubmit="event.preventDefault();document.title='로그인 완료';document.body.innerHTML='<h1>로그인했어요</h1><p>'+this.id.value+'님 반가워요</p>'">
<p><input name="id" placeholder="이메일"></p><p><input name="pw" type="password" placeholder="비밀번호"></p><p><button>로그인</button></p></form>`)
})
await new Promise((r) => shop2.listen(8791, '127.0.0.1', r))
const relay = await startRelay({ port: 8787, appDir: join(root, 'apps', 'phone', 'dist') })
log('시험 가게 :8790, 중계 서버 :8787')

// ── 앱 켜기 ──
mkdirSync(join(PROFILE, 'NativeMessagingHosts'), { recursive: true })
execFileSync('open', [
  '-n',
  APP,
  '--env',
  'DOOL2_REGISTER_HOST=0',
  '--env',
  `DOOL2_HOST_DIRS=${join(PROFILE, 'NativeMessagingHosts')}`,
  '--env',
  `DOOL2_RELAY=${relay.url}`,
  '--env',
  `DOOL2_API_INFO=${API_INFO}`,
  '--env',
  'DOOL2_PC_NAME=시험 PC',
  '--args',
  `--remote-debugging-port=${PORT}`,
])
let target
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    target = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
  } catch {}
}
if (!target) throw new Error('앱 창을 찾지 못했어요')
log('앱 창:', target.url)

// ── 개발자 통로 (CDP) ──
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const waiting = new Map()
let frameNo = 0
const frames = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(String(ev.data))
  if (m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    if (m.error) w.reject(new Error(m.error.message))
    else w.resolve(m.result)
  }
  if (m.method === 'Page.screencastFrame') {
    const f = join(FRAMES, `f${String(++frameNo).padStart(5, '0')}.jpg`)
    writeFileSync(f, Buffer.from(m.params.data, 'base64'))
    frames.push({ f, t: Date.now() })
    void cdp('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {})
  }
})
function cdp(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }))
}
async function js(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 실패')
  return r.result.value
}
async function waitFor(expr, ms = 30_000, what = expr) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await js(expr).catch(() => false)) return
    await sleep(300)
  }
  throw new Error(`기다렸지만 안 됐어요: ${what}`)
}
let shotNo = 0
async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  const f = join(SHOTS, `pc-${String(++shotNo).padStart(2, '0')}-${name}.png`)
  writeFileSync(f, Buffer.from(r.data, 'base64'))
  return f
}
/** 화면에 보이는 커서를 그 자리로 옮기고 누른다 (영상에서 어디를 눌렀는지 보이게) */
async function clickAt(x, y) {
  await js(`(() => {
    let c = document.getElementById('qa-cursor')
    if (!c) {
      c = document.createElement('div'); c.id = 'qa-cursor'
      Object.assign(c.style, { position: 'fixed', zIndex: 99999, width: '22px', height: '22px', margin: '-11px 0 0 -11px',
        borderRadius: '50%', background: 'rgba(47,196,141,.35)', boxShadow: '0 0 0 2px #2fc48d', pointerEvents: 'none',
        transition: 'left .45s ease, top .45s ease, transform .15s', left: '50%', top: '50%' })
      document.body.append(c)
    }
    c.style.left = '${x}px'; c.style.top = '${y}px'
  })()`)
  await sleep(550)
  await js(`document.getElementById('qa-cursor').style.transform = 'scale(.7)'`)
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(120)
  await js(`document.getElementById('qa-cursor').style.transform = ''`).catch(() => {})
}
async function click(text, sel = 'button') {
  const at = await js(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.offsetParent !== null && e.textContent.replace(/\\s+/g, ' ').includes(${JSON.stringify(text)}))
    const e = els[0]; if (!e) return null
    e.scrollIntoView({ block: 'center' })
    const r = e.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!at) throw new Error(`누를 것을 못 찾았어요: ${text}`)
  await sleep(300)
  await clickAt(at.x, at.y)
}
async function type(selector, text) {
  const at = await js(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) } })()`,
  )
  if (!at) throw new Error(`입력칸이 없어요: ${selector}`)
  await clickAt(at.x, at.y)
  // 사람이 치듯 조금씩
  for (const ch of text) {
    await cdp('Input.insertText', { text: ch })
    await sleep(35)
  }
}
const api = async (path, init = {}) => {
  const { url, token } = JSON.parse(readFileSync(API_INFO, 'utf8'))
  return (
    await fetch(url + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    })
  ).json()
}

// ── 폰 (ego 브라우저) ──
let phoneNo = 0
let space
/** ego 브라우저에 대본을 넘긴다. 비동기로 부른다 (같은 프로세스의 중계 서버·시험 가게가 멈추지 않게) */
function ego(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(homedir(), '.local/bin/ego-browser'), ['nodejs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`폰 단계 실패: ${out.slice(-600)}`)),
    )
    child.stdin.end(script)
  })
}
async function phone(body) {
  const head =
    space === undefined
      ? 'const task = await taskSpace("두리 QA 폰");'
      : `const task = await taskSpace(${space});`
  const out = await ego(`${head}
const page = task.page("p1");
await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
const snap = async (name) => page.screenshot({ path: ${JSON.stringify(SHOTS)} + "/" + name + ".png" });
${body}
console.log("SPACE=" + task.spaceId);`)
  const m = /SPACE=(\d+)/.exec(out)
  if (m) space = Number(m[1])
  return out
}
const pshot = (name) => `phone-${String(++phoneNo).padStart(2, '0')}-${name}`

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: 1400, everyNthFrame: 1 })

try {
  // 1. 첫 실행 마법사
  await waitFor(`!!document.querySelector('.setup-card')`, 30_000, '첫 화면')
  await sleep(1200)
  note('처음 켰을 때: 인사', await shot('welcome'))
  await click('시작하기')
  await waitFor(`!!document.querySelector('.choices')`)
  await sleep(800)
  note('어떤 AI로 일할까요?', await shot('choice'))
  await click('Claude', '.choice')
  await sleep(500)
  await click('다음')
  await waitFor(`!!document.querySelector('.checks')`, 60_000, '준비 상태')
  await sleep(1500)
  note('준비 상태 확인 (Claude Code·Chrome·두리 확장)', await shot('check'))

  // 2. 두리 확장 연결
  await click('추가 방법')
  await sleep(1200)
  note('두리 확장 추가 안내', await shot('extension-guide'))
  const extDir = join(DATA, 'chrome-extension')
  for (let i = 0; i < 20 && !existsSync(join(extDir, 'manifest.json')); i++) await sleep(500)
  const chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1100,820',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  process.on('exit', () => chrome.kill())
  await waitFor(
    `[...document.querySelectorAll('.checks li.ok .text strong')].some((e) => e.textContent.includes('확장'))`,
    90_000,
    '확장 연결',
  )
  await sleep(1200)
  note('두리 확장이 연결됨', await shot('extension-connected'))
  await click('다음')
  await waitFor(`!!document.querySelector('.toggles')`)
  await sleep(800)
  note('두리가 쉬지 않게 할까요? (시험이라 [나중에])', await shot('awake'))
  await click('나중에')
  await waitFor(
    `!document.querySelector('.setup:not([hidden])') && !!document.getElementById('home')`,
    20_000,
    '홈',
  )
  await sleep(1500)
  note('홈 화면', await shot('home'))

  // 3. 첫 부탁
  await type('#input', '넌 누구야? 한 문장으로')
  await sleep(400)
  await click('', '#send')
  await waitFor(
    `!!document.querySelector('.msg.assistant') && !document.querySelector('.work:not(.done)')`,
    180_000,
    '첫 답',
  )
  await sleep(1500)
  note('첫 부탁과 답', await shot('first-answer'))

  // 4. 웹 일 + 승인
  await click('새 부탁', '.nav-item')
  await sleep(800)
  await type('#input', '두리 시험 가게(http://127.0.0.1:8790/)에서 제주 귤 바로 구매해 줘')
  await click('', '#send')
  await waitFor(`!!document.querySelector('.worklog li')`, 120_000, '일하는 중')
  await sleep(2500)
  note('웹 일 하는 중 (진행 단계)', await shot('working'))
  await waitFor(`!!document.querySelector('.approval.pending .approval-actions')`, 300_000, '승인 요청')
  await sleep(2500)
  note('승인 요청 (화면 캡처·금액·누를 버튼)', await shot('approval'))
  await click('누르기', '.approval-actions button')
  await waitFor(
    `[...document.querySelectorAll('.msg.assistant')].length >= 2 && !document.querySelector('.work:not(.done)') && !document.querySelector('.approval.pending')`,
    300_000,
    '승인 뒤 답',
  )
  await sleep(2000)
  note('승인 → 두리가 누르고 확인', await shot('approved'))

  // 4-2. 로그인 카드 (PC): 금고에 없는 사이트 → 대화 안 카드에 넣으면 금고에만 저장 → 두리가 채우고 로그인
  await click('새 부탁', '.nav-item')
  await sleep(800)
  await type('#input', '두리 시험 가게 로그인 페이지(http://127.0.0.1:8790/login)에 로그인해 줘')
  await click('', '#send')
  await waitFor(`!!document.querySelector('.login-card form')`, 300_000, '로그인 카드')
  await sleep(1500)
  note('로그인 카드 (PC)', await shot('login-card'))
  await type('.login-card input[autocomplete=username]', 'dool2')
  await type('.login-card input[type=password]', 'test-password')
  await sleep(400)
  note('로그인 카드에 입력', await shot('login-typed'))
  await click('로그인', '.login-card button')
  await waitFor(
    `!document.querySelector('.work:not(.done)') && [...document.querySelectorAll('.msg.assistant')].length >= 2`,
    300_000,
    '로그인 뒤 답',
  )
  await sleep(2000)
  note('두리가 금고로 채우고 로그인', await shot('login-done'))

  // 5. 설정 → 폰 연결
  await click('', '#open-settings')
  await waitFor(`!!document.querySelector('.setup-card .checks')`, 30_000, '설정')
  await sleep(1200)
  note('설정', await shot('settings'))
  await click('폰 연결하기')
  await waitFor(`!!document.querySelector('.pair-qr')`, 20_000, 'QR')
  await sleep(1000)
  note('폰 연결 QR', await shot('pair-qr'))
  const pair = (await api('/api/link/pair')).pair
  await phone(`await page.goto(${JSON.stringify(pair.url)});
// 처음 열 때 앱이 늦게 뜨면 한 번 더 연다
if (!(await page.waitForSelector(".code", { timeout: 15000 }).then(() => true).catch(() => false))) {
  await page.goto(${JSON.stringify(pair.url)});
  await page.waitForSelector(".code", { timeout: 20000 });
}
await page.waitForTimeout(800);
await snap(${JSON.stringify(pshot('pair-code'))});`)
  await waitFor(
    `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('같아요, 연결'))`,
    30_000,
    '확인 코드',
  )
  await sleep(800)
  note('PC와 폰에 같은 확인 코드', await shot('pair-confirm'))
  await click('같아요, 연결')
  await sleep(1500)
  note('폰 연결됨', await shot('paired'))

  // 6. 폰에서 부탁 → 로그인 카드 → 두리가 로그인
  await phone(`await page.waitForSelector(".quick", { timeout: 30000 });
await page.waitForTimeout(2500);
await snap(${JSON.stringify(pshot('home'))});
await page.fill("textarea", "두리 시험 쇼핑몰(http://127.0.0.1:8791/)에 로그인해 줘");
await page.click(".send");
await page.waitForSelector(".worklog li", { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(1500);
await snap(${JSON.stringify(pshot('working'))});
await page.waitForSelector(".login-card form", { timeout: 300000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await snap(${JSON.stringify(pshot('login-card'))});
await page.fill("#login-user", "dool2@example.com");
await page.fill("#login-pw", "test-password");
await snap(${JSON.stringify(pshot('login-typed'))});
await page.click(".login-card button");
await page.waitForSelector(".activity", { timeout: 30000 }).catch(() => {});
await page.waitForFunction(() => !document.querySelector(".activity") && document.querySelectorAll(".msg.assistant").length >= 2, undefined, { timeout: 300000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await snap(${JSON.stringify(pshot('login-done'))});`)
  note('폰: 부탁 → 로그인 카드 → 금고에 저장 → 두리가 로그인', '')

  // 7. PC에서도 폰 대화가 보이는지, PC 앱 조작 설정
  await click('닫기')
  await sleep(1500)
  await js(`[...document.querySelectorAll('.threads button')][0]?.click()`)
  await sleep(2500)
  note('폰에서 맡긴 일이 PC에도', await shot('thread-from-phone'))
  await click('', '#open-settings')
  await waitFor(`!!document.querySelector('.setup-card .checks')`, 30_000, '설정')
  await js(
    `[...document.querySelectorAll('.setup-card .over')].find((e) => e.textContent.includes('PC 앱 조작'))?.scrollIntoView({ block: 'start' })`,
  )
  await sleep(1200)
  note('설정: PC 앱 조작 (권한 상태·허용한 앱)', await shot('settings-pc-control'))
  await click('닫기')
  await sleep(1000)
} catch (e) {
  note('멈춘 곳', String(e.message))
  await shot('error').catch(() => {})
} finally {
  await cdp('Page.stopScreencast').catch(() => {})
  writeFileSync(join(OUT, 'steps.json'), JSON.stringify(steps, null, 2))
  // 영상: 화면이 바뀐 프레임을 시간대로 잇되, 오래 기다린 구간은 1.5초로 줄인다
  const list = frames.map((f, i) => {
    const next = frames[i + 1]?.t ?? f.t + 1500
    return `file '${f.f}'\nduration ${Math.min(Math.max((next - f.t) / 1000, 0.04), 1.5).toFixed(3)}`
  })
  if (frames.length) {
    list.push(`file '${frames.at(-1).f}'`)
    writeFileSync(join(OUT, 'frames.txt'), list.join('\n'))
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      join(OUT, 'frames.txt'),
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-fps_mode',
      'vfr',
      '-pix_fmt',
      'yuv420p',
      join(OUT, 'pc.mp4'),
    ])
  }
  log('프레임', frames.length, '→', join(OUT, 'pc.mp4'))
  ws.close()
  await relay.close()
  shop.close()
  shop2.close()
  if (space !== undefined) await ego(`const t = await taskSpace(${space}); await t.finish({ keep: [] });`)
  process.exit(0)
}
