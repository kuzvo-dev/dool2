// 결제 흐름 끝-끝 시험: 시험용 Chrome(Chrome for Testing)에 두리 확장을 올리고 진짜 두리 본체의 브라우저 도구(BrowserTools)로
// 결제 시험 가게(pay-shop.mjs)에서 상품 → 주문서 → 배송지 추가(액자) → 주소 찾기(액자 속 액자) → 결제 카드 승인
// → 늦게 뜨는 결제 창 → 카드·[다음] → 키패드 → 주문 완료 + 주문번호까지 간다. AI 대신 시험이 도구를 차례로 부른다.
//
// 왜: 실측 11-20 G마켓 실주문이 이 흐름에서 여섯 번 막혔다. 실계정을 건드리기 전에 여기서 끝까지 통과해야 한다
// (개편 계획 PLAN.md 원칙 5). 단계마다 따로 통과·실패와 까닭을 적고, 끝에 표로 보여 준다.
// 한 단계가 실패해도 할 수 있으면 다른 방법으로 이어 가서 뒤 단계도 본다 (어디서 막히는지 한 번에 다 보이게).
//
//   pnpm build
//   DOOL2_TEST_CHROME=".../Google Chrome for Testing" node apps/extension/scripts/e2e-pay.mjs
//   DOOL2_PAY_FLOWS=A        흐름 하나만 (A: 새 창 결제, B: 화면 안 액자 결제)
//   DOOL2_E2E_PAY=report     실패가 있어도 표만 남기고 성공으로 끝낸다 (개편 도중 비교용)
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserTools, startDaemon } from '@dool2/daemon'
import { COUPON, ORDER_NO, PIN, PRODUCT, SAVED_ADDR, start as startShop } from './pay-shop.mjs'

