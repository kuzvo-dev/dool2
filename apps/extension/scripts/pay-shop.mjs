// Payment-flow test shop: like a real shop's checkout: product -> order page -> add address (frame) -> address search (frame inside a frame)
// -> payment method, coupon, quantity, request note -> [Pay] -> a late payment company window (new window or in-page frame)
// -> choose card, [Next] -> shuffled PIN keypad (cut off below the screen) -> order complete page + order number.
//
// Why: a real Gmarket order (measured 11-20) got stuck six times in this flow (the address frame painted 0.8s late and was judged "not shown",
// coordinates and numbers shifted in the frame inside the address-search frame, Enter in address search was blocked as a payment, the payment window opened late as a new window and was not found,
// [Next] inside the payment company window was blocked for approval again, the keypad was cut off below the screen, and it finished without checking the order number).
// Before touching a real account, pass the same shape through here end to end first (apps/extension/scripts/e2e-pay.mjs, live.mjs).
//
// The site is split in four (different sites, so Chrome puts the frames in different processes - the same shape as a real PG and address search):
//   shop            http://127.0.0.1:<shop>       product, order page, order complete
//   address         http://addr.localhost:<addr>   add-address form (frame inside the order page)
//   address search  http://juso.localhost:<juso>   postal code search (frame inside the address form = frame in a frame)
//   payment company http://pg.localhost:<pg>       card choice, PIN keypad (new window or in-page frame)
// (*.localhost is sent to 127.0.0.1 by Chrome and curl. Being different sites it is closer to real than using only 'localhost')
//
// Options after the address (?addr=...&pg=...) change the shape. Put them on the product page address and they carry through:
//   addr=cross(default)|same   the address form frame is another site / the shop's own address
//   pg=popup(default)|layer    the payment company window is a new window (window.open) / an in-page frame over the order page
//   late=<ms>               how long after [Pay] the payment window appears (default 1200, the prepare request time). Chrome allows
//                           popups for 5 seconds after a click, so above 5000 it hits popup blocking (before the site's popups are allowed a 'blocked' notice appears)
//   keypad=off(default)|on     keypad cut off below the screen (760px from the top, 900px window) / stuck to the bottom and fully visible
//   keys=text(default)|img     keypad digits are text / images (no name: each button must be cropped and looked at to know the digit)
//   ship=none(default)|saved   no address / a saved address already exists (a regular customer. To see only the payment step, skipping the address step)
// The payment PIN is 123456. It locks after 5 wrong tries. A wrong try reshuffles the keypad (like a real security keypad).
//
//   import { start } from './pay-shop.mjs'
//   const shop = await start()            // port 0 = a free port. start({ ports: { shop: 8791, addr: 8792, juso: 8793, pg: 8794 } })
//   shop.product                          // product page address
//   await shop.close()
//
//   Start by hand: node apps/extension/scripts/pay-shop.mjs   (8791~8794)
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

export const ORDER_NO = '2026112012345'
export const PIN = '123456'
export const PRODUCT = { name: '제주 귤 3kg (로열과)', price: 15_900 }
export const COUPON = { id: 'first', name: '첫 주문 1,000원 할인', off: 1_000 }
const MAX_TRIES = 5
/** Address search results (shape of a result line in Gmarket address search, measured 11-20: road name (village) postal code) */
export const JUSO = [
  {
    road: '경기도 용인시 수지구 테스트로 27 (테스트마을)',
    jibun: '경기도 용인시 수지구 테스트동 905',
    zip: '16845',
  },
  {
    road: '경기도 용인시 수지구 테스트로 29 (테스트마을)',
    jibun: '경기도 용인시 수지구 테스트동 907',
    zip: '16845',
  },
  { road: '서울특별시 성동구 테스트길 3 (성수동)', jibun: '서울특별시 성동구 성수동1가 13', zip: '04790' },
]

