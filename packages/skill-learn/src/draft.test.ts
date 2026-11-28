import { parseSkillMarkdown, resolveSkills, type SkillMeta } from '@dool2/skill-sdk'
import { describe, expect, it } from 'vitest'
import { baseDomain, draftSkill, hostGlobs, serializeFrontmatter } from './draft.js'
import type { SessionRecording } from './recording.js'

/** A recording of a Korean task on coupang with two API calls, a login, and a secret-ish header/url. */
const recording: SessionRecording = {
  url: 'https://order.coupang.com/order/list?page=1',
  host: 'order.coupang.com',
  apiCalls: [
    {
      method: 'GET',
      url: 'https://order.coupang.com/api/v1/orders?page=1&access_token=SEKRET_TOKEN_abc123',
      headers: {
        Cookie: 'session=SHOULD_NOT_APPEAR_abcdefghijklmnop',
        Authorization: 'Bearer SHOULD_NOT_APPEAR_tokenvalue',
        'X-Coupang-Target': 'orders',
        Accept: 'application/json',
      },
      status: 200,
      contentType: 'application/json',
    },
    {
      method: 'POST',
      url: 'https://order.coupang.com/api/v1/orders/cancel',
      headers: { 'X-Coupang-Target': 'orders' },
      status: 200,
    },
  ],
  uiSteps: [
    { action: 'goto', label: 'https://order.coupang.com/order/list' },
    { action: 'click', label: '주문목록', ref: 'e12' },
  ],
  loginFields: {
    username: '아이디',
    password: '비밀번호',
    submit: '로그인',
  },
  keywordsSeen: ['쿠팡', '주문', '주문내역'],
}

describe('draftSkill', () => {
  const drafted = draftSkill(recording)

  it('produces frontmatter that skill-sdk parses back to the same shape', () => {
    const parsed = parseSkillMarkdown(drafted.markdown)
    expect(parsed.frontmatter.name).toBe(drafted.frontmatter.name)
    expect(parsed.frontmatter.description).toBe(drafted.frontmatter.description)
    expect(parsed.frontmatter.site).toEqual(drafted.frontmatter.site)
    expect(parsed.frontmatter.autoInject).toEqual(drafted.frontmatter.autoInject)
    expect(parsed.frontmatter.regions).toEqual(drafted.frontmatter.regions)
    expect(parsed.frontmatter.login).toEqual(drafted.frontmatter.login)
  })

  it('uses the base domain as the site and a subdomain glob for autoInject', () => {
    expect(drafted.frontmatter.site).toEqual(['coupang.com'])
    expect(drafted.frontmatter.autoInject?.url).toEqual(hostGlobs('coupang.com'))
    expect(drafted.frontmatter.autoInject?.url).toContain('*.coupang.com')
  })

  it('derives Korean-first keywords and marks the region kr', () => {
    const keywords = drafted.frontmatter.autoInject?.keywords ?? []
    expect(keywords).toContain('쿠팡')
    expect(keywords).toContain('주문')
    // Korean keywords sort ahead of any Latin ones.
    const firstLatin = keywords.findIndex((k) => /^[a-z]/i.test(k))
    const lastKorean = keywords.map((k) => /[가-힣]/.test(k)).lastIndexOf(true)
    if (firstLatin !== -1) expect(lastKorean).toBeLessThan(firstLatin)
    expect(drafted.frontmatter.regions).toEqual(['kr'])
  })

  it('carries login hints from the recorded fields', () => {
    expect(drafted.frontmatter.login?.username).toEqual({ name: '아이디' })
    expect(drafted.frontmatter.login?.password).toEqual({ name: '비밀번호' })
    expect(drafted.frontmatter.login?.submit).toEqual({ name: '로그인' })
  })

  it('lists the API endpoints in the body, data path first, with a UI fallback', () => {
    expect(drafted.body).toContain('GET /api/v1/orders')
    expect(drafted.body).toContain('POST /api/v1/orders/cancel')
    // Data path section comes before the UI fallback section.
    expect(drafted.body.indexOf('데이터 경로')).toBeLessThan(drafted.body.indexOf('UI 폴백'))
    expect(drafted.body).toContain('주문목록')
    // The one custom header is listed by name; session headers are dropped.
    expect(drafted.body).toContain('X-Coupang-Target')
  })

  it('redacts secret-looking headers and url tokens out of the markdown', () => {
    expect(drafted.markdown).not.toContain('SEKRET_TOKEN_abc123')
    expect(drafted.markdown).not.toContain('SHOULD_NOT_APPEAR')
    expect(drafted.markdown.toLowerCase()).not.toContain('bearer shouldnot')
    expect(drafted.markdown).toBe(draftSkill(recording).markdown) // deterministic
  })

  it('marks the draft as needing review', () => {
    expect(drafted.needsReview).toBe(true)
  })
})

describe('resolve round-trip', () => {
  it('skill-sdk resolves the drafted skill for the recorded host', () => {
    const drafted = draftSkill(recording)
    const parsed = parseSkillMarkdown(drafted.markdown)
    const meta: SkillMeta = {
      id: drafted.id,
      name: parsed.frontmatter.name,
      ...(parsed.frontmatter.site ? { site: parsed.frontmatter.site } : {}),
      ...(parsed.frontmatter.autoInject ? { autoInject: parsed.frontmatter.autoInject } : {}),
      ...(parsed.frontmatter.login ? { login: parsed.frontmatter.login } : {}),
    }
    const other: SkillMeta = {
      id: 'naver',
      name: 'naver',
      autoInject: { url: ['*.naver.com'], keywords: ['네이버'] },
    }
    const scored = resolveSkills({ url: recording.url }, [other, meta])
    expect(scored[0]?.skill.id).toBe(drafted.id)
  })
})

describe('baseDomain', () => {
  it('reduces subdomains and honors Korean second-level domains', () => {
    expect(baseDomain('order.coupang.com')).toBe('coupang.com')
    expect(baseDomain('www.naver.com')).toBe('naver.com')
    expect(baseDomain('minwon.seoul.go.kr')).toBe('seoul.go.kr')
    expect(baseDomain('gov.kr')).toBe('gov.kr')
  })
})

describe('serializeFrontmatter', () => {
  it('quotes glob strings that start with a wildcard so they round-trip', () => {
    const text = serializeFrontmatter({
      name: 'x',
      description: 'y',
      autoInject: { url: ['*.x.com', '*.x.com/*'], keywords: ['쿠폰'] },
    })
    expect(text).toContain('"*.x.com"')
    const parsed = parseSkillMarkdown(`${text}\n# body\n`)
    expect(parsed.frontmatter.autoInject?.url).toEqual(['*.x.com', '*.x.com/*'])
  })
})
