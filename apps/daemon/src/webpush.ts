// 웹 푸시 (RFC 8030 보내기, RFC 8291 내용 암호화, RFC 8292 VAPID). 라이브러리 없이 node:crypto만 쓴다.
//
// PC가 폰의 푸시 서비스(애플·구글 등)로 직접 보낸다. 중계 서버는 거치지 않는다.
// 내용은 폰 브라우저만 풀 수 있게 암호화되므로 푸시 서비스도 읽을 수 없다.
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  type KeyObject,
  randomBytes,
  sign,
} from 'node:crypto'

/** 폰 브라우저의 PushSubscription.toJSON() 중 필요한 것 */
export interface PushSubscriptionLike {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** 알림에 실을 내용 (폰의 서비스 워커가 그대로 띄운다) */
export interface PushMessage {
  title: string
  body: string
  /** 같은 tag의 알림은 새 것으로 바뀐다 */
  tag: string
  /** 알림을 누르면 열 앱 주소 뒤쪽 (#a=승인 id, #t=대화 id) */
  url?: string
}

/** 이 주소들로만 보낸다 (폰이 엉뚱한 주소를 알려 PC가 아무 데나 요청하지 않게) */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/,
]

export function allowedEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint)
    return u.protocol === 'https:' && PUSH_HOSTS.some((r) => r.test(u.hostname))
  } catch {
    return false
  }
}

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url')
const unb64u = (s: string) => Buffer.from(s, 'base64url')

// ── VAPID ──

export interface VapidKeys {
  /** 공개키 (압축 안 한 65바이트, base64url). 폰의 applicationServerKey */
  publicKey: string
  /** 개인키 (PKCS#8 DER, base64url) */
  privateKey: string
}

export function generateVapid(): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const pub = ecdh.getPublicKey()
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64u(pub.subarray(1, 33)),
    y: b64u(pub.subarray(33, 65)),
    d: b64u(ecdh.getPrivateKey()),
  }
  const priv = createPrivateKey({ key: jwk, format: 'jwk' })
  return { publicKey: b64u(pub), privateKey: b64u(priv.export({ format: 'der', type: 'pkcs8' })) }
}

/** VAPID 서명(JWT). aud는 푸시 서비스 주소의 origin */
export function vapidHeader(
  endpoint: string,
  keys: VapidKeys,
  opts: { subject?: string; now?: number } = {},
): string {
  const key = createPrivateKey({ key: unb64u(keys.privateKey), format: 'der', type: 'pkcs8' })
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor((opts.now ?? Date.now()) / 1000) + 12 * 3600,
        sub: opts.subject ?? 'https://dool2.com',
      }),
    ),
  )
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`
}

/** 테스트용: VAPID 공개키를 KeyObject로 */
export function vapidPublicKeyObject(publicKey: string): KeyObject {
  const pub = unb64u(publicKey)
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  })
}

// ── 내용 암호화 (aes128gcm, 레코드 하나) ──

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number) =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, len))

export function encryptPayload(
  plaintext: Buffer,
  sub: PushSubscriptionLike,
  /** 테스트용: 고정 salt와 PC 쪽 임시 개인키 (RFC 8291 부록 A 예시와 맞춰 보려고) */
  opts: { salt?: Buffer; asPrivate?: Buffer } = {},
): Buffer {
  const uaPublic = unb64u(sub.keys.p256dh)
  const authSecret = unb64u(sub.keys.auth)
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('푸시 구독 키가 올바르지 않아요')
  const as = createECDH('prime256v1')
  if (opts.asPrivate) as.setPrivateKey(opts.asPrivate)
  else as.generateKeys()
  const asPublic = as.getPublicKey()
  const shared = as.computeSecret(uaPublic)
  // RFC 8291: IKM = HKDF(salt=auth, ikm=ECDH, info="WebPush: info\0" || ua_public || as_public)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hkdf(shared, authSecret, keyInfo, 32)
  const salt = opts.salt ?? randomBytes(16)
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 마지막(이자 하나뿐인) 레코드 표시 0x02
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, body, cipher.getAuthTag()])
}

// ── 보내기 ──

export type PushResult = 'sent' | 'gone' | 'failed'

export async function sendPush(
  sub: PushSubscriptionLike,
  msg: PushMessage,
  keys: VapidKeys,
  opts: { fetch?: typeof fetch; allow?: (endpoint: string) => boolean; ttl?: number } = {},
): Promise<PushResult> {
  if (!(opts.allow ?? allowedEndpoint)(sub.endpoint)) return 'failed'
  const body = encryptPayload(Buffer.from(JSON.stringify(msg)), sub)
  try {
    const res = await (opts.fetch ?? fetch)(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidHeader(sub.endpoint, keys),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(opts.ttl ?? 24 * 3600),
        urgency: 'high',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    // 404·410: 폰에서 알림을 끄거나 앱을 지웠다
    if (res.status === 404 || res.status === 410) return 'gone'
    return res.ok ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}
