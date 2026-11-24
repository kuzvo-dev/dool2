// dool2d — the Doori core. The PC app window (Electron) starts it, and on a Doori box it runs on its own.
// M0: takes chats through a local API (127.0.0.1 + token), runs Claude Code and Codex, and keeps a record.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
import { deviceRegion } from '@dool2/i18n'
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
  FILE_CHUNK,
  FILE_MAX,
  FocusTabSchema,
  type LifeAction,
  LoginSubmitSchema,
  type MadeImageRecordMessage,
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
import { APP_NOTE, appNote, PHOTO_MARK, readAppNote, withoutPhotoMark } from '@dool2/protocol/rich'
import { Store } from '@dool2/store'
import type { Approvals } from './approvals.js'
import { AutoApprover, autoCovers } from './auto-approve.js'
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
import { askedForAccount, BrowserTools, type ToolResult } from './browser-tools.js'
import { LoginWatch, strongSignedIn } from './connect-watch.js'
import { ConnectorHealth } from './connector-health.js'
import { Connectors } from './connectors.js'
import { EXEC_EXT } from './download.js'
import { DOORI_FOLDER, ensureLocal, FileTools, htmlText, type UserFolders } from './files.js'
import { FinishCheck } from './finish-check.js'
import { type HandsCaller, HandsProcess } from './hands.js'
import { ImageMaker } from './image-make.js'
import { InfoRequests } from './info-requests.js'
import { Journal, KEEP_DAYS, noteResultChars, SHOT_DAYS, scrubText, scrubUrl } from './journal.js'
import { userLang } from './lang.js'
import { Life, routineAsk, tellDelay, watchPrompt } from './life.js'
import { PhoneLink } from './link.js'
import { forAI, indexText } from './locales/index-text.js'
import { LoopGuard } from './loop-guard.js'
import { MotionMaker, type MotionRenderer } from './motion.js'
import { dataPaths, defaultDataDir } from './paths.js'
import { loadPayMethods, payMethodsText, savePayMethods } from './pay-methods.js'
import { isSmsApproval, PhoneSms } from './phone-sms.js'
import { PROFILE_FIELDS, ProfileStore } from './profile.js'
import {
  APP_CONFIRM_ONLY_END,
  APP_CONFIRM_ONLY_END_LOOSE,
  joinKoreanSentences,
  SNAPSHOT_FIELD,
  SNAPSHOT_VALUE,
  SNAPSHOT_VALUE_MASKED,
} from './region/kr/index-matchers.js'
import type { HtmlRenderer } from './render.js'
import { buildReport, sendReport } from './report.js'
import { RouteBook } from './routes.js'
import { runQuickCheck } from './routine-check.js'
import { ScreenTools } from './screen-tools.js'
import { checkSignedIn, type SigninCheck } from './signin-check.js'
import { Skills } from './skills.js'
import { localDay, StatsReporter } from './stats.js'
import { Thumbs } from './thumbs.js'
import { type TapeEntry, ToolTape } from './tool-tape.js'
import { mimeOf } from './upload.js'
import { Vault, vaultSitesText } from './vault.js'
import { VideoClipMaker } from './video-clip.js'
import { findFfmpeg, runFfmpeg, VideoMaker } from './video-make.js'
import type { sendPush } from './webpush.js'

/** Told to the AI when the user changes how Doori speaks */
const IDENTITY_CHANGED_NOTE =
  'The user changed how Doori talks and addresses them. Do not follow the tone or form of address used earlier in this chat: follow the settings at the very top of the instructions (the default polite style if none).'

export { APPROVAL_TTL_MS, Approvals } from './approvals.js'
export { BROWSER_TOOLS, BrowserTools, classifyRisk, type ToolResult } from './browser-tools.js'
export { ConnectorHealth } from './connector-health.js'
export { Connectors, coerce, render, type ServiceToolSpec } from './connectors.js'
export { FileTools } from './files.js'
export { PAIR_TTL_MS, PhoneLink } from './link.js'
export type { MotionRenderer, MotionRenderRequest, MotionRenderResult } from './motion.js'
export { dataPaths, defaultDataDir } from './paths.js'
export type { HtmlRenderer, HtmlRenderRequest, HtmlRenderResult } from './render.js'
export { RouteBook } from './routes.js'
export { Skills } from './skills.js'
export { Vault, vaultOrigin } from './vault.js'

/** PC settings wiped by "start over": what Doori has built up about the user (memories, goals, library, proactive checks, ideas, my info) */
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
  /** Draws HTML and returns a JPEG (base64) (the PC app provides it), so pictures and invitations Doori made show in the library and on the phone */
  renderHtml?: (html: string) => Promise<string | undefined>
  /** Shrinks a picture file to a JPEG (base64) of the given width (the PC app provides it): previews of pictures made by the image AI */
  shrinkImage?: (data: Buffer, width: number) => Promise<string | undefined>
  /**
   * Draws an HTML file as a PDF (A4, several pages) or PNG (the PC app provides it with a hidden window, file_render).
   * Without it (the daemon running without the app) file_render reports that it cannot
   */
  renderFile?: HtmlRenderer
  /** Captures animated HTML scene by scene for video (the PC app provides it, video_motion) */
  renderMotion?: MotionRenderer
  /**
   * Opens a PC file with the default app (open) or shows it in Finder/Explorer (reveal). The PC app provides it.
   * Used by file links in answers and the library [Open]. When it cannot open, it returns the reason
   */
  openFile?: (path: string, how: 'open' | 'reveal') => Promise<string | undefined>
  dataDir?: string
  /** When false, no work log (logs folder) is kept (default: kept for a few days, journal.ts) */
  journal?: false
  /** 0 picks a free port */
  port?: number
  token?: string
  /** Packaged app: the bundled Doori tool server script (otherwise @dool2/mcp-tools/server) */
  mcpServerScript?: string
  /** For tests: fixes the token of the tool address (/api/tools) (otherwise a new one is made on every start) */
  toolToken?: string
  /** For tests: the folders the PC file tools work in (default: the user's Desktop, Documents and Downloads) */
  fileFolders?: UserFolders
  /** Points directly at the Codex executable (default: the one downloaded on first use) */
  codexBin?: string
  /** Store for secrets such as API keys (default: memory) */
  secrets?: SecretStore
  /** For tests: swaps out the Chrome check and install */
  chrome?: { detect(): Promise<ChromeStatus>; createInstall?(downloadDir: string): ChromeInstall }
  /**
   * Registers the native messaging host with Chrome (how the Doori extension reaches the daemon, ADR 0006).
   * Without it nothing is registered. Check mode and tests leave it empty so the user's Chrome is untouched.
   */
  nativeHost?: { script?: string; extraDirs?: string[]; defaultTargets?: boolean }
  /** Skills folder (default: skills/ in the repo, inside the app for a packaged app) */
  skillsDir?: string
  /** The current-time line sent along with each message (on by default, turned off in tests: () => undefined) */
  timeLine?: () => string | undefined
  /** PC screen control helper executable (default: apps/hands-mac/dist/dool2-hands in the repo). Tests pass a fake */
  hands?: string | HandsCaller
  /**
   * The app's own Mac permissions (filled in by Electron). The app has to ask, or the prompt shows up under the name "Doori".
   * The helper is started by the app, so it uses the same permissions
   */
  appPermissions?: {
    status(): { accessibility: boolean; screenRecording: boolean }
    request(): Promise<void>
  }
  /**
   * Test PC: turns on "start over" in the phone settings (clears chats, memories, goals and library, like a new user).
   * Off in the packaged app. It can also be turned on with the environment variable DOOL2_DEV_RESET=1
   */
  devReset?: boolean
  /** Default address of the phone relay server (when settings have no relay). Without it the phone link stays off */
  relay?: string
  /** Phone app address (e.g. https://dool2.com/space/). Without it, the relay server's /app/ */
  appUrl?: string
  /** The name of this PC shown on the phone */
  pcName?: string
  /** PC app version (sent along with problem reports) */
  appVersion?: string
  /** For tests: sends web push */
  push?: typeof sendPush
  /** For tests: swaps out the agents */
  runtimes?: Partial<Record<AgentId, AgentRuntime>>
  /** The judge AI for the before-finishing check (ADR 0027). Off by default since 2026-11-24; only tests pass one */
  finishJudge?: ((prompt: string, signal: AbortSignal) => Promise<string | undefined>) | false
}

/** Store for secrets. The PC app encrypts them with the OS keychain (safeStorage) */
export interface SecretStore {
  get(key: string): Promise<string | undefined>
  /** undefined deletes it */
  set(key: string, value: string | undefined): Promise<void>
}

/** For development: kept in memory only (gone after a restart) */
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
  /** Settings changed (the PC app re-applies power and auto-start) */
  settings: [Settings]
  /** Doori started working (true) or finished everything (false) */
  busy: [boolean]
  /** The Doori extension in Chrome attached or detached */
  extension: [ExtensionStatus]
}

export interface Daemon {
  url: string
  port: number
  token: string
  events: EventEmitter<DaemonEvents>
  /** Whether anything is in progress right now */
  readonly busy: boolean
  /** Saved settings (filled in with defaults) */
  settings(): Settings
  /** The bridge to the Doori extension in Chrome */
  browser: BrowserBridge
  /** Approval gate (also used by the check screen) */
  approvals: Approvals
  close(): Promise<void>
}

/** How to start the Doori MCP tool server. Inside Electron, Electron runs as Node. */
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