/** Saved address (ship=saved) */
export const SAVED_ADDR = {
  name: '김두리',
  tel: '010-1234-5678',
  zip: '16845',
  road: '경기도 용인시 수지구 테스트로 27 (테스트마을)',
  detail: '101동 1001호',
}

const won = (n) => `${n.toLocaleString('ko-KR')}원`
const esc = (s) =>
  String(s ?? '').replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c],
  )

/** Options after the address -> shape */
function flagsOf(u) {
  const q = u.searchParams
  const late = Math.min(Math.max(Number(q.get('late')) || 1200, 0), 20_000)
  return {
    addr: q.get('addr') === 'same' ? 'same' : 'cross',
    pg: q.get('pg') === 'layer' ? 'layer' : 'popup',
    late,
    keypad: q.get('keypad') === 'on' ? 'on' : 'off',
    keys: q.get('keys') === 'img' ? 'img' : 'text',
    ship: q.get('ship') === 'saved' ? 'saved' : 'none',
  }
}
const qsOf = (f) => new URLSearchParams({ ...f, late: String(f.late) }).toString()

const shuffle = () => {
  const d = [...'0123456789']
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[d[i], d[j]] = [d[j], d[i]]
  }
  return d
}

const page = (
  title,
  body,
  { css = '', script = '' } = {},
) => `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style>body{font:15px/1.5 sans-serif;margin:0;padding:20px;color:#222}h1{font-size:22px}h2{font-size:18px;margin:18px 0 8px}
button{font:inherit;padding:6px 14px;cursor:pointer}input,select{font:inherit;padding:5px}label{display:inline-block;margin:4px 8px 4px 0}
.box{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:10px 0}.err{color:#d33}.muted{color:#888}${css}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`

/** Shop pages */
function productPage(f) {
  return page(
    `${PRODUCT.name} - 두리 결제 가게`,
    `<header class="muted">두리 결제 가게 › 과일 › 귤</header>
<h1>${esc(PRODUCT.name)}</h1>
<p><b>${won(PRODUCT.price)}</b> · 무료배송 · 오늘 출발 (오후 2시 전 주문)</p>
<p>판매자 두리농장 · 평점 4.8 (1,204) · 배송 전 취소 가능</p>
<label>옵션 <select id="opt"><option>3kg (로열과) +0원</option></select></label>
<p><button id="cart">장바구니</button> <button id="buy">구매하기</button></p><p id="msg" role="status"></p>`,
    {
      // [Buy] does not pay, it only moves to the order page (measured 11-20 Gmarket)
      script: `cart.onclick = () => { msg.textContent = '장바구니에 담았어요' }
buy.onclick = () => { msg.textContent = '주문서로 이동 중…'; setTimeout(() => { location.href = '/checkout/order?${qsOf(f)}' }, 300) }`,
    },
  )
}

