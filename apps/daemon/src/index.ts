// dool2d — 두리 본체. PC 앱 화면(Electron)이 띄우고, 두리 박스에서는 혼자 돈다.
// M0: 로컬 API(127.0.0.1 + 토큰)로 대화를 받아 Claude Code·Codex를 돌리고 기록을 남긴다.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { type ClaudeInstall, type ClaudeLogin, ClaudeRuntime } from '@dool2/agent-claude'
import { CodexInstall, CodexRuntime } from '@dool2/agent-codex'
import { OpenCodeInstall, OpenCodeRuntime, PAYG_PROVIDERS } from '@dool2/agent-opencode'
import {
  BrowserBridge,
  ChromeInstall,
  detectChrome,
  type HostRuntime,
  registerNativeHost,
} from '@dool2/browser'
import { type AgentRuntime, type McpServerSpec, ThreadService } from '@dool2/engine'
import {
  type AgentId,
  AgentIdSchema,
  type ChromeStatus,
  ClaudeLoginCodeSchema,
  type ClaudeLoginStatus,
  CreateThreadRequestSchema,
  type DaemonStreamEvent,
  DEFAULT_SETTINGS,
  type ExtensionStatus,
  FocusTabSchema,
  type PaygAccount,
  PaygAccountRequestSchema,
  SendMessageRequestSchema,
  type Settings,
  SettingsPatchSchema,
  SettingsSchema,
} from '@dool2/protocol'
import { Store } from '@dool2/store'
import { BrowserTools } from './browser-tools.js'
import { dataPaths, defaultDataDir } from './paths.js'

export { BROWSER_TOOLS, BrowserTools, classifyRisk, type ToolResult } from './browser-tools.js'
export { dataPaths, defaultDataDir } from './paths.js'

export interface DaemonOptions {
  dataDir?: string
  /** 0이면 빈 포트를 고른다 */
  port?: number
  token?: string
  /** 배포 앱: 묶어 둔 두리 도구 서버 스크립트 (없으면 @dool2/mcp-tools/server) */
  mcpServerScript?: string
  /** Codex 실행 파일을 직접 지정 (기본: 처음 쓸 때 내려받은 것) */
  codexBin?: string
  /** API 키 같은 비밀값 보관소 (기본: 메모리) */
  secrets?: SecretStore
  /** 테스트용: Chrome 확인·설치를 바꿔 끼운다 */
  chrome?: { detect(): Promise<ChromeStatus>; createInstall?(downloadDir: string): ChromeInstall }
  /**
   * Chrome에 native messaging 호스트를 등록한다 (두리 확장이 본체에 붙는 길, ADR 0006).
   * 없으면 등록하지 않는다. 점검 모드·테스트는 사용자 Chrome을 건드리지 않게 비워 둔다.
   */
  nativeHost?: { script?: string; extraDirs?: string[]; defaultTargets?: boolean }
  /** 테스트용: 에이전트를 바꿔 끼운다 */
  runtimes?: Partial<Record<AgentId, AgentRuntime>>
}

/** 비밀값 보관소. PC 앱은 OS 키체인(safeStorage)으로 암호화해 둔다 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>
  /** undefined면 지운다 */
  set(key: string, value: string | undefined): Promise<void>
}

/** 개발용: 메모리에만 둔다 (껐다 켜면 사라짐) */
export function memorySecrets(): SecretStore {
  const m = new Map<string, string>()
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => {
      if (v === undefined) m.delete(k)
      else m.set(k, v)
    },
  }
}

const PAYG_KEY = 'payg.apiKey'

export interface DaemonEvents {
  /** 설정이 바뀌었다 (PC 앱이 전원·자동 시작을 다시 맞춘다) */
  settings: [Settings]
  /** 두리가 일을 시작했거나(true) 모두 끝냈다(false) */
  busy: [boolean]
  /** Chrome의 두리 확장이 붙었거나 떨어졌다 */
  extension: [ExtensionStatus]
}

