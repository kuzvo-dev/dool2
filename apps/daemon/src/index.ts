// dool2d — 두리 본체. PC 앱 화면(Electron)이 띄우고, 두리 박스에서는 혼자 돈다.
// M0: 로컬 API(127.0.0.1 + 토큰)로 대화를 받아 Claude Code·Codex를 돌리고 기록을 남긴다.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { type ClaudeLogin, ClaudeRuntime } from '@dool2/agent-claude'
import { CodexRuntime } from '@dool2/agent-codex'
import { type AgentRuntime, type McpServerSpec, ThreadService } from '@dool2/engine'
import {
  type AgentId,
  AgentIdSchema,
  ClaudeLoginCodeSchema,
  type ClaudeLoginStatus,
  CreateThreadRequestSchema,
  type DaemonStreamEvent,
  DEFAULT_SETTINGS,
  SendMessageRequestSchema,
  type Settings,
  SettingsPatchSchema,
  SettingsSchema,
} from '@dool2/protocol'
import { Store } from '@dool2/store'
import { dataPaths, defaultDataDir } from './paths.js'

export { dataPaths, defaultDataDir } from './paths.js'

export interface DaemonOptions {
  dataDir?: string
  /** 0이면 빈 포트를 고른다 */
  port?: number
  token?: string
  /** 테스트용: 에이전트를 바꿔 끼운다 */
  runtimes?: Partial<Record<AgentId, AgentRuntime>>
}

export interface Daemon {
  url: string
  port: number
  token: string
  close(): Promise<void>
}

