// dool2d — 두리 본체. PC 앱 화면(Electron)이 띄우고, 두리 박스에서는 혼자 돈다.
// M0: 로컬 API(127.0.0.1 + 토큰)로 대화를 받아 Claude Code·Codex를 돌리고 기록을 남긴다.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
import {
  type AgentRuntime,
  buildSystemPrompt,
  ConversationService,
  type McpServerSpec,
  ThreadService,
} from '@dool2/engine'
import {
  type AgentId,
  AgentIdSchema,
  ApprovalDecisionSchema,
  type ApprovalView,
  AUTH_APPS,
  type ChromeStatus,
  ClaudeLoginCodeSchema,
  type ClaudeLoginStatus,
  type ConnectRecordMessage,
  type ConnectStep,
  type ConversationLiveEvent,
  type ConversationState,
  CreateThreadRequestSchema,
  type DaemonStreamEvent,
  DEFAULT_SETTINGS,
  type ExtensionStatus,
  type FeedItem,
  FocusTabSchema,
  type LifeAction,
  LoginSubmitSchema,
  PairConfirmSchema,
  type PaygAccount,
  PaygAccountRequestSchema,
  previewText,
  type Routine,
  type ScreenControlStatus,
  SendMessageRequestSchema,
  type Settings,
  SettingsPatchSchema,
  SettingsSchema,
  SIDE_THREAD_MAX,
  type StoredMessage,
  type TellRecordMessage,
  type ThreadSummary,
  VaultEntryRequestSchema,
} from '@dool2/protocol'
import {
  type ConnectCard,
  connectUrl,
  type SocialProvider,
  SocialProviderSchema,
} from '@dool2/protocol/connect'
import { findCard } from '@dool2/protocol/connect-text'
import { appNote, josa, PHOTO_MARK, readAppNote, withoutPhotoMark } from '@dool2/protocol/rich'
import { Store } from '@dool2/store'
import type { Approvals } from './approvals.js'
import {
  type AutoLoginResult,
  autoLogin,
  type LoginAsk,
  probeLogin,
  providerAccountIn,
  SOCIAL_PROVIDERS,
  sameAccount,
  socialLogin,
} from './auto-login.js'
import { askedForAccount, BrowserTools } from './browser-tools.js'
import { LoginWatch, strongSignedIn } from './connect-watch.js'
import { ConnectorHealth } from './connector-health.js'
import { Connectors } from './connectors.js'
import { FileTools, htmlText, type UserFolders } from './files.js'
import { type HandsCaller, HandsProcess } from './hands.js'
import { InfoRequests } from './info-requests.js'
import { Journal, KEEP_DAYS, SHOT_DAYS, scrubText, scrubUrl } from './journal.js'
import { Life, routineAsk, tellDelay, watchPrompt } from './life.js'
import { PhoneLink } from './link.js'
import { dataPaths, defaultDataDir } from './paths.js'
import { loadPayMethods, payMethodsText, savePayMethods } from './pay-methods.js'
import { PROFILE_FIELDS, ProfileStore } from './profile.js'
import type { HtmlRenderer } from './render.js'
import { ScreenTools } from './screen-tools.js'
import { checkSignedIn, type SigninCheck } from './signin-check.js'
import { Skills } from './skills.js'
import { Thumbs } from './thumbs.js'
import { Vault, vaultSitesText } from './vault.js'
import type { sendPush } from './webpush.js'

export { APPROVAL_TTL_MS, Approvals } from './approvals.js'
export { BROWSER_TOOLS, BrowserTools, classifyRisk, type ToolResult } from './browser-tools.js'
export { ConnectorHealth } from './connector-health.js'
export { Connectors, coerce, render, type ServiceToolSpec } from './connectors.js'
export { FileTools } from './files.js'
export { PAIR_TTL_MS, PhoneLink } from './link.js'
export { dataPaths, defaultDataDir } from './paths.js'
export type { HtmlRenderer, HtmlRenderRequest, HtmlRenderResult } from './render.js'
export { Skills } from './skills.js'
export { Vault, vaultOrigin } from './vault.js'

/** 처음부터 다시에서 지우는 PC 설정: 두리가 사용자에 대해 쌓은 것 (기억·목표·보관함·먼저 챙기기·아이디어·내 정보) */
const RESET_KEYS = [
  'memory',
  'routines',
  'library',
  'feed',
  'feedThread',
  'feedPrompt',
  'ideas',
  'ideasAt',
  'watchAt',
  'identity',
] as const

