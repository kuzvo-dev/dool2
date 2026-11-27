import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserTools } from './browser-tools.js'
import { type Route, RouteBook, readStep, routeCounts, routeStart, stepNameOk, typedStep } from './routes.js'

/** A shop: home → [마이페이지] opens a menu on the same page → [주문목록] moves to the orders page */
function shop() {
  let url = 'https://shop.example/'
  let menu = false
  let gone = false
  const calls: string[] = []
  const page = () => {
    if (url.endsWith('/orders')) return { title: '주문목록', text: '# 주문목록\n주문 2건\n[e9 링크 "홈"]' }
    const lines = ['# 홈', '[e1 링크 "마이페이지"]', '[e2 링크 "고객센터"]']
    if (menu && !gone) lines.push('[e3 링크 "주문목록"]')
    return { title: '홈', text: lines.join('\n') }
  }
  const byName = (name: string) =>
    [...page().text.matchAll(/\[(e\d+) 링크 "([^"]+)"\]/g)].find((m) => m[2] === name)
  return {
    calls,
    removeOrders: () => {
      gone = true
    },
    call: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd)
      if (cmd === 'open' || cmd === 'navigate') {
        url = String(args?.url ?? 'https://shop.example/')
        menu = false
        return { tabId: 3 }
      }
      if (cmd === 'snapshot') return { tabId: 3, url, ...page(), truncated: false, captcha: false }
      if (cmd === 'mark-text') {
        const m = byName(String(args?.text))
        if (!m) throw new Error(`"${String(args?.text)}" is not on the page`)
        return { ref: m[1], name: m[2] }
      }
      if (cmd === 'click') {
        const name = [...page().text.matchAll(/\[(e\d+) 링크 "([^"]+)"\]/g)].find(
          (m) => m[1] === args?.ref,
        )?.[2]
        if (name === '마이페이지') menu = true
        if (name === '주문목록') url = 'https://shop.example/orders'
        if (name === '홈') url = 'https://shop.example/'
        return { tabId: 3, url }
      }
      return { tabId: 3 }
    },
  }
}

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('\n')

const setup = async () => {
  const b = shop()
  const tools = new BrowserTools(b as never)
  const file = join(await mkdtemp(join(tmpdir(), 'dool2-routes-')), 'routes.json')
  tools.routes = new RouteBook(file)
  tools.routePause = () => 0
  return { b, tools, file }
}