/** 두리 MCP 도구 서버를 띄우는 방법. Electron 안에서는 Electron을 Node처럼 실행한다. */
export function dool2McpServer(): McpServerSpec {
  const req = createRequire(import.meta.url)
  const script = req.resolve('@dool2/mcp-tools/server')
  const inElectron = Boolean(process.versions.electron)
  return {
    name: 'dool2',
    command: process.execPath,
    args: [script],
    ...(inElectron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
  }
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const paths = dataPaths(opts.dataDir ?? defaultDataDir())
  await mkdir(paths.workspace, { recursive: true })
  await mkdir(paths.codexHome, { recursive: true })

  const store = new Store(paths.db)
  const runtimes: Partial<Record<AgentId, AgentRuntime>> = opts.runtimes ?? {
    claude: new ClaudeRuntime(),
    codex: new CodexRuntime({ codexHome: paths.codexHome }),
  }
  const threads = new ThreadService({
    store,
    runtimes,
    workspaceDir: paths.workspace,
    mcpServers: [dool2McpServer()],
  })
  const token = opts.token ?? randomBytes(32).toString('hex')

  let claudeLogin: ClaudeLogin | undefined
  const createClaudeLogin = async () => {
    const rt = runtimes.claude as
      | (AgentRuntime & { createLogin?: () => Promise<ClaudeLogin | undefined> })
      | undefined
    return rt?.createLogin?.()
  }

  /** 저장된 설정을 읽는다. 깨진 값이나 옛 항목이 있어도 기본값으로 메운다 */
  function readSettings(): Settings {
    const parsed = SettingsSchema.partial().safeParse(store.getSettings())
    return { ...DEFAULT_SETTINGS, ...(parsed.success ? parsed.data : {}) }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      // 입력 검사 실패는 400, 나머지는 500
      const bad = err.name === 'ZodError' || err instanceof SyntaxError
      if (!res.headersSent)
        json(res, bad ? 400 : 500, { error: bad ? '요청 형식이 맞지 않아요' : err.message })
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!authorized(req, token)) return json(res, 401, { error: '인증이 필요해요' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]
    if (parts[0] !== 'api') return json(res, 404, { error: '없는 주소예요' })
    const [, a, b, c, d] = parts

    if (req.method === 'GET' && a === 'health') return json(res, 200, { ok: true, dataDir: paths.dataDir })

    if (req.method === 'GET' && a === 'agents' && !b) {
      const list = await Promise.all(Object.values(runtimes).map((rt) => rt.detect()))
      return json(res, 200, { agents: list })
    }

    // Claude 로그인: 공식 `claude auth login`을 띄워 진행한다 (login.ts)
    if (a === 'agents' && b === 'claude' && c === 'login') {
      const send = (login: ClaudeLoginStatus) => json(res, 200, { login })
      if (req.method === 'GET' && !d) return send(claudeLogin?.status ?? { state: 'idle' })
      if (req.method === 'POST' && !d) {
        claudeLogin ??= await createClaudeLogin()
        if (!claudeLogin) return json(res, 409, { error: '먼저 Claude Code를 설치해 주세요' })
        return send(await claudeLogin.start())
      }
      if (req.method === 'POST' && d === 'code') {
        const { code } = ClaudeLoginCodeSchema.parse(await readJson(req))
        if (!claudeLogin) return send({ state: 'idle' })
        return send(await claudeLogin.submitCode(code))
      }
      if (req.method === 'DELETE' && !d) {
        claudeLogin?.cancel()
        return send({ state: 'idle' })
      }
    }

    if (req.method === 'POST' && a === 'agents' && b && c === 'login') {
      const id = AgentIdSchema.parse(b)
      const rt = runtimes[id]
      if (id === 'codex' && rt instanceof CodexRuntime) {
        const code = await rt.login()
        return json(res, 200, { ok: code === 0 })
      }
      return json(res, 404, { error: '이 AI는 이 방법으로 로그인하지 않아요' })
    }

    if (a === 'settings' && !b) {
      if (req.method === 'GET') return json(res, 200, { settings: readSettings() })
      if (req.method === 'PATCH') {
        const patch = SettingsPatchSchema.parse(await readJson(req))
        for (const [key, value] of Object.entries(patch)) store.setSetting(key, value)
        return json(res, 200, { settings: readSettings() })
      }
    }

    if (a === 'threads' && !b) {
      if (req.method === 'GET') return json(res, 200, { threads: store.listThreads() })
      if (req.method === 'POST') {
        const body = CreateThreadRequestSchema.parse(await readJson(req))
        if (!runtimes[body.agent]) return json(res, 400, { error: '지원하지 않는 AI예요' })
        return json(res, 201, { thread: store.createThread(body.agent) })
      }
    }

    if (a === 'threads' && b) {
      const thread = store.getThread(b)
      if (!thread) return json(res, 404, { error: '대화를 찾을 수 없어요' })
      if (req.method === 'GET' && !c) return json(res, 200, { thread, messages: store.listMessages(b) })
      if (req.method === 'POST' && c === 'cancel') {
        threads.cancel(b)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && c === 'messages') {
        const body = SendMessageRequestSchema.parse(await readJson(req))
        if (threads.isRunning(b)) return json(res, 409, { error: '이 대화는 아직 답하는 중이에요' })
        return stream(res, threads.send(b, body.text), () => threads.cancel(b))
      }
    }

    return json(res, 404, { error: '없는 주소예요' })
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    // 이 PC 안에서만 받는다
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })

  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    // 여러 번 불러도 한 번만 닫는다
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        claudeLogin?.cancel()
        server.closeAllConnections()
        server.close(() => {
          store.close()
          resolve()
        })
      })),
  }
}

function authorized(req: IncomingMessage, token: string) {
  const header = req.headers.authorization ?? ''
  const given = Buffer.from(header.replace(/^Bearer /, ''))
  const want = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 100_000) throw new Error('요청이 너무 커요')
  }
  return raw ? JSON.parse(raw) : {}
}

/** 서버 전송 이벤트(SSE)로 한 턴의 진행을 흘려보낸다 */
async function stream(res: ServerResponse, events: AsyncIterable<DaemonStreamEvent>, onClose: () => void) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  let open = true
  res.on('close', () => {
    if (open) onClose()
    open = false
  })
  try {
    for await (const ev of events) {
      if (!open) continue
      res.write(`data: ${JSON.stringify(ev)}\n\n`)
    }
  } finally {
    open = false
    res.end()
  }
}
