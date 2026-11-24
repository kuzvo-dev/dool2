import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConnectorSchema, checkConnector } from '@dool2/protocol/connector'
import { describe, expect, it } from 'vitest'
import { cleanStart, idForHost, qualifies, routeDrafts } from './route-drafts.js'
import type { Route } from './routes.js'

const FIXTURE = join(import.meta.dirname, '..', 'scripts', 'fixtures', 'routes.json')
const routes = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { routes: Route[] }).routes
const cards = [{ id: 'demo-eats', site: 'eats.example', tools: ['route_1', 'search'] }]
const drafts = () => routeDrafts(routes, cards, '2026-11-25')
const byId = (id: string) => drafts().drafts.find((d) => d.id === id)

describe('connector drafts from remembered routes (ADR 0034 follow-up)', () => {
  it('keeps only routes that reached their page 3+ times in 80%+ of walks', () => {
    const byRoute = (id: string) => routes.find((r) => r.id === id) as Route
    expect(qualifies(byRoute('r1'))).toBe(true)
    expect(qualifies(byRoute('r2'))).toBe(false) // 2 successes
    expect(qualifies(byRoute('r3'))).toBe(true) // older file without counts: one walk by hand + 3 route walks
    expect(qualifies(byRoute('r4'))).toBe(false) // 4 of 7
    expect(qualifies(byRoute('r7'))).toBe(true) // 8 of 9
    const r = drafts()
    expect(r.total).toBe(7)
    expect(r.drafts.flatMap((d) => d.routes)).toHaveLength(4)
    expect(r.skipped.map((s) => s.route.split(' ')[0])).toEqual(['[r6]', '[r4]', '[r2]'])
    expect(r.skipped.find((s) => s.route.startsWith('[r6]'))?.why).toContain('email')
  })

  it('writes lookup tools that walk the same clicks and hand the page over, and the shape passes the check', () => {
    const d = byId('shop')
    expect(d?.existing).toBe(false)
    expect(d?.sites).toEqual(['shop.example'])
    expect(d?.problems).toEqual([])
    const tool = d?.file.tools[0]
    expect(tool).toMatchObject({ name: 'route_1', tier: 'lookup', login: false, title: '주문목록' })
    expect(tool?.steps[0]).toEqual({ open: 'https://shop.example/' })
    expect(tool?.steps.filter((s) => 'click' in s)).toEqual([
      { click: { text: '마이페이지' } },
      { click: { text: '주문목록' } },
    ])
    expect(tool?.steps.at(-1)).toHaveProperty('handoff_to_agent')
    for (const x of drafts().drafts) {
      expect(x.file.tools.every((t) => t.tier === 'lookup')).toBe(true)
      const { _draft, ...connector } = x.file
      expect(checkConnector(x.id, connector, x.sites)).toEqual([])
    }
  })

  it('cannot be registered by accident: the _draft block fails the connector schema', () => {
    for (const x of drafts().drafts) {
      expect(Object.keys(x.file)[0]).toBe('_draft')
      expect(ConnectorSchema.safeParse(x.file).success).toBe(false)
      expect(checkConnector(x.id, x.file, x.sites).join(' ')).toContain('_draft')
    }
  })

  it('leaves out query strings, id-like address parts and page titles, and says so', () => {
    const books = byId('example')
    expect(books?.file.tools[0]?.steps[0]).toEqual({ open: 'https://www.books.example.co.kr/my/' })
    expect(books?.routes[0]?.stripped.join('; ')).toMatch(/query string.*# in the start.*id-like/)
    const text = JSON.stringify(drafts().drafts.map((d) => d.file))
    expect(text).not.toContain('ab12cd34ef56gh78')
    expect(text).not.toContain('user=kim')
    expect(text).not.toContain('김둘이')
    const coupons = byId('shop')?.routes.find((r) => r.successes === 4)
    expect(coupons?.stripped).toContain('page title (it can hold a name)')
  })

  it('adds to an existing service without clashing with its tool names', () => {
    const d = byId('demo-eats')
    expect(d?.existing).toBe(true)
    expect(d?.file.tools.map((t) => t.name)).toEqual(['route_2'])
    expect(d?.routes[0]).toMatchObject({ successes: 8, failures: 1 })
  })

  it('cleans start addresses and names new services after the domain', () => {
    expect(cleanStart('https://a.example/orders/2026112400/list').open).toBe('https://a.example/orders/')
    expect(cleanStart('https://a.example/u/me%40mail.example/').open).toBe('https://a.example/u/')
    expect(cleanStart('https://a.example/help/faq')).toEqual({
      open: 'https://a.example/help/faq',
      stripped: [],
    })
    expect(cleanStart('http://a.example/').open).toBeUndefined()
    expect(idForHost('www.shop-example.co.kr')).toBe('shop-example')
    expect(idForHost('m.store.example')).toBe('store')
    expect(idForHost('example.com')).toBe('example')
  })
})
