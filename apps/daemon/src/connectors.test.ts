import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkConnectCard } from '@dool2/protocol/connect'
import { checkConnector } from '@dool2/protocol/connector'
import { describe, expect, it } from 'vitest'
import { BrowserTools } from './browser-tools.js'
import { ConnectorHealth } from './connector-health.js'
import { Connectors, thinPage } from './connectors.js'
import { TASK_HINT, withTaskHint } from './tasks.js'

const REPO_SKILLS = fileURLToPath(new URL('../../../skills', import.meta.url))

describe('레포의 서비스 도구', () => {
  it('모든 tools.json이 형식과 안전 규칙을 지킨다', async () => {
    for (const d of await readdir(REPO_SKILLS, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('_')) continue
      const raw = await readFile(join(REPO_SKILLS, d.name, 'tools.json'), 'utf8').catch(() => undefined)
      if (!raw) continue
      const card = JSON.parse(await readFile(join(REPO_SKILLS, d.name, 'connect.json'), 'utf8'))
      expect(checkConnectCard(d.name, card), d.name).toEqual([])
      expect(
        checkConnector(
          d.name,
          JSON.parse(raw),
          [card.site, ...(card.alsoSites ?? [])].filter(Boolean),
          card.category,
        ),
        d.name,
      ).toEqual([])
    }
  })
})

const CARD = {
  id: 'demo-eats',
  name: '데모맛집',
  site: 'eats.example',
  category: 'tickets',
  how: 'browser',
  login: '아이디·비밀번호',
  summary: '데모맛집을 연결하면 식당 찾기부터 예약까지 두리에게 맡길 수 있어요.',
  example: { ask: '성수 저녁 4명', working: '빈자리 찾는 중', reply: '가게 가에 7시 자리가 있어요.' },
  abilities: [
    { title: '식당 찾기', say: '성수 저녁 4명', tier: 'lookup' },
    { title: '예약', say: '거기 7시로 잡아 줘', tier: 'pay' },
  ],
}

const CONNECTOR = {
  id: 'demo-eats',
  tools: [
    {
      name: 'search',
      title: '식당 찾기',
      description: '지역·가게 이름으로 식당과 날짜별 빈자리를 찾는다. 가게 이름·별점·빈 시간을 돌려준다.',
      tier: 'lookup',
      status: '검증됨(2026-11-17)',
      input: {
        properties: {
          keyword: { type: 'string', description: '지역이나 가게 이름 (예: 성수)' },
          date: { type: 'string', format: 'date', description: '날짜 YYYY-MM-DD' },
        },
        required: ['keyword'],
      },
      output: {
        shops: {
          type: 'list',
          description: '가게',
          fields: { name: { type: 'string' }, rating: { type: 'number' }, times: { type: 'strings' } },
        },
      },
      examples: [{ keyword: '성수' }],
      steps: [
        { open: 'https://eats.example/search?q={{keyword|url}}&d={{date|yymmdd}}' },
        { wait: { items: 'li.shop', timeoutMs: 500 } },
        {
          extract: {
            items: 'li.shop',
            fields: {
              name: { css: 'b' },
              rating: { css: 'p', match: '(\\d\\.\\d)' },
              times: { css: 'em', list: true },
            },
          },
          as: 'shops',
        },
      ],
      result: { shops: '{{shops}}' },
      next: '예약하려면 demo_eats_book을 불러요.',
      minIntervalSec: 300,
    },
    {
      name: 'book',
      title: '예약',
      description: '고른 가게의 시간을 골라 예약 직전까지 간 뒤 사용자 승인을 받는다.',
      tier: 'pay',
      login: true,
      status: '초안',
      input: {
        properties: {
          shop: { type: 'string', description: '가게 이름' },
          time: { type: 'string', format: 'time', description: '시간 HH:MM' },
        },
        required: ['shop', 'time'],
      },
      output: {},
      examples: [{ shop: '가게 가', time: '19:00' }],
      steps: [
        { open: 'https://eats.example/shop?name={{shop|url}}' },
        { click: { text: '{{time|ampm}}' } },
        { approve: { text: '예약하기', what: '{{shop}} {{time}} 예약', where: '데모맛집' } },
      ],
      result: {},
    },
    {
      name: 'peek',
      title: '나쁜 도구',
      description: '찾아보기인데 위험한 버튼을 누르려는 도구 (시험용).',
      tier: 'lookup',
      status: '초안',
      input: { properties: {}, required: [] },
      output: {},
      examples: [{}],
      steps: [{ open: 'https://eats.example/' }, { click: { text: '바로 구매' } }],
      result: {},
    },
  ],
}

const PAGE = '[e1 버튼 "오후 7:00"] [e2 버튼 "예약하기"] [e3 버튼 "바로 구매"]'

