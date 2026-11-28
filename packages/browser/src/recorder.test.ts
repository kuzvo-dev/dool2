import { draftSkill } from '@dool2/skill-learn'
import { parseSkillMarkdown } from '@dool2/skill-sdk'
import { describe, expect, it } from 'vitest'
import { SessionRecorder } from './recorder.js'

// A secret the page would send on an internal API call. The recorder must NEVER store its value.
const COOKIE_VALUE = 'session=SHOULD_NOT_APPEAR_abcdefghijklmnop'
const BEARER_VALUE = 'Bearer SHOULD_NOT_APPEAR_tokenvalue'

/** Build a fake `Network.requestWillBeSent` params object. */
function reqParams(
  requestId: string,
  method: string,
  url: string,
  headers?: Record<string, string>,
  type?: string,
): Record<string, unknown> {
  return { requestId, request: { method, url, ...(headers ? { headers } : {}) }, ...(type ? { type } : {}) }
}

/** Build a fake `Network.responseReceived` params object. */
function resParams(
  requestId: string,
  status: number,
  mimeType: string,
  type: string,
): Record<string, unknown> {
  return { requestId, type, response: { status, mimeType } }
}

/** Feed a request+response pair for one resource into the recorder. */
function feed(
  rec: SessionRecorder,
  args: {
    id: string
    method?: string
    url: string
    headers?: Record<string, string>
    status?: number
    mime?: string
    type: string
    /** when true, the resourceType is only known on the response (as the browser often reports it) */
    typeOnResponseOnly?: boolean
  },
): void {
  const method = args.method ?? 'GET'
  rec.onCdpEvent(
    'Network.requestWillBeSent',
    reqParams(args.id, method, args.url, args.headers, args.typeOnResponseOnly ? undefined : args.type),
  )
  rec.onCdpEvent(
    'Network.responseReceived',
    resParams(args.id, args.status ?? 200, args.mime ?? 'application/json', args.type),
  )
}

describe('SessionRecorder: capturing the internal API off CDP Network events', () => {
  function recorded(): SessionRecorder {
    const rec = new SessionRecorder({ url: 'https://order.coupang.com/order/list' })
    // The internal API: same-site XHR/Fetch — kept.
    feed(rec, {
      id: '1',
      method: 'GET',
      url: 'https://order.coupang.com/api/v1/orders?page=1&access_token=SEKRET',
      headers: {
        Cookie: COOKIE_VALUE,
        Authorization: BEARER_VALUE,
        'X-Coupang-Target': 'orders',
        'Content-Type': 'application/json',
      },
      type: 'XHR',
    })
    feed(rec, {
      id: '2',
      method: 'POST',
      url: 'https://order.coupang.com/api/v1/orders/cancel',
      headers: { 'X-Coupang-Target': 'orders' },
      type: 'Fetch',
    })
    // A same path again with a different query → de-duplicated by method+path.
    feed(rec, { id: '3', method: 'GET', url: 'https://order.coupang.com/api/v1/orders?page=2', type: 'XHR' })
    // Equivalent subdomain of the same site → still kept (same base domain).
    feed(rec, { id: '4', method: 'GET', url: 'https://mc.coupang.com/api/v1/cart', type: 'XHR' })
    // Not the internal API: a document/image/stylesheet → dropped.
    feed(rec, { id: '5', url: 'https://order.coupang.com/order/list', type: 'Document' })
    feed(rec, { id: '6', url: 'https://order.coupang.com/logo.png', type: 'Image' })
    feed(rec, { id: '7', url: 'https://order.coupang.com/app.css', type: 'Stylesheet' })
    // Cross-site XHR (an ad/tracker) → dropped.
    feed(rec, { id: '8', url: 'https://ads.doubleclick.net/collect', type: 'XHR' })
    return rec
  }

  it('keeps only same-site XHR/Fetch, drops document/image/css and cross-site, and dedups by method+path', () => {
    const r = recorded().toRecording()
    const keys = (r.apiCalls ?? []).map((c) => `${c.method} ${new URL(c.url).pathname}`)
    expect(keys).toEqual(['GET /api/v1/orders', 'POST /api/v1/orders/cancel', 'GET /api/v1/cart'])
    // Status + content type come off the response.
    const orders = r.apiCalls?.find((c) => c.url.endsWith('/api/v1/orders'))
    expect(orders?.status).toBe(200)
    expect(orders?.contentType).toBe('application/json')
  })

  it('records header NAMES only and NEVER a cookie/authorization/token value', () => {
    const r = recorded().toRecording()
    const serialized = JSON.stringify(r)
    expect(serialized).not.toContain('SHOULD_NOT_APPEAR')
    expect(serialized).not.toContain('SEKRET') // the query token on the url is stripped too
    const orders = r.apiCalls?.find((c) => c.url.endsWith('/api/v1/orders'))
    const names = Object.keys(orders?.headers ?? {}).map((n) => n.toLowerCase())
    expect(names).not.toContain('cookie')
    expect(names).not.toContain('authorization')
    // the safe custom header name is kept (as a name only, no value)
    expect(names).toContain('x-coupang-target')
    expect(orders?.headers?.['X-Coupang-Target']).toBe('')
    // the captured url carries no query string
    expect(orders?.url).toBe('https://order.coupang.com/api/v1/orders')
  })

  it('captures even when the resourceType is only known on the response', () => {
    const rec = new SessionRecorder({ url: 'https://order.coupang.com/list' })
    feed(rec, {
      id: 'x',
      method: 'GET',
      url: 'https://order.coupang.com/api/v1/me',
      type: 'XHR',
      typeOnResponseOnly: true,
    })
    const r = rec.toRecording()
    expect((r.apiCalls ?? []).map((c) => c.url)).toContain('https://order.coupang.com/api/v1/me')
  })
})

describe('SessionRecorder.toRecording() → draftSkill', () => {
  it('drafts a skill-sdk-parseable SKILL.md with the recorded endpoints in the body', () => {
    const rec = new SessionRecorder({
      url: 'https://order.coupang.com/order/list',
      keywords: ['쿠팡', '주문내역'],
    })
    feed(rec, { id: '1', method: 'GET', url: 'https://order.coupang.com/api/v1/orders', type: 'XHR' })
    feed(rec, {
      id: '2',
      method: 'POST',
      url: 'https://order.coupang.com/api/v1/orders/cancel',
      type: 'Fetch',
    })
    rec.noteUrl('https://order.coupang.com/order/list')
    rec.addUiStep({ action: 'goto', label: 'https://order.coupang.com/order/list' })
    rec.addUiStep({ action: 'click', ref: 'e12', label: '주문목록' })
    rec.setLoginFields({ username: 'e1', password: 'e2', submit: 'e3' })

    const recording = rec.toRecording()
    expect(recording.host).toBe('order.coupang.com')

    const drafted = draftSkill(recording)
    expect(drafted.needsReview).toBe(true)
    // The frontmatter round-trips through @dool2/skill-sdk.
    const parsed = parseSkillMarkdown(drafted.markdown)
    expect(parsed.frontmatter.site).toEqual(['coupang.com'])
    expect(parsed.frontmatter.autoInject?.keywords).toContain('쿠팡')
    // The data path (endpoints) is in the body.
    expect(drafted.body).toContain('GET /api/v1/orders')
    expect(drafted.body).toContain('POST /api/v1/orders/cancel')
    // Login hints came through as frontmatter.
    expect(parsed.frontmatter.login?.password).toBeDefined()
  })
})
