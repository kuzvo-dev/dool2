import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { handlePush, PUSH_PER_MINUTE, resetPushState } from './push.js'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const account = JSON.stringify({
  project_id: 'dool2-test',
  client_email: 'push@dool2-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
})
const token = `fcm:${'t'.repeat(150)}`

function fakeFcm(status = 200, text = '') {
  const calls: { url: string; init: RequestInit }[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url.includes('oauth2')) return Response.json({ access_token: 'ya29.x', expires_in: 3600 })
    return new Response(text, { status })
  }) as unknown as typeof fetch
  return { f, calls }
}

const post = (body: unknown) =>
  new Request('https://relay.dool2.com/push', { method: 'POST', body: JSON.stringify(body) })

describe('POST /push (ADR 0042)', () => {
  beforeEach(() => resetPushState())

  it('설정이 없으면 503', async () => {
    expect((await handlePush(post({ token, data: 'abc' }), {})).status).toBe(503)
  })

  it('암호문을 FCM 데이터 메시지로만 넘긴다 (알림 부분 없음)', async () => {
    const { f, calls } = fakeFcm()
    const r = await handlePush(post({ token, data: 'c2VhbGVk' }), { account, fetch: f })
    expect(r.status).toBe(200)
    const oauth = calls[0]
    expect(String(oauth?.init.body)).toContain('grant_type=urn')
    const send = calls[1] as { url: string; init: RequestInit }
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/dool2-test/messages:send')
    expect((send.init.headers as Record<string, string>).authorization).toBe('Bearer ya29.x')
    const msg = JSON.parse(String(send.init.body)).message
    expect(msg).toEqual({ token, data: { d: 'c2VhbGVk' }, android: { priority: 'HIGH', ttl: '86400s' } })
    // 두 번째는 받아 둔 접근 토큰을 다시 쓴다
    await handlePush(post({ token, data: 'eA' }), { account, fetch: f })
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1)
  })

  it('잘못된 입력은 거절한다', async () => {
    const { f } = fakeFcm()
    expect((await handlePush(post({ token: 'x', data: 'a' }), { account, fetch: f })).status).toBe(400)
    expect((await handlePush(post({ token, data: 'has space' }), { account, fetch: f })).status).toBe(400)
    expect((await handlePush(post({ token, data: 'a'.repeat(3_001) }), { account, fetch: f })).status).toBe(
      400,
    )
    expect(
      (await handlePush(new Request('https://x/push', { method: 'GET' }), { account, fetch: f })).status,
    ).toBe(405)
  })

  it('FCM이 토큰을 모르면 410 (PC가 지운다)', async () => {
    expect((await handlePush(post({ token, data: 'a' }), { account, fetch: fakeFcm(404).f })).status).toBe(
      410,
    )
    const bad = fakeFcm(400, '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}')
    expect((await handlePush(post({ token, data: 'a' }), { account, fetch: bad.f })).status).toBe(410)
  })

  it('토큰 하나에 1분에 정해진 수까지만', async () => {
    const { f } = fakeFcm()
    for (let i = 0; i < PUSH_PER_MINUTE; i++)
      expect(
        (await handlePush(post({ token, data: 'a' }), { account, fetch: f, now: () => 1_000 })).status,
      ).toBe(200)
    expect(
      (await handlePush(post({ token, data: 'a' }), { account, fetch: f, now: () => 1_000 })).status,
    ).toBe(429)
    expect(
      (await handlePush(post({ token, data: 'a' }), { account, fetch: f, now: () => 70_000 })).status,
    ).toBe(200)
  })
})
