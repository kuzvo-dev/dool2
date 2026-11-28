import { describe, expect, it } from 'vitest'
import type { VaultItem } from './types.js'
import { findLoginItemsForUrl, urlMatchesSite } from './url-binding.js'

const items: VaultItem[] = [
  { id: 'naver', kind: 'login', site: 'naver.com', username: 'a', secret: { password: 'p' } },
  { id: 'kakao', kind: 'login', site: 'kakao.com', username: 'b', secret: { password: 'p' } },
  { id: 'apple', kind: 'login', site: 'apple.com', username: 'c', secret: { password: 'p' } },
  { id: 'example', kind: 'login', site: 'example.com', username: 'd', secret: { password: 'p' } },
  // A card is never returned by a login-for-URL lookup.
  {
    id: 'card',
    kind: 'card',
    site: 'example.com',
    secret: { number: '4111111111111111', expiry: '1/29', cvc: '1' },
  },
]

function ids(url: string): string[] {
  return findLoginItemsForUrl(url, items).map((i) => i.id)
}

describe('findLoginItemsForUrl — URL binding with equivalent domains', () => {
  it('matches the exact host and returns only login items', () => {
    expect(ids('https://example.com/login')).toEqual(['example'])
  })

  it('matches a subdomain to its parent (nid.naver.com ~ naver.com)', () => {
    expect(ids('https://nid.naver.com/login')).toEqual(['naver'])
  })

  it('matches Korean equivalent domains (daum ~ kakao)', () => {
    expect(ids('https://www.daum.net/')).toEqual(['kakao'])
  })

  it('matches global equivalent domains (icloud.com ~ apple.com)', () => {
    expect(ids('https://www.icloud.com/')).toEqual(['apple'])
  })

  it('does not match an unrelated site', () => {
    expect(ids('https://evil.example.org/')).toEqual([])
  })

  it('rejects non-http(s) URLs', () => {
    expect(findLoginItemsForUrl('javascript:alert(1)', items)).toEqual([])
    expect(findLoginItemsForUrl('data:text/html,hi', items)).toEqual([])
    expect(findLoginItemsForUrl('file:///etc/passwd', items)).toEqual([])
    expect(findLoginItemsForUrl('ftp://naver.com/', items)).toEqual([])
    expect(findLoginItemsForUrl('not a url', items)).toEqual([])
  })

  it('honors extra equivalent-domain groups from settings', () => {
    const extra = { equivalentDomains: [['foo.com', 'bar.com']] }
    expect(urlMatchesSite('https://bar.com/', 'foo.com', extra)).toBe(true)
    expect(urlMatchesSite('https://bar.com/', 'foo.com')).toBe(false)
  })

  it('urlMatchesSite rejects a non-http tab or site', () => {
    expect(urlMatchesSite('javascript:1', 'naver.com')).toBe(false)
    expect(urlMatchesSite('https://naver.com', 'javascript:1')).toBe(false)
  })
})
