// Web Push (RFC 8030 sending, RFC 8291 content encryption, RFC 8292 VAPID). Uses only node:crypto, no library.
//
// The PC sends straight to the phone's push service (Apple, Google, etc.), not through the relay server.
// The content is encrypted so only the phone browser can open it, so the push service cannot read it either.
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

/** The needed parts of the phone browser's PushSubscription.toJSON() */
export interface PushSubscriptionLike {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** Content of the notification (the phone's service worker shows it as is) */
export interface PushMessage {
  title: string
  body: string
  /** A notification with the same tag is replaced by the new one */
  tag: string
  /** Tail of the app address to open when tapped (#a=approval id, #t=conversation id) */
  url?: string
}

/** Send only to these addresses (so a phone cannot make the PC call arbitrary addresses) */
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
  /** Public key (uncompressed 65 bytes, base64url). The phone's applicationServerKey */
  publicKey: string
  /** Private key (PKCS#8 DER, base64url) */
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

/** VAPID signature (JWT). aud is the origin of the push service address */
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

/** For tests: the VAPID public key as a KeyObject */
export function vapidPublicKeyObject(publicKey: string): KeyObject {
  const pub = unb64u(publicKey)
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  })
}

// -- Content encryption (aes128gcm, a single record) --

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number) =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, len))

export function encryptPayload(
  plaintext: Buffer,
  sub: PushSubscriptionLike,
  /** For tests: fixed salt and the PC-side ephemeral private key (to match the RFC 8291 Appendix A example) */
  opts: { salt?: Buffer; asPrivate?: Buffer } = {},
): Buffer {
  const uaPublic = unb64u(sub.keys.p256dh)
  const authSecret = unb64u(sub.keys.auth)
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Invalid push subscription keys')
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
  // Marker 0x02 for the last (and only) record
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, body, cipher.getAuthTag()])
}

// -- Sending --

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
    // 404/410: the phone turned notifications off or removed the app
    if (res.status === 404 || res.status === 410) return 'gone'
    return res.ok ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}