async function setup(
  opts: {
    connected?: boolean
    rows?: Record<string, unknown>[]
    health?: ConnectorHealth
    gapMs?: number
    /** find가 찾았다고 할 패턴 이름 (막힘 화면 등) */
    found?: Record<string, string>
    /** 화면에 로봇 확인이 떠 있다고 할지 */
    captcha?: boolean
    /** 로그인 없이 쓰는 서비스로 (how: open) */
    open?: boolean
    /** 이 사용자가 요즘 쓴 도구 */
    recent?: string[]
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'dool2-conn-'))
  await mkdir(join(dir, 'demo-eats'))
  await writeFile(
    join(dir, 'demo-eats', 'connect.json'),
    JSON.stringify(opts.open ? { ...CARD, how: 'open' } : CARD),
  )
  await writeFile(join(dir, 'demo-eats', 'tools.json'), JSON.stringify(CONNECTOR))
  const calls: [string, Record<string, unknown> | undefined][] = []
  let url = 'https://eats.example/'
  const browser = {
    call: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args])
      if (cmd === 'open' || cmd === 'navigate') {
        url = String(args?.url)
        return { tabId: 7 }
      }
      if (cmd === 'snapshot')
        return { tabId: 7, url, title: '데모', text: PAGE, truncated: false, captcha: Boolean(opts.captcha) }
      if (cmd === 'extract')
        return {
          ok: true,
          rows: opts.rows ?? [{ name: '가게 가', rating: '4.5 (12)', times: ['오후 7:00'] }],
          total: 1,
          url,
        }
      if (cmd === 'find') return { url, title: '', found: opts.found ?? {} }
      if (cmd === 'capture')
        return { url: 'https://eats.example/api/list', status: 200, json: [{ n: '가게 다' }] }
      if (cmd === 'mark-text') return { ok: true, ref: 'e9', name: String(args?.text) }
      if (cmd === 'screenshot') return { data: 'AAAA', mime: 'image/jpeg', url, title: '' }
      return { tabId: 7 }
    },
  }
  const tools = new BrowserTools(browser)
  const connectors = new Connectors({
    dir,
    browser,
    tools,
    connected: () => (opts.connected ? { 'demo-eats': '2026-11-17T00:00:00Z' } : {}),
    pollMs: 1,
    gapMs: opts.gapMs ?? 0,
    ...(opts.health ? { health: opts.health } : {}),
    ...(opts.recent ? { recentTools: () => new Set(opts.recent) } : {}),
  })
  return { connectors, calls, tools, dir }
}

const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('\n')

