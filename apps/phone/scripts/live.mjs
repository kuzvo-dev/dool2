// 폰 앱 끝-끝 확인용 판: 중계 서버(폰 앱 포함) + 두리 본체(진짜 AI) + 시험용 Chrome(두리 확장) + 시험 가게.
// 띄워 두고 폰 대신 브라우저로 /app/을 열어 시험한다. 사용자 Chrome·프로필은 건드리지 않는다.
//
//   pnpm build
//   DOOL2_TEST_CHROME=... node apps/phone/scripts/live.mjs     → /tmp/dool2-live.json 에 주소·토큰
//   DOOL2_LIVE_DIR=<폴더> 를 주면 그 폴더를 계속 쓴다 (다시 켜도 폰 연결이 남는다)
//   결제 흐름 가게: http://127.0.0.1:8791/goods/1234 (가게 8790의 /pay 로도 간다. 배송지·주소 찾기·결제 회사는 8792~8794)
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon } from '@dool2/daemon'
import { startRelay } from '@dool2/relay'
// 결제 흐름 시험 가게 (주문서·배송지 액자·주소 찾기·늦은 결제 창·키패드·주문번호, 실측 11-20 G마켓 모양)
import { start as startPayShop } from '../../extension/scripts/pay-shop.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const chromeBin = process.env.DOOL2_TEST_CHROME
// DOOL2_LIVE_DIR를 주면 그 폴더를 다시 쓴다 (본체를 다시 켜도 폰 연결·대화가 남는다)
const keep = process.env.DOOL2_LIVE_DIR
const tmp = keep ?? mkdtempSync(join(tmpdir(), 'dool2-live-'))