function checkoutPage(f, origins) {
  const cfg = {
    qs: qsOf(f),
    pg: f.pg,
    late: f.late,
    price: PRODUCT.price,
    coupon: COUPON,
    addrUrl: `${f.addr === 'same' ? origins.shop : origins.addr}/addr/form?${qsOf(f)}`,
    trusted: [origins.shop, origins.addr, origins.pg],
    saved: f.ship === 'saved' ? SAVED_ADDR : null,
  }
  return page(
    '주문/결제 - 두리 결제 가게',
    `<h1>주문/결제</h1>
<section class="box"><h2>주문 상품</h2><p>${esc(PRODUCT.name)} · <b id="line">${won(PRODUCT.price)}</b></p>
<div class="stepper">수량 <button id="minus" aria-label="수량 줄이기" disabled>−</button> <span id="qty">1</span> <button id="plus" aria-label="수량 늘리기">+</button></div></section>
<section class="box"><h2>배송지</h2><div id="ship"><p id="noaddr">등록된 배송지가 없어요. 배송지를 추가해 주세요.</p>
<button id="addaddr">배송지 추가</button></div>
<label>배송 요청사항 <select id="memo"><option>요청사항을 선택해 주세요</option><option>문 앞에 놓아 주세요</option><option>경비실에 맡겨 주세요</option><option>배송 전에 연락 주세요</option></select></label></section>
<section class="box"><h2>할인</h2><label>할인 쿠폰 <select id="coupon"><option value="">쿠폰 선택</option><option value="${COUPON.id}">${esc(COUPON.name)}</option></select></label>
<button id="applyc">적용</button> <span id="cmsg" role="status"></span></section>
<section class="box"><h2>결제 수단</h2>
<label><input type="radio" name="pm" value="card" checked> 신용/체크카드</label>
<label><input type="radio" name="pm" value="easy"> 간편결제 (두리페이)</label></section>
<section class="box"><h2>결제 금액</h2><p>상품 금액 <span id="sum">${won(PRODUCT.price)}</span> · 할인 <span id="off">0원</span> · 배송비 0원</p>
<p>총 결제 금액 <b id="total">${won(PRODUCT.price)}</b></p>
<p class="muted">주문 내용을 확인했으며 결제에 동의해요. 배송 전에는 주문 내역에서 바로 취소할 수 있어요.</p>
<p id="err" class="err" role="alert"></p>
<button id="pay">${won(PRODUCT.price)} 결제하기</button></section>
<div id="layer" class="layer" hidden></div>`,
    {
      css: '.layer{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}.layer[hidden]{display:none}.layer iframe{background:#fff;border:0;border-radius:10px}',
      script: `const C = ${JSON.stringify(cfg)}
let qty = 1, applied = false, addr = null, tid = null, paying = false, finished = false
const amount = () => C.price * qty - (applied ? C.coupon.off : 0)
const won = (n) => n.toLocaleString('ko-KR') + '원'
function render() {
  qty_.textContent = qty; minus.disabled = qty <= 1
  line.textContent = won(C.price * qty); sum.textContent = won(C.price * qty)
  off.textContent = applied ? '-' + won(C.coupon.off) : '0원'
  total.textContent = won(amount()); if (!paying) pay.textContent = won(amount()) + ' 결제하기'
}
const qty_ = document.getElementById('qty')
plus.onclick = () => { qty = Math.min(qty + 1, 9); render() }
minus.onclick = () => { qty = Math.max(qty - 1, 1); render() }
applyc.onclick = () => {
  if (coupon.value !== C.coupon.id) { cmsg.textContent = '적용할 쿠폰을 골라 주세요'; return }
  applied = true; cmsg.textContent = C.coupon.name + ' 적용됨'; render()
}
function closeLayer() { layer.hidden = true; layer.innerHTML = '' }
function openLayer(src, w, h) {
  layer.innerHTML = '<iframe title="' + (src.includes('/payment/') ? '결제' : '배송지 추가') + '" src="' + src + '" style="width:' + w + ';height:' + h + '"></iframe>'
  layer.hidden = false
}
// Add address: the form opens as a frame of another site, and its text is drawn 0.8s later (measured 11-20 Gmarket)
addaddr.onclick = () => openLayer(C.addrUrl, '480px', '620px')
function showAddr(a) {
  addr = a
  ship.innerHTML = '<p id="shipto"><b>' + a.name + '</b> · ' + a.tel + '<br>' + a.road + ' ' + a.detail + ' (' + a.zip + ')</p><button id="chaddr">배송지 변경</button>'
  document.getElementById('chaddr').onclick = () => openLayer(C.addrUrl, '480px', '620px')
}
function done(t) {
  if (finished || t !== tid) return
  finished = true; closeLayer()
  location.href = '/order/complete?tid=' + encodeURIComponent(t) + '&' + C.qs
}
addEventListener('message', (e) => {
  if (!C.trusted.includes(e.origin)) return
  const d = e.data || {}
  if (d.type === 'addr-saved') { showAddr(d.addr); closeLayer() }
  if (d.type === 'addr-close' || d.type === 'pg-close') closeLayer()
  if (d.type === 'pg-done') done(d.tid)
})
if (C.saved) showAddr(C.saved)
// In case the payment window cannot tell us, also ask the shop server whether payment finished (real shops do that too)
function poll() {
  if (finished || !tid) return
  fetch('/api/pay/status?tid=' + encodeURIComponent(tid)).then((r) => r.json()).then((s) => {
    if (s.status === 'paid') done(tid); else setTimeout(poll, 700)
  }, () => setTimeout(poll, 1500))
}
pay.onclick = async () => {
  err.textContent = ''
  if (!addr) { err.textContent = '배송지를 추가해 주세요'; return }
  if (paying) return
  paying = true; pay.disabled = true; pay.textContent = '결제 준비 중…'
  const method = document.querySelector('input[name=pm]:checked').value
  // The payment window opens after the prepare request finishes, not at the moment of the click (measured 11-20 Gmarket: a late new window was not found)
  const r = await fetch('/api/pay/prepare?' + C.qs, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ qty, coupon: applied ? C.coupon.id : '', method, addr, memo: memo.value }) }).then((x) => x.json())
  paying = false; pay.disabled = false; render()
  tid = r.tid
  if (C.pg === 'layer') openLayer(r.pgUrl + '&layer=1', '480px', '100%')
  else {
    const w = window.open(r.pgUrl, 'dool2pg', 'width=480,height=900')
    if (!w) { err.textContent = '결제 창이 차단되었어요. 브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 [결제하기]를 눌러 주세요.'; return }
  }
  poll()
}`,
    },
  )
}