describe('서비스 도구 실행기', () => {
  it('정해진 순서로 열고 목록을 뽑아 글과 구조화된 결과로 돌려준다', async () => {
    const { connectors, calls } = await setup()
    const r = await connectors.call('demo_eats_search', { keyword: '성수 맛집', date: '2026-11-27' })
    expect(r.isError).toBeUndefined()
    expect(calls[0]).toEqual([
      'open',
      { url: 'https://eats.example/search?q=%EC%84%B1%EC%88%98%20%EB%A7%9B%EC%A7%91&d=261127' },
    ])
    expect(r.structuredContent).toEqual({ shops: [{ name: '가게 가', rating: 4.5, times: ['오후 7:00'] }] })
    expect(textOf(r)).toContain('1. name: 가게 가 · rating: 4.5 · times: 오후 7:00')
    expect(textOf(r)).toContain('예약하려면 demo_eats_book')
    expect(textOf(r)).toContain('[Tab 7]')
    // The same lines go apart as hint (the tool server puts them in the structured result, which the AI reads)
    expect(r.hint).toMatch(/^Checked at: /)
    expect(r.hint).toContain('예약하려면 demo_eats_book')
    expect(r.hint).toContain('[Tab 7]')
    expect(r.hint).not.toContain('가게 가')
  })

  it('내 주문 모아 보기: 주문 도구가 있는 연결한 쇼핑몰이 없으면 연결 카드를 권한다', async () => {
    const { connectors, calls } = await setup({ connected: true })
    const r = await connectors.ordersAll()
    expect(textOf(r)).toContain('No shop is connected')
    expect(calls).toEqual([])
  })

  it('같은 입력은 정한 간격 안에 다시 사이트에 묻지 않는다', async () => {
    const { connectors, calls } = await setup()
    await connectors.call('demo_eats_search', { keyword: '성수' })
    const n = calls.length
    const r = await connectors.call('demo_eats_search', { keyword: '성수' })
    expect(calls.length).toBe(n)
    expect(textOf(r)).toContain(' min ago (')
  })

  it('입력이 틀리면 실행하지 않고 무엇을 고칠지 알려 준다', async () => {
    const { connectors, calls } = await setup()
    const r = await connectors.call('demo_eats_search', { date: '11월 27일' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/keyword is required.*date must be written as YYYY-MM-DD/)
    expect(calls).toEqual([])
  })

  it('목록이 안 나오면 막힌 단계와 탭을 알려 브라우저 도구로 잇게 한다', async () => {
    const { connectors } = await setup({ rows: [] })
    const r = await connectors.call('demo_eats_search', { keyword: '성수' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/step 2 \(wait\).*\[Tab 7\].*browser_read/)
    expect(connectors.breakages[0]).toMatchObject({ tool: 'demo_eats_search', step: 2, kind: 'wait' })
  })

  it('연결이 필요한 도구는 연결 전이면 실행 대신 연결 안내', async () => {
    const { connectors, calls } = await setup()
    const r = await connectors.call('demo_eats_book', { shop: '가게 가', time: '19:00' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain("connect_ask('demo-eats')")
    expect(calls).toEqual([])
  })

  it('돈 내기 도구는 마지막 버튼을 누르지 않고 승인 요청으로 끝낸다', async () => {
    const { connectors, calls, tools } = await setup({ connected: true })
    const r = await connectors.call('demo_eats_book', { shop: '가게 가', time: '19:00' })
    expect(textOf(r)).toContain('Asked for approval')
    // 시간 버튼은 눌렀고(오후 7:00), 예약하기는 누르지 않았다
    const clicks = calls.filter((c) => c[0] === 'click')
    expect(clicks).toHaveLength(1)
    const pending = tools.approvals.list()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      label: '예약하기',
      kind: 'money',
      what: '가게 가 19:00 예약',
      where: '데모맛집',
    })
  })

  it('찾아보기 도구도 위험한 버튼은 못 누른다 (승인 게이트 그대로)', async () => {
    const { connectors, calls } = await setup()
    await expect(connectors.catalog()).resolves.toEqual([])
    const r = await connectors.call('demo_eats_peek', {})
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/^승인이 필요해요: .*"구매"/)
    expect(calls.some((c) => c[0] === 'click')).toBe(false)
  })

  it('바로 보이는 도구는 연결한 서비스의 것만, 등급으로 MCP 힌트를 단다', async () => {
    const off = await setup()
    expect(await off.connectors.catalog()).toEqual([])
    const on = await setup({ connected: true })
    const cat = await on.connectors.catalog()
    expect(cat.map((t) => t.name)).toEqual(['demo_eats_search', 'demo_eats_book', 'demo_eats_peek'])
    expect(cat[0]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    })
    expect(cat[1]?.annotations.destructiveHint).toBe(true)
    expect(cat[0]?.description).toContain('Input examples: {"keyword":"성수"}')
  })

  it('로그인 없이 쓰는 서비스는 요즘 쓴 도구만 바로 보이고, 나머지도 service_call로 그대로 부른다', async () => {
    const fresh = await setup({ open: true, recent: [] })
    expect(await fresh.connectors.catalog()).toEqual([])
    expect((await fresh.connectors.call('demo_eats_search', { keyword: '성수' })).isError).toBeUndefined()
    const used = await setup({ open: true, recent: ['demo_eats_search', 'gmail_search'] })
    expect((await used.connectors.catalog()).map((t) => t.name)).toEqual(['demo_eats_search'])
    // 기록을 모르면 예전처럼 다 보인다
    const all = await setup({ open: true })
    expect((await all.connectors.catalog()).length).toBeGreaterThan(1)
  })

  it('keeps the first tool list of a segment for the rest of it (ADR 0032)', async () => {
    const recent = ['demo_eats_search']
    const { connectors } = await setup({ open: true, recent })
    const names = async (toolset: string) => (await connectors.catalogFor(toolset)).map((t) => t.name)
    expect(await names('seg-1')).toEqual(['demo_eats_search'])
    // A tool used for the first time would join the list: not in this segment, only in the next one
    recent.push('demo_eats_peek')
    expect(await names('seg-1')).toEqual(['demo_eats_search'])
    expect(await names('seg-2')).toEqual(['demo_eats_search', 'demo_eats_peek'])
    // Without a segment, the current list
    expect((await connectors.catalogFor('')).map((t) => t.name)).toEqual([
      'demo_eats_search',
      'demo_eats_peek',
    ])
  })

  it('does not keep an empty list, so a segment that starts before anything is ready still gets its tools', async () => {
    const recent: string[] = []
    const { connectors } = await setup({ open: true, recent })
    expect(await connectors.catalogFor('seg-1')).toEqual([])
    recent.push('demo_eats_search')
    expect((await connectors.catalogFor('seg-1')).map((t) => t.name)).toEqual(['demo_eats_search'])
  })

  it('서비스 찾기는 도구·등급·입력 칸과 연결하면 되는 일을 알려 준다', async () => {
    const { connectors } = await setup()
    const r = textOf(await connectors.find('성수 식당'))
    expect(r).toContain('## 데모맛집 (demo-eats) — not connected')
    expect(r).toContain(
      '- demo_eats_search [lookup · no login] 식당 찾기 — input: keyword*(지역이나 가게 이름), date(날짜 YYYY-MM-DD)',
    )
    expect(r).toContain(
      "After connecting: 예약. When you reach that step, call connect_ask('demo-eats'): connecting on that card is the person's step",
    )
  })

  it('finding a service gives the best match in full and the others in one line each', async () => {
    const { connectors, dir } = await setup()
    await mkdir(join(dir, 'demo-bar'))
    await writeFile(
      join(dir, 'demo-bar', 'connect.json'),
      JSON.stringify({
        ...CARD,
        id: 'demo-bar',
        name: '데모술집',
        site: 'bar.example',
        summary: '성수 술집을 찾고 자리를 잡아 줘요.',
      }),
    )
    await writeFile(join(dir, 'demo-bar', 'tools.json'), JSON.stringify({ ...CONNECTOR, id: 'demo-bar' }))
    const r = textOf(await connectors.find('데모맛집 성수 식당'))
    expect(r).toContain('## 데모맛집 (demo-eats) — not connected')
    expect(r).toContain('- demo_eats_search [lookup · no login] 식당 찾기 — input: keyword*')
    expect(r).toContain(
      'Other matches:\n- 데모술집 (demo-bar) — not connected: demo_bar_search (식당 찾기), ',
    )
    expect(r).not.toContain('demo_bar_search [lookup')
    expect(r).toContain('call service_find with the tool name to get its input fields')
    // A second call with a tool name gives that tool's input fields
    const one = textOf(await connectors.find('demo_bar_search'))
    expect(one).toContain('## 데모술집 (demo-bar) — not connected')
    expect(one).toContain('- demo_bar_search [lookup · no login] 식당 찾기 — input: keyword*')
    expect(one).not.toContain('demo_bar_book')
  })

  it('no matching service points at the browser, which the conversation of task sessions turns into a task', async () => {
    const { connectors } = await setup()
    const r = await connectors.find('zzqq weather')
    expect(textOf(r)).toContain('No matching service. Look it up on the web instead: browser_open')
    // There is no web-search tool: the result must not send the AI looking for one
    expect(textOf(r)).not.toMatch(/web search/i)
    expect(textOf(withTaskHint(r))).toContain(TASK_HINT)
  })

  it('a long list gives 10 rows, says how many more, and the next rows come from what was read', async () => {
    const rows = Array.from({ length: 23 }, (_, i) => ({ name: `가게 ${i + 1}`, rating: '4.0', times: [] }))
    const { connectors, calls } = await setup({ rows })
    const first = await connectors.call('demo_eats_search', { keyword: '성수' })
    const shops = (first.structuredContent as { shops: { name: string }[] }).shops
    expect(shops.map((x) => x.name)).toEqual(rows.slice(0, 10).map((x) => x.name))
    expect(first.hint).toContain('shops: rows 1–10 of 23 shown')
    expect(first.hint).toContain(
      "service_call({ tool: 'demo_eats_search', input: { …the same input, offset: 10 } })",
    )
    expect(textOf(first)).toContain('가게 (10)')
    const opened = calls.filter(([c]) => c === 'open').length
    const next = await connectors.call('demo_eats_search', { keyword: '성수', offset: 20 })
    expect((next.structuredContent as { shops: { name: string }[] }).shops.map((x) => x.name)).toEqual([
      '가게 21',
      '가게 22',
      '가게 23',
    ])
    expect(next.hint).toContain('shops: rows 21–23 of 23 shown')
    // Not asked again: the rows come from the list read a moment ago
    expect(calls.filter(([c]) => c === 'open').length).toBe(opened)
    // A short list says nothing about more rows
    const { connectors: few } = await setup()
    expect((await few.call('demo_eats_search', { keyword: '성수' })).hint).not.toContain('rows 1–')
  })

  it('주소로 그 사이트의 도구를 찾는다 (브라우저로 열었을 때 도구를 쓰라고)', async () => {
    const { connectors } = await setup()
    expect(await connectors.forUrl('https://m.eats.example/x')).toEqual({
      id: 'demo-eats',
      name: '데모맛집',
      tools: ['demo_eats_search', 'demo_eats_book', 'demo_eats_peek'],
    })
    expect(await connectors.forUrl('https://other.example/')).toBeUndefined()
  })

  it('목록 거르기(입력이 비면 그대로)와 여러 묶음 펼치기', async () => {
    const { connectors } = await setup()
    const c = connectors as unknown as {
      step: (s: unknown, c: unknown) => Promise<unknown>
    }
    const scope: Record<string, unknown> = {
      groups: [{ items: [{ n: 'a', p: 10 }] }, { items: [{ n: 'b', p: 40 }] }],
      max: '30',
    }
    const ctx = {
      scope,
      tier: 'lookup',
      site: 'eats.example',
      pollMs: 1,
      sleep: async () => {},
      read: async () => '',
      need: () => 7,
      open: async () => {},
    }
    await c.step({ map: { from: 'groups.*.items', fields: { name: 'n', price: 'p' } }, as: 'rows' }, ctx)
    expect(scope.rows).toEqual([
      { name: 'a', price: 10 },
      { name: 'b', price: 40 },
    ])
    await c.step({ filter: { from: 'rows', where: 'price', op: 'lte', value: '{{max}}' }, as: 'cheap' }, ctx)
    expect(scope.cheap).toEqual([{ name: 'a', price: 10 }])
    scope.max = ''
    await c.step({ filter: { from: 'rows', where: 'price', op: 'lte', value: '{{max}}' }, as: 'all' }, ctx)
    expect(scope.all).toHaveLength(2)
  })

  it('capture는 주소를 열 때 응답 듣기를 켜고, 페이지가 받은 응답만 읽는다', async () => {
    const { connectors, calls } = await setup()
    const c = connectors as unknown as {
      execute: (card: unknown, tool: unknown, args: unknown) => Promise<{ structuredContent?: unknown }>
    }
    const card = { ...CARD }
    const tool = {
      ...CONNECTOR.tools[0],
      steps: [
        { open: 'https://eats.example/search?q={{keyword|url}}' },
        { capture: { url: 'api/list', pick: 'data' }, as: 'raw' },
        { map: { from: 'raw', fields: { name: 'n' } }, as: 'shops' },
      ],
      output: { shops: { type: 'list', fields: { name: { type: 'string' } } } },
    }
    const r = await c.execute(card, tool, { keyword: '성수' })
    expect(calls[0]).toEqual([
      'open',
      { url: 'https://eats.example/search?q=%EC%84%B1%EC%88%98', capture: true },
    ])
    expect(calls[1]?.[0]).toBe('capture')
    expect(calls.some((x) => x[0] === 'fetch')).toBe(false)
    expect(r.structuredContent).toEqual({ shops: [{ name: '가게 다' }] })
  })

  it('칸이 비어 오면 조용한 고장으로 알리고 기록하며, 잇달아 깨지면 도구를 쉬게 한다', async () => {
    const health = new ConnectorHealth()
    const { connectors } = await setup({
      health,
      connected: true,
      rows: [{ name: null, rating: null }, { name: null }],
    })
    const raw = JSON.parse(JSON.stringify(CONNECTOR))
    raw.tools[0].expect = { filled: ['name'] }
    const c = connectors as unknown as {
      cache?: unknown
      load: () => Promise<Map<string, { connector: unknown }>>
    }
    ;(await c.load()).get('demo-eats')!.connector = raw
    const r = await connectors.call('demo_eats_search', { keyword: '성수' })
    expect(textOf(r)).toContain('Result fields are empty: shops.name is filled in only 0 of 2 rows')
    expect(health.summary().demo_eats_search?.last).toBe('empty')
    await connectors.call('demo_eats_search', { keyword: '한남' })
    await connectors.call('demo_eats_search', { keyword: '강남' })
    expect((await connectors.catalog()).map((t) => t.name)).not.toContain('demo_eats_search')
    const rest = await connectors.call('demo_eats_search', { keyword: '홍대' })
    expect(textOf(rest)).toMatch(/is resting.*browser tools/)
  })

  it('예전 확장(커넥터 엔진 없음)이면 서비스 도구를 내보이지 않고 브라우저로 하라고 한다', async () => {
    const { connectors: on } = await setup({ connected: true })
    ;(on as unknown as { opts: { extensionVersion: () => string } }).opts.extensionVersion = () => '0.1.0'
    expect(await on.catalog()).toEqual([])
    const r = await on.call('demo_eats_search', { keyword: '성수' })
    expect(textOf(r)).toMatch(/old version \(0\.1\.0\).*browser tools/)
  })

  it('같은 서비스는 한 번에 하나씩, 사이를 두고 연다 (한 탭을 동시에 옮기면 사이트가 막는다)', async () => {
    const { connectors, calls } = await setup({ gapMs: 40 })
    const stamps: [string, number][] = []
    const orig = calls.push.bind(calls)
    calls.push = (...items) => {
      for (const it of items) stamps.push([it[0], Date.now()])
      return orig(...items)
    }
    const [a, b] = await Promise.all([
      connectors.call('demo_eats_search', { keyword: '성수' }),
      connectors.call('demo_eats_search', { keyword: '한남' }),
    ])
    expect(a.isError).toBeUndefined()
    expect(b.isError).toBeUndefined()
    // 두 번째 주소 열기는 첫 부름이 목록을 다 뽑은 뒤, 간격을 두고
    const opens = stamps.filter(([c]) => c === 'open' || c === 'navigate')
    const extracts = stamps.filter(([c]) => c === 'extract')
    expect(opens).toHaveLength(2)
    expect(opens[1][1]).toBeGreaterThanOrEqual(extracts[1][1] + 35)
    expect(calls.findIndex((c) => c[0] === 'navigate')).toBeGreaterThan(
      calls.findIndex((c, i) => c[0] === 'extract' && i > 1),
    )
  })

  it('사이트가 막은 화면이면 막힘으로 멈추고, 곧바로 다시 부르지 말라고 한다', async () => {
    const health = new ConnectorHealth()
    const dir = await mkdtemp(join(tmpdir(), 'dool2-conn-'))
    await mkdir(join(dir, 'demo-eats'))
    await writeFile(join(dir, 'demo-eats', 'connect.json'), JSON.stringify(CARD))
    const tool = CONNECTOR.tools[0]
    const blocked = {
      ...CONNECTOR,
      tools: [
        {
          ...tool,
          steps: [
            tool.steps[0],
            { stop_if: '사용권한이 없', say: '데모맛집이 이 브라우저를 막았어요.', blocked: true },
            ...tool.steps.slice(1),
          ],
        },
      ],
    }
    await writeFile(join(dir, 'demo-eats', 'tools.json'), JSON.stringify(blocked))
    const browser = {
      call: async (cmd: string) =>
        cmd === 'find' ? { url: '', title: '', found: { hit: '사용권한이 없' } } : { tabId: 7 },
    }
    const connectors = new Connectors({
      dir,
      browser,
      tools: new BrowserTools(browser),
      connected: () => ({}),
      pollMs: 1,
      gapMs: 0,
      health,
    })
    const r = await connectors.call('demo_eats_search', { keyword: '성수' })
    expect(r.structuredContent).toEqual({ stopped: '데모맛집이 이 브라우저를 막았어요.', blocked: true })
    expect(textOf(r)).toContain('Do not call it again right away')
    expect(health.summary()).toMatchObject({ demo_eats_search: { last: 'blocked' } })
  })

  it('막은 화면이 로봇 확인이면 막다른 길 대신 탭을 열어 두고 폰 카드로 풀어 다시 부르게 한다', async () => {
    const health = new ConnectorHealth()
    const dir = await mkdtemp(join(tmpdir(), 'dool2-conn-'))
    await mkdir(join(dir, 'demo-eats'))
    await writeFile(join(dir, 'demo-eats', 'connect.json'), JSON.stringify(CARD))
    const tool = CONNECTOR.tools[0]
    const blocked = {
      ...CONNECTOR,
      tools: [
        {
          ...tool,
          steps: [
            tool.steps[0],
            {
              stop_if: '보안 확인을 완료해 주세요',
              say: '데모맛집이 보안 확인을 하고 있어요. 다른 곳에서 찾을게요.',
              blocked: true,
            },
            ...tool.steps.slice(1),
          ],
        },
      ],
    }
    await writeFile(join(dir, 'demo-eats', 'tools.json'), JSON.stringify(blocked))
    const calls: string[] = []
    const browser = {
      call: async (cmd: string) => {
        calls.push(cmd)
        return cmd === 'find'
          ? { url: '', title: '', found: { hit: '보안 확인을 완료해 주세요' } }
          : { tabId: 7 }
      },
    }
    const connectors = new Connectors({
      dir,
      browser,
      tools: new BrowserTools(browser),
      connected: () => ({}),
      pollMs: 1,
      gapMs: 0,
      health,
    })
    const r = await connectors.call('demo_eats_search', { keyword: '성수' })
    expect(r.structuredContent).toMatchObject({ blocked: true, captcha: true, tabId: 7 })
    const t = textOf(r)
    expect(t).toContain('[Tab 7]')
    expect(t).toContain('browser_request_code(kind: "captcha")')
    expect(t).toContain('browser_request_tap')
    expect(t).toContain('call demo_eats_search again with the same input')
    expect(t).not.toContain('다른 곳에서 찾을게요')
    expect(calls).not.toContain('close')
    // 로봇 확인은 고장이 아니다: 쉬게 하지 않는다
    expect(health.summary()).toMatchObject({ demo_eats_search: { last: 'blocked' } })
  })

  it('긴 화면 끝에 붙은 창의 선택 상자는 한 번 길게 다시 읽어 찾는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dool2-conn-'))
    await mkdir(join(dir, 'demo-eats'))
    await writeFile(join(dir, 'demo-eats', 'connect.json'), JSON.stringify(CARD))
    const tool = CONNECTOR.tools[0]
    await writeFile(
      join(dir, 'demo-eats', 'tools.json'),
      JSON.stringify({
        ...CONNECTOR,
        tools: [
          {
            ...tool,
            steps: [
              tool.steps[0],
              { choose: { field: '^전국$', option: '서울' } },
              { type: { field: '검색어를 입력', text: '강남' } },
              ...tool.steps.slice(1),
            ],
          },
        ],
      }),
    )
    const calls: [string, Record<string, unknown> | undefined][] = []
    const browser = {
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args])
        if (cmd === 'snapshot') {
          // 보통 길이로 읽으면 창이 잘려 안 보이고, 길게 읽어야 보인다
          const long = Number(args?.maxChars) >= 60_000
          const body = `${PAGE}\n데모맛집 성수점 오늘의 빈자리 안내`
          const text = long ? `${body}\n[e20 선택 상자 "전국"] [e21 입력칸 "검색어를 입력해 주세요."]` : body
          return { tabId: 7, url: 'https://eats.example/', title: '', text, truncated: !long, captcha: false }
        }
        if (cmd === 'options') return { options: [{ label: '서울특별시', selected: false }] }
        if (cmd === 'extract') return { ok: true, rows: [{ name: '가게 가' }], total: 1, url: '' }
        if (cmd === 'find') return { url: '', title: '', found: {} }
        return { tabId: 7 }
      },
    }
    const connectors = new Connectors({
      dir,
      browser,
      tools: new BrowserTools(browser),
      connected: () => ({}),
      pollMs: 1,
      gapMs: 0,
    })
    const r = await connectors.call('demo_eats_search', { keyword: '성수' })
    expect(textOf(r)).not.toContain('찾지 못했어요')
    expect(calls).toContainEqual(['choose', { tabId: 7, ref: 'e20', label: '서울특별시' }])
    expect(calls.find(([c]) => c === 'type')?.[1]).toMatchObject({ ref: 'e21', text: '강남' })
  })

  it('단계가 깨졌는데 화면에 로봇 확인이 떠 있으면 고장 대신 폰 카드로 풀게 한다', async () => {
    const health = new ConnectorHealth()
    const { connectors } = await setup({ rows: [], health, captcha: true })
    const r = await connectors.call('demo_eats_search', { keyword: '성수' })
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent).toMatchObject({ captcha: true, tabId: 7 })
    expect(connectors.breakages).toEqual([])
    expect(health.summary()).toMatchObject({ demo_eats_search: { last: 'blocked' } })
  })
})

