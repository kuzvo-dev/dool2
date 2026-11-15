// dool2d — 두리 본체. PC 앱 화면(Electron)이 띄우고, 두리 박스에서는 혼자 돈다.
// M0: 로컬 API(127.0.0.1 + 토큰)로 대화를 받아 Claude Code·Codex를 돌리고 기록을 남긴다.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { type AgentRuntime, ConversationService, type McpServerSpec, ThreadService } from '@dool2/engine'
import {
  type AgentId,
  AgentIdSchema,
  ApprovalDecisionSchema,
  type ApprovalView,
  type ChromeStatus,
  ClaudeLoginCodeSchema,
  type ClaudeLoginStatus,
  type ConversationLiveEvent,
  type ConversationState,
  CreateThreadRequestSchema,
  type DaemonStreamEvent,
  DEFAULT_SETTINGS,
  type ExtensionStatus,
  FocusTabSchema,
  LoginSubmitSchema,
  PairConfirmSchema,
  type PaygAccount,
  PaygAccountRequestSchema,
  previewText,
  type ScreenControlStatus,
  SendMessageRequestSchema,
  type Settings,
  SettingsPatchSchema,
  SettingsSchema,
  type ThreadSummary,
  VaultEntryRequestSchema,
} from '@dool2/protocol'
import { type ConnectCard, connectUrl } from '@dool2/protocol/connect'
import { appNote } from '@dool2/protocol/rich'
import { Store } from '@dool2/store'
import type { Approvals } from './approvals.js'
import { BrowserTools } from './browser-tools.js'
import { LoginWatch } from './connect-watch.js'
import { type HandsCaller, HandsProcess } from './hands.js'
import { PhoneLink } from './link.js'
import { dataPaths, defaultDataDir } from './paths.js'
import { ScreenTools } from './screen-tools.js'
import { Skills } from './skills.js'
import { Vault } from './vault.js'
import type { sendPush } from './webpush.js'

export { APPROVAL_TTL_MS, Approvals } from './approvals.js'
export { BROWSER_TOOLS, BrowserTools, classifyRisk, type ToolResult } from './browser-tools.js'
export { PAIR_TTL_MS, PhoneLink } from './link.js'
export { dataPaths, defaultDataDir } from './paths.js'
export { parseSkill, Skills, validateSkill } from './skills.js'
export { Vault, vaultOrigin } from './vault.js'

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
  /** 스킬 폴더 (기본: 레포의 skills/, 배포 앱은 앱 안에 넣은 것) */
  skillsDir?: string
  /** PC 화면 제어 도우미 실행 파일 (기본: 레포의 apps/hands-mac/dist/dool2-hands). 테스트는 흉내를 넣는다 */
  hands?: string | HandsCaller
  /**
   * 앱 자신의 맥 권한 (Electron이 채운다). 권한 요청은 앱이 해야 "두리" 이름으로 뜬다.
   * 도우미는 앱이 띄우므로 같은 권한을 쓴다
   */
  appPermissions?: {
    status(): { accessibility: boolean; screenRecording: boolean }
    request(): Promise<void>
  }
  /** 폰 연결 중계 서버 기본 주소 (설정의 relay가 없을 때). 없으면 폰 연결을 켜지 않는다 */
  relay?: string
  /** 폰에 보일 이 PC 이름 */
  pcName?: string
  /** 테스트용: 웹 푸시 보내기 */
  push?: typeof sendPush
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
  /** 승인 게이트 (점검 화면용으로도 쓴다) */
  approvals: Approvals
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

/** 개발 중에는 레포의 skills/ (apps/daemon/dist → ../../../skills) */
/** 개발 중 도우미 위치: 레포의 apps/hands-mac/dist/dool2-hands (배포 앱은 hands 옵션으로 넣는다) */
export function defaultHandsBin(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  return fileURLToPath(new URL('../../hands-mac/dist/dool2-hands', import.meta.url))
}

