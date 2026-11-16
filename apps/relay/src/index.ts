// 두리 중계 서버 (ADR 0012). 폰과 PC 사이에서 암호문 봉투만 옮긴다. 내용은 볼 수 없다.
//
// - 연결하면 먼저 "나는 이 기기"임을 Ed25519 서명으로 증명한다 (기기 id = 서명 공개키 해시)
// - 봉투의 from은 증명한 기기여야 한다 (남을 사칭할 수 없다)
// - PC 방(id)마다 PC 하나와 폰 여럿을 잇는다. 받는 쪽이 꺼져 있으면 7일까지 쌓아 두고, 켜지면 넘긴다
// - 누가 페어링된 폰인지는 모른다. 그건 PC가 판단해서 나머지는 버린다
//
// 이 Node 버전은 자체 호스팅·개발용이다. 같은 규약으로 Cloudflare Durable Objects 버전을 배포한다(M5).
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'
import { deviceId, type Envelope, verifyText } from '@dool2/protocol/e2e'
import { helloText } from '@dool2/protocol/link'
import { WebSocket, WebSocketServer } from 'ws'

export const MAX_MESSAGE = 512 * 1024
export const QUEUE_TTL_MS = 7 * 24 * 60 * 60_000
export const QUEUE_MAX = 500
const AUTH_SKEW_MS = 2 * 60_000

/** 연결 직후 첫 메시지. ts를 서명해서 다른 연결의 증명을 다시 쓰지 못하게 한다 */
export interface Hello {
  role: 'pc' | 'phone'
  id: string
  signPub: string
  /** 폰: 연결할 PC 방 */
  room?: string
  ts: number
  sig: string
}

interface Queued {
  at: number
  data: string
}

export interface RelayOptions {
  port?: number
  host?: string
  /** 폰 앱(PWA) 파일 폴더. /app/ 아래로 내려준다 */
  appDir?: string
  now?: () => number
  log?: (line: string) => void
}