describe('쿠팡 주문 찾기 (여러 기간을 한 번에)', () => {
  // 쿠팡 주문목록 화면이 담아 보내는 데이터(__NEXT_DATA__) 흉내: 주소의 keyword·requestYear대로 고른다
  const ORDERS = [
    { at: '2026-11-10', names: ['생수 2L 12개', '라면 5개'] },
    { at: '2025-03-02', names: ['베개 커버 2장', '수건'] },
    { at: '2023-07-01', names: ['생수 2L 6개'] },
  ]
  async function coupang() {
    const opened: string[] = []
    let url = ''
    const page = () => {
      const u = new URL(url)
      const kw = u.searchParams.get('keyword') ?? ''
      const year = u.searchParams.get('requestYear')
      const pageIndex = Number(u.searchParams.get('pageIndex') ?? 0)
      const list = ORDERS.filter((o) => (year ? o.at.startsWith(year) : o.at >= '2026-05-19')).filter(
        (o) => !kw || o.names.some((n) => n.includes(kw)),
      )
      return {
        props: {
          pageProps: {
            domains: {
              desktopOrder: {
                orderPagination: { hasPrev: pageIndex > 0, hasNext: false },
                orderList: list.map((o, i) => ({
                  orderId: Number(o.at.replace(/-/g, '')) * 10 + i,
                  orderedAt: Date.parse(`${o.at}T12:00:00+09:00`),
                  deliveryGroupList: [
                    {
                      groupStatus: { status: 'FINAL_DELIVERY' },
                      pddMessage: { message: '도착' },
                      deliveredDate: Date.parse(`${o.at}T20:00:00+09:00`),
                      selfService: { returnableDay: 30 },
                      productList: o.names.map((n, j) => ({
                        vendorItemName: n,
                        productId: j + 1,
                        itemId: j + 1,
                        vendorItemId: j + 1,
                        quantity: 1,
                        discountedUnitPrice: 1000 * (j + 1),
                        imagePath: `https://img.example/${j}.jpg`,
                        searchMatchingProduct: !kw || n.includes(kw),
                      })),
                    },
                  ],
                })),
              },
            },
          },
        },
      }
    }
    const browser = {
      call: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'open' || cmd === 'navigate') {
          url = String(args?.url)
          opened.push(url)
          return { tabId: 7 }
        }
        if (cmd === 'find') return { url, title: '', found: { text: '주문목록' } }
        if (cmd === 'extract') return { ok: true, rows: [{ t: JSON.stringify(page()) }], total: 1, url }
        return { tabId: 7 }
      },
    }
    const connectors = new Connectors({
      dir: REPO_SKILLS,
      browser,
      tools: new BrowserTools(browser),
      connected: () => ({ coupang: '2026-11-17T00:00:00Z' }),
      now: () => new Date('2026-11-19T03:00:00Z'),
      pollMs: 1,
      gapMs: 0,
    })
    return { connectors, opened }
  }
  type Found = {
    orders: { ordered: string; items: string[]; prices: number[]; delivered: string }[]
    searched: string
    tip: string | null
  }

  it('최근 6개월에 없으면 올해·지난해로 차례로 찾고, 찾은 해에서 멈춘다', async () => {
    const { connectors, opened } = await coupang()
    const r = await connectors.call('coupang_orders', { item: '베개' })
    const s = r.structuredContent as Found
    expect(opened.map((u) => new URL(u).searchParams.get('requestYear'))).toEqual([null, '2026', '2025'])
    expect(s.orders).toHaveLength(1)
    // 검색어에 맞은 상품만 (같은 주문의 수건은 빼고)
    expect(s.orders[0]).toMatchObject({ ordered: '2025-03-02', items: ['베개 커버 2장'], prices: ['1000'] })
    expect(s.orders[0]?.delivered).toBe('2025-03-02')
    expect(s.searched).toBe('최근 6개월(page 0), 2026년, 2025년')
    expect(s.tip ?? '').toBe('')
  })

  it('all이면 멈추지 않고 올해부터 6년 전까지 모은다', async () => {
    const { connectors, opened } = await coupang()
    const r = await connectors.call('coupang_orders', { item: '생수', all: true })
    const s = r.structuredContent as Found
    expect(opened.map((u) => new URL(u).searchParams.get('requestYear'))).toEqual([
      '2026',
      '2025',
      '2024',
      '2023',
      '2022',
      '2021',
    ])
    expect(s.orders.map((o) => o.ordered)).toEqual(['2026-11-10', '2023-07-01'])
    expect(s.orders[0]?.items).toEqual(['생수 2L 12개'])
    expect(s.searched).toBe('2026년, 2025년, 2024년, 2023년, 2022년, 2021년')
  })

  it('해를 주면 그 해만 한 번, 다 찾아도 없으면 다음 길을 알려 준다', async () => {
    const { connectors, opened } = await coupang()
    const one = await connectors.call('coupang_orders', { item: '베개', year: 2025 })
    expect(opened).toHaveLength(1)
    expect((one.structuredContent as Found).searched).toBe('2025년(page 0)')
    const none = await connectors.call('coupang_orders', { item: '키보드' })
    const s = none.structuredContent as Found
    expect(opened).toHaveLength(1 + 7)
    expect(s.orders).toEqual([])
    expect(s.searched).toBe('최근 6개월(page 0), 2026년, 2025년, 2024년, 2023년, 2022년, 2021년')
    expect(s.tip).toContain('한 번만 더')
  })

  it('낱말 없이 부르면 최근 주문 한 쪽만', async () => {
    const { connectors, opened } = await coupang()
    const r = await connectors.call('coupang_orders', {})
    expect(opened).toHaveLength(1)
    expect((r.structuredContent as Found).searched).toBe('최근 주문(page 0)')
    expect((r.structuredContent as Found).orders[0]?.items).toEqual(['생수 2L 12개', '라면 5개'])
  })
})