const shop = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  // 로그인 페이지: 두리 금고에 없는 사이트라 사람에게 넘긴다 (원격 화면 시험용)
  // 낯선 가게 (DOOL2_SHOP_ODD=1, 자동 로그인이 화면을 못 알아보는 경우 시험): '로그인'이라는 말이 없고 칸 이름도 다르다.
  // 정해 둔 순서로는 못 들어가서 두리(AI)가 대화에서 화면을 읽고 이어받아야 한다
  if (req.url?.startsWith('/odd/enter')) {
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>단골 창구</title>
<h1>단골 창구</h1><form onsubmit="event.preventDefault();document.body.innerHTML='<h1>어서 오세요</h1><p>'+this.no.value+'님 반가워요</p><a href=/odd>로그아웃</a>'">
<p><input name="no" placeholder="단골 번호" style="font-size:20px;padding:8px"></p>
<p><input name="pw" type="password" placeholder="암호" style="font-size:20px;padding:8px"></p>
<p><button style="font-size:20px;padding:8px 20px">들어가기</button></p></form>`)
    return
  }
  if (req.url?.startsWith('/odd') || (process.env.DOOL2_SHOP_ODD === '1' && req.url === '/')) {
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>두리 낯선 가게</title>
<h1>두리 낯선 가게</h1><p>단골만 주문 내역을 볼 수 있어요.</p>
<p><button onclick="location.href='/odd/enter'" style="font-size:18px;padding:8px 16px">단골 창구 열기</button></p>`)
    return
  }
  if (req.url?.startsWith('/login')) {
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>두리 시험 가게 로그인</title>
<h1>로그인</h1><form onsubmit="event.preventDefault();document.body.innerHTML='<h1>로그인했어요</h1><p>'+this.id.value+'님 반가워요</p><a href=/>로그아웃</a>'">
<p><input name="id" placeholder="아이디" style="font-size:20px;padding:8px"></p>
<p><input name="pw" type="password" placeholder="비밀번호" style="font-size:20px;padding:8px"></p>
<p><button style="font-size:20px;padding:8px 20px">로그인</button></p></form>`)
    return
  }
  // 본인인증 흉내 (원격 화면 '필요한 칸만' 시험): 이름·생년월일 6+1·통신사 버튼·번호·약관 → 인증번호 → 끝
  if (req.url?.startsWith('/verify/code')) {
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>인증번호 입력</title>
<style>body{font:16px sans-serif;padding:16px}input{font-size:18px;padding:8px}</style>
<h2>인증번호를 입력해 주세요</h2><p>문자로 보낸 6자리 번호예요. 남은 시간 2:59</p>
<form action="/verified"><input type="hidden" name="from" value="${encodeURIComponent(req.url ?? '')}"><label for="code">인증번호</label><br><input id="code" name="code" maxlength="6" inputmode="numeric" placeholder="인증번호 6자리"><br><br>
<button type="submit">확인</button> <button type="button">다시 받기</button></form>`)
    return
  }
  if (req.url?.startsWith('/verified')) {
    // 받은 값을 보여 준다 (폰에서 넣은 값이 진짜 칸에 들어갔는지 시험)
    const q = new URL(req.url ?? '/', 'http://x').searchParams
    const first = new URL(decodeURIComponent(q.get('from') ?? '/'), 'http://x').searchParams
    const show = [...first.entries(), ['code', q.get('code') ?? '']]
      .map(([k, v]) => `<li>${k}: ${String(v).replace(/[<>&]/g, '')}</li>`)
      .join('')
    res.end(
      `<!doctype html><meta name="viewport" content="width=device-width"><title>본인인증 완료</title><h1>본인인증이 끝났어요</h1><p>카드 신청을 이어서 진행해요.</p><ul>${show}</ul>`,
    )
    return
  }
  if (req.url?.startsWith('/verify')) {
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>휴대폰 본인인증</title>
<style>body{font:15px sans-serif;padding:16px}input{font-size:16px;padding:8px;margin:4px 0}.tel button{padding:8px 12px;margin:2px}.tel button.on{background:#1a4fd6;color:#fff}.agree input{position:absolute;opacity:0;width:1px;height:1px}.agree label{display:inline-block;padding:6px 0}</style>
<h2>휴대폰 본인인증</h2>
<form action="/verify/code">
<table><tr><th>이름</th><td><input name="name" placeholder="이름"></td></tr>
<tr><th>생년월일</th><td><input name="birth" maxlength="6" inputmode="numeric" placeholder="앞 6자리"> - <input name="sex" maxlength="1" inputmode="numeric" style="width:30px">●●●●●●</td></tr></table>
<div class="tel"><strong>통신사</strong><br><button type="button" class="on">SKT</button><button type="button">KT</button><button type="button">LG U+</button><button type="button">알뜰폰</button></div>
<p><input name="phone" type="tel" placeholder="휴대폰 번호 (- 없이)"></p>
<div class="agree"><input type="checkbox" id="a1"><label for="a1">개인정보 수집·이용 동의 (필수)</label><br><input type="checkbox" id="a2"><label for="a2">본인확인 서비스 이용약관 동의 (필수)</label></div>
<p><button type="submit">인증번호 받기</button></p></form>
<script>document.querySelectorAll('.tel button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tel button').forEach(x=>x.classList.remove('on'));b.classList.add('on')})</script>`)
    return
  }
  // 보안문자 흉내
  if (req.url?.startsWith('/captcha')) {
    const ok = /answer=7K2Q8/i.test(req.url)
    const svg = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="#e9ecef"/><text x="20" y="42" font-family="monospace" font-size="34" font-weight="bold" fill="#3b4a63" transform="skewX(-12)">7K2Q8</text><line x1="0" y1="35" x2="200" y2="22" stroke="#53627e" stroke-width="2"/></svg>',
    )
    res.end(
      ok
        ? '<!doctype html><title>확인됐어요</title><h1>확인됐어요</h1><p>사람인 걸 확인했어요.</p>'
        : `<!doctype html><meta name="viewport" content="width=device-width"><title>보안문자 확인</title><h2>자동입력 방지</h2>
