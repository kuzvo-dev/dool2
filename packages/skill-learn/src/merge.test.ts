import { parseSkillMarkdown } from '@dool2/skill-sdk'
import { describe, expect, it } from 'vitest'
import { mergeIntoSkill } from './draft.js'
import type { SessionRecording } from './recording.js'

/** An existing, hand-curated skill with one endpoint and a curated tip. */
const existing = `---
name: coupang
description: 쿠팡 주문 조회를 돕는다.
site: [coupang.com]
autoInject:
  url: ['*.coupang.com', '*.coupang.com/*']
  keywords: [쿠팡, 주문]
regions: [kr]
login:
  password:
    name: 비밀번호
---

# 쿠팡 (coupang.com)

손으로 다듬은 요령: 로켓배송 주문은 배송 탭에서 따로 본다.

## 데이터 경로 (먼저 시도)

먼저 이 API를 사용자 세션으로 불러 보세요(로그인 상태면 클릭 없이 바로):
- \`GET /api/v1/orders\`

## 안전

- 캡차는 사용자에게 넘긴다.
`

const recording: SessionRecording = {
  url: 'https://order.coupang.com/returns',
  host: 'order.coupang.com',
  apiCalls: [
    { method: 'GET', url: 'https://order.coupang.com/api/v1/orders' }, // already known
    { method: 'POST', url: 'https://order.coupang.com/api/v1/returns' }, // new
  ],
  loginFields: { username: '아이디' }, // fills a missing login hint
  keywordsSeen: ['반품'],
}

describe('mergeIntoSkill', () => {
  const merged = mergeIntoSkill(existing, recording)

  it('adds the newly-found endpoint', () => {
    expect(merged.body).toContain('POST /api/v1/returns')
  })

  it('keeps the previously-known endpoint and the curated prose', () => {
    expect(merged.body).toContain('GET /api/v1/orders')
    expect(merged.body).toContain('손으로 다듬은 요령')
    expect(merged.body).toContain('로켓배송 주문은 배송 탭에서 따로 본다')
  })

  it('does not duplicate the already-known endpoint', () => {
    const occurrences = merged.body.split('GET /api/v1/orders').length - 1
    expect(occurrences).toBe(1)
  })

  it('keeps curated name/description but grows keywords and login hints', () => {
    const parsed = parseSkillMarkdown(merged.markdown)
    expect(parsed.frontmatter.name).toBe('coupang')
    expect(parsed.frontmatter.description).toBe('쿠팡 주문 조회를 돕는다.')
    expect(parsed.frontmatter.autoInject?.keywords).toContain('반품')
    expect(parsed.frontmatter.autoInject?.keywords).toContain('쿠팡')
    // Existing password hint preserved; the new username hint filled in.
    expect(parsed.frontmatter.login?.password).toEqual({ name: '비밀번호' })
    expect(parsed.frontmatter.login?.username).toEqual({ name: '아이디' })
  })

  it('round-trips through skill-sdk', () => {
    const parsed = parseSkillMarkdown(merged.markdown)
    expect(parsed.frontmatter.site).toEqual(['coupang.com'])
    expect(parsed.frontmatter.regions).toEqual(['kr'])
  })
})
