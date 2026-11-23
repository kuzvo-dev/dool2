// Relay rules, shared by the Node version (index.ts) and the Cloudflare version (worker.ts).
// No platform APIs (sockets, storage) here, only decisions.
import { deviceId, type Envelope, verifyText } from '@dool2/protocol/e2e'
import { helloText } from '@dool2/protocol/link'

export const MAX_MESSAGE = 512 * 1024
export const QUEUE_TTL_MS = 7 * 24 * 60 * 60_000
export const QUEUE_MAX = 500
/** Envelope kinds that are never queued (they only matter to someone watching right now) */
export const LIVE_KINDS = new Set(['screen', 'remote', 'stream'])
/** Trim the queue once every this many envelopes (trimming reads many rows) */
export const TRIM_EVERY = 50
export const AUTH_SKEW_MS = 2 * 60_000
/** Close the connection if it does not prove itself within this time after connecting */
export const AUTH_TIMEOUT_MS = 10_000
/** Messages per second per connection: generous for the PC (it streams replies and live screens to several
 *  phones), low for phones. Over the limit the connection is closed (messages in between are lost, so the limit is
 *  set where normal use never reaches it) */
export const RATE_LIMIT = { pc: 600, phone: 60 } as const

/** First message after connecting. Signs ts so another connection cannot replay the proof */
export interface Hello {
  role: 'pc' | 'phone'
  id: string
  signPub: string
  /** Phone: the PC room to join */
  room?: string
  ts: number
  sig: string
}

export interface Me {
  id: string
  role: 'pc' | 'phone'
  /** The room this device belongs to (PC id) */
  room: string
}

/** Close codes */
export const CLOSE = {
  helloTimeout: 4001,
  badJson: 4002,
  badHello: 4003,
  replaced: 4004,
  badFrom: 4005,
  tooBig: 4006,
  tooFast: 4008,
} as const

/**
 * Checks that the first message is a valid device proof. Returns the device if so, otherwise undefined.
 * urlRoom: the room in the connect URL (`/link?room=`). If present, it must match the proven room
 */
export async function checkHello(msg: unknown, now: number, urlRoom?: string): Promise<Me | undefined> {
  const h = msg as Hello
  const shape =
    (h?.role === 'pc' || h?.role === 'phone') &&
    typeof h.id === 'string' &&
    typeof h.signPub === 'string' &&
    typeof h.sig === 'string' &&
    Math.abs(now - Number(h.ts)) < AUTH_SKEW_MS &&
    (h.role === 'pc' || typeof h.room === 'string')
  if (!shape) return undefined
  const room = h.role === 'pc' ? h.id : (h.room as string)
  if (urlRoom !== undefined && urlRoom !== room) return undefined
  if ((await deviceId(h.signPub).catch(() => '')) !== h.id) return undefined
  if (!(await verifyText(h.signPub, helloText(h), h.sig))) return undefined
  return { id: h.id, role: h.role, room }
}

export type Route =
  | { ok: false; close: number; reason: string }
  /** drop: silently discard (envelope for another room) */
  | { ok: true; drop: true }
  | { ok: true; drop: false; to: string; queue: boolean }

/**
 * Decides where to send an envelope from a proven device.
 * roomOf: returns the receiving device's room if known (needed by the Node version, which holds all rooms together)
 */
export function route(me: Me, msg: unknown, roomOf?: (id: string) => string | undefined): Route {
  const env = msg as Envelope
  if (env?.from !== me.id || typeof env.to !== 'string')
    return { ok: false, close: CLOSE.badFrom, reason: 'bad from' }
  // A phone may only send to the PC of its room, and a PC only to phones in its room
  if (me.role === 'phone' && env.to !== me.room) return { ok: true, drop: true }
  const targetRoom = roomOf?.(env.to)
  if (me.role === 'pc' && targetRoom !== undefined && targetRoom !== me.id) return { ok: true, drop: true }
  // Remote screens and streamed replies only matter to someone watching now. Do not queue them for offline devices
  // (a phone re-fetches the chat from the start when it reconnects. Measured: queued stream chunks from 150 test
  // chats used 90% of the daily read limit)
  return { ok: true, drop: false, to: env.to, queue: !LIVE_KINDS.has(String(env.kind)) }
}