/** How to start the native messaging host. Inside Electron, Electron runs as Node */
export function dool2BrowserHost(scriptPath?: string): HostRuntime {
  const script = scriptPath ?? createRequire(import.meta.url).resolve('@dool2/browser/host')
  const inElectron = Boolean(process.versions.electron)
  return {
    command: process.execPath,
    args: [script],
    ...(inElectron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
  }
}

/** During development, skills/ in the repo (apps/daemon/dist → ../../../skills) */
/** During development, the helper lives at apps/hands-mac/dist/dool2-hands in the repo (a packaged app passes the hands option) */
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
  /** Pay-as-you-go account: provider and model come from settings, the key from the secret store. Merged only when running */
  const paygAccount = async () => {
    const payg = savedPayg()
    const apiKey = await secrets.get(PAYG_KEY)
    return payg && apiKey ? { ...payg, apiKey } : undefined
  }
  // Language for text people read (ADR 0029). Korean until the app follows the device language
  const lang = () => userLang(readSettings())
  const runtimes: Partial<Record<AgentId, AgentRuntime>> = opts.runtimes ?? {
    claude: new ClaudeRuntime({ lang }),
    codex: new CodexRuntime({
      lang,
      codexHome: paths.codexHome,
      installDir: paths.codex,
      ...(opts.codexBin ? { binPath: opts.codexBin } : {}),
    }),
    opencode: new OpenCodeRuntime({ dir: paths.opencode, account: paygAccount, lang }),
  }
  // Before-finishing check (ADR 0027): turned off 2026-11-24. Sending finished answers back made them vanish and
  // start over, and testers read it as Dool2 thinking forever. Kept only for tests that pass their own judge
  const judgeAsk = opts.finishJudge || undefined
  const finishCheck = judgeAsk ? new FinishCheck({ ask: judgeAsk }) : undefined
  // The Doori tool server (MCP) is a child the agent starts, so it gets a different token from the screen's. This token can only call the tool address (T5)
  /** Text for people in the language they chose (ADR 0029) */
  const m = () => indexText(userLang(readSettings()))
  const toolToken = opts.toolToken ?? randomBytes(32).toString('hex')
  /** Notices the same tool call with the same result again and again, and adds "take another route" to it */
  const loopGuard = new LoopGuard()
  /** Scenario tests on a test PC: records tool answers, or plays them back instead of running tools (evals layer 2) */
  const toolTape = new ToolTape()
  const mcp = dool2McpServer(opts.mcpServerScript)
  /** Goals, library, memories and feed */
  const life = new Life(store)
  life.lang = () => userLang(readSettings())
  life.tidyLibrary()
  // Photos sent from the phone: kept in photos/ in the work folder, with only a marker added to the message (Doori views them with photo_view)
  const photoDir = join(paths.workspace, 'photos')
  async function savePhoto(b64: string): Promise<string> {
    const buf = Buffer.from(b64, 'base64')
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error(m().photoBadFormat)
    await mkdir(photoDir, { recursive: true })
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`
    await writeFile(join(photoDir, name), buf)
    return `${PHOTO_MARK}${name}]`
  }
  life.photo = async (name) => {
    if (!/^[\w-]+\.jpg$/.test(name)) throw new Error(m().photoBadName)
    return (await readFile(join(photoDir, name))).toString('base64')
  }
  const threads = new ThreadService({
    lang,
    store,
    runtimes,
    workspaceDir: paths.workspace,
    mcpServers: [mcp],
    // Work log: which site a web tool worked on, from just a tab number
    tabHost: (tabId) => browserTools.tabHost(tabId),
    // Title of a service tool in the work steps ("finding shops · checking opening hours")
    toolTitle: (name) => connectors.titleOf(name),
    takeMadeImage: () => {
      const m = madeImage
      madeImage = undefined
      return m
    },
    ...(opts.timeLine ? { timeLine: opts.timeLine } : {}),
    // Cache share of each turn's first AI call (ADR 0032: pinned instructions should keep it high)
    onCache: (threadId, x) =>
      journal.write('cache', {
        threadId,
        input: x.input,
        cached: x.cached,
        share: x.input ? Math.round((x.cached / x.input) * 100) : 0,
        ...(x.noted ? { noted: true } : {}),
        // Time since the segment's previous turn: how long the provider's cache lives decides when to switch segments
        ...(x.gapMs !== undefined ? { gapMs: x.gapMs } : {}),
      }),
    // Memories are attached to the end of the instructions for each chat
    // Service map: lets requests without a service name still pick a fitting service (connected ones first)
    systemPrompt: () =>
      [
        buildSystemPrompt({ ...life.identity(), lang: lang() }),
        skills.serviceMap(),
        life.memoryPrompt(),
        life.knowPrompt(),
      ]
        .filter(Boolean)
        .join('\n\n'),
  })
  /** One conversation (ADR 0015): picking and switching segments */
  const conversation = new ConversationService({ store, threads })
  /** Streams what happens in the conversation to the PC screen (GET /api/conversation/live) */
  const live = new EventEmitter<{ event: [ConversationLiveEvent] }>()
  // Also tells the phone the conversation state (answering, queued messages). Only when it changes
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

  // Browser bridge: extension → native messaging host → this socket
  const browser = new BrowserBridge(paths.dataDir)
  await browser.listen()
  browser.on('status', (s) => events.emit('extension', s))
  // Work log: keeps for a few days on this PC how each connection, tool and answer turn went (read when looking for problems, journal.ts)
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
  vault.userLang = lang
  const browserTools = new BrowserTools(browser, vault, () => readSettings().finalStep ?? 'approve')
  browserTools.userLang = lang
  // Remembered routes (ADR 0034): clicks that led somewhere on a site, walked again without the AI in between
  browserTools.routes = new RouteBook(join(paths.dataDir, 'routes.json'))
  // My info (booker and orderer fields): in the same store as the vault, and the AI only sees masked values (browser_fill_profile)
  const profile = new ProfileStore(secrets)
  browserTools.profile = profile
  browserTools.onNote = (kind, data) => journal.write(kind, data)
  browserTools.onShot = (label, data) => void journal.shot(label, data)
  // PC file tools (ADR 0022·0024). Tests can change the folders. Moving (several files) and printing use the same approval card
  const fileTools = new FileTools(opts.fileFolders, undefined, {
    lang,
    approvals: browserTools.approvals,
    movesLog: join(paths.dataDir, 'file-moves.json'),
    // Looks at what Doori was doing before sleep (answering chats, service connections). It is built below, so it is read when called
    busy: () => ({ turns: activeThreads.size, connecting: [...connecting.keys()] }),
    ...(opts.renderFile ? { renderFile: opts.renderFile } : {}),
  })
  // Uploading PC files to a website (browser_upload) also stays inside the same folder fence as the file tools (plus photos received in chat)
  fileTools.sentPhotos = photoDir
  browserTools.uploadFiles = (p) => fileTools.uploadable(p)
  /** The picture just made by the image AI (when the chat receives an image_make result, it is taken out once and attached under the answer) */
  let madeImage: MadeImageRecordMessage | undefined
  // Motion graphics video (video_motion): the PC app captures the scenes and the video component stitches them
  fileTools.motionMaker = new MotionMaker({
    binDir: join(paths.dataDir, 'bin'),
    ...(opts.renderMotion ? { render: opts.renderMotion } : {}),
    readable: (p) => fileTools.readable(p),
    local: (p) => ensureLocal(p),
    resolveAll: async (list) => {
      const r = await fileTools.uploadable(list)
      return 'error' in r ? r : r.files.map((f) => f.path)
    },
    saveDir: () => {
      const docs = fileTools.dir('documents')
      return docs ? join(docs, DOORI_FOLDER) : undefined
    },
    show: (p) => fileTools.shown(p),
    onMade: (f) => fileTools.onWritten?.(f),
    ...(opts.shrinkImage
      ? { preview: (jpeg: Buffer) => (opts.shrinkImage as NonNullable<typeof opts.shrinkImage>)(jpeg, 720) }
      : {}),
  })
  // Making a video from photos (video_make): the video component is fetched on first use
  fileTools.videoMaker = new VideoMaker({
    binDir: join(paths.dataDir, 'bin'),
    resolveAll: async (list) => {
      const r = await fileTools.uploadable(list)
      return 'error' in r ? r : r.files.map((f) => f.path)
    },
    saveDir: () => {
      const docs = fileTools.dir('documents')
      return docs ? join(docs, DOORI_FOLDER) : undefined
    },
    show: (p) => fileTools.shown(p),
    onMade: (f) => fileTools.onWritten?.(f),
    ...(opts.shrinkImage
      ? { preview: (jpeg: Buffer) => (opts.shrinkImage as NonNullable<typeof opts.shrinkImage>)(jpeg, 720) }
      : {}),
  })
  // Making pictures with the image AI (image_make): made on Gemini on the web in the user's Chrome, then placed in the Doori folder and library
  fileTools.imageMaker = new ImageMaker({
    browser,
    // Connected image AI first (the Gemini and ChatGPT cards in the AI tools section)
    connected: async () =>
      new Set((await skills.connections()).filter((c) => c.connectedAt).map((c) => c.card.id)),
    // If a picture came out, the user is signed in to that site: mark it connected (Connect screen, used first)
    onWorked: (id) => {
      void skills.connections().then((list) => {
        if (!list.find((c) => c.card.id === id)?.connectedAt) connectMark(id, true)
      })
    },
    downloadsDir: () => fileTools.dir('downloads'),
    saveDir: () => {
      const docs = fileTools.dir('documents')
      return docs ? join(docs, DOORI_FOLDER) : undefined
    },
    show: (p) => fileTools.shown(p),
    onMade: (f) => fileTools.onWritten?.(f),
    // Picture shown in the chat bubble: kept in the same place as sent photos (photos/) and the phone and PC fetch it as "photo:name"
    keepPhoto: async (jpeg, title, path) => {
      await mkdir(photoDir, { recursive: true })
      const name = `made-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`
      await writeFile(join(photoDir, name), Buffer.from(jpeg, 'base64'))
      madeImage = { kind: 'made', title, photo: name, path }
    },
    // Preview: the PC app shrinks it (drawing the original inside HTML hits the data: URL limit for big pictures — measured 11-22)
    ...(opts.shrinkImage
      ? { preview: (png: Buffer) => (opts.shrinkImage as NonNullable<typeof opts.shrinkImage>)(png, 720) }
      : {}),
  })
  // AI video clip (video_clip): a short clip made on Google Flow in the user's Chrome → Doori folder and library (the material for video_motion)
  fileTools.clipMaker = new VideoClipMaker({
    browser,
    onWorked: (id) => {
      void skills.connections().then((list) => {
        if (!list.find((c) => c.card.id === id)?.connectedAt) connectMark(id, true)
      })
    },
    downloadsDir: () => fileTools.dir('downloads'),
    saveDir: () => {
      const docs = fileTools.dir('documents')
      return docs ? join(docs, DOORI_FOLDER) : undefined
    },
    show: (p) => fileTools.shown(p),
    onMade: (f) => fileTools.onWritten?.(f),
    // One frame sheet per second (Doori looks at it to check) and a first-frame preview — only when the video component is present
    frames: async (mp4) => {
      const bin = findFfmpeg(join(paths.dataDir, 'bin'))
      if (!bin) return {}
      const tmp = await mkdtemp(join(tmpdir(), 'dool2-clip-'))
      try {
        await runFfmpeg(
          bin,
          [
            '-y',
            '-loglevel',
            'error',
            '-i',
            mp4,
            '-vf',
            'fps=1,scale=150:-2,tile=8x1',
            '-frames:v',
            '1',
            join(tmp, 's.jpg'),
          ],
          60_000,
        )
        await runFfmpeg(
          bin,
          [
            '-y',
            '-loglevel',
            'error',
            '-ss',
            '1',
            '-i',
            mp4,
            '-vf',
            'scale=480:-2',
            '-frames:v',
            '1',
            '-q:v',
            '5',
            join(tmp, 'p.jpg'),
          ],
          60_000,
        )
        const read = async (f: string) =>
          (await readFile(join(tmp, f)).catch(() => undefined))?.toString('base64')
        return { sheet: await read('s.jpg'), poster: await read('p.jpg') }
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  })
  // Files Doori made also go to the library's "Photos and files" to view on the phone (text and tables as content, HTML as a preview)
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
      // HTML (pictures, invitations): keep the photo the PC app drew along with it, since the phone cannot render HTML
      // A file drawn from HTML as PNG uses the preview made while drawing
      const shot =
        f.image ??
        (f.kind === 'html' && opts.renderHtml
          ? await opts.renderHtml(text).catch(() => undefined)
          : undefined)
      const saved = life.save({
        kind: 'file',
        title: f.name,
        body: `${body}\n\nPC: ${f.path}`.trim(),
        path: f.path,
        ...(shot ? { image: shot } : {}),
      })
      if (shot) await addThumb(saved.id, shot)
    })()
  }
  /** Small preview shown in the library list (the PC app shrinks it) */
  async function addThumb(id: string, image: string) {
    if (!opts.shrinkImage) return
    const t = await opts.shrinkImage(Buffer.from(image, 'base64'), 112).catch(() => undefined)
    if (t && !closing) life.setThumb(id, t)
  }
  // Fill in list previews for files made earlier too (once at startup). Stops when closed (so nothing is written to the store after closing)
  const thumbFill = setTimeout(() => {
    void (async () => {
      for (const it of life.library()) {
        if (closing) return
        if (it.image && !it.thumb) await addThumb(it.id, it.image)
      }
    })()
  }, 5000)
  // The payment method last chosen per site (the default on the next approval card). No secrets such as card numbers, only the method name
  {
    const saved = store.getSetting('payChoices')
    if (saved && typeof saved === 'object') browserTools.loadChoices(saved as Record<string, string>)
    browserTools.payMethods = () => loadPayMethods(store)
    browserTools.onChoice = (host, label) => {
      const now = (store.getSetting('payChoices') as Record<string, string> | undefined) ?? {}
      store.setSetting('payChoices', { ...now, [host]: label.slice(0, 40) })
    }
    // Registered card and installments per site ("host|card" → masked card name)
    const subs = store.getSetting('paySubChoices')
    if (subs && typeof subs === 'object') browserTools.loadSubChoices(subs as Record<string, string>)
    browserTools.onSubChoice = (key, label) => {
      const now = (store.getSetting('paySubChoices') as Record<string, string> | undefined) ?? {}
      store.setSetting('paySubChoices', { ...now, [key]: label.slice(0, 60) })
    }
  }
  /** When settings forget a site's payment memory, forget the card and installment memory too */
  const forgetPaySubs = (host: string) => {
    const now = { ...((store.getSetting('paySubChoices') as Record<string, string> | undefined) ?? {}) }
    for (const k of Object.keys(now)) if (k.startsWith(`${host}|`)) delete now[k]
    store.setSetting('paySubChoices', now)
  }
  /** Tools used in the last days of the work log (open-service tools are listed directly only if used lately) */
  const recentServiceTools: ReadonlySet<string> = new Set(
    journal
      .read({ kind: 'turn', days: KEEP_DAYS })
      .flatMap((e) => (Array.isArray(e.tools) ? (e.tools as string[]) : [])),
  )
  const skillsDir = opts.skillsDir ?? defaultSkillsDir()
  // Service tools (connectors, ADR 0018): run the tools.json next to a connect card with the engine
  const connectors = new Connectors({
    dir: skillsDir,
    browser,
    tools: browserTools,
    connected: () => readSettings().connections ?? {},
    // Read once at start, so the tool list does not change in the middle of a conversation (that would break the cache)
    recentTools: () => recentServiceTools,
    extensionVersion: () => (browser.status.connected ? browser.status.version : undefined),
    health: new ConnectorHealth(join(paths.dataDir, 'connector-health.json')),
    journal,
    // My info address (when the tool's address field is empty or "my address"). It does not go to the AI, only into that site
    homeAddress: async () => (await profile.get()).address?.trim() || undefined,
    // The last thing the user said in the main chat (leaving out app note lines)
    lastUser: () => {
      const cur = conversation.current()
      if (!cur) return undefined
      const m = store
        .listMessages(cur.id)
        .filter((x) => x.role === 'user' && !x.text.startsWith(APP_NOTE))
        .at(-1)
      return m ? { at: Date.parse(m.createdAt), text: m.text } : undefined
    },
    // The account connected for that service (the vault ID): opens places whose address differs per account, like a mailbox, with that account
    accountFor: async (card) => {
      for (const site of [card.site, ...(card.alsoSites ?? [])].filter(Boolean)) {
        const e = await vault.findForOrigin(`https://${String(site).replace(/^https?:\/\//, '')}`)
        // Google needs the full address to open that mailbox (with only an ID saved, /mail/u/ID/ gives a "temporary error")
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
    () => {
      const st = readSettings()
      const locale = [Intl.DateTimeFormat().resolvedOptions().locale]
      const region = st.region ?? deviceRegion(locale)
      return { lang: lang(), ...(region ? { region } : {}) }
    },
  )
  // The service map in the instructions uses the list read last: read it once at the start
  void skills.connections().catch(() => undefined)
  // PC screen control (M4): the helper is started on first use
  const hands: HandsCaller =
    typeof opts.hands === 'object' ? opts.hands : new HandsProcess(opts.hands ?? defaultHandsBin())
  const screenTools = new ScreenTools(hands, browserTools.approvals, {
    lang,
    allowed: () => readSettings().allowedApps ?? [],
    setAllowed: (list) => {
      store.setSetting('allowedApps', list)
      events.emit('settings', readSettings())
    },
    finalStep: () => readSettings().finalStep ?? 'approve',
    vaultList: () => vault.list(),
    vaultReveal: (id) => vault.reveal(id),
  })
  /** What the phone said it can do when it said hello (phone id → caps). Only phones that said hello after startup are known */
  const phoneCaps = new Map<string, string[]>()
  // Sending texts (to my phone number): once approved, the phone app sends it directly
  const phoneSms = new PhoneSms(browserTools.approvals, () => {
    const phones = link.status().phones
    const known = phones.map((p) => phoneCaps.get(p.id)).filter((c): c is string[] => !!c)
    return {
      paired: phones.length,
      sms: known.filter((c) => c.includes('sms')).length,
      old: known.filter((c) => !c.includes('sms')).length,
    }
  })
  /**
   * Approval: an app (app:…) means screen control, a PC file (file:…) the file tools, a text (sms:…) the result the phone sent, otherwise the browser.
   * fromPhone: an approval whose phone signature was verified (texts can only be approved on the phone)
   */
  const approveAny = (id: string, choice?: string, fromPhone = false) => {
    const url = browserTools.approvals.get(id)?.url ?? ''
    if (isSmsApproval(url)) return phoneSms.approve(id, fromPhone)
    if (url.startsWith('app:')) return screenTools.approve(id)
    if (url.startsWith('file:')) return fileTools.ops.approve(id)
    return browserTools.approve(id, choice)
  }
  // Auto-approve (ADR 0030): everything except payments runs without a card when the user turned it on.
  // When it changes on the PC, the phones' switches follow
  let autoOn = readSettings().autoApprove === true
  events.on('settings', (st: Settings) => {
    if ((st.autoApprove === true) === autoOn) return
    autoOn = st.autoApprove === true
    journal.write('auto-approve-set', { on: autoOn })
    // link is created further down; a settings change before that has no phones to tell
    try {
      void link.resync()
    } catch {}
  })
  browserTools.approvals.autoDecide = (n) => autoCovers(readSettings().autoApprove === true, n)
  const autoApprover = new AutoApprover(
    browserTools.approvals,
    (id) => approveAny(id),
    (e) => journal.write('auto-approve', e),
  )

  // Phone link (M6): takes requests from paired phones and handles them on the PC
  const relayUrl = () => process.env.DOOL2_RELAY || readSettings().relay || opts.relay
  /**
   * The AI status check waits at most 10 seconds. On a daemon left on for long, the check never finished and new chats would not open
   * (measured: on the test build, POST /api/threads and /api/agents stopped responding after a few dozen minutes; restarting fixed it).
   * When blocked, it uses the last confirmed status and records in the work log which AI was stuck
   */
  const agentStatus = new Map<string, Awaited<ReturnType<AgentRuntime['detect']>>>()
  // Usage stats (only with consent, numbers only): updates and sends today's numbers every hour (stats.ts)
  const stats = new StatsReporter({
    dir: paths.dataDir,
    enabled: () => readSettings().usageStats === true && opts.journal !== false,
    version: opts.appVersion ?? 'dev',
    entries: () => journal.read({ days: 2, limit: 5_000 }),
    status: async () => ({
      agents: (await detectAll()).filter((a) => a.installed && a.loggedIn).map((a) => a.id),
      extension: Boolean(browser.status.connected),
      connections: (await skills.connections()).filter((c) => c.connectedAt).length,
    }),
  })
  if (opts.appVersion) {
    stats.start()
    // If consent was just given, send once right away without waiting (then every hour)
    let statsOn = readSettings().usageStats === true
    events.on('settings', (st: Settings) => {
      const on = st.usageStats === true
      if (on && !statsOn) void stats.tick().catch(() => undefined)
      statsOn = on
    })
  }
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
            problem: m().statusUnfinished,
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
    throw new Error(m().noAgent)
  }
  // Service connections (ADR 0014): shared by the PC screen (HTTP) and the phone (link)
  // Watches the tab opened for connecting, and when text only a signed-in person sees shows up, marks it connected on its own (no AI)
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
      // If it ends while the daemon is shutting down, the store is closed: then nothing is notified
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
    if (!url) throw new Error(m().phoneOnlyService)
    if (!browser.status.connected)
      throw Object.assign(new Error(m().extNotConnected), { code: 'no-extension' })
    const r = (await browser.call('open', { url }, 40_000)) as { tabId: number }
    // When connecting from the phone, nobody is at the PC, so hand that tab over as a remote screen. On the PC, bring it to the front
    if (forPhone) browserTools.holdForPerson(r.tabId)
    else await browser.call('focus', { tabId: r.tabId }).catch(() => undefined)
    loginWatch.start(card, r.tabId)
    return r.tabId
  }
  /** Connect: put the ID and password in the vault and the daemon signs in on the user's behalf. The AI never sees the values */
  const connectLogin = async (card: ConnectCard, username: string, password: string) => {
    const url = connectUrl(card)
    if (!url) throw new Error(m().phoneOnlyService)
    if (!username.trim() || !password) throw new Error(m().needIdPassword)
    const start = card.loginUrl ?? url
    if (!browser.status.connected) throw new Error(m().extNotConnectedPc)
    await vault.add({ url, username, password })
    const r = await autoLogin(browser, {
      lang: lang(),
      card,
      url: start,
      username,
      password,
      ask: loginAsk(card),
      step: connectStep(card.id),
      onTab: connectTab(card.id),
    })
    // If the sign-in screen is on another address (login.site), save it there too (for the next time Doori signs in again)
    if (r.loginOrigin && r.loginOrigin !== new URL(url).origin)
      await vault.add({ url: r.loginOrigin, username, password }).catch(() => undefined)
    if (r.status === 'ok') rememberVia(card.id, 'vault')
    return connectFinish(card, r)
  }
  /** Connect with quick sign-in: if the provider side is already signed in, only pass the button and consent, otherwise use the vault value or hand it to the person */
  const connectSocial = async (card: ConnectCard, provider: SocialProvider, noJoin = false) => {
    const url = connectUrl(card)
    if (!url) throw new Error(m().phoneOnlyService)
    if (!browser.status.connected) throw new Error(m().extNotConnectedPc)
    // Quick sign-up only when there is no working account on this site yet (otherwise the same site would get two accounts)
    const known = connectVia()[card.id]
    // noJoin: when not signing up, like a batch check (on a sign-up screen it ends with "sign-up needed")
    const join = !noJoin && !(known && known !== `social:${provider}`) && !(await vaultCreds(card))
    const r = await socialLogin(browser, {
      lang: lang(),
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
   * The method used to connect each service (vault: vault account, social:kakao and so on). When a sign-in expires, Doori signs in again the same way.
   * No secrets, only the method name
   */
  /** The last sign-in check per service (shown as "checked N hours ago" on the Connect screen, and used when keep-connected picks where to sign in again) */
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
  /** The connect method last tried per service: so the method is remembered even when auto sign-in could not verify and Doori (the AI) took over and finished */
  const connectTried = new Map<string, string>()
  /** The service's account in the vault (connect address and sign-in address) */
  const vaultCreds = async (card: ConnectCard) => {
    const url = connectUrl(card)
    if (!url) return undefined
    // An account added through Connect is stored under the connect address (coupang.com), one added while working under that screen's address (www.coupang.com)
    const www = card.site && !card.site.startsWith('www.') ? `https://www.${card.site}/` : undefined
    let saved: { username: string; password: string } | undefined
    for (const u of [url, card.loginUrl, www].filter(Boolean) as string[])
      saved ??= await vault.findForOrigin(new URL(u).origin)
    return saved
  }
  /** Auto sign-in result → connected mark / person's turn (remote screen) / guidance */
  const connectFinish = async (card: ConnectCard, r: AutoLoginResult): Promise<ConnectResult> => {
    if (r.status === 'ok') {
      connectMark(card.id, true)
      await browser.call('close', { tabId: r.tabId }).catch(() => undefined)
      return { ok: true, message: m().loggedInReady(card.name) }
    }
    if (r.status === 'human') {
      // A step only a person can do: when they finish it on the phone looking at that screen, mark it connected
      browserTools.holdForPerson(r.tabId)
      loginWatch.start(card, r.tabId)
      return {
        ok: false,
        human: true,
        reason: 'human',
        tabId: r.tabId,
        // If only an app confirmation is left (KakaoTalk and so on), there is no need to open the screen, just tap: the watcher connects afterwards
        message: APP_CONFIRM_ONLY_END.test(r.reason) ? `${r.reason}.` : m().finishByHand(r.reason),
      }
    }
    browserTools.holdForPerson(r.tabId)
    // Even if the ID or password was wrong or the result is unknown, when the user finishes on that screen it is marked connected on its own
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
   * When auto sign-in stops because it cannot recognize the screen: instead of ending with a failure card, Doori (the AI) takes over that tab in the chat.
   * Unlike auto sign-in, which only clicks in a fixed order, it reads the screen and adapts, so it can continue on sign-in screens that differ per site.
   * What it does is shown in the chat as is (work screen and steps). The ID and password go into the fields only from the vault and never reach the AI.
   * Only once per 10 minutes per service (if that still fails, the user does it by looking at the screen)
   */
  const takeoverAt = new Map<string, number>()
  /** Taken-over tab → service (so other addresses on that service's site also use the account entered when connecting) */
  const takeoverTabs = new Map<number, string>()
  const agentTakeover = (card: ConnectCard, r: ConnectResult): boolean => {
    // User decision 11-20: there should be nothing for a person to do. Even if auto sign-in judges "person's turn" or "wrong" (rule-based verdicts are often wrong),
    // Doori (the AI) looks at the screen and continues. The person's parts (robot check, verification code, identity check, sign-up consent) Doori collects with phone cards.
    // What stays: the step that only waits for an authenticator app approval (when tapped on the phone, the watcher connects afterwards)
    if (r.ok || r.tabId === undefined) return false
    if (r.human && APP_CONFIRM_ONLY_END_LOOSE.test(r.message)) return false
    if (Date.now() - (takeoverAt.get(card.id) ?? 0) < 3 * 60_000) return false
    takeoverAt.set(card.id, Date.now())
    takeoverTabs.set(r.tabId, card.id)
    journal.write('connect-takeover', { id: card.id })
    // Once signed in, the watcher (loginWatch) marks it connected and tells the chat
    connectHuman.add(card.id)
    // Whether a task had stopped (tell the taken-over AI too, and tell it again separately when the connection ends — if the taken-over AI finishes before the sign-in,
    // there is no way to continue (measured in shopping 3: the Yogiyo connection finished but nobody continued)))
    const resume = connectAsked.has(card.id)
    // Only the first two sentences show on screen (sentences with tool names go to the AI only)
    const why = joinKoreanSentences(r.message.split(/[.!?]/)[0] ?? '').trim()
    void talk(
      appNote(
        forAI(
          m().takeoverShown(card.name),
          `Automatic sign-in to ${card.name} stopped partway. Continue the sign-in yourself. ` +
            `Read tab ${r.tabId} with browser_read (the automatic sign-in's verdict: ${why}. That verdict comes from rules and may be wrong, so look at the screen and decide). ` +
            `The ID and password are in the vault: enter them only with browser_login and press the sign-in button with browser_click. ` +
            `If the screen asks you to link a quick sign-in to an existing account, press the link button (this is not a new sign-up). ` +
            `Anything that needs the person goes to the phone as a card only: robot-check pictures with browser_request_tap, text captchas and verification codes with browser_request_code, authenticator-app approval with browser_wait_auth, identity fields with browser_fill_profile, and choices the user must make, such as signing up, with browser_request_approval. Never hand over the PC screen or tell the user to do it themselves. ` +
            `Do not ask the user for the password again. Once signed in, leave the tab open but do not mention the tab. ` +
            (resume
              ? `If a task stopped because ${card.name} was needed, finish it after signing in (mention the connection in one line).`
              : 'Report only the result, in one sentence: it is connected.'),
        ),
      ),
    ).catch(() => {})
    return true
  }
  /**
   * Connecting happens in the background: the phone and PC do not wait and can do other things.
   * When it finishes, every phone gets the result and connection list, and a chat note is left so Doori tells the user and continues the stopped task
   */
  const connecting = new Map<string, Promise<ConnectResult>>()
  /** Steps while connecting: shown on the phone's connect card as "opening X → entering ID and password → …" */
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
  /** The tab being signed in during connecting: shown small and live on the phone's connect card (so you can see what it is doing) */
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
  /** Connections handed to a person for a robot check or identity check (when finished on screen, connectMark tells the chat) */
  const connectHuman = new Set<string>()
  const connectStatus = () => {
    const list = [...connecting.keys()]
    void link.broadcast({ kind: 'connect-status', connecting: list })
    live.emit('event', { kind: 'connect', connecting: list })
  }
  /** When Doori put a connect card in the chat (if it connects within 30 minutes after that, the AI is told to continue the stopped task) */
  const connectAsked = new Map<string, number>()
  /** Leaves only a note line in the chat without calling the AI (shown right away on the phone and PC) */
  const postNote = (text: string) => {
    const cur = conversation.current()
    if (!cur) return
    // Do not leave the same note again within 10 minutes (when connecting failed after several taps, the same line piled up three times)
    const note = appNote(text)
    const since = Date.now() - 10 * 60_000
    const recent = store.listMessages(cur.id).slice(-8)
    if (recent.some((m) => m.text === note && Date.parse(m.createdAt) >= since)) return
    postSaved(cur.id, store.addMessage(cur.id, 'user', note))
  }
  /**
   * When the user does something on the phone (approval, password, verification code), leave a line in Doori's voice right away without waiting for the AI's answer:
   * "Got it → now doing this". The next screen moved much later and people could not tell whether anything was happening (real use 11-20)
   */
  const sayNow = (text: string) => {
    const cur = conversation.current()
    if (!cur) return
    postSaved(cur.id, store.addMessage(cur.id, 'assistant', text))
  }
  /** Streams a saved message to the phone and PC screens right away */
  const postSaved = (threadId: string, message: StoredMessage) => {
    const event = { type: 'saved' as const, message }
    void link.broadcast({ kind: 'stream', threadId, event })
    live.emit('event', { kind: 'turn', threadId, posted: true, event })
  }
  /**
   * Connecting from the chat: leaves my message "connect X" and Doori's connect card right away.
   * No AI call, so no waiting, and the sign-in continues on the card (progress and result also stay in the same chat)
   */
  const connectInChat = (card: ConnectCard) => {
    const cur = conversation.current()
    if (!cur) throw new Error(m().chatNotOpen)
    // If the same connect card is already near the end of the chat, do not pile up another (tapping several times gives one card)
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
    postSaved(cur.id, store.addMessage(cur.id, 'user', m().connectRequest(card.name)))
    postConnectCard(card)
  }
  /** Leaves only a connect card in the chat. The card shows [Open screen] or [Try again] according to the last connect result */
  const postConnectCard = (card: ConnectCard) => {
    const cur = conversation.current()
    if (!cur) return
    const record: ConnectRecordMessage = { kind: 'connect', service: card.id }
    postSaved(cur.id, store.addMessage(cur.id, 'tool', JSON.stringify(record)))
  }
  /**
   * [I signed in]: do not trust and mark, verify. Use the watched tab, and if still unsure, open the site's front page fresh
   * and look for text only a signed-in person sees (even if finished in the quick sign-in window, it shows through the site cookie)
   */
  const connectVerify = async (card: ConnectCard): Promise<boolean> => {
    let ok = false
    const watched = loginWatch.tabOf(card.id)
    // If the watched screen has a sure sign, go right away. Otherwise open the site fresh and look as far as My page (never mark by guessing)
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
        message: m().alreadyLoggedIn(card.name),
      })
      void skills
        .connections()
        .then((services) => link.broadcast({ kind: 'connections', services }))
        .catch(() => {})
      return true
    }
    // Not yet: Doori looks at that screen and continues (the watcher is turned back on too)
    if (watched !== undefined) loginWatch.start(card, watched)
    const left: ConnectResult = {
      ok: false,
      reason: 'unknown',
      ...(watched !== undefined ? { tabId: watched } : {}),
      message: m().notLoggedInYet(card.name),
    }
    const agent = agentTakeover(card, left)
    void link.broadcast({
      kind: 'connect-result',
      id: card.id,
      ...left,
      ...(agent ? { agent } : {}),
      message: agent ? m().agentContinues(left.message) : left.message,
    })
    return false
  }
  /** Whether this service's connect card is at the end of the chat (within 8 lines) (judged from the record even after a daemon restart) */
  const cardNearEnd = (card: ConnectCard) => {
    const cur = conversation.current()
    if (!cur) return false
    return store
      .listMessages(cur.id)
      .slice(-8)
      .some(
        (m) =>
          m.role === 'tool' &&
          // A connect card, or a sign-in card for the same site (shown while working), also shows the status, so no note line is needed
          ((m.text.includes('"kind":"connect"') &&
            [card.id, card.name].some((k) => m.text.includes(`"service":${JSON.stringify(k)}`))) ||
            (m.text.includes('"kind":"login"') && m.text.includes(`"site":${JSON.stringify(card.name)}`))),
      )
  }
  const connectDone = (card: ConnectCard) => {
    const asked = connectAsked.get(card.id)
    connectAsked.delete(card.id)
    if (asked && Date.now() - asked < 30 * 60_000) {
      // Report first ("connected → continuing"), then the AI continues (people said they could not tell what was happening while waiting)
      sayNow(m().connectedResume(card.name))
      void talk(
        appNote(
          forAI(
            '',
            `${card.name} is connected and Doori has verified the sign-in. Finish the task that stopped because ${card.name} was needed (do not show the connect card or sign-in again). If the task is already done, say so in one sentence.`,
          ),
        ),
      ).catch(() => {})
    }
    // If this service's connect card is near the end of the chat, that card turns into "connected". Do not leave the same words again as a note line
    else if (!cardNearEnd(card)) postNote(m().connectedReady(card.name))
    void link
      .notify({
        title: m().connectedTitle(card.name),
        body: m().connectedBody,
        tag: `connect-${card.id}`,
        url: '#tab=chat',
      })
      .catch(() => {})
  }
  /** Records the screen at the moment the connection stopped: one picture, the address (without the query), and the first part of the page text (values in fields are masked) */
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
            text: scrubText(snap.text.replace(SNAPSHOT_VALUE, SNAPSHOT_VALUE_MASKED), 1_500),
          }
        : {}),
    })
  }
  /** Services being connected by a batch check (no cards or notes are left in the chat) */
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
    // Thrown errors are inner talk mixed with screen markers (e2 and so on), so give the user plain words and keep the original only in the record
    const p: Promise<ConnectResult> = run().catch((e: Error) => {
      console.warn(`[connect] ${card.id} auto sign-in error: ${e.message}`)
      const tabId = connectTabs.get(card.id)
      return {
        ok: false,
        reason: 'unknown' as const,
        ...(tabId !== undefined ? { tabId } : {}),
        message: /\be\d+\b|ref|tabId/.test(e.message) ? m().loginScreenOff : e.message,
      }
    })
    connecting.set(card.id, p)
    connectStatus()
    void p.then((r) => {
      // Keep the reason for failure in the record (where to look when the user says "it failed")
      if (!r.ok) console.warn(`[connect] ${card.id} did not finish: ${JSON.stringify(r).slice(0, 300)}`)
      connecting.delete(card.id)
      connectSteps.delete(card.id)
      connectTabs.delete(card.id)
      // A batch check (quiet) leaves no chat or notifications: the result goes only to the record (connect-end) and the response
      const quiet = quietConnect.delete(card.id)
      // If it stopped because it could not recognize the screen, Doori (the AI) takes over in the chat
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
      // If it did not get to the end, keep that screen (so the reason it stopped can be seen later)
      if (!r.ok && r.tabId !== undefined) void journalScreen(card.id, r.tabId)
      // Send the result first, then the end of "connecting" (the other way round, the card briefly went back to its first state and then changed)
      void link
        .broadcast({ kind: 'connect-result', id: card.id, ...r, ...(agent ? { agent, human: false } : {}) })
        .then(() => connectStatus())
      void skills
        .connections()
        .then((services) => link.broadcast({ kind: 'connections', services }))
        .catch(() => {})
      if (quiet) {
        // The connected mark was already set by connectFinish. Leave no chat note line, card or phone notification.
        // If it did not get there, close the tab instead of leaving it waiting for a person (leftover tabs from batch checks piled up and closed new sign-in windows)
        if (!r.ok) {
          loginWatch.stop(card.id)
          if (r.tabId !== undefined)
            setTimeout(() => void browser.call('close', { tabId: r.tabId }).catch(() => undefined), 3_000)
        }
      } else if (r.ok) connectDone(card)
      else if (agent) {
        // If that connect card is not at the end of the chat, show it (the card shows "Doori is trying to continue")
        if (!cardNearEnd(card)) postConnectCard(card)
      } else if (r.human || r.tabId !== undefined) {
        // A person's turn to finish: open that screen on the phone or PC and sign in by hand, and Doori checks on its own
        connectHuman.add(card.id)
        // If that connect card is at the end of the chat, the card changes to "Please finish it yourself [Open screen]".
        // If not (started from the Connect screen), a single line of text leaves no button to continue: show a card in the chat
        if (!cardNearEnd(card)) postConnectCard(card)
        void link
          .notify({
            title: m().finishConnectTitle(card.name),
            body: r.message,
            tag: `connect-${card.id}`,
            url: '#tab=chat',
          })
          .catch(() => {})
      } else {
        if (!cardNearEnd(card)) postConnectCard(card)
        void link
          .notify({
            title: m().loginFailedTitle(card.name),
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
   * When a connection ends (including quick sign-in), also finish the sign-in request waiting for that site (the sign-in card Doori showed while working).
   * It signed in with a quick sign-in and no vault value, so tell the AI to reload that tab and continue
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
      void link.broadcast({ kind: 'login-done', id: r.id, ok: true, message: m().loggedInShort(card.name) })
      const threadId = loginThread.get(r.id)
      if (threadId)
        followUp(
          threadId,
          appNote(
            forAI(
              m().loggedInShort(card.name),
              `Signed in to ${card.name} with a quick sign-in, so there is no vault entry. Reload that tab and continue the task.`,
            ),
          ),
        )
    }
  }
  const connectMark = (id: string, on: boolean): string | undefined => {
    journal.write('connect-marked', { id, on })
    loginWatch.stop(id)
    if (on) void skills.card(id).then((card) => card && resolveLoginRequests(card))
    if (on && connectHuman.delete(id)) void skills.card(id).then((card) => card && connectDone(card))
    // When marked connected, remember the method tried then (quick sign-in or vault account): if the sign-in expires, Doori signs in again the same way
    // (measured 11-20: Doori took over and finished the Yogiyo Kakao sign-in, but the method was not kept, so when it expired the connect card appeared again from the start)
    const tried = connectTried.get(id)?.replace(/^keep:/, '')
    if (
      on &&
      tried &&
      !connectVia()[id] &&
      (tried.startsWith('social:') || /^(?:login|relogin|vault)$/.test(tried))
    )
      rememberVia(id, tried.startsWith('social:') ? tried : 'vault')
    // When the Kakao, Naver or Google account itself is connected: remember the account shown on that screen as "my account"
    // (when signing in to another site with quick sign-in, do not ask if the account on the consent screen is the same)
    if (on && id in SOCIAL_PROVIDERS) void rememberProviderAccount(id as SocialProvider).catch(() => {})
    const next = { ...(readSettings().connections ?? {}) }
    if (on) next[id] = new Date().toISOString()
    else delete next[id]
    store.setSetting('connections', next)
    events.emit('settings', readSettings())
    return next[id]
  }
  /** Reads the account currently signed in on a provider's account screen and adds it to my account list (socialAccounts) */
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
  /** Card photo: the daemon fetches and passes it on so the screen never connects to outside servers directly */
  const thumbs = new Thumbs(fetch, async (url) => {
    if (!browser.status.connected) return undefined
    const r = (await browser.call('thumb', { url }, 12_000)) as { data?: string }
    return typeof r?.data === 'string' && r.data.startsWith('data:image/jpeg;base64,') ? r.data : undefined
  })
  /** Card photo + photos the user sent ("photo:filename" — shows the [Photo: …] in chat records again in phone and PC bubbles) */
  const thumbOrPhoto = async (url: string): Promise<string | undefined> => {
    const m = /^photo:([\w-]+\.jpg)$/.exec(url)
    if (!m) return thumbs.get(url)
    const b64 = await readFile(join(photoDir, m[1] as string))
      .then((b) => b.toString('base64'))
      .catch(() => undefined)
    return b64 ? `data:image/jpeg;base64,${b64}` : undefined
  }
  const devReset = opts.devReset ?? process.env.DOOL2_DEV_RESET === '1'
  /**
   * Reset data (settings on the PC and the phone): start over like a new user. Erases chats, memory, goals, library,
   * ideas and my info. Keeps the vault passwords, phone pairing, PC settings (name, AI choice) and the work log
   */
  async function resetAll(
    phone: string,
    o: { services: boolean },
  ): Promise<{ ok: boolean; message: string }> {
    if (conversationBusy()) return { ok: false, message: m().busyReset }
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
      message: o.services ? m().resetWithServices : m().resetPlain,
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
          ...(readSettings().autoApprove ? { autoApprove: true } : {}),
        }
      },
      thread: async (id) => {
        const thread = store.getThread(id)
        return thread ? { kind: 'thread', thread, messages: store.listMessages(id) } : undefined
      },
      ask: async ({ threadId, agent, text: said, image }) => {
        // Photo: kept in Doori's work folder, and Doori views it with photo_view
        const text = image ? `${said}\n\n${await savePhoto(image)}` : said
        // One conversation: a request without a chosen room goes to the conversation (queued if it is working)
        if (!threadId) {
          await talk(text, { agent, viaPhone: true })
          return conversation.current()?.id ?? ''
        }
        const id =
          threadId && store.getThread(threadId) ? threadId : store.createThread(await pickAgent(agent)).id
        if (threads.isRunning(id)) throw new Error(m().threadStillAnswering)
        // The phone gets results through the stream, so here it only runs to the end
        fromPhone.add(id)
        void (async () => {
          for await (const _ of tracked(id, threads.send(id, text))) {
          }
        })().catch(() => {})
        return id
      },
      cancel: (id) => stopThread(id),
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
        if (action === 'done') return handoffDone(tabId, 'the user tapped Done on the phone')
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
      // The card's "First time · sign me up": treat it as the user choosing to sign up for that site, and close the sign-in card that was waiting
      signup: (site, loginId) => {
        browserTools.allowSignup(site)
        if (loginId && browserTools.logins.finish(loginId, 'cancelled'))
          void link.broadcast({ kind: 'login-done', id: loginId, ok: false, message: m().switchedToSignup })
      },
      // Don't know the account: take back the sign-in card and continue as a request in the chat (find ID, reset password).
      // Doori chooses the new password and saves it in the vault (the same path as browser_login's password creation)
      forgot: (site, loginId) => {
        // What the user chose: do that site's password reset (making a new password) without asking
        browserTools.allowSignup(site)
        if (loginId && browserTools.logins.finish(loginId, 'cancelled'))
          void link.broadcast({ kind: 'login-done', id: loginId, ok: false, message: m().switchedToFind })
      },
      // From the phone only with a request signed by the phone key (checked in link.ts)
      reset: (phone: string, o: { services: boolean }) => resetAll(phone, o),
      thumb: (url) => thumbOrPhoto(url),
      // Settings > Vault (ADR 0026): the user views and edits on the phone. Viewing is requested only after the phone verified the device lock.
      // The password goes only to that phone, and the work log keeps only which site was viewed
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
          if (!r) return named(m().noSuchEntry)
          journal.write('vault-reveal', { origin: r.origin })
          return { id: action.id, username: r.username, password: r.password }
        }
        if (action.kind === 'set') {
          const r = await vault.update(action.id, { username: action.username, password: action.password })
          if (r) journal.write('vault-update', { origin: r.origin, password: Boolean(action.password) })
          return named(r ? m().fixed : m().noSuchEntry)
        }
        if (action.kind === 'delete') {
          const ok = await vault.remove(action.id)
          return named(ok ? m().deleted : m().noSuchEntry)
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
          message = r.bad.length ? m().savedLeavingBad(names(r.bad)) : m().saved
        } else if (action.kind === 'clear') {
          await profile.clear()
          journal.write('profile', { cleared: true })
          message = m().profileCleared
        } else if (action.kind === 'forget-pay') {
          const now = { ...((store.getSetting('payChoices') as Record<string, string> | undefined) ?? {}) }
          delete now[action.host]
          store.setSetting('payChoices', now)
          forgetPaySubs(action.host)
          browserTools.forgetChoice(action.host)
          message = m().payForgotten
        } else if (action.kind === 'pay-methods') {
          const r = savePayMethods(store, action.methods)
          // Keep only what and how many were registered (masked displays are not put in the record either)
          journal.write('pay-methods', r.ok ? { kinds: r.methods.map((m) => m.kind) } : { error: r.error })
          message = r.ok ? m().payMethodsSaved : r.error
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
      setAutoApprove: (on, phone) => {
        store.setSetting('autoApprove', on)
        events.emit('settings', readSettings())
        journal.write('auto-approve-set', { on, from: 'phone', phone })
      },
      caps: (phone, caps) => {
        phoneCaps.set(phone, caps)
        journal.write('phone-caps', { caps })
      },
      smsResult: (id, r) => {
        journal.write('phone-sms', { ok: r.ok })
        phoneSms.result(id, r)
      },
      report: (phone, r) => {
        // Also record how the PC side was at that time
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
      cancelConversation: () => stopConversation(),
      connect: async (id, action) => {
        const card = await skills.card(id)
        if (!card) throw new Error(m().noSuchService)
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
      // The phone shows only 8 lines of the goal progress log (reduces what travels through the relay)
      life: async () => life.state({ logs: 8 }),
      feedPage: async (q) => life.feedPage(q),
      libraryPage: async (q) => life.libraryPage(q),
      libraryItem: async (id) => life.libraryItem(id),
      // The library file original to the phone (split into chunks, only paths of files Doori made)
      // File links in answers go by path (only non-sensitive files inside the user's folders)
      fileChunk: async (id, offset, path) => {
        let full: string
        if (path) {
          const real = fileTools.realReadable(path)
          if (!real) return { error: m().fileNotFoundSend }
          full = real
        } else {
          const it = life.libraryItem(id)
          if (!it?.path) return { error: m().noPcFile }
          full = it.path.startsWith('~') ? join(homedir(), it.path.slice(1)) : it.path
        }
        // If it exists only in iCloud, download it (document folder sync)
        const away = await ensureLocal(full).catch(() => undefined)
        if (away) return { error: away }
        const st = await stat(full).catch(() => undefined)
        if (!st?.isFile()) return { error: m().fileNotFound }
        if (st.size > FILE_MAX) return { error: m().fileTooBig }
        const fh = await open(full, 'r')
        try {
          const buf = Buffer.alloc(Math.min(FILE_CHUNK, Math.max(0, st.size - offset)))
          await fh.read(buf, 0, buf.length, offset)
          return { size: st.size, name: basename(full), mime: mimeOf(full), data: buf.toString('base64') }
        } finally {
          await fh.close()
        }
      },
      lifeAction: async (a) => {
        life.act(a)
        if (a.action === 'identity') conversation.rotateSoon(IDENTITY_CHANGED_NOTE)
        return life.state({ logs: 8 })
      },
      connectLogin: async (id, username, password) => {
        const card = await skills.card(id)
        if (!card) throw new Error(m().noSuchService)
        return startConnect(card, () => connectLogin(card, username, password))
      },
      connectSocial: async (id, provider) => {
        const card = await skills.card(id)
        if (!card) throw new Error(m().noSuchService)
        return startConnect(card, () => connectSocial(card, provider), `social:${provider}`)
      },
      decide: async (id, decision, choice) => {
        const label = browserTools.approvals.get(id)?.label ?? ''
        // A text the phone sent on its own under auto-approve (ADR 0030): say so instead of "approved on the phone"
        const auto = browserTools.approvals.get(id)?.auto === true
        // The phone already sent the text (the result follows right away): do not say it will press
        if (
          decision === 'approve' &&
          approvalThread.get(id) &&
          !isSmsApproval(browserTools.approvals.get(id)?.url)
        )
          sayNow(m().approvedPressing(label))
        const r =
          decision === 'reject'
            ? { ok: browserTools.approvals.reject(id), message: m().rejected }
            : await approveAny(id, choice, true)
        // If decided on the phone, tell the AI the result so it continues (the PC screen tells it directly)
        const threadId = approvalThread.get(id)
        if (threadId)
          followUp(
            threadId,
            decision === 'reject'
              ? appNote(forAI('', `The user declined on the phone ("${label}"). Do not press it.`))
              : appNote(
                  forAI(
                    auto ? m().doneAutomatically(r.message) : m().approvedOnPhone(r.message),
                    'Check the result and continue the task.',
                  ),
                ),
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
      lang,
    },
  )
  browserTools.approvals.onChange = (rec) => void link.broadcast({ kind: 'approval', approval: rec })
  browserTools.approvals.onCreate = (rec) => {
    // An approval request comes from a tool call in the chat that is answering. If there is only one, treat it as that chat
    const only = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    if (only) approvalThread.set(rec.id, only)
    void link.broadcast({ kind: 'approval', approval: rec })
    // Notify the phone even if the app is off
    void link
      .notify({
        title: m().approvalWaiting,
        body: [rec.what, rec.amount].filter(Boolean).join(' · ') || m().pressLabel(rec.label),
        tag: `approval-${rec.id}`,
        url: `#a=${rec.id}`,
      })
      .catch(() => {})
  }
  await link.start()
  if (opts.nativeHost) {
    const { script, ...where } = opts.nativeHost
    await registerNativeHost({ dataDir: paths.dataDir, runtime: dool2BrowserHost(script), ...where }).catch(
      (e: Error) => console.error(`[dool2] Could not register the browser host: ${e.message}`),
    )
  }
  let running = 0
  /** Chats being judged by the before-finishing check (messages arriving meanwhile are queued) */
  const judging = new Set<string>()
  /** Chat records waiting for a person */
  const WAITING_KINDS = new Set(['approval', 'login', 'connect', 'handoff'])
  /** Authenticator approvals watched off the turn, per chat (stopping ends them) */
  const authWatches = new Map<string, AbortController>()
  /**
   * The user pressed stop (PC or phone): end the running turn, the before-finishing check that may be judging it, and
   * the rounds it would send back. Stopping only the turn let a verdict that arrived later start the work again
   */
  function stopThread(threadId: string) {
    finishCheck?.drop(threadId)
    authWatches.get(threadId)?.abort()
    authWatches.delete(threadId)
    threads.cancel(threadId)
  }
  function stopConversation() {
    const cur = conversation.current()?.id
    if (cur) stopThread(cur)
  }
  /** The first request of a chat being continued by the before-finishing check (when the verdict ends, the check's record is cleared) */
  const lastAsk = new Map<string, string>()
  /**
   * Wraps one chat turn and reports the "working" state.
   * receivedAt: when the request reached the daemon (before picking the segment), for the turn's phase timings
   */
  async function* tracked(
    threadId: string,
    inner: AsyncIterable<DaemonStreamEvent>,
    o: { receivedAt?: number } = {},
  ): AsyncGenerator<DaemonStreamEvent> {
    if (running++ === 0) events.emit('busy', true)
    activeThreads.add(threadId)
    live.emit('event', { kind: 'busy', busy: true })
    // Send the same progress to connected phones too (so chats started on the PC show on the phone)
    // The separate chat that writes feed posts is not streamed to the phone's chat screen (the result goes to the feed)
    const toPhones = threadId === store.getSetting('feedThread') ? () => {} : link.streamer(threadId)
    // So the PC screen draws the main chat and the separate chats apart
    const side = store.getThread(threadId)?.side === true
    // Whether this answer produced an approval request or a "please do it yourself" (then no separate "done" notification is sent)
    let asked = false
    // Feed "finished tasks": the request and answer of a turn that worked with tools
    let askText = ''
    let usedTool = false
    let answerText = ''
    // Work log: the tool names used this turn and how long they took (the content of the words is not written)
    const turnAt = Date.now()
    const turnTools: string[] = []
    // Characters of text each tool result gave the AI, in the order of turnTools (sizes only; null = not known),
    // to see which tools fill the session
    const turnChars: (number | null)[] = []
    const turnFromPhone = fromPhone.has(threadId)
    // The before-finishing check runs only in chats with the user (not feed posts or scheduled tasks)
    const checkable = threadId !== store.getSetting('feedThread') && !routineThreads.has(threadId)
    let failed = false
    // Where the time of the turn went, for problem reports: the AI program up (started), the first word or tool, and
    // why it failed (a usage limit shows here). A tester's first answer was slow and the log could not say why.
    // Phases, all from the turn's start: prepMs before it (request received → segment picked, a summary can sit here),
    // startMs the AI program ready, eventMs the first sign of the AI after that, textMs the first word, firstMs the first
    // word or tool
    const prepMs = o.receivedAt !== undefined ? Math.max(0, turnAt - o.receivedAt) : undefined
    let startMs: number | undefined
    let eventMs: number | undefined
    let textMs: number | undefined
    let firstMs: number | undefined
    let failCode: string | undefined
    try {
      for await (const ev of inner) {
        if (ev.type === 'agent') {
          const at = Date.now() - turnAt
          if (ev.event.type === 'started') startMs ??= at
          else if (startMs !== undefined) eventMs ??= at
          if (ev.event.type === 'text') textMs ??= at
          if (ev.event.type === 'text' || ev.event.type === 'tool') firstMs ??= at
          if (ev.event.type === 'error') failCode ??= ev.event.code
          if (ev.event.type === 'limit_reached') failCode ??= 'limit_reached'
        }
        if (ev.type === 'saved' && ev.message.role === 'user' && !readAppNote(ev.message.text)) {
          askText = withoutPhotoMark(ev.message.text)
          if (checkable) finishCheck?.begin(threadId, askText)
        }
        if (ev.type === 'agent' && (ev.event.type === 'error' || ev.event.type === 'limit_reached'))
          failed = true
        if (
          ev.type === 'agent' &&
          ev.event.type === 'tool' &&
          !/(goal|memory|library|feed)_|status|skill_/.test(ev.event.name)
        )
          usedTool = true
        // Waiting for an authenticator approval off the turn: the reply ends waiting for the person
        if (ev.type === 'agent' && ev.event.type === 'tool' && ev.event.name.endsWith('browser_wait_auth'))
          asked = true
        if (ev.type === 'saved' && ev.message.role === 'assistant') answerText = ev.message.text
        if (ev.type === 'agent' && ev.event.type === 'tool' && turnTools.length < 60) {
          turnTools.push(ev.event.name.replace(/^(mcp__dool2__|dool2_)/, ''))
          turnChars.push(null)
        }
        if (ev.type === 'agent' && ev.event.type === 'tool_result' && typeof ev.event.chars === 'number')
          noteResultChars(turnTools, turnChars, ev.event.name, ev.event.chars)
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
        // Records that wait for a person are only approval, sign-in, connection and handoff. Work steps, quick answers, lists and cards are for the screen,
        // so the "done" notification goes out as usual and the before-finishing check runs (it checks whether a question asked by a quick answer was really needed)
        if (rec?.kind && WAITING_KINDS.has(rec.kind)) {
          asked = true
          if (rec.kind !== 'approval')
            void link
              .notify({
                title: rec.kind === 'handoff' ? m().handoffTitle : m().loginNeeded,
                body: rec.reason ?? m().waitingForHelp,
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
        ...(turnChars.some((c) => c !== null) ? { chars: turnChars } : {}),
        answered: answerText.length > 0,
        ...(prepMs !== undefined ? { prepMs } : {}),
        ...(startMs !== undefined ? { startMs } : {}),
        ...(eventMs !== undefined ? { eventMs } : {}),
        ...(textMs !== undefined ? { textMs } : {}),
        ...(firstMs !== undefined ? { firstMs } : {}),
        ...(failCode ? { code: failCode } : {}),
        ...(asked ? { waitingForUser: true } : {}),
        ...(turnFromPhone ? { phone: true } : {}),
      })
      // If phone approval or sign-in results arrived while answering, send them next
      const next = pendingFollowUps.get(threadId)?.shift()
      // Before-finishing check: if it is not waiting for a person, there is no next message, and the turn worked with tools, judge separately whether it is finished
      let again: string | undefined
      if (
        finishCheck &&
        checkable &&
        !asked &&
        !failed &&
        !next &&
        !(queued.length && conversation.current()?.id === threadId) &&
        answerText
      ) {
        const gen = finishCheck.current(threadId)
        judging.add(threadId)
        const r = await finishCheck
          .check(threadId, { answer: answerText, tools: turnTools })
          .catch(() => undefined)
          .finally(() => judging.delete(threadId))
        if (r && r.kind !== 'skip')
          journal.write('finish-check', {
            result: r.kind,
            cycles: r.cycles,
            why: r.why,
            ...(r.kind === 'stop' ? { reason: r.reason } : {}),
          })
        // If a new request or stop came in while judging, do not send it back
        // (if a message the user sent while judging is queued, that message comes first)
        const spoke = queued.length > 0 && conversation.current()?.id === threadId
        if (
          r?.kind === 'again' &&
          finishCheck.current(threadId) === gen &&
          !threads.isRunning(threadId) &&
          !spoke
        )
          again = r.note
      }
      // The feed "finished tasks" entry is added once, when there is nothing left to continue (for a continued turn, with the first request)
      const feedAsk = askText || finishCheck?.askOf(threadId) || lastAsk.get(threadId)
      if (usedTool && feedAsk && answerText && !again && !routineThreads.has(threadId)) {
        lastAsk.delete(threadId)
        life.feed({
          kind: 'done',
          title: feedAsk.slice(0, 60),
          body: answerText.slice(0, 300),
          ref: threadId,
        })
      } else if (again && feedAsk) lastAsk.set(threadId, feedAsk)
      // If the next message is about to switch segments, summarize beforehand (so the next message is saved and answered right away)
      if (!again && conversation.current()?.id === threadId) conversation.prewarm()
      if (next) setTimeout(() => followUp(threadId, next), 0)
      else if (again) {
        const note = again
        // A continued turn also counts as a task handed over from the phone: the "done" notification goes out once, at the last turn
        if (turnFromPhone) fromPhone.add(threadId)
        // Unless the user pressed stop in the meantime (stopping drops the request)
        setTimeout(() => {
          if (finishCheck?.current(threadId) !== undefined) followUp(threadId, appNote(note))
        }, 0)
      }
      // Chat: gather messages queued while answering into one turn and send them next
      else if (queued.length && conversation.current()?.id === threadId) {
        const text = queued.splice(0).join('\n\n')
        live.emit('event', { kind: 'queued', texts: [] })
        setTimeout(() => void talk(text).catch(() => {}), 0)
      }
      if (--running === 0) events.emit('busy', false)
      live.emit('event', { kind: 'busy', busy: activeThreads.size > 0 })
      // When a task handed over from the phone finishes, notify the phone (even if it ended while the app was closed)
      if (!again && fromPhone.delete(threadId) && !asked) {
        const t = store.getThread(threadId)
        const last = store
          .listMessages(threadId)
          .filter((m) => m.role === 'assistant')
          .at(-1)
        void link
          .notify({
            title: t?.title ? m().doneTitle(t.title) : m().doneUntitled,
            body: last ? previewText(last.text, 120) : m().checkResult,
            tag: `thread-${threadId}`,
            url: `#t=${threadId}`,
          })
          .catch(() => {})
      }
    }
  }
  /** Chats that are answering right now (to know which chat an approval request came from) */
  const activeThreads = new Set<string>()
  const approvalThread = new Map<string, string>()
  /** The chat a sign-in request came from (so that saving on the phone continues that chat) */
  const loginThread = new Map<string, string>()
  /** Receives what the screen asks during sign-in (verification code and so on) with the phone's input screen */
  const infoRequests = new InfoRequests()
  infoRequests.onCreate = (request) => {
    void link.broadcast({ kind: 'info-request', request })
    void link
      .notify({
        title:
          request.field === 'form'
            ? m().infoFormTitle
            : `${request.site}: ${request.field === 'otp' ? m().needCode : request.field === 'tap' ? m().needTap : m().needInput}`,
        body: request.hint ?? request.label,
        tag: `info-${request.id}`,
        url: '',
      })
      .catch(() => {})
  }
  infoRequests.onDone = (id) => void link.broadcast({ kind: 'info-done', id })
  // Ask before sign-up or password change: if the user asked for it in the chat, go ahead, otherwise show a choice card on the phone.
  // Instructions alone let the AI sign up without asking, so the daemon confirms before making a new password
  browserTools.askSignup = (site, key, purpose, needOwn) => {
    const threadId = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    const lastAsk = threadId
      ? (store
          .listMessages(threadId)
          .filter((m) => m.role === 'user')
          .at(-1)?.text ?? '')
      : ''
    if (!needOwn && askedForAccount(lastAsk, purpose)) return 'ok'
    // Choose whether Doori makes the password or the user does (it changed without the user knowing and caused alarm, 11-20)
    const OWN = m().optOwn
    // If the site's field did not accept the password Doori made, start with the user choosing it
    const options = needOwn
      ? [OWN, m().optStop]
      : purpose === 'reset'
        ? [m().optDooriMakes, OWN, m().optStop]
        : [m().optSignup, OWN, m().optHaveAccount]
    const answer = infoRequests.ask(
      {
        site,
        host: key,
        field: 'choice',
        label: needOwn
          ? m().chooseOwnPassword(site)
          : purpose === 'reset'
            ? m().changePassword(site)
            : m().howToLogin(site),
        hint: needOwn ? m().hintOwnPassword : purpose === 'reset' ? m().hintReset : m().hintSignup,
        options,
      },
      30 * 60_000,
    )
    void answer.then(async (v) => {
      if (!v || !threadId) return
      let yes = v.trim() === options[0]
      if (v.trim() === OWN) {
        // Receive the new password twice on the phone. The value stays only in this daemon, not in the AI or the record
        const pw = await infoRequests.ask(
          {
            site,
            host: key,
            field: 'password',
            label: m().newPasswordLabel(site),
            hint: m().newPasswordHint,
            pattern: '^.{8,64}$',
            patternHint: m().newPasswordPattern,
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
          forAI(
            '',
            purpose === 'reset'
              ? yes
                ? `The user chose to change the ${site} password. Continue with browser_new_password(purpose: "reset").`
                : `The user decided not to change the ${site} password. Tell the user about any part of the task that needs a sign-in.`
              : yes
                ? `The user chose to sign up for ${site}. Continue on the sign-up screen with browser_new_password.`
                : `The user says they already have a ${site} account. Do not sign up: use browser_login on the sign-in screen, or show a browser_request_login card if the vault has no entry.`,
          ),
        ),
      )
    })
    return 'asked'
  }
  // My info card: receive only once and keep it in the vault, and when saved, tell the chat to continue
  browserTools.requestCode = (tabId, field, label, hint, host, kind, firstRef, image) => {
    const threadId = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    // The last digits of the ID number: not stored, only put into this field
    if (kind === 'rrn_back') {
      label = m().rrnLabel
      hint = m().rrnHint
    }
    if (kind === 'captcha') {
      label = m().captchaLabel
      hint = m().captchaHint
    }
    // If the same field is already being asked, do not show the card again (the AI called twice and two cards appeared)
    const same = infoRequests
      .pending()
      .find(
        (q) =>
          q.host === host &&
          q.label === label &&
          (q.field === 'otp' || q.field === 'secret' || q.field === 'text'),
      )
    // A captcha picture may have changed, so close the earlier card and show a new one
    if (same && kind === 'captcha') infoRequests.cancel(same.id)
    else if (same) return same.id
    const answer = infoRequests.ask(
      {
        site: host || m().siteAuth,
        host,
        field: kind === 'rrn_back' ? 'secret' : kind === 'captcha' ? 'text' : 'otp',
        ...(kind === 'captcha' && image ? { image } : {}),
        ...(kind === 'rrn_back' ? { pattern: '^[1-4]\\d{6}$', patternHint: m().rrnPattern } : {}),
        label,
        ...(hint ? { hint } : {}),
      },
      10 * 60_000,
    )
    const id = infoRequests.pending().at(-1)?.id
    void answer.then(async (code) => {
      if (!code) return
      sayNow(kind === 'rrn_back' ? m().gotRrn : kind === 'captcha' ? m().gotCaptcha : m().gotCode)
      // The last digits of the ID number are saved in the vault (my info) so they are not asked again
      if (kind === 'rrn_back') await profile.update({ rrn_back: code }).catch(() => undefined)
      // The screen may have been read again while entering and the markers changed: find the field with the same name again and enter it (the number is kept out of the record and the AI)
      const snap = (await browser.call('snapshot', { tabId, maxChars: 20_000 }).catch(() => undefined)) as
        | { text: string; url?: string }
        | undefined
      const ref = snap ? ([...snap.text.matchAll(SNAPSHOT_FIELD)].find((m) => m[3] === field)?.[1] ?? '') : ''
      // Enter into the field pointed at first, and if the markers changed, find the field with the same name and enter it
      // Enter through the same path as the vault (fill): only on that site's address, and masked fields (password fields) work too. The value is not returned
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
          forAI(
            '',
            ok
              ? `The user entered the ${kind === 'rrn_back' ? 'last digits of the ID number' : kind === 'captcha' ? 'captcha' : 'verification code'} on the phone and it went into the "${field}" field. Read the page, press the confirm/verify button and continue the task.`
              : `The user entered the verification code, but the "${field}" field could not be found on the screen, so it was not entered. Read the page, check the field and call browser_request_code again.`,
          ),
        ),
      )
    })
    return id
  }
  // A screen handed to a person: when the user taps [Done] or the screen changes (looks finished), Doori continues without making the user write in the chat
  // (user 11-20: "I want it to notice by itself, without me saying I'm done")
  const handoffDoneAt = new Map<number, number>()
  const handoffDone = (tabId: number, why: string) => {
    browserTools.stopHandoffWatch(tabId)
    if (Date.now() - (handoffDoneAt.get(tabId) ?? 0) < 20_000) return
    handoffDoneAt.set(tabId, Date.now())
    const threadId = conversation.current()?.id
    if (!threadId) return
    sayNow(m().screenChanged)
    followUp(
      threadId,
      appNote(
        forAI(
          '',
          `The screen that was handed over changed (${why}). The user seems to be done. Read tab ${tabId} again (the original tab if it was closed), check, and finish the task. If something is still left, mention only that, in one sentence. Do not ask the user to say they are done.`,
        ),
      ),
    )
  }
  browserTools.onHandoffChanged = handoffDone
  // Solving by tapping the picture (robot check): taps the spots tapped on the phone card (0 to 1000 relative to the picture) in order at the same places on the PC screen
  browserTools.requestTap = (tabId, say, host, image, rect, taps) => {
    const threadId = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    // Close earlier picture cards of the same site (the puzzle picture changed)
    for (const q of infoRequests.pending())
      if (q.field === 'tap' && q.host === host) infoRequests.cancel(q.id)
    const answer = infoRequests.ask(
      {
        site: host || m().siteRobot,
        host,
        field: 'tap',
        label: say,
        hint: taps > 1 ? m().tapMany(taps) : m().tapOne,
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
      sayNow(m().gotTaps(points.length))
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
          forAI(
            '',
            ok
              ? `The user tapped ${points.length} spot(s) on the picture card on the phone and the same spots were tapped on the PC screen. Read the page again, press confirm/submit if there is one, and if the robot check appears again, use browser_request_tap again and continue the task.`
              : 'The spots the user tapped on the picture card could not be tapped on the PC screen. Read the screen again and use browser_request_tap again.',
          ),
        ),
      )
    })
    return id
  }
  // Payment password: receive it on the phone's secure keypad and tap the keypad buttons pointed out earlier in order. The value is kept out of the record and the AI
  browserTools.requestPin = (tabId, label, host, keys, length) => {
    const threadId = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    const answer = infoRequests.ask(
      {
        site: host || m().sitePay,
        host,
        field: 'secret',
        label,
        hint: m().pinHint(length),
        // The phone's secure keypad reads the last {n}+1 as the digit count (ID number '^[1-4]\\d{6}$' = 7 digits)
        pattern: `^\\d\\d{${length - 1}}$`,
        patternHint: m().pinPattern(length),
      },
      5 * 60_000,
    )
    const id = infoRequests.pending().at(-1)?.id
    void answer.then(async (pin) => {
      if (!pin) return
      sayNow(m().gotPin)
      const ok = await browserTools.pressPin(tabId, keys, pin)
      journal.write('pin-typed', { host, ok })
      if (!threadId) return
      followUp(
        threadId,
        appNote(
          forAI(
            '',
            ok
              ? 'The user entered the payment password on the phone keypad and Doori tapped the on-screen keypad. Read the page, check whether the payment finished (order complete, order number) and tell the user. If the keypad is unchanged, the keys moved: point them out again and call browser_request_code(kind: "pin").'
              : 'A keypad button could not be found while tapping the payment password. Read the page again, point out the keypad again and call browser_request_code(kind: "pin").',
          ),
        ),
      )
    })
    return id
  }
  browserTools.requestProfile = (fields, reason, options) => {
    const threadId = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    const names = (list: string[]) =>
      list.map((f) => PROFILE_FIELDS[f as keyof typeof PROFILE_FIELDS].label).join('·')
    // The verification app is not received as text but as a separate choice card (from the apps shown in that site's verification window)
    const appOptions = (options?.length ? options : [...AUTH_APPS]).slice(0, 10)
    // A card that takes birth date and mobile phone is for identity checks, so if there is no default app, also have the user choose the app on the same card
    const identity = fields.includes('birth') && fields.includes('phone')
    const wantsApp = fields.includes('auth_app') || identity
    const formFields = fields.filter((f) => f !== 'auth_app')
    const askApp = async (): Promise<string> => {
      const picked = await infoRequests.ask(
        {
          site: m().hostDoori,
          host: m().hostMyInfo,
          field: 'choice',
          label: m().authAppLabel,
          hint: m().authAppHint,
          options: appOptions,
        },
        30 * 60_000,
      )
      if (!picked) return ''
      // Save as default only when there is none (the working apps differ per site, so a different app can be chosen just this once)
      if (!(await profile.get()).auth_app) await profile.update({ auth_app: picked })
      return `For the verification app, the user chose '${picked}' this time. Press the button with that name, go as far as the request-verification button, and ask for the phone approval.`
    }
    const answer = formFields.length
      ? infoRequests.ask(
          {
            site: m().hostDoori,
            host: m().hostMyInfo,
            field: 'form',
            label: m().hostMyInfo,
            hint: m().infoHint(reason || m().infoDefaultReason),
            fields: [
              ...formFields.map((key) => ({ key, ...PROFILE_FIELDS[key] })),
              // The verification app goes as a chip at the bottom of the same card (not received as text)
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
      // If chosen on the same card use that, and if only the app is requested (a different app per site) use the choice card
      const pickedInForm = typeof input.auth_app === 'string' && input.auth_app ? input.auth_app : ''
      const app = pickedInForm
        ? `For the verification app, the user chose '${pickedInForm}'. Press the button with that name, go as far as the request-verification button, and ask for the phone approval.`
        : wantsApp && !formFields.length
          ? await askApp()
          : ''
      if (!threadId) return
      followUp(
        threadId,
        appNote(
          forAI(
            '',
            [
              formFields.length
                ? `The user's info was saved (${names(saved) || 'none'})${bad.length ? `. Left out because of a wrong format: ${names(bad)}` : ''}.`
                : '',
              app,
              'Fill the fields with browser_fill_profile and continue the task.',
            ]
              .filter(Boolean)
              .join(' '),
          ),
        ),
      )
    })
    return id ?? (wantsApp ? infoRequests.pending().at(-1)?.id : undefined)
  }
  /**
   * While connecting, ask the phone instead of handing over to a person: provider accounts through the sign-in card (vault), verification codes through the input screen
   */
  const loginAsk = (card: ConnectCard): LoginAsk => ({
    // The account chosen when there are several provider accounts (the text shown on Google's choose-an-account screen: "name m***@gmail.com")
    account: {
      get: (provider) =>
        (store.getSetting('providerAccounts') as Record<string, string> | undefined)?.[provider],
      set: (provider, label) =>
        store.setSetting('providerAccounts', {
          ...((store.getSetting('providerAccounts') as Record<string, string> | undefined) ?? {}),
          [provider]: label.slice(0, 120),
        }),
    },
    // Provider accounts the user confirmed as "my account" (the masked email text as is, not a secret).
    // An account chosen on Google's account chooser also counts as my account
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
      // When "I will do it while watching the screen" is chosen on the phone, open that sign-in tab as a remote screen
      browserTools.holdForPerson(tabId)
      const r = browserTools.logins.create({ tabId, origin, site: label, connect: true })
      // Make the connect card show "A Kakao account is needed [Enter]" (so you can tell what it is waiting for while it spins)
      connectStep(card.id)(m().needLabel(label), {
        kind: 'login',
        id: r.id,
        label: m().putLabel(label),
      })
      // When entered on the phone, saveLogin puts it in the vault and ends the request. Then return the vault value
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
        // A choice question ("Use Kakao account X?") goes as it is, and a value to enter (verification code) as "X needed"
        connectStep(card.id)(q.field === 'choice' ? q.label : m().needLabel(q.label), {
          kind: 'info',
          id: req.id,
          label: q.field === 'choice' ? m().pickLabel : m().putLabel(q.label),
        })
      return answer
    },
  })
  browserTools.siteConnector = (url) => connectors.forUrl(url)
  // Also watch tabs signed in with the vault while working: when signed in, mark that service connected
  // (measured 11-21 Shinhan Card: signed up and signed in during chat and even read the card info, but the connection list still said "not connected")
  browserTools.reloginFor = async (origin) => {
    const c = await connectors.forUrl(origin)
    if (!c) return undefined
    const card = await skills.card(c.id)
    if (!card || card.how !== 'browser') return undefined
    const via = connectVia()[card.id]
    if (via?.startsWith('social:') || (await vaultCreds(card))) return card.id
    return undefined
  }
  // When sign-up finishes and an account enters the vault, mark that service connected (measured 11-22 Kidsnote: signed up and still stayed "not connected")
  browserTools.onAccountSaved = (url) => {
    void connectors
      .forUrl(url)
      .then((c) => {
        if (!c || readSettings().connections?.[c.id]) return
        connectTried.set(c.id, 'vault')
        connectMark(c.id, true)
      })
      .catch(() => undefined)
  }
  browserTools.onVaultLogin = (tabId, url) => {
    void connectors
      .forUrl(url)
      .then(async (c) => {
        if (!c || readSettings().connections?.[c.id]) return
        const card = await skills.card(c.id)
        if (!card) return
        // It signed in with the vault, so leave the method so it signs in with the vault again when it expires (connectMark remembers)
        connectTried.set(card.id, 'vault')
        loginWatch.start(card, tabId)
      })
      .catch(() => undefined)
  }
  void connectors
    .paySites()
    .then((sites) => browserTools.setPayServiceSites(sites))
    .catch(() => {})
  // A tab taken over in a connection: if the sign-in screen is another address of that service's site (login.site), use the account entered when connecting.
  // Not put into screens that moved to another site (such as a quick sign-in provider)
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
  // When the extension reports a closed Doori tab, delete that tab's record (otherwise it piles up all day)
  browser.on('notice', (n) => {
    if (n.event === 'tab-closed') {
      takeoverTabs.delete(n.tabId)
      browserTools.forgetTab(n.tabId)
      connectors.forgetTab(n.tabId)
    }
  })
  browserTools.notifyUser = (title, body) =>
    void link.notify({ title, body, tag: 'auth-wait', url: '#tab=chat' }).catch(() => {})
  // Waiting for verification approval: when [I verified] is tapped on the phone card, Doori presses the site's [Verified] once
  browserTools.askAuthDone = (host, label, hint) => {
    const answer = infoRequests.ask(
      { site: host || m().siteEasyAuth, host, field: 'choice', label, hint, options: [m().easyAuthDone] },
      200_000,
    )
    const id = infoRequests.pending().at(-1)?.id
    return { answer, cancel: () => void (id && infoRequests.cancel(id)) }
  }
  // Waiting for that approval does not hold the chat: the reply ends, and the screen comes back as a new message
  browserTools.afterAuth = () => {
    const only = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    if (!only) return undefined
    authWatches.get(only)?.abort()
    const ac = new AbortController()
    authWatches.set(only, ac)
    return {
      signal: ac.signal,
      deliver: (text) => {
        if (authWatches.get(only) === ac) authWatches.delete(only)
        followUp(only, appNote(forAI(m().authWaitOver, text)))
      },
    }
  }
  browserTools.onActiveTab = (tabId) => void link.broadcast({ kind: 'work-tab', tabId }, { live: true })
  browserTools.logins.onCreate = (r) => {
    const only = activeThreads.size === 1 ? [...activeThreads][0] : undefined
    if (only) loginThread.set(r.id, only)
    void link.broadcast({ kind: 'login-request', request: r })
    void link
      .notify({
        title: m().loginNeeded,
        body: m().loginBody(r.site),
        tag: `login-${r.id}`,
        url: only ? `#t=${only}` : '',
      })
      .catch(() => {})
  }
  /**
   * Saves the value entered on a sign-in card into the vault. The value stays out of the AI, the chat record and phone notifications.
   * If entered on the phone, tell the AI in that chat to continue (the PC screen tells it directly)
   */
  async function saveLogin(id: string, username: string, password: string, viaPhone: boolean) {
    const r = browserTools.logins.get(id)
    if (!r || r.status !== 'pending') return { ok: false, message: m().loginRequestGone }
    try {
      await vault.add({ url: r.origin, username, password })
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
    // Until the sign-in succeeds it is "unverified": if the site says it is wrong, delete it from the vault and receive the card again
    browserTools.markUnverified(r.origin)
    browserTools.logins.finish(id, 'saved', username)
    const message = m().savedLoginInfo(r.site)
    void link.broadcast({ kind: 'login-done', id, ok: true, message })
    const threadId = loginThread.get(id)
    if (viaPhone && threadId)
      followUp(
        threadId,
        appNote(forAI(message, 'Fill them in with browser_login, sign in and continue the task.')),
      )
    return { ok: true, message }
  }
  /**
   * Tells the AI the result of an approval or sign-in done on the phone so it continues.
   * If that chat is still answering (on the phone the card shows before the answer), do not discard it: send it when the answer ends
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
  /** Chats handed over from the phone (notify the phone when done) */
  const fromPhone = new Set<string>()
  /** Chat: messages that arrived while Doori was answering and wait for their turn */
  const queued: string[] = []
  /** Picking a segment (the summary request can take long, so messages arriving meanwhile are queued too) */
  let preparing = false
  const conversationBusy = () =>
    preparing || conversation.isRunning() || judging.has(conversation.current()?.id ?? '')
  /**
   * Sends one message to the chat. If it is answering, queue it and send it after that turn ends (ADR 0015).
   * Progress goes through GET /api/conversation/live and the phone stream
   */
  async function talk(text: string, o: { agent?: AgentId; viaPhone?: boolean } = {}) {
    const receivedAt = Date.now()
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
    // Proactive checks did not call the AI and were left only as cards in the chat. If the user continues about it, add it to this turn so it is understood
    const told = unseenTells.splice(0)
    const aside = told.length
      ? appNote(
          `Already shown to the user in the chat (the user may talk about these):\n${told.map((t) => `- ${t.title}${t.body ? ` — ${t.body}` : ''}${t.from ? ` (${t.from})` : ''}`).join('\n')}`,
        )
      : undefined
    void (async () => {
      for await (const _ of tracked(sessionId, threads.send(sessionId, text, aside ? { aside } : {}), {
        receivedAt,
      })) {
      }
    })().catch(() => {})
    return { queued: false }
  }
  /** Proactive checks left as cards in the chat that the AI does not know yet */
  const unseenTells: TellRecordMessage[] = []
  // Goals and automatic tasks: Doori does them at the set time
  /** Chats doing a scheduled task (that turn is not put separately into the feed "finished tasks") */
  const routineThreads = new Set<string>()
  /** Feed posts are written in a separate chat so the main chat is not cluttered */
  const feedThreadId = async () => {
    const saved = store.getSetting('feedThread')
    if (typeof saved === 'string' && store.getThread(saved)) return saved
    const t = store.createThread(await pickAgent(undefined), m().feedThreadTitle, undefined, true)
    store.setSetting('feedThread', t.id)
    return t.id
  }
  /** One run of a scheduled task. note: what a quick check found (ADR 0031), added to the ask */
  async function runRoutine(r: Routine, tries = 0, note?: string) {
    let threadId: string
    let text: string
    // Tasks that notify only when a condition is met run in a separate chat (so "nothing to report" does not pile up in the main chat on days with no match)
    const quietly = r.target === 'feed' || r.notify === 'when_found'
    if (quietly) {
      threadId = await feedThreadId()
      text = r.target === 'feed' ? routineAsk(r) : `This is a scheduled task ("${r.title}"). ${routineAsk(r)}`
      if (note) text += `\n\n${note}`
    } else {
      // To the chat: if it is answering, wait in line
      text = appNote(
        forAI(
          '',
          `This is a scheduled task ("${r.title}"). ${routineAsk(r)} Skip the greeting and give the result first, briefly.${note ? `\n\n${note}` : ''}`,
        ),
      )
      if (conversationBusy()) {
        queued.push(text)
        live.emit('event', { kind: 'queued', texts: [...queued] })
        return
      }
      threadId = (await conversation.prepare(await pickAgent(undefined))).session.id
    }
    if (threads.isRunning(threadId)) {
      // If the separate chat is busy with other work (proactive checks, ideas), try again in a minute (up to 30 minutes)
      if (quietly && tries < 30)
        setTimeout(() => void runRoutine(r, tries + 1, note).catch(() => {}), 60_000).unref?.()
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
    // If the condition was not met, tell neither the feed nor the phone
    if (!run || run.quiet) return
    // The result of a separate chat is also left in the main chat as a Doori card (so the user can continue talking about it)
    if (r.target !== 'feed' && quietly && run.item) tellInChat(run.item)
    const push = () =>
      void link
        .notify({
          title: r.target === 'feed' ? m().newFeedPost : r.title,
          body: (run.item?.body ?? answer).replace(/\*\*/g, '').replace(/\s+/g, ' ').slice(0, 120),
          tag: `routine-${r.id}`,
          url: r.target === 'feed' ? '#tab=feed' : '#tab=chat',
        })
        .catch(() => {})
    // "Do it overnight and tell me in the morning": leave the result in the chat right away and delay only the phone notification to the set time
    const wait = tellDelay(r.tellAt, new Date())
    if (wait > 0) setTimeout(push, wait).unref?.()
    else push()
  }
  // Make feed chats created earlier separate chats too (so they do not mix into the main chat)
  {
    const f = store.getSetting('feedThread')
    if (typeof f === 'string' && store.getThread(f)) store.setSide(f)
  }
  // Tailored ideas: ask Doori in the feed chat to find them (the result arrives through the idea_suggest tool)
  life.onIdeas = () =>
    void (async () => {
      const threadId = await feedThreadId()
      if (threads.isRunning(threadId)) return
      const ask =
        'Find tailored to-dos for the Ideas tab. Recall the memories, goals, connected services and recent chats, pick 3 to 6 concrete things Doori can actually do for the user right now, and post them with idea_suggest. You do not need to open the web. Answer in one sentence only.'
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
  // Proactive checks: every hour from 6 am to 10 pm, look at tasks due for a check and connected services, and post with feed_tell if something needs attention (silent otherwise)
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
  // Proactive checks: also left in the main chat as a Doori card (no AI call). If it is answering, after it ends (waits up to 5 minutes)
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
    void (
      r.check
        ? runQuickCheck(r, {
            call: (tool, input) => connectors.call(tool, input),
            noteCheck: (id, print, text) => life.noteCheck(id, print, text),
            noteCheckFail: (id) => life.noteCheckFail(id),
            wake: (routine, note) => runRoutine(routine, 0, note),
            log: (entry) => journal.write('quick-check', entry),
          })
        : runRoutine(r)
    ).catch((e: Error) => life.noteRun(r.id, m().scheduledFail(e.message)))
  const lifeTimer = setInterval(() => life.tick(), 30_000)
  lifeTimer.unref?.()

  /**
   * Keep connected: twice a day (more than 11 hours since the last, and 8 am to 10 pm Korean time), quietly check that the sign-in of each connected service is still alive.
   * Many places extend the session just by visiting, and when expired, it signs in again with the method used when connecting (quick sign-in or vault account).
   * Only places that need a person's step (KakaoTalk confirmation, identity check) or where the method is unknown are gathered and told once.
   * Measured (2026-11-19): within a few hours of connecting, 9 places expired, and 4 of them signed in again without any human, using the remembered Kakao
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
      // Quick sign-in accounts (Kakao, Naver, Google) first: they must be alive for other places to sign in again with just a button
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
        // Even if the method was not kept, if the vault has that service's account, sign in again with the vault
        // (measured 11-21: when the session of Shinhan Card, signed in through the vault while Doori worked, expired, the connected mark went off)
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
        // Even if it says signed in again, check once more (it has said 'ok' by guessing before)
        if (ok) ok = (await checkSignedIn(browser, card).catch(() => undefined))?.state === 'in'
        if (ok) result.relogged.push(card.name)
        else if (provider || creds) result.need.push(card.name)
        else {
          connectMark(card.id, false)
          result.need.push(card.name)
        }
      }
      journal.write('connect-keep', { checked: result.checked, relogged: result.relogged, need: result.need })
      // Tell only about places where the way to sign in again is unknown (if a way exists, Doori signs in again on its own when needed)
      const unknownWay = result.need.filter((n) => {
        const c = services.find((x) => x.card.name === n)?.card
        return c ? !connectVia()[c.id] : true
      })
      if (unknownWay.length)
        void link
          .notify({
            title: m().loginLostTitle(unknownWay.length),
            body: m().loginLostBody(unknownWay.slice(0, 4).join('·'), unknownWay.length > 4),
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
  // When it changes, send it again to the phone and PC (gathered for a moment)
  let lifePush: ReturnType<typeof setTimeout> | undefined
  life.onChange = () => {
    clearTimeout(lifePush)
    lifePush = setTimeout(() => {
      void link.broadcast({ kind: 'life', state: life.state({ logs: 8 }) })
      live.emit('event', { kind: 'life' })
    }, 300)
  }

  /** Remote screen: the page size of the last screen sent (to turn the ratio tapped on the phone into coordinates) */
  const remoteViewport = new Map<number, { width: number; height: number }>()
  /**
   * Chat list + info for the home screen: whether it is answering, a preview of the last answer (only the first few), approvals waiting.
   * The PC app and phone get the same
   */
  /** Open a new separate chat: reuse an empty chat if there is one, and ask to delete one when there are SIDE_THREAD_MAX */
  async function openSide(agent?: AgentId) {
    const feed = store.getSetting('feedThread')
    const t = store.openSideThread(
      agent ?? (await pickAgent(undefined)),
      SIDE_THREAD_MAX,
      typeof feed === 'string' ? feed : undefined,
    )
    if (!t) throw new Error(m().sideThreadMax(SIDE_THREAD_MAX))
    return t
  }
  function threadSummaries(limit = 50, previews = 6): ThreadSummary[] {
    const waiting = new Map<string, ApprovalView>()
    for (const ap of browserTools.approvals.list()) {
      const t = ap.status === 'pending' ? approvalThread.get(ap.id) : undefined
      if (t) waiting.set(t, ap)
    }
    // Attach the separate chats on their own so they are not pushed out of the list even when the main chat has many segments
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
        // Also find this chat's approvals through approval records (tool messages) (when several chats were answering)
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
  /** Pay-as-you-go accounts to show on screen. The key shows only the last 4 digits */
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

  /** Reads the saved settings. Broken values or old entries are filled in with defaults */
  function readSettings(): Settings {
    const parsed = SettingsSchema.partial().safeParse(store.getSettings())
    return { ...DEFAULT_SETTINGS, ...(parsed.success ? parsed.data : {}) }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      // Input validation failure is 400, the rest 500
      const bad = err.name === 'ZodError' || err instanceof SyntaxError
      if (!res.headersSent) json(res, bad ? 400 : 500, { error: bad ? m().badRequest : err.message })
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]
    const [, a, b, c, d] = parts

    // Address only for the Doori tool server: can be called only with the tool token
    if (parts[0] === 'api' && a === 'tools') {
      if (!authorized(req, toolToken)) return json(res, 401, { error: m().needAuth })
      // Loop guard: the same call with the same result again gets a "take another route" line (the call still runs)
      if (req.method === 'POST' && b && c && !d) {
        const tool = `${b}/${c}`
        const input = await readJson(req)
        const guard = (body: unknown) => {
          const { result, count } = loopGuard.check(tool, input, body)
          if (count) journal.write('loop-guard', { tool, count })
          return result
        }
        // Replay test: answer from the tape, run nothing
        if (toolTape.current === 'replay') {
          resultHooks.set(res, guard)
          return json(res, 200, toolTape.replay(tool, input))
        }
        // Record test: keep the answer the AI gets and the approval requests this call created
        const seen =
          toolTape.current === 'record' ? new Set(browserTools.approvals.list().map((x) => x.id)) : undefined
        resultHooks.set(res, (body) => {
          const result = guard(body)
          if (seen) {
            const approvals = browserTools.approvals
              .list()
              .filter((x) => !seen.has(x.id))
              .map(({ label, what, amount, kind }) => ({ label, what, amount, kind }))
            toolTape.record({ tool, input, result, approvals })
          }
          return result
        })
      }
      // Requests this call creates that auto-approve takes are approved before the AI gets the answer (ADR 0030)
      const pendingBefore = autoApprover.before()
      const reply = async (r: ToolResult) => json(res, 200, await autoApprover.after(pendingBefore, r))
      if (req.method === 'POST' && b === 'browser' && c && !d) {
        const args = (await readJson(req)) as Record<string, unknown>
        return reply(await browserTools.run(c, args && typeof args === 'object' ? args : {}))
      }
      if (req.method === 'POST' && b === 'screen' && c && !d) {
        const args = (await readJson(req)) as Record<string, unknown>
        return reply(
          await screenTools
            .run(c, args && typeof args === 'object' ? args : {})
            .catch(
              (e: Error): ToolResult => ({ isError: true, content: [{ type: 'text', text: e.message }] }),
            ),
        )
      }
      // PC file tools (ADR 0022·0024): find and read in Desktop, Documents and Downloads, create new files, move, change photos, print
      if (req.method === 'POST' && b === 'file' && c && !d) {
        const args = (await readJson(req)) as Record<string, unknown>
        const r = await fileTools.run(c, args && typeof args === 'object' ? args : {})
        journal.write('file-tool', {
          tool: c,
          ok: !r.isError,
          path: typeof args?.path === 'string' ? args.path : args?.name,
          ...(Array.isArray(args?.moves) ? { count: args.moves.length } : {}),
          ...(Array.isArray(args?.paths) ? { count: args.paths.length } : {}),
          // Reason for failure (no file content or paths kept, only the first line of the guidance returned to Doori)
          ...(r.isError
            ? {
                why: (r.content.find((x) => x.type === 'text') as { text?: string } | undefined)?.text?.slice(
                  0,
                  160,
                ),
              }
            : {}),
        })
        return reply(r)
      }
      if (req.method === 'POST' && b === 'life' && c === 'phone_sms' && !d) {
        const args = (await readJson(req)) as Record<string, unknown>
        const r = phoneSms.request(args && typeof args === 'object' ? args : {})
        journal.write('phone-sms-ask', { ok: !r.isError })
        return reply(r)
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
            `There is no connect card for "${q}". If the site is not on the list, open it with browser_open, and use browser_request_login if it needs a sign-in.`,
            true,
          )
        if (card.how === 'device')
          return text(
            `${card.name} is a phone permission. Tell the user to turn it on from the Connect screen on the phone.`,
          )
        if (connecting.has(card.id))
          return text(`Signing in to ${card.name} right now. A note will arrive in the chat when it is done.`)
        // If the same account (Naver mail → Naver) is connected, do not show a card
        const parent = card.sameLoginAs ? items.find((x) => x.card.id === card.sameLoginAs) : undefined
        if (parent?.connectedAt)
          return text(
            `${card.name} signs in with the ${parent.card.name} account. ${parent.card.name} is already connected, so use the ${card.name} tools right away without a connect card. If a tool meets a sign-in screen, reconnect then with connect_ask('${parent.card.id}').`,
          )
        // When a sign-in is needed again but there is a vault account or a quick sign-in used before, Doori signs in again without asking.
        // When it ends, connectDone sends "continue the stopped task" to the chat
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
            ? 'the account in the vault'
            : `the ${SOCIAL_PROVIDERS[provider as SocialProvider].label} quick sign-in used before`
          return text(
            `Doori is signing in to ${card.name} again with ${how}. When it finishes, a chat note will tell you to continue. Tell the user in one sentence, like "I am signing in to ${card.name} again and will continue", and end your reply.`,
          )
        }
        // If the service was just connected (within 10 minutes), do not show a card again (measured: the connection had just finished and the AI that took over showed the card again)
        const at = items.find((x) => x.card.id === card.id)?.connectedAt
        if (at && Date.now() - Date.parse(at) < 10 * 60_000)
          return text(
            `${card.name} was just connected, so no connect card was shown. Continue the task (open the page again or read it again to see the signed-in screen).`,
          )
        // If it is remembered as connected but there is no way to sign in again: clear the connected mark so a real connect card shows on the phone
        // (if not cleared, the phone showed only a "connected" line and it looked like no card appeared)
        if (at && !creds && !provider) {
          journal.write('connect-ask', { id: card.id, expired: true })
          connectMark(card.id, false)
        }
        connectAsked.set(card.id, Date.now())
        void link
          .notify({
            title: m().connectCardTitle(card.name),
            body: m().connectCardBody,
            tag: `connect-ask-${card.id}`,
            url: '#tab=chat',
          })
          .catch(() => {})
        return text(
          card.how === 'browser'
            ? `A ${card.name} connect card is now in the chat. When the user enters the ID and password on the card, Doori signs in and the result arrives as a chat note. Do not ask for the password: explain in one sentence, then wait.`
            : `A ${card.name} connect card is now in the chat. Tapping the card opens the Connect screen. Explain in one sentence, then wait.`,
        )
      }
      // View my info: masked values only (name H*D, birth date 1990-**-**). The AI sees it before asking about the target conditions
      if (req.method === 'POST' && b === 'life' && c === 'profile_view' && !d) {
        const { have, missing } = await profile.masked()
        const lines = Object.entries(have).map(
          ([k, v]) => `- ${PROFILE_FIELDS[k as keyof typeof PROFILE_FIELDS].label}: ${v}`,
        )
        const text = [
          lines.length ? `My info (masked values):\n${lines.join('\n')}` : 'My info is still empty.',
          missing.length
            ? `Missing: ${missing.map((k) => PROFILE_FIELDS[k].label).join('·')} — if really needed, get them with browser_request_profile (do not ask in the chat).`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
        return json(res, 200, { content: [{ type: 'text', text }] })
      }
      // View my payment methods (ADR 0023): masked values only, such as card company, nickname and last 4 digits. Changing is done by a person in the phone settings
      if (req.method === 'POST' && b === 'life' && c === 'pay_method_list' && !d) {
        return json(res, 200, { content: [{ type: 'text', text: payMethodsText(loadPayMethods(store)) }] })
      }
      // View the vault (ADR 0011): only which sites have a sign-in. Passwords are left out (vault.list) and IDs are masked
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
      // Find past chats: the AI looks again at earlier segments left out of the summary (ADR 0015)
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
          if (!data) throw new Error(m().photoMissing)
          return json(res, 200, {
            content: [
              { type: 'image', data, mimeType: 'image/jpeg' },
              {
                type: 'text',
                text: 'This is a photo the user sent from the phone. Answer based on what you see.',
              },
            ],
          })
        } catch (e) {
          return json(res, 200, { isError: true, content: [{ type: 'text', text: (e as Error).message }] })
        }
      }
      if (req.method === 'POST' && b === 'life' && c && !d) {
        const raw = (await readJson(req)) as Record<string, unknown>
        const { _check: _ignored, ...args } = raw && typeof raw === 'object' ? raw : {}
        // Quick check of a watch (ADR 0031): the daemon checks the service tool and attaches it as _check
        if (
          (c === 'goal_create' || c === 'goal_update') &&
          typeof args.check_tool === 'string' &&
          args.check_tool
        ) {
          const tool = args.check_tool.slice(0, 120)
          const can = await connectors.checkable(tool)
          if (!can.ok) return json(res, 200, { isError: true, content: [{ type: 'text', text: can.why }] })
          const input =
            args.check_input && typeof args.check_input === 'object'
              ? (args.check_input as Record<string, unknown>)
              : {}
          args._check = {
            tool,
            input,
            minMinutes: can.minMinutes,
            note: `Quick check: every set time the daemon runs ${tool} ("${can.title}") with this input without you, and wakes you only when the result changes (the first result is the baseline).${can.minMinutes > 1 ? ` This service allows checking every ${can.minMinutes} minutes at most, so the interval is at least that.` : ''}`,
          }
        }
        return json(res, 200, life.run(c, args))
      }
      // Service tools: catalog (tools shown right away), find (find a service), call (run)
      if (req.method === 'POST' && b === 'service' && c && !d) {
        const args = ((await readJson(req)) ?? {}) as Record<string, unknown>
        if (c === 'catalog')
          return json(res, 200, { tools: await connectors.catalogFor(String(args.toolset ?? '')) })
        if (c === 'find') return json(res, 200, await connectors.find(String(args.query ?? '').slice(0, 100)))
        if (c === 'orders_all') return json(res, 200, await connectors.ordersAll())
        // Test PC only: runs a tool definition not yet installed once in the user's Chrome (pnpm connector try --pc)
        if (c === 'try') {
          if (!devReset) return json(res, 403, { error: m().testPcOnly })
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
        return json(res, 404, { error: m().noRoute })
      }
      return json(res, 404, { error: m().noRoute })
    }

    if (!authorized(req, token)) return json(res, 401, { error: m().needAuth })
    if (parts[0] !== 'api') return json(res, 404, { error: m().noRoute })

    if (req.method === 'GET' && a === 'health') return json(res, 200, { ok: true, dataDir: paths.dataDir })

    // Reset data from the PC settings (screen token only). The phone sends a signed request over the link instead
    if (req.method === 'POST' && a === 'reset' && !b) {
      const body = (await readJson(req)) as { services?: unknown }
      return json(res, 200, await resetAll('pc', { services: body.services === true }))
    }

    // Scenario tests (evals layer 2), test PC only: { mode: 'record' | 'replay' | 'off', entries? }. 'off' returns the report
    if (req.method === 'POST' && a === 'eval' && b === 'tape' && !c) {
      if (!devReset) return json(res, 403, { error: m().testPcOnly })
      const body = (await readJson(req, 200_000_000)) as { mode?: unknown; entries?: unknown }
      if (body.mode === 'off') return json(res, 200, toolTape.stop())
      if (body.mode !== 'record' && body.mode !== 'replay') return json(res, 400, { error: m().badRequest })
      toolTape.start(body.mode, Array.isArray(body.entries) ? (body.entries as TapeEntry[]) : [])
      return json(res, 200, { ok: true, mode: body.mode })
    }

    // PC screen control (M4): permissions and allowed apps. The user turns on the permission in Mac settings ([Turn on permission] only opens a system window)
    if (a === 'screen' && !c) {
      const allowed = readSettings().allowedApps ?? []
      if (!hands.available()) return json(res, 200, { screen: { available: false, allowed } })
      const read = async () => {
        const helper = (await hands.call('status').catch(() => ({}))) as Partial<ScreenControlStatus>
        const app = opts.appPermissions?.status()
        return {
          available: true,
          ...helper,
          // The app permission is on but the helper is off: the helper did not inherit the permission (for diagnosis)
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

    // Usage stats: show the numbers to be sent as they are (the consent screen and "what is sent" in settings)
    if (a === 'stats' && b === 'preview' && req.method === 'GET')
      return json(res, 200, { stats: await stats.build(localDay(new Date())) })

    // Problem report (report.ts): view what will be sent (preview) → send. Only the set fields of the record, without chat and file names
    if (a === 'report' && req.method === 'POST' && (!b || b === 'preview')) {
      const body = (await readJson(req).catch(() => ({}))) as {
        text?: unknown
        contact?: unknown
        includeLogs?: unknown
      }
      const text = typeof body.text === 'string' ? body.text : ''
      if (!b && !text.trim()) return json(res, 400, { error: m().writeWhatHappened })
      const payload = buildReport(
        {
          text,
          ...(typeof body.contact === 'string' ? { contact: body.contact } : {}),
          includeLogs: body.includeLogs !== false,
        },
        {
          version: opts.appVersion ?? 'dev',
          agents: await detectAll().catch(() => []),
          extension: browser.status as { connected?: boolean; version?: string },
          entries: journal.read({ days: 2, limit: 2_000 }),
        },
      )
      if (b === 'preview') return json(res, 200, { payload })
      const sent = await sendReport(payload, fetch, undefined, userLang(readSettings()))
      journal.write('report', { ok: sent.ok, ...(sent.id ? { id: sent.id } : {}), logs: payload.logs.length })
      return json(res, sent.ok ? 200 : 502, sent)
    }

    if (req.method === 'GET' && a === 'agents' && !b) {
      const list = await detectAll()
      return json(res, 200, { agents: list })
    }

    // Codex: downloaded from the official npm registry on first use and verified with a pinned SHA-512 (download.ts)
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

    // Pay-as-you-go mode: install OpenCode, provider, model and API key (ADR 0010)
    if (a === 'agents' && b === 'opencode') {
      if (c === 'catalog' && req.method === 'GET') return json(res, 200, { providers: PAYG_PROVIDERS })
      if (c === 'account' && !d) {
        if (req.method === 'GET') return json(res, 200, { account: await paygView() })
        if (req.method === 'PUT') {
          const body = PaygAccountRequestSchema.parse(await readJson(req))
          const provider = PAYG_PROVIDERS.find((p) => p.id === body.provider)
          if (!provider) return json(res, 400, { error: m().unsupportedProvider })
          if (!body.apiKey && !(await secrets.get(PAYG_KEY))) return json(res, 400, { error: m().needApiKey })
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

    // Browser: Chrome check and install (ADR 0006)
    if (a === 'browser' && !b && req.method === 'GET')
      return json(res, 200, { chrome: await chrome.detect(), extension: browser.status })
    // The screen asks often (lighter than the Chrome check)
    if (a === 'browser' && b === 'extension' && !c && req.method === 'GET')
      return json(res, 200, { extension: browser.status })
    // Restart the extension with new code (after rebuilding the extension. When it reconnects, the new code runs)
    if (a === 'browser' && b === 'extension' && c === 'reload' && req.method === 'POST') {
      const ok = await browser.call('reload', {}, 5_000).then(
        () => true,
        () => false,
      )
      return json(res, 200, { ok })
    }
    // Bring a Doori tab handed to a person to the front (the screen's [View in Chrome])
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
        if (!chromeInstall) return json(res, 409, { error: m().cannotInstallChrome })
        return json(res, 200, { install: chromeInstall.start() })
      }
      if (req.method === 'DELETE') {
        chromeInstall?.cancel()
        opencodeInstall?.cancel()
        return json(res, 200, { install: { state: 'idle' } })
      }
    }

    // Install Claude Code: download from the official distribution server, verify the checksum and finish with the official `claude install` (install.ts)
    if (a === 'agents' && b === 'claude' && c === 'install' && !d) {
      const rt = runtimes.claude as
        | (AgentRuntime & { createInstall?: (dir: string) => ClaudeInstall })
        | undefined
      if (req.method === 'GET') return json(res, 200, { install: claudeInstall?.status ?? { state: 'idle' } })
      if (req.method === 'POST') {
        claudeInstall ??= rt?.createInstall?.(join(paths.dataDir, 'downloads'))
        if (!claudeInstall) return json(res, 409, { error: m().cannotInstallClaude })
        return json(res, 200, { install: claudeInstall.start() })
      }
      if (req.method === 'DELETE') {
        claudeInstall?.cancel()
        chromeInstall?.cancel()
        return json(res, 200, { install: { state: 'idle' } })
      }
    }

    // Claude sign-in: start the official `claude auth login` and follow it (login.ts)
    if (a === 'agents' && b === 'claude' && c === 'login') {
      const send = (login: ClaudeLoginStatus) => json(res, 200, { login })
      if (req.method === 'GET' && !d) return send(claudeLogin?.status ?? { state: 'idle' })
      if (req.method === 'POST' && !d) {
        claudeLogin ??= await createClaudeLogin()
        if (!claudeLogin) return json(res, 409, { error: m().installClaudeFirst })
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
      return json(res, 404, { error: m().noLoginForAgent })
    }

    // Approval gate (M3): approvals can only be made with the screen's token. The AI's tool token cannot reach this address
    // Sign-in card (PC): the entered value goes only to the vault. The PC screen tells the AI directly after saving
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
        if (!rec) return json(res, 404, { error: m().approvalNotFound })
        return json(res, 200, { approval: rec })
      }
      if (b && !c && req.method === 'POST') {
        const { decision, choice } = ApprovalDecisionSchema.parse(await readJson(req))
        if (decision === 'reject')
          return json(res, 200, { ok: browserTools.approvals.reject(b), message: m().rejected })
        return json(res, 200, await approveAny(b, choice))
      }
    }

    // Phone link (M6): only with the screen's token. A new phone attaches only after the PC screen shows a verification code and [Connect] is tapped
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

    // Work log (journal.ts): the connections, tools and answers of the last few days and pictures of stopped screens. Read only on this PC
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
        if (!existsSync(file)) return json(res, 404, { error: m().noSuchPicture })
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
        return void res.end(readFileSync(file))
      }
    }

    // Service connections (ADR 0014): card list, open in Chrome to sign in, connected marks
    if (a === 'connections') {
      if (!b && req.method === 'GET') return json(res, 200, { services: await skills.connections() })
      // Keep connected once now (when a test or the user taps "check connection again")
      if (b === 'keep' && !c && req.method === 'POST') return json(res, 200, await keepConnections(true))
      const card = b ? await skills.card(b) : undefined
      if (b && !card) return json(res, 404, { error: m().noSuchService })
      if (card && c === 'open' && !d && req.method === 'POST') {
        try {
          return json(res, 200, { tabId: await connectOpen(card, false) })
        } catch (e) {
          const message = (e as Error).message
          return json(res, (e as { code?: string }).code === 'no-extension' ? 409 : 400, { error: message })
        }
      }
      // Check: only looks for the sign-in fields (does not enter or press anything)
      if (card && c === 'probe' && !d && req.method === 'POST') {
        const body = (await readJson(req).catch(() => ({}))) as { url?: unknown }
        const url =
          typeof body.url === 'string' && body.url.startsWith('https://')
            ? body.url
            : (card.loginUrl ?? connectUrl(card))
        if (!url) return json(res, 400, { error: m().noSiteUrl })
        const r = await probeLogin(browser, { card, url }, { lang: lang() })
        for (const t of r.tabs ?? [r.tabId]) await browser.call('close', { tabId: t }).catch(() => undefined)
        return json(res, 200, r)
      }
      // Connect with quick sign-in (Kakao, Naver…)
      if (card && c === 'social' && !d && req.method === 'POST') {
        const body = (await readJson(req)) as {
          provider?: unknown
          background?: unknown
          join?: unknown
          quiet?: unknown
        }
        const provider = SocialProviderSchema.safeParse(body.provider)
        if (!provider.success) return json(res, 400, { error: m().pickSocial })
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
            message: m().socialLoggingIn(card.name),
          })
        return json(res, 200, await p)
      }
      // Connect: ID and password → vault → the daemon signs in on the user's behalf
      if (card && c === 'login' && !d && req.method === 'POST') {
        const body = (await readJson(req)) as { username?: unknown; password?: unknown; background?: unknown }
        try {
          const username = String(body.username ?? '')
          const password = String(body.password ?? '')
          if (!username.trim() || !password) throw new Error(m().needIdPassword)
          const p = startConnect(card, () => connectLogin(card, username, password))
          // In the background: answer right away, and the result comes as a chat note
          if (body.background === true)
            return json(res, 200, {
              ok: false,
              started: true,
              message: m().loggingIn(card.name),
            })
          return json(res, 200, await p)
        } catch (e) {
          return json(res, 400, { error: (e as Error).message })
        }
      }
      // Sign in again with the account in the vault (connection tests, when the sign-in expired). The password does not travel in the request
      if (card && c === 'relogin' && !d && req.method === 'POST') {
        const url = connectUrl(card)
        if (!url) return json(res, 400, { error: m().phoneOnlyService })
        const origins = [url, card.loginUrl].filter(Boolean).map((u) => new URL(u as string).origin)
        let saved: { username: string; password: string } | undefined
        for (const o of origins) saved ??= await vault.findForOrigin(o)
        if (!saved) return json(res, 404, { error: m().noVaultAccount(card.name) })
        const creds = saved
        return json(
          res,
          200,
          await startConnect(card, () => connectLogin(card, creds.username, creds.password), 'relogin'),
        )
      }
      // Connecting from the chat (ADR 0021): leaves my message and a connect card in the main chat. The screen moves over to the chat
      if (card && c === 'chat' && !d && req.method === 'POST') {
        if (card.how === 'open' || card.how === 'device')
          return json(res, 400, { error: m().noNeedToConnect })
        connectInChat(card)
        return json(res, 200, { ok: true })
      }
      // Only check whether signed in now (the mark follows the result: if expired, the connected mark is turned off)
      if (card && c === 'check' && !d && req.method === 'POST') {
        if (!browser.status.connected) return json(res, 409, { error: m().extNotConnectedShort })
        const r = await checkSignedIn(browser, card)
        rememberCheck(card.id, r)
        const was = Boolean(readSettings().connections?.[card.id])
        if (r.state === 'in' && !was) connectMark(card.id, true)
        // Only the session expired (Doori can sign in again with the vault account or quick sign-in): the connection is not broken
        const via = connectVia()[card.id]
        const canRelogin = via?.startsWith('social:') || Boolean(await vaultCreds(card))
        if (r.state === 'out' && was && !canRelogin) connectMark(card.id, false)
        return json(res, 200, { ...r, connectedAt: readSettings().connections?.[card.id] ?? null })
      }
      // Check that it is really signed in and mark it (same path as [I signed in]). Result: the marked time or null
      if (card && c === 'verify' && !d && req.method === 'POST') {
        const ok = await connectVerify(card)
        return json(res, 200, { ok, connectedAt: readSettings().connections?.[card.id] ?? null })
      }
      if (card && !c && (req.method === 'PUT' || req.method === 'DELETE'))
        return json(res, 200, { connectedAt: connectMark(card.id, req.method === 'PUT') ?? null })
    }

    // Goals, library, memories and feed (PC screen)
    if (a === 'thumb' && !b && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://x').searchParams.get('url') ?? ''
      const data = await thumbOrPhoto(url.slice(0, 800))
      return json(res, 200, data ? { data } : {})
    }
    // File links in answers and the library [Open]: opens only files inside the user's folders. Executables are not opened, only shown in the folder
    if (a === 'files' && b === 'open' && !c && req.method === 'POST') {
      const body = (await readJson(req)) as { path?: unknown; reveal?: unknown }
      const real = fileTools.realReadable(String(body?.path ?? '').slice(0, 1000))
      if (!real)
        return json(res, 404, {
          error: m().fileNotFoundOpen,
        })
      if (!opts.openFile) return json(res, 501, { error: m().cannotOpenFileHere })
      const how = body?.reveal === true || EXEC_EXT.test(real) ? 'reveal' : 'open'
      const err = await opts.openFile(real, how).catch((e: Error) => e.message)
      return err ? json(res, 500, { error: err }) : json(res, 200, { ok: true, how })
    }
    if (a === 'life' && !b && req.method === 'GET') return json(res, 200, life.state())
    // Receiving long lists in pieces: feed (activity when kinds=done,routine), library (tab=made|files). before is the previous page's next
    if (a === 'life' && b === 'feed' && !c && req.method === 'GET')
      return json(res, 200, life.feedPage(pageQuery(url)))
    if (a === 'life' && b === 'library' && !c && req.method === 'GET')
      return json(res, 200, life.libraryPage(pageQuery(url)))
    if (a === 'life' && b === 'library' && c && !d && req.method === 'GET') {
      const item = life.libraryItem(c)
      return item ? json(res, 200, { item }) : json(res, 404, { error: m().notInLibrary })
    }
    if (a === 'life' && b === 'action' && req.method === 'POST') {
      const action = (await readJson(req)) as LifeAction
      const id = life.act(action)
      if (action.action === 'identity') conversation.rotateSoon(IDENTITY_CHANGED_NOTE)
      return json(res, 200, { ok: true, ...(id ? { id } : {}), state: life.state() })
    }

    // Doori vault: only with the screen's token. Passwords never go to the AI, and the user only sees and edits on the screen (ADR 0011·0026)
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
      // View and edit on the PC screen (only with the screen's token, ADR 0026)
      if (b && c === 'reveal' && req.method === 'POST') {
        const r = await vault.reveal(b)
        if (!r) return json(res, 404, { error: m().noSuchEntry })
        journal.write('vault-reveal', { origin: r.origin, from: 'pc' })
        return json(res, 200, r)
      }
      if (b && !c && req.method === 'PUT') {
        const body = (await readJson(req)) as { username?: unknown; password?: unknown }
        const r = await vault.update(b, {
          ...(typeof body?.username === 'string' ? { username: body.username } : {}),
          ...(typeof body?.password === 'string' ? { password: body.password } : {}),
        })
        if (!r) return json(res, 404, { error: m().noSuchEntry })
        journal.write('vault-update', { origin: r.origin, from: 'pc' })
        return json(res, 200, { entry: r })
      }
    }

    // My info (booker and orderer fields): the screen only gets masked values. When editing, only the fields entered change (empty value = delete)
    const payChoices = () => (store.getSetting('payChoices') as Record<string, string> | undefined) ?? {}
    // Forget the payment method remembered per site (PC settings screen)
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
    // Answer info requests (verification code, my info card) on the PC screen (the phone answers through the link)
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

    // One conversation (ADR 0015)
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
      stopConversation()
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
        if (body.agent && !runtimes[body.agent]) return json(res, 400, { error: m().unsupportedAgent })
        if (body.side) {
          try {
            return json(res, 201, { thread: await openSide(body.agent) })
          } catch (e) {
            return json(res, 409, { error: (e as Error).message })
          }
        }
        const agent = body.agent ?? (await pickAgent(undefined))
        return json(res, 201, { thread: store.createThread(agent, m().newThreadTitle) })
      }
    }

    if (a === 'threads' && b) {
      const thread = store.getThread(b)
      if (!thread) return json(res, 404, { error: m().noThread })
      if (req.method === 'GET' && !c) return json(res, 200, { thread, messages: store.listMessages(b) })
      // Only separate chats can be deleted (segments of the main chat are not deleted)
      if (req.method === 'DELETE' && !c) {
        if (!thread.side) return json(res, 400, { error: m().mainThreadKeep })
        if (threads.isRunning(b)) return json(res, 409, { error: m().threadStillAnswering })
        store.deleteThread(b)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && c === 'cancel') {
        stopThread(b)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && c === 'messages') {
        const body = SendMessageRequestSchema.parse(await readJson(req, MESSAGE_MAX))
        if (threads.isRunning(b)) return json(res, 409, { error: m().threadStillAnswering })
        // Photo: kept in Doori's work folder like chat and phone, and viewed with photo_view (before, photos were missing from separate chats)
        const text = body.image ? `${body.text}\n\n${await savePhoto(body.image)}` : body.text
        return stream(res, tracked(b, threads.send(b, text)), () => threads.cancel(b))
      }
    }

    return json(res, 404, { error: m().noRoute })
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    // Receives only inside this PC
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })

  // Now that the address is known, tell the tool server (ThreadService uses the same object)
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
    // Close only once even if called many times
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        claudeLogin?.cancel()
        journal.stop()
        clearInterval(lifeTimer)
        clearInterval(keepTimer)
        clearTimeout(lifePush)
        clearTimeout(thumbFill)
        loginWatch.stopAll()
        link.stop()
        server.closeAllConnections()
        server.close(() => {
          store.close()
          stats.stop()
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

/** Fields of the paging address: ?before=<cursor>&limit=30&kinds=done,routine&tab=made */
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

/** Changes a 200 answer right before it is sent (the loop guard adds its line to tool results) */
const resultHooks = new WeakMap<ServerResponse, (body: unknown) => unknown>()

function json(res: ServerResponse, status: number, body: unknown) {
  const hook = status === 200 ? resultHooks.get(res) : undefined
  if (hook) {
    resultHooks.delete(res)
    body = hook(body)
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Messages (with photos) are accepted up to the photo size: the image in SendMessageRequestSchema is up to 2,000,000 characters */
const MESSAGE_MAX = 2_100_000

/** Request bodies already read, so a body can be read twice (the loop guard reads it before the route does) */
const bodies = new WeakMap<IncomingMessage, string>()

async function readJson(req: IncomingMessage, max = 100_000): Promise<unknown> {
  let raw = bodies.get(req)
  if (raw === undefined) {
    raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > max) throw new Error('Request too large')
    }
    bodies.set(req, raw)
  } else if (raw.length > max) throw new Error('Request too large')
  return raw ? JSON.parse(raw) : {}
}

/** Streams one turn's progress with server-sent events (SSE) */
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