function completePage(order, f) {
  if (order?.status !== 'paid')
    return page(
      '결제 확인 실패 - 두리 결제 가게',
      `<h1>결제가 확인되지 않았어요</h1><p>결제를 마치지 못했어요. 주문서로 돌아가 다시 결제해 주세요.</p><a href="/checkout/order?${qsOf(f)}">주문서로 돌아가기</a>`,
    )
  const a = order.addr ?? {}
  return page(
    '주문 완료 - 두리 결제 가게',
    `<h1>주문이 완료되었어요</h1>
<p>주문번호 <b id="orderno">${ORDER_NO}</b></p>
<div class="box"><p>${esc(PRODUCT.name)} · ${order.qty}개 · 결제 금액 <b>${won(order.amount)}</b> · ${esc(order.card ?? '')} ${esc(order.inst ?? '')}</p>
<p>받는 분 ${esc(a.name)} · ${esc(a.road)} ${esc(a.detail)} (${esc(a.zip)})</p><p>배송 요청사항: ${esc(order.memo)}</p></div>
<p><a href="/goods/1234?${qsOf(f)}">쇼핑 계속하기</a> · <a href="/my/orders">주문 내역 보기</a></p>`,
  )
}

/** Add-address form (frame inside the order page). Its text is drawn 0.8s late */
function addrPage(origins) {
  const cfg = { juso: `${origins.juso}/juso/search`, trusted: [origins.juso] }
  return page('배송지 추가', '<p id="loading">불러오는 중…</p><div id="root"></div>', {
    script: `const C = ${JSON.stringify(cfg)}
// Some fields share a name like window.name, so look them up by id
const $ = (id) => document.getElementById(id)
setTimeout(() => {
  $('loading').remove()
  $('root').innerHTML = '<h2>배송지 추가</h2>' +
    '<p><label>받는 분 <input id="name" autocomplete="off"></label></p>' +
    '<p><label>연락처 <input id="tel" inputmode="tel" placeholder="- 없이 숫자만"></label></p>' +
    '<p><label>우편번호 <input id="zip" readonly size="6"></label> <button id="findzip" type="button">우편번호 찾기</button></p>' +
    '<p><label>주소 <input id="road" readonly size="36" placeholder="우편번호 찾기로 넣어 주세요"></label></p>' +
    '<p><label>상세주소 <input id="detail" placeholder="동·호수 등"></label></p>' +
    '<p><label><input type="checkbox" id="def" checked> 기본 배송지로 저장</label></p>' +
    '<p id="ferr" class="err" role="alert"></p>' +
    '<p><button id="save" type="button">저장하기</button> <button id="cancel" type="button">닫기</button></p><div id="jusobox"></div>'
  // Postal code search: open another site's frame inside this frame (frame in a frame, measured 11-20 Gmarket)
  $('findzip').onclick = () => { $('jusobox').innerHTML = '<iframe title="우편번호 찾기" src="' + C.juso + '" style="width:100%;height:330px;border:1px solid #ccc"></iframe>' }
  $('cancel').onclick = () => parent.postMessage({ type: 'addr-close' }, '*')
  $('save').onclick = () => {
    const a = { name: $('name').value.trim(), tel: $('tel').value.replace(/\\D/g, ''), zip: $('zip').value, road: $('road').value, detail: $('detail').value.trim() }
    $('ferr').textContent = !a.name ? '받는 분 이름을 넣어 주세요' : !/^01\\d{8,9}$/.test(a.tel) ? '연락처를 확인해 주세요 (휴대폰 번호 10~11자리)' : !a.road ? '우편번호 찾기로 주소를 넣어 주세요' : ''
    if ($('ferr').textContent) return
    a.tel = a.tel.replace(/^(\\d{3})(\\d{3,4})(\\d{4})$/, '$1-$2-$3')
    $('save').disabled = true; $('save').textContent = '저장 중…'
    setTimeout(() => parent.postMessage({ type: 'addr-saved', addr: a }, '*'), 300)
  }
}, 800)
addEventListener('message', (e) => {
  if (!C.trusted.includes(e.origin)) return
  const d = e.data || {}
  if (d.type === 'juso-pick') { $('zip').value = d.zip; $('road').value = d.road; $('jusobox').innerHTML = ''; $('detail').focus() }
  if (d.type === 'juso-close') $('jusobox').innerHTML = ''
})`,
  })
}

