// A small local HTTP API over an Agentd session. Loopback only (127.0.0.1), a bearer token on every endpoint but
// /health, and Host/Origin checks — the posture of a normal local daemon, so a web page in the user's browser cannot
// drive it. Endpoints:
//
//   GET  /health                      -> { ok: true }                      (no token)
//   POST /message { message, url?, level? }  -> SSE stream of turn events, one `data:` JSON object per event,
//                                               then a final `event: result` with the SendResult summary.
//   POST /approve { hash, signature } -> the ApproveResult (phone signature verified + consumed)
//   GET  /pending                     -> the approval cards still awaiting a signature
//   GET  /drafts                      -> the review-pending learned site-skill drafts + the library coverage KPIs
//
// Streaming uses Server-Sent Events: each AgentdEvent is written as it is emitted, so a client (the desktop app, or a
// phone watching) sees text and tool calls live. Secrets never appear in any event or response.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Agentd, AgentdEvent } from './agentd.js'

export interface HttpServerOptions {
  agentd: Agentd
  /** The bearer token required on every endpoint but /health. Generate a random one per launch if you have none. */
  token: string
  /** Port to bind on 127.0.0.1. 0 picks a free port (read it back from address()). Default 0. */
  port?: number
  /** Optional log sink for one-line notes. */
  log?: (line: string) => void
}

export interface RunningHttpServer {
  server: Server
  url: string
  port: number
  close(): Promise<void>
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])

/** Start the local HTTP API. Resolves once it is listening. */
export function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const log = opts.log ?? (() => {})
  const server = createServer((req, res) => {
    handle(req, res, opts, log).catch((err: unknown) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    })
  })

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const url = `http://127.0.0.1:${port}`
      log(`agentd listening on ${url}`)
      resolve({
        server,
        url,
        port,
        close: () => new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done()))),
      })
    })
  })
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HttpServerOptions,
  log: (line: string) => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  // Host/Origin checks: reject anything that is not a loopback host, and any cross-origin browser request.
  if (!hostAllowed(req)) return void sendJson(res, 403, { error: 'host not allowed' })
  if (!originAllowed(req)) return void sendJson(res, 403, { error: 'origin not allowed' })

  if (req.method === 'GET' && path === '/health') {
    return void sendJson(res, 200, { ok: true, level: opts.agentd.level })
  }

  // Everything else needs the token.
  if (!tokenOk(req, opts.token)) return void sendJson(res, 401, { error: 'unauthorized' })

  if (req.method === 'GET' && path === '/pending') {
    return void sendJson(res, 200, { pending: opts.agentd.pending() })
  }

  // The learn-by-watching review surface: the review-pending site-skill drafts + the library KPIs for the dashboard.
  if (req.method === 'GET' && path === '/drafts') {
    return void sendJson(res, 200, { drafts: opts.agentd.drafts(), coverage: opts.agentd.coverage() })
  }

  // Autonomy level change (ADR 0047). Raising to full-auto requires a phone-signed consent in the body; ask/auto do
  // not. On refusal the daemon stays at the previous level and returns a machine reason.
  if (req.method === 'POST' && path === '/level') {
    const body = await readJson(req)
    if (body.level !== 'ask' && body.level !== 'auto' && body.level !== 'full') {
      return void sendJson(res, 400, { error: 'level must be ask, auto or full' })
    }
    const consent =
      body.consent && typeof body.consent === 'object'
        ? (body.consent as Parameters<Agentd['setLevel']>[1])
        : undefined
    const result = opts.agentd.setLevel(body.level, consent)
    log(`setLevel ${body.level} -> ${result.ok ? 'ok' : result.reason}`)
    return void sendJson(res, result.ok ? 200 : 400, result)
  }

  // Turn full-auto off (a revoke or a device lock).
  if (req.method === 'POST' && path === '/revoke-full-auto') {
    opts.agentd.revokeFullAuto()
    return void sendJson(res, 200, { ok: true, level: opts.agentd.level })
  }

  // The current spend state: won spent this period, the user cap, and the effective cap = min(user, org).
  if (req.method === 'GET' && path === '/spending') {
    return void sendJson(res, 200, opts.agentd.spending())
  }

  // Spending cap: onboarding sets it unsigned ({ cap }); a later change requires a phone-signed update ({ update }).
  if (req.method === 'POST' && path === '/spending-cap') {
    const body = await readJson(req)
    if (body.update && typeof body.update === 'object') {
      const result = opts.agentd.updateSpendingCap(body.update as Parameters<Agentd['updateSpendingCap']>[0])
      log(`updateSpendingCap -> ${result.ok ? 'ok' : result.reason}`)
      return void sendJson(res, result.ok ? 200 : 400, result)
    }
    const cap = body.cap as { amountKrw?: unknown; period?: unknown } | undefined
    if (!cap || typeof cap.amountKrw !== 'number' || (cap.period !== 'day' && cap.period !== 'month')) {
      return void sendJson(res, 400, { error: 'cap { amountKrw: number, period: day|month } is required' })
    }
    opts.agentd.setSpendingCap({ amountKrw: cap.amountKrw, period: cap.period })
    return void sendJson(res, 200, { ok: true, ...opts.agentd.spending() })
  }

  if (req.method === 'POST' && path === '/approve') {
    const body = await readJson(req)
    const hash = typeof body.hash === 'string' ? body.hash : undefined
    const signature = typeof body.signature === 'string' ? body.signature : undefined
    if (!hash || !signature) return void sendJson(res, 400, { error: 'hash and signature are required' })
    const result = opts.agentd.approve(hash, signature)
    log(`approve ${hash.slice(0, 12)}… -> ${result.ok ? 'ok' : result.reason}`)
    return void sendJson(res, result.ok ? 200 : 400, result)
  }

  if (req.method === 'POST' && path === '/message') {
    const body = await readJson(req)
    const message = typeof body.message === 'string' ? body.message : undefined
    if (!message) return void sendJson(res, 400, { error: 'message is required' })
    const sendOpts: Parameters<Agentd['send']>[1] = {}
    if (typeof body.url === 'string') sendOpts.url = body.url
    if (body.level === 'ask' || body.level === 'auto' || body.level === 'full') sendOpts.level = body.level
    return void (await streamTurn(res, opts.agentd, message, sendOpts, log))
  }

  sendJson(res, 404, { error: 'not found' })
}

/** Run a turn and stream each event as an SSE message, then a final `result` event with the SendResult. */
async function streamTurn(
  res: ServerResponse,
  agentd: Agentd,
  message: string,
  sendOpts: Parameters<Agentd['send']>[1],
  log: (line: string) => void,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const write = (event: AgentdEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  try {
    const result = await agentd.send(message, { ...sendOpts, onEvent: write })
    res.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`)
    log(`turn done: stop=${result.stop} approvals=${result.approvalsNeeded.length}`)
  } catch (err) {
    res.write(
      `event: error\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`,
    )
  } finally {
    res.end()
  }
}

// --- security helpers ---------------------------------------------------------------------------------------------

function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (!host) return true // no Host header (e.g. a raw local client) is fine on a loopback socket
  const name = host.split(':')[0] ?? ''
  return LOOPBACK_HOSTS.has(name)
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true // non-browser clients send no Origin
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname)
  } catch {
    return false
  }
}

function tokenOk(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return safeEqual(auth.slice('Bearer '.length), token)
  return false
}

/** Constant-time-ish string compare, so the token check does not leak length/prefix via timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// --- body helpers -------------------------------------------------------------------------------------------------

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new Error('invalid JSON body')
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}
