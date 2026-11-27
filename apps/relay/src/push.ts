// Store app notifications (ADR 0042): POST /push {token, data} -> one FCM data message.
//
// - `data` is the notification already encrypted by the PC with the phone's own key. The relay cannot read it, and
//   neither can FCM. The phone app opens it itself and shows the notification
// - The FCM sending key (a Firebase service account) is a Cloudflare secret, FCM_SERVICE_ACCOUNT. It is not in the
//   open source PC app, which is why notifications go through here
// - Anyone could call this, but a token only reaches the Dool2 app on that phone, and the app shows nothing it cannot
//   open with its key. Per-token rate limit so a token cannot be flooded
// Uses only fetch and WebCrypto, so it runs on Workers and in Node tests the same.

/** Encrypted notification size limit (the PC keeps it under 3,000: apps/daemon/src/apppush.ts) */
export const PUSH_DATA_MAX = 3_000
/** Notifications per token per minute */
export const PUSH_PER_MINUTE = 30

const TOKEN_RE = /^[\w:.-]{20,4096}$/
const DATA_RE = /^[\w-]+$/
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
}

export interface PushDeps {
  /** The service account JSON (Cloudflare secret). Without it /push answers 503 */
  account?: string
  fetch?: typeof fetch
  now?: () => number
}

const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (const x of u) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64uText = (s: string) => b64u(new TextEncoder().encode(s))

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Google OAuth access token for FCM, kept until a minute before it runs out (per isolate) */
let cached: { email: string; token: string; until: number } | undefined

async function accessToken(sa: ServiceAccount, deps: PushDeps): Promise<string> {
  const now = deps.now?.() ?? Date.now()
  if (cached && cached.email === sa.client_email && cached.until > now) return cached.token
  const iat = Math.floor(now / 1000)
  const head = b64uText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64uText(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }),
  )
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${head}.${claims}`),
  )
  const res = await (deps.fetch ?? fetch)(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claims}.${b64u(sig)}`,
    }),
  })
  if (!res.ok) throw new Error(`oauth ${res.status}`)
  const j = (await res.json()) as { access_token: string; expires_in?: number }
  cached = {
    email: sa.client_email,
    token: j.access_token,
    until: now + ((j.expires_in ?? 3600) - 60) * 1000,
  }
  return j.access_token
}

/** Sends per token in the last minute (per isolate: a best-effort limit, FCM has its own limits behind it) */
const recent = new Map<string, number[]>()

function tooMany(token: string, now: number): boolean {
  const list = (recent.get(token) ?? []).filter((t) => now - t < 60_000)
  if (list.length >= PUSH_PER_MINUTE) {
    recent.set(token, list)
    return true
  }
  list.push(now)
  recent.set(token, list)
  if (recent.size > 10_000) recent.clear()
  return false
}

const reply = (status: number, text = '') => new Response(text, { status })

/** Handles POST /push. 200 sent, 410 FCM no longer knows the token (the PC removes it), others: try again later */
export async function handlePush(req: Request, deps: PushDeps): Promise<Response> {
  if (req.method !== 'POST') return reply(405)
  if (!deps.account) return reply(503, 'push is not set up')
  const raw = await req.text()
  if (raw.length > PUSH_DATA_MAX + 4_200) return reply(413)
  let body: { token?: unknown; data?: unknown }
  try {
    body = JSON.parse(raw)
  } catch {
    return reply(400)
  }
  const { token, data } = body
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return reply(400, 'bad token')
  if (typeof data !== 'string' || data.length > PUSH_DATA_MAX || !DATA_RE.test(data))
    return reply(400, 'bad data')
  const now = deps.now?.() ?? Date.now()
  if (tooMany(token, now)) return reply(429)

  let sa: ServiceAccount
  try {
    sa = JSON.parse(deps.account) as ServiceAccount
  } catch {
    return reply(503, 'push is not set up')
  }
  let access: string
  try {
    access = await accessToken(sa, deps)
  } catch {
    return reply(502)
  }
  const res = await (deps.fetch ?? fetch)(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      // A data message (no notification part), so FCM never shows anything itself: the app opens it and shows it.
      // High priority so it arrives while the phone is asleep; kept a day if the phone is off
      body: JSON.stringify({
        message: { token, data: { d: data }, android: { priority: 'HIGH', ttl: '86400s' } },
      }),
    },
  )
  if (res.ok) return reply(200)
  if (res.status === 404) return reply(410)
  if (res.status === 400) {
    const t = await res.text().catch(() => '')
    // A token that was never valid (or is from another app) is also gone for good
    if (/UNREGISTERED|registration token/i.test(t)) return reply(410)
    return reply(400)
  }
  if (res.status === 401 || res.status === 403) cached = undefined
  return reply(502)
}

/** For tests: forget the cached access token and the rate limit */
export function resetPushState() {
  cached = undefined
  recent.clear()
}