function defaultSkillsDir(): string | undefined {
  const dir = fileURLToPath(new URL('../../../skills', import.meta.url))
  return existsSync(dir) ? dir : undefined
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
  /** 대화는 하나 (ADR 0015): 구간을 고르고 바꾸는 일 */
  const conversation = new ConversationService({ store, threads })
  /** 대화에서 일어나는 일을 PC 화면(GET /api/conversation/live)에 흘려보낸다 */
  const live = new EventEmitter<{ event: [ConversationLiveEvent] }>()
  // 폰에도 대화 상태(답하는 중·줄 선 말)를 알린다. 바뀔 때만
  let lastStatus = ''
  live.on('event', (ev) => {
    if (ev.kind !== 'busy' && ev.kind !== 'queued') return
    const status = {
      kind: 'conversation-status' as const,
      busy: conversationBusy() || activeThreads.size > 0,
      queued: [...queued],
    }
    const key = JSON.stringify(status)
    if (key === lastStatus) return
    lastStatus = key
    void link.broadcast(status)
  })
  live.setMaxListeners(50)
  const token = opts.token ?? randomBytes(32).toString('hex')

  const events = new EventEmitter<DaemonEvents>()

  // 브라우저 다리: 확장 → native messaging 호스트 → 이 소켓
  const browser = new BrowserBridge(paths.dataDir)
  await browser.listen()
  browser.on('status', (s) => events.emit('extension', s))
  const vault = new Vault(secrets)
  const browserTools = new BrowserTools(browser, vault, () => readSettings().finalStep ?? 'approve')
  const skills = new Skills(opts.skillsDir ?? defaultSkillsDir(), () => readSettings().connections ?? {})
  // PC 화면 제어 (M4): 도우미는 처음 쓸 때 띄운다
  const hands: HandsCaller =
    typeof opts.hands === 'object' ? opts.hands : new HandsProcess(opts.hands ?? defaultHandsBin())
  const screenTools = new ScreenTools(hands, browserTools.approvals, {
    allowed: () => readSettings().allowedApps ?? [],
    setAllowed: (list) => {
      store.setSetting('allowedApps', list)
      events.emit('settings', readSettings())
    },
    finalStep: () => readSettings().finalStep ?? 'approve',
  })
  /** 승인: 앱(app:…)이면 화면 제어, 아니면 브라우저 */
  const approveAny = (id: string) =>
    browserTools.approvals.get(id)?.url.startsWith('app:')
      ? screenTools.approve(id)
      : browserTools.approve(id)

  // 폰 연결 (M6): 페어링된 폰의 부탁을 받아 PC에서 처리한다
  const relayUrl = () => process.env.DOOL2_RELAY || readSettings().relay || opts.relay
  const pickAgent = async (want?: AgentId): Promise<AgentId> => {
    const ready = (await Promise.all(Object.values(runtimes).map((rt) => rt.detect()))).filter(
      (a) => a.installed && a.loggedIn,
    )
    const ids = ready.map((a) => a.id)
    const def = readSettings().defaultAgent
    if (want && ids.includes(want)) return want
    if (def && ids.includes(def)) return def
    if (ids[0]) return ids[0]
    throw new Error('PC에 일할 AI가 연결돼 있지 않아요')
  }
  // 서비스 연결 (ADR 0014): PC 화면(HTTP)과 폰(연결)이 같이 쓴다
  // 연결하려고 연 탭을 지켜보다가 로그인한 사람에게만 보이는 말이 나오면 알아서 연결로 표시한다 (AI 없이)
  const loginWatch = new LoginWatch({
    snapshot: async (tabId) => {
      const r = (await browser.call('snapshot', { tabId, maxChars: 6_000 }, 20_000)) as {
        url: string
        text: string
      }
      return { url: r.url, text: r.text }
    },
    connected: (id) => Boolean(readSettings().connections?.[id]),
    onSignedIn: (card) => {
      connectMark(card.id, true)
      void skills.connections().then((services) => link.broadcast({ kind: 'connections', services }))
    },
  })
  const connectOpen = async (card: ConnectCard, forPhone: boolean): Promise<number> => {
    const url = connectUrl(card)
    if (!url) throw new Error('이 서비스는 폰에서 켜요')
    if (!browser.status.connected) throw new Error('Chrome의 두리 확장이 아직 연결되지 않았어요')
    const r = (await browser.call('open', { url }, 40_000)) as { tabId: number }
    // 폰에서 연결하면 PC 앞에 없으니 그 탭을 원격 화면으로 넘긴다. PC면 앞으로 띄운다
    if (forPhone) browserTools.allowRemote(r.tabId)
    else await browser.call('focus', { tabId: r.tabId }).catch(() => undefined)
    loginWatch.start(card, r.tabId)
    return r.tabId
  }
  const connectMark = (id: string, on: boolean): string | undefined => {
    loginWatch.stop(id)
    const next = { ...(readSettings().connections ?? {}) }
    if (on) next[id] = new Date().toISOString()
    else delete next[id]
    store.setSetting('connections', next)
    events.emit('settings', readSettings())
    return next[id]
  }
  const link = new PhoneLink(
    secrets,
    {
      state: async () => {
        const agents = (await Promise.all(Object.values(runtimes).map((rt) => rt.detect())))
          .filter((a) => a.installed && a.loggedIn)
          .map((a) => a.id)
        const def = readSettings().defaultAgent
        return {
          agents,
          ...(def ? { defaultAgent: def } : {}),
          extension: browser.status.connected,
          threads: threadSummaries(30),
          approvals: browserTools.approvals.list().filter((x) => x.status === 'pending'),
          logins: browserTools.logins.list().filter((x) => x.status === 'pending'),
        }
      },
      thread: async (id) => {
        const thread = store.getThread(id)
        return thread ? { kind: 'thread', thread, messages: store.listMessages(id) } : undefined
      },
      ask: async ({ threadId, agent, text }) => {
        // 대화는 하나: 방을 고르지 않은 부탁은 대화로 보낸다 (일하는 중이면 줄을 선다)
        if (!threadId) {
          await talk(text, { agent, viaPhone: true })
          return conversation.current()?.id ?? ''
        }
        const id =
          threadId && store.getThread(threadId) ? threadId : store.createThread(await pickAgent(agent)).id
        if (threads.isRunning(id)) throw new Error('이 대화는 아직 답하는 중이에요')
        // 폰은 스트림으로 결과를 받으니 여기서는 끝까지 돌리기만 한다
        fromPhone.add(id)
        void (async () => {
          for await (const _ of tracked(id, threads.send(id, text))) {
          }
        })().catch(() => {})
        return id
      },
      cancel: (id) => threads.cancel(id),
      approval: (id) => browserTools.approvals.get(id),
      screen: async (tabId) => {
        const s = await browserTools.remoteScreen(tabId)
        remoteViewport.set(tabId, s.viewport)
        return { shot: s.data, url: s.url, title: s.title }
      },
      remote: async ({ tabId, action, x, y, text, key, dy }) => {
        const viewport = remoteViewport.get(tabId) ?? (await browserTools.remoteScreen(tabId)).viewport
        await browserTools.remoteInput(
          tabId,
          {
            action,
            ...(x !== undefined ? { x } : {}),
            ...(y !== undefined ? { y } : {}),
            ...(text !== undefined ? { text } : {}),
            ...(key !== undefined ? { key } : {}),
            ...(dy !== undefined ? { dy } : {}),
          },
          viewport,
        )
      },
      login: (id, username, password) => saveLogin(id, username, password, true),
      connections: () => skills.connections(),
      conversation: ({ before, limit }) => {
        const messages = conversation.history({ limit: limit ?? 60, ...(before ? { before } : {}) })
        return {
          messages,
          busy: conversationBusy(),
          queued: [...queued],
          hasMore: messages.length === (limit ?? 60),
        }
      },
      cancelConversation: () => conversation.cancel(),
      connect: async (id, action) => {
        const card = await skills.card(id)
        if (!card) throw new Error('그런 서비스가 없어요')
        if (action === 'open') return { tabId: await connectOpen(card, true) }
        connectMark(card.id, action === 'mark')
        return {}
      },
      decide: async (id, decision) => {
        const label = browserTools.approvals.get(id)?.label ?? ''
        const r =
          decision === 'reject'
            ? { ok: browserTools.approvals.reject(id), message: '거절했어요' }
            : await approveAny(id)
        // 폰에서 정했으면 그 결과를 AI에게 알려 이어서 하게 한다 (PC 화면은 화면이 직접 알린다)
        const threadId = approvalThread.get(id)
        if (threadId)
          followUp(
            threadId,
            decision === 'reject'
              ? appNote(`"${label}"은(는) 폰에서 거절했어요. 누르지 말아 주세요.`)
              : appNote(`폰에서 승인했어요. ${r.message} 결과를 확인하고 이어서 해 주세요.`),
          )
        return r
      },
    },
    {
      relay: relayUrl,
      ...(opts.pcName ? { name: opts.pcName } : {}),
      ...(opts.push ? { push: opts.push } : {}),
    },
  )
  browserTools.approvals.onCreate = (rec) => {
    // 승인 요청은 답하는 중인 대화의 도구 호출에서 나온다. 하나뿐이면 그 대화로 본다
    const only = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    if (only) approvalThread.set(rec.id, only)
    void link.broadcast({ kind: 'approval', approval: rec })
    // 앱이 꺼져 있어도 폰에 알린다
    void link
      .notify({
        title: '승인을 기다려요',
        body: [rec.what, rec.amount].filter(Boolean).join(' · ') || `"${rec.label}" 누르기`,
        tag: `approval-${rec.id}`,
        url: `#a=${rec.id}`,
      })
      .catch(() => {})
  }
  await link.start()
  if (opts.nativeHost) {
    const { script, ...where } = opts.nativeHost
    await registerNativeHost({ dataDir: paths.dataDir, runtime: dool2BrowserHost(script), ...where }).catch(
      (e: Error) => console.error(`[두리] 브라우저 호스트를 등록하지 못했어요: ${e.message}`),
    )
  }
  let running = 0
  /** 대화 한 턴을 감싸서 "일하는 중" 상태를 알린다 */
  async function* tracked(
    threadId: string,
    inner: AsyncIterable<DaemonStreamEvent>,
  ): AsyncGenerator<DaemonStreamEvent> {
    if (running++ === 0) events.emit('busy', true)
    activeThreads.add(threadId)
    live.emit('event', { kind: 'busy', busy: true })
    // 연결된 폰에도 같은 진행을 보낸다 (PC에서 시작한 대화도 폰에서 보이게)
    const toPhones = link.streamer(threadId)
    // 이번 답에서 승인 요청·직접 해 주세요가 나왔는지 (그러면 "끝났어요" 알림은 따로 보내지 않는다)
    let asked = false
    try {
      for await (const ev of inner) {
        toPhones(ev)
        live.emit('event', { kind: 'turn', threadId, event: ev })
        if (ev.type === 'saved' && ev.message.role === 'tool') {
          asked = true
          const rec = (() => {
            try {
              return JSON.parse(ev.message.text) as { kind?: string; reason?: string }
            } catch {
              return {}
            }
          })()
          if (rec.kind !== 'approval')
            void link
              .notify({
                title: 'PC에서 직접 해 주세요',
                body: rec.reason ?? '두리가 도움을 기다려요',
                tag: `handoff-${threadId}`,
                url: `#t=${threadId}`,
              })
              .catch(() => {})
        }
        yield ev
      }
    } finally {
      activeThreads.delete(threadId)
      // 답하는 동안 들어온 폰 승인·로그인 결과가 있으면 이어서 보낸다
      const next = pendingFollowUps.get(threadId)?.shift()
      if (next) setTimeout(() => followUp(threadId, next), 0)
      // 대화: 답하는 동안 줄 선 말을 한 차례로 모아 이어서 보낸다
      else if (queued.length && conversation.current()?.id === threadId) {
        const text = queued.splice(0).join('\n\n')
        live.emit('event', { kind: 'queued', texts: [] })
        setTimeout(() => void talk(text).catch(() => {}), 0)
      }
      if (--running === 0) events.emit('busy', false)
      live.emit('event', { kind: 'busy', busy: activeThreads.size > 0 })
      // 폰에서 맡긴 일이 끝나면 폰에 알린다 (앱을 닫아 둔 사이에 끝나도)
      if (fromPhone.delete(threadId) && !asked) {
        const t = store.getThread(threadId)
        const last = store
          .listMessages(threadId)
          .filter((m) => m.role === 'assistant')
          .at(-1)
        void link
          .notify({
            title: t?.title ? `끝났어요 · ${t.title}` : '두리가 일을 끝냈어요',
            body: last ? previewText(last.text, 120) : '결과를 확인해 주세요',
            tag: `thread-${threadId}`,
            url: `#t=${threadId}`,
          })
          .catch(() => {})
      }
    }
  }
  /** 지금 답하는 중인 대화 (승인 요청이 어느 대화에서 나왔는지 알려고) */
  const activeThreads = new Set<string>()
  const approvalThread = new Map<string, string>()
  /** 로그인 요청이 나온 대화 (폰에서 저장하면 그 대화로 이어서 하게) */
  const loginThread = new Map<string, string>()
  browserTools.logins.onCreate = (r) => {
    const only = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    if (only) loginThread.set(r.id, only)
    void link.broadcast({ kind: 'login-request', request: r })
    void link
      .notify({
        title: '로그인이 필요해요',
        body: `${r.site} 아이디와 비밀번호를 넣어 주세요`,
        tag: `login-${r.id}`,
        url: only ? `#t=${only}` : '',
      })
      .catch(() => {})
  }
  /**
   * 로그인 카드에 넣은 값을 금고에 저장한다. 값은 AI·대화 기록·폰 알림 어디에도 남기지 않는다.
   * 폰에서 넣었으면 그 대화로 AI에게 이어서 하게 알린다 (PC 화면은 화면이 직접 알린다)
   */
  async function saveLogin(id: string, username: string, password: string, viaPhone: boolean) {
    const r = browserTools.logins.get(id)
    if (!r || r.status !== 'pending')
      return { ok: false, message: '이미 처리했거나 시간이 지난 로그인 요청이에요' }
    try {
      await vault.add({ url: r.origin, username, password })
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
    browserTools.logins.finish(id, 'saved', username)
    const message = `${r.site} 로그인 정보를 두리 금고에 저장했어요.`
    void link.broadcast({ kind: 'login-done', id, ok: true, message })
    const threadId = loginThread.get(id)
    if (viaPhone && threadId)
      followUp(
        threadId,
        appNote(`폰에서 ${message} browser_login으로 채우고 로그인한 뒤 하던 일을 이어서 해 주세요.`),
      )
    return { ok: true, message }
  }
  /**
   * 폰에서 한 승인·로그인 결과를 AI에게 알려 이어서 하게 한다.
   * 그 대화가 아직 답하는 중이면(폰은 카드가 답보다 먼저 보인다) 버리지 않고, 답이 끝나면 보낸다
   */
  const pendingFollowUps = new Map<string, string[]>()
  function followUp(threadId: string, text: string) {
    if (!store.getThread(threadId)) return
    if (threads.isRunning(threadId)) {
      pendingFollowUps.set(threadId, [...(pendingFollowUps.get(threadId) ?? []), text])
      return
    }
    fromPhone.add(threadId)
    void (async () => {
      for await (const _ of tracked(threadId, threads.send(threadId, text))) {
      }
    })().catch(() => {})
  }
  /** 폰에서 맡긴 대화 (끝나면 폰에 알림) */
  const fromPhone = new Set<string>()
  /** 대화: 두리가 답하는 동안 들어와 차례를 기다리는 말 */
  const queued: string[] = []
  /** 구간을 고르는 중 (요약 부탁이 오래 걸릴 수 있어서, 그동안 온 말도 줄을 세운다) */
  let preparing = false
  const conversationBusy = () => preparing || conversation.isRunning()
  /**
   * 대화에 말 하나를 보낸다. 답하는 중이면 줄을 세웠다가 그 차례가 끝나면 이어서 보낸다 (ADR 0015).
   * 진행은 GET /api/conversation/live와 폰 스트림으로 간다
   */
  async function talk(text: string, o: { agent?: AgentId; viaPhone?: boolean } = {}) {
    if (conversationBusy()) {
      queued.push(text)
      live.emit('event', { kind: 'queued', texts: [...queued] })
      return { queued: true }
    }
    preparing = true
    let sessionId: string
    try {
      sessionId = (await conversation.prepare(await pickAgent(o.agent))).session.id
    } finally {
      preparing = false
    }
    if (o.viaPhone) fromPhone.add(sessionId)
    void (async () => {
      for await (const _ of tracked(sessionId, threads.send(sessionId, text))) {
      }
    })().catch(() => {})
    return { queued: false }
  }
  /** 원격 화면: 마지막으로 보낸 화면의 페이지 크기 (폰이 누른 비율을 좌표로 바꾸려고) */
  const remoteViewport = new Map<number, { width: number; height: number }>()
  /**
   * 대화 목록 + 홈 화면용 정보: 답하는 중인지, 마지막 답 미리보기(앞의 몇 개만), 기다리는 승인.
   * PC 앱과 폰이 같은 걸 받는다
   */
  function threadSummaries(limit = 50, previews = 6): ThreadSummary[] {
    const waiting = new Map<string, ApprovalView>()
    for (const ap of browserTools.approvals.list()) {
      const t = ap.status === 'pending' ? approvalThread.get(ap.id) : undefined
      if (t) waiting.set(t, ap)
    }
    return store.listThreads(limit).map((t, i) => {
      const out: ThreadSummary = {
        id: t.id,
        agent: t.agent,
        title: t.title,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }
      if (activeThreads.has(t.id)) out.busy = true
      if (i < previews) {
        const messages = store.listMessages(t.id)
        const last = messages.filter((m) => m.role === 'assistant').at(-1)
        if (last) out.preview = previewText(last.text)
        // 승인 기록(tool 메시지)으로도 이 대화의 승인을 찾는다 (답하던 대화가 여럿이었을 때)
        if (!waiting.has(t.id)) {
          const recs = messages.filter((m) => m.role === 'tool').map((m) => m.text)
          const pending = browserTools.approvals.list().filter((ap) => ap.status === 'pending')
          for (const raw of recs) {
            try {
              const rec = JSON.parse(raw) as { kind?: string; tabId?: number; ref?: string }
              const ap =
                rec.kind === 'approval' && pending.find((x) => x.tabId === rec.tabId && x.ref === rec.ref)
              if (ap) waiting.set(t.id, ap)
            } catch {}
          }
        }
      }
      const ap = waiting.get(t.id)
      if (ap)
        out.approval = {
          id: ap.id,
          what: ap.what,
          label: ap.label,
          ...(ap.amount ? { amount: ap.amount } : {}),
        }
      return out
    })
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
      if (req.method === 'POST' && b === 'screen' && c && !d) {
        const args = (await readJson(req)) as Record<string, unknown>
        return json(
          res,
          200,
          await screenTools
            .run(c, args && typeof args === 'object' ? args : {})
            .catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] })),
        )
      }
      if (req.method === 'POST' && b === 'skill' && c && !d) {
        const args = (await readJson(req)) as Record<string, unknown>
        return json(res, 200, await skills.run(c, args && typeof args === 'object' ? args : {}))
      }
      return json(res, 404, { error: '없는 주소예요' })
    }

    if (!authorized(req, token)) return json(res, 401, { error: '인증이 필요해요' })
    if (parts[0] !== 'api') return json(res, 404, { error: '없는 주소예요' })

    if (req.method === 'GET' && a === 'health') return json(res, 200, { ok: true, dataDir: paths.dataDir })

    // PC 화면 제어 (M4): 권한·허용한 앱. 권한은 사용자가 맥 설정에서 직접 켠다 ([권한 켜기]는 시스템 창을 띄울 뿐)
    if (a === 'screen' && !c) {
      const allowed = readSettings().allowedApps ?? []
      if (!hands.available()) return json(res, 200, { screen: { available: false, allowed } })
      const read = async () => {
        const helper = (await hands.call('status').catch(() => ({}))) as Partial<ScreenControlStatus>
        const app = opts.appPermissions?.status()
        return {
          available: true,
          ...helper,
          // 앱 권한이 켜져 있는데 도우미는 꺼져 있으면 도우미가 권한을 물려받지 못한 것 (진단용)
          ...(app ? { app } : {}),
          allowed,
        }
      }
      if (req.method === 'GET' && !b) return json(res, 200, { screen: await read() })
      if (req.method === 'POST' && b === 'permissions') {
        if (opts.appPermissions) await opts.appPermissions.request()
        else await hands.call('request')
        return json(res, 200, { screen: await read() })
      }
    }

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

    // 승인 게이트 (M3): 화면용 토큰으로만 승인할 수 있다. AI의 도구 토큰으로는 이 주소에 닿지 못한다
    // 로그인 카드 (PC): 넣은 값은 금고에만. PC 화면은 저장 뒤 직접 AI에게 알린다
    if (a === 'logins') {
      if (!b && req.method === 'GET') return json(res, 200, { logins: browserTools.logins.list() })
      if (b && !c && req.method === 'POST') {
        const body = LoginSubmitSchema.parse(await readJson(req))
        return json(res, 200, await saveLogin(b, body.username, body.password, false))
      }
      if (b && c === 'cancel' && req.method === 'POST')
        return json(res, 200, { ok: browserTools.logins.finish(b, 'cancelled') })
    }

    if (a === 'approvals') {
      if (!b && req.method === 'GET') return json(res, 200, { approvals: browserTools.approvals.list() })
      const rec = b ? browserTools.approvals.get(b) : undefined
      if (b && !c && req.method === 'GET') {
        if (!rec) return json(res, 404, { error: '승인 요청을 찾을 수 없어요' })
        return json(res, 200, { approval: rec })
      }
      if (b && !c && req.method === 'POST') {
        const { decision } = ApprovalDecisionSchema.parse(await readJson(req))
        if (decision === 'reject')
          return json(res, 200, { ok: browserTools.approvals.reject(b), message: '거절했어요' })
        return json(res, 200, await approveAny(b))
      }
    }

    // 폰 연결 (M6): 화면용 토큰으로만. 새 폰은 PC 화면에서 확인 코드를 보고 [연결]해야 붙는다
    if (a === 'link') {
      if (!b && req.method === 'GET') return json(res, 200, { link: link.status() })
      if (b === 'pair' && !c) {
        if (req.method === 'GET') return json(res, 200, { pair: link.pairStatus() })
        if (req.method === 'POST') {
          try {
            return json(res, 200, { pair: await link.startPairing() })
          } catch (e) {
            return json(res, 409, { error: (e as Error).message })
          }
        }
        if (req.method === 'DELETE') {
          link.cancelPairing()
          return json(res, 200, { pair: { state: 'idle' } })
        }
      }
      if (b === 'pair' && c === 'confirm' && req.method === 'POST') {
        const { accept } = PairConfirmSchema.parse(await readJson(req))
        return json(res, 200, { pair: await link.confirmPairing(accept) })
      }
      if (b === 'phones' && c && req.method === 'DELETE')
        return json(res, 200, { ok: await link.removePhone(c) })
    }

    // 서비스 연결 (ADR 0014): 카드 목록, 로그인하러 Chrome에서 열기, 연결 표시
    if (a === 'connections') {
      if (!b && req.method === 'GET') return json(res, 200, { services: await skills.connections() })
      const card = b ? await skills.card(b) : undefined
      if (b && !card) return json(res, 404, { error: '그런 서비스가 없어요' })
      if (card && c === 'open' && !d && req.method === 'POST') {
        try {
          return json(res, 200, { tabId: await connectOpen(card, false) })
        } catch (e) {
          const message = (e as Error).message
          return json(res, message.includes('확장') ? 409 : 400, { error: message })
        }
      }
      if (card && !c && (req.method === 'PUT' || req.method === 'DELETE'))
        return json(res, 200, { connectedAt: connectMark(card.id, req.method === 'PUT') ?? null })
    }

    // 두리 금고: 화면용 토큰으로만. 비밀번호는 넣기만 하고 꺼낼 수 없다 (ADR 0011)
    if (a === 'vault') {
      if (!b && req.method === 'GET') return json(res, 200, { entries: await vault.list() })
      if (!b && req.method === 'POST') {
        const body = VaultEntryRequestSchema.parse(await readJson(req))
        try {
          return json(res, 200, { entry: await vault.add(body) })
        } catch (e) {
          return json(res, 400, { error: (e as Error).message })
        }
      }
      if (b && !c && req.method === 'DELETE') return json(res, 200, { ok: await vault.remove(b) })
    }

    if (a === 'settings' && !b) {
      if (req.method === 'GET') return json(res, 200, { settings: readSettings() })
      if (req.method === 'PATCH') {
        const patch = SettingsPatchSchema.parse(await readJson(req))
        for (const [key, value] of Object.entries(patch)) store.setSetting(key, value)
        if ('relay' in patch) link.connect()
        const settings = readSettings()
        events.emit('settings', settings)
        return json(res, 200, { settings })
      }
    }

    // 대화 하나 (ADR 0015)
    if (a === 'conversation' && !b && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500)
      const before = url.searchParams.get('before') ?? undefined
      const messages = conversation.history({ limit, ...(before ? { before } : {}) })
      const body: ConversationState = {
        messages,
        busy: conversationBusy(),
        queued: [...queued],
        hasMore: messages.length === limit,
      }
      return json(res, 200, body)
    }
    if (a === 'conversation' && b === 'messages' && req.method === 'POST') {
      const body = SendMessageRequestSchema.parse(await readJson(req))
      return json(res, 202, await talk(body.text))
    }
    if (a === 'conversation' && b === 'cancel' && req.method === 'POST') {
      conversation.cancel()
      return json(res, 200, { ok: true })
    }
    if (a === 'conversation' && b === 'live' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      const send = (ev: ConversationLiveEvent) => res.write(`data: ${JSON.stringify(ev)}\n\n`)
      send({ kind: 'busy', busy: conversationBusy() })
      live.on('event', send)
      res.on('close', () => live.off('event', send))
      return
    }

    if (a === 'threads' && !b) {
      if (req.method === 'GET') return json(res, 200, { threads: threadSummaries() })
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
        return stream(res, tracked(b, threads.send(b, body.text)), () => threads.cancel(b))
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
    approvals: browserTools.approvals,
    port,
    token,
    // 여러 번 불러도 한 번만 닫는다
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        claudeLogin?.cancel()
        loginWatch.stopAll()
        link.stop()
        server.closeAllConnections()
        server.close(() => {
          store.close()
          if (hands instanceof HandsProcess) hands.close()
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