describe('기억한 길 (ADR 0034)', { timeout: 30_000 }, () => {
  it('메뉴를 열고 링크로 넘어간 클릭들을 길로 기억하고, 다음에 그 사이트를 열면 알려 준다', async () => {
    const { tools, file } = await setup()
    await tools.run('open', { url: 'https://shop.example/' })
    await tools.run('click', { tabId: 3, text: '마이페이지' })
    await tools.run('click', { tabId: 3, ref: 'e3' })
    const saved = JSON.parse(await readFile(file, 'utf8')) as { routes: { steps: string[]; title: string }[] }
    expect(saved.routes).toMatchObject([
      { start: 'https://shop.example/', steps: ['마이페이지', '주문목록'], title: '주문목록' },
    ])
    const again = await tools.run('open', { url: 'https://shop.example/' })
    expect(text(again)).toContain("[r1] 주문목록: '마이페이지' → '주문목록'")
  })

  it('기억한 길은 AI 없이 같은 클릭을 해서 마지막 화면을 돌려준다', async () => {
    const { b, tools } = await setup()
    await tools.run('open', { url: 'https://shop.example/' })
    await tools.run('click', { tabId: 3, text: '마이페이지' })
    await tools.run('click', { tabId: 3, ref: 'e3' })
    await tools.run('click', { tabId: 3, ref: 'e9' })
    b.calls.length = 0
    const r = await tools.run('route', { tabId: 3, route: 'r1' })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('Took the remembered route [r1] (2 steps')
    expect(text(r)).toContain('주문 2건')
    expect(b.calls.filter((c) => c === 'click')).toHaveLength(2)
    expect(tools.routes?.get('r1')?.uses).toBe(1)
    // The clicks of a route walk are not counted again as a walk by hand
    expect(tools.routes?.get('r1')?.seen).toBe(1)
  })

  it('같은 클릭을 손으로 다시 하면 본 횟수를 센다', async () => {
    const { tools } = await setup()
    for (let i = 0; i < 2; i++) {
      await tools.run('open', { url: 'https://shop.example/' })
      await tools.run('click', { tabId: 3, text: '마이페이지' })
      await tools.run('click', { tabId: 3, ref: 'e3' })
    }
    expect(tools.routes?.get('r1')).toMatchObject({ uses: 0, seen: 2 })
  })

  it('사이트가 바뀌어 링크가 없으면 그 자리에서 멈추고 화면을 주며, 그 길은 지운다', async () => {
    const { b, tools } = await setup()
    await tools.run('open', { url: 'https://shop.example/' })
    await tools.run('click', { tabId: 3, text: '마이페이지' })
    await tools.run('click', { tabId: 3, ref: 'e3' })
    b.removeOrders()
    await tools.run('navigate', { tabId: 3, url: 'https://shop.example/' })
    const r = await tools.run('route', { tabId: 3, route: 'r1' })
    expect(text(r)).toContain("stopped at step 2 ('주문목록')")
    expect(text(r)).toContain('Carry on yourself')
    expect(tools.routes?.get('r1')).toBeUndefined()
  })

  it('글자를 넣은 뒤의 클릭은 길로 기억하지 않는다 (입력한 내용에 달린 화면)', async () => {
    const { tools } = await setup()
    await tools.run('open', { url: 'https://shop.example/' })
    await tools.run('type', { tabId: 3, ref: 'e2', text: '내 주소' })
    await tools.run('click', { tabId: 3, text: '마이페이지' })
    await tools.run('click', { tabId: 3, ref: 'e3' })
    expect(tools.routes?.forHost('shop.example')).toEqual([])
  })

  it('없는 길은 알려 준다', async () => {
    const { tools } = await setup()
    await tools.run('open', { url: 'https://shop.example/' })
    const r = await tools.run('route', { tabId: 3, route: 'r7' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('There is no remembered route r7')
  })
})

/** A shop with a search box: home → type in [상품 검색] + Enter → results → [낮은 가격순] sorts them */
function searchShop() {
  let url = 'https://find.example/'
  const typed: string[] = []
  const page = () => {
    if (url.includes('/search')) {
      const q = new URL(url).searchParams.get('q') ?? ''
      return { title: `${q} 검색`, text: `# ${q} 결과 3건\n[e7 링크 "낮은 가격순"]` }
    }
    return { title: '홈', text: '# 홈\n[e1 검색칸 "상품 검색"]\n[e2 링크 "마이페이지"]' }
  }
  return {
    typed,
    call: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'open' || cmd === 'navigate') {
        url = String(args?.url ?? 'https://find.example/')
        return { tabId: 5 }
      }
      if (cmd === 'snapshot') return { tabId: 5, url, ...page(), truncated: false, captcha: false }
      if (cmd === 'type') {
        typed.push(String(args?.text))
        if (args?.submit) url = `https://find.example/search?q=${encodeURIComponent(String(args?.text))}`
        return { tabId: 5, url }
      }
      if (cmd === 'mark-text') {
        if (!page().text.includes(`"${String(args?.text)}"`)) throw new Error('not on the page')
        return { ref: 'e7', name: String(args?.text) }
      }
      if (cmd === 'click') {
        if (args?.ref === 'e7') url = `${url}&sort=low`
        return { tabId: 5, url }
      }
      return { tabId: 5 }
    },
  }
}