export interface Relay {
  url: string
  port: number
  server: Server
  /** 쌓여 있는 봉투 수 (확인용) */
  queued(id: string): number
  close(): Promise<void>
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

export async function startRelay(opts: RelayOptions = {}): Promise<Relay> {
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  /** 기기 id → 연결 (PC는 하나, 폰은 기기마다 하나) */
  const sockets = new Map<string, WebSocket>()
  /** 기기 id → 그 기기가 속한 방(PC id) */
  const rooms = new Map<string, string>()
  const queues = new Map<string, Queued[]>()

  const server = createServer((req, res) => {
    serveHttp(req, res, opts.appDir).catch(() => {
      res.writeHead(500).end()
    })
  })
  const wss = new WebSocketServer({ server, path: '/link', maxPayload: MAX_MESSAGE })

  const enqueue = (to: string, data: string) => {
    const q = (queues.get(to) ?? []).filter((m) => now() - m.at < QUEUE_TTL_MS)
    q.push({ at: now(), data })
    queues.set(to, q.slice(-QUEUE_MAX))
  }
  const flush = (id: string, ws: WebSocket) => {
    const q = (queues.get(id) ?? []).filter((m) => now() - m.at < QUEUE_TTL_MS)
    queues.delete(id)
    for (const m of q) ws.send(m.data)
  }

  wss.on('connection', (ws) => {
    let me: { id: string; role: 'pc' | 'phone'; room: string } | undefined
    const authTimer = setTimeout(() => ws.close(4001, 'hello timeout'), 10_000)
    // 연결마다 1초에 보낼 수 있는 수: PC는 여러 폰에 흘려 쓰는 답·실시간 화면을 보내서 넉넉히, 폰은 적게.
    // 넘으면 끊는다 (끊기면 그사이 메시지를 잃으니, 정상 사용으로는 닿지 않게 잡는다)
    const LIMIT = { pc: 600, phone: 60 }
    let budget = LIMIT.phone
    const refill = setInterval(() => {
      budget = me?.role === 'pc' ? LIMIT.pc : LIMIT.phone
    }, 1_000)

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return ws.close(4002, 'text only')
      const text = raw.toString()
      let msg: unknown
      try {
        msg = JSON.parse(text)
      } catch {
        return ws.close(4002, 'bad json')
      }
      if (!me) {
        const h = msg as Hello
        const ok =
          (h?.role === 'pc' || h?.role === 'phone') &&
          typeof h.id === 'string' &&
          typeof h.signPub === 'string' &&
          typeof h.sig === 'string' &&
          Math.abs(now() - Number(h.ts)) < AUTH_SKEW_MS &&
          (h.role === 'pc' || typeof h.room === 'string') &&
          (await deviceId(h.signPub).catch(() => '')) === h.id &&
          (await verifyText(h.signPub, helloText(h), h.sig))
        if (!ok) return ws.close(4003, 'bad hello')
        clearTimeout(authTimer)
        me = { id: h.id, role: h.role, room: h.role === 'pc' ? h.id : (h.room as string) }
        if (me.role === 'pc') budget = LIMIT.pc
        // 같은 기기가 다시 붙으면 예전 연결을 닫는다
        sockets.get(me.id)?.close(4004, 'replaced')
        sockets.set(me.id, ws)
        rooms.set(me.id, me.room)
        ws.send(JSON.stringify({ relay: 'ready', id: me.id }))
        flush(me.id, ws)
        log(`연결: ${me.role} ${me.id.slice(0, 6)}`)
        return
      }
      if (--budget < 0) return ws.close(4008, 'too fast')
      const env = msg as Envelope
      if (env?.from !== me.id || typeof env.to !== 'string') return ws.close(4005, 'bad from')
      // PC는 자기 방의 폰에게만, 폰은 자기 방의 PC에게만 보낼 수 있다
      if (me.role === 'phone' && env.to !== me.room) return
      if (me.role === 'pc' && rooms.get(env.to) !== undefined && rooms.get(env.to) !== me.id) return
      const target = sockets.get(env.to)
      if (target && target.readyState === WebSocket.OPEN) target.send(text)
      // 원격 화면은 지금 보는 사람에게만 의미가 있다. 꺼진 기기에 쌓아 두지 않는다
      else if (env.kind !== 'screen' && env.kind !== 'remote') enqueue(env.to, text)
    })
    ws.on('close', () => {
      clearTimeout(authTimer)
      clearInterval(refill)
      if (me && sockets.get(me.id) === ws) sockets.delete(me.id)
    })
    ws.on('error', () => {})
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    )
  })
  return {
    url: `http://${opts.host ?? '127.0.0.1'}:${port}`,
    port,
    server,
    queued: (id) => queues.get(id)?.length ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate()
        wss.close()
        server.close(() => resolve())
      }),
  }
}

async function serveHttp(req: IncomingMessage, res: ServerResponse, appDir?: string) {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('ok')
  }
  if (url.pathname === '/') {
    res.writeHead(302, { location: '/app/' })
    return res.end()
  }
  if (!appDir || !url.pathname.startsWith('/app/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('없는 주소예요')
  }
  let rel = decodeURIComponent(url.pathname.slice('/app/'.length)) || 'index.html'
  if (rel.endsWith('/')) rel += 'index.html'
  const file = normalize(join(appDir, rel))
  if (!file.startsWith(normalize(appDir) + sep)) {
    res.writeHead(403).end()
    return
  }
  const st = await stat(file).catch(() => undefined)
  // 앱 안의 화면 이동은 모두 index.html이 처리한다
  const target = st?.isFile() ? file : join(appDir, 'index.html')
  res.writeHead(200, {
    'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
    // 앱은 작고 자주 바뀐다. 매번 새것인지 확인하게 해서 업데이트가 바로 닿게 한다 (아이콘만 오래 둔다)
    'cache-control': extname(target) === '.png' ? 'public, max-age=86400' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self'; script-src 'self'",
  })
  createReadStream(target).pipe(res)
}
