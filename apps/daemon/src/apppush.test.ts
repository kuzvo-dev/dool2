import { createDecipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { APP_PUSH_MAX, sealAppPush, sendAppPush, validAppPush } from './apppush.js'

const key = Buffer.alloc(32, 3).toString('base64url')

function openSealed(data: string) {
  const b = Buffer.from(data, 'base64url')
  const d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), b.subarray(0, 12))
  d.setAuthTag(b.subarray(b.length - 16))
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString())
}

describe('스토어 앱 알림 (ADR 0042)', () => {
  it('폰이 보낸 토큰·키를 확인한다', () => {
    expect(validAppPush({ token: 'a'.repeat(40), key })).toBe(true)
    expect(validAppPush({ token: 'a'.repeat(40), key: 'abc' })).toBe(false)
    expect(validAppPush({ token: 'bad token with spaces', key })).toBe(false)
    expect(validAppPush(null)).toBe(false)
  })

  it('알림 내용은 폰 키로만 풀린다', () => {
    const msg = { title: '승인을 기다려요', body: '사과 결제', tag: 'a-1', url: '#a=1' }
    const sealed = sealAppPush(key, msg)
    expect(sealed).not.toContain('사과')
    expect(openSealed(sealed)).toEqual(msg)
  })

  it('긴 본문은 잘라서 FCM 한 통에 들어가게 한다', () => {
    const sealed = sealAppPush(key, { title: 't', body: '가'.repeat(5_000), tag: 'x' })
    expect(sealed.length).toBeLessThanOrEqual(APP_PUSH_MAX)
    expect(openSealed(sealed).body).toMatch(/…$/)
  })

  it('공식 중계 서버에 암호문만 넘기고, 410이면 gone', async () => {
    const calls: { url: string; body: { token: string; data: string } }[] = []
    let status = 200
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(null, { status })
    }) as unknown as typeof fetch
    const reg = { token: 'a'.repeat(40), key }
    expect(await sendAppPush(reg, { title: '안녕', body: '본문', tag: 't' }, { fetch: fake })).toBe('sent')
    expect(calls[0]?.url).toBe('https://relay.dool2.com/push')
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(['data', 'token'])
    expect(JSON.stringify(calls[0]?.body)).not.toContain('안녕')
    status = 410
    expect(await sendAppPush(reg, { title: 'x', body: 'y', tag: 't' }, { fetch: fake })).toBe('gone')
    status = 500
    expect(await sendAppPush(reg, { title: 'x', body: 'y', tag: 't' }, { fetch: fake })).toBe('failed')
  })
})