describe('길에 입력 칸 (ADR 0044)', { timeout: 30_000 }, () => {
  it('검색칸에 넣은 말은 남기지 않고 칸 이름만 남겨, 다음엔 이번 검색어로 같은 길을 간다', async () => {
    const b = searchShop()
    const tools = new BrowserTools(b as never)
    const file = join(await mkdtemp(join(tmpdir(), 'dool2-routes-')), 'routes.json')
    tools.routes = new RouteBook(file)
    tools.routePause = () => 0
    await tools.run('open', { url: 'https://find.example/' })
    await tools.run('type', { tabId: 5, ref: 'e1', text: '울 코트', submit: true })
    await tools.run('click', { tabId: 5, ref: 'e7' })
    const saved = await readFile(file, 'utf8')
    expect(saved).not.toContain('울 코트')
    expect(tools.routes.get('r1')?.steps).toEqual([typedStep('상품 검색', true), '낮은 가격순'])
    const again = await tools.run('open', { url: 'https://find.example/' })
    expect(text(again)).toContain(
      "[r1] … 검색: type in '상품 검색' + Enter → '낮은 가격순' (inputs: '상품 검색')",
    )
    // Without this time's words the walk does not start
    const none = await tools.run('route', { tabId: 5, route: 'r1' })
    expect(none.isError).toBe(true)
    expect(text(none)).toContain("types into '상품 검색'")
    const r = await tools.run('route', { tabId: 5, route: 'r1', inputs: ['패딩'] })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('Took the remembered route [r1] (2 steps')
    expect(text(r)).toContain('패딩 결과 3건')
    expect(b.typed).toEqual(['울 코트', '패딩'])
    expect(readStep(typedStep('상품 검색', false))).toEqual({
      kind: 'type',
      field: '상품 검색',
      submit: false,
    })
  })

  it('긴 글을 쓴 걸음과 글자만 넣은 걸음은 길이 아니다', async () => {
    const book = new RouteBook()
    expect(
      book.record({
        start: 'https://a.example/',
        steps: [typedStep('검색', true), typedStep('지역', false)],
        title: '',
      }),
    ).toBeUndefined()
    const b = searchShop()
    const tools = new BrowserTools(b as never)
    tools.routes = book
    await tools.run('open', { url: 'https://find.example/' })
    await tools.run('type', { tabId: 5, ref: 'e1', text: 'x'.repeat(101), submit: true })
    await tools.run('click', { tabId: 5, ref: 'e7' })
    expect(book.forHost('find.example')).toEqual([])
  })
})

describe('길 책', () => {
  it('메뉴 이름만 남기고, 숫자·주소·메일은 남기지 않는다', () => {
    expect(stepNameOk('주문목록')).toBe(true)
    expect(stepNameOk('주문번호 20261124-000123')).toBe(false)
    expect(stepNameOk('me@example.com')).toBe(false)
    expect(stepNameOk('https://x')).toBe(false)
    expect(routeStart('https://shop.example/search?q=내 이름#a')).toBe('https://shop.example/search')
    expect(routeStart('chrome://settings')).toBeUndefined()
    expect(routeStart('https://shop.example/member/2026112400/orders')).toBeUndefined()
  })

  it('같은 길은 하나로, 사이트마다 6개까지 남기고 파일에서 다시 읽는다', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'dool2-routes-')), 'routes.json')
    let t = 0
    const book = new RouteBook(file, () => new Date(1_000_000 + t++ * 1000))
    for (let i = 0; i < 8; i++)
      book.record({ start: 'https://a.example/', steps: ['메뉴', `칸${i}`], title: `${i}` })
    book.record({ start: 'https://a.example/', steps: ['메뉴', '칸7'], title: '7' })
    expect(book.forHost('a.example')).toHaveLength(6)
    expect(book.record({ start: 'https://a.example/', steps: ['하나'], title: '' })).toBeUndefined()
    const reread = new RouteBook(file)
    expect(reread.forHost('a.example').map((r) => r.title)).toContain('7')
    expect(reread.forHost('a.example').map((r) => r.title)).not.toContain('0')
  })

  it('성공·실패 횟수를 남기고, 횟수가 없는 예전 파일도 읽는다', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'dool2-routes-')), 'routes.json')
    const old = { id: 'r4', host: 'a.example', start: 'https://a.example/', steps: ['메뉴', '주문'] }
    await writeFile(file, JSON.stringify({ routes: [{ ...old, title: '주문', uses: 3, lastAt: 'x' }] }))
    const book = new RouteBook(file, () => new Date(0))
    const r = book.get('r4') as Route
    expect(routeCounts(r)).toEqual({ ok: 4, failed: 0 })
    book.used('r4')
    book.failed('r4')
    book.record({ start: 'https://a.example/', steps: ['메뉴', '주문'], title: '주문' })
    const saved = JSON.parse(await readFile(file, 'utf8')) as { routes: Route[] }
    expect(saved.routes[0]).toMatchObject({ uses: 4, fails: 1, seen: 2, lastAt: '1970-01-01T00:00:00.000Z' })
    expect(routeCounts(saved.routes[0] as Route)).toEqual({ ok: 6, failed: 1 })
    // A new route starts with one walk by hand, and none when it was made by the clicks of a route walk
    book.record({ start: 'https://a.example/', steps: ['메뉴', '쿠폰'], title: '쿠폰' })
    book.record({ start: 'https://a.example/', steps: ['메뉴', '찜'], title: '찜' }, false)
    expect(book.forHost('a.example').map((x) => [x.title, x.seen])).toEqual([
      ['주문', 2],
      ['쿠폰', 1],
      ['찜', 0],
    ])
  })
})
