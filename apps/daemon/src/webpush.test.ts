import { createDecipheriv, createECDH, hkdfSync, verify } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  allowedEndpoint,
  encryptPayload,
  generateVapid,
  sendPush,
  vapidHeader,
  vapidPublicKeyObject,
} from './webpush.js'

const u = (s: string) => Buffer.from(s, 'base64url')

/** 폰 브라우저가 하는 일: 머리를 읽고 같은 방법으로 키를 만들어 푼다 */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const ua = createECDH('prime256v1')
  ua.setPrivateKey(uaPrivate)
  const salt = body.subarray(0, 16)
  const idlen = body.readUInt8(20)
  const asPublic = body.subarray(21, 21 + idlen)
  const ct = body.subarray(21 + idlen)
  const shared = ua.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(ct.length - 16))
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  expect(out.at(-1)).toBe(2)
  return out.subarray(0, -1).toString()
}

describe('웹 푸시', () => {
  it('RFC 8291 부록 A 예시와 똑같이 암호화한다', () => {
    const body = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      {
        endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
        keys: {
          p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
          auth: 'BTBZMqHH6r4Tts7J_aSIgg',
        },
      },
      { salt: u('DGv6ra1nlYgDCS1FRnbzlw'), asPrivate: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') },
    )
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    )
  })

  it('폰 쪽에서 풀 수 있게 암호화하고, VAPID 서명은 공개키로 확인된다', async () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const auth = Buffer.alloc(16, 7)
    const sub = {
      endpoint: 'http://127.0.0.1/x',
      keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    }
    const keys = generateVapid()
    let got: { headers: Record<string, string | string[] | undefined>; body: Buffer } | undefined
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        got = { headers: req.headers, body: Buffer.concat(chunks) }
        res.writeHead(201).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    sub.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/push/abc`
    const r = await sendPush(sub, { title: '승인을 기다려요', body: '사과 1kg · 9,900원', tag: 'a1' }, keys, {
      allow: () => true,
    })
    server.close()
    expect(r).toBe('sent')
    expect(got?.headers['content-encoding']).toBe('aes128gcm')
    expect(JSON.parse(decrypt(got?.body as Buffer, ua.getPrivateKey(), auth))).toMatchObject({
      title: '승인을 기다려요',
      tag: 'a1',
    })
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(String(got?.headers.authorization))
    expect(m?.[4]).toBe(keys.publicKey)
    const ok = verify(
      'sha256',
      Buffer.from(`${m?.[1]}.${m?.[2]}`),
      { key: vapidPublicKeyObject(keys.publicKey), dsaEncoding: 'ieee-p1363' },
      u(m?.[3] ?? ''),
    )
    expect(ok).toBe(true)
    expect(JSON.parse(u(m?.[2] ?? '').toString())).toMatchObject({ aud: new URL(sub.endpoint).origin })
  })

  it('알려진 푸시 서비스 주소로만 보낸다', async () => {
    expect(allowedEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true)
    expect(allowedEndpoint('https://web.push.apple.com/QOlz')).toBe(true)
    expect(allowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true)
    expect(allowedEndpoint('http://fcm.googleapis.com/x')).toBe(false)
    expect(allowedEndpoint('https://127.0.0.1/x')).toBe(false)
    expect(allowedEndpoint('https://evil.example/push.apple.com')).toBe(false)
    const keys = generateVapid()
    const sub = { endpoint: 'https://169.254.169.254/latest', keys: { p256dh: 'x', auth: 'y' } }
    expect(await sendPush(sub, { title: 't', body: 'b', tag: 't' }, keys)).toBe('failed')
  })

  it('푸시 서비스가 410이면 구독이 없어진 것으로 본다', async () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16).toString('base64url') },
    }
    const fake = (async () => new Response(null, { status: 410 })) as typeof fetch
    expect(await sendPush(sub, { title: 't', body: 'b', tag: 't' }, generateVapid(), { fetch: fake })).toBe(
      'gone',
    )
    expect(vapidHeader(sub.endpoint, generateVapid())).toMatch(/^vapid t=.+, k=.+$/)
  })
})
