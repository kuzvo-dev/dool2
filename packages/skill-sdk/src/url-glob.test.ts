import { describe, expect, it } from 'vitest'
import { globSpecificity, matchUrlGlob } from './url-glob.js'

describe('matchUrlGlob', () => {
  it('matches a bare domain and its subdomains with *.gov.kr', () => {
    expect(matchUrlGlob('https://www.gov.kr/portal/main', '*.gov.kr')).toBe(true)
    expect(matchUrlGlob('https://gov.kr/', '*.gov.kr')).toBe(true)
    expect(matchUrlGlob('https://minwon.gov.kr/m/main', '*.gov.kr')).toBe(true)
    expect(matchUrlGlob('https://a.b.gov.kr/x', '*.gov.kr')).toBe(true)
  })

  it('does not match a different host', () => {
    expect(matchUrlGlob('https://evil.com/gov.kr', '*.gov.kr')).toBe(false)
    expect(matchUrlGlob('https://notgov.kr/', '*.gov.kr')).toBe(false)
  })

  it('matches host + path globs', () => {
    expect(matchUrlGlob('https://coupang.com/np/search?q=apple', 'coupang.com/np/*')).toBe(true)
    expect(matchUrlGlob('https://coupang.com/vp/products/1', 'coupang.com/np/*')).toBe(false)
    expect(matchUrlGlob('https://coupang.com/', 'coupang.com/*')).toBe(true)
    expect(matchUrlGlob('https://coupang.com/a/b/c', 'coupang.com/*')).toBe(true)
  })

  it('ignores query and hash', () => {
    expect(matchUrlGlob('https://coupang.com/np/x#frag?z=1', 'coupang.com/np/*')).toBe(true)
  })

  it('returns false for invalid URLs', () => {
    expect(matchUrlGlob('not a url', '*.gov.kr')).toBe(false)
  })

  it('scores specificity by literal characters', () => {
    expect(globSpecificity('coupang.com/np/*')).toBeGreaterThan(globSpecificity('coupang.com/*'))
  })
})
