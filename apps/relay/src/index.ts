// Dool2 relay (ADR 0012). Only moves ciphertext envelopes between phone and PC. It cannot read the content.
//
// - On connect, a device first proves "I am this device" with an Ed25519 signature (device id = hash of the signing public key)
// - An envelope's `from` must be the proven device (no impersonation)
// - Each PC room (id) links one PC and several phones. If the receiver is offline, envelopes are queued for up to 7 days and delivered when it comes back
// - The relay does not know which phones are paired. The PC decides that and discards the rest
//
// This Node version is for self-hosting and development. The official relay runs the same rules (core.ts) on Cloudflare Durable Objects (worker.ts).
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
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

export { type Hello, MAX_MESSAGE, QUEUE_MAX, QUEUE_TTL_MS } from './core.js'

interface Queued {
  at: number
  data: string
}

export interface RelayOptions {
  port?: number
  host?: string
  /** Phone app (PWA) files folder. Served under /app/ */
  appDir?: string
  now?: () => number
  log?: (line: string) => void
}

export interface Relay {
  url: string
  port: number
  server: Server
  /** Number of queued envelopes (for checks) */
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
  /** Device id -> connection (one for the PC, one per phone) */
  const sockets = new Map<string, WebSocket>()
  /** Device id -> the room (PC id) the device belongs to */
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

  wss.on('connection', (ws, req) => {
    // If the URL carries a room (`/link?room=`), it must match the proven room. Older clients connect without one
    const urlRoom = new URL(req.url ?? '/', 'http://x').searchParams.get('room') ?? undefined
    let me: Me | undefined
    const authTimer = setTimeout(() => ws.close(CLOSE.helloTimeout, 'hello timeout'), AUTH_TIMEOUT_MS)
    let budget: number = RATE_LIMIT.phone
    const refill = setInterval(() => {
      budget = RATE_LIMIT[me?.role ?? 'phone']
    }, 1_000)

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return ws.close(CLOSE.badJson, 'text only')
      const text = raw.toString()
      let msg: unknown
      try {
        msg = JSON.parse(text)
      } catch {
        return ws.close(CLOSE.badJson, 'bad json')
      }
      if (!me) {
        const who = await checkHello(msg, now(), urlRoom)
        if (!who) return ws.close(CLOSE.badHello, 'bad hello')
        clearTimeout(authTimer)
        me = who
        budget = RATE_LIMIT[me.role]
        // If the same device reconnects, close the old connection
        sockets.get(me.id)?.close(CLOSE.replaced, 'replaced')
        sockets.set(me.id, ws)
        rooms.set(me.id, me.room)
        ws.send(JSON.stringify({ relay: 'ready', id: me.id }))
        flush(me.id, ws)
        log(`connected: ${me.role} ${me.id.slice(0, 6)}`)
        return
      }
      if (--budget < 0) return ws.close(CLOSE.tooFast, 'too fast')
      const r = route(me, msg, (id) => rooms.get(id))
      if (!r.ok) return ws.close(r.close, r.reason)
      if (r.drop) return
      const target = sockets.get(r.to)
      if (target && target.readyState === WebSocket.OPEN) target.send(text)
      else if (r.queue) enqueue(r.to, text)
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
    return res.end('Not found')
  }
  let rel = decodeURIComponent(url.pathname.slice('/app/'.length)) || 'index.html'
  if (rel.endsWith('/')) rel += 'index.html'
  const file = normalize(join(appDir, rel))
  if (!file.startsWith(normalize(appDir) + sep)) {
    res.writeHead(403).end()
    return
  }
  const st = await stat(file).catch(() => undefined)
  // index.html handles all in-app navigation
  const target = st?.isFile() ? file : join(appDir, 'index.html')
  res.writeHead(200, {
    'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
    // The app is small and changes often. Revalidate every time so updates land right away (only icons are cached long)
    'cache-control': extname(target) === '.png' ? 'public, max-age=86400' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self'; script-src 'self'",
  })
  createReadStream(target).pipe(res)
}