<form action="/captcha"><img alt="보안문자" src="data:image/svg+xml,${svg}"><br><input name="answer" placeholder="보안문자 입력"> <button type="submit">확인</button></form>`,
    )
    return
  }
  // 쿠팡 모양 결제 화면: 이름 없는 결제 수단 버튼(바로 뒤 글), 꾸민 펼침 목록(role=combobox, 눌러야 항목이 보임)
  if (req.url?.startsWith('/checkout2')) {
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>주문/결제</title>
<style>.combo{display:inline-block;min-width:200px;border:1px solid #999;padding:4px;cursor:pointer}.list{border:1px solid #999;margin:0;padding:0;list-style:none}.list li{padding:4px;cursor:pointer}.list li.selected{font-weight:bold}</style>
<h1>주문/결제</h1><p>제주 귤 3kg 1개</p>
<h2>결제수단</h2>
<div><button id="m1"></button>쿠페이 머니: 0원</div>
<div><button id="m2"></button>신용/체크카드</div>
<div id="cardbox"><div><div role="combobox" class="combo" id="cc"></div><span id="ccv">신한카드 / 5155****3361</span></div>
<div><div role="combobox" class="combo" id="mm"></div><span id="mmv">일시불</span></div></div>
<h3>총 결제 금액 15,900원</h3>
<button id="go">결제하기</button>
<script>
let method = '카드'
m1.onclick = () => { method = '쿠페이 머니'; cardbox.hidden = true }
m2.onclick = () => { method = '카드'; cardbox.hidden = false }
function combo(box, view, items) {
  box.addEventListener('click', () => {
    const open = box.parentElement.querySelector('ul')
    if (open) { open.remove(); return }
    const ul = document.createElement('ul'); ul.className = 'list'
    for (const t of items) { const li = document.createElement('li'); li.textContent = t; if (t === view.textContent) li.className = 'selected'
      li.addEventListener('click', () => { view.textContent = t; ul.remove() }); ul.append(li) }
    box.parentElement.append(ul)
  })
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') box.parentElement.querySelector('ul')?.remove() })
}
combo(cc, ccv, ['신한카드 / 5155****3361', '국민카드 / 9409****1234'])
combo(mm, mmv, ['일시불', '2개월 (무이자)', '3개월 (무이자)', '4개월', '5개월', '6개월', '7개월 (부분무이자)', '8개월', '9개월 (부분무이자)', '10개월', '11개월 (부분무이자)', '12개월'])
go.onclick = () => { const how = method === '카드' ? ccv.textContent + ' · ' + mmv.textContent : method; document.title = '주문 완료'; document.body.insertAdjacentHTML('beforeend', '<h2>주문이 완료됐어요</h2><p>' + how + '</p>') }
</script>`)
    return
  }
  // 결제 화면 (결제 흐름 시험): 배송지·결제 수단 라디오·총 결제 금액. 결제 수단을 바꾸면 마지막 버튼 이름도 바뀐다
  if (req.url?.startsWith('/checkout')) {
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>주문 결제</title>
<h1>주문 결제</h1><p>제주 귤 3kg 1개</p>
<h2>배송지 정보</h2><p>서울 강남구 테헤란로 123 (시험)</p>
<h2>결제 수단</h2>
<p><label><input type="radio" name="pay" value="카드" checked> 카드</label>
<label><input type="radio" name="pay" value="네이버페이"> 네이버페이</label>
<label><input type="radio" name="pay" value="카카오페이"> 카카오페이</label></p>
<p id="card">등록 카드 <select id="cardno"><option>신한카드 / 5155****3361</option><option>국민카드 / 9409****1234</option></select>
할부 <select id="months"><option>일시불</option><option>2개월(무이자)</option><option>3개월(무이자)</option></select></p>
<h3>총 결제 금액 15,900원</h3>
<button id="go">카드로 결제하기</button>
<script>for (const r of document.querySelectorAll('input[name=pay]')) r.onchange = () => { go.textContent = r.value + '로 결제하기'; card.hidden = r.value !== '카드' }
go.onclick = () => { const how = card.hidden ? go.textContent : cardno.value + ' · ' + months.value; document.title = '주문 완료'; document.body.insertAdjacentHTML('beforeend', '<h2>주문이 완료됐어요</h2><p>' + how + '</p>') }</script>`)
    return
  }
  // 회원가입 화면 (가입 흐름 시험): 이름·이메일·비밀번호·확인·필수 약관
  if (req.url?.startsWith('/signup')) {
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>회원가입</title>
<h1>회원가입</h1>
<p>가입 완료 시 3,000원 쿠폰을 드려요. 이미 가입된 회원이신가요? <a href="/login">로그인</a></p>
<form id="f">
<label>이름 <input name="name" autocomplete="name"></label>
<label>이메일 <input name="email" type="email" autocomplete="email"></label>
<label>비밀번호 (8~15자) <input name="pw" type="password" maxlength="15" autocomplete="new-password"></label>
<label>비밀번호 확인 <input name="pw2" type="password" maxlength="15" autocomplete="new-password"></label>
<label><input type="checkbox" name="t1"> (필수) 이용약관 동의</label>
<label><input type="checkbox" name="t2"> (선택) 마케팅 수신 동의</label>
<button type="submit">가입하기</button>
</form>
<script>f.onsubmit=e=>{e.preventDefault();const d=new FormData(f);if(!d.get('t1')){document.title='약관 필요';return}
if(d.get('pw')!==d.get('pw2')){document.body.insertAdjacentHTML('beforeend','<p>비밀번호가 서로 달라요</p>');return}
if(/taken/.test(d.get('email')||'')||location.search.includes('taken')){document.body.insertAdjacentHTML('beforeend','<p role="alert">이미 가입된 이메일이에요. 로그인해 주세요.</p>');return}
document.title='가입 완료';document.body.insertAdjacentHTML('beforeend','<h2>가입이 완료됐어요</h2><p>'+d.get('email')+' / 비번길이 '+(d.get('pw')||'').length+'</p>')}</script>`)
    return
  }
  // 결제 흐름 가게로 (8791~8794 따로 띄움). 뒤의 고르기(?pg=layer 등)는 그대로 넘긴다
  if (req.url?.startsWith('/pay')) {
    res.writeHead(302, { location: `${payShop.product}${req.url.slice(4)}` })
    res.end()
    return
  }
  if (req.url?.startsWith('/me')) {
    res.end(`<!doctype html><title>내 정보</title><h1>홍길동님</h1><a href="/">로그아웃</a>`)
    return
  }
  res.end(`<!doctype html><title>두리 시험 가게</title><p><a href="/login">로그인</a> · <a href="/pay">결제 흐름 가게</a></p><h1>두리 시험 가게</h1>
<p>오늘의 추천: 제주 귤 3kg <b>15,900원</b> (무료 배송, 배송 전 취소 가능)</p>
<button onclick="document.title='주문 완료';document.body.insertAdjacentHTML('beforeend','<h2>주문이 완료됐어요</h2>')">바로 구매</button>`)
})
const payShop = await startPayShop({ ports: { shop: 8791, addr: 8792, juso: 8793, pg: 8794 } })
await new Promise((r) => shop.listen(8790, '127.0.0.1', r))

