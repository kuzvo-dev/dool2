import { describe, expect, it } from 'vitest'
import {
  formatMoney,
  guessRegion,
  initialLang,
  list,
  messages,
  plural,
  resolveLang,
  servesRegion,
} from './index.js'

describe('resolveLang', () => {
  it('takes the first shipped language in order', () => {
    expect(resolveLang(['ja-JP', 'ko-KR', 'en-US'])).toBe('ko')
    expect(resolveLang('en-GB')).toBe('en')
    expect(resolveLang('ko')).toBe('ko')
  })
  it('falls back to English', () => {
    expect(resolveLang(['ja-JP', 'zh-Hant-TW'])).toBe('en')
    expect(resolveLang(undefined)).toBe('en')
    expect(resolveLang([])).toBe('en')
  })
})

describe('guessRegion', () => {
  it('reads the region from the locale first', () => {
    expect(guessRegion({ locales: ['ko-KR'], timeZone: 'Asia/Tokyo' })).toBe('KR')
    expect(guessRegion({ locales: ['zh-Hant-TW'] })).toBe('TW')
    expect(guessRegion({ locales: ['en_JP'] })).toBe('JP')
  })
  it('then from the time zone', () => {
    expect(guessRegion({ locales: ['en-US'], timeZone: 'Asia/Seoul' })).toBe('KR')
    expect(guessRegion({ locales: ['en'], timeZone: 'Asia/Taipei' })).toBe('TW')
  })
  it('returns undefined when unknown', () => {
    expect(guessRegion({ locales: ['en-US'], timeZone: 'America/New_York' })).toBeUndefined()
  })
})

describe('servesRegion', () => {
  it('shows global services everywhere and regional ones only in their region', () => {
    expect(servesRegion(['global'], 'JP')).toBe(true)
    expect(servesRegion(['KR'], 'KR')).toBe(true)
    expect(servesRegion(['KR'], 'JP')).toBe(false)
    expect(servesRegion(['KR', 'JP'], 'JP')).toBe(true)
  })
  it('treats cards without regions as Korean', () => {
    expect(servesRegion(undefined, 'KR')).toBe(true)
    expect(servesRegion(undefined, 'TW')).toBe(false)
  })
})

describe('messages', () => {
  const m = messages({
    ko: { title: '연결', hello: (name: string) => `${name}님, 안녕하세요` },
    en: { title: 'Connections', hello: (name: string) => `Hi ${name}` },
  })
  it('returns the catalog for the language', () => {
    expect(m('ko').title).toBe('연결')
    expect(m('en').hello('Minji')).toBe('Hi Minji')
  })
  it('fails to type-check when English misses a key', () => {
    messages({
      ko: { a: '가', b: '나' },
      // @ts-expect-error `b` is missing in English
      en: { a: 'A' },
    })
  })
})

describe('plural and list', () => {
  it('uses the language rules', () => {
    expect(plural('en', 1, { one: '1 service', other: 'n services' })).toBe('1 service')
    expect(plural('en', 2, { one: '1 service', other: '2 services' })).toBe('2 services')
    expect(plural('ko', 1, { one: 'x', other: '1곳' })).toBe('1곳')
    expect(list('en', ['orders', 'returns', 'reviews'])).toBe('orders, returns, and reviews')
  })
})

describe('formatMoney', () => {
  it('writes won the Korean way in Korean', () => {
    expect(formatMoney('ko', 12000)).toBe('12,000원')
    expect(formatMoney('en', 12000)).toBe('₩12,000')
    expect(formatMoney('en', 1200, 'JPY')).toBe('¥1,200')
  })
})

describe('initialLang', () => {
  it('keeps a saved choice', () => {
    expect(initialLang('en', ['ko-KR'])).toBe('en')
  })
  it('stays Korean until UI_FOLLOWS_DEVICE is on', () => {
    expect(initialLang(undefined, ['en-US'])).toBe('ko')
    expect(initialLang('fr', ['en-US'])).toBe('ko')
  })
})
