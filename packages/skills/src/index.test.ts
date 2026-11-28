import { resolveSkills } from '@dool2/skill-sdk'
import { describe, expect, it } from 'vitest'
import { builtinSkillsDir, loadBuiltinSkillMetas, loadBuiltinSkills } from './index.js'

describe('built-in skill pack', () => {
  const skills = loadBuiltinSkills()
  const metas = loadBuiltinSkillMetas()

  it('ships the seed skills', () => {
    const ids = skills.map((s) => s.meta.id).sort()
    expect(ids).toEqual(['coupang', 'gov24', 'naver'])
  })

  it('parses valid frontmatter for each seed skill', () => {
    for (const s of skills) {
      expect(s.meta.name).toBeTruthy()
      expect(s.meta.regions).toContain('kr')
      // Each seed skill asks to be auto-injected by URL and by keyword.
      expect(s.meta.autoInject?.url?.length).toBeGreaterThan(0)
      expect(s.meta.autoInject?.keywords?.length).toBeGreaterThan(0)
      // The body carries the site hints the brain reads once the skill is injected.
      expect(s.body.trim().length).toBeGreaterThan(0)
      expect(s.path.endsWith('SKILL.md')).toBe(true)
    }
  })

  it('points builtinSkillsDir at a directory that contains the skills', () => {
    expect(builtinSkillsDir().endsWith('skills')).toBe(true)
  })

  it('resolves gov24 for a gov.kr tab URL', () => {
    const top = resolveSkills({ url: 'https://www.gov.kr/portal/main' }, metas)[0]
    expect(top?.skill.id).toBe('gov24')
    expect(top?.reasons.some((r) => r.kind === 'url')).toBe(true)
  })

  it('resolves coupang for a coupang message', () => {
    // "쿠팡에서 지난주 주문 배송 어디까지 왔어?" — keywords 쿠팡/주문/배송 fused with Korean endings.
    const top = resolveSkills({ message: '쿠팡에서 지난주 주문 배송 어디까지 왔어?' }, metas)[0]
    expect(top?.skill.id).toBe('coupang')
    expect(top?.reasons.some((r) => r.kind === 'keyword')).toBe(true)
  })

  it('resolves naver for a naver login message', () => {
    const top = resolveSkills({ message: '네이버 로그인 해줘' }, metas)[0]
    expect(top?.skill.id).toBe('naver')
  })

  it('exposes login field hints on the naver seed skill (Korean names)', () => {
    const naver = skills.find((s) => s.meta.id === 'naver')
    expect(naver?.meta.login?.username).toEqual({ name: '아이디', role: 'textbox' })
    expect(naver?.meta.login?.password?.name).toBe('비밀번호')
    expect(naver?.meta.login?.submit).toEqual({ name: '로그인', role: 'button' })
    expect(naver?.meta.login?.totp?.name).toBe('인증번호')
  })

  it('binds the login hints to the nid.naver.com login page via URL resolution', () => {
    const top = resolveSkills({ url: 'https://nid.naver.com/nidlogin.login' }, metas)[0]
    expect(top?.skill.id).toBe('naver')
    expect(top?.skill.login?.password?.name).toBe('비밀번호')
  })
})
