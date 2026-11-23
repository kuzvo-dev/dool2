// End-to-end payment-flow test: load the Dool2 extension into a test Chrome (Chrome for Testing) and, with the real daemon's browser tools (BrowserTools),
// go through the payment test shop (pay-shop.mjs): product -> order page -> add address (frame) -> address search (frame in a frame) -> payment card approval
// -> late payment window -> card and [Next] -> keypad -> order complete + order number. The test calls the tools in turn instead of an AI.
//
// Why: a real Gmarket order (measured 11-20) got stuck six times in this flow. It must pass end to end here before touching a real account
// (revamp plan PLAN.md principle 5). Each step records pass/fail and the reason separately, and a table is shown at the end.
// If a step fails, continue another way when possible and check the later steps too (so everything that is stuck shows at once).
//
//   pnpm build
//   DOOL2_TEST_CHROME=".../Google Chrome for Testing" node apps/extension/scripts/e2e-pay.mjs
//   DOOL2_PAY_FLOWS=A        run one flow only (A: new-window payment, B: in-page frame payment)
//   DOOL2_E2E_PAY=report     leave only the table and exit with success even if something failed (for comparing during the revamp)
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserTools, startDaemon } from '@dool2/daemon'
import { COUPON, ORDER_NO, PIN, PRODUCT, SAVED_ADDR, start as startShop } from './pay-shop.mjs'