describe('넘기기 전 화면이 그려졌는지', () => {
  it('머리줄만 있거나 누를 것이 거의 없으면 덜 그려진 화면이다', () => {
    expect(thinPage('[탭 1] Gmail — https://mail.google.com/\n\n로딩 중')).toBe(true)
    const full = `[탭 1] 받은편지함\n${Array.from({ length: 10 }, (_, i) => `[e${i} 링크 "메일 제목 ${i}번째 줄이에요"]`).join('\n')}`
    expect(thinPage(full)).toBe(false)
  })
})

describe('도구 주소 칸은 내 정보 주소로', () => {
  it('비었거나 "내 주소"면 본체가 채우고, 직접 넣은 주소는 그대로 둔다', async () => {
    const { Connectors } = await import('./connectors.js')
    const c = new Connectors({
      homeAddress: async () => '경기 용인시 수지구 신봉동 905',
    } as never) as unknown as {
      fillHome: (t: unknown, a: Record<string, unknown>) => Promise<void>
    }
    const tool = {
      input: {
        properties: {
          address: { type: 'string', description: '주소' },
          shop: { type: 'string', description: '가게' },
        },
        required: ['address'],
      },
    }
    const a: Record<string, unknown> = {}
    await c.fillHome(tool, a)
    expect(a.address).toBe('경기 용인시 수지구 신봉동 905')
    const b: Record<string, unknown> = { address: '내 주소' }
    await c.fillHome(tool, b)
    expect(b.address).toBe('경기 용인시 수지구 신봉동 905')
    const d: Record<string, unknown> = { address: '성수동1가 656' }
    await c.fillHome(tool, d)
    expect(d.address).toBe('성수동1가 656')
  })
})

