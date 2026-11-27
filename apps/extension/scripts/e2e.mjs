// Extension end-to-end check: load the extension into a test Chrome (Chrome for Testing), attach it to the real Dool2 daemon over native messaging,
// and run open tab -> read -> type -> click -> screen capture. The user's Chrome and profile are not touched.
//
//   pnpm build
//   DOOL2_TEST_CHROME=".../Google Chrome for Testing" node apps/extension/scripts/e2e.mjs
//
// (regular Chrome 137+ blocks --load-extension, so use Chrome for Testing:
//  npx @puppeteer/browsers install chrome@stable)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserTools, FileTools, memorySecrets, RouteBook, startDaemon, Vault } from '@dool2/daemon'

const chromeBin = process.env.DOOL2_TEST_CHROME
if (!chromeBin) {
  console.error('Set DOOL2_TEST_CHROME to the path of the Chrome for Testing executable')
  process.exit(2)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.env.DOOL2_E2E_OUT ?? join(root, 'out')
mkdirSync(out, { recursive: true })

// ── Test web pages ──
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
  '/viewer': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>증명서 보기</title></head><body style="margin:0;background:#888">
<div id="bar" style="height:40px;background:#eee">TOOLBAR <button>인쇄</button></div>
<canvas id="doc" width="714" height="1010" style="display:block;margin:10px auto;background:#fff"></canvas>
<button id="close">닫기</button>
<script>const c=document.getElementById('doc').getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,714,1010);c.fillStyle='#000';c.font='40px sans-serif';c.fillText('CERTIFICATE',200,200)</script>
</body></html>`,
  '/login': `<!doctype html><title>로그인</title><h1>로그인</h1>
<form action="/welcome" method="get"><label>아이디 <input name="id"></label> <label>비밀번호 <input type="password" name="pw"></label> <button>로그인</button></form>`,
  '/popup': '<!doctype html><title>새 창</title><h1>새 창이에요</h1>',
  // Imitates a phone React site (Catch Table): list rows are a div with only an onClick handler, no pointer cursor and no role.
  // The search box reflects input into state a little late, so pressing Enter right after typing makes an empty search
  '/app': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>맛집 앱</title></head><body>
<input id="q" placeholder="어떤 맛집 찾으시나요?">
<div id="list"><div class="row"><span>성수 사위식당</span> <span>4.3 · 한식</span></div>
<div class="row"><span>성수 까망</span> <span>4.7 · 이탈리아음식</span></div></div>
<div role="radiogroup" aria-label="테이블 타입"><label role="radio" aria-checked="false" aria-label="홀" tabindex="0" id="hall"><input type="radio" name="seat" aria-hidden="true" tabindex="-1" style="appearance:none;position:absolute;width:0;height:0;margin:0;border:0"><span aria-hidden="true">홀</span></label><label role="radio" aria-checked="false" aria-disabled="true" aria-label="룸" tabindex="0">룸</label></div>
<div id="cards"><div class="card"><b>가게 가</b> <i>조용한 한식집</i> <span class="chip">27일 예약</span></div>
<div class="card"><b>가게 나</b> <i>시끄러운 술집</i> <span class="chip">27일 예약</span></div></div>
<button id="shuffle">섞기</button>
<div id="times"><label><input type="radio" name="t" value="1900" style="position:absolute;width:0;height:0;margin:0;opacity:0;appearance:none"><span>오후 7:00</span></label>
<label><input type="radio" name="t" value="1930" style="position:absolute;width:0;height:0;margin:0;opacity:0;appearance:none"><span>오후 7:30</span></label></div>
<div style="display:contents"><button id="dc" style="display:contents" onclick="document.title='상자 없는 버튼'"><span>지도에서 보기</span></button></div>
<div style="position:relative;height:60px"><button id="under" onclick="document.title='아래 버튼'">아래 버튼</button>
<div id="pop" style="position:absolute;inset:0;background:#fff"><button onclick="document.title='팝업 예약'" style="width:100%;height:100%">팝업 예약</button></div></div>
<div id="plain"><span>골목 식당 카드</span> <small>4.6 (394)</small></div>
<a href="#" id="pinkey" onclick="event.preventDefault();window.__pin=(window.__pin||0)+1;document.title='비밀번호 '+window.__pin+'자리'">7</a>
<div class="stepper"><div><button disabled><svg width="12" height="12"><path d="M0 6h12"/></svg></button></div><div>0</div><div><button><svg width="12" height="12"><path d="M0 6h12M6 0v12"/></svg></button></div></div>
<button class="IconClose" style="width:24px;height:24px"><svg width="12" height="12"><path d="M0 0l12 12"/></svg></button>
<div role="dialog" style="width:320px;height:220px"><img alt="" width="300" height="160" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button>닫기</button></div>
<div id="long">${'성수동 골목 이야기 '.repeat(20)}<span>끝 문장</span></div>
<script>
const props = (el, p) => { el['__reactProps$t3st'] = p; el.addEventListener('click', (e) => p.onClick?.(e)) }
for (const r of document.querySelectorAll('.row')) props(r, { onClick: () => { document.title = '고름: ' + r.firstChild.textContent } })
props(document.getElementById('long'), { onClick: () => {} })
const hall = document.getElementById('hall')
hall.addEventListener('click', () => hall.setAttribute('aria-checked', 'true'))
for (const c of document.querySelectorAll('.chip'))
  props(c, { onClick: () => { document.title = '예약: ' + c.parentElement.querySelector('b').textContent } })
// Imitates list row recycling: draws a different shop in the same row (DOM)
document.getElementById('shuffle').addEventListener('click', () => {
  const [a, b] = document.querySelectorAll('.card')
  for (const sel of ['b', 'i']) {
    const t = a.querySelector(sel).textContent
    a.querySelector(sel).textContent = b.querySelector(sel).textContent
    b.querySelector(sel).textContent = t
  }
})
// A box with neither a handler mark nor a pointer cursor (the site takes clicks higher up): it can only be clicked by its text
document.addEventListener('click', (e) => { if (e.target.closest?.('#plain')) document.title = '고름: 골목 식당' })
let kw = ''
const q = document.getElementById('q')
q.addEventListener('input', () => setTimeout(() => { kw = q.value }, 100))
q.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.title = '검색: ' + (kw || '(빈칸)') })
</script></body></html>`,
  // Connector engine: pull a list (leaving out hidden rows; selector, attribute, row and regex per field)
  '/list': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>가게 목록</title></head><body>
<ul id="shops"><li class="shop"><a href="/shop/1"><b>가게 가</b></a>
<p>4.5 (120) · 한식</p><em>오후 7:00</em><em>오후 7:30</em></li>
<li class="shop"><a href="/shop/2"><b>가게 나</b></a>
<p>4.1 (8) · 술집</p></li>
<li class="shop" style="display:none"><b>숨은 가게</b></li></ul>
<script>fetch('/api/items?q=%EC%84%B1%EC%88%98').then((r) => r.json()).then((d) => { document.title = '목록 ' + d.items.length })</script>
</body></html>`,
  // Site dialogs: alert, confirm, prompt, an alert while opening, a leave-page confirmation
  '/dialogs': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>알림창 가게</title></head><body>
<h1>알림창 가게</h1><p>사과 1kg 9,900원. 버튼마다 사이트 알림창이 떠요.</p>
<button onclick="alert('아이디 또는 비밀번호가 틀렸어요'); document.title='알림 뒤'">로그인</button>
<button onclick="document.title = confirm('장바구니로 이동할까요?') ? '이동함' : '머무름'">담기</button>
<button onclick="document.title = '수량 ' + prompt('수량을 넣어 주세요', '1')">수량</button>
<button onclick="document.title = confirm('사과 1kg 9,900원을 주문하시겠습니까?') ? '주문됨' : '주문 안 함'">다음</button>
</body></html>`,
  '/hello-alert':
    '<!doctype html><meta charset="utf-8"><title>여는 중 알림</title><script>alert("로그인이 필요한 서비스입니다")</script><h1>로그인이 필요해요</h1>',
  '/leave': `<!doctype html><meta charset="utf-8"><title>쓰는 중</title><h1>글쓰기</h1><label>제목 <input id="t"></label>
<script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = '' })</script>`,
  // Many actions at once: several fields + consent checkboxes + next
  '/join': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>가입</title></head><body>
