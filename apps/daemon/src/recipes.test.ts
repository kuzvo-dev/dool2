import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  alike,
  foldSteps,
  MIN_OK,
  RecipeBook,
  RequestSteps,
  recipeView,
  signature,
  stepOf,
  worthKeeping,
} from './recipes.js'

const coupang = (q = '쿠팡 주문 언제 와?') => {
  const r = new RequestSteps(() => 1000)
  r.begin('t1', q)
  r.tool('t1', 'mcp__dool2__service_find', { query: '쿠팡 주문' })
  r.result('t1', 'service_find', true)
  r.tool('t1', 'mcp__dool2__service_call', { tool: 'coupang_orders', input: { days: 30 } })
  r.result('t1', 'service_call', true)
  r.tool('t1', 'mcp__dool2__show_cards', { cards: [{ title: 'x' }] })
  r.result('t1', 'show_cards', true)
  return r.end('t1')!
}

describe('recipe steps', () => {
  it('keeps the service tool a service_call called, and skips looking tools up', () => {
    const req = coupang()
    expect(req.tools).toBe(3)
    expect(req.steps).toEqual([
      { tool: 'coupang_orders', via: 'service_call', input: { days: 30 } },
      { tool: 'show_cards' },
    ])
  })

  it('never keeps messages, secrets or numbers that look like a phone or card', () => {
    expect(stepOf('kakao_send', { to: '엄마', text: '오늘 늦어' })).toEqual({ tool: 'kakao_send' })
    expect(stepOf('x_search', { query: '01012345678', q: 'a@b.com', date: '2026-12-01' })).toEqual({
      tool: 'x_search',
      input: { date: '2026-12-01' },
    })
    expect(stepOf('x_search', { query: 'x'.repeat(41) })).toEqual({ tool: 'x_search' })
  })

  it('keeps the site of an open, not its query or member numbers, and only the kind of a click', () => {
    expect(stepOf('browser_open', { url: 'https://www.coupang.com/np/search?q=휴지' })).toEqual({
      tool: 'browser_open',
      at: 'www.coupang.com/np/search',
    })
    expect(stepOf('browser_open', { url: 'https://shop.example/member/1234567' })).toEqual({
      tool: 'browser_open',
      at: 'shop.example',
    })
    expect(stepOf('browser_click', { tabId: 3, ref: 'e12' })).toEqual({ tool: 'browser_click' })
    expect(stepOf('browser_route', { tabId: 3, route: 'r3' })).toEqual({
      tool: 'browser_route',
      input: { route: 'r3' },
    })
  })

  it('drops failed calls from the steps', () => {
    const r = new RequestSteps()
    r.begin('t', 'x')
    r.tool('t', 'service_call', { tool: 'a_search', input: {} })
    r.result('t', 'service_call', false)
    r.tool('t', 'service_call', { tool: 'b_search', input: {} })
    r.result('t', 'service_call', true)
    expect(r.end('t')?.steps.map((s) => s.tool)).toEqual(['b_search'])
  })

  it('folds repeats, keeps only the last answer shape, and keys on tools and sites', () => {
    const steps = foldSteps([
      { tool: 'browser_open', at: 'a.com/x' },
      { tool: 'browser_click' },
      { tool: 'browser_click' },
      { tool: 'show_list' },
      { tool: 'browser_click' },
      { tool: 'show_cards' },
    ])
    expect(steps).toEqual([
      { tool: 'browser_open', at: 'a.com/x' },
      { tool: 'browser_click', times: 2 },
      { tool: 'browser_click' },
      { tool: 'show_cards' },
    ])
    expect(signature(steps)).toBe('browser_open@a.com>browser_click>browser_click>show_cards')
  })

  it('is worth keeping with two steps or a tool the AI looked up, not a lone direct tool', () => {
    expect(worthKeeping([{ tool: 'orders_all' }, { tool: 'show_cards' }])).toBe(false)
    expect(worthKeeping([{ tool: 'a_orders', via: 'service_call' }])).toBe(true)
    expect(worthKeeping([{ tool: 'browser_open' }, { tool: 'browser_click' }])).toBe(true)
  })
})

describe('alike', () => {
  it('reads Korean requests about the same thing as alike, others not', () => {
    expect(alike('쿠팡 주문 언제 와?', '쿠팡 택배 언제 와')).toBeGreaterThan(0.34)
    expect(alike('쿠팡 주문 언제 와?', '내일 서울 날씨')).toBe(0)
  })
})

describe('RecipeBook', () => {
  it('offers steps only after they got a request done twice, then on a request like it', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'dool2-recipes-')), 'recipes.json')
    const book = new RecipeBook(file)
    const first = coupang()
    expect(book.record(first.ask, first.steps)?.before).toBe(0)
    expect(book.match('쿠팡 택배 언제 와')).toEqual([])
    const again = coupang('쿠팡에서 산 거 언제 와')
    const kept = book.record(again.ask, again.steps)
    expect(kept?.before).toBe(1)
    expect(kept?.recipe.ok).toBe(MIN_OK)
    const found = book.match('쿠팡 택배 언제 와')
    expect(found.map((r) => r.id)).toEqual([kept?.recipe.id])
    expect(book.match('내일 서울 날씨')).toEqual([])
    const hint = book.hint(found) ?? ''
    expect(hint).toContain('service_call coupang_orders {"days":30} → show_cards')
    expect(hint).toContain('done 2 times')
    // Kept on the PC and read back
    const saved = JSON.parse(await readFile(file, 'utf8')) as { recipes: unknown[] }
    expect(saved.recipes).toHaveLength(1)
    expect(new RecipeBook(file).match('쿠팡 택배 언제 와')).toHaveLength(1)
  })

  it('forgets a recipe that fails more than it works', () => {
    const book = new RecipeBook()
    const a = coupang()
    const id = book.record(a.ask, a.steps)!.recipe.id
    book.record(a.ask, a.steps)
    expect(book.failed(id)).toBe(false)
    expect(book.failed(id)).toBe(false)
    expect(book.failed(id)).toBe(true)
    expect(book.get(id)).toBeUndefined()
  })

  it('counts a failing step of an offered recipe once per request', () => {
    const book = new RecipeBook()
    const a = coupang()
    const id = book.record(a.ask, a.steps)!.recipe.id
    const r = new RequestSteps()
    r.begin('t', '쿠팡 주문', [id])
    r.tool('t', 'service_call', { tool: 'coupang_orders', input: {} })
    expect(r.result('t', 'service_call', false, book)).toEqual([id])
    r.tool('t', 'service_call', { tool: 'coupang_orders', input: {} })
    expect(r.result('t', 'service_call', false, book)).toEqual([])
  })
})

describe('recipeView', () => {
  it('shows the services and sites people know, not tool names', () => {
    const v = recipeView(
      {
        id: 'k1',
        steps: [
          { tool: 'coupang_orders', via: 'service_call' },
          { tool: 'browser_open', at: 'www.apti.co.kr/apti' },
          { tool: 'browser_click', times: 2 },
          { tool: 'show_cards' },
        ],
        asks: ['쿠팡에서 산 거 언제 와'],
        ok: 3,
        fails: 0,
        offered: 1,
        followed: 1,
        lastAt: '2026-11-26T00:00:00.000Z',
      },
      (t) => (t === 'coupang_orders' ? '쿠팡' : undefined),
    )
    expect(v).toEqual({
      id: 'k1',
      ask: '쿠팡에서 산 거 언제 와',
      steps: ['쿠팡', 'apti.co.kr'],
      ok: 3,
      lastAt: '2026-11-26T00:00:00.000Z',
    })
  })
})