export interface DaemonOptions {
  /** HTML을 그려 JPEG(base64)로 (PC 앱이 준다). 두리가 만든 그림·초대장을 보관함·폰에서 보이게 */
  renderHtml?: (html: string) => Promise<string | undefined>
  /**
   * HTML 파일을 PDF(A4, 여러 쪽)·PNG로 그린다 (PC 앱이 보이지 않는 창으로 준다, file_render).
   * 없으면(앱 없이 본체만) file_render가 못 한다고 알린다
   */
  renderFile?: HtmlRenderer
  dataDir?: string
  /** false면 일한 기록(logs 폴더)을 남기지 않는다 (기본: 며칠만 남김, journal.ts) */
  journal?: false
  /** 0이면 빈 포트를 고른다 */
  port?: number
  token?: string
  /** 배포 앱: 묶어 둔 두리 도구 서버 스크립트 (없으면 @dool2/mcp-tools/server) */
  mcpServerScript?: string
  /** 시험용: 도구 주소(/api/tools) 토큰을 정해 둔다 (없으면 켤 때마다 새로 만든다) */
  toolToken?: string
  /** 시험용: PC 파일 도구가 다룰 폴더 (기본: 사용자의 바탕화면·문서·다운로드) */
  fileFolders?: UserFolders
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
  /** 말과 함께 넘기는 지금 시각 줄 (기본 켬, 시험에서 끈다: () => undefined) */
  timeLine?: () => string | undefined
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
  /**
   * 시험용 PC: 폰 설정의 '처음부터 다시'를 켠다 (대화·기억·목표·보관함을 지우고 새 사용자처럼).
   * 배포 앱은 켜지 않는다. 환경 변수 DOOL2_DEV_RESET=1로도 켤 수 있다
   */
  devReset?: boolean
  /** 폰 연결 중계 서버 기본 주소 (설정의 relay가 없을 때). 없으면 폰 연결을 켜지 않는다 */
  relay?: string
  /** 폰 앱 주소 (예: https://dool2.com/space/). 없으면 중계 서버의 /app/ */
  appUrl?: string
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
  const toolToken = opts.toolToken ?? randomBytes(32).toString('hex')
  const mcp = dool2McpServer(opts.mcpServerScript)
  /** 목표·보관함·기억·피드 */
  const life = new Life(store)
  // 폰에서 보낸 사진: 작업 폴더 photos/에 두고, 말에는 표시만 붙인다 (두리는 photo_view로 본다)
  const photoDir = join(paths.workspace, 'photos')
  async function savePhoto(b64: string): Promise<string> {
    const buf = Buffer.from(b64, 'base64')
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('사진 형식이 맞지 않아요')
    await mkdir(photoDir, { recursive: true })
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`
    await writeFile(join(photoDir, name), buf)
    return `${PHOTO_MARK}${name}]`
  }
  life.photo = async (name) => {
    if (!/^[\w-]+\.jpg$/.test(name)) throw new Error('사진 이름이 맞지 않아요')
    return (await readFile(join(photoDir, name))).toString('base64')
  }
  const threads = new ThreadService({
    store,
    runtimes,
    workspaceDir: paths.workspace,
    mcpServers: [mcp],
    // 일한 과정 기록: 탭 번호만 받은 웹 도구가 어느 사이트에서 일했는지
    tabHost: (tabId) => browserTools.tabHost(tabId),
    // 일한 과정에 서비스 도구 제목 ("가게 찾기·영업 확인 중")
    toolTitle: (name) => connectors.titleOf(name),
    ...(opts.timeLine ? { timeLine: opts.timeLine } : {}),
    // 기억은 대화마다 지침 끝에 붙는다
    // 서비스 지도: 서비스 이름이 없는 부탁에도 맞는 서비스(연결된 곳 먼저)를 고르게
    systemPrompt: () =>
      [buildSystemPrompt(life.identity()), skills.serviceMap(), life.memoryPrompt(), life.knowPrompt()]
        .filter(Boolean)
        .join('\n\n'),
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
  // 일한 기록: 연결·도구·답 한 차례가 어떻게 됐는지 이 PC에 며칠만 남긴다 (문제를 찾을 때 본다, journal.ts)
  const journal = new Journal(opts.journal === false ? undefined : join(paths.dataDir, 'logs'))
  let extensionSeen = ''
  browser.on('status', (s) => {
    const sig = `${s.connected}:${s.connected ? s.version : ''}`
    if (sig === extensionSeen) return
    extensionSeen = sig
    journal.write('extension', {
      connected: s.connected,
      ...(s.connected ? { version: s.version, browser: s.browser } : {}),
    })
  })
  const vault = new Vault(secrets)
  const browserTools = new BrowserTools(browser, vault, () => readSettings().finalStep ?? 'approve')
  // 내 정보(예약자·주문자 칸): 금고와 같은 보관소에, AI는 가린 값만 (browser_fill_profile)
  const profile = new ProfileStore(secrets)
  browserTools.profile = profile
  browserTools.onNote = (kind, data) => journal.write(kind, data)
  browserTools.onShot = (label, data) => void journal.shot(label, data)
  // PC 파일 도구 (ADR 0022·0024). 시험에서는 폴더를 바꿀 수 있다. 옮기기(여러 개)·출력은 같은 승인 카드로
  const fileTools = new FileTools(opts.fileFolders, undefined, {
    approvals: browserTools.approvals,
    movesLog: join(paths.dataDir, 'file-moves.json'),
    // 잠자기 전에 두리가 하던 일을 본다 (답하는 대화·서비스 연결). 아래에서 만드는 값이라 부를 때 읽는다
    busy: () => ({ turns: activeThreads.size, connecting: [...connecting.keys()] }),
    ...(opts.renderFile ? { renderFile: opts.renderFile } : {}),
  })
  // 웹사이트에 PC 파일 올리기(browser_upload)도 파일 도구와 같은 폴더 울타리 안에서만 (+ 대화로 받은 사진)
  fileTools.sentPhotos = photoDir
  browserTools.uploadFiles = (p) => fileTools.uploadable(p)
  // 두리가 만든 파일은 보관함 '사진·파일'에도 올려 폰에서 본다 (글·표는 내용, HTML은 미리보기)
  fileTools.onWritten = (f) => {
    const md = (rows: unknown[][]) =>
      rows
        .slice(0, 30)
        .map((r, i) => {
          const line = `| ${(Array.isArray(r) ? r : [r]).map((c) => String(c ?? '').replace(/\|/g, '/')).join(' | ')} |`
          return i === 0 ? `${line}\n|${(Array.isArray(r) ? r : [r]).map(() => '---').join('|')}|` : line
        })
        .join('\n')
    const text = f.text ?? ''
    const body = f.kind === 'html' ? htmlText(text).slice(0, 1500) : f.rows ? md(f.rows) : text.slice(0, 3800)
    void (async () => {
      // HTML(그림·초대장)은 PC 앱이 그려 찍은 사진을 함께 둔다: 폰은 HTML을 그리지 못한다
      // HTML을 PNG로 그린 파일은 그릴 때 만든 미리보기를 쓴다
      const shot =
        f.image ??
        (f.kind === 'html' && opts.renderHtml
          ? await opts.renderHtml(text).catch(() => undefined)
          : undefined)
      life.save({
        kind: 'file',
        title: f.name,
        body: `${body}\n\nPC: ${f.path}`.trim(),
        path: f.path,
        ...(shot ? { image: shot } : {}),
      })
    })()
  }
  // 사이트마다 마지막으로 고른 결제 수단 (다음 승인 카드의 기본값). 카드 번호 같은 비밀은 없고 수단 이름만
  {
    const saved = store.getSetting('payChoices')
    if (saved && typeof saved === 'object') browserTools.loadChoices(saved as Record<string, string>)
    browserTools.payMethods = () => loadPayMethods(store)
    browserTools.onChoice = (host, label) => {
      const now = (store.getSetting('payChoices') as Record<string, string> | undefined) ?? {}
      store.setSetting('payChoices', { ...now, [host]: label.slice(0, 40) })
    }
    // 사이트별 등록 카드·할부 ("host|카드" → 가린 카드 이름)
    const subs = store.getSetting('paySubChoices')
    if (subs && typeof subs === 'object') browserTools.loadSubChoices(subs as Record<string, string>)
    browserTools.onSubChoice = (key, label) => {
      const now = (store.getSetting('paySubChoices') as Record<string, string> | undefined) ?? {}
      store.setSetting('paySubChoices', { ...now, [key]: label.slice(0, 60) })
    }
  }
  /** 설정에서 그 사이트 결제 기억을 잊을 때 카드·할부 기억도 같이 */
  const forgetPaySubs = (host: string) => {
    const now = { ...((store.getSetting('paySubChoices') as Record<string, string> | undefined) ?? {}) }
    for (const k of Object.keys(now)) if (k.startsWith(`${host}|`)) delete now[k]
    store.setSetting('paySubChoices', now)
  }
  const skillsDir = opts.skillsDir ?? defaultSkillsDir()
  // 서비스 도구(커넥터, ADR 0018): 연결 카드 옆 tools.json을 엔진 동작으로 실행한다
  const connectors = new Connectors({
    dir: skillsDir,
    browser,
    tools: browserTools,
    connected: () => readSettings().connections ?? {},
    extensionVersion: () => (browser.status.connected ? browser.status.version : undefined),
    health: new ConnectorHealth(join(paths.dataDir, 'connector-health.json')),
    journal,
    // 내 정보 주소 (도구 주소 칸이 비었거나 "내 주소"일 때). AI에게는 가지 않고 그 사이트에만 들어간다
    homeAddress: async () => (await profile.get()).address?.trim() || undefined,
    // 메인 대화에서 사용자가 마지막으로 한 말 (앱 알림 줄은 빼고)
    lastUser: () => {
      const cur = conversation.current()
      if (!cur) return undefined
      const m = store
        .listMessages(cur.id)
        .filter((x) => x.role === 'user' && !x.text.startsWith('[두리 앱 알림]'))
        .at(-1)
      return m ? { at: Date.parse(m.createdAt), text: m.text } : undefined
    },
    // 그 서비스에 연결한 계정(금고의 아이디): 메일함처럼 계정마다 주소가 다른 곳을 그 계정으로 연다
    accountFor: async (card) => {
      for (const site of [card.site, ...(card.alsoSites ?? [])].filter(Boolean)) {
        const e = await vault.findForOrigin(`https://${String(site).replace(/^https?:\/\//, '')}`)
        // 구글은 주소 전체여야 그 메일함이 열린다 (아이디만 저장돼 있으면 /mail/u/아이디/가 '일시적 오류')
        if (e?.username)
          return /google\.com|gmail\.com/.test(String(site)) && !e.username.includes('@')
            ? `${e.username}@gmail.com`
            : e.username
      }
      return undefined
    },
  })
  const skills = new Skills(
    skillsDir,
    () => readSettings().connections ?? {},
    (id) => connectors.summary(id),
    () => (store.getSetting('connectVia') as Record<string, string> | undefined) ?? {},
    () => (store.getSetting('socialAccounts') as Record<string, string[]> | undefined) ?? {},
  )
  // 지침의 서비스 지도는 마지막으로 읽은 목록을 쓴다: 처음 한 번 읽어 둔다
  void skills.connections().catch(() => undefined)
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
  /** 승인: 앱(app:…)이면 화면 제어, PC 파일(file:…)이면 파일 도구, 아니면 브라우저 */
  const approveAny = (id: string, choice?: string) => {
    const url = browserTools.approvals.get(id)?.url ?? ''
    if (url.startsWith('app:')) return screenTools.approve(id)
    if (url.startsWith('file:')) return fileTools.ops.approve(id)
    return browserTools.approve(id, choice)
  }

  // 폰 연결 (M6): 페어링된 폰의 부탁을 받아 PC에서 처리한다
  const relayUrl = () => process.env.DOOL2_RELAY || readSettings().relay || opts.relay
  /**
   * AI 상태 확인은 10초까지만 기다린다. 오래 켜 둔 본체에서 확인이 끝나지 않아 새 대화가 안 열렸다
   * (실측: 시험 판에서 몇십 분 뒤부터 POST /api/threads·/api/agents가 응답하지 않음, 다시 켜면 풀림).
   * 막히면 마지막으로 확인된 상태를 쓰고, 어느 AI가 막혔는지 일한 기록에 남긴다
   */
  const agentStatus = new Map<string, Awaited<ReturnType<AgentRuntime['detect']>>>()
  const detectAll = () =>
    Promise.all(
      Object.entries(runtimes).map(async ([id, rt]) => {
        const timeout = new Promise<undefined>((ok) => setTimeout(() => ok(undefined), 10_000))
        const s = await Promise.race([rt.detect().catch(() => undefined), timeout])
        if (s) {
          agentStatus.set(id, s)
          return s
        }
        journal.write('agent-detect-timeout', { id })
        return (
          agentStatus.get(id) ?? {
            id: id as AgentId,
            installed: false,
            loggedIn: false,
            problem: '상태 확인이 끝나지 않았어요',
          }
        )
      }),
    )
  const pickAgent = async (want?: AgentId): Promise<AgentId> => {
    const ready = (await detectAll()).filter((a) => a.installed && a.loggedIn)
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
      const r = (await browser.call('snapshot', { tabId, maxChars: 20_000 }, 20_000)) as {
        url: string
        text: string
      }
      return { url: r.url, text: r.text }
    },
    connected: (id) => Boolean(readSettings().connections?.[id]),
    onSignedIn: (card) => {
      connectMark(card.id, true)
      // 본체가 꺼지는 중에 끝나면 저장소가 닫혀 있다: 그때는 알리지 않는다
      void skills
        .connections()
        .then((services) => link.broadcast({ kind: 'connections', services }))
        .catch(() => {})
    },
    confirm: async (card) => {
      const r = await checkSignedIn(browser, card)
      rememberCheck(card.id, r)
      return r.state === 'in'
    },
    onClosed: (card) => {
      if (!readSettings().connections?.[card.id]) void connectVerify(card).catch(() => false)
    },
  })
  const connectOpen = async (card: ConnectCard, forPhone: boolean): Promise<number> => {
    const url = connectUrl(card)
    if (!url) throw new Error('이 서비스는 폰에서 켜요')
    if (!browser.status.connected) throw new Error('Chrome의 두리 확장이 아직 연결되지 않았어요')
    const r = (await browser.call('open', { url }, 40_000)) as { tabId: number }
    // 폰에서 연결하면 PC 앞에 없으니 그 탭을 원격 화면으로 넘긴다. PC면 앞으로 띄운다
    if (forPhone) browserTools.holdForPerson(r.tabId)
    else await browser.call('focus', { tabId: r.tabId }).catch(() => undefined)
    loginWatch.start(card, r.tabId)
    return r.tabId
  }
  /** 연결하기: 아이디·비밀번호를 금고에 넣고 본체가 대신 로그인한다. AI는 값을 보지 않는다 */
  const connectLogin = async (card: ConnectCard, username: string, password: string) => {
    const url = connectUrl(card)
    if (!url) throw new Error('이 서비스는 폰에서 켜요')
    if (!username.trim() || !password) throw new Error('아이디와 비밀번호를 넣어 주세요')
    const start = card.loginUrl ?? url
    if (!browser.status.connected) throw new Error('PC의 Chrome에 두리 확장이 아직 연결되지 않았어요')
    await vault.add({ url, username, password })
    const r = await autoLogin(browser, {
      card,
      url: start,
      username,
      password,
      ask: loginAsk(card),
      step: connectStep(card.id),
      onTab: connectTab(card.id),
    })
    // 로그인 화면이 다른 주소면(login.사이트) 거기에도 넣어 둔다 (다음에 두리가 다시 로그인할 때)
    if (r.loginOrigin && r.loginOrigin !== new URL(url).origin)
      await vault.add({ url: r.loginOrigin, username, password }).catch(() => undefined)
    if (r.status === 'ok') rememberVia(card.id, 'vault')
    return connectFinish(card, r)
  }
  /** 간편 로그인으로 연결: 공급자 쪽이 이미 로그인돼 있으면 버튼·동의만 넘기고, 아니면 금고 값 또는 사람 차례 */
  const connectSocial = async (card: ConnectCard, provider: SocialProvider, noJoin = false) => {
    const url = connectUrl(card)
    if (!url) throw new Error('이 서비스는 폰에서 켜요')
    if (!browser.status.connected) throw new Error('PC의 Chrome에 두리 확장이 아직 연결되지 않았어요')
    // 이 사이트에 이미 되는 계정이 없을 때만 간편 가입까지 (있으면 같은 사이트에 계정이 둘이 된다)
    const known = connectVia()[card.id]
    // noJoin: 일괄 점검처럼 가입까지는 하지 않을 때 (가입 화면이면 '가입이 필요해요'로 끝낸다)
    const join = !noJoin && !(known && known !== `social:${provider}`) && !(await vaultCreds(card))
    const r = await socialLogin(browser, {
      card,
      url: card.loginUrl ?? url,
      provider,
      join,
      creds: (origin) => vault.findForOrigin(origin),
      ask: loginAsk(card),
      step: connectStep(card.id),
      onTab: connectTab(card.id),
    })
    if (r.status === 'ok') rememberVia(card.id, `social:${provider}`)
    return connectFinish(card, r)
  }
  /**
   * 서비스마다 연결할 때 쓴 방법 (vault: 금고 계정, social:kakao 등). 로그인이 풀리면 두리가 같은 방법으로 다시 로그인한다.
   * 비밀값은 없고 방법 이름만
   */
  /** 서비스마다 마지막 로그인 확인 (연결 화면에 '확인 ○시간 전'으로, 연결 유지가 다시 로그인할 곳을 고를 때) */
  const rememberCheck = (id: string, r: SigninCheck) => {
    const all = (store.getSetting('connectChecks') as Record<string, unknown> | undefined) ?? {}
    store.setSetting('connectChecks', {
      ...all,
      [id]: { at: new Date().toISOString(), state: r.state, why: r.why },
    })
    journal.write('signin-check', { id, state: r.state, why: r.why })
  }
  const connectVia = () => (store.getSetting('connectVia') as Record<string, string> | undefined) ?? {}
  const rememberVia = (id: string, via: string) =>
    store.setSetting('connectVia', { ...connectVia(), [id]: via })
  /** 서비스마다 마지막으로 해 본 연결 방법: 자동 로그인이 확인을 못 하고 두리(AI)가 이어받아 끝낸 경우에도 방법을 기억하려고 */
  const connectTried = new Map<string, string>()
  /** 금고에 있는 그 서비스 계정 (연결 주소·로그인 주소) */
  const vaultCreds = async (card: ConnectCard) => {
    const url = connectUrl(card)
    if (!url) return undefined
    // 연결로 넣은 계정은 연결 주소(coupang.com), 일하다 넣은 계정은 그 화면 주소(www.coupang.com)로 들어 있다
    const www = card.site && !card.site.startsWith('www.') ? `https://www.${card.site}/` : undefined
    let saved: { username: string; password: string } | undefined
    for (const u of [url, card.loginUrl, www].filter(Boolean) as string[])
      saved ??= await vault.findForOrigin(new URL(u).origin)
    return saved
  }
  /** 자동 로그인 결과 → 연결 표시 / 사람 차례(원격 화면) / 안내 */
  const connectFinish = async (card: ConnectCard, r: AutoLoginResult): Promise<ConnectResult> => {
    if (r.status === 'ok') {
      connectMark(card.id, true)
      await browser.call('close', { tabId: r.tabId }).catch(() => undefined)
      return { ok: true, message: `${card.name}에 로그인했어요. 이제 부탁만 하면 돼요.` }
    }
    if (r.status === 'human') {
      // 사람이 해야 하는 단계: 폰에서 그 화면을 보고 마치면 연결로 표시한다
      browserTools.holdForPerson(r.tabId)
      loginWatch.start(card, r.tabId)
      return {
        ok: false,
        human: true,
        reason: 'human',
        tabId: r.tabId,
        // 앱 확인만 남았으면(카카오톡 등) 화면을 열 필요 없이 누르기만 하면 된다: 지켜보기가 이어서 연결한다
        message: /이어서 연결해요$/.test(r.reason)
          ? `${r.reason}.`
          : `${r.reason}. 화면을 열어 직접 마쳐 주세요.`,
      }
    }
    browserTools.holdForPerson(r.tabId)
    // 아이디·비밀번호가 틀렸거나 결과를 몰라도, 사용자가 그 화면에서 마치면 알아서 연결로 표시한다
    loginWatch.start(card, r.tabId)
    return {
      ok: false,
      reason: r.status === 'wrong' ? 'wrong' : 'unknown',
      tabId: r.tabId,
      message: r.message,
    }
  }
  type ConnectResult = {
    ok: boolean
    message: string
    human?: boolean
    tabId?: number
    reason?: 'human' | 'wrong' | 'unknown'
    agent?: boolean
  }
  /**
   * 자동 로그인이 화면을 못 알아봐 멈췄을 때: 실패 카드로 끝내지 않고 두리(AI)가 대화에서 그 탭을 이어받는다.
   * 정해 둔 순서로만 누르는 자동 로그인과 달리 화면을 읽고 맞춰 가므로, 사이트마다 다른 로그인 화면에서도 이어 갈 수 있다.
   * 하는 일은 대화에 그대로 보인다(일하는 화면·단계). 아이디·비밀번호는 금고에서 칸으로만 들어가고 AI에게는 가지 않는다.
   * 서비스마다 10분에 한 번만 (그래도 안 되면 사용자가 화면을 보며 직접)
   */
  const takeoverAt = new Map<string, number>()
  /** 이어받은 탭 → 서비스 (그 서비스 사이트의 다른 주소에서도 연결할 때 넣은 계정을 쓰게) */
  const takeoverTabs = new Map<number, string>()
  const agentTakeover = (card: ConnectCard, r: ConnectResult): boolean => {
    // 사용자 결정 11-20: 사람이 할 일은 없어야 한다. 자동 로그인이 '사람 차례'·'틀림'으로 판정해도(규칙 판정은 자주 틀린다)
    // 두리(AI)가 화면을 보고 이어 간다. 사람 몫(로봇 확인·인증번호·본인인증·가입 동의)은 두리가 폰 카드로 받는다.
    // 남기는 것: 인증 앱 승인만 기다리는 단계(폰에서 누르면 지켜보기가 이어서 연결한다)
    if (r.ok || r.tabId === undefined) return false
    if (r.human && /이어서 연결해요\.?$/.test(r.message)) return false
    if (Date.now() - (takeoverAt.get(card.id) ?? 0) < 3 * 60_000) return false
    takeoverAt.set(card.id, Date.now())
    takeoverTabs.set(r.tabId, card.id)
    journal.write('connect-takeover', { id: card.id })
    // 로그인되면 지켜보던 쪽(loginWatch)이 연결로 표시하고 대화에 알린다
    connectHuman.add(card.id)
    // 멈춘 일이 있었는지 (이어받은 AI에게도 알리고, 연결이 끝나면 따로 또 알린다 — 이어받은 AI가 로그인 전에
    // 끝나 버리면 이어 갈 길이 없었다(실측 장보기 3: 요기요 연결이 끝났는데 아무도 이어 하지 않았다))
    const resume = connectAsked.has(card.id)
    // 화면에는 앞의 두 문장만 보인다 (도구 이름이 든 문장은 AI에게만 간다)
    const why = (r.message.split(/[.!?]/)[0] ?? '').replace(/요\s+/g, '요·').trim()
    void talk(
      appNote(
        `${card.name} 자동 로그인이 중간에 멈췄어요. 두리가 화면을 보며 이어서 해 볼게요. ` +
          `browser_read로 탭 ${r.tabId}을 읽고(자동 로그인의 판단: ${why} — 규칙 판단이라 틀릴 수 있어요. 화면을 직접 보고 정해요) 로그인을 이어서 해 주세요. ` +
          `아이디·비밀번호는 금고에 있으니 browser_login으로만 넣고 browser_click으로 로그인 버튼을 눌러요. ` +
          `이미 있는 계정에 간편 로그인을 연결하라는 화면이면 연결 버튼을 눌러요(새로 가입하는 게 아니에요). ` +
          `사람 몫은 폰 카드로만 받아요: 로봇 확인 그림은 browser_request_tap, 글자 보안문자·인증번호는 browser_request_code, 인증 앱 승인은 browser_wait_auth, 본인인증 칸은 browser_fill_profile, 가입처럼 사용자가 정할 일은 browser_request_approval. 화면 넘기기·직접 하라는 말은 하지 않아요. ` +
          `사용자에게 비밀번호를 다시 묻지 않고, 로그인됐으면 탭은 닫지 말되 탭 이야기는 빼고 ` +
          (resume
            ? `${card.name}이 필요해서 멈춘 일이 있었으면 로그인 뒤 그 일을 이어서 끝내요(연결됐다는 말은 한 줄로).`
            : `연결됐다는 결과만 한 문장으로 말해요.`),
      ),
    ).catch(() => {})
    return true
  }
  /**
   * 연결하기는 뒤에서 한다: 폰·PC는 기다리지 않고 다른 일을 해도 된다.
   * 끝나면 모든 폰에 결과·연결 목록을 보내고, 대화에 알림을 남겨 두리가 사용자에게 알리고 멈춘 일을 이어 가게 한다
   */
  const connecting = new Map<string, Promise<ConnectResult>>()
  /** 연결하는 동안의 단계: 폰 연결 카드에 "○○ 여는 중 → 아이디·비밀번호 넣는 중 → …"으로 보인다 */
  const connectSteps = new Map<string, ConnectStep[]>()
  function connectStep(id: string) {
    return (text: string, ask?: ConnectStep['ask']) => {
      const steps = connectSteps.get(id) ?? []
      if (steps.at(-1)?.text === text && !ask) return
      steps.push({ text, at: Date.now(), ...(ask ? { ask } : {}) })
      connectSteps.set(id, steps)
      journal.write('connect-step', { id, text, ...(ask ? { ask: ask.kind } : {}) })
      connectProgress(id)
    }
  }
  /** 연결하는 동안 로그인하고 있는 탭: 폰 연결 카드에 그 화면이 작게 실시간으로 보인다 (무엇을 하는지 보이게) */
  const connectTabs = new Map<string, number>()
  function connectProgress(id: string) {
    const tabId = connectTabs.get(id)
    void link.broadcast({
      kind: 'connect-progress',
      id,
      steps: connectSteps.get(id) ?? [],
      ...(tabId !== undefined ? { tabId } : {}),
    })
  }
  function connectTab(id: string) {
    return (tabId: number) => {
      browserTools.allowRemote(tabId)
      connectTabs.set(id, tabId)
      connectProgress(id)
    }
  }
  /** 로봇 확인·본인인증을 사람에게 넘긴 연결 (화면에서 마치면 connectMark가 대화에 알린다) */
  const connectHuman = new Set<string>()
  const connectStatus = () => {
    const list = [...connecting.keys()]
    void link.broadcast({ kind: 'connect-status', connecting: list })
    live.emit('event', { kind: 'connect', connecting: list })
  }
  /** 두리가 대화에 연결 카드를 띄운 때 (그 뒤 30분 안에 연결되면 멈춘 일을 이어 가게 AI에게 알린다) */
  const connectAsked = new Map<string, number>()
  /** AI를 부르지 않고 대화에 알림 줄만 남긴다 (폰·PC에 바로 보인다) */
  const postNote = (text: string) => {
    const cur = conversation.current()
    if (!cur) return
    // 같은 알림을 10분 안에 또 남기지 않는다 (연결을 여러 번 눌러 실패하면 같은 줄이 세 번씩 쌓였다)
    const note = appNote(text)
    const since = Date.now() - 10 * 60_000
    const recent = store.listMessages(cur.id).slice(-8)
    if (recent.some((m) => m.text === note && Date.parse(m.createdAt) >= since)) return
    postSaved(cur.id, store.addMessage(cur.id, 'user', note))
  }
  /**
   * 사용자가 폰에서 무언가 하면(승인·비밀번호·인증번호) AI 답을 기다리지 않고 두리 말로 바로 한 줄 남긴다:
   * "받았어요 → 이제 이걸 할게요". 다음 화면이 한참 뒤에 움직여서 하고 있는지 모르겠다고 했다(11-20 실사용)
   */
  const sayNow = (text: string) => {
    const cur = conversation.current()
    if (!cur) return
    postSaved(cur.id, store.addMessage(cur.id, 'assistant', text))
  }
  /** 저장한 말을 폰·PC 화면에 바로 흘린다 */
  const postSaved = (threadId: string, message: StoredMessage) => {
    const event = { type: 'saved' as const, message }
    void link.broadcast({ kind: 'stream', threadId, event })
    live.emit('event', { kind: 'turn', threadId, posted: true, event })
  }
  /**
   * 연결하기를 대화에서: 내 말 "○○ 연결해 줘"와 두리의 연결 카드를 바로 남긴다.
   * AI를 부르지 않아 기다림이 없고, 로그인은 카드에서 이어 간다 (진행·결과도 같은 대화에 남는다)
   */
  const connectInChat = (card: ConnectCard) => {
    const cur = conversation.current()
    if (!cur) throw new Error('대화를 아직 열지 못했어요')
    // 같은 연결 카드가 대화 끝 가까이에 이미 있으면 또 쌓지 않는다 (여러 번 눌러도 카드 하나)
    const near = store
      .listMessages(cur.id)
      .slice(-6)
      .some((m) => {
        if (m.role !== 'tool') return false
        try {
          const rec = JSON.parse(m.text) as { kind?: string; service?: string }
          return rec.kind === 'connect' && rec.service === card.id
        } catch {
          return false
        }
      })
    if (near) return
    postSaved(cur.id, store.addMessage(cur.id, 'user', `${card.name} 연결해 줘`))
    postConnectCard(card)
  }
  /** 대화에 연결 카드만 남긴다. 카드는 마지막 연결 결과대로 [화면 열기]·[다시 해 보기]를 보여 준다 */
  const postConnectCard = (card: ConnectCard) => {
    const cur = conversation.current()
    if (!cur) return
    const record: ConnectRecordMessage = { kind: 'connect', service: card.id }
    postSaved(cur.id, store.addMessage(cur.id, 'tool', JSON.stringify(record)))
  }
  /**
   * [로그인했어요]: 믿고 표시하지 않고 확인한다. 지켜보던 탭, 그래도 모르면 사이트 첫 화면을 새로 열어
   * 로그인한 사람에게만 보이는 말이 있는지 본다 (간편 로그인 창에서 마쳤어도 사이트 쿠키로 보인다)
   */
  const connectVerify = async (card: ConnectCard): Promise<boolean> => {
    let ok = false
    const watched = loginWatch.tabOf(card.id)
    // 지켜보던 화면에 확실한 표시가 있으면 바로. 아니면 사이트를 새로 열어 마이페이지까지 본다 (짐작으로 표시하지 않는다)
    if (watched !== undefined)
      ok = await browser
        .call('snapshot', { tabId: watched, maxChars: 20_000 }, 20_000)
        .then((p) => strongSignedIn(card, p as { url: string; text: string }))
        .catch(() => false)
    if (!ok && card.site && browser.status.connected) {
      const r = await checkSignedIn(browser, card).catch(() => undefined)
      if (r) rememberCheck(card.id, r)
      ok = r?.state === 'in'
    }
    if (ok) {
      connectMark(card.id, true)
      if (watched !== undefined) await browser.call('close', { tabId: watched }).catch(() => undefined)
      void link.broadcast({
        kind: 'connect-result',
        id: card.id,
        ok: true,
        message: `${card.name}에 로그인돼 있어요.`,
      })
      void skills
        .connections()
        .then((services) => link.broadcast({ kind: 'connections', services }))
        .catch(() => {})
      return true
    }
    // 아직: 두리가 그 화면을 보고 이어서 한다 (지켜보기도 다시 켠다)
    if (watched !== undefined) loginWatch.start(card, watched)
    const left: ConnectResult = {
      ok: false,
      reason: 'unknown',
      ...(watched !== undefined ? { tabId: watched } : {}),
      message: `아직 ${card.name}에 로그인이 안 된 것 같아요.`,
    }
    const agent = agentTakeover(card, left)
    void link.broadcast({
      kind: 'connect-result',
      id: card.id,
      ...left,
      ...(agent ? { agent } : {}),
      message: agent ? `${left.message} 두리가 화면을 보고 이어서 할게요.` : left.message,
    })
    return false
  }
  /** 대화 끝(8줄 안)에 이 서비스 연결 카드가 있나 (본체를 다시 켜도 기록으로 판단한다) */
  const cardNearEnd = (card: ConnectCard) => {
    const cur = conversation.current()
    if (!cur) return false
    return store
      .listMessages(cur.id)
      .slice(-8)
      .some(
        (m) =>
          m.role === 'tool' &&
          // 연결 카드, 또는 같은 사이트의 로그인 카드(일하다 띄운 것)도 상태를 보여 주니 알림 줄이 필요 없다
          ((m.text.includes('"kind":"connect"') &&
            [card.id, card.name].some((k) => m.text.includes(`"service":${JSON.stringify(k)}`))) ||
            (m.text.includes('"kind":"login"') && m.text.includes(`"site":${JSON.stringify(card.name)}`))),
      )
  }
  const connectDone = (card: ConnectCard) => {
    const asked = connectAsked.get(card.id)
    connectAsked.delete(card.id)
    if (asked && Date.now() - asked < 30 * 60_000) {
      // 먼저 보고하고("연결됐어요 → 이어서 할게요"), 그다음 AI가 이어서 한다 (기다리는 동안 무슨 일인지 모르겠다고 했다)
      sayNow(`${card.name} 연결됐어요. 이제 하던 일을 이어서 할게요.`)
      void talk(
        appNote(
          `${card.name} 연결을 마쳤어요. 두리가 로그인까지 확인했어요. ${card.name}이 필요해서 멈춘 일을 이어서 끝내 주세요(연결 카드·로그인은 다시 띄우지 않아요). 이미 끝낸 일이면 한 문장으로만 말해 주세요.`,
        ),
      ).catch(() => {})
    }
    // 대화 끝 가까이에 이 서비스 연결 카드가 있으면 그 카드가 "연결돼 있어요"로 바뀐다. 같은 말을 알림 줄로 또 남기지 않는다
    else if (!cardNearEnd(card)) postNote(`${card.name} 연결됐어요. 이제 부탁만 하면 돼요.`)
    void link
      .notify({
        title: `${card.name} 연결됐어요`,
        body: '이제 부탁만 하면 돼요',
        tag: `connect-${card.id}`,
        url: '#tab=chat',
      })
      .catch(() => {})
  }
  /** 연결이 멈춘 순간의 화면을 기록에 남긴다: 그림 한 장, 주소(물음표 뒤 뺌), 화면 글 앞부분(칸에 든 값은 가림) */
  const journalScreen = async (id: string, tabId: number) => {
    const snap = (await browser
      .call('snapshot', { tabId, maxChars: 4_000 }, 15_000)
      .catch(() => undefined)) as { url: string; title?: string; text: string } | undefined
    const pic = (await browser
      .call('screenshot', { tabId, maxWidth: 780, quality: 50 }, 15_000)
      .catch(() => undefined)) as { data?: string } | undefined
    const shot = pic?.data ? journal.shot(id, pic.data) : undefined
    if (!snap && !shot) return
    journal.write('connect-screen', {
      id,
      ...(shot ? { shot } : {}),
      ...(snap
        ? {
            url: scrubUrl(snap.url),
            title: snap.title ?? '',
            text: scrubText(snap.text.replace(/값="[^"]*"/g, '값="(가림)"'), 1_500),
          }
        : {}),
    })
  }
  /** 일괄 점검으로 연결 중인 서비스 (대화에 카드·알림을 남기지 않는다) */
  const quietConnect = new Set<string>()
  function startConnect(
    card: ConnectCard,
    run: () => Promise<ConnectResult>,
    how = 'login',
  ): Promise<ConnectResult> {
    const running = connecting.get(card.id)
    if (running) return running
    const startedAt = Date.now()
    connectTried.set(card.id, how)
    journal.write('connect-start', { id: card.id, how })
    // 던져진 오류는 화면 표시(e2 등)가 섞인 속 이야기라 사용자에게는 쉬운 말로, 원문은 기록에만
    const p: Promise<ConnectResult> = run().catch((e: Error) => {
      console.warn(`[연결] ${card.id} 자동 로그인 오류: ${e.message}`)
      const tabId = connectTabs.get(card.id)
      return {
        ok: false,
        reason: 'unknown' as const,
        ...(tabId !== undefined ? { tabId } : {}),
        message: /\be\d+\b|ref|tabId/.test(e.message)
          ? '로그인 화면이 예상과 달라 멈췄어요. 다시 해 보기를 눌러 주세요.'
          : e.message,
      }
    })
    connecting.set(card.id, p)
    connectStatus()
    void p.then((r) => {
      // 실패 까닭은 기록에 남긴다 (사용자가 "실패했어"라고 할 때 볼 곳)
      if (!r.ok) console.warn(`[연결] ${card.id} 끝까지 못 감: ${JSON.stringify(r).slice(0, 300)}`)
      connecting.delete(card.id)
      connectSteps.delete(card.id)
      connectTabs.delete(card.id)
      // 일괄 점검(조용히)은 대화·알림을 남기지 않는다: 결과는 기록(connect-end)과 응답으로만
      const quiet = quietConnect.delete(card.id)
      // 화면을 못 알아봐 멈춘 것이면 두리(AI)가 대화에서 이어받는다
      const agent = quiet ? false : agentTakeover(card, r)
      journal.write('connect-end', {
        id: card.id,
        how,
        ok: r.ok,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.human ? { human: true } : {}),
        ...(agent ? { agent: true } : {}),
        message: r.message,
        ms: Date.now() - startedAt,
      })
      // 끝까지 못 갔으면 그 화면을 남긴다 (왜 멈췄는지 나중에 볼 수 있게)
      if (!r.ok && r.tabId !== undefined) void journalScreen(card.id, r.tabId)
      // 결과를 먼저 보내고 "연결 중" 끝을 보낸다 (반대면 카드가 잠깐 처음 상태로 돌아갔다 바뀐다)
      void link
        .broadcast({ kind: 'connect-result', id: card.id, ...r, ...(agent ? { agent, human: false } : {}) })
        .then(() => connectStatus())
      void skills
        .connections()
        .then((services) => link.broadcast({ kind: 'connections', services }))
        .catch(() => {})
      if (quiet) {
        // 연결 표시는 connectFinish가 이미 했다. 대화 알림 줄·카드·폰 알림은 남기지 않는다.
        // 못 갔으면 사람을 기다리는 탭으로 남기지 않고 닫는다 (일괄 점검에서 남은 탭이 쌓여 새 로그인 창이 닫혔다)
        if (!r.ok) {
          loginWatch.stop(card.id)
          if (r.tabId !== undefined)
            setTimeout(() => void browser.call('close', { tabId: r.tabId }).catch(() => undefined), 3_000)
        }
      } else if (r.ok) connectDone(card)
      else if (agent) {
        // 대화 끝에 그 연결 카드가 없으면 띄운다 (카드가 "두리가 이어서 해 보는 중"을 보여 준다)
        if (!cardNearEnd(card)) postConnectCard(card)
      } else if (r.human || r.tabId !== undefined) {
        // 사람이 마칠 차례: 그 화면을 폰·PC에서 열어 직접 로그인하면 두리가 알아서 확인한다
        connectHuman.add(card.id)
        // 대화 끝에 그 연결 카드가 있으면 카드가 "직접 마쳐 주세요 [화면 열기]"로 바뀐다.
        // 없으면(연결 화면에서 시작) 글 한 줄만 남기면 이어 갈 버튼이 없다: 카드를 대화에 띄운다
        if (!cardNearEnd(card)) postConnectCard(card)
        void link
          .notify({
            title: `${card.name} 연결을 마쳐 주세요`,
            body: r.message,
            tag: `connect-${card.id}`,
            url: '#tab=chat',
          })
          .catch(() => {})
      } else {
        if (!cardNearEnd(card)) postConnectCard(card)
        void link
          .notify({
            title: `${card.name} 로그인이 안 됐어요`,
            body: r.message,
            tag: `connect-${card.id}`,
            url: '#tab=chat',
          })
          .catch(() => {})
      }
    })
    return p
  }
  /**
   * 연결이 끝나면(간편 로그인 포함) 그 사이트를 기다리던 로그인 요청(두리가 일하다 띄운 로그인 카드)도 끝낸다.
   * 금고 값 없이 간편 로그인으로 들어갔으니 AI에게 그 탭을 새로 고쳐 이어서 하라고 알린다
   */
  const resolveLoginRequests = (card: ConnectCard) => {
    const site = card.site?.replace(/^www\./, '')
    if (!site) return
    for (const r of browserTools.logins.list()) {
      if (r.status !== 'pending') continue
      let host = ''
      try {
        host = new URL(r.origin).hostname
      } catch {}
      if (host !== site && !host.endsWith(`.${site}`)) continue
      browserTools.logins.finish(r.id, 'saved')
      void link.broadcast({ kind: 'login-done', id: r.id, ok: true, message: `${card.name}에 로그인했어요.` })
      const threadId = loginThread.get(r.id)
      if (threadId)
        followUp(
          threadId,
          appNote(
            `${card.name}에 로그인했어요(간편 로그인이라 금고 값은 없어요). 그 탭을 새로 고치고 하던 일을 이어서 해 주세요.`,
          ),
        )
    }
  }
  const connectMark = (id: string, on: boolean): string | undefined => {
    journal.write('connect-marked', { id, on })
    loginWatch.stop(id)
    if (on) void skills.card(id).then((card) => card && resolveLoginRequests(card))
    if (on && connectHuman.delete(id)) void skills.card(id).then((card) => card && connectDone(card))
    // 연결로 표시되면 그때 해 본 방법(간편 로그인·금고 계정)을 기억한다: 로그인이 풀리면 같은 방법으로 두리가 다시 로그인
    // (실측 11-20: 요기요 카카오 로그인을 두리가 이어받아 끝냈는데 방법이 안 남아, 풀리자 연결 카드부터 다시 떴다)
    const tried = connectTried.get(id)?.replace(/^keep:/, '')
    if (
      on &&
      tried &&
      !connectVia()[id] &&
      (tried.startsWith('social:') || /^(?:login|relogin|vault)$/.test(tried))
    )
      rememberVia(id, tried.startsWith('social:') ? tried : 'vault')
    // 카카오·네이버·구글 계정 자체를 연결하면: 그 화면에 보이는 계정을 '내 계정'으로 기억한다
    // (다른 사이트에 간편 로그인할 때 동의 화면의 계정이 이것과 같으면 묻지 않는다)
    if (on && id in SOCIAL_PROVIDERS) void rememberProviderAccount(id as SocialProvider).catch(() => {})
    const next = { ...(readSettings().connections ?? {}) }
    if (on) next[id] = new Date().toISOString()
    else delete next[id]
    store.setSetting('connections', next)
    events.emit('settings', readSettings())
    return next[id]
  }
  /** 공급자 계정 화면에서 지금 로그인된 계정을 읽어 내 계정 목록(socialAccounts)에 더한다 */
  const rememberProviderAccount = async (provider: SocialProvider) => {
    const card = await skills.card(provider)
    const url = card ? connectUrl(card) : undefined
    if (!url || !browser.status.connected) return
    const opened = (await browser.call('open', { url }, 40_000)) as { tabId: number }
    try {
      await new Promise((r) => setTimeout(r, 2_000))
      const page = (await browser.call('snapshot', { tabId: opened.tabId, maxChars: 20_000 }, 20_000)) as {
        text: string
      }
      const who = providerAccountIn(provider, page.text)
      if (!who) return
      const all = (store.getSetting('socialAccounts') as Record<string, string[]> | undefined) ?? {}
      const mine = all[provider] ?? []
      if (!mine.some((m) => sameAccount(m, who)))
        store.setSetting('socialAccounts', { ...all, [provider]: [...mine, who].slice(-5) })
      journal.write('provider-account', { provider, who: who.replace(/^(.).*@/, '$1***@') })
    } finally {
      await browser.call('close', { tabId: opened.tabId }).catch(() => undefined)
    }
  }
  /** 카드 사진: 화면이 바깥 서버에 직접 붙지 않게 본체가 받아 넘긴다 */
  const thumbs = new Thumbs(fetch, async (url) => {
    if (!browser.status.connected) return undefined
    const r = (await browser.call('thumb', { url }, 12_000)) as { data?: string }
    return typeof r?.data === 'string' && r.data.startsWith('data:image/jpeg;base64,') ? r.data : undefined
  })
  /** 카드 사진 + 사용자가 보낸 사진("photo:파일이름" — 대화 기록의 [사진: …]를 폰·PC 말풍선에 다시 보이게) */
  const thumbOrPhoto = async (url: string): Promise<string | undefined> => {
    const m = /^photo:([\w-]+\.jpg)$/.exec(url)
    if (!m) return thumbs.get(url)
    const b64 = await readFile(join(photoDir, m[1] as string))
      .then((b) => b.toString('base64'))
      .catch(() => undefined)
    return b64 ? `data:image/jpeg;base64,${b64}` : undefined
  }
  const devReset = opts.devReset ?? process.env.DOOL2_DEV_RESET === '1'
  /** 처음부터 다시 (시험용 PC): 새 사용자처럼. 금고의 비밀번호·폰 짝짓기·PC 설정(이름·AI 고르기)·일한 기록은 남긴다 */
  async function resetAll(
    phone: string,
    o: { services: boolean },
  ): Promise<{ ok: boolean; message: string }> {
    if (conversationBusy()) return { ok: false, message: '두리가 일하는 중이에요. 끝난 뒤에 다시 해 주세요' }
    const before = store.listThreads(100_000).length
    store.clearConversations()
    for (const k of RESET_KEYS) store.setSetting(k, undefined)
    life.reload()
    if (o.services) store.setSetting('connections', undefined)
    journal.write('reset', { phone, threads: before, services: o.services })
    events.emit('settings', readSettings())
    life.onChange?.()
    live.emit('event', { kind: 'reset' })
    return {
      ok: true,
      message: o.services
        ? '대화·기억·목표·보관함과 연결한 서비스 표시를 지웠어요. 처음부터 시작해요'
        : '대화·기억·목표·보관함을 지웠어요. 처음부터 시작해요',
    }
  }
  const link = new PhoneLink(
    secrets,
    {
      state: async () => {
        const agents = (await detectAll()).filter((a) => a.installed && a.loggedIn).map((a) => a.id)
        const def = readSettings().defaultAgent
        return {
          agents,
          ...(def ? { defaultAgent: def } : {}),
          extension: browser.status.connected,
          threads: threadSummaries(30),
          approvals: browserTools.approvals.list().filter((x) => x.status === 'pending'),
          logins: browserTools.logins.list().filter((x) => x.status === 'pending'),
          infos: infoRequests.pending(),
          ...(connecting.size ? { connecting: [...connecting.keys()] } : {}),
          ...(browserTools.lastTabId !== undefined ? { activeTab: browserTools.lastTabId } : {}),
          ...(devReset ? { dev: true } : {}),
        }
      },
      thread: async (id) => {
        const thread = store.getThread(id)
        return thread ? { kind: 'thread', thread, messages: store.listMessages(id) } : undefined
      },
      ask: async ({ threadId, agent, text: said, image }) => {
        // 사진: 두리 작업 폴더에 두고, 두리가 photo_view로 본다
        const text = image ? `${said}\n\n${await savePhoto(image)}` : said
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
      screen: async (tabId, fit) => {
        const s = await browserTools.remoteScreen(tabId, fit)
        remoteViewport.set(tabId, s.viewport)
        return {
          shot: s.data,
          url: s.url,
          title: s.title,
          ...(s.fields ? { fields: s.fields } : {}),
          ...(s.actions ? { actions: s.actions } : {}),
          ...(s.focus !== undefined ? { focus: s.focus } : {}),
        }
      },
      form: (tabId) => browserTools.remoteForm(tabId),
      fill: async (tabId, values, press) => {
        await browserTools.remoteFill(tabId, values, press)
      },
      remote: async ({ tabId, action, x, y, text, key, dy, w, h }) => {
        if (action === 'done') return handoffDone(tabId, '사용자가 폰에서 [다 했어요]를 눌렀어요')
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
            ...(w !== undefined ? { w } : {}),
            ...(h !== undefined ? { h } : {}),
          },
          viewport,
        )
      },
      login: (id, username, password) => saveLogin(id, username, password, true),
      infoAnswer: (id, value) => void infoRequests.answer(id, value),
      // 카드의 "처음이에요 · 가입해 주세요": 그 사이트 가입을 고른 것으로 두고, 기다리던 로그인 카드는 닫는다
      signup: (site, loginId) => {
        browserTools.allowSignup(site)
        if (loginId && browserTools.logins.finish(loginId, 'cancelled'))
          void link.broadcast({ kind: 'login-done', id: loginId, ok: false, message: '가입으로 바꿨어요' })
      },
      // 계정을 몰라요: 로그인 카드를 거두고 대화의 부탁(아이디 찾기·비밀번호 재설정)으로 이어 간다.
      // 새 비밀번호는 두리가 정해 금고에 저장한다(browser_login의 비밀번호 만들기와 같은 길)
      forgot: (site, loginId) => {
        // 사용자가 고른 것: 그 사이트의 비밀번호 재설정(새 비밀번호 만들기)을 묻지 않고 하게 한다
        browserTools.allowSignup(site)
        if (loginId && browserTools.logins.finish(loginId, 'cancelled'))
          void link.broadcast({ kind: 'login-done', id: loginId, ok: false, message: '계정 찾기로 바꿨어요' })
      },
      ...(devReset ? { reset: (phone: string, o: { services: boolean }) => resetAll(phone, o) } : {}),
      thumb: (url) => thumbOrPhoto(url),
      // 설정 > 금고 (ADR 0026): 사용자가 폰에서 보기·고치기. 보기는 폰이 기기 잠금을 확인한 뒤에만 부탁한다.
      // 비밀번호는 그 폰에만 가고, 일한 기록에는 어느 사이트를 봤는지만 남긴다
      vault: async (action) => {
        const named = async (message?: string) => {
          const cards = (await skills.connections()).map((x) => x.card)
          const hostOf = (o: string) => {
            try {
              return new URL(o).hostname.replace(/^www\./, '')
            } catch {
              return o
            }
          }
          const entries = (await vault.list()).map((e) => {
            const h = hostOf(e.origin)
            const card = cards.find((c) =>
              [c.site, ...(c.alsoSites ?? [])].some(
                (x) => x && (h === x.replace(/^www\./, '') || h.endsWith(`.${x.replace(/^www\./, '')}`)),
              ),
            )
            return { ...e, ...(card ? { name: card.name } : {}) }
          })
          return { entries, ...(message ? { message } : {}) }
        }
        if (action.kind === 'reveal') {
          const r = await vault.reveal(action.id)
          if (!r) return named('그 항목이 없어요')
          journal.write('vault-reveal', { origin: r.origin })
          return { id: action.id, username: r.username, password: r.password }
        }
        if (action.kind === 'set') {
          const r = await vault.update(action.id, { username: action.username, password: action.password })
          if (r) journal.write('vault-update', { origin: r.origin, password: Boolean(action.password) })
          return named(r ? '고쳤어요' : '그 항목이 없어요')
        }
        if (action.kind === 'delete') {
          const ok = await vault.remove(action.id)
          return named(ok ? '지웠어요' : '그 항목이 없어요')
        }
        return named()
      },
      profile: async (action) => {
        let message: string | undefined
        if (action.kind === 'set') {
          const r = await profile.update(action.values)
          journal.write('profile', r)
          const names = (l: string[]) =>
            l.map((f) => PROFILE_FIELDS[f as keyof typeof PROFILE_FIELDS]?.label ?? f).join('·')
          message = r.bad.length ? `형식이 맞지 않아 빼고 저장했어요: ${names(r.bad)}` : '저장했어요'
        } else if (action.kind === 'clear') {
          await profile.clear()
          journal.write('profile', { cleared: true })
          message = '내 정보를 모두 지웠어요'
        } else if (action.kind === 'forget-pay') {
          const now = { ...((store.getSetting('payChoices') as Record<string, string> | undefined) ?? {}) }
          delete now[action.host]
          store.setSetting('payChoices', now)
          forgetPaySubs(action.host)
          browserTools.forgetChoice(action.host)
          message = '그 사이트의 결제 수단을 잊었어요'
        } else if (action.kind === 'pay-methods') {
          const r = savePayMethods(store, action.methods)
          // 무엇을 몇 개 등록했는지만 남긴다 (가린 표시도 기록에는 넣지 않는다)
          journal.write('pay-methods', r.ok ? { kinds: r.methods.map((m) => m.kind) } : { error: r.error })
          message = r.ok ? '결제 수단을 저장했어요' : r.error
        }
        const { have, missing } = await profile.masked()
        return {
          have,
          missing,
          payChoices: (store.getSetting('payChoices') as Record<string, string> | undefined) ?? {},
          payMethods: loadPayMethods(store),
          ...(message ? { message } : {}),
        }
      },
      report: (phone, r) => {
        // 그때 PC 쪽은 어땠는지도 같이 남긴다
        journal.write('phone-report', {
          phone,
          ...(r.note ? { note: r.note } : {}),
          ...(r.app ? { app: r.app } : {}),
          count: r.trail.length,
          pc: {
            extension: browser.status.connected ? browser.status.version : 'off',
            busy: conversationBusy(),
            connecting: [...connecting.keys()],
            waiting: browserTools.approvals.list().filter((x) => x.status === 'pending').length,
          },
        })
        for (const t of r.trail)
          journal.write('phone-trail', { t: new Date(t.at).toISOString(), what: t.what })
      },
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
        if (action === 'chat') {
          connectInChat(card)
          return {}
        }
        if (action === 'verify') {
          void connectVerify(card)
          return {}
        }
        connectMark(card.id, action === 'mark')
        return {}
      },
      sideNew: async () => ({ kind: 'thread', thread: await openSide(), messages: [] }),
      sideDelete: async (id) => {
        const t = store.getThread(id)
        if (!t?.side || threads.isRunning(id)) return false
        store.deleteThread(id)
        return true
      },
      // 폰은 목표 진행 기록을 8줄만 보여 준다 (중계로 오가는 양을 줄인다)
      life: async () => life.state({ logs: 8 }),
      feedPage: async (q) => life.feedPage(q),
      libraryPage: async (q) => life.libraryPage(q),
      libraryItem: async (id) => life.libraryItem(id),
      lifeAction: async (a) => {
        life.act(a)
        if (a.action === 'identity')
          conversation.rotateSoon(
            '사용자가 두리의 말투·호칭 설정을 바꿨어요. 위 대화의 말투·호칭은 따르지 말고 지침 맨 앞 설정(없으면 기본 해요체)을 따라요.',
          )
        return life.state({ logs: 8 })
      },
      connectLogin: async (id, username, password) => {
        const card = await skills.card(id)
        if (!card) throw new Error('그런 서비스가 없어요')
        return startConnect(card, () => connectLogin(card, username, password))
      },
      connectSocial: async (id, provider) => {
        const card = await skills.card(id)
        if (!card) throw new Error('그런 서비스가 없어요')
        return startConnect(card, () => connectSocial(card, provider), `social:${provider}`)
      },
      decide: async (id, decision, choice) => {
        const label = browserTools.approvals.get(id)?.label ?? ''
        if (decision === 'approve' && approvalThread.get(id))
          sayNow(`승인 받았어요. 이제 "${label}"을(를) 누를게요.`)
        const r =
          decision === 'reject'
            ? { ok: browserTools.approvals.reject(id), message: '거절했어요' }
            : await approveAny(id, choice)
        // 폰에서 정했으면 그 결과를 AI에게 알려 이어서 하게 한다 (PC 화면은 화면이 직접 알린다)
        const threadId = approvalThread.get(id)
        if (threadId)
          followUp(
            threadId,
            decision === 'reject'
              ? appNote(`폰에서 거절했어요("${label}"). 누르지 말아 주세요.`)
              : appNote(`폰에서 승인했어요. ${r.message} 결과를 확인하고 이어서 해 주세요.`),
          )
        return r
      },
    },
    {
      relay: relayUrl,
      appUrl: () => process.env.DOOL2_APP_URL || opts.appUrl,
      name: () => readSettings().pcName || opts.pcName,
      rename: (name) => {
        store.setSetting('pcName', name)
        events.emit('settings', readSettings())
      },
      ...(opts.push ? { push: opts.push } : {}),
    },
  )
  browserTools.approvals.onChange = (rec) => void link.broadcast({ kind: 'approval', approval: rec })
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
    // 피드 글을 쓰는 따로 대화는 폰 대화 화면에 흘리지 않는다 (결과는 피드로 간다)
    const toPhones = threadId === store.getSetting('feedThread') ? () => {} : link.streamer(threadId)
    // PC 화면이 메인 대화와 따로 하는 대화를 나눠 그리게
    const side = store.getThread(threadId)?.side === true
    // 이번 답에서 승인 요청·직접 해 주세요가 나왔는지 (그러면 "끝났어요" 알림은 따로 보내지 않는다)
    let asked = false
    // 피드 "끝낸 일": 도구를 써서 일한 차례의 부탁과 답
    let askText = ''
    let usedTool = false
    let answerText = ''
    // 일한 기록: 이번 차례에 쓴 도구 이름과 걸린 시간 (말의 내용은 적지 않는다)
    const turnAt = Date.now()
    const turnTools: string[] = []
    const turnFromPhone = fromPhone.has(threadId)
    try {
      for await (const ev of inner) {
        if (ev.type === 'saved' && ev.message.role === 'user' && !readAppNote(ev.message.text))
          askText = withoutPhotoMark(ev.message.text)
        if (
          ev.type === 'agent' &&
          ev.event.type === 'tool' &&
          !/(goal|memory|library|feed)_|status|skill_/.test(ev.event.name)
        )
          usedTool = true
        if (ev.type === 'saved' && ev.message.role === 'assistant') answerText = ev.message.text
        if (ev.type === 'agent' && ev.event.type === 'tool' && turnTools.length < 60)
          turnTools.push(ev.event.name.replace(/^(mcp__dool2__|dool2_)/, ''))
        toPhones(ev)
        live.emit('event', { kind: 'turn', threadId, ...(side ? { side } : {}), event: ev })
        const rec =
          ev.type === 'saved' && ev.message.role === 'tool'
            ? (() => {
                try {
                  return JSON.parse(ev.message.text) as { kind?: string; reason?: string }
                } catch {
                  return {}
                }
              })()
            : undefined
        // 일한 과정 기록은 화면용일 뿐: 사람을 기다리는 게 아니다 ("끝났어요" 알림은 그대로 간다)
        if (rec && rec.kind !== 'work') {
          asked = true
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
      journal.write('turn', {
        where: side ? 'side' : threadId === store.getSetting('feedThread') ? 'feed' : 'main',
        ms: Date.now() - turnAt,
        tools: turnTools,
        answered: answerText.length > 0,
        ...(asked ? { waitingForUser: true } : {}),
        ...(turnFromPhone ? { phone: true } : {}),
      })
      if (usedTool && askText && answerText && !routineThreads.has(threadId))
        life.feed({
          kind: 'done',
          title: askText.slice(0, 60),
          body: answerText.slice(0, 300),
          ref: threadId,
        })
      // 다음 말에서 구간을 바꿀 참이면 요약을 미리 해 둔다 (다음 말이 바로 저장되고 바로 답하게)
      if (conversation.current()?.id === threadId) conversation.prewarm()
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
  /** 로그인 중 화면이 묻는 것(인증번호 등)을 폰 입력 화면으로 받는다 */
  const infoRequests = new InfoRequests()
  infoRequests.onCreate = (request) => {
    void link.broadcast({ kind: 'info-request', request })
    void link
      .notify({
        title:
          request.field === 'form'
            ? '내 정보를 한 번만 넣어 주세요'
            : `${request.site}: ${request.field === 'otp' ? '인증번호가 필요해요' : request.field === 'tap' ? '로봇 확인을 풀어 주세요' : '입력이 필요해요'}`,
        body: request.hint ?? request.label,
        tag: `info-${request.id}`,
        url: '',
      })
      .catch(() => {})
  }
  infoRequests.onDone = (id) => void link.broadcast({ kind: 'info-done', id })
  // 가입·비번 변경 전 묻기: 사용자가 대화에서 그렇게 부탁했으면 그대로, 아니면 폰에 고르기 카드를 띄운다.
  // 지침만으로는 AI가 묻지 않고 가입할 수 있어서, 새 비밀번호를 만들기 전에 본체가 확인한다
  browserTools.askSignup = (site, key, purpose, needOwn) => {
    const threadId = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    const lastAsk = threadId
      ? (store
          .listMessages(threadId)
          .filter((m) => m.role === 'user')
          .at(-1)?.text ?? '')
      : ''
    if (!needOwn && askedForAccount(lastAsk, purpose)) return 'ok'
    // 비밀번호는 두리가 만들지, 사용자가 정할지 고른다 (사용자가 모르게 바뀌어 당황했다, 11-20)
    const OWN = '비밀번호는 제가 정할게요'
    // 두리가 만든 비밀번호를 그 사이트 칸이 받지 않았으면 직접 정하는 것부터
    const options = needOwn
      ? [OWN, '그만둘게요']
      : purpose === 'reset'
        ? ['두리가 만들어 주세요', OWN, '그만둘게요']
        : ['가입해 주세요', OWN, '이미 계정 있어요']
    const answer = infoRequests.ask(
      {
        site,
        host: key,
        field: 'choice',
        label: needOwn
          ? `${site} 비밀번호는 직접 정해 주세요`
          : purpose === 'reset'
            ? `${site} 비밀번호를 새로 바꿀까요?`
            : `${josa(site, '은/는')} 어떻게 로그인할까요?`,
        hint: needOwn
          ? '두리가 만든 비밀번호를 이 사이트 칸이 받지 않았어요(보안 입력 칸). 규칙에 맞게 한 번만 정해 주시면 두리가 넣고 금고에 저장해요.'
          : purpose === 'reset'
            ? '비밀번호 찾기로 새 비밀번호를 정해 금고에 넣어요. 두리가 만들면 강한 비밀번호를 만들고, 직접 정하면 폰에서 한 번 넣어 주세요. 예전 비밀번호는 더 못 써요.'
            : '처음이면 두리가 가입해 드려요(아이디는 내 정보 이메일). 비밀번호는 두리가 만들거나 직접 정할 수 있어요. 이미 계정이 있으면 로그인 카드를 띄울게요.',
        options,
      },
      30 * 60_000,
    )
    void answer.then(async (v) => {
      if (!v || !threadId) return
      let yes = v.trim() === options[0]
      if (v.trim() === OWN) {
        // 새 비밀번호를 폰에서 두 번 받는다. 값은 이 본체에만, AI·기록에는 남지 않는다
        const pw = await infoRequests.ask(
          {
            site,
            host: key,
            field: 'password',
            label: `${site} 새 비밀번호`,
            hint: '두 번 넣어 주세요. 보통 8자 이상, 영문·숫자·특수문자를 섞어요. PC 금고에만 저장돼요.',
            pattern: '^.{8,64}$',
            patternHint: '8자 이상으로 넣어 주세요',
          },
          30 * 60_000,
        )
        if (!pw) return
        browserTools.setOwnPassword(key, pw)
        yes = true
      }
      if (yes) browserTools.allowSignup(key)
      followUp(
        threadId,
        appNote(
          purpose === 'reset'
            ? yes
              ? `사용자가 ${site} 비밀번호를 새로 바꾸기로 했어요. browser_new_password(purpose: "reset")로 이어서 해 주세요.`
              : `사용자가 ${site} 비밀번호 변경을 그만뒀어요. 하던 일에서 로그인이 필요한 부분은 사용자에게 알려 주세요.`
            : yes
              ? `사용자가 ${site} 가입을 골랐어요. 가입 화면에서 browser_new_password로 이어서 해 주세요.`
              : `사용자가 ${site} 계정이 이미 있대요. 가입하지 말고 로그인 화면에서 browser_login, 금고에 없으면 browser_request_login 카드를 띄워 주세요.`,
        ),
      )
    })
    return 'asked'
  }
  // 내 정보 카드: 처음 한 번만 받아 금고에 두고, 저장되면 그 대화로 이어서 하라고 알린다
  browserTools.requestCode = (tabId, field, label, hint, host, kind, firstRef, image) => {
    const threadId = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    // 주민번호 뒷자리: 저장하지 않고 이 칸에만 넣는다
    if (kind === 'rrn_back') {
      label = '주민등록번호 뒷자리'
      hint = '한 번 넣으면 이 PC 금고에 암호화해 두고 다음부터 두리가 채워요. 두리(AI)는 값을 보지 않아요.'
    }
    if (kind === 'captcha') {
      label = '그림의 글자를 넣어 주세요'
      hint = '자동입력 방지 글자예요. 그림에 보이는 글자·숫자를 그대로 넣어 주세요.'
    }
    // 같은 칸을 이미 묻고 있으면 카드를 또 띄우지 않는다 (AI가 두 번 불러 카드가 두 장 떴다)
    const same = infoRequests
      .pending()
      .find(
        (q) =>
          q.host === host &&
          q.label === label &&
          (q.field === 'otp' || q.field === 'secret' || q.field === 'text'),
      )
    // 보안문자는 그림이 바뀌었을 수 있어 앞 카드를 닫고 새로 띄운다
    if (same && kind === 'captcha') infoRequests.cancel(same.id)
    else if (same) return same.id
    const answer = infoRequests.ask(
      {
        site: host || '인증',
        host,
        field: kind === 'rrn_back' ? 'secret' : kind === 'captcha' ? 'text' : 'otp',
        ...(kind === 'captcha' && image ? { image } : {}),
        ...(kind === 'rrn_back'
          ? { pattern: '^[1-4]\\d{6}$', patternHint: '숫자 7자리예요 (첫 자리 1~4)' }
          : {}),
        label,
        ...(hint ? { hint } : {}),
      },
      10 * 60_000,
    )
    const id = infoRequests.pending().at(-1)?.id
    void answer.then(async (code) => {
      if (!code) return
      sayNow(
        kind === 'rrn_back'
          ? '주민번호 뒷자리 받았어요. 칸에 넣고 이어서 할게요.'
          : kind === 'captcha'
            ? '보안문자 받았어요. 칸에 넣고 이어서 할게요.'
            : '인증번호 받았어요. 칸에 넣고 이어서 할게요.',
      )
      // 주민번호 뒷자리는 금고(내 정보)에 저장해 다음부터 묻지 않는다
      if (kind === 'rrn_back') await profile.update({ rrn_back: code }).catch(() => undefined)
      // 넣는 동안 화면을 다시 읽었을 수 있어 표시가 바뀐다: 같은 이름의 칸을 새로 찾아 넣는다 (번호는 기록·AI에 남기지 않는다)
      const snap = (await browser.call('snapshot', { tabId, maxChars: 20_000 }).catch(() => undefined)) as
        | { text: string; url?: string }
        | undefined
      const ref = snap
        ? ([...snap.text.matchAll(/\[(e\d+) (입력칸|검색칸|비밀번호칸) "([^"]*)"\]/g)].find(
            (m) => m[3] === field,
          )?.[1] ?? '')
        : ''
      // 처음 짚은 칸에 먼저 넣고, 표시가 바뀌었으면 같은 이름의 칸을 찾아 넣는다
      // 금고와 같은 길(fill)로 넣는다: 그 사이트 주소일 때만, 가린 칸(비밀번호칸)도 된다. 값은 돌려받지 않는다
      let origin = ''
      try {
        origin = new URL((snap as { url?: string } | undefined)?.url ?? '').origin
      } catch {}
      const put = (r: string) =>
        origin
          ? browser
              .call('fill', {
                tabId,
                ref: r,
                value: code,
                origin,
              })
              .then(
                () => true,
                () => false,
              )
          : Promise.resolve(false)
      const ok = (firstRef ? await put(firstRef) : false) || (ref ? await put(ref) : false)
      if (!threadId) return
      followUp(
        threadId,
        appNote(
          ok
            ? `사용자가 폰에서 ${kind === 'rrn_back' ? '주민번호 뒷자리' : kind === 'captcha' ? '보안문자' : '인증번호'}를 넣어 "${field}" 칸에 들어갔어요. 페이지를 읽고 [확인]·[인증] 버튼을 눌러 하던 일을 이어서 해 주세요.`
            : `사용자가 인증번호를 넣었는데 "${field}" 칸을 화면에서 찾지 못해 넣지 못했어요. 페이지를 읽어 칸을 확인하고 browser_request_code를 다시 써 주세요.`,
        ),
      )
    })
    return id
  }
  // 사람에게 넘긴 화면: 사용자가 [다 했어요]를 누르거나 화면이 바뀌면(마친 듯) 대화에 말을 쓰게 하지 않고 두리가 이어 간다
  // (사용자 11-20: "다 했어 이런 거 말 안 하고 알아서 잘 인지하고 했으면")
  const handoffDoneAt = new Map<number, number>()
  const handoffDone = (tabId: number, why: string) => {
    browserTools.stopHandoffWatch(tabId)
    if (Date.now() - (handoffDoneAt.get(tabId) ?? 0) < 20_000) return
    handoffDoneAt.set(tabId, Date.now())
    const threadId = conversation.current()?.id
    if (!threadId) return
    sayNow('화면이 바뀐 걸 봤어요. 확인하고 이어서 할게요.')
    followUp(
      threadId,
      appNote(
        `넘긴 화면이 바뀌었어요(${why}). 사용자가 마친 것 같아요. 탭 ${tabId}(닫혔으면 원래 탭)을 다시 읽어 확인하고 하던 일을 이어서 끝내요. 아직 남은 일이 있으면 그것만 한 문장으로 말해요. 사용자에게 "다 했다고 말해 달라"고 하지 않아요.`,
      ),
    )
  }
  browserTools.onHandoffChanged = handoffDone
  // 그림 눌러 풀기(로봇 확인): 폰 카드에서 누른 곳(그림 기준 0~1000)을 PC 화면의 같은 자리에 차례로 누른다
  browserTools.requestTap = (tabId, say, host, image, rect, taps) => {
    const threadId = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    // 같은 사이트의 앞 그림 카드는 닫는다 (문제 그림이 바뀌었다)
    for (const q of infoRequests.pending())
      if (q.field === 'tap' && q.host === host) infoRequests.cancel(q.id)
    const answer = infoRequests.ask(
      {
        site: host || '로봇 확인',
        host,
        field: 'tap',
        label: say,
        hint:
          taps > 1
            ? `맞는 곳을 모두 누르고(최대 ${taps}곳) [다 눌렀어요]를 눌러 주세요`
            : '그림에서 맞는 곳을 한 번 눌러 주세요',
        image,
        maxTaps: taps,
      },
      10 * 60_000,
    )
    const id = infoRequests.pending().at(-1)?.id
    void answer.then(async (value) => {
      if (!value) return
      const points = value
        .split(';')
        .map((p) => p.split(',').map(Number))
        .filter(
          (p): p is [number, number] =>
            p.length === 2 && p.every((n) => Number.isFinite(n) && n >= 0 && n <= 1000),
        )
        .slice(0, taps)
      sayNow(`눌러 주신 ${points.length}곳 받았어요. PC 화면에서 같은 자리를 누를게요.`)
      let ok = points.length > 0
      for (const [px, py] of points) {
        const x = Math.round(rect.x + (px / 1000) * rect.w)
        const y = Math.round(rect.y + (py / 1000) * rect.h)
        const r = await browser.call('input', { tabId, action: 'tap', x, y }, 15_000).then(
          () => true,
          () => false,
        )
        if (!r) {
          ok = false
          break
        }
        await new Promise((res) => setTimeout(res, 350))
      }
      journal.write('tap-solved', { host, taps: points.length, ok })
      if (!threadId) return
      followUp(
        threadId,
        appNote(
          ok
            ? `사용자가 폰 그림 카드에서 ${points.length}곳을 눌러 PC 화면의 같은 자리를 눌렀어요. 페이지를 다시 읽어 [확인]·[제출]이 있으면 누르고, 로봇 확인이 또 나오면 browser_request_tap을 다시 써서 하던 일을 이어서 해 주세요.`
            : '사용자가 그림 카드에서 누른 곳을 PC 화면에 누르지 못했어요. 화면을 다시 읽고 browser_request_tap을 다시 써 주세요.',
        ),
      )
    })
    return id
  }
  // 결제 비밀번호: 폰 보안 키패드로 받아 짚어 둔 키패드 버튼을 차례로 누른다. 값은 기록·AI에 남기지 않는다
  browserTools.requestPin = (tabId, label, host, keys, length) => {
    const threadId = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    const answer = infoRequests.ask(
      {
        site: host || '결제',
        host,
        field: 'secret',
        label,
        hint: `${length}자리를 넣으면 두리가 화면 키패드를 대신 눌러요. 두리(AI)는 값을 보지 않고, 저장하지 않아요.`,
        // 폰 보안 키패드는 마지막 {n}+1을 자릿수로 읽는다 (주민번호 '^[1-4]\\d{6}$' = 7자리)
        pattern: `^\\d\\d{${length - 1}}$`,
        patternHint: `숫자 ${length}자리예요`,
      },
      5 * 60_000,
    )
    const id = infoRequests.pending().at(-1)?.id
    void answer.then(async (pin) => {
      if (!pin) return
      sayNow('비밀번호 받았어요. 이제 화면 키패드를 차례로 누를게요.')
      const ok = await browserTools.pressPin(tabId, keys, pin)
      journal.write('pin-typed', { host, ok })
      if (!threadId) return
      followUp(
        threadId,
        appNote(
          ok
            ? '사용자가 폰 키패드로 결제 비밀번호를 넣어 두리가 화면 키패드를 눌렀어요. 페이지를 읽어 결제가 끝났는지(주문 완료·번호) 확인하고 알려 주세요. 키패드가 그대로면 자리가 바뀐 것이니 다시 짚어 browser_request_code(kind: "pin")를 불러요.'
            : '결제 비밀번호를 누르다 키패드 버튼을 찾지 못했어요. 페이지를 다시 읽고 키패드를 다시 짚어 browser_request_code(kind: "pin")를 불러 주세요.',
        ),
      )
    })
    return id
  }
  browserTools.requestProfile = (fields, reason, options) => {
    const threadId = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    const names = (list: string[]) =>
      list.map((f) => PROFILE_FIELDS[f as keyof typeof PROFILE_FIELDS].label).join('·')
    // 간편인증 앱은 글로 받지 않고 고르기 카드로 따로 (그 사이트 간편인증 창에 보이는 앱 중에서)
    const appOptions = (options?.length ? options : [...AUTH_APPS]).slice(0, 10)
    // 생년월일·휴대폰을 받는 카드는 본인인증용이라, 기본 앱이 없으면 같은 카드에서 앱도 고르게 한다
    const identity = fields.includes('birth') && fields.includes('phone')
    const wantsApp = fields.includes('auth_app') || identity
    const formFields = fields.filter((f) => f !== 'auth_app')
    const askApp = async (): Promise<string> => {
      const picked = await infoRequests.ask(
        {
          site: '두리',
          host: '내 정보',
          field: 'choice',
          label: '간편인증 앱',
          hint: '어느 앱으로 본인인증을 승인할지 골라 주세요. 처음 고른 앱은 내 정보에 기본으로 저장돼요.',
          options: appOptions,
        },
        30 * 60_000,
      )
      if (!picked) return ''
      // 기본이 없을 때만 기본으로 저장한다 (사이트마다 되는 앱이 달라 이번에만 다른 앱을 고를 수 있다)
      if (!(await profile.get()).auth_app) await profile.update({ auth_app: picked })
      return `간편인증 앱은 이번에 '${picked}'로 골랐어요. 그 이름의 버튼을 눌러 [인증 요청]까지 누르고 폰 승인을 부탁해요.`
    }
    const answer = formFields.length
      ? infoRequests.ask(
          {
            site: '두리',
            host: '내 정보',
            field: 'form',
            label: '내 정보',
            hint: `${reason || '예약·주문 칸을 채우려고 해요'}. 한 번만 넣어 두면 다음부터는 두리가 알아서 채워요.`,
            fields: [
              ...formFields.map((key) => ({ key, ...PROFILE_FIELDS[key] })),
              // 간편인증 앱은 같은 카드 맨 아래 칩으로 (글로 받지 않는다)
              ...(wantsApp ? [{ key: 'auth_app', ...PROFILE_FIELDS.auth_app, options: appOptions }] : []),
            ],
          },
          30 * 60_000,
        )
      : Promise.resolve('{}')
    const id = infoRequests.pending().at(-1)?.id
    void answer.then(async (raw) => {
      if (!raw) return
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return
      }
      const { saved, bad } = formFields.length ? await profile.update(input) : { saved: [], bad: [] }
      if (formFields.length) journal.write('profile', { saved, bad })
      // 같은 카드에서 골랐으면 그걸로, 앱만 받는 경우(사이트별로 다른 앱)는 고르기 카드로
      const pickedInForm = typeof input.auth_app === 'string' && input.auth_app ? input.auth_app : ''
      const app = pickedInForm
        ? `간편인증 앱은 '${pickedInForm}'로 골랐어요. 그 이름의 버튼을 눌러 [인증 요청]까지 누르고 폰 승인을 부탁해요.`
        : wantsApp && !formFields.length
          ? await askApp()
          : ''
      if (!threadId) return
      followUp(
        threadId,
        appNote(
          [
            formFields.length
              ? `내 정보를 저장했어요(${names(saved) || '없음'})${bad.length ? `. 형식이 맞지 않아 빠진 것: ${names(bad)}` : ''}.`
              : '',
            app,
            'browser_fill_profile로 칸을 채우고 하던 일을 이어서 해 주세요.',
          ]
            .filter(Boolean)
            .join(' '),
        ),
      )
    })
    return id ?? (wantsApp ? infoRequests.pending().at(-1)?.id : undefined)
  }
  /**
   * 연결 중 사람에게 넘기는 대신 폰에 묻는다: 공급자 계정은 로그인 카드(금고)로, 인증번호는 입력 화면으로
   */
  const loginAsk = (card: ConnectCard): LoginAsk => ({
    // 공급자 계정이 여럿일 때 고른 계정 (구글 계정 고르기 화면에 보이는 글: "이름 m***@gmail.com")
    account: {
      get: (provider) =>
        (store.getSetting('providerAccounts') as Record<string, string> | undefined)?.[provider],
      set: (provider, label) =>
        store.setSetting('providerAccounts', {
          ...((store.getSetting('providerAccounts') as Record<string, string> | undefined) ?? {}),
          [provider]: label.slice(0, 120),
        }),
    },
    // 사용자가 "내 계정"이라고 확인해 준 공급자 계정들 (가린 이메일 글 그대로, 비밀값 아님).
    // 구글 계정 고르기에서 고른 계정도 내 계정으로 본다
    known: {
      has: (provider, label) => {
        const mine =
          (store.getSetting('socialAccounts') as Record<string, string[]> | undefined)?.[provider] ?? []
        const picked = (store.getSetting('providerAccounts') as Record<string, string> | undefined)?.[
          provider
        ]
        return mine.some((m) => sameAccount(m, label)) || Boolean(picked && sameAccount(picked, label))
      },
      add: (provider, label) => {
        const all = (store.getSetting('socialAccounts') as Record<string, string[]> | undefined) ?? {}
        const mine = all[provider] ?? []
        if (!mine.some((m) => sameAccount(m, label)))
          store.setSetting('socialAccounts', { ...all, [provider]: [...mine, label.slice(0, 120)].slice(-5) })
      },
    },
    credentials: async (origin, label, tabId) => {
      // 폰에서 "화면 보면서 직접 할게요"를 고르면 그 로그인 탭을 원격 화면으로 연다
      browserTools.holdForPerson(tabId)
      const r = browserTools.logins.create({ tabId, origin, site: label, connect: true })
      // 연결 카드에 "카카오 계정이 필요해요 [넣기]"가 보이게 한다 (빙글빙글 도는 동안 무엇을 기다리는지 모르지 않게)
      connectStep(card.id)(`${josa(label, '이/가')} 필요해요`, {
        kind: 'login',
        id: r.id,
        label: `${label} 넣기`,
      })
      // 폰에서 넣으면 saveLogin이 금고에 넣고 요청을 끝낸다. 그때 금고 값을 돌려준다
      for (let i = 0; i < 300; i++) {
        await new Promise((ok) => setTimeout(ok, 1_000))
        const x = browserTools.logins.get(r.id)
        if (x?.status === 'saved') return vault.findForOrigin(origin)
        if (!x || x.status !== 'pending') return undefined
      }
      return undefined
    },
    info: (q) => {
      const answer = infoRequests.ask({ ...q, site: card.name })
      const req = infoRequests.pending().at(-1)
      if (req)
        // 고르기 질문("카카오 계정 ○○로 할까요?")은 그 말 그대로, 넣을 값(인증번호)은 "○○이 필요해요"
        connectStep(card.id)(q.field === 'choice' ? q.label : `${josa(q.label, '이/가')} 필요해요`, {
          kind: 'info',
          id: req.id,
          label: q.field === 'choice' ? '고르기' : `${q.label} 넣기`,
        })
      return answer
    },
  })
  browserTools.siteConnector = (url) => connectors.forUrl(url)
  // 일하다가 금고로 로그인한 탭도 지켜본다: 로그인되면 그 서비스를 연결로 표시한다
  // (실측 11-21 신한카드: 대화에서 가입·로그인해 카드 정보까지 읽었는데 연결 목록에는 '연결 안 됨'으로 남았다)
  browserTools.onVaultLogin = (tabId, url) => {
    void connectors
      .forUrl(url)
      .then(async (c) => {
        if (!c || readSettings().connections?.[c.id]) return
        const card = await skills.card(c.id)
        if (!card) return
        // 금고로 로그인했으니 풀리면 금고로 다시 로그인하게 방법을 남긴다 (connectMark가 기억)
        connectTried.set(card.id, 'vault')
        loginWatch.start(card, tabId)
      })
      .catch(() => undefined)
  }
  void connectors
    .paySites()
    .then((sites) => browserTools.setPayServiceSites(sites))
    .catch(() => {})
  // 연결을 이어받은 탭: 로그인 화면이 그 서비스 사이트의 다른 주소(login.사이트)면 연결할 때 넣은 계정을 쓴다.
  // 다른 사이트(간편 로그인 공급자 등)로 넘어간 화면에는 넣지 않는다
  browserTools.siteLogin = async (tabId, origin) => {
    const id = takeoverTabs.get(tabId)
    const card = id ? await skills.card(id) : undefined
    const url = card ? connectUrl(card) : undefined
    const site = card?.site?.replace(/^www\./, '')
    if (!url || !site) return undefined
    let host = ''
    try {
      host = new URL(origin).hostname
    } catch {
      return undefined
    }
    if (host !== site && !host.endsWith(`.${site}`)) return undefined
    return vault.findForOrigin(new URL(url).origin)
  }
  // 확장이 닫힌 두리 탭을 알리면 그 탭 기록을 지운다 (안 지우면 하루 내내 쌓인다)
  browser.on('notice', (n) => {
    if (n.event === 'tab-closed') {
      takeoverTabs.delete(n.tabId)
      browserTools.forgetTab(n.tabId)
      connectors.forgetTab(n.tabId)
    }
  })
  browserTools.notifyUser = (title, body) =>
    void link.notify({ title, body, tag: 'auth-wait', url: '#tab=chat' }).catch(() => {})
  // 간편인증 승인 기다리기: 폰 카드의 [인증 완료했어요]를 누르면 두리가 사이트의 [인증 완료]를 한 번 누른다
  browserTools.askAuthDone = (host, label, hint) => {
    const answer = infoRequests.ask(
      { site: host || '간편인증', host, field: 'choice', label, hint, options: ['인증 완료했어요'] },
      200_000,
    )
    const id = infoRequests.pending().at(-1)?.id
    return { answer, cancel: () => void (id && infoRequests.cancel(id)) }
  }
  browserTools.onActiveTab = (tabId) => void link.broadcast({ kind: 'work-tab', tabId }, { live: true })
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
    // 로그인에 성공하기 전까지는 '확인 전': 사이트가 틀렸다고 하면 금고에서 지우고 카드를 다시 받는다
    browserTools.markUnverified(r.origin)
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
    // 먼저 챙긴 일은 AI를 부르지 않고 대화에 카드로만 남겼다. 사용자가 그 얘기를 이어 하면 알아듣게 이번 차례에 덧붙인다
    const told = unseenTells.splice(0)
    const aside = told.length
      ? appNote(
          `대화에 먼저 알린 것 (사용자가 이 이야기를 할 수 있어요):\n${told.map((t) => `- ${t.title}${t.body ? ` — ${t.body}` : ''}${t.from ? ` (${t.from})` : ''}`).join('\n')}`,
        )
      : undefined
    void (async () => {
      for await (const _ of tracked(sessionId, threads.send(sessionId, text, aside ? { aside } : {}))) {
      }
    })().catch(() => {})
    return { queued: false }
  }
  /** 대화에 카드로 남겼지만 AI는 아직 모르는 먼저 챙긴 일 */
  const unseenTells: TellRecordMessage[] = []
  // ── 목표·알아서 하는 일: 정해진 때 두리가 한다 ──
  /** 예약한 일을 하고 있는 대화 (그 차례는 피드 "끝낸 일"에 따로 넣지 않는다) */
  const routineThreads = new Set<string>()
  /** 피드 글은 대화를 어지럽히지 않게 따로 쓰는 대화에서 */
  const feedThreadId = async () => {
    const saved = store.getSetting('feedThread')
    if (typeof saved === 'string' && store.getThread(saved)) return saved
    const t = store.createThread(await pickAgent(undefined), '두리 피드', undefined, true)
    store.setSetting('feedThread', t.id)
    return t.id
  }
  async function runRoutine(r: Routine, tries = 0) {
    let threadId: string
    let text: string
    // 조건에 맞을 때만 알리는 일은 따로 하는 대화에서 (맞는 게 없는 날 메인 대화에 "알릴 것 없음"이 쌓이지 않게)
    const quietly = r.target === 'feed' || r.notify === 'when_found'
    if (quietly) {
      threadId = await feedThreadId()
      text = r.target === 'feed' ? routineAsk(r) : `예약해 둔 일이에요 ("${r.title}"). ${routineAsk(r)}`
    } else {
      // 대화로: 답하는 중이면 줄을 선다
      text = appNote(`예약해 둔 일이에요 ("${r.title}"). ${routineAsk(r)} 인사 없이 결과부터 짧게 써 주세요.`)
      if (conversationBusy()) {
        queued.push(text)
        live.emit('event', { kind: 'queued', texts: [...queued] })
        return
      }
      threadId = (await conversation.prepare(await pickAgent(undefined))).session.id
    }
    if (threads.isRunning(threadId)) {
      // 따로 하는 대화가 다른 일(먼저 챙기기·아이디어) 중이면 1분 뒤 다시 (30분까지)
      if (quietly && tries < 30)
        setTimeout(() => void runRoutine(r, tries + 1).catch(() => {}), 60_000).unref?.()
      return
    }
    routineThreads.add(threadId)
    let answer = ''
    try {
      for await (const ev of tracked(threadId, threads.send(threadId, text)))
        if (ev.type === 'saved' && ev.message.role === 'assistant') answer = ev.message.text
    } finally {
      routineThreads.delete(threadId)
    }
    if (!answer) return
    const run = life.noteRun(r.id, answer)
    // 조건에 맞지 않았으면 피드에도 폰에도 알리지 않는다
    if (!run || run.quiet) return
    // 따로 한 대화의 결과는 메인 대화에도 두리 카드로 남긴다 (사용자가 이어 말할 수 있게)
    if (r.target !== 'feed' && quietly && run.item) tellInChat(run.item)
    const push = () =>
      void link
        .notify({
          title: r.target === 'feed' ? '피드에 새 글' : r.title,
          body: (run.item?.body ?? answer).replace(/\*\*/g, '').replace(/\s+/g, ' ').slice(0, 120),
          tag: `routine-${r.id}`,
          url: r.target === 'feed' ? '#tab=feed' : '#tab=chat',
        })
        .catch(() => {})
    // "밤새 해 두고 아침에 알려 줘": 결과는 대화에 바로 남기고 폰 알림만 정한 시각까지 미룬다
    const wait = tellDelay(r.tellAt, new Date())
    if (wait > 0) setTimeout(push, wait).unref?.()
    else push()
  }
  // 예전에 만든 피드 대화도 따로 하는 대화로 (메인 대화에 섞이지 않게)
  {
    const f = store.getSetting('feedThread')
    if (typeof f === 'string' && store.getThread(f)) store.setSide(f)
  }
  // 맞춤 아이디어: 피드 대화에서 두리에게 찾아 달라고 한다 (결과는 idea_suggest 도구로 들어온다)
  life.onIdeas = () =>
    void (async () => {
      const threadId = await feedThreadId()
      if (threads.isRunning(threadId)) return
      const ask =
        '아이디어 탭에 올릴 맞춤 할 일을 찾아 주세요. 기억·목표·연결한 서비스·최근 대화를 떠올려, 지금 두리가 실제로 해 줄 수 있는 구체적인 일 3~6개를 골라 idea_suggest로 올려요. 웹을 열 필요는 없어요. 답은 한 문장으로만.'
      routineThreads.add(threadId)
      try {
        for await (const _ of tracked(threadId, threads.send(threadId, ask))) {
        }
      } finally {
        routineThreads.delete(threadId)
        if (life.ideasBusy) {
          life.ideasBusy = false
          life.onChange?.()
        }
      }
    })().catch(() => {
      life.ideasBusy = false
    })
  // 먼저 챙기기: 아침 6시~밤 10시 한 시간마다, 챙길 때가 된 한 일과 연결한 서비스를 살펴 챙길 일이 있으면 feed_tell로 올린다 (없으면 조용히)
  life.watchSources = () => Object.keys(readSettings().connections ?? {})
  life.onWatch = (lastWatch) =>
    void (async () => {
      const threadId = await feedThreadId()
      if (threads.isRunning(threadId)) return
      const services = (await skills.connections()).filter((c) => c.connectedAt && c.card.how !== 'device')
      const due = life.knowDue()
      if (!services.length && !due.length) return
      routineThreads.add(threadId)
      try {
        for await (const _ of tracked(
          threadId,
          threads.send(threadId, watchPrompt(services, life.recentTells(), new Date(), due, lastWatch)),
        )) {
        }
      } finally {
        routineThreads.delete(threadId)
      }
    })()
      .catch(() => {})
      .finally(() => life.watchDone())
  // 먼저 챙긴 일: 메인 대화에도 두리 카드로 남긴다 (AI를 부르지 않는다). 답하는 중이면 끝난 뒤에 (5분까지 기다림)
  const tellInChat = (f: FeedItem, tries = 0) => {
    const cur = conversation.current()
    if (!cur) return
    if (conversationBusy() && tries < 60) {
      setTimeout(() => tellInChat(f, tries + 1), 5_000).unref?.()
      return
    }
    const rec: TellRecordMessage = {
      kind: 'tell',
      id: f.id,
      title: f.title,
      ...(f.body ? { body: f.body } : {}),
      ...(f.from ? { from: f.from } : {}),
      ...(f.ask ? { ask: f.ask } : {}),
      ...(f.askLabel ? { askLabel: f.askLabel } : {}),
    }
    postSaved(cur.id, store.addMessage(cur.id, 'tool', JSON.stringify(rec)))
    unseenTells.push(rec)
    if (unseenTells.length > 6) unseenTells.shift()
  }
  life.onTell = (f) => {
    tellInChat(f)
    void link
      .notify({ title: f.title, body: f.body ?? f.from ?? '', tag: `tell-${f.id}`, url: '#tab=chat' })
      .catch(() => {})
  }
  life.onDue = (r) =>
    void runRoutine(r).catch((e: Error) => life.noteRun(r.id, `하지 못했어요: ${e.message}`))
  const lifeTimer = setInterval(() => life.tick(), 30_000)
  lifeTimer.unref?.()

  /**
   * 연결 유지: 하루 두 번(마지막 뒤 11시간 넘고, 한국 시간 8~22시) 연결한 서비스마다 로그인이 살아 있는지 조용히 본다.
   * 들어가 보는 것만으로 세션이 늘어나는 곳이 많고, 풀렸으면 연결할 때 쓴 방법(간편 로그인·금고 계정)으로 다시 로그인한다.
   * 사람이 해야 하는 단계(카톡 확인·본인인증)나 방법을 모르는 곳만 모아 한 번 알린다.
   * 실측(2026-11-19): 연결 몇 시간 만에 9곳이 풀렸고, 그중 4곳은 기억한 카카오로 사람 손 없이 다시 로그인됐다
   */
  let keeping = false
  const keepConnections = async (
    force = false,
  ): Promise<{ checked: number; relogged: string[]; need: string[] }> => {
    const result = { checked: 0, relogged: [] as string[], need: [] as string[] }
    if (keeping || !browser.status.connected) return result
    const last = Date.parse(String(store.getSetting('connectKeptAt') ?? '')) || 0
    const hour = Number(
      new Date().toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Seoul' }),
    )
    if (!force && (Date.now() - last < 11 * 3_600_000 || hour < 8 || hour >= 22)) return result
    if (!force && (conversationBusy() || connecting.size > 0)) return result
    keeping = true
    store.setSetting('connectKeptAt', new Date().toISOString())
    try {
      const services = (await skills.connections()).filter((x) => x.connectedAt && x.card.how === 'browser')
      // 간편 로그인 계정(카카오·네이버·구글)을 먼저: 이것이 살아 있어야 다른 곳을 버튼만으로 다시 로그인한다
      services.sort((a, b) => Number(b.card.category === 'account') - Number(a.card.category === 'account'))
      for (const s of services) {
        if (conversationBusy() && !force) break
        const card = s.card
        const r = await checkSignedIn(browser, card).catch(() => undefined)
        if (!r) continue
        result.checked++
        rememberCheck(card.id, r)
        if (r.state !== 'out') continue
        const via = connectVia()[card.id]
        const provider = via?.startsWith('social:') ? (via.slice(7) as SocialProvider) : undefined
        // 방법이 안 남았어도 금고에 그 서비스 계정이 있으면 금고로 다시 로그인한다
        // (실측 11-21: 두리가 일하다 금고로 로그인한 신한카드가 세션이 풀리자 연결 표시가 꺼졌다)
        const creds = via === 'vault' || !provider ? await vaultCreds(card) : undefined
        let ok = false
        if (provider && provider in SOCIAL_PROVIDERS) {
          quietConnect.add(card.id)
          ok = (
            await startConnect(card, () => connectSocial(card, provider, true), `keep:social:${provider}`)
          ).ok
        } else if (creds) {
          quietConnect.add(card.id)
          ok = (
            await startConnect(card, () => connectLogin(card, creds.username, creds.password), 'keep:vault')
          ).ok
        }
        // 다시 로그인했다고 나와도 한 번 더 확인한다 (짐작으로 'ok'가 나온 적이 있다)
        if (ok) ok = (await checkSignedIn(browser, card).catch(() => undefined))?.state === 'in'
        if (ok) result.relogged.push(card.name)
        else if (provider || creds) result.need.push(card.name)
        else {
          connectMark(card.id, false)
          result.need.push(card.name)
        }
      }
      journal.write('connect-keep', { checked: result.checked, relogged: result.relogged, need: result.need })
      // 다시 로그인할 방법을 모르는 곳만 알린다 (방법이 있으면 쓸 때 두리가 알아서 다시 로그인한다)
      const unknownWay = result.need.filter((n) => {
        const c = services.find((x) => x.card.name === n)?.card
        return c ? !connectVia()[c.id] : true
      })
      if (unknownWay.length)
        void link
          .notify({
            title: `로그인이 풀린 곳 ${unknownWay.length}곳`,
            body: `${unknownWay.slice(0, 4).join('·')}${unknownWay.length > 4 ? ' 등' : ''} — 연결 화면에서 다시 연결해 주세요`,
            tag: 'connect-keep',
            url: '#tab=connect',
          })
          .catch(() => {})
      void skills
        .connections()
        .then((list) => link.broadcast({ kind: 'connections', services: list }))
        .catch(() => {})
      return result
    } finally {
      keeping = false
    }
  }
  const keepTimer = setInterval(() => void keepConnections().catch(() => {}), 30 * 60_000)
  keepTimer.unref?.()
  // 바뀌면 폰·PC에 다시 보낸다 (잠깐 모아서)
  let lifePush: ReturnType<typeof setTimeout> | undefined
  life.onChange = () => {
    clearTimeout(lifePush)
    lifePush = setTimeout(() => {
      void link.broadcast({ kind: 'life', state: life.state({ logs: 8 }) })
      live.emit('event', { kind: 'life' })
    }, 300)
  }

  /** 원격 화면: 마지막으로 보낸 화면의 페이지 크기 (폰이 누른 비율을 좌표로 바꾸려고) */
  const remoteViewport = new Map<number, { width: number; height: number }>()
  /**
   * 대화 목록 + 홈 화면용 정보: 답하는 중인지, 마지막 답 미리보기(앞의 몇 개만), 기다리는 승인.
   * PC 앱과 폰이 같은 걸 받는다
   */
  /** 따로 하는 대화 새로 열기: 빈 대화가 있으면 그걸 다시 쓰고, SIDE_THREAD_MAX개면 지워 달라고 한다 */
  async function openSide(agent?: AgentId) {
    const feed = store.getSetting('feedThread')
    const t = store.openSideThread(
      agent ?? (await pickAgent(undefined)),
      SIDE_THREAD_MAX,
      typeof feed === 'string' ? feed : undefined,
    )
    if (!t)
      throw new Error(
        `따로 하는 대화는 ${SIDE_THREAD_MAX}개까지 둘 수 있어요. 다 끝낸 대화를 지우고 다시 만들어 주세요.`,
      )
    return t
  }
  function threadSummaries(limit = 50, previews = 6): ThreadSummary[] {
    const waiting = new Map<string, ApprovalView>()
    for (const ap of browserTools.approvals.list()) {
      const t = ap.status === 'pending' ? approvalThread.get(ap.id) : undefined
      if (t) waiting.set(t, ap)
    }
    // 메인 대화 구간이 많이 쌓여도 따로 하는 대화가 목록에서 밀려나지 않게 따로 붙인다
    const recent = store.listThreads(limit)
    const seen = new Set(recent.map((t) => t.id))
    const all = [...recent, ...store.listSideThreads(SIDE_THREAD_MAX + 1).filter((t) => !seen.has(t.id))]
    all.sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0))
    return all.map((t, i) => {
      const out: ThreadSummary = {
        id: t.id,
        agent: t.agent,
        title: t.title,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        ...(t.side ? { side: true } : {}),
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
      // PC 파일 도구 (ADR 0022·0024): 바탕화면·문서·다운로드에서 찾기·읽기, 새 파일 만들기, 옮기기·사진 바꾸기·출력
      if (req.method === 'POST' && b === 'file' && c && !d) {
        const args = (await readJson(req)) as Record<string, unknown>
        const r = await fileTools.run(c, args && typeof args === 'object' ? args : {})
        journal.write('file-tool', {
          tool: c,
          ok: !r.isError,
          path: typeof args?.path === 'string' ? args.path : args?.name,
          ...(Array.isArray(args?.moves) ? { count: args.moves.length } : {}),
          ...(Array.isArray(args?.paths) ? { count: args.paths.length } : {}),
        })
        return json(res, 200, r)
      }
      if (req.method === 'POST' && b === 'life' && c === 'connect_ask' && !d) {
        const args = (await readJson(req)) as { service?: unknown }
        const q = String(args.service ?? '').slice(0, 60)
        const text = (t: string, isError = false) =>
          json(res, 200, { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: t }] })
        const items = await skills.connections()
        const card = findCard(
          items.map((x) => x.card),
          q,
        )
        if (!card)
          return text(
            `"${q}" 연결 카드가 없어요. 목록에 없는 사이트면 browser_open으로 열고, 로그인이 필요하면 browser_request_login을 써요.`,
            true,
          )
        if (card.how === 'device')
          return text(`${card.name}은 폰 권한이에요. 사용자에게 폰의 연결 화면에서 켜 달라고 말해요.`)
        if (connecting.has(card.id))
          return text(`지금 ${card.name}에 로그인하는 중이에요. 끝나면 대화로 알림이 와요.`)
        // 같은 계정(네이버 메일 → 네이버)이 연결돼 있으면 카드를 띄우지 않는다
        const parent = card.sameLoginAs ? items.find((x) => x.card.id === card.sameLoginAs) : undefined
        if (parent?.connectedAt)
          return text(
            `${card.name}은 ${parent.card.name} 계정으로 로그인해요. ${parent.card.name}이 이미 연결돼 있으니 연결 카드 없이 ${card.name} 도구를 바로 써요. 도구가 로그인 화면을 만나면 그때 connect_ask('${parent.card.id}')로 다시 연결해요.`,
          )
        // 로그인이 필요해졌는데 금고 계정이나 전에 쓴 간편 로그인이 있으면 묻지 않고 두리가 다시 로그인한다.
        // 끝나면 connectDone이 "멈춘 일을 이어서 해 주세요"를 대화로 보낸다
        const creds = card.how === 'browser' ? await vaultCreds(card) : undefined
        const via = connectVia()[card.id]
        const provider = via?.startsWith('social:') ? (via.slice(7) as SocialProvider) : undefined
        if (creds || (provider && provider in SOCIAL_PROVIDERS)) {
          connectAsked.set(card.id, Date.now())
          void startConnect(
            card,
            () =>
              creds
                ? connectLogin(card, creds.username, creds.password)
                : connectSocial(card, provider as SocialProvider),
            creds ? 'relogin' : `social:${provider}`,
          )
          const how = creds
            ? '금고에 있는 계정'
            : `전에 쓴 ${SOCIAL_PROVIDERS[provider as SocialProvider].label} 간편 로그인`
          return text(
            `${card.name}에 ${how}으로 두리 본체가 다시 로그인하고 있어요. 끝나면 대화 알림으로 이어서 하라고 알려 줘요. 사용자에게 "${card.name}에 다시 로그인하고 이어서 할게요"처럼 한 문장으로 말하고 답을 끝내요.`,
          )
        }
        // 방금(10분 안) 연결된 서비스면 카드를 또 띄우지 않는다 (실측: 연결이 막 끝났는데 이어받은 AI가 카드를 다시 띄웠다)
        const at = items.find((x) => x.card.id === card.id)?.connectedAt
        if (at && Date.now() - Date.parse(at) < 10 * 60_000)
          return text(
            `${card.name}은 방금 연결됐어요. 연결 카드는 띄우지 않았어요. 하던 일을 이어서 해요(페이지를 새로 열거나 다시 읽으면 로그인된 화면이 보여요).`,
          )
        // 연결돼 있다고 기억하는데 다시 로그인할 방법이 없으면: 연결 표시를 풀어 폰에 진짜 연결 카드가 뜨게 한다
        // (안 풀면 폰은 '연결돼 있어요' 한 줄만 보여 카드가 안 뜬 것처럼 보였다)
        if (at && !creds && !provider) {
          journal.write('connect-ask', { id: card.id, expired: true })
          connectMark(card.id, false)
        }
        connectAsked.set(card.id, Date.now())
        void link
          .notify({
            title: `${card.name} 연결`,
            body: '아이디·비밀번호를 넣으면 두리가 로그인해요',
            tag: `connect-ask-${card.id}`,
            url: '#tab=chat',
          })
          .catch(() => {})
        return text(
          card.how === 'browser'
            ? `대화에 ${card.name} 연결 카드를 띄웠어요. 사용자가 카드에 아이디·비밀번호를 넣으면 두리 본체가 로그인하고, 결과는 대화 알림으로 와요. 비밀번호를 묻지 말고 한 문장으로 안내한 뒤 기다려요.`
            : `대화에 ${card.name} 연결 카드를 띄웠어요. 카드를 누르면 연결 화면이 열려요. 한 문장으로 안내한 뒤 기다려요.`,
        )
      }
      // 내 정보 보기: 가린 값만(이름 홍*동, 생년월일 1990-**-**). AI가 대상 조건을 묻기 전에 본다
      if (req.method === 'POST' && b === 'life' && c === 'profile_view' && !d) {
        const { have, missing } = await profile.masked()
        const lines = Object.entries(have).map(
          ([k, v]) => `- ${PROFILE_FIELDS[k as keyof typeof PROFILE_FIELDS].label}: ${v}`,
        )
        const text = [
          lines.length ? `내 정보 (가린 값):\n${lines.join('\n')}` : '내 정보가 아직 비어 있어요.',
          missing.length
            ? `없는 항목: ${missing.map((k) => PROFILE_FIELDS[k].label).join('·')} — 꼭 필요하면 browser_request_profile로 받아요(대화로 묻지 않아요).`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
        return json(res, 200, { content: [{ type: 'text', text }] })
      }
      // 내 결제 수단 보기 (ADR 0023): 카드사·별칭·끝 4자리 같은 가린 값만. 바꾸기는 폰 설정에서 사람이
      if (req.method === 'POST' && b === 'life' && c === 'pay_method_list' && !d) {
        return json(res, 200, { content: [{ type: 'text', text: payMethodsText(loadPayMethods(store)) }] })
      }
      // 금고 보기 (ADR 0011): 어느 사이트 로그인이 있는지만. 비밀번호는 빼고(vault.list) 아이디는 가린다
      if (req.method === 'POST' && b === 'life' && c === 'vault_find' && !d) {
        const args = ((await readJson(req)) ?? {}) as { site?: unknown }
        const via = connectVia()
        const cards = (await skills.connections().catch(() => []))
          .filter((x) => x.card.how !== 'device')
          .map((x) => {
            const v = via[x.card.id]
            const social = v?.startsWith('social:')
              ? SOCIAL_PROVIDERS[v.slice(7) as SocialProvider]?.label
              : undefined
            return {
              id: x.card.id,
              name: x.card.name,
              ...(x.card.site ? { site: x.card.site } : {}),
              ...(x.connectedAt ? { connected: true } : {}),
              ...(social ? { social } : {}),
            }
          })
        const text = vaultSitesText(await vault.list(), {
          query: String(args.site ?? '').slice(0, 100),
          cards,
        })
        return json(res, 200, { content: [{ type: 'text', text }] })
      }
      // 지난 대화 찾기: 요약에서 빠진 앞 구간의 말을 AI가 다시 찾아본다 (ADR 0015)
      if (req.method === 'POST' && b === 'life' && c === 'conversation_search' && !d) {
        const args = (await readJson(req)) as { query?: unknown; limit?: unknown }
        const text = conversation.search(
          String(args.query ?? '').slice(0, 100),
          typeof args.limit === 'number' ? args.limit : 10,
        )
        return json(res, 200, { content: [{ type: 'text', text }] })
      }
      if (req.method === 'POST' && b === 'life' && c === 'photo_view' && !d) {
        const args = (await readJson(req)) as { name?: unknown }
        try {
          const data = await life.photo?.(String(args.name ?? ''))
          if (!data) throw new Error('사진을 찾지 못했어요')
          return json(res, 200, {
            content: [
              { type: 'image', data, mimeType: 'image/jpeg' },
              { type: 'text', text: '사용자가 폰에서 보낸 사진이에요. 보이는 내용을 바탕으로 답해요.' },
            ],
          })
        } catch (e) {
          return json(res, 200, { isError: true, content: [{ type: 'text', text: (e as Error).message }] })
        }
      }
      if (req.method === 'POST' && b === 'life' && c && !d) {
        const args = (await readJson(req)) as Record<string, unknown>
        return json(res, 200, life.run(c, args && typeof args === 'object' ? args : {}))
      }
      // 서비스 도구: catalog(바로 보일 도구), find(서비스 찾기), call(실행)
      if (req.method === 'POST' && b === 'service' && c && !d) {
        const args = ((await readJson(req)) ?? {}) as Record<string, unknown>
        if (c === 'catalog') return json(res, 200, { tools: await connectors.catalog() })
        if (c === 'find') return json(res, 200, await connectors.find(String(args.query ?? '').slice(0, 100)))
        if (c === 'orders_all') return json(res, 200, await connectors.ordersAll())
        // 시험용 PC만: 아직 설치하지 않은 도구 정의를 사용자 Chrome에서 한 번 돌린다 (pnpm connector try --pc)
        if (c === 'try') {
          if (!devReset) return json(res, 403, { error: '시험용 PC에서만 돼요' })
          const input =
            args.input && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : {}
          return json(
            res,
            200,
            await connectors.tryDraft(args.connector, String(args.tool ?? ''), input, {
              close: args.close === true,
            }),
          )
        }
        if (c === 'call') {
          const input =
            args.input && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : {}
          return json(res, 200, await connectors.call(String(args.tool ?? ''), input))
        }
        return json(res, 404, { error: '없는 주소예요' })
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
      const list = await detectAll()
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
    // 확장을 새 코드로 다시 켜기 (확장을 다시 빌드한 뒤. 다시 연결되면 새 코드가 돈다)
    if (a === 'browser' && b === 'extension' && c === 'reload' && req.method === 'POST') {
      const ok = await browser.call('reload', {}, 5_000).then(
        () => true,
        () => false,
      )
      return json(res, 200, { ok })
    }
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
        const { decision, choice } = ApprovalDecisionSchema.parse(await readJson(req))
        if (decision === 'reject')
          return json(res, 200, { ok: browserTools.approvals.reject(b), message: '거절했어요' })
        return json(res, 200, await approveAny(b, choice))
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

    // 일한 기록 (journal.ts): 최근 며칠의 연결·도구·답 기록과 멈춘 화면 그림. 이 PC에서만 읽는다
    if (a === 'logs') {
      if (!b && req.method === 'GET') {
        const kind = url.searchParams.get('kind') ?? undefined
        return json(res, 200, {
          keepDays: KEEP_DAYS,
          shotDays: SHOT_DAYS,
          entries: journal.read({
            days: Number(url.searchParams.get('days')) || 2,
            limit: Math.min(Number(url.searchParams.get('limit')) || 500, 5_000),
            ...(kind ? { kind } : {}),
          }),
        })
      }
      if (b === 'shots' && c && !d && req.method === 'GET' && /^[\w-]+\.jpg$/.test(c) && journal.shotsDir) {
        const file = join(journal.shotsDir, c)
        if (!existsSync(file)) return json(res, 404, { error: '그런 그림이 없어요' })
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
        return void res.end(readFileSync(file))
      }
    }

    // 서비스 연결 (ADR 0014): 카드 목록, 로그인하러 Chrome에서 열기, 연결 표시
    if (a === 'connections') {
      if (!b && req.method === 'GET') return json(res, 200, { services: await skills.connections() })
      // 연결 유지를 지금 한 번 (시험·사용자가 '연결 다시 확인'을 눌렀을 때)
      if (b === 'keep' && !c && req.method === 'POST') return json(res, 200, await keepConnections(true))
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
      // 점검: 로그인 칸을 찾기만 한다 (넣거나 누르지 않는다)
      if (card && c === 'probe' && !d && req.method === 'POST') {
        const body = (await readJson(req).catch(() => ({}))) as { url?: unknown }
        const url =
          typeof body.url === 'string' && body.url.startsWith('https://')
            ? body.url
            : (card.loginUrl ?? connectUrl(card))
        if (!url) return json(res, 400, { error: '사이트 주소가 없어요' })
        const r = await probeLogin(browser, { card, url })
        for (const t of r.tabs ?? [r.tabId]) await browser.call('close', { tabId: t }).catch(() => undefined)
        return json(res, 200, r)
      }
      // 간편 로그인으로 연결하기 (카카오·네이버…)
      if (card && c === 'social' && !d && req.method === 'POST') {
        const body = (await readJson(req)) as {
          provider?: unknown
          background?: unknown
          join?: unknown
          quiet?: unknown
        }
        const provider = SocialProviderSchema.safeParse(body.provider)
        if (!provider.success) return json(res, 400, { error: '간편 로그인 종류를 골라 주세요' })
        if (body.quiet === true && !connecting.has(card.id)) quietConnect.add(card.id)
        const p = startConnect(
          card,
          () => connectSocial(card, provider.data, body.join === false),
          `social:${provider.data}`,
        )
        if (body.background === true)
          return json(res, 200, {
            ok: false,
            started: true,
            message: `두리가 ${card.name}에 간편 로그인하고 있어요. 끝나면 대화로 알려 드릴게요.`,
          })
        return json(res, 200, await p)
      }
      // 연결하기: 아이디·비밀번호 → 금고 → 두리 본체가 대신 로그인
      if (card && c === 'login' && !d && req.method === 'POST') {
        const body = (await readJson(req)) as { username?: unknown; password?: unknown; background?: unknown }
        try {
          const username = String(body.username ?? '')
          const password = String(body.password ?? '')
          if (!username.trim() || !password) throw new Error('아이디와 비밀번호를 넣어 주세요')
          const p = startConnect(card, () => connectLogin(card, username, password))
          // 뒤에서: 바로 답하고, 결과는 대화 알림으로
          if (body.background === true)
            return json(res, 200, {
              ok: false,
              started: true,
              message: `두리가 ${card.name}에 로그인하고 있어요. 다른 일을 하셔도 돼요. 끝나면 대화로 알려 드릴게요.`,
            })
          return json(res, 200, await p)
        } catch (e) {
          return json(res, 400, { error: (e as Error).message })
        }
      }
      // 금고에 있는 계정으로 다시 로그인하기 (연결 시험·로그인 풀렸을 때). 비밀번호는 요청에 오가지 않는다
      if (card && c === 'relogin' && !d && req.method === 'POST') {
        const url = connectUrl(card)
        if (!url) return json(res, 400, { error: '이 서비스는 폰에서 켜요' })
        const origins = [url, card.loginUrl].filter(Boolean).map((u) => new URL(u as string).origin)
        let saved: { username: string; password: string } | undefined
        for (const o of origins) saved ??= await vault.findForOrigin(o)
        if (!saved) return json(res, 404, { error: `금고에 ${card.name} 계정이 없어요` })
        const creds = saved
        return json(
          res,
          200,
          await startConnect(card, () => connectLogin(card, creds.username, creds.password), 'relogin'),
        )
      }
      // 연결하기는 대화에서 (ADR 0021): 내 말과 연결 카드를 메인 대화에 남긴다. 화면은 대화로 옮겨 간다
      if (card && c === 'chat' && !d && req.method === 'POST') {
        if (card.how === 'open' || card.how === 'device')
          return json(res, 400, { error: '이 서비스는 연결하지 않아도 돼요' })
        connectInChat(card)
        return json(res, 200, { ok: true })
      }
      // 지금 로그인돼 있는지 확인만 (표시는 확인 결과대로: 풀렸으면 연결 표시를 끈다)
      if (card && c === 'check' && !d && req.method === 'POST') {
        if (!browser.status.connected)
          return json(res, 409, { error: 'Chrome의 두리 확장이 연결되지 않았어요' })
        const r = await checkSignedIn(browser, card)
        rememberCheck(card.id, r)
        const was = Boolean(readSettings().connections?.[card.id])
        if (r.state === 'in' && !was) connectMark(card.id, true)
        // 세션만 풀린 것(금고 계정·간편 로그인으로 두리가 다시 로그인할 수 있음)은 연결이 끊긴 게 아니다
        const via = connectVia()[card.id]
        const canRelogin = via?.startsWith('social:') || Boolean(await vaultCreds(card))
        if (r.state === 'out' && was && !canRelogin) connectMark(card.id, false)
        return json(res, 200, { ...r, connectedAt: readSettings().connections?.[card.id] ?? null })
      }
      // 정말 로그인됐는지 확인하고 표시하기 ([로그인했어요]와 같은 길). 결과: 표시된 시각 또는 null
      if (card && c === 'verify' && !d && req.method === 'POST') {
        const ok = await connectVerify(card)
        return json(res, 200, { ok, connectedAt: readSettings().connections?.[card.id] ?? null })
      }
      if (card && !c && (req.method === 'PUT' || req.method === 'DELETE'))
        return json(res, 200, { connectedAt: connectMark(card.id, req.method === 'PUT') ?? null })
    }

    // 목표·보관함·기억·피드 (PC 화면)
    if (a === 'thumb' && !b && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://x').searchParams.get('url') ?? ''
      const data = await thumbOrPhoto(url.slice(0, 800))
      return json(res, 200, data ? { data } : {})
    }
    if (a === 'life' && !b && req.method === 'GET') return json(res, 200, life.state())
    // 긴 목록 나눠 받기: 피드(kinds=done,routine이면 활동), 보관함(tab=made|files). before는 앞 페이지의 next
    if (a === 'life' && b === 'feed' && !c && req.method === 'GET')
      return json(res, 200, life.feedPage(pageQuery(url)))
    if (a === 'life' && b === 'library' && !c && req.method === 'GET')
      return json(res, 200, life.libraryPage(pageQuery(url)))
    if (a === 'life' && b === 'library' && c && !d && req.method === 'GET') {
      const item = life.libraryItem(c)
      return item ? json(res, 200, { item }) : json(res, 404, { error: '보관함에 없어요' })
    }
    if (a === 'life' && b === 'action' && req.method === 'POST') {
      const action = (await readJson(req)) as LifeAction
      const id = life.act(action)
      if (action.action === 'identity')
        conversation.rotateSoon(
          '사용자가 두리의 말투·호칭 설정을 바꿨어요. 위 대화의 말투·호칭은 따르지 말고 지침 맨 앞 설정(없으면 기본 해요체)을 따라요.',
        )
      return json(res, 200, { ok: true, ...(id ? { id } : {}), state: life.state() })
    }

    // 두리 금고: 화면용 토큰으로만. AI에게는 비밀번호가 나가지 않고, 사용자가 화면에서만 보고 고친다 (ADR 0011·0026)
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
      // PC 화면에서 보기·고치기 (화면용 토큰으로만, ADR 0026)
      if (b && c === 'reveal' && req.method === 'POST') {
        const r = await vault.reveal(b)
        if (!r) return json(res, 404, { error: '그 항목이 없어요' })
        journal.write('vault-reveal', { origin: r.origin, from: 'pc' })
        return json(res, 200, r)
      }
      if (b && !c && req.method === 'PUT') {
        const body = (await readJson(req)) as { username?: unknown; password?: unknown }
        const r = await vault.update(b, {
          ...(typeof body?.username === 'string' ? { username: body.username } : {}),
          ...(typeof body?.password === 'string' ? { password: body.password } : {}),
        })
        if (!r) return json(res, 404, { error: '그 항목이 없어요' })
        journal.write('vault-update', { origin: r.origin, from: 'pc' })
        return json(res, 200, { entry: r })
      }
    }

    // 내 정보 (예약자·주문자 칸): 화면은 가린 값만 받는다. 고칠 땐 넣은 칸만 바뀐다 (빈 값 = 지우기)
    const payChoices = () => (store.getSetting('payChoices') as Record<string, string> | undefined) ?? {}
    // 사이트별로 기억한 결제 수단 잊기 (PC 설정 화면)
    if (a === 'profile' && b === 'pay' && c && req.method === 'DELETE') {
      const now = { ...payChoices() }
      delete now[c]
      store.setSetting('payChoices', now)
      forgetPaySubs(c)
      browserTools.forgetChoice(c)
      return json(res, 200, { ok: true, payChoices: now })
    }
    if (a === 'profile' && !b) {
      if (req.method === 'GET')
        return json(res, 200, { ...(await profile.masked()), payChoices: payChoices() })
      if (req.method === 'PUT') {
        const body = (await readJson(req)) as Record<string, unknown>
        const r = await profile.update(body && typeof body === 'object' ? body : {})
        journal.write('profile', r)
        return json(res, 200, { ...r, ...(await profile.masked()) })
      }
      if (req.method === 'DELETE') {
        await profile.clear()
        return json(res, 200, { ok: true })
      }
    }
    // 정보 요청(인증번호·내 정보 카드)에 PC 화면에서 답하기 (폰은 연결로 답한다)
    if (a === 'info' && !b && req.method === 'GET')
      return json(res, 200, { requests: infoRequests.pending() })
    if (a === 'info' && b && !c && req.method === 'POST') {
      const body = (await readJson(req)) as { value?: unknown }
      return json(res, 200, {
        ok: infoRequests.answer(b, typeof body?.value === 'string' ? body.value : undefined),
      })
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
      const body = SendMessageRequestSchema.parse(await readJson(req, MESSAGE_MAX))
      const text = body.image ? `${body.text}\n\n${await savePhoto(body.image)}` : body.text
      return json(res, 202, await talk(text))
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
        if (body.agent && !runtimes[body.agent]) return json(res, 400, { error: '지원하지 않는 AI예요' })
        if (body.side) {
          try {
            return json(res, 201, { thread: await openSide(body.agent) })
          } catch (e) {
            return json(res, 409, { error: (e as Error).message })
          }
        }
        const agent = body.agent ?? (await pickAgent(undefined))
        return json(res, 201, { thread: store.createThread(agent, '새 대화') })
      }
    }

    if (a === 'threads' && b) {
      const thread = store.getThread(b)
      if (!thread) return json(res, 404, { error: '대화를 찾을 수 없어요' })
      if (req.method === 'GET' && !c) return json(res, 200, { thread, messages: store.listMessages(b) })
      // 따로 하는 대화만 지울 수 있다 (메인 대화의 구간은 지우지 않는다)
      if (req.method === 'DELETE' && !c) {
        if (!thread.side) return json(res, 400, { error: '메인 대화는 지울 수 없어요' })
        if (threads.isRunning(b)) return json(res, 409, { error: '이 대화는 아직 답하는 중이에요' })
        store.deleteThread(b)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && c === 'cancel') {
        threads.cancel(b)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && c === 'messages') {
        const body = SendMessageRequestSchema.parse(await readJson(req, MESSAGE_MAX))
        if (threads.isRunning(b)) return json(res, 409, { error: '이 대화는 아직 답하는 중이에요' })
        // 사진: 대화·폰과 같이 두리 작업 폴더에 두고 photo_view로 보게 한다 (전에는 따로 하는 대화에서 사진이 빠졌다)
        const text = body.image ? `${body.text}\n\n${await savePhoto(body.image)}` : body.text
        return stream(res, tracked(b, threads.send(b, text)), () => threads.cancel(b))
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
        journal.stop()
        clearInterval(lifeTimer)
        clearInterval(keepTimer)
        clearTimeout(lifePush)
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

const FEED_KIND_NAMES = new Set(['done', 'routine', 'saved', 'goal', 'connected', 'suggest', 'post'])

/** 나눠 받기 주소의 칸: ?before=<커서>&limit=30&kinds=done,routine&tab=made */
function pageQuery(url: URL): {
  before?: string
  limit?: number
  kinds?: FeedItem['kind'][]
  tab?: 'made' | 'files'
} {
  const before = url.searchParams.get('before')?.slice(0, 120)
  const limit = Number(url.searchParams.get('limit'))
  const kinds = (url.searchParams.get('kinds') ?? '')
    .split(',')
    .filter((k): k is FeedItem['kind'] => FEED_KIND_NAMES.has(k))
  const tab = url.searchParams.get('tab')
  return {
    ...(before ? { before } : {}),
    ...(limit > 0 ? { limit } : {}),
    ...(kinds.length ? { kinds } : {}),
    ...(tab === 'files' || tab === 'made' ? { tab } : {}),
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 메시지(사진 포함)는 사진 크기까지 받는다: SendMessageRequestSchema의 image는 2,000,000자까지 */
const MESSAGE_MAX = 2_100_000

async function readJson(req: IncomingMessage, max = 100_000): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > max) throw new Error('요청이 너무 커요')
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