<h1>회원 가입</h1><p>배송받을 분의 정보를 넣어 주세요. ${'자주 묻는 질문과 안내 문구가 길게 이어져요. '.repeat(60)}</p>
<form action="/join/done"><label>이름 <input name="name"></label><br><label>휴대폰 번호 <input name="phone"></label><br>
<label>주소 <input name="addr"></label><br>
<label><input type="checkbox" name="a1" required> 이용약관 동의 (필수)</label><br><label><input type="checkbox" name="a2" required> 개인정보 수집 동의 (필수)</label><br>
<button>다음</button></form></body></html>`,
  // A long page: a long menu at the top and 200 products
  '/long': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>긴 목록</title></head><body>
<nav>${Array.from({ length: 300 }, (_, i) => `<a href="/c/${i}">카테고리 메뉴 ${i}</a>`).join(' ')}</nav>
<h1>검색 결과</h1><ul>${Array.from({ length: 200 }, (_, i) => `<li style="height:40px">상품 ${i + 1} 사과 ${i + 1}kg ${(i + 1) * 1000}원 <button onclick="document.title='담음 ${i + 1}'">담기</button></li>`).join('')}</ul>
</body></html>`,
  // Mouse: a menu that opens only on hover, and a button that counts movements before the click
  '/hover': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>마우스 가게</title>