const relay = await startRelay({
  port: 8787,
  appDir: join(root, 'apps', 'phone', 'dist'),
  log: (l) => console.log(`[중계] ${l}`),
})
const profile = join(tmp, 'profile')
// 폴더를 다시 쓸 때는 폰 연결 키도 파일에 남긴다 (시험 판 전용, 실제 앱은 키체인)
const secretFile = join(tmp, 'secrets.json')
const fileSecrets = {
  read: () => (existsSync(secretFile) ? JSON.parse(readFileSync(secretFile, 'utf8')) : {}),
  async get(key) {
    return this.read()[key]
  },
  async set(key, value) {
    const all = this.read()
    if (value === undefined) delete all[key]
    else all[key] = value
    writeFileSync(secretFile, JSON.stringify(all), { mode: 0o600 })
  },
}
// 연결 카드: 저장소의 카드에 시험 가게를 하나 더한다 (연결하기 끝-끝 시험)
const skillsDir = join(tmp, 'skills')
cpSync(join(root, 'skills'), skillsDir, { recursive: true })
mkdirSync(join(skillsDir, 'test-shop'), { recursive: true })
writeFileSync(
  join(skillsDir, 'test-shop', 'connect.json'),
  JSON.stringify({
    id: 'test-shop',
    name: '두리 시험 가게',
    site: '127.0.0.1:8790',
    category: 'shopping',
    how: 'browser',
    login: '아이디·비밀번호',
    summary: '연결하기를 끝까지 시험해 보는 가게예요.',
    example: { ask: '추천 상품 뭐야?', working: '가게 보는 중', reply: '오늘은 제주 귤 3kg이에요.' },
    abilities: [
      { title: '추천 상품 보기', say: '추천 상품 뭐야?', tier: '찾아보기' },
      { title: '바로 구매', say: '귤 사 줘', tier: '돈 내기' },
    ],
    signedIn: ['로그아웃'],
  }),
)
const daemon = await startDaemon({
  skillsDir,
  ...(keep ? { secrets: fileSecrets } : {}),
  dataDir: join(tmp, 'data'),
  relay: relay.url,
  pcName: process.env.DOOL2_PC_NAME ?? '시험 PC',
  // 도구 토큰을 고정하면 점검 스크립트가 도구(browser_*)를 직접 불러 화면을 띄울 수 있다
  ...(process.env.DOOL2_TOOL_TOKEN ? { toolToken: process.env.DOOL2_TOOL_TOKEN } : {}),
  nativeHost: { defaultTargets: false, extraDirs: [join(profile, 'NativeMessagingHosts')] },
})
const chrome = chromeBin
  ? spawn(
      chromeBin,
      [
        `--user-data-dir=${profile}`,
        `--load-extension=${join(root, 'apps', 'extension', 'dist')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1200,900',
        'about:blank',
      ],
      { stdio: 'ignore' },
    )
  : undefined

writeFileSync(
  '/tmp/dool2-live.json',
  JSON.stringify({
    relay: relay.url,
    daemon: daemon.url,
    token: daemon.token,
    shop: 'http://127.0.0.1:8790/',
    payShop: payShop.product,
  }),
)
console.log(`준비됐어요: 폰 앱 ${relay.url}/app/ · 본체 ${daemon.url}`)
console.log(
  `결제 흐름 가게: ${payShop.product} (예: "${payShop.product} 에서 귤 사 줘", 모양 바꾸기 ?pg=layer&keypad=on)`,
)

const stop = async () => {
  // 시험용 Chrome·열린 연결이 늦게 닫혀도 3초 안에는 끝낸다
  setTimeout(() => process.exit(0), 3000).unref()
  chrome?.kill()
  await daemon.close()
  await relay.close()
  shop.close()
  await payShop.close()
  if (!keep) rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