export interface Daemon {
  url: string
  port: number
  token: string
  events: EventEmitter<DaemonEvents>
  /** 지금 진행 중인 일이 있는지 */
  readonly busy: boolean
  /** 저장된 설정 (기본값으로 메운 것) */
  settings(): Settings
  /** Chrome의 두리 확장과 잇는 다리 */
  browser: BrowserBridge
  close(): Promise<void>
}

/** 두리 MCP 도구 서버를 띄우는 방법. Electron 안에서는 Electron을 Node처럼 실행한다. */
export function dool2McpServer(scriptPath?: string): McpServerSpec {
  const script = scriptPath ?? createRequire(import.meta.url).resolve('@dool2/mcp-tools/server')
  const inElectron = Boolean(process.versions.electron)
  return {
    name: 'dool2',
    command: process.execPath,
    args: [script],
    ...(inElectron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
  }
}

/** native messaging 호스트를 띄우는 방법. Electron 안에서는 Electron을 Node처럼 실행한다 */
export function dool2BrowserHost(scriptPath?: string): HostRuntime {
  const script = scriptPath ?? createRequire(import.meta.url).resolve('@dool2/browser/host')
  const inElectron = Boolean(process.versions.electron)
  return {
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
  const secrets = opts.secrets ?? memorySecrets()
  const savedPayg = () => {
    const parsed = SettingsSchema.partial().safeParse(store.getSettings())
    return parsed.success ? parsed.data.payg : undefined
  }
  /** 종량제 계정: 제공자·모델은 설정, 키는 비밀값 보관소에서. 실행할 때만 합친다 */
  const paygAccount = async () => {
    const payg = savedPayg()
    const apiKey = await secrets.get(PAYG_KEY)
    return payg && apiKey ? { ...payg, apiKey } : undefined
  }
  const runtimes: Partial<Record<AgentId, AgentRuntime>> = opts.runtimes ?? {
    claude: new ClaudeRuntime(),
    codex: new CodexRuntime({
      codexHome: paths.codexHome,
      installDir: paths.codex,
      ...(opts.codexBin ? { binPath: opts.codexBin } : {}),
    }),
    opencode: new OpenCodeRuntime({ dir: paths.opencode, account: paygAccount }),
  }
  // 두리 도구 서버(MCP)는 에이전트가 띄우는 자식이라 화면용 토큰과 다른 토큰을 준다. 이 토큰은 도구 주소만 부를 수 있다 (T5)
  const toolToken = randomBytes(32).toString('hex')
  const mcp = dool2McpServer(opts.mcpServerScript)
  const threads = new ThreadService({
    store,
    runtimes,
    workspaceDir: paths.workspace,
    mcpServers: [mcp],
  })
  const token = opts.token ?? randomBytes(32).toString('hex')

  const events = new EventEmitter<DaemonEvents>()

  // 브라우저 다리: 확장 → native messaging 호스트 → 이 소켓
  const browser = new BrowserBridge(paths.dataDir)
  await browser.listen()
  browser.on('status', (s) => events.emit('extension', s))
  const browserTools = new BrowserTools(browser)
  if (opts.nativeHost) {
    const { script, ...where } = opts.nativeHost
    await registerNativeHost({ dataDir: paths.dataDir, runtime: dool2BrowserHost(script), ...where }).catch(
      (e: Error) => console.error(`[두리] 브라우저 호스트를 등록하지 못했어요: ${e.message}`),
    )
  }
  let running = 0
  /** 대화 한 턴을 감싸서 "일하는 중" 상태를 알린다 */
  async function* tracked<T>(inner: AsyncIterable<T>): AsyncGenerator<T> {
    if (running++ === 0) events.emit('busy', true)
    try {
      yield* inner
    } finally {
      if (--running === 0) events.emit('busy', false)
    }
  }
  let claudeInstall: ClaudeInstall | undefined
  let chromeInstall: ChromeInstall | undefined
  let opencodeInstall: OpenCodeInstall | undefined
  let codexInstall: CodexInstall | undefined
  /** 화면에 보여 줄 종량제 계정. 키는 끝 4자리만 */
  const paygView = async (): Promise<PaygAccount | null> => {
    const payg = savedPayg()
    if (!payg) return null
    const key = await secrets.get(PAYG_KEY)
    return { ...payg, hasKey: Boolean(key), ...(key ? { keyHint: key.slice(-4) } : {}) }
  }
  const chrome = opts.chrome ?? {
    detect: () => detectChrome(),
    createInstall: (downloadDir: string) => new ChromeInstall({ downloadDir }),
  }
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
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]
    const [, a, b, c, d] = parts

    // 두리 도구 서버 전용 주소: 도구 토큰으로만 부를 수 있다
    if (parts[0] === 'api' && a === 'tools') {
      if (!authorized(req, toolToken)) return json(res, 401, { error: '인증이 필요해요' })
      if (req.method === 'POST' && b === 'browser' && c && !d) {
        const args = (await readJson(req)) as Record<string, unknown>
        return json(res, 200, await browserTools.run(c, args && typeof args === 'object' ? args : {}))
      }
      return json(res, 404, { error: '없는 주소예요' })
    }

    if (!authorized(req, token)) return json(res, 401, { error: '인증이 필요해요' })
    if (parts[0] !== 'api') return json(res, 404, { error: '없는 주소예요' })

    if (req.method === 'GET' && a === 'health') return json(res, 200, { ok: true, dataDir: paths.dataDir })

    if (req.method === 'GET' && a === 'agents' && !b) {
      const list = await Promise.all(Object.values(runtimes).map((rt) => rt.detect()))
      return json(res, 200, { agents: list })
    }

    // Codex: 처음 쓸 때 npm 공식 레지스트리에서 받아 고정한 SHA-512로 확인 (download.ts)
    if (a === 'agents' && b === 'codex' && c === 'install' && !d) {
      if (req.method === 'GET') return json(res, 200, { install: codexInstall?.status ?? { state: 'idle' } })
      if (req.method === 'POST') {
        codexInstall ??= new CodexInstall({ dir: paths.codex })
        return json(res, 200, { install: codexInstall.start() })
      }
      if (req.method === 'DELETE') {
        codexInstall?.cancel()
        return json(res, 200, { install: { state: 'idle' } })
      }
    }

    // 종량제 모드: OpenCode 설치, 제공자·모델·API 키 (ADR 0010)
    if (a === 'agents' && b === 'opencode') {
      if (c === 'catalog' && req.method === 'GET') return json(res, 200, { providers: PAYG_PROVIDERS })
      if (c === 'account' && !d) {
        if (req.method === 'GET') return json(res, 200, { account: await paygView() })
        if (req.method === 'PUT') {
          const body = PaygAccountRequestSchema.parse(await readJson(req))
          const provider = PAYG_PROVIDERS.find((p) => p.id === body.provider)
          if (!provider) return json(res, 400, { error: '지원하지 않는 AI 제공자예요' })
          if (!body.apiKey && !(await secrets.get(PAYG_KEY)))
            return json(res, 400, { error: 'API 키를 넣어 주세요' })
          if (body.apiKey) await secrets.set(PAYG_KEY, body.apiKey)
          store.setSetting('payg', { provider: body.provider, model: body.model })
          events.emit('settings', readSettings())
          return json(res, 200, { account: await paygView() })
        }
        if (req.method === 'DELETE') {
          await secrets.set(PAYG_KEY, undefined)
          store.setSetting('payg', undefined)
          events.emit('settings', readSettings())
          return json(res, 200, { account: null })
        }
      }
      if (c === 'install' && !d) {
        if (req.method === 'GET')
          return json(res, 200, { install: opencodeInstall?.status ?? { state: 'idle' } })
        if (req.method === 'POST') {
          opencodeInstall ??= new OpenCodeInstall({ dir: paths.opencode })
          return json(res, 200, { install: opencodeInstall.start() })
        }
        if (req.method === 'DELETE') {
          opencodeInstall?.cancel()
          codexInstall?.cancel()
          return json(res, 200, { install: { state: 'idle' } })
        }
      }
    }

    // 브라우저: Chrome 확인·설치 (ADR 0006)
    if (a === 'browser' && !b && req.method === 'GET')
      return json(res, 200, { chrome: await chrome.detect(), extension: browser.status })
    // 화면이 자주 묻는다 (Chrome 확인보다 가볍게)
    if (a === 'browser' && b === 'extension' && !c && req.method === 'GET')
      return json(res, 200, { extension: browser.status })
    // 사람에게 넘긴 두리 탭을 앞으로 (화면의 [Chrome에서 보기])
    if (a === 'browser' && b === 'focus' && !c && req.method === 'POST') {
      const { tabId } = FocusTabSchema.parse(await readJson(req))
      await browser.call('focus', { tabId }).catch(() => undefined)
      return json(res, 200, { ok: true })
    }
    if (a === 'browser' && b === 'install' && !c) {
      if (req.method === 'GET') return json(res, 200, { install: chromeInstall?.status ?? { state: 'idle' } })
      if (req.method === 'POST') {
        if ((await chrome.detect()).installed) return json(res, 200, { install: { state: 'done' } })
        chromeInstall ??= chrome.createInstall?.(join(paths.dataDir, 'downloads'))
        if (!chromeInstall) return json(res, 409, { error: '이 컴퓨터에서는 Chrome을 설치할 수 없어요' })
        return json(res, 200, { install: chromeInstall.start() })
      }
      if (req.method === 'DELETE') {
        chromeInstall?.cancel()
        opencodeInstall?.cancel()
        return json(res, 200, { install: { state: 'idle' } })
      }
    }

    // Claude Code 설치: 공식 배포 서버에서 받아 체크섬을 확인하고 공식 `claude install`로 마무리 (install.ts)
    if (a === 'agents' && b === 'claude' && c === 'install' && !d) {
      const rt = runtimes.claude as
        | (AgentRuntime & { createInstall?: (dir: string) => ClaudeInstall })
        | undefined
      if (req.method === 'GET') return json(res, 200, { install: claudeInstall?.status ?? { state: 'idle' } })
      if (req.method === 'POST') {
        claudeInstall ??= rt?.createInstall?.(join(paths.dataDir, 'downloads'))
        if (!claudeInstall) return json(res, 409, { error: '이 컴퓨터에서는 Claude Code를 설치할 수 없어요' })
        return json(res, 200, { install: claudeInstall.start() })
      }
      if (req.method === 'DELETE') {
        claudeInstall?.cancel()
        chromeInstall?.cancel()
        return json(res, 200, { install: { state: 'idle' } })
      }
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
        claudeInstall?.cancel()
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
        const settings = readSettings()
        events.emit('settings', settings)
        return json(res, 200, { settings })
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
        return stream(res, tracked(threads.send(b, body.text)), () => threads.cancel(b))
      }
    }

    return json(res, 404, { error: '없는 주소예요' })
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    // 이 PC 안에서만 받는다
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })

  // 이제 주소를 알았으니 도구 서버에 알려 준다 (ThreadService는 같은 객체를 쓴다)
  mcp.env = { ...mcp.env, DOOL2_API: `http://127.0.0.1:${port}`, DOOL2_TOOL_TOKEN: toolToken }

  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${port}`,
    events,
    get busy() {
      return running > 0
    },
    settings: readSettings,
    browser,
    port,
    token,
    // 여러 번 불러도 한 번만 닫는다
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        claudeLogin?.cancel()
        server.closeAllConnections()
        server.close(() => {
          store.close()
          browser.close().then(resolve, resolve)
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
