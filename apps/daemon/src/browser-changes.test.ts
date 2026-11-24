// Clicks and typing give only what changed on the page (the AI asks browser_read for the whole page)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserTools, SEEN_TTL_MS } from './browser-tools.js'

const page = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'pages', `${name}.txt`), 'utf8').trimEnd()
const ITEM = 'https://shop.example/item/1'

/** A browser whose page changes on each click or typing as the test says */
function shop(next: Record<string, { text: string; url?: string }> = {}) {
  let cur = { url: ITEM, text: page('product') }
  const calls: string[] = []
  return {
    calls,
    set(text: string, url = cur.url) {
      cur = { url, text }
    },
    call: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd)
      if (cmd === 'open') return { tabId: 3 }
      if (cmd === 'snapshot')
        return { tabId: 3, url: cur.url, title: '두리마켓', text: cur.text, truncated: false, captcha: false }
      const key = `${cmd}:${String(args?.ref ?? '')}`
      if (next[key]) cur = { url: next[key].url ?? cur.url, text: next[key].text }
      return { tabId: 3, url: cur.url }
    },
  }
}

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('\n')
const ai = { ai: true }

afterEach(() => {
  vi.useRealTimers()
})

describe('results after clicks and typing', () => {
  it('a click that opens a list gives the title, address and only the new lines', async () => {
    const b = shop({ 'click:e15': { text: page('product-options-open') } })
    const tools = new BrowserTools(b)
    const opened = await tools.run('open', { url: ITEM }, ai)
    expect(text(opened)).toContain('[e20 버튼 "장바구니 담기"]')
    const r = await tools.run('click', { tabId: 3, ref: 'e15' }, ai)
    const out = text(r)
    expect(out).toContain('Pressed 선택 상자 "색상을 선택해 주세요".')
    expect(out).toContain(`[탭 3] 두리마켓 — ${ITEM}`)
    expect(out).toContain('(Only what changed since the last read: 5 new or changed lines of')
    expect(out).toContain('browser_read shows the whole page.')
    expect(out).toContain('[e200 선택지 "미드나잇 블랙"]')
    expect(out).not.toContain('[e20 버튼 "장바구니 담기"]')
    // Refs of the new lines can be used right away (the daemon read the whole page)
    const chose = await tools.run('click', { tabId: 3, ref: 'e200' }, ai)
    expect(chose.isError).toBeFalsy()
  })

  it('typing gives the suggestions that appeared', async () => {
    const b = shop({ 'type:e2': { text: page('product-search-typed') } })
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 }, ai)
    const out = text(await tools.run('type', { tabId: 3, ref: 'e2', text: '무선 청소' }, ai))
    expect(out).toContain('Typed in "검색어 입력".')
    expect(out).toContain('[e208 링크 "무선 청소기 추천"]')
    expect(out).not.toContain('## 리뷰')
  })

  it('a click that changes nothing says so in one line', async () => {
    const tools = new BrowserTools(shop())
    await tools.run('read', { tabId: 3 }, ai)
    const out = text(await tools.run('click', { tabId: 3, ref: 'e22' }, ai))
    expect(out).toContain(
      '(The page text did not change since the last read. browser_read shows the whole page.)',
    )
    expect(out).not.toContain('## 옵션 선택')
  })

  it('moving to another address gives the whole page', async () => {
    const b = shop({ 'click:e6': { text: page('cart'), url: 'https://shop.example/cart' } })
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 }, ai)
    const out = text(await tools.run('click', { tabId: 3, ref: 'e6' }, ai))
    expect(out).toContain('# 장바구니 (1)')
    expect(out).not.toContain('Only what changed')
  })

  it('changes are counted from the last page the AI saw, not from reads inside Dool2', async () => {
    const b = shop({
      'click:e15': { text: page('product-options-open') },
      'click:e200': { text: page('product-option-chosen') },
    })
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 }, ai)
    // A service tool step clicks inside Dool2: its result is not given to the AI as it is
    const inside = await tools.run('click', { tabId: 3, ref: 'e15' })
    expect(text(inside)).toContain('[e20 버튼 "장바구니 담기"]')
    const out = text(await tools.run('click', { tabId: 3, ref: 'e200' }, ai))
    // Against the page the AI saw (before the list opened): the chosen option and the new total
    expect(out).toContain('총 상품 금액 279,000원')
    expect(out).not.toContain('[e201 옵션')
  })

  it('a whole read after the click becomes the new base', async () => {
    const b = shop({
      'click:e15': { text: page('product-options-open') },
      'click:e22': { text: page('product-options-open') },
    })
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 }, ai)
    await tools.run('click', { tabId: 3, ref: 'e15' }, ai)
    const again = text(await tools.run('click', { tabId: 3, ref: 'e22' }, ai))
    expect(again).toContain('did not change since the last read')
    // browser_read always gives the whole page
    expect(text(await tools.run('read', { tabId: 3 }, ai))).toContain('[e20 버튼 "장바구니 담기"]')
  })

  it('a part read (view) does not change the base', async () => {
    const b = shop()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 }, ai)
    b.set(page('product-options-open'))
    await tools.run('read', { tabId: 3, view: true }, ai)
    const out = text(await tools.run('click', { tabId: 3, ref: 'e22' }, ai))
    expect(out).toContain('[e200 선택지 "미드나잇 블랙"]')
  })

  it('a new turn, an old read or a closed tab gives the whole page again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const tools = new BrowserTools(shop())
    const whole = async () =>
      !text(await tools.run('click', { tabId: 3, ref: 'e22' }, ai)).includes('did not change')
    await tools.run('read', { tabId: 3 }, ai)
    expect(await whole()).toBe(false)
    tools.forgetSeen()
    expect(await whole()).toBe(true)
    expect(await whole()).toBe(false)
    vi.setSystemTime(Date.now() + SEEN_TTL_MS + 1)
    expect(await whole()).toBe(true)
    expect(await whole()).toBe(false)
    // A closed tab: a read inside Dool2 gives the refs back, but the AI has not seen the page
    tools.forgetTab(3)
    await tools.run('read', { tabId: 3 })
    expect(await whole()).toBe(true)
  })

  it('notes about the screen still come with only the changes (checkout screen in a payment flow)', async () => {
    const pay = `${page('cart')}\n[e407 버튼 "결제하기"]`
    const b = shop({ 'click:e403': { text: pay.replace('수량 빼기"] 1', '수량 빼기"] 2') } })
    b.set(pay, 'https://shop.example/order/checkout')
    const tools = new BrowserTools(b)
    tools.startPayFlow(3, 'shop_buy')
    await tools.run('read', { tabId: 3 }, ai)
    const out = text(await tools.run('click', { tabId: 3, ref: 'e403' }, ai))
    expect(out).toContain('Only what changed')
    expect(out).toContain('This is a checkout screen')
  })

  it('switched off, clicks give the whole page', async () => {
    const b = shop({ 'click:e15': { text: page('product-options-open') } })
    const tools = new BrowserTools(b)
    tools.changesOnly = false
    await tools.run('read', { tabId: 3 }, ai)
    const out = text(await tools.run('click', { tabId: 3, ref: 'e15' }, ai))
    expect(out).toContain('[e20 버튼 "장바구니 담기"]')
    expect(out).not.toContain('Only what changed')
  })

  it('the same click with no change gives the same result (the loop check can see repeats)', async () => {
    const tools = new BrowserTools(shop())
    await tools.run('read', { tabId: 3 }, ai)
    const a = text(await tools.run('click', { tabId: 3, ref: 'e22' }, ai))
    const b = text(await tools.run('click', { tabId: 3, ref: 'e22' }, ai))
    expect(a).toBe(b)
  })
})