/** Postal code search (frame inside the address form). Search with Enter or the magnifier; results come after 0.6s */
function jusoPage() {
  return page(
    '우편번호 찾기',
    `<h3>우편번호 찾기</h3>
<p><input id="q" size="28" placeholder="도로명, 건물명, 지번으로 검색" aria-label="주소 검색"> <button id="go" type="button" aria-label="검색">🔍</button></p>
<p id="tip" class="muted">예) 테스트로 27, 테스트마을</p><ul id="list"></ul><button id="x" type="button">닫기</button>`,
    {
      css: 'body{padding:10px}ul{list-style:none;padding:0}li{border-bottom:1px solid #eee}li button{all:unset;display:block;cursor:pointer;padding:6px 0;width:100%}li small{color:#888;display:block}',
      script: `const ROWS = ${JSON.stringify(JUSO)}
function search() {
  const words = q.value.trim().split(/\\s+/).filter(Boolean)
  list.innerHTML = ''
  if (!words.length) { tip.textContent = '검색어를 넣어 주세요'; return }
  tip.textContent = '검색 중…'
  setTimeout(() => {
    const hits = ROWS.filter((r) => words.every((w) => (r.road + ' ' + r.jibun).replace(/\\s/g, '').includes(w)))
    tip.textContent = hits.length ? '검색 결과 ' + hits.length + '건' : '검색 결과가 없어요. 도로명과 건물 번호를 확인해 주세요'
    for (const r of hits) {
      const li = document.createElement('li')
      li.innerHTML = '<button type="button"><span>' + r.road + ' ' + r.zip + '</span><small>지번 ' + r.jibun + '</small></button>'
      li.querySelector('button').onclick = () => parent.postMessage({ type: 'juso-pick', zip: r.zip, road: r.road }, '*')
      list.append(li)
    }
  }, 600)
}
q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search() } })
go.onclick = search
x.onclick = () => parent.postMessage({ type: 'juso-close' }, '*')`,
    },
  )
}