describe('찾은 뒤 바로 주문 준비로 오면 한 줄 붙인다 (판단은 AI)', () => {
  it('찾아보기 다음 사용자 말 없이 돈 내기 도구를 부르면 막지 않고, 고를지·진행할지를 AI가 정하게 알린다', async () => {
    const { Connectors } = await import('./connectors.js')
    let user = { at: Date.now() - 10_000, text: '저녁 배달 시켜 줘' }
    const c = new Connectors({ lastUser: () => user } as never) as unknown as {
      pickGate: (id: string, t: { tier: string }) => string | undefined
    }
    expect(c.pickGate('food', { tier: 'lookup' })).toBeUndefined()
    const note = c.pickGate('food', { tier: 'pay' })
    expect(note).toContain('show_cards')
    expect(note).toContain('If they already picked')
    user = { at: Date.now() + 1, text: '두 번째 걸로' }
    expect(c.pickGate('food', { tier: 'pay' })).toBeUndefined()
    // "알아서"는 정규식으로 가리지 않는다: 같은 안내가 붙고 AI가 대화를 보고 진행한다
    c.pickGate('food', { tier: 'lookup' })
    user = { at: Date.now() - 5, text: '알아서 골라서 바로 시켜 줘' }
    expect(c.pickGate('food', { tier: 'pay' })).toContain('decide for them')
  })

  it('같은 동네 이름인데 내 번지가 없으면 짐작한 주소라 내 정보 주소로 바꾼다', async () => {
    const { Connectors } = await import('./connectors.js')
    const c = new Connectors({
      homeAddress: async () => '경기 용인시 수지구 신봉1로 27',
    } as never) as unknown as {
      fillHome: (t: unknown, a: Record<string, unknown>) => Promise<void>
    }
    const tool = {
      input: { properties: { address: { type: 'string', description: '주소' } }, required: ['address'] },
    }
    const a: Record<string, unknown> = { address: '신봉동 33' }
    await c.fillHome(tool, a)
    expect(a.address).toBe('경기 용인시 수지구 신봉1로 27')
    const b: Record<string, unknown> = { address: '서울 성동구 성수동1가 656' }
    await c.fillHome(tool, b)
    expect(b.address).toBe('서울 성동구 성수동1가 656')
  })
})
