// 두리 공식 중계 서버 (Cloudflare Workers + Durable Objects). 규칙은 Node 버전과 같다(core.ts).
//
// - PC 방(PC id)마다 Durable Object 하나. 접속 주소 `/link?room=<PC id>`로 그 방에 바로 붙는다
// - WebSocket Hibernation: 연결은 이어 두되, 메시지가 없을 때는 깨어 있지 않는다(요금 없음)
// - 꺼진 기기로 가는 봉투는 그 방의 SQLite에 암호문 그대로 7일까지 쌓아 둔다
// - 폰 앱은 내려주지 않는다. 폰 앱은 스토어 앱으로만 배포한다(서버가 앱 코드를 바꿔치기할 수 없게)
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
} from './core.js'

export interface Env {
  ROOMS: DurableObjectNamespace<RelayRoom>
}

/** 방 이름(PC id)은 서명 공개키 해시의 base64url 16바이트 → 22자 */
const ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') return new Response('ok')
    if (url.pathname !== '/link') return new Response('없는 주소예요', { status: 404 })
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('WebSocket으로만 붙을 수 있어요', { status: 426 })
    const room = url.searchParams.get('room') ?? ''
    if (!ROOM_RE.test(room)) return new Response('방(room)이 필요해요', { status: 400 })
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req)
  },
} satisfies ExportedHandler<Env>

/** 소켓마다 붙여 두는 상태. 잠들었다 깨어나도 남는다 */
interface Attachment {
  room: string
  at: number
  me?: Me
}

export class RelayRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage
  /** 1초 창마다 보낸 수. 잠들면 사라지는데, 그건 그동안 아무것도 안 보냈다는 뜻이라 괜찮다 */
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
      // 같은 기기가 다시 붙으면 예전 연결을 닫는다
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

    // 이 방에는 이 PC와 그 폰들만 붙는다. 그래서 PC가 보내는 곳은 늘 자기 방이다
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
      // 이미 닫힘
    }
  }

  async webSocketError(): Promise<void> {}

  /** 증명하지 않은 연결을 끊고, 오래된 봉투를 지운다 */
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

  /** 증명을 마친 그 기기의 연결 */
  private socketOf(id: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Attachment).me?.id === id)
  }

  private async enqueue(to: string, data: string, now: number) {
    this.sql.exec('INSERT INTO queue (to_id, at, data) VALUES (?, ?, ?)', to, now, data)
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

  /** 알람은 하나뿐이라, 이미 더 이른 알람이 있으면 그대로 둔다 */
  private async wakeAt(t: number) {
    const cur = await this.ctx.storage.getAlarm()
    if (cur === null || cur > t) await this.ctx.storage.setAlarm(t)
  }
}