/** Payment company window: choose card -> [Next] -> shuffled 6-digit keypad */
function pgPage(f, tid, layer) {
  const cfg = { tid, layer, keys: f.keys, max: MAX_TRIES }
  return page(
    '두리PG 안전결제',
    `<header><b>두리PG</b> 안전결제 <span class="muted">· 두리 결제 가게</span></header>
<div id="s1"><h2>카드 결제</h2><p>${esc(PRODUCT.name)} · 결제 금액 <b id="amt">…</b></p>
<fieldset><legend>카드사 선택</legend>
${['신한카드', '국민카드', '현대카드', '삼성카드'].map((c) => `<label><input type="radio" name="card" value="${c}"> ${c}</label>`).join('\n')}</fieldset>
<p><label>할부 <select id="inst"><option>일시불</option><option>2개월 (무이자)</option><option>3개월 (무이자)</option></select></label></p>
<p id="perr" class="err" role="alert"></p><p><button id="next">다음</button> <button id="cancel">결제 취소</button></p></div>
<div id="s2" hidden><h2>결제 비밀번호</h2><p id="who"></p><p id="dots" aria-live="polite">○○○○○○ (0/6자리)</p>
<p id="kerr" class="err" role="alert"></p></div>
<div id="pad" class="pad ${f.keypad === 'on' ? 'on' : 'off'}" hidden></div>
<div id="s3" hidden><h2>결제가 완료되었어요</h2><p>잠시 뒤 가게 화면으로 돌아가요.</p></div>`,
    {
      // keypad=off: put the keypad 760px from the top. In a 900px window (about 800px visible) it is cut off below the screen from the second row
      // (measured 11-20 Gmarket: the payment company keypad was drawn off-screen and could not be clicked)
      css: '.pad{position:fixed;left:0;right:0;background:#f4f5f7;border-top:1px solid #ccc;display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:10px}.pad[hidden]{display:none}.pad.off{top:760px}.pad.on{bottom:0}.pad button{height:64px;font-size:24px;background:#fff;border:1px solid #ccc;border-radius:8px}.pad button img{pointer-events:none}',
      script: `const C = ${JSON.stringify(cfg)}
const svg = (d) => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><text x="20" y="31" font-size="28" font-family="sans-serif" text-anchor="middle" fill="#123">' + d + '</text></svg>')
const api = (p, body) => fetch(p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}).then((r) => r.json())
let picked = [], busy = false
api('/api/pg/order?tid=' + encodeURIComponent(C.tid)).then((o) => { amt.textContent = o.amount ? o.amount.toLocaleString('ko-KR') + '원' : '주문을 찾을 수 없어요' })
function notify(m) {
  const to = window.opener || (window.parent !== window ? window.parent : null)
  try { to && to.postMessage(m, '*') } catch {}
}
cancel.onclick = () => { notify({ type: 'pg-close' }); if (!C.layer) window.close() }
next.onclick = async () => {
  const card = document.querySelector('input[name=card]:checked')
  if (!card) { perr.textContent = '카드사를 골라 주세요'; return }
  next.disabled = true
  await api('/api/pg/card', { tid: C.tid, card: card.value, inst: inst.value })
  setTimeout(() => { s1.hidden = true; s2.hidden = false; who.textContent = card.value + ' 결제 비밀번호 6자리를 눌러 주세요'; keypad() }, 400)
}
function dotsText() { dots.textContent = '●'.repeat(picked.length) + '○'.repeat(6 - picked.length) + ' (' + picked.length + '/6자리)' }
// Keypad: the server shuffles the digit positions. Only the pressed 'position' is sent and the server turns it into a digit (like a real security keypad)
async function keypad() {
  const { layout } = await api('/api/pg/layout?tid=' + encodeURIComponent(C.tid))
  picked = []; dotsText()
  const keys = layout.map((d, i) => '<button type="button" class="k" data-i="' + i + '">' + (C.keys === 'img' ? '<img alt="" width="40" height="40" src="' + svg(d) + '">' : d) + '</button>')
  // Last row: reshuffle, digit, delete
  pad.innerHTML = keys.slice(0, 9).join('') + '<button type="button" id="mix">재배열</button>' + keys[9] + '<button type="button" id="del">지우기</button>'
  pad.hidden = false
  for (const b of pad.querySelectorAll('.k')) b.onclick = () => press(Number(b.dataset.i))
  document.getElementById('del').onclick = () => { picked.pop(); dotsText() }
  document.getElementById('mix').onclick = () => keypad()
}
async function press(i) {
  if (busy || picked.length >= 6) return
  picked.push(i); dotsText()
  if (picked.length < 6) return
  busy = true
  const r = await api('/api/pg/auth', { tid: C.tid, idx: picked })
  busy = false
  if (r.ok) {
    s2.hidden = true; pad.hidden = true; s3.hidden = false
    notify({ type: 'pg-done', tid: C.tid })
    if (!C.layer) setTimeout(() => window.close(), 600)
    return
  }
  if (r.locked) { kerr.textContent = '비밀번호를 ' + C.max + '번 틀려 이 결제가 잠겼어요. 처음부터 다시 결제해 주세요.'; pad.hidden = true; return }
  kerr.textContent = '비밀번호가 틀렸어요 (' + r.tries + '/' + C.max + ') — ' + C.max + '번 틀리면 결제가 잠겨요'
  keypad()
}`,
    },
  )
}