<style>body{font:16px sans-serif;margin:40px}.menu{position:relative}.menu .sub{display:none;position:absolute;top:100%;left:0;background:#fff;border:1px solid #ccc;padding:8px}.menu:hover .sub{display:block}#buy{margin-top:220px;margin-left:300px;padding:12px 20px}</style></head><body>
<h1>마우스 가게</h1><p>카테고리에 마우스를 올리면 코너가 펼쳐져요.</p>
<div class="menu"><a href="/c" id="cat">과일 카테고리</a><div class="sub"><a href="/c/apple">사과 코너</a></div></div>
<div id="jsmenu" style="position:absolute;left:600px;top:150px"><a href="/v" id="veg">채소 카테고리</a><div id="jssub" hidden><a href="/v/1">배추 코너</a></div></div>
<button id="buy">장바구니 담기</button>
<script>let moves = 0; document.addEventListener('mousemove', () => moves++)
document.getElementById('jsmenu').addEventListener('mouseenter', () => { document.getElementById('jssub').hidden = false })
document.getElementById('buy').addEventListener('click', () => { document.title = '움직임 ' + moves })</script>
</body></html>`,
  // PC file upload: a button that opens a hidden file field, a visible file field, and a button that creates the field on click (a field not attached to the document)
  '/upload': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>블로그 글쓰기</title></head><body>
<h1>블로그 글쓰기</h1><p>사진과 서류를 올려 주세요.</p>
<div class="toolbar"><input type="file" id="pic" accept="image/*" multiple style="display:none">
<button id="add" onclick="document.getElementById('pic').click()">사진 추가</button></div>
<p><label>영수증 <input type="file" id="rcpt" accept=".pdf,image/*"></label></p>
<div><button id="doc">서류 첨부</button></div>
<script>
const read = async (fs) => (await Promise.all([...fs].map(async (f) => f.name + ':' + f.size + ':' + (await f.text()) + ':' + f.type))).join(',')
const pic = document.getElementById('pic')
let ev = []
pic.addEventListener('input', () => ev.push('input'))
pic.addEventListener('change', async () => { ev.push('change'); document.title = '사진 ' + (await read(pic.files)) + ' ' + ev.join('+'); ev = [] })
const rcpt = document.getElementById('rcpt')
rcpt.addEventListener('change', async () => { document.title = '영수증 ' + (await read(rcpt.files)) })
document.getElementById('doc').addEventListener('click', () => {
  const i = document.createElement('input'); i.type = 'file'
  i.onchange = async () => { document.title = '서류 ' + (await read(i.files)) }
  i.click()
})
</script></body></html>`,
  '/captcha':
    '<!doctype html><title>확인</title><h1>로그인</h1><p>자동입력 방지 문자를 입력해 주세요</p><img src="/x" alt="보안문자">',
  // Frames with an empty address (a payment company creates an about:blank frame and fills it with script) and a srcdoc frame
  '/blank-frames': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>결제 액자</title></head><body style="margin:30px">
<h1>주문서</h1><p>결제 수단을 골라 주세요.</p>
<iframe id="amount" style="width:360px;height:80px;border:0;margin-left:120px"></iframe>
<iframe id="pick" style="width:360px;height:90px;border:2px solid #ccc;margin:40px 0 0 220px" srcdoc="<!doctype html><meta charset=utf-8><button style='margin:20px 0 0 60px' onclick=&quot;document.body.insertAdjacentHTML('beforeend','<p>카드 골랐어요</p>')&quot;>카드 선택</button>"></iframe>
<script>const d = document.getElementById('amount').contentDocument; d.open(); d.write('<!doctype html><meta charset=utf-8><p>결제 금액 12,300원</p>'); d.close()</script>
</body></html>`,
  // A new window that opens late, and two windows at once (Chrome blocks the second)
  '/pops': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>새 창 가게</title></head><body>
<h1>새 창 가게</h1>
<button onclick="setTimeout(() => window.open('/popup?late'), 2000)">늦게 새 창</button>
<button onclick="window.open('/popup?one'); window.open('/popup?two')">두 창</button>
</body></html>`,
  // A screen that changes long after the click (payment completion appears late)
  '/later': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>늦은 가게</title></head><body>
<h1>늦은 가게</h1>
<button onclick="setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p>결제 완료 주문번호 A-123</p>'), 3500)">결제 확인</button>
</body></html>`,
  // A keypad at the bottom of the page (visible after scrolling) and a fixed keypad cut off below the screen (not visible even after scrolling)
  '/keypad': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>키패드</title></head><body style="margin:0">
<h1>결제 비밀번호</h1><div style="height:2200px">위쪽 안내</div>
<div id="pad">${[1, 2, 3].map((n) => `<button style="width:80px;height:50px" onclick="document.title='누름 ${n}'">${n}</button>`).join('')}</div>
<div style="position:fixed;left:20px;top:1150px"><button style="width:90px;height:50px" onclick="document.title='고정 9'">9</button></div>
</body></html>`,
  // Imitates Naver Blog writing (SmartEditor ONE): the whole editor is inside a same-site frame, and the title and body are drawn boxes, not text fields.
  // On press (mousedown) it gives focus to a contenteditable (input buffer) inside a hidden about:blank frame, redraws the text that arrives there, then clears the buffer.
  // It does not accept text from script-only focus or text put outside the buffer. Enter moves from the title to the body, and in the body starts a new paragraph
  '/se-write': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>블로그 글쓰기</title></head><body style="margin:0">
<iframe id="mainFrame" src="/se-form" style="width:1000px;height:700px;border:0"></iframe></body></html>`,
  '/se-form': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>글쓰기</title>
<style>body{font:15px sans-serif;margin:30px}.comp{position:relative;min-height:40px;margin:20px 0;cursor:text}
.se-placeholder{position:absolute;left:0;top:0;color:#999;pointer-events:none}.title p{font-size:30px;margin:0;min-height:40px}
.body p{margin:0 0 8px;min-height:22px}#buf{position:absolute;left:-9999px;top:0;width:1px;height:1px;border:0;opacity:0}</style></head><body>
<div class="toolbar"><button>사진 추가</button> <button onclick="document.title='발행됨'">발행</button>
<span class="find"><span class="placeholder">글감 찾기</span><input aria-label="글감 검색"></span></div>
<div class="comp title" data-c="title"><div class="se-module"><p class="se-text-paragraph"></p><span class="se-placeholder __se_placeholder se-fs32">제목</span></div></div>
<div class="comp body" data-c="body"><div class="se-module"><p class="se-text-paragraph"></p><span class="se-placeholder __se_placeholder se-fs15">글감과 함께 나의 일상을 기록해보세요!</span></div></div>
<iframe id="buf"></iframe>
<script>
const buf = document.getElementById('buf')
const bd = buf.contentDocument
bd.open(); bd.write('<!doctype html><body contenteditable="true"></body>'); bd.close()
let active = null
const paras = (c) => [...c.querySelectorAll('p')]
const sync = (c) => { c.querySelector('.se-placeholder').style.display = paras(c).some((p) => p.textContent) ? 'none' : '' }
for (const c of document.querySelectorAll('.comp'))
  c.addEventListener('mousedown', (e) => { e.preventDefault(); active = c; buf.contentWindow.focus(); bd.body.focus() })
bd.body.addEventListener('input', () => {
  const t = bd.body.textContent
  bd.body.textContent = ''
  if (!active || !t) return
  const p = paras(active).at(-1)
  p.textContent += t
  sync(active)
})
bd.body.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !active) return
  e.preventDefault()
  if (active.dataset.c === 'title') { active = document.querySelector('.body'); return }
  const p = document.createElement('p'); p.className = 'se-text-paragraph'
  active.querySelector('.se-module').insertBefore(p, active.querySelector('.se-placeholder'))
})
</script></body></html>`,
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
  if (url.pathname === '/join/done') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    const v = (k) => (url.searchParams.get(k) ?? '').replace(/[<>&]/g, '')
    return res.end(
      `<!doctype html><title>가입 확인</title><h1>가입 정보 확인</h1><p>${v('name')} / ${v('phone')} / ${v('addr')} / 동의 ${v('a1')}${v('a2')}</p>`,
    )
  }
  // A collection of tricky shapes met on real sites: open shadow DOM, a frame at another address, a screen that navigates late, downloads
  if (url.pathname === '/robust') {
    const port = site.address().port
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>까다로운 가게</title></head><body>
<h1>까다로운 가게</h1><p>여러 가지 모양의 버튼이 있어요. 하나씩 눌러 보세요.</p>
<div id="topbar"></div>
<shop-card></shop-card>
<button onclick="setTimeout(() => { location.href = '/search?q=late' }, 600)">늦게 넘어가기</button>
<a href="/file.csv" download="주문내역.csv">주문 내역 내려받기</a>
<button id="keep" onclick="document.title='그대로 눌림'">그대로 버튼</button>
<button onclick="document.getElementById('topbar').innerHTML = '<p>새 배너가 위에 생겼어요</p><button>배너 닫기</button>'">배너 띄우기</button>
<iframe src="http://localhost:${port}/frame" style="width:420px;height:120px;border:1px solid #ccc"></iframe>
<script>customElements.define('shop-card', class extends HTMLElement { connectedCallback() {
  const r = this.attachShadow({ mode: 'open' })
  r.innerHTML = '<p>그림자 속 상품 귤 3kg</p><button>귤 담기</button>'
  r.querySelector('button').addEventListener('click', () => { document.title = '귤 담음' })
} })</script></body></html>`)
  }
  // Nested frames: page (127.0.0.1) -> delivery address window (localhost) -> address search window (127.0.0.1). Positions are offset at each step
  if (url.pathname === '/nested') {
    const port = site.address().port
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>겹친 액자</title></head><body style="margin:0">
<h1 style="margin:20px">주문서</h1><p style="margin:20px">배송지를 추가해 주세요.</p>
<iframe src="http://localhost:${port}/nest1" style="position:absolute;left:300px;top:180px;width:620px;height:460px;border:6px solid #999;padding:10px"></iframe>
</body></html>`)
  }
  if (url.pathname === '/nest1') {
    const port = site.address().port
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#f6f6f6"><p style="margin:12px">배송지 추가 창</p>
<iframe src="http://127.0.0.1:${port}/nest2" style="margin:60px 0 0 150px;width:380px;height:220px;border:3px solid #333"></iframe></body>`)
  }
  if (url.pathname === '/nest2') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(
      '<!doctype html><meta charset="utf-8"><body style="margin:0"><p style="margin:10px">주소 찾기 결과</p><button style="margin:50px 0 0 90px;width:140px;height:40px" onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>주소 골랐어요: 서울 성동구</p>\')">서울 성동구</button></body>',
    )
  }
  if (url.pathname === '/frame') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(
      '<!doctype html><meta charset="utf-8"><title>액자</title><p>다른 주소 액자 안 쿠폰</p><button onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>쿠폰 받음</p>\')">쿠폰 받기</button>',
    )
  }
  if (url.pathname === '/file.csv') {
    res.writeHead(200, {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="orders.csv"',
    })
    return res.end('주문,금액\n사과,9900\n')
  }
  if (url.pathname === '/api/items') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ items: [{ name: '가게 가', q: url.searchParams.get('q') }] }))
  }
  if (url.pathname === '/search') {
    const q = url.searchParams.get('q') ?? ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(
      `<!doctype html><title>검색 결과</title><h1>"${q.replace(/[<>&"]/g, '')}" 검색 결과</h1><p>사과 1kg 9,900원</p>`,
    )
  }
  // Remembered routes (ADR 0034): home → [마이페이지] → [주문목록]
  if (url.pathname.startsWith('/r/')) {
    const pages = {
      '/r/home':
        '<!doctype html><title>길 가게</title><h1>길 가게</h1><a href="/r/my">마이페이지</a> <a href="/r/help">고객센터</a>',
      '/r/my':
        '<!doctype html><title>마이페이지</title><h1>마이페이지</h1><a href="/r/orders">주문목록</a> <a href="/r/home">홈</a>',
      '/r/orders': '<!doctype html><title>주문목록</title><h1>주문목록</h1><p>귤 5kg 배송 중</p>',
    }
    const body = pages[url.pathname]
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(body ?? 'not found')
  }
  // A page whose content is on screen at once but whose load event waits on a slow ad image (like many shopping sites)
  if (url.pathname === '/slow-ad') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(`<!doctype html><title>광고 많은 가게</title><h1>광고 많은 가게</h1>
<p>오늘의 특가: 귤 5kg 12,900원</p><img src="/slow-ad.gif" width="300" height="100" alt="">`)
  }
  if (url.pathname === '/slow-ad.gif') {
    const timer = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'image/gif' })
      res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'))
    }, 15_000)
    req.on('close', () => clearTimeout(timer))
    return
  }
  const body = PAGES[url.pathname]
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body ?? 'not found')
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${site.address().port}`

// ── Dool2 daemon + test Chrome ──
const tmp = mkdtempSync(join(tmpdir(), 'dool2-e2e-'))
const profile = join(tmp, 'profile')
const daemon = await startDaemon({
  dataDir: join(tmp, 'data'),
  // With DOOL2_E2E_AGENT=claude|codex it runs the conversation with a real AI too (it uses that AI's login and usage)
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
    // macOS: a test profile never asks for the login keychain (a prompt nobody answers blocks the installed app)
    '--use-mock-keychain',
    '--password-store=basic',
    '--window-size=1200,900',
    // GitHub Linux runners cannot use the Chrome sandbox (user namespace restriction)
    ...(process.env.CI ? ['--no-sandbox'] : []),
    'about:blank',
  ],
  { stdio: 'ignore' },
)

// If one step fails the remaining steps still run so the whole result is visible (only steps that need an earlier step stop)
// With DOOL2_E2E_ONLY="upload", only steps whose name contains that word (and steps they need) run
const only = process.env.DOOL2_E2E_ONLY
const step = async (name, fn, { must = false } = {}) => {
  if (only && !must && !name.includes(only)) return undefined
  const t = Date.now()
  try {
    const r = await fn()
    console.log(`✓ ${name} (${Date.now() - t}ms)`)
    return r
  } catch (e) {
    console.log(`✗ ${name}: ${e.message}`)
    failed = true
    if (must) throw e
  }
}
const call = (cmd, args) => daemon.browser.call(cmd, args)

let failed = false
try {
  await step(
    'The extension attaches to the daemon',
    async () => {
      for (let i = 0; i < 150 && !daemon.browser.status.connected; i++)
        await new Promise((r) => setTimeout(r, 200))
      assert.equal(daemon.browser.status.connected, true, 'Did not connect within 30 seconds')
      console.log(`  ${JSON.stringify(daemon.browser.status)}`)
    },
    { must: true },
  )

  const { tabId } = await step(
    'Open a tab',
    async () => {
      const r = await call('open', { url: base })
      assert.equal(r.title, '두리 시험 가게')
      return r
    },
    { must: true },
  )

  const snap = await step(
    'Read the page',
    async () => {
      const r = await call('snapshot', { tabId })
      writeFileSync(join(out, 'e2e-snapshot.txt'), r.text)
      assert.match(r.text, /# 두리 시험 가게/)
      assert.match(r.text, /사과 1kg 9,900원/)
      assert.match(r.text, /\[e\d+ 입력칸 "검색어"\]/)
      assert.match(r.text, /\[e\d+ 비밀번호칸 "비밀번호"\]/)
      assert.doesNotMatch(r.text, /숨은 버튼/)
      assert.equal(r.captcha, false)
      return r
    },
    { must: true },
  )
  const ref = (re) => {
    const m = snap.text.match(re)
    assert.ok(m, `${re} was not found`)
    return m[1]
  }

  await step('Does not type into a password field', async () => {
    await assert.rejects(call('type', { tabId, ref: ref(/\[(e\d+) 비밀번호칸/), text: 'x' }), /vault/)
  })

  await step('A page script reads and computes, and cannot act (ADR 0045)', async () => {
    const r = await call('eval', {
      tabId,
      expression: "[...document.querySelectorAll('li b')].map((b) => b.textContent)",
    })
    assert.deepEqual(r.value, ['9,900원', '15,000원'])
    const act = await call('eval', { tabId, expression: "document.querySelector('li button').click()" })
    assert.match(String(act.error), /side.?effect/i)
    assert.equal((await call('snapshot', { tabId })).title, '두리 시험 가게')
  })

  await step('Saving a viewer as PDF prints only the document, not its toolbar (0.3.6)', async () => {
    const v = await call('open', { url: `${base}/viewer` })
    const r = await call('pdf', { tabId: v.tabId })
    assert.equal(r.part, 'document')
    assert.equal(r.pages, 1)
    assert.ok(Buffer.from(r.data, 'base64').subarray(0, 5).toString('latin1') === '%PDF-')
    // Nothing is left on the page afterwards
    const left = await call('eval', {
      tabId: v.tabId,
      expression: "document.querySelectorAll('#dool2-print-only, #dool2-print-style').length",
    })
    assert.equal(left.value, 0, left.error)
    const whole = await call('pdf', { tabId: v.tabId, only: 'page' })
    assert.equal(whole.part, 'page')
    await call('close', { tabId: v.tabId })
  })

  await step('Asking Chrome for an update answers with a status (0.3.5)', async () => {
    const r = await call('update', {})
    assert.equal(typeof r.status, 'string')
  })

  await step('DevTools: print to PDF is on the list, cookies are not', async () => {
    const r = await call('cdp', { tabId, method: 'Page.printToPDF', params: {} })
    assert.ok(Buffer.from(r.data, 'base64').subarray(0, 5).toString('latin1') === '%PDF-')
    await assert.rejects(call('cdp', { tabId, method: 'Network.getCookies', params: {} }), /not on the list/)
  })

  await step('Type and press Enter', async () => {
    const r = await call('type', { tabId, ref: ref(/\[(e\d+) 입력칸 "검색어"/), text: '사과', submit: true })
    assert.match(r.url, /\/search\?q=%EC%82%AC%EA%B3%BC/)
    assert.equal(r.title, '검색 결과')
  })

  await step('Screen capture', async () => {
    const r = await call('screenshot', { tabId })
    assert.equal(r.mime, 'image/jpeg')
    writeFileSync(join(out, 'e2e-search.jpg'), Buffer.from(r.data, 'base64'))
  })

  await step('Go back and click a link -> the new tab is a Dool2 tab too', async () => {
    await call('back', { tabId })
    const s = await call('snapshot', { tabId })
    const link = s.text.match(/\[(e\d+) 링크 "새 창으로 보기"\]/)?.[1]
    assert.ok(link)
    const t = Date.now()
    const r = await call('click', { tabId, ref: link })
    assert.ok(Date.now() - t < 3000, `The click is too slow (${Date.now() - t}ms)`)
    assert.ok(r.newTabId, 'No new tab id')
    const p = await call('snapshot', { tabId: r.newTabId })
    assert.match(p.text, /새 창이에요/)
    // Even while the new tab is in front, the original tab's button can be clicked (a background tab takes no input, so it is brought to the front)
    const buy = s.text.match(/\[(e\d+) 버튼 "바로 구매"\]/)?.[1]
    const bought = await call('click', { tabId, ref: buy })
    assert.equal(bought.title, '구매됨')
    await call('close', { tabId: r.newTabId })
  })

  await step('Scroll', async () => {
    await call('scroll', { tabId, direction: 'down' })
  })

  await step(
    'Read React click boxes so they can be clicked, and a late-reflecting field is searched with Enter',
    async () => {
      await call('navigate', { tabId, url: `${base}/app` })
      const s = await call('snapshot', { tabId })
      writeFileSync(join(out, 'e2e-app-snapshot.txt'), s.text)
      const row = s.text.match(/\[(e\d+) 버튼 "성수 까망 4\.7 · 이탈리아음식"\]/)?.[1]
      assert.ok(row, `The list row has no mark:\n${s.text}`)
      // A long box only gets a mark and its inner text is read as is
      assert.match(s.text, /끝 문장/)
      const picked = await call('click', { tabId, ref: row })
      assert.equal(picked.title, '고름: 성수 까망')
      const q = s.text.match(/\[(e\d+) 입력칸 "어떤 맛집 찾으시나요\?"\]/)?.[1]
      const r = await call('type', { tabId, ref: q, text: '성수', submit: true })
      assert.equal(r.title, '검색: 성수')
    },
  )

  await step(
    'Read a radio label that wraps a hidden field, and do not click the wrong thing when a row is recycled',
    async () => {
      await call('navigate', { tabId, url: `${base}/app` })
      const s = await call('snapshot', { tabId })
      const hall = s.text.match(/\[(e\d+) 라디오 "홀"\]/)?.[1]
      assert.ok(hall, `The radio "홀" is missing:\n${s.text}`)
      assert.match(s.text, /라디오 "룸" 비활성/)
      await call('click', { tabId, ref: hall })
      assert.match((await call('snapshot', { tabId })).text, /라디오 "홀" 선택됨/)
      const s2 = await call('snapshot', { tabId })
      const chipA = s2.text.match(/가게 가 조용한 한식집 \[(e\d+) 버튼 "27일 예약"\]/)?.[1]
      assert.ok(chipA, `The date chip of 가게 가 is missing:\n${s2.text}`)
      await call('click', { tabId, ref: s2.text.match(/\[(e\d+) 버튼 "섞기"\]/)?.[1] })
      await assert.rejects(call('click', { tabId, ref: chipA }), /Read again and choose/)
      const s3 = await call('snapshot', { tabId })
      const chip = s3.text.match(/가게 가 조용한 한식집 \[(e\d+) 버튼 "27일 예약"\]/)?.[1]
      const r = await call('click', { tabId, ref: chip })
      assert.equal(r.title, '예약: 가게 가')
    },
  )

  await step('A hidden radio clicks its label, and a box-less button clicks its inner text', async () => {
    await call('navigate', { tabId, url: `${base}/app` })
    const s = await call('snapshot', { tabId })
    const t730 = s.text.match(/\[(e\d+) 라디오 "오후 7:30"\]/)?.[1]
    assert.ok(t730, `The time radio is missing:\n${s.text}`)
    await call('click', { tabId, ref: t730 })
    assert.match((await call('snapshot', { tabId })).text, /라디오 "오후 7:30" 선택됨/)
    const dc = s.text.match(/\[(e\d+) 버튼 "지도에서 보기"\]/)?.[1]
    assert.ok(dc, `The box-less button is missing:\n${s.text}`)
    assert.equal((await call('click', { tabId, ref: dc })).title, '상자 없는 버튼')
  })

  await step('Does not click a spot covered by another button', async () => {
    await call('navigate', { tabId, url: `${base}/app` })
    const s = await call('snapshot', { tabId })
    const under = s.text.match(/\[(e\d+) 버튼 "아래 버튼"\]/)?.[1]
    assert.ok(under, `The lower button is missing:\n${s.text}`)
    await assert.rejects(call('click', { tabId, ref: under }), /is covered by another button/)
    const t = await call('snapshot', { tabId })
    assert.doesNotMatch(t.text, /팝업 예약 눌림/)
  })

  await step('A box with no mark is clicked by its on-screen text', async () => {
    const tools = new BrowserTools(daemon.browser)
    const text = (r) => r.content.map((c) => c.text ?? '').join('\n')
    await call('navigate', { tabId, url: `${base}/app` })
    const page = text(await tools.run('read', { tabId }))
    assert.doesNotMatch(page, /버튼 "골목 식당 카드/)
    const r = await tools.run('click', { tabId, text: '골목 식당 카드' })
    assert.equal(r.isError, undefined, text(r))
    assert.match(text(r), /고름: 골목 식당/)
  })

  await step('Read nameless icon buttons, quantity buttons, and a popup that is only a picture', async () => {
    await call('navigate', { tabId, url: `${base}/app` })
    const s = await call('snapshot', { tabId })
    assert.match(s.text, /버튼 "수량 줄이기" 비활성\]\s+0\s+\[e\d+ 버튼 "수량 늘리기"\]/, s.text)
    // A name guessed from icon attributes is reported with (guessed) (it is not the name written on the screen)
    assert.match(s.text, /\[e\d+ 버튼 "닫기" \(추정\)\]/)
    assert.match(s.text, /notice is an image and cannot be read as text/)
  })

  await step(
    'A button whose text does not change on click (a keypad digit) is clicked only once',
    async () => {
      await call('navigate', { tabId, url: `${base}/app` })
      const s = await call('snapshot', { tabId })
      const key = s.text.match(/\[(e\d+) 링크 "7"\]/)?.[1]
      assert.ok(key, `The keypad button is missing:\n${s.text}`)
      await call('click', { tabId, ref: key })
      const t = await call('snapshot', { tabId })
      // The page text stays the same, so it used to be reported as "the mouse did not work" and clicked again, giving 2 digits (measured Coupang payment PIN)
      assert.equal(t.title, '비밀번호 1자리')
    },
  )

  await step('커넥터 엔진: 목록 뽑기·글자 찾기·페이지가 받은 응답 읽기', async () => {
    await call('navigate', { tabId, url: `${base}/list` })
    const r = await call('extract', {
      tabId,
      spec: {
        items: 'li.shop',
        fields: {
          name: { css: 'b' },
          link: { css: 'a', attr: 'href' },
          rating: { css: 'p', match: '^(\\d\\.\\d)' },
          kind: { css: 'p', match: '· (\\S+)$' },
          times: { css: 'em', list: true },
        },
      },
    })
    assert.equal(r.total, 3)
    assert.deepEqual(r.rows, [
      {
        name: '가게 가',
        link: `${base}/shop/1`,
        rating: '4.5',
        kind: '한식',
        times: ['오후 7:00', '오후 7:30'],
      },
      { name: '가게 나', link: `${base}/shop/2`, rating: '4.1', kind: '술집', times: [] },
    ])
    const f = await call('find', { tabId, patterns: { has: '가게 나', no: '없는 말' } })
    assert.deepEqual(f.found, { has: '가게 나', no: null })
    // Reading responses the page received by itself: Dool2 sends no request, it only listens
    const opened = await call('open', { url: `${base}/list`, capture: true })
    const d = await call('capture', { tabId: opened.tabId, url: 'api/items', pick: 'items.*.name' })
    assert.deepEqual(d.json, ['가게 가'])
    await assert.rejects(
      call('capture', { tabId: opened.tabId, url: 'api/none', timeoutMs: 600 }),
      /did not receive that data/,
    )
    await call('close', { tabId: opened.tabId })
  })

  await step('Notice a captcha screen', async () => {
    await call('navigate', { tabId, url: `${base}/captcha` })
    const r = await call('snapshot', { tabId })
    assert.equal(r.captcha, true)
  })

  await step('Does not open dangerous addresses', async () => {
    await assert.rejects(call('navigate', { tabId, url: 'javascript:alert(1)' }), /http and https/)
    await assert.rejects(call('open', { url: 'file:///etc/passwd' }), /http and https/)
  })

  await step('Does not touch tabs Dool2 did not open', async () => {
    await assert.rejects(call('snapshot', { tabId: 1 }), /Not a tab Dool2 opened/)
  })

  await step('A closed Dool2 tab is reported as "closed", and hold is accepted', async () => {
    const extra = await call('open', { url: `${base}/login` })
    const held = await call('hold', { tabId: extra.tabId, ms: 60_000 })
    assert.ok(held.until > Date.now())
    await call('close', { tabId: extra.tabId })
    await new Promise((r) => setTimeout(r, 300))
    await assert.rejects(call('snapshot', { tabId: extra.tabId }), /The tab was closed/)
  })

  await step('Log in with the Dool2 vault (the value does not go to the AI)', async () => {
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

  await step(
    'Site dialogs: an alert is closed and its text reported; the AI chooses on confirm and prompt',
    async () => {
      const tools = new BrowserTools(daemon.browser)
      const text = (r) => r.content.map((c) => c.text ?? '').join('\n')
      await call('navigate', { tabId, url: `${base}/dialogs` })
      const page = text(await tools.run('read', { tabId }))
      const btn = (label) => page.match(new RegExp(`\\[(e\\d+) 버튼 "${label}"\\]`))?.[1]
      // alert: does not stop, and its text is read out
      let t = Date.now()
      let r = text(await tools.run('click', { tabId, ref: btn('로그인') }))
      assert.ok(Date.now() - t < 5000, `The alert click is too slow (${Date.now() - t}ms)`)
      assert.match(r, /💬 Site alert: "아이디 또는 비밀번호가 틀렸어요"/)
      assert.match(r, /알림 뒤/)
      // confirm: stays open and is reported to the AI; choosing [Cancel] makes the page receive false
      t = Date.now()
      r = text(await tools.run('click', { tabId, ref: btn('담기') }))
      assert.ok(Date.now() - t < 5000, `The confirm click is too slow (${Date.now() - t}ms)`)
      assert.match(r, /⚠ A site confirm dialog is open: "장바구니로 이동할까요\?"/)
      // While it is open, other commands do not wait and report right away
      t = Date.now()
      await assert.rejects(call('click', { tabId, ref: btn('수량') }), /A site confirm dialog is open/)
      assert.ok(Date.now() - t < 2000)
      r = text(await tools.run('dialog', { tabId, accept: false }))
      assert.match(r, /머무름/)
      // prompt: type text and press [OK]
      r = text(await tools.run('click', { tabId, ref: btn('수량') }))
      assert.match(r, /site confirm dialog is open: "수량을 넣어 주세요"/)
      r = text(await tools.run('dialog', { tabId, accept: true, text: '3' }))
      assert.match(r, /수량 3/)
      // Even if the button ('다음') does not look risky, [OK] on a confirm that places an order is not pressed without approval -> once approved, Dool2 presses it
      text(await tools.run('read', { tabId }))
      r = text(await tools.run('click', { tabId, ref: btn('다음') }))
      assert.match(r, /주문하시겠습니까/)
      const blocked = await tools.run('dialog', { tabId, accept: true })
      assert.equal(blocked.isError, true)
      // Wording after the revamp: instead of blocking, it points to the approval card path (browser_request_approval dialog). What was not pressed is the same
      assert.match(text(blocked), /승인이 필요해요[\s\S]*browser_request_approval\(dialog: true/)
      const asked = await tools.run('request_approval', {
        tabId,
        dialog: true,
        what: '사과 주문',
        where: '시험 가게',
      })
      assert.equal(asked.isError, undefined, text(asked))
      const pending = tools.approvals.list().find((x) => x.status === 'pending')
      assert.equal(pending?.role, '확인 창')
      const done = await tools.approve(pending.id)
      assert.equal(done.ok, true, done.message)
      assert.equal((await call('snapshot', { tabId })).title, '주문됨')
    },
  )

  await step('Does not stop at an alert while opening or a leave-page confirmation', async () => {
    const tools = new BrowserTools(daemon.browser)
    const text = (r) => r.content.map((c) => c.text ?? '').join('\n')
    let t = Date.now()
    const opened = await tools.run('open', { url: `${base}/hello-alert` })
    assert.ok(Date.now() - t < 8000, `Opening took too long (${Date.now() - t}ms)`)
    assert.match(text(opened), /💬 Site alert: "로그인이 필요한 서비스입니다"/)
    assert.match(text(opened), /로그인이 필요해요/)
    const other = Number(text(opened).match(/\[탭 (\d+)\]/)?.[1])
    await call('close', { tabId: other })
    await call('navigate', { tabId, url: `${base}/leave` })
    const s = await call('snapshot', { tabId })
    await call('type', { tabId, ref: s.text.match(/\[(e\d+) 입력칸 "제목"\]/)?.[1], text: '쓰던 글' })
    t = Date.now()
    const moved = await tools.run('navigate', { tabId, url: `${base}/list` })
    assert.ok(Date.now() - t < 8000, `Leaving took too long (${Date.now() - t}ms)`)
    assert.match(text(moved), /\[e\d+ 링크 "가게 가"\]/)
    assert.match(text(moved), /asked whether to leave the page/)
  })

  await step(
    'Many actions at once: faster than filling a form one by one, and less text comes back',
    async () => {
      const tools = new BrowserTools(daemon.browser)
      const text = (r) => r.content.map((c) => c.text ?? '').join('\n')
      const fill = (page) => {
        const ref = (re) => page.match(re)?.[1]
        return [
          { do: 'type', ref: ref(/\[(e\d+) 입력칸 "이름"\]/), text: '김두리' },
          { do: 'type', ref: ref(/\[(e\d+) 입력칸 "휴대폰 번호"\]/), text: '01012345678' },
          { do: 'type', ref: ref(/\[(e\d+) 입력칸 "주소"\]/), text: '서울 성동구 성수동' },
          { do: 'click', ref: ref(/\[(e\d+) 체크박스 "이용약관 동의 \(필수\)"\]/) },
          { do: 'click', ref: ref(/\[(e\d+) 체크박스 "개인정보 수집 동의 \(필수\)"\]/) },
          { do: 'click', ref: ref(/\[(e\d+) 버튼 "다음"\]/) },
        ]
      }
      const done = /김두리 \/ 01012345678 \/ 서울 성동구 성수동 \/ 동의 onon/
      // One by one: call a tool per action, and each tool reads the page and returns it
      await call('navigate', { tabId, url: `${base}/join` })
      let steps = fill(text(await tools.run('read', { tabId })))
      let t = Date.now()
      let chars = 0
      let last = ''
      for (const s of steps) {
        last = text(await tools.run(s.do, { tabId, ...s }))
        chars += last.length
      }
      const one = { calls: steps.length, ms: Date.now() - t, chars }
      assert.match(last, done)
      // At once
      await call('navigate', { tabId, url: `${base}/join` })
      steps = fill(text(await tools.run('read', { tabId })))
      t = Date.now()
      const r = await tools.run('steps', { tabId, steps })
      const all = { calls: 1, ms: Date.now() - t, chars: text(r).length }
      assert.equal(r.isError, undefined, text(r))
      assert.match(text(r), done)
      console.log(`  one by one ${JSON.stringify(one)} -> at once ${JSON.stringify(all)}`)
      assert.ok(all.ms < one.ms, 'At once is slower')
      assert.ok(all.chars * 3 < one.chars, 'The returned text did not shrink enough')
    },
  )

  await step(
    'Read only the needed part: from the line to find in a long page, visible screen only',
    async () => {
      const tools = new BrowserTools(daemon.browser)
      const text = (r) => r.content.map((c) => c.text ?? '').join('\n')
      await call('navigate', { tabId, url: `${base}/long` })
      // Reading from the start shows only the menu and gets cut
      const top = text(await tools.run('read', { tabId }))
      assert.doesNotMatch(top, /상품 150 /)
      assert.match(top, /skip: \d+/)
      // Old way: raise the limit to the maximum and read from the start again
      const big = text(await tools.run('read', { tabId, maxChars: 40000 }))
      // New way: from that line
      const from = text(await tools.run('read', { tabId, from: '상품 150 ' }))
      assert.match(from, /^상품 150 사과/m)
      const buy = from.match(/상품 150 사과 150kg 150000원 \[(e\d+) 버튼 "담기"\]/)?.[1]
      assert.ok(buy, from.slice(0, 400))
      assert.match(text(await tools.run('click', { tabId, ref: buy })), /담음 150/)
      console.log(
        `  상품 150 찾기: 처음부터 크게 ${big.length.toLocaleString()}자${/상품 150 /.test(big) ? '' : '(못 찾음)'} → 그 줄부터 ${from.length.toLocaleString()}자`,
      )
      // Visible screen only: after scrolling the top menu drops out, and the text left above and below is reported
      await call('navigate', { tabId, url: `${base}/long` })
      await tools.run('read', { tabId })
      const scrolled = text(await tools.run('scroll', { tabId, direction: 'down' }))
      assert.match(scrolled, /Read only the part visible on screen/)
      assert.match(scrolled, /↓ About [\d,]+ more characters are below the screen/)
      assert.ok(scrolled.length < 4000, `The visible part is too long (${scrolled.length} chars)`)
      console.log(`  Visible part after scrolling: ${scrolled.length.toLocaleString()} chars`)
    },
  )

  await step(
    'Mouse: move and click, hover opens a menu, and what Dool2 does is shown with a cursor',
    async () => {
      const tools = new BrowserTools(daemon.browser)
      const text = (r) => r.content.map((c) => c.text ?? '').join('\n')
      await call('navigate', { tabId, url: `${base}/hover` })
      const page = text(await tools.run('read', { tabId }))
      assert.doesNotMatch(page, /사과 코너/)
      const cat = page.match(/\[(e\d+) 링크 "과일 카테고리"\]/)?.[1]
      const opened = text(await tools.run('hover', { tabId, ref: cat }))
      // A menu opened by script (mouseenter)
      const veg = text(
        await tools.run('hover', { tabId, ref: opened.match(/\[(e\d+) 링크 "채소 카테고리"\]/)?.[1] }),
      )
      console.log(`  Hover: CSS menu ${/사과 코너/.test(opened)} / script menu ${/배추 코너/.test(veg)}`)
      assert.match(veg, /\[e\d+ 링크 "배추 코너"\]/)
      // Linux virtual screens (xvfb in CI) deliver mouse events but do not reflect CSS :hover (Mac and Windows windows do, measured)
      if (!(process.env.CI && process.platform === 'linux')) assert.match(opened, /\[e\d+ 링크 "사과 코너"\]/)
      const buy = veg.match(/\[(e\d+) 버튼 "장바구니 담기"\]/)?.[1]
      const t = Date.now()
      const r = await call('click', { tabId, ref: buy })
      const moves = Number(r.title.match(/움직임 (\d+)/)?.[1])
      console.log(`  Mouse movements before the click: ${moves}, click ${Date.now() - t}ms`)
      assert.ok(moves >= 3, `Clicked without the mouse moving (${r.title})`)
      const shot = await call('screenshot', { tabId })
      writeFileSync(join(out, 'e2e-cursor.jpg'), Buffer.from(shot.data, 'base64'))
      // The cursor does not get mixed into reads
      assert.doesNotMatch(text(await tools.run('read', { tabId })), /누르는 중/)
    },
  )

  await step(
    'Tricky shapes: shadow DOM, frame at another address, late navigation, downloads, stable marks',
    async () => {
      const tools = new BrowserTools(daemon.browser)
      const text = (r) => r.content.map((c) => c.text ?? '').join('\n')
      await call('navigate', { tabId, url: `${base}/robust` })
      let page = text(await tools.run('read', { tabId }))
      const btn = (label, p = page) => p.match(new RegExp(`\\[(e\\d+) 버튼 "${label}"\\]`))?.[1]
      // Text and button inside an open shadow DOM
      assert.match(page, /그림자 속 상품 귤 3kg/)
      assert.match(text(await tools.run('click', { tabId, ref: btn('귤 담기') })), /귤 담음/)
      // A button inside a frame at another address (localhost)
      page = text(await tools.run('read', { tabId }))
      assert.match(page, /화면 안 액자 \(localhost\)/, page.slice(-600))
      assert.match(text(await tools.run('click', { tabId, ref: btn('쿠폰 받기') })), /쿠폰 받음/)
      // Stable marks: even if a new box appears above, the same button keeps the same mark
      page = text(await tools.run('read', { tabId }))
      const keep = btn('그대로 버튼')
      await tools.run('click', { tabId, ref: btn('배너 띄우기') })
      page = text(await tools.run('read', { tabId }))
      assert.match(page, /새 배너가 위에 생겼어요/)
      assert.equal(btn('그대로 버튼'), keep, 'The mark of the same button changed')
      assert.match(text(await tools.run('click', { tabId, ref: keep })), /그대로 눌림/)
      // Download link: does not stop, and the tab stays usable
      let t = Date.now()
      await tools.run('click', { tabId, ref: page.match(/\[(e\d+) 링크 "주문 내역 내려받기"\]/)?.[1] })
      assert.ok(Date.now() - t < 6000, `The download click is too slow (${Date.now() - t}ms)`)
      page = text(await tools.run('read', { tabId }))
      assert.match(page, /까다로운 가게/)
      // A screen that navigates 0.6s after the click: the new screen is read as the click result
      t = Date.now()
      const moved = text(await tools.run('click', { tabId, ref: btn('늦게 넘어가기') }))
      assert.match(moved, /"late" 검색 결과/, moved.slice(0, 300))
    },
  )

  await step(
    'Nested frames: click the inner frame button exactly with the real mouse, and report the frame tree (measured 11-20 Gmarket)',
    async () => {
      await call('navigate', { tabId, url: `${base}/nested` })
      // The frame appears late: read until the inner button is visible
      let s
      for (let i = 0; i < 10; i++) {
        s = await call('snapshot', { tabId })
        if (/버튼 "서울 성동구"/.test(s.text)) break
        await new Promise((r) => setTimeout(r, 300))
      }
      writeFileSync(join(out, 'e2e-nested.txt'), s.text)
      assert.match(s.text, /## 화면 안 액자 list/, s.text.slice(-800))
      // A frame placeholder at that spot in the body text, and the outer frame in the list
      assert.match(s.text, /\[frame f\d+\]/)
      assert.match(s.text, /- f\d+ 127\.0\.0\.1\/nest2 · outer: f\d+ · visible/, s.text.slice(-800))
      const btn = s.text.match(/\[(e\d+) 버튼 "서울 성동구"\]/)?.[1]
      assert.ok(btn && /^e\d{5,}$/.test(btn), `The inner frame button has no mark:\n${s.text.slice(-800)}`)
      const r = await call('click', { tabId, ref: btn })
      // Click position = outer frame inner (300+6+10) + inner frame inner (150+3) + button center (90+70) = 629.
      // It used to look only in the outer document and, if not found, assume (0,0) and click near 160
      assert.ok(Math.abs(r.point.x - 629) <= 2, JSON.stringify(r))
      assert.ok(r.point.y > 300 && r.point.y < 560, JSON.stringify(r))
      assert.equal(r.delivered, true, JSON.stringify(r))
      // In a window that paints (CI virtual screen) the real mouse reaches it. In an occluded window the mouse does not reach a frame at another address, so it is clicked by keyboard
      console.log(`  Click position ${JSON.stringify(r.point)} · ${r.via}`)
      const after = await call('snapshot', { tabId })
      assert.match(after.text, /주소 골랐어요: 서울 성동구/)
    },
  )

  await step(
    'Read and click text in an empty-address (about:blank) frame and a button in a srcdoc frame',
    async () => {
      await call('navigate', { tabId, url: `${base}/blank-frames` })
      const s = await call('snapshot', { tabId })
      writeFileSync(join(out, 'e2e-blank-frames.txt'), s.text)
      assert.match(s.text, /결제 금액 12,300원/, s.text.slice(-800))
      assert.match(s.text, /about:blank · outer: main · visible · text only/, s.text.slice(-800))
      const card = s.text.match(/\[(e\d+) 버튼 "카드 선택"\]/)?.[1]
      assert.ok(card, `The srcdoc frame button is missing:\n${s.text.slice(-800)}`)
      const r = await call('click', { tabId, ref: card })
      assert.equal(r.delivered, true, JSON.stringify(r))
      assert.match((await call('snapshot', { tabId })).text, /카드 골랐어요/)
    },
  )

  await step(
    'Blog editor (drawn title and body inside frames, hidden input frame): enter a title and several paragraphs (measured 11-21 Naver Blog)',
    async () => {
      const tools = new BrowserTools(daemon.browser)
      const text = (r) => r.content.map((c) => c.text ?? '').join('\n')
      await call('navigate', { tabId, url: `${base}/se-write` })
      let page = ''
      for (let i = 0; i < 10; i++) {
        page = text(await tools.run('read', { tabId }))
        if (/입력칸 "제목"/.test(page)) break
        await new Promise((r) => setTimeout(r, 300))
      }
      writeFileSync(join(out, 'e2e-se-editor.txt'), page)
      // The drawn empty-slot placeholder text is read as a place to type (it used to be plain text, so the AI did not know where to type)
      const title = page.match(/\[(e\d+) 입력칸 "제목"\]/)?.[1]
      const body = page.match(/\[(e\d+) 입력칸 "글감과 함께 나의 일상을 기록해보세요!"\]/)?.[1]
      assert.ok(title && body, page.slice(-900))
      // A placeholder laid over beside a real field does not make one more field
      assert.match(page, /입력칸 "글감 검색"/)
      assert.doesNotMatch(page, /입력칸 "글감 찾기"/)
      const form = async () => {
        const s = await call('snapshot', { tabId })
        return s.text
      }
      // Title: click the spot with the real mouse so the editor gives focus to the hidden field, then type
      const t = text(await tools.run('type', { tabId, ref: title, text: '제주 바다 여행' }))
      assert.match(t, /the typed text shows on screen/, t.slice(0, 300))
      // Body: newlines become new paragraphs (Enter), empty lines stay as they are
      const b = text(
        await tools.run('steps', {
          tabId,
          steps: [{ do: 'type', ref: body, text: '첫째 날 바다를 봤어요.\n\n둘째 날은 오름에 올랐어요.' }],
        }),
      )
      assert.match(b, /the typed text shows on screen/, b.slice(0, 300))
      const after = await form()
      writeFileSync(join(out, 'e2e-se-editor-after.txt'), after)
      assert.match(after, /제주 바다 여행/)
      assert.match(after, /첫째 날 바다를 봤어요\.\s*\n\s*둘째 날은 오름에 올랐어요\./, after.slice(-600))
      assert.doesNotMatch(after, /제주 바다 여행.*첫째 날/, 'The title and body got mixed')
      // Continue writing: click the body paragraph that has text by its on-screen text (frames are searched too) and append at its end
      const more = text(await tools.run('click', { tabId, text: '둘째 날은 오름에 올랐어요.' }))
      assert.doesNotMatch(more, /Could not find the text/)
    },
  )

  await step(
    'A late new window stays in the tab list, and the blocked one of two windows at once is reported',
    async () => {
      const tools = new BrowserTools(daemon.browser)
      const text = (r) => r.content.map((c) => c.text ?? '').join('\n')
      await call('navigate', { tabId, url: `${base}/pops` })
      const s = await call('snapshot', { tabId })
      const late = s.text.match(/\[(e\d+) 버튼 "늦게 새 창"\]/)?.[1]
      const r = await call('click', { tabId, ref: late })
      assert.equal(
        r.newTabId,
        undefined,
        'The window that opens after 2 seconds is already in the click result',
      )
      // Wait: returns right away when a new tab appears
      const w = await call('wait', { tabId, ms: 6000 })
      assert.equal(w.changed, true, JSON.stringify(w))
      assert.ok(
        w.what.some((x) => /new tab \d+/.test(x)),
        JSON.stringify(w.what),
      )
      const list = await call('tabs', {})
      const child = list.tabs.find((t) => t.opener === tabId && /\/popup\?late/.test(t.url))
      assert.ok(child, `The late window is not in the list: ${JSON.stringify(list.tabs)}`)
      // The popup command also reports that window (only once)
      assert.equal((await call('popup', { tabId })).newTabId, child.tabId)
      assert.equal((await call('popup', { tabId })).newTabId, undefined)
      await call('close', { tabId: child.tabId })
      // Two windows at once: Chrome blocks the second
      const two = s.text.match(/\[(e\d+) 버튼 "두 창"\]/)?.[1]
      const r2 = await call('click', { tabId, ref: two })
      assert.ok(r2.newTabId, JSON.stringify(r2))
      await new Promise((res) => setTimeout(res, 1800))
      const t = text(await tools.run('tabs', {}))
      console.log(`  ${t.split('\n').join('\n  ')}`)
      assert.match(t, /Chrome blocked[\s\S]*\/popup\?two/)
      assert.doesNotMatch(t, /Chrome blocked[\s\S]*\/popup\?one/)
      assert.match(t, new RegExp(`window opened by tab ${tabId}`))
      await call('close', { tabId: r2.newTabId })
    },
  )

  await step('Wait: a screen that changes late returns as it changes and reports what changed', async () => {
    const tools = new BrowserTools(daemon.browser)
    const text = (r) => r.content.map((c) => c.text ?? '').join('\n')
    await call('navigate', { tabId, url: `${base}/later` })
    const s = await call('snapshot', { tabId })
    await call('click', { tabId, ref: s.text.match(/\[(e\d+) 버튼 "결제 확인"\]/)?.[1] })
    const t = Date.now()
    const w = text(await tools.run('wait', { tabId, ms: 8000 }))
    const took = Date.now() - t
    assert.match(w, /What changed/, w)
    assert.match(w, /주문번호 A-123/, w)
    assert.ok(took < 6000, `Kept waiting to the end after the change (${took}ms)`)
    const still = await call('wait', { tabId, ms: 700 })
    assert.equal(still.changed, false, JSON.stringify(still))
  })

  await step(
    'Element pictures: scroll to a button below the screen, briefly stretch for a fixed button cut off below the screen, and report the status of each mark',
    async () => {
      await call('navigate', { tabId, url: `${base}/keypad` })
      const s = await call('snapshot', { tabId })
      const keys = ['1', '2', '3'].map((n) => s.text.match(new RegExp(`\\[(e\\d+) 버튼 "${n}"\\]`))?.[1])
      const fixed = s.text.match(/\[(e\d+) 버튼 "9"\]/)?.[1]
      assert.ok(keys.every(Boolean) && fixed, s.text)
      const r = await call('element-shots', { tabId, refs: [...keys, fixed, 'e9999'] })
      console.log(`  ${JSON.stringify(r.status)}`)
      assert.deepEqual(
        r.status.map((x) => x.status),
        ['ok', 'ok', 'ok', 'ok', 'missing'],
      )
      assert.equal(r.shots.length, 4)
      for (const sh of r.shots) assert.ok(sh.data.length > 500, `${sh.ref} picture is empty`)
      writeFileSync(join(out, 'e2e-key-9.jpg'), Buffer.from(r.shots[3].data, 'base64'))
      // Also click the fixed button cut off below the screen (only then is the viewport stretched and restored)
      const c = await call('click', { tabId, ref: fixed })
      assert.equal(c.title, '고정 9', JSON.stringify(c))
      const k = await call('click', { tabId, ref: keys[1] })
      assert.equal(k.title, '누름 2')
    },
  )

  await step('Scroll: report how far it scrolled and whether it reached the end', async () => {
    await call('navigate', { tabId, url: `${base}/long` })
    const r = await call('scroll', { tabId, direction: 'down' })
    assert.ok(r.scroll && r.scroll.after > r.scroll.before, JSON.stringify(r.scroll))
    assert.equal(r.scroll.atEnd, false)
  })

  await step(
    'PC file upload: a button that opens a hidden field, a visible file field, a field created on click (intercepting the chooser), and insertion in chunks',
    async () => {
      const up = join(tmp, 'up')
      for (const d of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies'])
        mkdirSync(join(up, d), { recursive: true })
      const jpg = join(up, 'Pictures', '제주 바다.jpg')
      const pdf = join(up, 'Documents', '진단서.pdf')
      writeFileSync(jpg, 'JPG바다')
      writeFileSync(pdf, 'PDF서류')
      await call('navigate', { tabId, url: `${base}/upload` })
      const s = await call('snapshot', { tabId })
      const r = (re) => {
        const m = s.text.match(re)
        assert.ok(m, `${re} is missing:\n${s.text}`)
        return m[1]
      }
      const add = r(/\[(e\d+) 버튼 "사진 추가"\]/)
      const rcpt = r(/\[(e\d+) 입력칸 "영수증" 파일 칸\]/)
      const doc = r(/\[(e\d+) 버튼 "서류 첨부"\]/)
      const title = async () => (await call('tabs', { tabId })).tabs?.find((t) => t.tabId === tabId)?.title
      const waitTitle = async (re) => {
        for (let i = 0; i < 30; i++) {
          const t = await title()
          if (re.test(t ?? '')) return t
          await new Promise((res) => setTimeout(res, 100))
        }
        return title()
      }
      // (1) The path as is (if file access is off for the extension, Chrome blocks it and says it will receive chunks)
      const a = await call('upload', { tabId, ref: add, paths: [jpg] })
      console.log(
        `  사진 추가: ${JSON.stringify({ how: a.how, found: a.found, needBytes: a.needBytes, why: a.why })}`,
      )
      const send = async (res, path, name, type) => {
        if (!res.needBytes) return res
        await call('upload', { tabId, token: res.token, part: readFileSync(path).toString('base64') })
        return call('upload', {
          tabId,
          token: res.token,
          finish: [{ name, type, lastModified: 0, parts: 1 }],
        })
      }
      const a2 = await send(a, jpg, '제주 바다.jpg', 'image/jpeg')
      assert.deepEqual(a2.names, ['제주 바다.jpg'])
      assert.match(await waitTitle(/^사진 /), /^사진 제주 바다\.jpg:\d+:JPG바다:image\/jpeg input\+change$/)
      // (3) Receive in chunks inside the page (a visible file field)
      const b = await call('upload', { tabId, ref: rcpt, paths: [pdf], viaPage: true })
      assert.equal(b.needBytes, true)
      assert.equal(b.found, 'self')
      const b2 = await send(b, pdf, '진단서.pdf', 'application/pdf')
      assert.equal(b2.how, 'page')
      assert.match(await waitTitle(/^영수증 /), /^영수증 진단서\.pdf:\d+:PDF서류:application\/pdf$/)
      // (2) A button that creates the field on click: intercept the chooser and insert (no window opens on the PC), also by chunks
      const c = await call('upload', { tabId, ref: doc, paths: [pdf] })
      assert.equal(c.found, 'chooser')
      await send(c, pdf, '진단서.pdf', 'application/pdf')
      assert.match(await waitTitle(/^서류 /), /^서류 진단서\.pdf:\d+:PDF서류/)
      const c2 = await call('upload', { tabId, ref: doc, paths: [jpg], viaPage: true })
      assert.equal(c2.found, 'chooser')
      assert.equal(c2.needBytes, true)
      await send(c2, jpg, '제주 바다.jpg', 'image/jpeg')
      assert.match(await waitTitle(/^서류 제주/), /^서류 제주 바다\.jpg:\d+:JPG바다:image\/jpeg$/)
      // Daemon tool: approval card -> once approved, Dool2 inserts it
      const files = new FileTools(
        Object.fromEntries(
          ['desktop', 'documents', 'downloads', 'pictures', 'movies'].map((k, i) => [
            k,
            [join(up, ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies'][i])],
          ]),
        ),
        up,
      )
      const tools = new BrowserTools(daemon.browser)
      tools.uploadFiles = (p) => files.uploadable(p)
      await call('navigate', { tabId, url: `${base}/upload` })
      await tools.run('read', { tabId })
      const asked = await tools.run('upload', { tabId, ref: add, paths: ['~/Pictures/제주 바다.jpg'] })
      assert.match(asked.content[0].text, /Asked for approval/)
      const [rec] = tools.approvals.list()
      assert.equal(rec.kind, 'contact')
      const done = await tools.approve(rec.id)
      console.log(`  After approval: ${done.message}`)
      assert.equal(done.ok, true)
      assert.match(await waitTitle(/^사진 /), /^사진 제주 바다\.jpg:\d+:JPG바다/)
    },
  )

  await step('A walk of clicks is remembered and walked again without the AI', async () => {
    const tools = new BrowserTools(daemon.browser)
    tools.routes = new RouteBook(join(tmp, 'routes.json'))
    const first = await tools.run('open', { url: `${base}/r/home` })
    const tab = Number(/\[(?:tab|탭) (\d+)\]/.exec(first.content[0].text)?.[1])
    assert.ok(tab > 0, 'No tab number in the page read')
    await tools.run('click', { tabId: tab, text: '마이페이지' })
    const orders = await tools.run('click', { tabId: tab, text: '주문목록' })
    assert.match(orders.content.map((c) => c.text).join('\n'), /귤 5kg 배송 중/)
    await tools.run('navigate', { tabId: tab, url: `${base}/r/home` })
    const again = await tools.run('navigate', { tabId: tab, url: `${base}/r/home` })
    assert.match(again.content.map((c) => c.text).join('\n'), /\[r1\] 주문목록: '마이페이지' → '주문목록'/)
    const t = Date.now()
    const walked = await tools.run('route', { tabId: tab, route: 'r1' })
    const text = walked.content.map((c) => c.text).join('\n')
    assert.match(text, /Took the remembered route \[r1\]/)
    assert.match(text, /귤 5kg 배송 중/)
    console.log(`  walked 2 clicks in ${Date.now() - t}ms`)
    await call('close', { tabId: tab })
  })

  await step('A slow ad does not hold back opening, reading or moving to the next page', async () => {
    let t = Date.now()
    const r = await call('open', { url: `${base}/slow-ad` })
    const opened = Date.now() - t
    assert.equal(r.title, '광고 많은 가게')
    assert.ok(opened < 6_000, `Opening waited ${opened}ms for the ad (load event is 15 s away)`)
    t = Date.now()
    const snap = await call('snapshot', { tabId: r.tabId })
    assert.match(snap.text, /귤 5kg 12,900원/)
    assert.ok(Date.now() - t < 4_000, `Reading waited ${Date.now() - t}ms`)
    // Moving on still waits for the new page, not the old one that is already quiet
    t = Date.now()
    const next = await call('navigate', { tabId: r.tabId, url: `${base}/popup` })
    assert.equal(next.title, '새 창')
    console.log(`  open ${opened}ms, move ${Date.now() - t}ms`)
    await call('close', { tabId: r.tabId })
  })

  await step('Close the tab', async () => {
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
      console.log(`  > ${text}\n${tools.map((t) => `    tool: ${t}`).join('\n')}\n  Dool2: ${answer}`)
      return { tools, answer }
    }
    await step(`AI(${agent}) finds the apple price in the shop`, async () => {
      const r = await ask(`${base} 에서 사과 1kg 가격 알려줘`)
      assert.ok(
        r.tools.some((t) => t.includes('browser_open')),
        'Did not use the browser',
      )
      assert.match(r.answer, /9,?900/)
    })
    await step(
      `AI(${agent}) asks approval for the buy button, and the daemon presses it once approved`,
      async () => {
        const r = await ask(`${base} 에서 사과 바로 구매 버튼 눌러줘`)
        assert.ok(
          r.tools.some((t) => t.includes('browser_request_approval')),
          'Did not ask for approval',
        )
        assert.ok(!r.tools.some((t) => /browser_click .*"바로 구매"/.test(t)))
        const pending = daemon.approvals.list().find((x) => x.status === 'pending')
        assert.ok(pending, 'No pending approval request')
        console.log(
          `  승인 카드: ${JSON.stringify({ what: pending.what, amount: pending.amount, label: pending.label })}`,
        )
        const res = await fetch(`${daemon.url}/api/approvals/${pending.id}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'approve' }),
        })
        const out = await res.json()
        console.log(`  Approval result: ${out.message}`)
        assert.equal(out.ok, true)
        assert.match(out.message, /구매됨/)
        writeFileSync(join(out ? join(root, 'out') : '', 'e2e-agent.txt'), JSON.stringify(r, null, 2))
      },
    )
    await step(`AI(${agent}) hands off to a person on a captcha screen`, async () => {
      const r = await ask(`${base}/captcha 에서 로그인해줘`)
      assert.ok(
        r.tools.some((t) => t.includes('browser_handoff')),
        'Did not hand off to a person',
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
console.log(failed ? 'failed' : 'all passed')
process.exit(failed ? 1 : 0)
