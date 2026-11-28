import { describe, expect, it } from 'vitest'
import { parseSkillMarkdown } from './frontmatter.js'

const SAMPLE = `---
name: gov24
description: 정부24에서 증명서 발급·민원 조회를 돕는 사이트 스킬
site:
  - gov.kr
autoInject:
  url:
    - "*.gov.kr"
    - "*.gov.kr/*"
  keywords: ["발급", "증명서", "민원"]
regions: [kr]
disabled: false
---

# gov24

본문 시작. 정부24 요령.
`

describe('parseSkillMarkdown', () => {
  it('parses name, description, site, autoInject url/keywords and regions', () => {
    const { frontmatter, body } = parseSkillMarkdown(SAMPLE)
    expect(frontmatter.name).toBe('gov24')
    expect(frontmatter.description).toBe('정부24에서 증명서 발급·민원 조회를 돕는 사이트 스킬')
    expect(frontmatter.site).toEqual(['gov.kr'])
    expect(frontmatter.autoInject?.url).toEqual(['*.gov.kr', '*.gov.kr/*'])
    expect(frontmatter.autoInject?.keywords).toEqual(['발급', '증명서', '민원'])
    expect(frontmatter.regions).toEqual(['kr'])
    expect(frontmatter.disabled).toBe(false)
    expect(body.trimStart().startsWith('# gov24')).toBe(true)
  })

  it('normalizes a scalar site into an array and reads inline lists', () => {
    const { frontmatter } = parseSkillMarkdown(
      `---\nname: coupang\ndescription: 쿠팡 스킬\nsite: coupang.com\nautoInject:\n  url: ["coupang.com/*"]\n  keywords: ["쿠팡"]\n---\nbody\n`,
    )
    expect(frontmatter.site).toEqual(['coupang.com'])
    expect(frontmatter.autoInject?.url).toEqual(['coupang.com/*'])
    expect(frontmatter.autoInject?.keywords).toEqual(['쿠팡'])
  })

  it('drops an empty autoInject block', () => {
    const { frontmatter } = parseSkillMarkdown('---\nname: x\ndescription: y\n---\nbody\n')
    expect(frontmatter.autoInject).toBeUndefined()
  })

  it('ignores trailing comments in the frontmatter', () => {
    const { frontmatter } = parseSkillMarkdown(
      '---\nname: x # the id\ndescription: y\n# a full-line comment\n---\nbody\n',
    )
    expect(frontmatter.name).toBe('x')
    expect(frontmatter.description).toBe('y')
  })

  it('treats a document without frontmatter as all body', () => {
    const { frontmatter, body } = (() => {
      try {
        return parseSkillMarkdown('# just a heading\n')
      } catch (err) {
        return { frontmatter: null, body: String(err) }
      }
    })()
    // No frontmatter means the required name is missing -> throws.
    expect(frontmatter).toBeNull()
    expect(body).toContain('requires')
  })

  it('throws when name or description is missing', () => {
    expect(() => parseSkillMarkdown('---\ndescription: y\n---\nbody\n')).toThrow(/name/)
    expect(() => parseSkillMarkdown('---\nname: x\n---\nbody\n')).toThrow(/description/)
  })

  it('parses a login block with role+name hints (Korean names) and a totp field', () => {
    const md = `---
name: naver
description: 네이버 로그인 스킬
login:
  username:
    name: 아이디
    role: textbox
  password:
    name: 비밀번호
    role: textbox
  submit:
    name: 로그인
    role: button
  totp:
    name: 인증번호
---
body
`
    const { frontmatter } = parseSkillMarkdown(md)
    expect(frontmatter.login?.username).toEqual({ name: '아이디', role: 'textbox' })
    expect(frontmatter.login?.password).toEqual({ name: '비밀번호', role: 'textbox' })
    expect(frontmatter.login?.submit).toEqual({ name: '로그인', role: 'button' })
    expect(frontmatter.login?.totp).toEqual({ name: '인증번호' })
  })

  it('accepts a bare-string field hint as shorthand for { name }, and a selector hint', () => {
    const { frontmatter } = parseSkillMarkdown(
      `---\nname: x\ndescription: y\nlogin:\n  username: 아이디\n  password:\n    selector: "#pw"\n---\nbody\n`,
    )
    expect(frontmatter.login?.username).toEqual({ name: '아이디' })
    expect(frontmatter.login?.password).toEqual({ selector: '#pw' })
  })

  it('drops a login block that names no fillable field', () => {
    const { frontmatter } = parseSkillMarkdown(
      '---\nname: x\ndescription: y\nlogin:\n  username:\n---\nbody\n',
    )
    expect(frontmatter.login).toBeUndefined()
  })
})