const readBody = (req) =>
  new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > 50_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'))
      } catch {
        resolve({})
      }
    })
  })

/**
 * Start the shop. The same handler is attached to four ports, and pages call each other at fixed site addresses
 * @param {{ host?: string, ports?: { shop?: number, addr?: number, juso?: number, pg?: number } }} [o]
 */
export async function start({ host = '127.0.0.1', ports = {} } = {}) {
  /** Payment records (exported so a test can check things like whether it was paid twice) */
  const state = { orders: new Map(), prepares: 0, paid: 0, seq: 0 }
  const origins = {}
  const hostOf = { shop: host, addr: 'addr.localhost', juso: 'juso.localhost', pg: 'pg.localhost' }
  const send = (res, code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }
  const html = (res, body) => send(res, 200, 'text/html; charset=utf-8', body)
  const json = (res, body, code = 200) => send(res, code, 'application/json', JSON.stringify(body))

  const handle = async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const f = flagsOf(u)
    const p = u.pathname
    const order = state.orders.get(u.searchParams.get('tid') ?? '')
    if (p === '/' || p === '/pay') {
      res.writeHead(302, { location: `/goods/1234?${qsOf(f)}` })
      return res.end()
    }
    if (p === '/goods/1234') return html(res, productPage(f))
    if (p === '/checkout/order') return html(res, checkoutPage(f, origins))
    if (p === '/order/complete') return html(res, completePage(order, f))
    if (p === '/my/orders')
      return html(
        res,
        page(
          '주문 내역',
          `<h1>주문 내역</h1>${[...state.orders.values()]
            .filter((o) => o.status === 'paid')
            .map((o) => `<p>주문번호 ${ORDER_NO} · ${esc(PRODUCT.name)} · ${won(o.amount)}</p>`)
            .join('')}`,
        ),
      )
    if (p === '/addr/form') return html(res, addrPage(origins))
    if (p === '/juso/search') return html(res, jusoPage())
    if (p === '/payment/card')
      return html(res, pgPage(f, u.searchParams.get('tid') ?? '', u.searchParams.has('layer')))
    if (p === '/api/pay/prepare' && req.method === 'POST') {
      const b = await readBody(req)
      const qty = Math.min(Math.max(Math.floor(Number(b.qty)) || 1, 1), 9)
      const off = b.coupon === COUPON.id ? COUPON.off : 0
      state.prepares++
      const tid = `T${Date.now().toString(36)}${++state.seq}`
      state.orders.set(tid, {
        tid,
        qty,
        amount: PRODUCT.price * qty - off,
        method: b.method === 'easy' ? '간편결제' : '카드',
        addr: b.addr && typeof b.addr === 'object' ? b.addr : undefined,
        memo: String(b.memo ?? '').slice(0, 60),
        status: 'ready',
        tries: 0,
        layout: shuffle(),
      })
      // The prepare request finishes late: the payment window appears after it (late, default 1.2s)
      await new Promise((r) => setTimeout(r, f.late))
      return json(res, {
        tid,
        pgUrl: `${origins.pg}/payment/card?tid=${tid}&${qsOf(f)}`,
        amount: state.orders.get(tid).amount,
      })
    }
    if (p === '/api/pay/status') return json(res, { status: order?.status ?? 'none' })
    if (p === '/api/pg/order')
      return order ? json(res, { amount: order.amount, method: order.method }) : json(res, {}, 404)
    if (p === '/api/pg/card' && req.method === 'POST') {
      const b = await readBody(req)
      const o = state.orders.get(String(b.tid))
      if (!o) return json(res, { ok: false }, 404)
      o.card = String(b.card ?? '').slice(0, 20)
      o.inst = String(b.inst ?? '').slice(0, 20)
      return json(res, { ok: true })
    }
    // Keypad positions: reshuffled every time it is called (first time, reshuffle, after a wrong try)
    if (p === '/api/pg/layout') {
      if (!order) return json(res, { layout: [] }, 404)
      order.layout = shuffle()
      return json(res, { layout: order.layout })
    }
    // Answer sheet for tests only: the current keypad positions (stands in for 'what the AI read from the images' on an image keypad). Not in a real PG
    if (p === '/api/pg/keymap') return order ? json(res, { layout: order.layout }) : json(res, {}, 404)
    if (p === '/api/pg/auth' && req.method === 'POST') {
      const b = await readBody(req)
      const o = state.orders.get(String(b.tid))
      if (!o) return json(res, { ok: false }, 404)
      if (o.status === 'paid') return json(res, { ok: true })
      if (o.tries >= MAX_TRIES) return json(res, { ok: false, locked: true, tries: o.tries })
      const pin = (Array.isArray(b.idx) ? b.idx : []).map((i) => o.layout[Number(i)] ?? '?').join('')
      if (pin === PIN) {
        o.status = 'paid'
        state.paid++
        return json(res, { ok: true })
      }
      o.tries++
      return json(res, { ok: false, tries: o.tries, locked: o.tries >= MAX_TRIES })
    }
    send(res, 404, 'text/plain; charset=utf-8', 'not found')
  }

  const servers = []
  try {
    for (const name of ['shop', 'addr', 'juso', 'pg']) {
      const s = createServer((req, res) => {
        handle(req, res).catch((e) => send(res, 500, 'text/plain; charset=utf-8', String(e)))
      })
      await new Promise((resolve, reject) => {
        s.once('error', reject)
        s.listen(ports[name] ?? 0, host, resolve)
      })
      servers.push(s)
      origins[name] = `http://${hostOf[name]}:${s.address().port}`
    }
  } catch (e) {
    for (const s of servers) s.close()
    throw e
  }
  return {
    url: origins.shop,
    product: `${origins.shop}/goods/1234`,
    origins,
    state,
    close: () =>
      Promise.all(
        servers.map(
          (s) =>
            new Promise((r) => {
              s.closeAllConnections?.()
              s.close(() => r())
            }),
        ),
      ),
  }
}

// Start by hand
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const shop = await start({ ports: { shop: 8791, addr: 8792, juso: 8793, pg: 8794 } })
  console.log(`Payment shop: ${shop.product}`)
  console.log(`  change the shape: ${shop.product}?pg=layer&addr=same&keypad=on&keys=img&late=6000`)
}
