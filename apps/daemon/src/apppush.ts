// Store app notifications (ADR 0042). The phone app runs in a WebView, which cannot get web push, so the store app
// registers with FCM instead.
//
// - The phone makes its own 32-byte notification key and sends it with the FCM token over the encrypted link
// - The PC encrypts the notification (title, body, tag, where to open) with that key: AES-256-GCM
// - The official relay hands the ciphertext to FCM as a data message, so neither Google nor the relay can read it
// - The phone app opens it itself and shows the notification
// The FCM sending key belongs to the store app's Firebase project, so it lives on the official relay, not in this
// open source PC app. A self-hosted relay does not change this: notifications always go through the official one.
import { createCipheriv, randomBytes } from 'node:crypto'
import type { AppPushReg } from '@dool2/protocol'
import { OFFICIAL_RELAY } from '@dool2/protocol/link'
import type { PushMessage, PushResult } from './webpush.js'

/** Where the PC hands notifications to (the official relay) */
export const APP_PUSH_URL = `${OFFICIAL_RELAY}/push`

/** FCM data messages are at most 4KB: keep the encrypted content well under that */
export const APP_PUSH_MAX = 3_000

const TOKEN_RE = /^[\w:.-]{20,4096}$/

/** Checks what the phone sent before it is saved */
export function validAppPush(reg: unknown): reg is AppPushReg {
  if (!reg || typeof reg !== 'object') return false
  const { token, key } = reg as Record<string, unknown>
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false
  if (typeof key !== 'string' || !/^[\w-]{43}$/.test(key)) return false
  return Buffer.from(key, 'base64url').length === 32
}

/** Encrypts the notification for the phone: base64url(12-byte nonce || ciphertext || 16-byte tag) */
export function sealAppPush(key: string, msg: PushMessage): string {
  const k = Buffer.from(key, 'base64url')
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', k, iv)
  // Long bodies are cut so the whole thing fits in one FCM message
  let body = msg.body
  let plain = Buffer.from(JSON.stringify({ ...msg, body }))
  while (plain.length > (APP_PUSH_MAX * 3) / 4 - 28 && body.length > 0) {
    body = `${body.slice(0, Math.max(0, body.length - 80))}…`
    if (body === '…') body = ''
    plain = Buffer.from(JSON.stringify({ ...msg, body }))
  }
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
  return Buffer.concat([iv, ct]).toString('base64url')
}

/** Hands one notification to the official relay. 'gone' means FCM no longer knows the token (app removed, etc.) */
export async function sendAppPush(
  reg: AppPushReg,
  msg: PushMessage,
  opts: { fetch?: typeof fetch; url?: string } = {},
): Promise<PushResult> {
  try {
    const res = await (opts.fetch ?? fetch)(opts.url ?? APP_PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: reg.token, data: sealAppPush(reg.key, msg) }),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 410) return 'gone'
    return res.ok ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}