const chromeBin = process.env.DOOL2_TEST_CHROME
if (!chromeBin) {
  console.error('DOOL2_TEST_CHROME에 Chrome for Testing 실행 파일 경로를 넣어 주세요')
  process.exit(2)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.env.DOOL2_E2E_OUT ?? join(root, 'out')
mkdirSync(out, { recursive: true })

// 개편 뒤 도구 이름·인자 (PLAN.md A·B 갈래). 이름이 정해지면 여기만 고친다
const PLANNED = {
  /** 탭 목록: 새 창·여는 탭(opener)·차단된 팝업 (browser_tabs) */
  tabs: () => ['tabs', {}],
  /** 화면이 바뀔 때까지 기다리기 (browser_wait) */
  wait: (tabId, text) => ['wait', { tabId, for: text, timeoutMs: 6000 }],
  /** 주문 완료 화면 + 주문번호로 결제 끝 (browser_order_done) */
  orderDone: (tabId) => ['order_done', { tabId, order_no: ORDER_NO }],
  /** AI가 '돈이 나가는 마지막 버튼'이라고 선언하는 누르기 → 결제 카드 (browser_click final) */
  finalClick: { final: true },
}

const FLOWS = [
  {
    // 실측 11-20 G마켓과 같은 모양: 다른 사이트 배송지 액자, 준비 요청 1.2초 뒤 새 창 결제, 화면 아래로 잘린 키패드
    id: 'A',
    name: '새 창 결제·다른 사이트 배송지·화면 밖 키패드·틀린 비밀번호 한 번',
    flags: 'addr=cross&pg=popup&late=1200&keypad=off&keys=text',
    wrongFirst: true,
  },
  {
    id: 'B',
    name: '화면 안 액자 결제·같은 가게 배송지·그림 숫자 키패드',
    flags: 'addr=same&pg=layer&late=1200&keypad=on&keys=img',
    wrongFirst: false,
  },
  {
    // 결제 창이 5.5초 뒤에 뜬다: Chrome의 누르기 허용(5초)이 지나 사이트 팝업 허용 없이는 차단되고,
    // 승인 뒤 2.5초 한 번 보기로는 못 찾는다. 배송지는 저장된 것(ship=saved)으로 건너뛴다
    id: 'C',
    name: '아주 늦은 새 창 결제(팝업 차단 경계)·저장된 배송지',
    flags: 'addr=cross&pg=popup&late=5500&keypad=off&keys=text&ship=saved',
    wrongFirst: false,
  },
].filter((f) => !process.env.DOOL2_PAY_FLOWS || process.env.DOOL2_PAY_FLOWS.split(',').includes(f.id))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const text = (r) => (r?.content ?? []).map((c) => c.text ?? '').join('\n')
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 화면 글에서 표시(e12) 찾기. role은 '버튼'·'라디오'·'입력칸|검색칸' 같은 정규식 조각, name은 앞부분 */
const refOf = (page, role, name) =>
  page.match(new RegExp(`\\[(e\\d+) (?:${role}) "${reEsc(name)}[^"]*"`))?.[1] ??
  (() => {
    throw new Error(`${role} "${name}"을(를) 화면에서 찾지 못했어요`)
  })()
/** 액자 부분만 (## 화면 안 액자 …) */
const framesOf = (page) => page.split('\n## 화면 안 액자').slice(1).join('\n## 화면 안 액자')
const mainOf = (page) => page.split('\n## 화면 안 액자')[0] ?? ''
/** 결제 버튼 (이름 앞에 금액이 붙는다: "14,900원 결제하기") */
const payRef = (page) => {
  const r = mainOf(page).match(/\[(e\d+) 버튼 "[\d,]+원 결제하기"\]/)?.[1]
  if (!r) throw new Error('[결제하기] 버튼을 화면에서 찾지 못했어요')
  return r
}
const totalOf = (page) => mainOf(page).match(/총 결제 금액 ([\d,]+원)/)?.[1] ?? ''

// ── 가게 + 두리 본체 + 시험용 Chrome ──
const shop = await startShop()
const tmp = mkdtempSync(join(tmpdir(), 'dool2-e2e-pay-'))
const profile = join(tmp, 'profile')
const daemon = await startDaemon({
  dataDir: join(tmp, 'data'),
  runtimes: {},
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
    ...(process.env.CI ? ['--no-sandbox'] : []),
    'about:blank',
  ],
  { stdio: 'ignore' },
)
const call = (cmd, args, ms) => daemon.browser.call(cmd, args, ms)
const tools = new BrowserTools(daemon.browser)
/** 도구를 부르고, 오류면 그 글로 던진다 */
const run = async (tool, args) => {
  const r = await tools.run(tool, args)
  if (r.isError) throw new Error(text(r).replace(/\s+/g, ' ').slice(0, 300))
  return r
}
const read = async (tabId) => text(await run('read', { tabId }))

// 폰 키패드 카드 흉내: 본체(index.ts)처럼 짚어 둔 버튼을 차례로 누른다 (본체와 같은 BrowserTools.pressPin).
// 시험에서는 '사용자가 폰에 넣은 값'을 시험이 준다
let pinCard
tools.requestPin = (tabId, _label, _host, keys, length) => {
  pinCard = { tabId, keys, length }
  return 'pin-card'
}
const typeOnPhone = async (pin) => {
  if (!(await tools.pressPin(pinCard.tabId, pinCard.keys, pin)))
    throw new Error('화면 키패드를 다 누르지 못했어요')
}

// ── 단계 기록 ──
const results = []
/**
 * 한 단계. 실패해도 다음 단계로 간다. needs가 거짓이면(앞 단계에서 꼭 필요한 것을 못 얻음) 건너뜀으로 적는다.
 * fn이 { note }를 돌려주면 까닭 칸에 적는다 (통과했지만 예전 방법으로 이어 간 경우 등)
 */
const step = async (flow, name, fn, { needs = true } = {}) => {
  // 돌려주는 값: 통과면 fn의 값(없으면 true), 실패·건너뜀이면 false
  const row = { flow: flow.id, n: results.filter((r) => r.flow === flow.id).length + 1, name }
  results.push(row)
  if (!needs) {
    Object.assign(row, { status: '건너뜀', ms: 0, why: '앞 단계가 실패해 할 수 없어요' })
    console.log(`- [${flow.id}${row.n}] ${name}: 건너뜀`)
    return false
  }
  const t = Date.now()
  try {
    const v = await fn()
    Object.assign(row, { status: '통과', ms: Date.now() - t, why: v?.note ?? '' })
    console.log(`✓ [${flow.id}${row.n}] ${name} (${row.ms}ms)${row.why ? ` — ${row.why}` : ''}`)
    return v ?? true
  } catch (e) {
    Object.assign(row, { status: '실패', ms: Date.now() - t, why: String(e.message).replace(/\s+/g, ' ') })
    console.log(`✗ [${flow.id}${row.n}] ${name}: ${row.why}`)
    return false
  }
}
/** 실패한 단계의 까닭에 '예전 방법으로 이어 감'을 덧붙인다 */
const note = (msg) => {
  const last = results.at(-1)
  if (last) last.why = `${last.why} → ${msg}`
}

/** 글이 보일 때까지 다시 읽기 (예전 방법: 도구 없이 시험이 직접 기다린다) */
const pollRead = async (tabId, re, ms = 8000) => {
  const until = Date.now() + ms
  let page = ''
  while (Date.now() < until) {
    page = await read(tabId)
    if (re.test(page)) return page
    await sleep(500)
  }
  throw new Error(`${ms / 1000}초 동안 ${re} 이(가) 화면에 나오지 않았어요`)
}

/** 기다리기 도구로 기다리고, 없으면 실패로 적은 뒤 다시 읽기로 이어 간다. 이어 간 화면 글을 돌려준다 */
const waitStep = async (flow, name, tabId, waitText, re) => {
  let page
  const ok = await step(flow, name, async () => {
    const [tool, args] = PLANNED.wait(tabId, waitText)
    await run(tool, args)
    page = await read(tabId)
    if (!re.test(page)) throw new Error(`기다린 뒤에도 ${re} 이(가) 화면에 없어요`)
  })
  if (ok) return page
  try {
    page = await pollRead(tabId, re)
    note('다시 읽기로 이어 감')
    return page
  } catch (e) {
    note(`다시 읽기로도 못 봄: ${e.message}`)
    return undefined
  }
}

async function runFlow(flow) {
  console.log(`\n── 흐름 ${flow.id}: ${flow.name} (${flow.flags}) ──`)
  const before = { paid: shop.state.paid, prepares: shop.state.prepares }
  const popup = flow.flags.includes('pg=popup')
  const savedShip = flow.flags.includes('ship=saved')
  let tabId
  let page = ''

  // 1. 상품
  await step(flow, '상품 화면 열기', async () => {
    const r = text(await run('open', { url: `${shop.product}?${flow.flags}` }))
    tabId = Number(r.match(/\[탭 (\d+)\]/)?.[1])
    if (!tabId) throw new Error(`탭 번호가 없어요: ${r.slice(0, 200)}`)
    if (!r.includes(PRODUCT.name)) throw new Error('상품 이름이 안 보여요')
    page = r
  })
  if (!tabId) return
  const onCheckout = await step(flow, '[구매하기] → 주문서 (결제 아님, 승인 없음)', async () => {
    const r = text(await run('click', { tabId, ref: refOf(page, '버튼', '구매하기'), opens_checkout: true }))
    page = /주문\/결제/.test(r) ? r : await pollRead(tabId, /주문\/결제/)
    if (tools.approvals.list().some((x) => x.status === 'pending')) throw new Error('승인 카드가 떴어요')
  })

  // 2. 주문서
  await step(
    flow,
    `주문서 읽기: 상품·금액·${savedShip ? '저장된' : '빈'} 배송지·결제 수단`,
    async () => {
      page = await read(tabId)
      const ship = savedShip ? SAVED_ADDR.detail : '등록된 배송지가 없어요'
      for (const want of [PRODUCT.name, '총 결제 금액', '15,900원', ship])
        if (!page.includes(want)) throw new Error(`"${want}"이(가) 안 보여요`)
      refOf(page, '버튼', savedShip ? '배송지 변경' : '배송지 추가')
      refOf(page, '버튼', '15,900원 결제하기')
      refOf(page, '라디오', '신용/체크카드')
      refOf(page, '라디오', '간편결제')
    },
    { needs: onCheckout },
  )
  await step(
    flow,
    '수량 늘리기·줄이기 (주문서 안 버튼은 승인 없이)',
    async () => {
      let r = text(await run('click', { tabId, ref: refOf(page, '버튼', '수량 늘리기') }))
      if (!r.includes('31,800원')) throw new Error('수량 2개 금액(31,800원)이 안 보여요')
      r = text(await run('click', { tabId, ref: refOf(r, '버튼', '수량 줄이기') }))
      if (!/총 결제 금액 15,900원/.test(r)) throw new Error('다시 1개 금액으로 안 돌아왔어요')
      page = r
    },
    { needs: onCheckout },
  )
  await step(
    flow,
    '쿠폰 고르고 [적용]',
    async () => {
      const sel = page.match(/\[(e\d+) 선택 상자 "할인 쿠폰[^\]]*\]/)?.[1]
      if (!sel) throw new Error('쿠폰 선택 상자가 없어요')
      await run('select', { tabId, ref: sel, choose: COUPON.name })
      const r = text(await run('click', { tabId, ref: refOf(await read(tabId), '버튼', '적용') }))
      if (!/적용됨/.test(r) || !/총 결제 금액 14,900원/.test(r))
        throw new Error('할인된 금액(14,900원)이 안 보여요')
      page = r
    },
    { needs: onCheckout },
  )
  await step(
    flow,
    '배송 요청사항 고르기',
    async () => {
      const sel = page.match(/\[(e\d+) 선택 상자 "배송 요청사항[^\]]*\]/)?.[1]
      if (!sel) throw new Error('배송 요청사항 선택 상자가 없어요')
      page = text(await run('select', { tabId, ref: sel, choose: '문 앞에 놓아 주세요' }))
      if (!/값="문 앞에 놓아 주세요"/.test(page)) throw new Error('고른 요청사항이 안 보여요')
    },
    { needs: onCheckout },
  )
  await step(
    flow,
    '결제 수단 라디오 바꾸기',
    async () => {
      let r = text(await run('click', { tabId, ref: refOf(page, '라디오', '간편결제') }))
      if (!/라디오 "간편결제[^"]*" 선택됨/.test(r)) throw new Error('간편결제가 골라지지 않았어요')
      r = text(await run('click', { tabId, ref: refOf(r, '라디오', '신용/체크카드') }))
      if (!/라디오 "신용\/체크카드" 선택됨/.test(r)) throw new Error('카드로 돌아오지 않았어요')
      page = r
    },
    { needs: onCheckout },
  )

  // 3. 배송지 추가 (액자) → 우편번호 찾기 (액자 속 액자). 저장된 배송지 흐름(ship=saved)은 건너뛴다
  let saved = false
  if (!savedShip) {
    const nameRe = /\[e\d+ 입력칸 "받는 분"/
    let shown = await step(
      flow,
      '[배송지 추가] → 0.8초 뒤 그려지는 액자 양식이 누른 결과에 보인다',
      async () => {
        const r = text(await run('click', { tabId, ref: refOf(page, '버튼', '배송지 추가') }))
        page = r
        if (!nameRe.test(framesOf(r))) throw new Error('누른 결과에 액자 속 "받는 분" 칸이 없어요')
      },
      { needs: onCheckout },
    )
    if (!shown && onCheckout) {
      const p = await waitStep(flow, '기다리기 도구로 배송지 양식 기다리기', tabId, '받는 분', nameRe)
      if (p) page = p
      shown = Boolean(p)
    }
    const filled = await step(
      flow,
      '액자 안 칸에 받는 분·연락처 넣기',
      async () => {
        await run('type', { tabId, ref: refOf(page, '입력칸', '받는 분'), text: '김두리' })
        page = text(await run('type', { tabId, ref: refOf(page, '입력칸', '연락처'), text: '01012345678' }))
        if (!/입력칸 "받는 분"[^\]]*값="김두리"/.test(page))
          throw new Error('받는 분 칸에 글이 안 들어갔어요')
      },
      { needs: shown },
    )
    const searchRe = /\[e\d+ (?:입력칸|검색칸) "주소 검색"/
    let jusoOpen = await step(
      flow,
      '[우편번호 찾기] → 액자 속 액자의 검색 칸이 보인다',
      async () => {
        page = text(await run('click', { tabId, ref: refOf(page, '버튼', '우편번호 찾기') }))
        if (!searchRe.test(page)) throw new Error('누른 결과에 주소 검색 칸이 없어요 (액자 속 액자)')
      },
      { needs: filled },
    )
    if (!jusoOpen && filled) {
      const p = await waitStep(flow, '기다리기 도구로 주소 찾기 액자 기다리기', tabId, '주소 검색', searchRe)
      if (p) page = p
      jusoOpen = Boolean(p)
    }
    const rowRe = /\[(e\d+) 버튼 "경기도 용인시 수지구 테스트로 27 \(테스트마을\) 16845/
    const searched = await step(
      flow,
      '주소 검색 칸에 넣고 Enter → 0.6초 뒤 결과 줄 (결제로 막히지 않음)',
      async () => {
        const r = text(
          await run('type', {
            tabId,
            ref: refOf(page, '입력칸|검색칸', '주소 검색'),
            text: '테스트로 27',
            submit: true,
          }),
        )
        page = rowRe.test(r) ? r : await pollRead(tabId, rowRe, 4000)
        return rowRe.test(r) ? undefined : { note: '누른 결과에는 없어 다시 읽어 찾음' }
      },
      { needs: jusoOpen },
    )
    const picked = await step(
      flow,
      '결과 줄 누르기 → 주소 찾기가 닫히고 양식에 우편번호·주소',
      async () => {
        const r = text(await run('click', { tabId, ref: page.match(rowRe)?.[1] }))
        page = /값="16845"/.test(r) ? r : await pollRead(tabId, /값="16845"/, 4000)
        if (searchRe.test(page)) throw new Error('주소 찾기 액자가 닫히지 않았어요')
        if (!/값="경기도 용인시 수지구 테스트로 27/.test(page)) throw new Error('주소 칸이 비었어요')
      },
      { needs: searched },
    )
    saved = await step(
      flow,
      '상세주소 넣고 [저장하기] → 주문서에 배송지',
      async () => {
        page = text(
          await run('type', { tabId, ref: refOf(page, '입력칸', '상세주소'), text: '101동 1001호' }),
        )
        const r = text(await run('click', { tabId, ref: refOf(page, '버튼', '저장하기') }))
        const ok = (p) => /테스트로 27 \(테스트마을\) 101동 1001호 \(16845\)/.test(mainOf(p))
        page = ok(r) ? r : await pollRead(tabId, /테스트로 27 \(테스트마을\) 101동 1001호 \(16845\)/, 4000)
        if (!ok(page) || page.includes('등록된 배송지가 없어요'))
          throw new Error('주문서에 배송지가 안 보여요')
        return ok(r) ? undefined : { note: '누른 결과에는 없어 다시 읽어 찾음' }
      },
      { needs: picked },
    )
  }

  // 배송지 단계가 막혀도 결제 단계는 본다: 저장된 배송지가 있는 단골 주문서로 다시 연다 (쿠폰·수량은 처음 값)
  let haveAddr = saved || (savedShip && onCheckout)
  if (!haveAddr && onCheckout) {
    try {
      page = text(
        await run('navigate', { tabId, url: `${shop.url}/checkout/order?${flow.flags}&ship=saved` }),
      )
      haveAddr = mainOf(page).includes(SAVED_ADDR.detail)
      note(
        haveAddr
          ? '저장된 배송지 주문서(ship=saved)로 결제 단계를 이어 감'
          : '저장된 배송지 주문서도 못 읽음',
      )
    } catch (e) {
      note(`저장된 배송지 주문서도 못 엶: ${e.message}`)
    }
  }

  // 4. 결제 카드 → 승인 → 결제 회사 창
  let approval
  let total = ''
  // 안전장치: 돈이 나가는 마지막 버튼은 매번 승인 한 번 (PLAN.md 원칙 1). 승인 없이 가게에 결제 준비 요청이 가면 실패다.
  // 흐름들은 한 본체(한 BrowserTools)에서 이어 돈다: 앞 흐름의 승인이 같은 사이트의 돈 버튼을 열어 두면(사이트 30분 통과) 여기서 잡힌다
  let leaked = false
  // 합의한 설계: AI가 final로 선언한 누르기는 누르지 않고, browser_checkout으로 결제 카드를 띄우라는 오류로 돌려준다
  // (결제 카드 내용 — 상품·금액·배송지 — 은 checkout만 받으니 click이 카드를 대신 만들지 않는다).
  // 그래서 이 단계의 통과 = 안 눌렸고(가게에 결제 준비 요청 없음) + browser_checkout을 가리킨다. 카드는 다음에 checkout으로 띄운다
  await step(
    flow,
    '[결제하기]를 마지막 버튼으로 누르기(final) → 누르지 않고 browser_checkout(결제 카드)으로 안내',
    async () => {
      page = await read(tabId)
      total = totalOf(page)
      const p0 = shop.state.prepares
      const r = await tools.run('click', { tabId, ref: payRef(page), ...PLANNED.finalClick })
      if (shop.state.prepares > p0) {
        leaked = true
        throw new Error('승인 없이 [결제하기]가 눌려 결제가 시작됐어요 (앞 승인의 사이트 통과 등)')
      }
      approval = tools.approvals.list().find((x) => x.status === 'pending')
      if (approval) return { note: '결제 카드가 바로 떴어요' }
      if (!r.isError || !/browser_checkout/.test(text(r)))
        throw new Error(`안 눌렸지만 browser_checkout 안내가 없어요: ${text(r).slice(0, 160)}`)
    },
    { needs: haveAddr },
  )
  if (leaked) note('이미 눌렸으니 그 결제 창으로 뒤 단계를 이어 감')
  if (!approval && haveAddr && !leaked) {
    // 안내대로 browser_checkout (결제 화면의 마지막 버튼에 결제 카드). final 단계가 실패했어도 같은 길로 이어 간다
    await step(flow, 'browser_checkout → 결제 카드 (아직 누르지 않음)', async () => {
      page = await read(tabId)
      total = totalOf(page)
      const p0 = shop.state.prepares
      await run('checkout', {
        tabId,
        ref: payRef(page),
        title: '두리 결제 가게',
        goods: [{ name: PRODUCT.name, qty: '1개', price: '15,900원' }],
        total,
        ship_to: `${SAVED_ADDR.name} · ${SAVED_ADDR.road} ${SAVED_ADDR.detail}`,
      })
      if (shop.state.prepares > p0) throw new Error('승인 전에 [결제하기]가 눌렸어요')
      approval = tools.approvals.list().find((x) => x.status === 'pending')
      if (!approval) throw new Error('결제 카드(승인 요청)가 뜨지 않았어요')
    })
  }
  if (approval)
    await step(flow, `결제 카드 내용: 돈 승인·${total}`, async () => {
      if (approval.kind !== 'money') throw new Error(`돈 승인이 아니에요 (${approval.kind})`)
      if (approval.amount && !approval.amount.includes(total.replace('원', '')))
        throw new Error(`금액이 달라요: ${approval.amount}`)
    })
  let approved
  const pressed =
    leaked ||
    (await step(
      flow,
      '승인 → 두리가 [결제하기]를 누른다',
      async () => {
        approved = await tools.approve(approval.id)
        if (!approved.ok) throw new Error(approved.message)
        return { note: approved.message.slice(0, 120) }
      },
      { needs: Boolean(approval) },
    ))

  let pgTab
  let pgFrame = false
  if (popup) {
    const tabsOk = await step(
      flow,
      '늦게 뜬 결제 창(새 창)을 탭 목록에서 찾기',
      async () => {
        const until = Date.now() + 12_000
        while (Date.now() < until) {
          const [tool, args] = PLANNED.tabs()
          const r = text(await run(tool, args))
          // 열린 탭 줄(- [탭 N] …)에서 이 주문서가 연 결제 창만. '최근 닫힌 새 창' 줄에는 앞 흐름의 닫힌 결제 창도 있다
          // (예전에는 그 줄을 집어 '탭이 닫혔어요'로 실패했다 — 흐름 C)
          const line = r
            .split('\n')
            .find(
              (l) =>
                l.startsWith('- [탭 ') &&
                l.includes('/payment/card') &&
                l.includes(`탭 ${tabId}이(가) 연 창`),
            )
          const id = Number(line?.match(/^- \[탭 (\d+)\]/)?.[1])
          if (id) {
            pgTab = id
            return
          }
          await sleep(700)
        }
        throw new Error('12초 동안 탭 목록에 결제 창이 없어요')
      },
      { needs: pressed },
    )
    if (!tabsOk && pressed) {
      // 예전 방법: 승인 결과 글의 탭 번호, 없으면 확장에 늦게 뜬 창을 직접 묻는다
      pgTab = Number(approved?.message.match(/새 탭\(탭 (\d+)\)/)?.[1]) || undefined
      for (let i = 0; !pgTab && i < 20; i++) {
        pgTab = (await call('popup', { tabId }).catch(() => ({}))).newTabId
        if (!pgTab) await sleep(500)
      }
      note(pgTab ? `확장에 직접 물어 찾음(탭 ${pgTab})` : '확장도 늦게 뜬 창을 못 찾음')
    }
    await step(
      flow,
      '팝업 차단에 걸리지 않았다',
      async () => {
        const r = await read(tabId)
        if (r.includes('결제 창이 차단되었어요'))
          throw new Error('가게가 "결제 창이 차단되었어요"를 띄웠어요')
      },
      { needs: pressed },
    )
  } else {
    pgFrame = Boolean(
      await step(
        flow,
        '화면 안 결제 창(액자)이 뜬다',
        async () => {
          page = await pollRead(tabId, /카드사 선택/, 8000)
          if (!/카드사 선택/.test(framesOf(page))) throw new Error('결제 창 액자가 없어요')
        },
        { needs: pressed },
      ),
    )
    pgTab = pgFrame ? tabId : undefined
  }

  let pg = ''
  const pgRead = await step(
    flow,
    '결제 창 읽기: 금액이 주문서와 같다 (결제 회사 사이트의 글도 읽힌다)',
    async () => {
      pg = await pollRead(pgTab, new RegExp(`결제 금액 ${total}`), 6000)
      refOf(pg, '라디오', '신한카드')
      refOf(pg, '버튼', '다음')
    },
    { needs: Boolean(pgTab) },
  )
  const nextOk = await step(
    flow,
    '결제 창 안 카드 고르기·[다음] (같은 결제라 다시 승인하지 않음)',
    async () => {
      pg = text(await run('click', { tabId: pgTab, ref: refOf(pg, '라디오', '신한카드') }))
      const n = tools.approvals.list().filter((x) => x.status === 'pending').length
      pg = text(await run('click', { tabId: pgTab, ref: refOf(pg, '버튼', '다음') }))
      if (tools.approvals.list().filter((x) => x.status === 'pending').length > n)
        throw new Error('결제 창 안 버튼에 승인을 또 받았어요')
      pg = /결제 비밀번호 6자리/.test(pg) ? pg : await pollRead(pgTab, /결제 비밀번호 6자리/, 4000)
    },
    { needs: pgRead },
  )
  // 예전 방법: 결제 창 안 [다음]이 돈 버튼으로 막히면 승인을 한 번 더 받아 누른다 (실측 11-20 G마켓: 사용자가 두 번 승인)
  let nextAgain = false
  if (!nextOk && pgRead) {
    try {
      pg = await read(pgTab)
      if (!/결제 비밀번호 6자리/.test(pg)) {
        await run('request_approval', {
          tabId: pgTab,
          ref: refOf(pg, '버튼', '다음'),
          what: '카드 결제 다음 단계',
          where: '두리PG',
        })
        const again = tools.approvals.list().find((x) => x.status === 'pending')
        const r = again ? await tools.approve(again.id) : { ok: false, message: '승인 카드가 안 떴어요' }
        if (!r.ok) throw new Error(r.message)
        pg = await pollRead(pgTab, /결제 비밀번호 6자리/, 4000)
      }
      nextAgain = true
      note('승인을 한 번 더 받아 [다음]을 눌러 이어 감')
    } catch (e) {
      note(`두 번째 승인으로도 못 넘어감: ${e.message.slice(0, 120)}`)
    }
  }

  // 5. 키패드
  const keyRefs = (p) => {
    const part = pgFrame ? framesOf(p) : p
    const tail = part.slice(part.indexOf('결제 비밀번호 6자리'))
    if (flow.flags.includes('keys=img')) return [...tail.matchAll(/\[(e\d+) 버튼\]/g)].map((m) => m[1])
    return [...tail.matchAll(/\[(e\d+) 버튼 "(\d)"\]/g)].map((m) => m[1])
  }
  /** 숫자 → 버튼 표시. 글자 키패드는 글로, 그림 키패드는 가게 정답지로 (AI가 잘라 본 그림을 읽은 결과 대신) */
  const keyMap = async (p, tid) => {
    const refs = keyRefs(p)
    if (refs.length !== 10) throw new Error(`숫자 버튼이 10개가 아니에요 (${refs.length}개)`)
    if (flow.flags.includes('keys=img')) {
      const { layout } = await fetch(`${shop.origins.pg}/api/pg/keymap?tid=${tid}`).then((r) => r.json())
      return Object.fromEntries(layout.map((d, i) => [d, refs[i]]))
    }
    const part = pgFrame ? framesOf(p) : p
    return Object.fromEntries(refs.map((r) => [part.match(new RegExp(`\\[${r} 버튼 "(\\d)"\\]`))?.[1], r]))
  }
  const tid = [...shop.state.orders.keys()].at(-1)
  let keys
  const shot = await step(
    flow,
    `키패드 버튼을 하나씩 찍기${flow.flags.includes('keypad=off') ? ' (화면 아래로 잘린 키패드)' : ''}`,
    async () => {
      pg = await read(pgTab)
      const refs = keyRefs(pg)
      if (refs.length !== 10) throw new Error(`키패드 숫자 버튼이 10개가 아니에요 (${refs.length}개)`)
      const r = await run('request_code', { tabId: pgTab, kind: 'pin', key_refs: refs })
      const imgs = r.content.filter((c) => c.type === 'image')
      if (imgs.length < 10) throw new Error(`찍은 그림이 ${imgs.length}장이에요`)
      imgs.forEach((c, i) => {
        writeFileSync(join(out, `e2e-pay-${flow.id}-key${i}.jpg`), Buffer.from(c.data, 'base64'))
      })
      if (imgs.some((c) => c.data.length < 400))
        throw new Error('빈 그림이 있어요 (화면 밖이라 못 찍었을 수 있어요)')
    },
    { needs: nextOk || nextAgain },
  )
  const pinTry = async (pin) => {
    pg = await read(pgTab)
    keys = await keyMap(pg, tid)
    pinCard = undefined
    await run('request_code', { tabId: pgTab, kind: 'pin', keys })
    if (!pinCard) throw new Error('폰 키패드 카드가 뜨지 않았어요')
    await typeOnPhone(pin)
  }
  if (flow.wrongFirst)
    await step(
      flow,
      '틀린 비밀번호 → "비밀번호가 틀렸어요 (1/5)" · 다시 섞인 키패드',
      async () => {
        await pinTry('000000')
        const old = JSON.stringify(keys)
        pg = await pollRead(pgTab, /비밀번호가 틀렸어요 \(1\/5\)/, 4000)
        const again = await keyMap(pg, tid)
        if (JSON.stringify(again) === old) return { note: '자리가 우연히 같게 섞임' }
      },
      { needs: Boolean(shot) },
    )
  const paid = await step(
    flow,
    '맞는 비밀번호 → 결제 완료',
    async () => {
      await pinTry(PIN)
      const until = Date.now() + 6000
      while (shop.state.paid === before.paid && Date.now() < until) await sleep(200)
      if (shop.state.paid === before.paid) throw new Error('가게 서버가 결제를 받지 못했어요')
    },
    { needs: Boolean(shot) },
  )

  // 6. 끝: 주문 완료 화면 + 주문번호
  const doneOk = await step(
    flow,
    '주문서 탭이 주문 완료 화면으로 → 주문번호',
    async () => {
      const r = await pollRead(tabId, /주문이 완료되었어요/, 8000)
      if (!r.includes(`주문번호 ${ORDER_NO}`)) throw new Error('주문번호가 안 보여요')
      return { note: `주문번호 ${r.match(/주문번호 (\d+)/)?.[1]}` }
    },
    { needs: paid },
  )
  if (popup)
    await step(
      flow,
      '결제 창은 스스로 닫혔다',
      async () => {
        await sleep(800)
        const still = await call('snapshot', { tabId: pgTab }).then(
          () => true,
          () => false,
        )
        if (still) throw new Error('결제 창 탭이 아직 열려 있어요')
      },
      { needs: paid },
    )
  await step(
    flow,
    '주문 완료를 도구로 알리기 → 결제 중 풀림',
    async () => {
      const [tool, args] = PLANNED.orderDone(tabId)
      await run(tool, args)
      if (tools.isPaying(tabId)) throw new Error('아직 결제 중인 탭으로 남아 있어요')
    },
    { needs: doneOk },
  )
  await step(
    flow,
    '가게 서버: 결제 준비 한 번·결제 한 번 (두 번 결제 없음)',
    async () => {
      const prepares = shop.state.prepares - before.prepares
      const got = shop.state.paid - before.paid
      if (prepares !== 1 || got !== 1) throw new Error(`준비 ${prepares}번·결제 ${got}번`)
    },
    { needs: pressed },
  )
  if (!doneOk) {
    const shot2 = await call('screenshot', { tabId }).catch(() => undefined)
    if (shot2?.data)
      writeFileSync(join(out, `e2e-pay-${flow.id}-last.jpg`), Buffer.from(shot2.data, 'base64'))
    writeFileSync(join(out, `e2e-pay-${flow.id}-last.txt`), await read(tabId).catch((e) => String(e)))
  }
  // 다음 흐름을 위해 정리
  for (const t of [pgTab, tabId]) if (t) await call('close', { tabId: t }).catch(() => {})
  tools.donePaying?.(tabId)
}

let crashed = false
try {
  for (let i = 0; i < 150 && !daemon.browser.status.connected; i++) await sleep(200)
  if (!daemon.browser.status.connected) throw new Error('확장이 30초 안에 본체에 붙지 않았어요')
  for (const flow of FLOWS) await runFlow(flow)
} catch (e) {
  crashed = true
  console.log(`✗ 시험을 이어 갈 수 없어요: ${e.message}`)
} finally {
  chrome.kill()
  await daemon.close()
  await shop.close()
  await sleep(500)
  rmSync(tmp, { recursive: true, force: true })
}

// ── 결과 표 ──
const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '/')
    .slice(0, 160)
const table = [
  '| 흐름 | # | 단계 | 결과 | ms | 까닭 |',
  '|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.flow} | ${r.n} | ${cell(r.name)} | ${r.status} | ${r.ms} | ${cell(r.why)} |`),
].join('\n')
const count = (s) => results.filter((r) => r.status === s).length
const summary = `통과 ${count('통과')} · 실패 ${count('실패')} · 건너뜀 ${count('건너뜀')}`
console.log(`\n결제 흐름 시험 결과 (${summary})\n${table}`)
writeFileSync(join(out, 'e2e-pay-result.txt'), `${summary}\n${table}\n`)
writeFileSync(join(out, 'e2e-pay-result.json'), JSON.stringify(results, null, 2))
const failed = crashed || count('실패') > 0 || count('건너뜀') > 0
console.log(failed ? '실패' : '모두 통과')
process.exit(failed && process.env.DOOL2_E2E_PAY !== 'report' ? 1 : 0)
