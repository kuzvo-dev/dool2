import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserTools } from './browser-tools.js'
import { RouteBook, routeStart, stepNameOk } from './routes.js'

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
    expect(text(r)).toContain('Took the remembered route [r1] (2 clicks')
    expect(text(r)).toContain('주문 2건')
    expect(b.calls.filter((c) => c === 'click')).toHaveLength(2)
    expect(tools.routes?.get('r1')?.uses).toBe(1)
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
})
