// Official Dool2 relay (Cloudflare Workers + Durable Objects). Same rules as the Node version (core.ts).
//
// - One Durable Object per PC room (PC id). The connect URL `/link?room=<PC id>` goes straight to that room
// - WebSocket Hibernation: connections stay open but the object sleeps when there are no messages (no charge)
// - Envelopes for offline devices are kept as ciphertext in the room's SQLite for up to 7 days
// - The phone app is not served here. It ships only as a store app (so the server cannot swap the app code)
import { DurableObject } from 'cloudflare:workers'
import {
  AUTH_TIMEOUT_MS,
  CLOSE,
  checkHello,
  MAX_MESSAGE,
  type Me,
  QUEUE_MAX,
  QUEUE_TTL_MS,
  RATE_LIMIT,
  route,
  TRIM_EVERY,
} from './core.js'

export interface Env {
  ROOMS: DurableObjectNamespace<RelayRoom>
}

/** Room name (PC id) is 16 bytes of the signing public key hash in base64url -> 22 chars */
const ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') return new Response('ok')
    if (url.pathname !== '/link') return new Response('Not found', { status: 404 })
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('WebSocket only', { status: 426 })
    const room = url.searchParams.get('room') ?? ''
    if (!ROOM_RE.test(room)) return new Response('room is required', { status: 400 })
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req)
  },
} satisfies ExportedHandler<Env>

/** State attached to each socket. Survives hibernation */
interface Attachment {
  room: string
  at: number
  me?: Me
}

export class RelayRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage
  /** Messages sent per 1-second window. Lost on hibernation, which is fine: it means nothing was sent meanwhile */
  private readonly rate = new WeakMap<WebSocket, { at: number; n: number }>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS queue (n INTEGER PRIMARY KEY AUTOINCREMENT, to_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)',
    )
    this.sql.exec('CREATE INDEX IF NOT EXISTS queue_to ON queue (to_id, n)')
  }

  async fetch(req: Request): Promise<Response> {
    const room = new URL(req.url).searchParams.get('room') ?? ''
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ room, at: Date.now() } satisfies Attachment)
    await this.wakeAt(Date.now() + AUTH_TIMEOUT_MS)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return ws.close(CLOSE.badJson, 'text only')
    if (raw.length > MAX_MESSAGE) return ws.close(CLOSE.tooBig, 'too big')
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      return ws.close(CLOSE.badJson, 'bad json')
    }
    const a = ws.deserializeAttachment() as Attachment
    const now = Date.now()
    if (!a.me) {
      if (now - a.at > AUTH_TIMEOUT_MS) return ws.close(CLOSE.helloTimeout, 'hello timeout')
      const me = await checkHello(msg, now, a.room)
      if (!me) return ws.close(CLOSE.badHello, 'bad hello')
      // If the same device reconnects, close the old connection
      for (const other of this.socketOf(me.id)) other.close(CLOSE.replaced, 'replaced')
      ws.serializeAttachment({ ...a, me } satisfies Attachment)
      ws.send(JSON.stringify({ relay: 'ready', id: me.id }))
      this.flush(me.id, ws)
      return
    }
    const r0 = this.rate.get(ws)
    const r = r0 && now - r0.at < 1_000 ? r0 : { at: now, n: 0 }
    this.rate.set(ws, r)
    if (++r.n > RATE_LIMIT[a.me.role]) return ws.close(CLOSE.tooFast, 'too fast')

    // Only this PC and its phones join this room, so the PC always sends within its own room
    const dest = route(a.me, msg)
    if (!dest.ok) return ws.close(dest.close, dest.reason)
    if (dest.drop) return
    const target = this.socketOf(dest.to)[0]
    if (target) target.send(raw)
    else if (dest.queue) await this.enqueue(dest.to, raw, now)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason)
    } catch {
      // already closed
    }
  }

  async webSocketError(): Promise<void> {}

  /** Close unproven connections and delete old envelopes */
  async alarm(): Promise<void> {
    const now = Date.now()
    let pending = false
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment
      if (a.me) continue
      if (now - a.at > AUTH_TIMEOUT_MS) ws.close(CLOSE.helloTimeout, 'hello timeout')
      else pending = true
    }
    this.sql.exec('DELETE FROM queue WHERE at < ?', now - QUEUE_TTL_MS)
    const oldest = this.sql.exec<{ at: number }>('SELECT MIN(at) AS at FROM queue').one().at
    if (pending) await this.wakeAt(now + AUTH_TIMEOUT_MS)
    else if (oldest) await this.wakeAt(oldest + QUEUE_TTL_MS)
  }

  /** Connections of the given proven device */
  private socketOf(id: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Attachment).me?.id === id)
  }

  /** Envelopes queued per receiver since the last trim (restarts at 0 after hibernation: still trims within TRIM_EVERY) */
  private readonly sinceTrim = new Map<string, number>()

  private async enqueue(to: string, data: string, now: number) {
    this.sql.exec('INSERT INTO queue (to_id, at, data) VALUES (?, ?, ?)', to, now, data)
    // Trimming re-reads the queue (up to QUEUE_MAX rows), so doing it per envelope multiplies reads: only once every few
    const n = (this.sinceTrim.get(to) ?? 0) + 1
    this.sinceTrim.set(to, n % TRIM_EVERY)
    if (n < TRIM_EVERY) {
      await this.wakeAt(now + QUEUE_TTL_MS)
      return
    }
    this.sql.exec(
      'DELETE FROM queue WHERE to_id = ? AND n NOT IN (SELECT n FROM queue WHERE to_id = ? ORDER BY n DESC LIMIT ?)',
      to,
      to,
      QUEUE_MAX,
    )
    await this.wakeAt(now + QUEUE_TTL_MS)
  }

  private flush(id: string, ws: WebSocket) {
    const since = Date.now() - QUEUE_TTL_MS
    const rows = this.sql
      .exec<{ data: string }>('SELECT data FROM queue WHERE to_id = ? AND at >= ? ORDER BY n', id, since)
      .toArray()
    this.sql.exec('DELETE FROM queue WHERE to_id = ?', id)
    for (const r of rows) ws.send(r.data)
  }

  /** There is only one alarm, so keep an existing earlier one */
  private async wakeAt(t: number) {
    const cur = await this.ctx.storage.getAlarm()
    if (cur === null || cur > t) await this.ctx.storage.setAlarm(t)
  }
}
