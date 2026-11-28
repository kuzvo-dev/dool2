import { describe, expect, it } from 'vitest'
import { keywordMatchScore, resolveSkills, type SkillMeta, tokenize, urlMatchScore } from './resolve.js'

const gov24: SkillMeta = {
  id: 'gov24',
  name: 'gov24',
  autoInject: { url: ['*.gov.kr', '*.gov.kr/*'], keywords: ['발급', '증명서'] },
}
const coupang: SkillMeta = {
  id: 'coupang',
  name: 'coupang',
  autoInject: { url: ['coupang.com/*', '*.coupang.com/*'], keywords: ['쿠팡'] },
}
const pay: SkillMeta = {
  id: 'pay',
  name: 'pay',
  autoInject: { keywords: ['결제', '구매'] },
}
const SKILLS = [gov24, coupang, pay]

describe('resolveSkills', () => {
  it('returns the gov24 skill for a gov.kr tab URL', () => {
    const result = resolveSkills({ url: 'https://www.gov.kr/portal/main' }, SKILLS)
    expect(result.map((r) => r.skill.id)).toEqual(['gov24'])
    expect(result[0]?.reasons.some((r) => r.kind === 'url')).toBe(true)
  })

  it('ranks coupang above the keyword-only pay skill when both URL and keyword hit', () => {
    const result = resolveSkills(
      { url: 'https://coupang.com/np/search', message: '쿠팡에서 사과 결제해줘' },
      SKILLS,
    )
    expect(result.map((r) => r.skill.id)).toEqual(['coupang', 'pay'])
    // coupang scored on both URL and keyword; pay only on the keyword.
    expect(result[0]?.score).toBeGreaterThan(result[1]?.score ?? 0)
  })

  it('matches a keyword glued to a Korean particle or ending', () => {
    const result = resolveSkills({ message: '쿠팡에서 사과 결제해줘' }, SKILLS)
    expect(result.map((r) => r.skill.id).sort()).toEqual(['coupang', 'pay'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(resolveSkills({ message: '오늘 날씨 어때' }, SKILLS)).toEqual([])
    expect(resolveSkills({ url: 'https://example.com/' }, SKILLS)).toEqual([])
    expect(resolveSkills({}, SKILLS)).toEqual([])
  })

  it('does not falsely match a keyword inside a bigger token', () => {
    const login: SkillMeta = { id: 'login', autoInject: { keywords: ['로그인'] } }
    // 로그인 appears mid-token in 블로그인기 (블로그 + 인기); must not match.
    expect(resolveSkills({ message: '블로그인기 글 추천해줘' }, [login])).toEqual([])
    // Standalone token matches.
    expect(resolveSkills({ message: '네이버 로그인 해줘' }, [login]).map((r) => r.skill.id)).toEqual([
      'login',
    ])
  })

  it('treats a Latin keyword as a strict whole word', () => {
    const skill: SkillMeta = { id: 'pay-en', autoInject: { keywords: ['pay'] } }
    expect(resolveSkills({ message: 'open the payment page' }, [skill])).toEqual([])
    expect(resolveSkills({ message: 'pay now please' }, [skill]).map((r) => r.skill.id)).toEqual(['pay-en'])
  })

  it('skips disabled skills', () => {
    const disabled: SkillMeta = { ...gov24, id: 'gov24', disabled: true }
    expect(resolveSkills({ url: 'https://www.gov.kr/' }, [disabled])).toEqual([])
  })

  it('honors the limit option', () => {
    const result = resolveSkills(
      { url: 'https://coupang.com/np/search', message: '쿠팡 결제 구매' },
      SKILLS,
      { limit: 1 },
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.skill.id).toBe('coupang')
  })
})

describe('urlMatchScore', () => {
  it('scores a matching glob and lists the pattern as a reason', () => {
    const { score, reasons } = urlMatchScore('https://www.gov.kr/x', ['*.gov.kr'])
    expect(score).toBeGreaterThan(0)
    expect(reasons).toEqual([{ kind: 'url', pattern: '*.gov.kr' }])
  })

  it('scores zero without a url or patterns', () => {
    expect(urlMatchScore(undefined, ['*.gov.kr']).score).toBe(0)
    expect(urlMatchScore('https://gov.kr/', undefined).score).toBe(0)
  })
})

describe('keywordMatchScore', () => {
  it('counts distinct matched keywords', () => {
    const { score, reasons } = keywordMatchScore('쿠팡 결제 구매', ['결제', '구매'])
    expect(reasons).toHaveLength(2)
    expect(score).toBeGreaterThan(0)
  })

  it('does not double count a repeated keyword', () => {
    const { reasons } = keywordMatchScore('결제 결제 결제', ['결제', '결제'])
    expect(reasons).toHaveLength(1)
  })
})

describe('tokenize', () => {
  it('splits on non-letter/digit while keeping Hangul tokens whole', () => {
    expect(tokenize('쿠팡에서 사과 결제해줘')).toEqual(['쿠팡에서', '사과', '결제해줘'])
    expect(tokenize('go to coupang.com/np')).toEqual(['go', 'to', 'coupang', 'com', 'np'])
  })
})