const chromeBin = process.env.DOOL2_TEST_CHROME
if (!chromeBin) {
  console.error('Set DOOL2_TEST_CHROME to the Chrome for Testing executable path')
  process.exit(2)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.env.DOOL2_E2E_OUT ?? join(root, 'out')
mkdirSync(out, { recursive: true })

// Tool names and arguments after the revamp (PLAN.md branches A and B). Once names are settled, change only here
const PLANNED = {
  /** Tab list: new windows, opener tabs, blocked popups (browser_tabs) */
  tabs: () => ['tabs', {}],
  /** Wait until the page changes (browser_wait) */
  wait: (tabId, text) => ['wait', { tabId, for: text, timeoutMs: 6000 }],
  /** Payment is over with the order complete page + order number (browser_order_done) */
  orderDone: (tabId) => ['order_done', { tabId, order_no: ORDER_NO }],
  /** A click where the AI declares 'the last button that spends money' -> payment card (browser_click final) */
  finalClick: { final: true },
}

const FLOWS = [
  {
    // Same shape as the measured 11-20 Gmarket: address frame from another site, new-window payment 1.2s after the prepare request, keypad cut off below the screen
    id: 'A',
    name: 'New-window payment, address from another site, off-screen keypad, one wrong PIN',
    flags: 'addr=cross&pg=popup&late=1200&keypad=off&keys=text',
    wrongFirst: true,
  },
  {
    id: 'B',
    name: 'In-page frame payment, address from the same shop, image digit keypad',
    flags: 'addr=same&pg=layer&late=1200&keypad=on&keys=img',
    wrongFirst: false,
  },
  {
    // The payment window appears after 5.5s: Chrome's click allowance (5s) has passed, so it is blocked without allowing the site's popups,
    // and looking once 2.5s after approval cannot find it. The address is skipped with a saved one (ship=saved)
    id: 'C',
    name: 'Very late new-window payment (popup-blocking edge), saved address',
    flags: 'addr=cross&pg=popup&late=5500&keypad=off&keys=text&ship=saved',
    wrongFirst: false,
  },
].filter((f) => !process.env.DOOL2_PAY_FLOWS || process.env.DOOL2_PAY_FLOWS.split(',').includes(f.id))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const text = (r) => (r?.content ?? []).map((c) => c.text ?? '').join('\n')
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Find a mark (e12) in the page text. role is a regex piece like '버튼', '라디오', '입력칸|검색칸' (Korean snapshot words); name is the beginning */
const refOf = (page, role, name) =>
  page.match(new RegExp(`\\[(e\\d+) (?:${role}) "${reEsc(name)}[^"]*"`))?.[1] ??
  (() => {
    throw new Error(`${role} "${name}" not found on the page`)
  })()
/** Only the frame part (## 화면 안 액자 ...) */
const framesOf = (page) => page.split('\n## 화면 안 액자').slice(1).join('\n## 화면 안 액자')
const mainOf = (page) => page.split('\n## 화면 안 액자')[0] ?? ''
/** Pay button (the amount comes before the name: "14,900원 결제하기") */
const payRef = (page) => {
  const r = mainOf(page).match(/\[(e\d+) 버튼 "[\d,]+원 결제하기"\]/)?.[1]
  if (!r) throw new Error('The [결제하기] button was not found on the page')
  return r
}
const totalOf = (page) => mainOf(page).match(/총 결제 금액 ([\d,]+원)/)?.[1] ?? ''

// ── Shop + Dool2 daemon + test Chrome ──
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
/** Call a tool and throw its text if it is an error */
const run = async (tool, args) => {
  const r = await tools.run(tool, args)
  if (r.isError) throw new Error(text(r).replace(/\s+/g, ' ').slice(0, 300))
  return r
}
const read = async (tabId) => text(await run('read', { tabId }))

// Imitate the phone keypad card: press the pointed-out buttons in turn like the daemon (index.ts) does (the same BrowserTools.pressPin).
// In the test, the test supplies 'the value the user typed on the phone'
let pinCard
tools.requestPin = (tabId, _label, _host, keys, length) => {
  pinCard = { tabId, keys, length }
  return 'pin-card'
}
const typeOnPhone = async (pin) => {
  if (!(await tools.pressPin(pinCard.tabId, pinCard.keys, pin)))
    throw new Error('Could not press the whole on-screen keypad')
}

// ── Step records ──
const results = []
/**
 * One step. On failure it goes on to the next step. If needs is false (a required thing was not obtained in an earlier step) it is recorded as skipped.
 * If fn returns { note } it goes in the reason column (e.g. passed but continued the old way)
 */
const step = async (flow, name, fn, { needs = true } = {}) => {
  // Return value: on pass, fn's value (true if none); on failure or skip, false
  const row = { flow: flow.id, n: results.filter((r) => r.flow === flow.id).length + 1, name }
  results.push(row)
  if (!needs) {
    Object.assign(row, { status: 'skipped', ms: 0, why: 'cannot run because an earlier step failed' })
    console.log(`- [${flow.id}${row.n}] ${name}: skipped`)
    return false
  }
  const t = Date.now()
  try {
    const v = await fn()
    Object.assign(row, { status: 'passed', ms: Date.now() - t, why: v?.note ?? '' })
    console.log(`✓ [${flow.id}${row.n}] ${name} (${row.ms}ms)${row.why ? ` — ${row.why}` : ''}`)
    return v ?? true
  } catch (e) {
    Object.assign(row, { status: 'failed', ms: Date.now() - t, why: String(e.message).replace(/\s+/g, ' ') })
    console.log(`✗ [${flow.id}${row.n}] ${name}: ${row.why}`)
    return false
  }
}
/** Append 'continued the old way' to the reason of the failed step */
const note = (msg) => {
  const last = results.at(-1)
  if (last) last.why = `${last.why} → ${msg}`
}

/** Read again until the text shows (old way: the test waits by itself without a tool) */
const pollRead = async (tabId, re, ms = 8000) => {
  const until = Date.now() + ms
  let page = ''
  while (Date.now() < until) {
    page = await read(tabId)
    if (re.test(page)) return page
    await sleep(500)
  }
  throw new Error(`${re} did not appear on the page for ${ms / 1000}s`)
}

/** Wait with the wait tool; if that fails, record a failure and continue with re-reading. Returns the page text it continued with */
const waitStep = async (flow, name, tabId, waitText, re) => {
  let page
  const ok = await step(flow, name, async () => {
    const [tool, args] = PLANNED.wait(tabId, waitText)
    await run(tool, args)
    page = await read(tabId)
    if (!re.test(page)) throw new Error(`${re} is still not on the page after waiting`)
  })
  if (ok) return page
  try {
    page = await pollRead(tabId, re)
    note('continued by re-reading')
    return page
  } catch (e) {
    note(`not seen even by re-reading: ${e.message}`)
    return undefined
  }
}

async function runFlow(flow) {
  console.log(`\n── flow ${flow.id}: ${flow.name} (${flow.flags}) ──`)
  const before = { paid: shop.state.paid, prepares: shop.state.prepares }
  const popup = flow.flags.includes('pg=popup')
  const savedShip = flow.flags.includes('ship=saved')
  let tabId
  let page = ''

  // 1. Product
  await step(flow, 'Open the product page', async () => {
    const r = text(await run('open', { url: `${shop.product}?${flow.flags}` }))
    tabId = Number(r.match(/\[탭 (\d+)\]/)?.[1])
    if (!tabId) throw new Error(`No tab number: ${r.slice(0, 200)}`)
    if (!r.includes(PRODUCT.name)) throw new Error('The product name is not visible')
    page = r
  })
  if (!tabId) return
  const onCheckout = await step(flow, '[Buy] -> order page (not a payment, no approval)', async () => {
    const r = text(await run('click', { tabId, ref: refOf(page, '버튼', '구매하기'), opens_checkout: true }))
    page = /주문\/결제/.test(r) ? r : await pollRead(tabId, /주문\/결제/)
    if (tools.approvals.list().some((x) => x.status === 'pending'))
      throw new Error('An approval card appeared')
  })

  // 2. Order page
  await step(
    flow,
    `Read the order page: product, amount, ${savedShip ? 'saved' : 'empty'} address, payment method`,
    async () => {
      page = await read(tabId)
      const ship = savedShip ? SAVED_ADDR.detail : '등록된 배송지가 없어요'
      for (const want of [PRODUCT.name, '총 결제 금액', '15,900원', ship])
        if (!page.includes(want)) throw new Error(`"${want}" is not visible`)
      refOf(page, '버튼', savedShip ? '배송지 변경' : '배송지 추가')
      refOf(page, '버튼', '15,900원 결제하기')
      refOf(page, '라디오', '신용/체크카드')
      refOf(page, '라디오', '간편결제')
    },
    { needs: onCheckout },
  )
  await step(
    flow,
    'Quantity up and down (buttons on the order page need no approval)',
    async () => {
      let r = text(await run('click', { tabId, ref: refOf(page, '버튼', '수량 늘리기') }))
      if (!r.includes('31,800원')) throw new Error('The amount for quantity 2 (31,800원) is not visible')
      r = text(await run('click', { tabId, ref: refOf(r, '버튼', '수량 줄이기') }))
      if (!/총 결제 금액 15,900원/.test(r)) throw new Error('Did not return to the amount for 1')
      page = r
    },
    { needs: onCheckout },
  )
  await step(
    flow,
    'Choose a coupon and [Apply]',
    async () => {
      const sel = page.match(/\[(e\d+) 선택 상자 "할인 쿠폰[^\]]*\]/)?.[1]
      if (!sel) throw new Error('No coupon select box')
      await run('select', { tabId, ref: sel, choose: COUPON.name })
      const r = text(await run('click', { tabId, ref: refOf(await read(tabId), '버튼', '적용') }))
      if (!/적용됨/.test(r) || !/총 결제 금액 14,900원/.test(r))
        throw new Error('The discounted amount (14,900원) is not visible')
      page = r
    },
    { needs: onCheckout },
  )
  await step(
    flow,
    'Choose the delivery request note',
    async () => {
      const sel = page.match(/\[(e\d+) 선택 상자 "배송 요청사항[^\]]*\]/)?.[1]
      if (!sel) throw new Error('No delivery request select box')
      page = text(await run('select', { tabId, ref: sel, choose: '문 앞에 놓아 주세요' }))
      if (!/값="문 앞에 놓아 주세요"/.test(page)) throw new Error('The chosen request note is not visible')
    },
    { needs: onCheckout },
  )
  await step(
    flow,
    'Switch the payment method radio',
    async () => {
      let r = text(await run('click', { tabId, ref: refOf(page, '라디오', '간편결제') }))
      if (!/라디오 "간편결제[^"]*" 선택됨/.test(r)) throw new Error('The easy-pay option was not selected')
      r = text(await run('click', { tabId, ref: refOf(r, '라디오', '신용/체크카드') }))
      if (!/라디오 "신용\/체크카드" 선택됨/.test(r)) throw new Error('Did not go back to card')
      page = r
    },
    { needs: onCheckout },
  )

  // 3. Add address (frame) -> postal code search (frame in a frame). The saved-address flow (ship=saved) skips this
  let saved = false
  if (!savedShip) {
    const nameRe = /\[e\d+ 입력칸 "받는 분"/
    let shown = await step(
      flow,
      '[Add address] -> the frame form drawn 0.8s later shows in the click result',
      async () => {
        const r = text(await run('click', { tabId, ref: refOf(page, '버튼', '배송지 추가') }))
        page = r
        if (!nameRe.test(framesOf(r))) throw new Error('The click result has no "받는 분" field in a frame')
      },
      { needs: onCheckout },
    )
    if (!shown && onCheckout) {
      const p = await waitStep(flow, 'Wait for the address form with the wait tool', tabId, '받는 분', nameRe)
      if (p) page = p
      shown = Boolean(p)
    }
    const filled = await step(
      flow,
      'Type the recipient and phone into fields in the frame',
      async () => {
        await run('type', { tabId, ref: refOf(page, '입력칸', '받는 분'), text: '김두리' })
        page = text(await run('type', { tabId, ref: refOf(page, '입력칸', '연락처'), text: '01012345678' }))
        if (!/입력칸 "받는 분"[^\]]*값="김두리"/.test(page))
          throw new Error('The text did not go into the recipient field')
      },
      { needs: shown },
    )
    const searchRe = /\[e\d+ (?:입력칸|검색칸) "주소 검색"/
    let jusoOpen = await step(
      flow,
      '[Find postal code] -> the search field of the frame in a frame shows',
      async () => {
        page = text(await run('click', { tabId, ref: refOf(page, '버튼', '우편번호 찾기') }))
        if (!searchRe.test(page))
          throw new Error('The click result has no address search field (frame in a frame)')
      },
      { needs: filled },
    )
    if (!jusoOpen && filled) {
      const p = await waitStep(
        flow,
        'Wait for the address search frame with the wait tool',
        tabId,
        '주소 검색',
        searchRe,
      )
      if (p) page = p
      jusoOpen = Boolean(p)
    }
    const rowRe = /\[(e\d+) 버튼 "경기도 용인시 수지구 테스트로 27 \(테스트마을\) 16845/
    const searched = await step(
      flow,
      'Type in the address search field and Enter -> result rows 0.6s later (not blocked as a payment)',
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
        return rowRe.test(r) ? undefined : { note: 'not in the click result; found by reading again' }
      },
      { needs: jusoOpen },
    )
    const picked = await step(
      flow,
      'Click a result row -> the address search closes and the form gets postal code and address',
      async () => {
        const r = text(await run('click', { tabId, ref: page.match(rowRe)?.[1] }))
        page = /값="16845"/.test(r) ? r : await pollRead(tabId, /값="16845"/, 4000)
        if (searchRe.test(page)) throw new Error('The address search frame did not close')
        if (!/값="경기도 용인시 수지구 테스트로 27/.test(page)) throw new Error('The address field is empty')
      },
      { needs: searched },
    )
    saved = await step(
      flow,
      'Type the detailed address and [Save] -> address on the order page',
      async () => {
        page = text(
          await run('type', { tabId, ref: refOf(page, '입력칸', '상세주소'), text: '101동 1001호' }),
        )
        const r = text(await run('click', { tabId, ref: refOf(page, '버튼', '저장하기') }))
        const ok = (p) => /테스트로 27 \(테스트마을\) 101동 1001호 \(16845\)/.test(mainOf(p))
        page = ok(r) ? r : await pollRead(tabId, /테스트로 27 \(테스트마을\) 101동 1001호 \(16845\)/, 4000)
        if (!ok(page) || page.includes('등록된 배송지가 없어요'))
          throw new Error('The address is not visible on the order page')
        return ok(r) ? undefined : { note: 'not in the click result; found by reading again' }
      },
      { needs: picked },
    )
  }

  // Even if the address step is stuck, check the payment step: reopen with a regular customer's order page that has a saved address (coupon and quantity are the initial values)
  let haveAddr = saved || (savedShip && onCheckout)
  if (!haveAddr && onCheckout) {
    try {
      page = text(
        await run('navigate', { tabId, url: `${shop.url}/checkout/order?${flow.flags}&ship=saved` }),
      )
      haveAddr = mainOf(page).includes(SAVED_ADDR.detail)
      note(
        haveAddr
          ? 'continued to the payment step with the saved-address order page (ship=saved)'
          : 'could not read the saved-address order page either',
      )
    } catch (e) {
      note(`could not open the saved-address order page either: ${e.message}`)
    }
  }

  // 4. Payment card -> approval -> payment company window
  let approval
  let total = ''
  // Safeguard: the last button that spends money needs one approval every time (PLAN.md principle 1). If a prepare request reaches the shop without approval, it fails.
  // The flows run in one daemon (one BrowserTools): if an earlier flow's approval left the same site's money button open (site pass for 30 minutes), it is caught here
  let leaked = false
  // Agreed design: a click the AI declares final is not pressed; it returns an error telling to show the payment card with browser_checkout
  // (the payment card content - product, amount, address - is received only by checkout, so click does not build the card instead).
  // So passing this step = it was not pressed (no prepare request at the shop) + it points to browser_checkout. The card is shown next with checkout
  await step(
    flow,
    'Click [Pay] as the last button (final) -> not pressed, guided to browser_checkout (payment card)',
    async () => {
      page = await read(tabId)
      total = totalOf(page)
      const p0 = shop.state.prepares
      const r = await tools.run('click', { tabId, ref: payRef(page), ...PLANNED.finalClick })
      if (shop.state.prepares > p0) {
        leaked = true
        throw new Error(
          '[결제하기] was pressed without approval and payment started (e.g. the site pass of an earlier approval)',
        )
      }
      approval = tools.approvals.list().find((x) => x.status === 'pending')
      if (approval) return { note: 'the payment card appeared right away' }
      if (!r.isError || !/browser_checkout/.test(text(r)))
        throw new Error(`Not pressed, but there is no browser_checkout guidance: ${text(r).slice(0, 160)}`)
    },
    { needs: haveAddr },
  )
  if (leaked) note('already pressed, so the later steps continue with that payment window')
  if (!approval && haveAddr && !leaked) {
    // browser_checkout as guided (payment card on the last button of the payment page). Even if the final step failed, continue the same way
    await step(flow, 'browser_checkout -> payment card (not pressed yet)', async () => {
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
      if (shop.state.prepares > p0) throw new Error('[결제하기] was pressed before approval')
      approval = tools.approvals.list().find((x) => x.status === 'pending')
      if (!approval) throw new Error('The payment card (approval request) did not appear')
    })
  }
  if (approval)
    await step(flow, `Payment card content: money approval, ${total}`, async () => {
      if (approval.kind !== 'money') throw new Error(`Not a money approval (${approval.kind})`)
      if (approval.amount && !approval.amount.includes(total.replace('원', '')))
        throw new Error(`The amount differs: ${approval.amount}`)
    })
  let approved
  const pressed =
    leaked ||
    (await step(
      flow,
      'Approve -> Dool2 presses [결제하기]',
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
      'Find the late payment window (new window) in the tab list',
      async () => {
        const until = Date.now() + 12_000
        while (Date.now() < until) {
          const [tool, args] = PLANNED.tabs()
          const r = text(await run(tool, args))
          // Only the payment window this order page opened, from the open-tab lines (- [탭 N] ...). The 'recently closed new windows' line also holds closed payment windows from earlier flows
          // (it used to pick that line and fail with 'The tab was closed' - flow C)
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
        throw new Error('No payment window in the tab list for 12s')
      },
      { needs: pressed },
    )
    if (!tabsOk && pressed) {
      // Old way: the tab number in the approval result text; if none, ask the extension directly for the late window
      pgTab = Number(approved?.message.match(/새 탭\(탭 (\d+)\)/)?.[1]) || undefined
      for (let i = 0; !pgTab && i < 20; i++) {
        pgTab = (await call('popup', { tabId }).catch(() => ({}))).newTabId
        if (!pgTab) await sleep(500)
      }
      note(
        pgTab
          ? `found by asking the extension directly (tab ${pgTab})`
          : 'the extension could not find the late window either',
      )
    }
    await step(
      flow,
      'Not caught by popup blocking',
      async () => {
        const r = await read(tabId)
        if (r.includes('결제 창이 차단되었어요')) throw new Error('The shop showed "결제 창이 차단되었어요"')
      },
      { needs: pressed },
    )
  } else {
    pgFrame = Boolean(
      await step(
        flow,
        'The in-page payment window (frame) appears',
        async () => {
          page = await pollRead(tabId, /카드사 선택/, 8000)
          if (!/카드사 선택/.test(framesOf(page))) throw new Error('No payment window frame')
        },
        { needs: pressed },
      ),
    )
    pgTab = pgFrame ? tabId : undefined
  }

  let pg = ''
  const pgRead = await step(
    flow,
    'Read the payment window: the amount equals the order page (the payment company site text is read too)',
    async () => {
      pg = await pollRead(pgTab, new RegExp(`결제 금액 ${total}`), 6000)
      refOf(pg, '라디오', '신한카드')
      refOf(pg, '버튼', '다음')
    },
    { needs: Boolean(pgTab) },
  )
  const nextOk = await step(
    flow,
    'Choose a card and [Next] in the payment window (same payment, so no new approval)',
    async () => {
      pg = text(await run('click', { tabId: pgTab, ref: refOf(pg, '라디오', '신한카드') }))
      const n = tools.approvals.list().filter((x) => x.status === 'pending').length
      pg = text(await run('click', { tabId: pgTab, ref: refOf(pg, '버튼', '다음') }))
      if (tools.approvals.list().filter((x) => x.status === 'pending').length > n)
        throw new Error('Approval was asked again for a button in the payment window')
      pg = /결제 비밀번호 6자리/.test(pg) ? pg : await pollRead(pgTab, /결제 비밀번호 6자리/, 4000)
    },
    { needs: pgRead },
  )
  // Old way: if [Next] in the payment window is blocked as a money button, get one more approval and press it (measured 11-20 Gmarket: the user approved twice)
  let nextAgain = false
  if (!nextOk && pgRead) {
    try {
      pg = await read(pgTab)
      if (!/결제 비밀번호 6자리/.test(pg)) {
        await run('request_approval', {
          tabId: pgTab,
          ref: refOf(pg, '버튼', '다음'),
          what: 'card payment next step',
          where: '두리PG',
        })
        const again = tools.approvals.list().find((x) => x.status === 'pending')
        const r = again
          ? await tools.approve(again.id)
          : { ok: false, message: 'the approval card did not appear' }
        if (!r.ok) throw new Error(r.message)
        pg = await pollRead(pgTab, /결제 비밀번호 6자리/, 4000)
      }
      nextAgain = true
      note('got one more approval and pressed [Next] to continue')
    } catch (e) {
      note(`could not get past even with a second approval: ${e.message.slice(0, 120)}`)
    }
  }

  // 5. Keypad
  const keyRefs = (p) => {
    const part = pgFrame ? framesOf(p) : p
    const tail = part.slice(part.indexOf('결제 비밀번호 6자리'))
    if (flow.flags.includes('keys=img')) return [...tail.matchAll(/\[(e\d+) 버튼\]/g)].map((m) => m[1])
    return [...tail.matchAll(/\[(e\d+) 버튼 "(\d)"\]/g)].map((m) => m[1])
  }
  /** Digit -> button mark. Text keypad by text, image keypad by the shop's answer sheet (instead of what the AI read from the cropped images) */
  const keyMap = async (p, tid) => {
    const refs = keyRefs(p)
    if (refs.length !== 10) throw new Error(`There are not 10 digit buttons (${refs.length})`)
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
    `Capture the keypad buttons one by one${flow.flags.includes('keypad=off') ? ' (keypad cut off below the screen)' : ''}`,
    async () => {
      pg = await read(pgTab)
      const refs = keyRefs(pg)
      if (refs.length !== 10) throw new Error(`There are not 10 keypad digit buttons (${refs.length})`)
      const r = await run('request_code', { tabId: pgTab, kind: 'pin', key_refs: refs })
      const imgs = r.content.filter((c) => c.type === 'image')
      if (imgs.length < 10) throw new Error(`${imgs.length} images captured`)
      imgs.forEach((c, i) => {
        writeFileSync(join(out, `e2e-pay-${flow.id}-key${i}.jpg`), Buffer.from(c.data, 'base64'))
      })
      if (imgs.some((c) => c.data.length < 400))
        throw new Error('There is an empty image (it may be off-screen and could not be captured)')
    },
    { needs: nextOk || nextAgain },
  )
  const pinTry = async (pin) => {
    pg = await read(pgTab)
    keys = await keyMap(pg, tid)
    pinCard = undefined
    await run('request_code', { tabId: pgTab, kind: 'pin', keys })
    if (!pinCard) throw new Error('The phone keypad card did not appear')
    await typeOnPhone(pin)
  }
  if (flow.wrongFirst)
    await step(
      flow,
      'Wrong PIN -> "비밀번호가 틀렸어요 (1/5)" and a reshuffled keypad',
      async () => {
        await pinTry('000000')
        const old = JSON.stringify(keys)
        pg = await pollRead(pgTab, /비밀번호가 틀렸어요 \(1\/5\)/, 4000)
        const again = await keyMap(pg, tid)
        if (JSON.stringify(again) === old) return { note: 'the positions happened to shuffle the same' }
      },
      { needs: Boolean(shot) },
    )
  const paid = await step(
    flow,
    'Right PIN -> payment done',
    async () => {
      await pinTry(PIN)
      const until = Date.now() + 6000
      while (shop.state.paid === before.paid && Date.now() < until) await sleep(200)
      if (shop.state.paid === before.paid) throw new Error('The shop server did not receive the payment')
    },
    { needs: Boolean(shot) },
  )

  // 6. End: order complete page + order number
  const doneOk = await step(
    flow,
    'The order tab goes to the order complete page -> order number',
    async () => {
      const r = await pollRead(tabId, /주문이 완료되었어요/, 8000)
      if (!r.includes(`주문번호 ${ORDER_NO}`)) throw new Error('The order number is not visible')
      return { note: `order number ${r.match(/주문번호 (\d+)/)?.[1]}` }
    },
    { needs: paid },
  )
  if (popup)
    await step(
      flow,
      'The payment window closed itself',
      async () => {
        await sleep(800)
        const still = await call('snapshot', { tabId: pgTab }).then(
          () => true,
          () => false,
        )
        if (still) throw new Error('The payment window tab is still open')
      },
      { needs: paid },
    )
  await step(
    flow,
    'Report order completion with the tool -> no longer paying',
    async () => {
      const [tool, args] = PLANNED.orderDone(tabId)
      await run(tool, args)
      if (tools.isPaying(tabId)) throw new Error('Still left as a paying tab')
    },
    { needs: doneOk },
  )
  await step(
    flow,
    'Shop server: one prepare and one payment (no double payment)',
    async () => {
      const prepares = shop.state.prepares - before.prepares
      const got = shop.state.paid - before.paid
      if (prepares !== 1 || got !== 1) throw new Error(`${prepares} prepares, ${got} payments`)
    },
    { needs: pressed },
  )
  if (!doneOk) {
    const shot2 = await call('screenshot', { tabId }).catch(() => undefined)
    if (shot2?.data)
      writeFileSync(join(out, `e2e-pay-${flow.id}-last.jpg`), Buffer.from(shot2.data, 'base64'))
    writeFileSync(join(out, `e2e-pay-${flow.id}-last.txt`), await read(tabId).catch((e) => String(e)))
  }
  // Clean up for the next flow
  for (const t of [pgTab, tabId]) if (t) await call('close', { tabId: t }).catch(() => {})
  tools.donePaying?.(tabId)
}

let crashed = false
try {
  for (let i = 0; i < 150 && !daemon.browser.status.connected; i++) await sleep(200)
  if (!daemon.browser.status.connected)
    throw new Error('The extension did not attach to the daemon within 30s')
  for (const flow of FLOWS) await runFlow(flow)
} catch (e) {
  crashed = true
  console.log(`✗ Cannot continue the test: ${e.message}`)
} finally {
  chrome.kill()
  await daemon.close()
  await shop.close()
  await sleep(500)
  rmSync(tmp, { recursive: true, force: true })
}

// ── Result table ──
const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '/')
    .slice(0, 160)
const table = [
  '| flow | # | step | result | ms | reason |',
  '|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.flow} | ${r.n} | ${cell(r.name)} | ${r.status} | ${r.ms} | ${cell(r.why)} |`),
].join('\n')
const count = (s) => results.filter((r) => r.status === s).length
const summary = `passed ${count('passed')} · failed ${count('failed')} · skipped ${count('skipped')}`
console.log(`\nPayment flow test result (${summary})\n${table}`)
writeFileSync(join(out, 'e2e-pay-result.txt'), `${summary}\n${table}\n`)
writeFileSync(join(out, 'e2e-pay-result.json'), JSON.stringify(results, null, 2))
const failed = crashed || count('failed') > 0 || count('skipped') > 0
console.log(failed ? 'failed' : 'all passed')
process.exit(failed && process.env.DOOL2_E2E_PAY !== 'report' ? 1 : 0)
