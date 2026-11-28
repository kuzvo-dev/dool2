import { describe, expect, it } from 'vitest'
import { draftSkill } from './draft.js'
import type { SessionRecording } from './recording.js'
import { defaultRedactor, isSessionHeaderName, safeHeaderNames } from './redact.js'

describe('defaultRedactor', () => {
  it('masks secret query params but keeps the path', () => {
    const out = defaultRedactor('https://x.com/api/orders?access_token=ABC123secretValue&page=1')
    expect(out).not.toContain('ABC123secretValue')
    expect(out).toContain('/api/orders')
    expect(out).toContain('page=1')
  })

  it('masks Authorization, Cookie and bearer tokens', () => {
    expect(defaultRedactor('Authorization: Bearer abcTOKENabcTOKENabcTOKEN')).not.toContain('abcTOKEN')
    expect(defaultRedactor('Cookie: session=abcdefghijklmnopqrstuvwx')).not.toContain(
      'abcdefghijklmnopqrstuvwx',
    )
  })

  it('leaves ordinary API paths intact', () => {
    const path = '/api/v2/orders/12345/items'
    expect(defaultRedactor(path)).toBe(path)
  })
})

describe('safeHeaderNames', () => {
  it('drops session and ordinary headers, keeps custom ones', () => {
    const names = safeHeaderNames({
      Cookie: 'x',
      Authorization: 'y',
      Accept: 'application/json',
      'X-Gmail-BTAI': 'z',
      'X-Custom': 'w',
    })
    expect(names).toEqual(['X-Custom', 'X-Gmail-BTAI'])
    expect(isSessionHeaderName('cookie')).toBe(true)
    expect(isSessionHeaderName('x-gmail-btai')).toBe(false)
  })
})

describe('drafted markdown never carries a secret', () => {
  it('a cookie, an Authorization header and a url token never appear', () => {
    const recording: SessionRecording = {
      url: 'https://shop.example.kr/me',
      host: 'shop.example.kr',
      apiCalls: [
        {
          method: 'GET',
          url: 'https://shop.example.kr/api/me?token=TOPSECRET_token_value_123456',
          headers: {
            Cookie: 'sid=COOKIE_SECRET_abcdefghijklmnop',
            Authorization: 'Bearer AUTH_SECRET_abcdefghijklmnop',
          },
        },
      ],
      keywordsSeen: ['내정보'],
    }
    const drafted = draftSkill(recording)
    expect(drafted.markdown).not.toContain('TOPSECRET')
    expect(drafted.markdown).not.toContain('COOKIE_SECRET')
    expect(drafted.markdown).not.toContain('AUTH_SECRET')
    // The path itself is still useful and present.
    expect(drafted.markdown).toContain('GET /api/me')
  })

  it('honors an injected redactor', () => {
    const recording: SessionRecording = {
      url: 'https://x.com/a',
      host: 'x.com',
      apiCalls: [{ method: 'GET', url: 'https://x.com/api/data' }],
    }
    const drafted = draftSkill(recording, { redactor: (t) => t.replaceAll('data', 'REDACTED') })
    expect(drafted.markdown).toContain('/api/REDACTED')
  })
})
