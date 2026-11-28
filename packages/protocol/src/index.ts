// Shared Dool2 types: agent events, conversations, the daemon API.
// The phone <-> PC encryption protocol was added to this package in M2.
import { LANGS, type Lang, REGIONS } from '@dool2/i18n'
import { z } from 'zod'
import type { ConnectionItem, SocialProvider } from './connect.js'
import { type DooriLook, DooriLookSchema } from './doori-look.js'
import type { PayMethod, PayMethodInput } from './pay-methods.js'

/** The AIs Dool2 can run. They run on the user's subscription. */
/** claude and codex: subscription, opencode: pay-as-you-go API key (ADR 0010) */
export const AgentIdSchema = z.enum(['claude', 'codex', 'opencode'])
export type AgentId = z.infer<typeof AgentIdSchema>

export const AGENT_LABEL: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'API 키 (종량제)',
}

/** The name of an AI in the given language (Korean is the reference copy) */
export function agentLabel(id: AgentId, lang: Lang = 'ko'): string {
  return id === 'opencode' ? (lang === 'en' ? 'API key (pay-as-you-go)' : 'API 키 (종량제)') : AGENT_LABEL[id]
}

/** Install and sign-in state. Used by the first-run wizard and the diagnostics screen. */
export interface AgentStatus {
  id: AgentId
  installed: boolean
  version?: string
  /** Where the executable is */
  path?: string
  loggedIn: boolean
  /** Subscription type (e.g. max, pro, plus) */
  plan?: string
  /** A description of the problem to show the user. None means all is well */
  problem?: string
  /** Pay as you go: what this month's answers cost, in US dollars (month in Korean time, YYYY-MM) */
  spent?: { month: string; usd: number }
}

/** One usage limit slot (e.g. a 5-hour window, a 7-day window) */
export interface UsageLimit {
  kind: string
  /** 0~100 */
  percent: number
  resetsAt?: string
}

/** Events during one agent turn. The Claude and Codex adapters convert to this shape. */
export type AgentEvent =
  | { type: 'started'; resumeId?: string; model?: string; tools: string[] }
  | { type: 'text'; delta: string }
  /** title: the human-readable title of a service tool (added by the engine, for the working indicator) */
  | { type: 'tool'; name: string; input: unknown; title?: string; detail?: StepDetail[] }
  /** chars: how many characters of text the result gave the AI (sizes only, for the work log). Missing when unknown */
  | { type: 'tool_result'; name?: string; ok: boolean; chars?: number }
  | { type: 'usage'; limits: UsageLimit[] }
  /** Pay-as-you-go: money (USD) and tokens used in this step */
  | { type: 'cost'; usd: number; inputTokens: number; outputTokens: number }
  /**
   * How much the AI session actually reads now (tokens). Based on the last AI call of the turn, once per turn (ADR 0015).
   * It includes tool results like browser pages, so it is used to decide when to switch segments. It is not shown on screen
   */
  /**
   * Size of the session (the last AI call's input). first*: the turn's first AI call, input and the part read from
   * the provider's cache (to see whether pinned instructions keep the cache, ADR 0032)
   */
  | { type: 'context'; tokens: number; firstInput?: number; firstCached?: number }
  | { type: 'limit_reached'; resetsAt?: string; message: string }
  | { type: 'error'; code: AgentErrorCode; message: string }
  | { type: 'done'; resumeId?: string; text: string }

export type AgentErrorCode =
  | 'not_installed'
  | 'not_logged_in'
  | 'rate_limited'
  | 'tools_unsafe'
  | 'process_failed'
  | 'aborted'
  | 'unknown'

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

export interface ThreadSummary {
  id: string
  agent: AgentId
  title: string
  createdAt: string
  updatedAt: string
  /** Answering now (the spinning circle in the home card for entrusted work and in the left list) */
  busy?: boolean
  /** The beginning of the last Dool2 answer (text without markdown symbols) */
  preview?: string
  /** A request in this conversation waiting for approval */
  approval?: { id: string; what: string; amount?: string; label: string }
  /** A separate conversation (not the main conversation) */
  side?: boolean
  /** A task session's own chat (ADR 0038): its detail, not listed with the separate conversations */
  task?: boolean
}

/** For previews: strips markdown symbols and shortens to one line */
export function previewText(text: string, max = 140): string {
  const flat = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*(?:[-*•]|\d{1,3}[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Characters of text in a tool result as the AI gets it: a plain string, or the text parts of a content list
 * (images and other parts are not counted). undefined when the shape is unknown
 */
export function resultChars(content: unknown): number | undefined {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return undefined
  let n = 0
  for (const part of content)
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string')
      n += (part as { text: string }).text.length
  return n
}

export interface StoredMessage {
  id: string
  threadId: string
  role: MessageRole
  text: string
  createdAt: string
}

// ── Daemon local API (PC app window <-> dool2d) ──────────────────────────

export const CreateThreadRequestSchema = z.object({
  /** If missing, the default AI in settings (among those that are ready) */
  agent: AgentIdSchema.optional(),
  /** A separate conversation (not mixed into the main conversation) */
  side: z.boolean().optional(),
})
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>

/** A separate conversation is allowed up to this many (conversations that write feed posts are not counted). Beyond it, the user is asked to delete unused ones */
export const SIDE_THREAD_MAX = 50
/** How many separate conversations the menu shows at first. The rest expand with "Show more" */
export const SIDE_THREAD_PEEK = 8

export const SendMessageRequestSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** Photo (JPEG base64) */
  image: z.string().max(2_000_000).optional(),
})
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>

/**
 * Switch the AI Dool2 runs on (PUT /api/agents/default, the phone's use-agent, the ai_use tool). Only a connected one is
 * taken; the conversation's next turn runs on it
 */
export const UseAgentRequestSchema = z.object({ agent: AgentIdSchema })
export type UseAgentRequest = z.infer<typeof UseAgentRequestSchema>

// ── Settings (stored only on this PC) ──────────────────────────────────────

/** The AI subscription chosen on first run. 'unsure' if not sure */
export const AiChoiceSchema = z.enum(['claude', 'codex', 'both', 'unsure', 'payg'])
export type AiChoice = z.infer<typeof AiChoiceSchema>

export const SettingsSchema = z.object({
  /** Whether the first-run wizard was finished */
  setupDone: z.boolean(),
  aiChoice: AiChoiceSchema.optional(),
  /** The AI to choose when starting a new conversation */
  defaultAgent: AgentIdSchema.optional(),
  /** Keep the PC awake: only while working / always / never (docs/architecture.md 7.1) */
  keepAwake: z.enum(['working', 'always', 'off']).optional(),
  /** Start Dool2 automatically when the PC starts */
  launchAtLogin: z.boolean().optional(),
  /**
   * The last button, like paying or sending: approve = Dool2 presses it once approved / self = the user always presses it themselves
   * (the "final confirmation" switch from the ADR 0006 review)
   */
  finalStep: z.enum(['approve', 'self']).optional(),
  /** The name of this PC shown on the phone. If empty, the computer name */
  pcName: z.string().trim().min(1).max(40).optional(),
  /** The relay server address to use for phone connection (M6). If empty, the default address */
  relay: z.string().url().max(200).optional(),
  /** The provider and model chosen in pay-as-you-go mode (the API key is not kept here but in the OS keychain) */
  payg: z.object({ provider: z.string(), model: z.string() }).optional(),
  /** Apps allowed to be handled by PC screen control (macOS bundle ids) */
  allowedApps: z
    .array(
      z
        .string()
        .regex(/^[\w.-]+$/)
        .max(200),
    )
    .max(100)
    .optional(),
  /**
   * Auto-approve: everything except payments runs without an approval card (ADR 0030). On by default since
   * 2026-11-26 (a card for every step was the most tiring part of using Dool2); turning it off is kept.
   * Turned on from the PC settings or the phone (phone changes are signed, see autoApproveSignText)
   */
  autoApprove: z.boolean().optional(),
  /** How the user dressed Doori (colour, body, eyes, hat…); drawn the same on the phone and PC (doori-look.ts) */
  dooriLook: DooriLookSchema.optional(),
  /**
   * Keep the AI program running between messages of the conversation (ADR 0035). Empty: on. False: start it for every
   * message, as before (a fallback if the resident session misbehaves)
   */
  residentAgent: z.boolean().optional(),
  /**
   * Remember the steps that got requests done and offer them on the next request like it (ADR 0044). Empty: on.
   * False: nothing is offered (what is kept stays until the person deletes it)
   */
  recipes: z.boolean().optional(),
  /**
   * Hand longer work to task sessions so the conversation keeps talking (ADR 0038). Empty: the default of this build
   * (TASK_SESSIONS_DEFAULT in the daemon). Applies from the next segment of the conversation
   */
  taskSessions: z.boolean().optional(),
  /**
   * Open the user's Chrome by itself when Dool2 needs the browser and Chrome is closed (ADR 0006 follow-up). Empty: on.
   * False: leave Chrome closed and say so
   */
  chromeAutoOpen: z.boolean().optional(),
  /**
   * Use Dool2's own downloaded Chromium (hidden, no extension) for browsing instead of the user's Chrome and the Dool2
   * extension (ADR 0046). Empty/false: the extension path as today. On (or the env DOOL2_BUILTIN_BROWSER=1): the daemon
   * downloads Chromium on first use and drives it over a DevTools pipe. First slice: read-only browsing and capture
   */
  builtInBrowser: z.boolean().optional(),
  /** Send usage stats (numbers only, apps/daemon/src/stats.ts). Empty means not asked yet */
  usageStats: z.boolean().optional(),
  /** Connector packs (ADR 0039): beta takes each pack before everyone (test PCs); off turns automatic packs off */
  packChannel: z.enum(['beta', 'off']).optional(),
  /** UI language of the desktop app and the language Dool2 answers in by default (ADR 0029). Empty: follow the device */
  language: z.enum(LANGS).optional(),
  /** Region for services and local features (ADR 0029). Empty: guessed from the device */
  region: z.enum(REGIONS).optional(),
  /** Services finished connecting (id in skills/<id>/connect.json -> time connected) ADR 0014 */
  connections: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/), z.string().max(40)).optional(),
})

/** PC screen control state (settings screen) */
export interface ScreenControlStatus {
  /** Whether it can be used on this PC (whether the helper exists, currently macOS only) */
  available: boolean
  accessibility?: boolean
  screenRecording?: boolean
  locked?: boolean
  allowed: string[]
}
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = { setupDone: false, autoApprove: true }

/** Send only the items to change. Unknown items are rejected */
export const SettingsPatchSchema = SettingsSchema.partial().strict()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

// ── Claude sign-in (runs the official `claude auth login`) ─────────────

export type ClaudeLoginStatus =
  | { state: 'idle' }
  /** url: the sign-in address to open in the browser. codeRejected: the pasted code was wrong */
  | { state: 'waiting'; url?: string; codeRejected?: boolean }
  | { state: 'done' }
  | { state: 'failed'; message: string }

// ── Installing parts (Claude Code, Chrome) ─────────────────────────

export type InstallPhase = 'prepare' | 'download' | 'verify' | 'setup'

export type InstallStatus =
  | { state: 'idle' }
  /** percent: download progress (0-100) */
  | { state: 'running'; phase: InstallPhase; percent?: number }
  | { state: 'done'; version?: string }
  | { state: 'failed'; message: string }

export interface ChromeStatus {
  installed: boolean
  version?: string
  path?: string
}

// ── Pay-as-you-go (API key) ──────────────────────────────────────────────

export interface PaygModel {
  id: string
  label: string
  /** US dollars per million input and output tokens (from OpenRouter's public price list), when known */
  inPerM?: number
  outPerM?: number
  /** Dool2's pick for the provider: cheap and good enough at using tools */
  recommended?: boolean
}

export interface PaygProvider {
  id: string
  label: string
  /** Where to get a key */
  keyUrl: string
  models: PaygModel[]
}

/** A saved pay-as-you-go account. The API key itself is never sent out */
export interface PaygAccount {
  provider: string
  model: string
  hasKey: boolean
  /** Last 4 digits of the key (for checking) */
  keyHint?: string
}

export const PaygAccountRequestSchema = z.object({
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(120),
  /** If empty, only the model is changed */
  apiKey: z.string().trim().min(8).max(500).optional(),
})

export const ClaudeLoginCodeSchema = z.object({
  code: z.string().trim().min(1).max(2_000),
})

/** Events the daemon streams out over SSE */
export type DaemonStreamEvent =
  | { type: 'agent'; event: AgentEvent }
  | { type: 'saved'; message: StoredMessage }
  | { type: 'end' }

// ── One conversation (ADR 0015) ───────────────────────────────────────

/** GET /api/conversation: the conversation history (all segments in time order) */
export interface ConversationState {
  messages: StoredMessage[]
  /** Answering now */
  busy: boolean
  /** The last answer is a draft being checked before it is final (ADR 0027): the screen keeps it in the progress card */
  checking?: boolean
  /** Messages sent while answering, waiting for their turn */
  queued: string[]
  /** There may be earlier messages (load more with before) */
  hasMore: boolean
  /** Tasks handed over in the conversation (ADR 0038): the running ones and the last few finished. Older PCs omit it */
  tasks?: TaskView[]
}

// ── Task sessions (ADR 0038) ──────────────────────────────────────────

/**
 * waiting: in line for the browser. working: in its session. checking: its answer is a draft before the finish check.
 * needs-you: waiting for the person (an approval, a sign-in, a card). done, stopped, failed: ended
 */
export type TaskStatus = 'waiting' | 'working' | 'checking' | 'needs-you' | 'done' | 'stopped' | 'failed'

/** One task as the screens show it: one progress card in the conversation */
export interface TaskView {
  /** Short id the AI uses ("t3") */
  id: string
  title: string
  status: TaskStatus
  /** What it is doing now (the last step), or what it continues with after the finish check sent it back */
  now?: string
  /** The finish check sent it back and it is on another round */
  continuing?: boolean
  /** Steps so far (the last 30), with the same fields as a work record */
  steps: WorkRecordMessage['steps']
  count: number
  /** ISO times */
  createdAt: string
  startedAt?: string
  endedAt?: string
  /** Tasks ahead of it in line for the browser */
  ahead?: number
  /** The draft answer while it is checked (take it as is makes it the result) */
  draft?: string
  /** Notes from the person the task has not read yet */
  notes?: number
  /** The task's own chat (its detail: GET /api/threads/<id>) */
  threadId: string
  /** The last site it worked on */
  host?: string
}

/** The task's card in the conversation, saved when it starts. The screen draws it from the task's current view */
export interface TaskRecordMessage {
  kind: 'task'
  id: string
  title: string
}

/** GET /api/conversation/live: what happens in the conversation (whichever place the turn started from) */
export type ConversationLiveEvent =
  /** side: a turn of a separate conversation (including feed posts). Not put on the main conversation screen */
  | {
      kind: 'turn'
      threadId: string
      side?: boolean
      /** A message or card the core left in the conversation directly (connect card, app notice). Not a turn where Dool2 answers */
      posted?: boolean
      event: DaemonStreamEvent
    }
  | { kind: 'queued'; texts: string[] }
  | { kind: 'busy'; busy: boolean }
  /** A message was received and Dool2 starts on it (sent before the AI is called, so a status shows within a second) */
  | { kind: 'ack' }
  /** The main conversation's last answer is being checked before it is final (ADR 0027), or no longer */
  | { kind: 'checking'; checking: boolean }
  /** Goals, library, memory or feed changed (fetch again with GET /api/life) */
  | { kind: 'life' }
  /** Start over (test PC): the conversation and memory were all erased. The screen fetches everything again from the start */
  | { kind: 'reset' }
  /** Connecting: the service being signed in to has changed */
  | { kind: 'connect'; connecting: string[] }
  /** A task changed (ADR 0038) */
  | { kind: 'task'; task: TaskView }

// ── Browser hands (ADR 0006): the Dool2 core <-> native messaging <-> the Dool2 extension ──────

/** The native messaging host name. Chrome finds the registration file by this name */
export const BROWSER_HOST_NAME = 'com.dool2.host'

/**
 * Development extension id. It comes from the `key` (public key) in apps/extension/manifest.json.
 * When it goes on the web store, the store id is added here (M5).
 */
export const DEV_EXTENSION_ID = 'mgjjgnbhoaalicncjbbcldjffpecocah'

/**
 * The id of the Dool2 extension on the Chrome Web Store. The store decides it on first upload, so it is filled in after uploading.
 * Once filled, the PC app uses "Add from the web store (one click)" and external extension registration. If empty, it shows how to load the extension folder by hand.
 * Edge and Whale use the same extension from the Chrome Web Store too (Edge takes the store address as is for external registration).
 */
export const STORE_EXTENSION_ID: string | undefined = 'ogpbnlgnijmebpeiaceeepemcngiocif'

/**
 * Whether it passed web store review and was published. Only when true does the PC app use [Add to Chrome] and external extension registration
 * (turning it on before publishing would open a store page that does not exist yet). The connection channel allows the store id even before publishing.
 * Submitted 2026-11-17 (auto-published after review passes, unregistered). Publication confirmed 2026-11-23 (store page 0.2.0).
 */
export const STORE_EXTENSION_PUBLISHED = true

/** The Chrome Web Store address that supplies extension updates (used for external extension registration) */
export const CHROME_STORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx'

/** The Dool2 extension page on the web store ([Add to Chrome] once) */
export const storeExtensionPage = (id: string) => `https://chromewebstore.google.com/detail/${id}`

/** The extension version that includes the service tool (connector) engine (extract, find, capture). Below this, service tools are not used */
export const MIN_CONNECTOR_EXTENSION = '0.2.0'
/** The extension version that prints a page to PDF (browser_save_pdf) */
export const PDF_EXTENSION = '0.3.3'
/** The extension version with side-effect-free page scripts and the read-only DevTools list (ADR 0045) */
export const EVAL_EXTENSION = '0.3.4'
/** The newest extension in this repo: an older store copy is asked to update itself (command update, from 0.3.5) */
export const EXTENSION_LATEST = '0.3.7'

export { READ_CDP_METHODS } from './cdp.js'

/** Version comparison like "0.10.1" >= "0.2.0" */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const b = min.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}

export const EXTENSION_IDS = [DEV_EXTENSION_ID, ...(STORE_EXTENSION_ID ? [STORE_EXTENSION_ID] : [])]

/** What the extension can do. It does not judge, it only does what it is told */
export const BrowserCommandSchema = z.enum([
  // Dropdowns (select): read what can be chosen, choose by text (registered card and installments on the payment screen)
  'options',
  'choose',
  'open',
  'navigate',
  'snapshot',
  'click',
  'type',
  'press',
  'scroll',
  'screenshot',
  'back',
  'close',
  'focus',
  'fill',
  'input',
  'form',
  'form-fill',
  // Candidate images around the captcha field (the AI picks)
  'captcha-candidates',
  // Capture only that spot for each marker (picture keypad)
  'element-shots',
  'popup',
  'allow-popups',
  'mark-text',
  'link-navigates',
  /** Connector engine (ADR 0018): list extraction, text search, reading responses the page received */
  'extract',
  'find',
  'capture',
  /** Fetches a card photo, shrinks it and returns a data: address (the browser fetches it: the way the site does not block) */
  'thumb',
  /** Restart the extension with new code (after rebuilding the unpacked extension) */
  'reload',
  /** Choose OK or Cancel in a site's confirm dialog (confirm, prompt) that is showing */
  'dialog',
  /** Only moves the mouse to that spot (menus that open on hover) */
  'hover',
  /** The tab printed as a PDF {tabId} → {data: base64}, the way Chrome prints it (certificates in a viewer) */
  'pdf',
  'eval',
  'cdp',
  'update',
  /**
   * Excludes tabs waiting for a person or approval from tab cleanup (sleeping, closing) for a set time (ms: 0 releases).
   * Only 3 tabs are kept, and a tab waiting for payment approval was closed when another tab opened (measured: Lotte Cinema)
   */
  'hold',
  /**
   * Wait {tabId, ms?(default 3000, at most 10000), until?: 'change'|'time'}: wait until the screen changes (document text or elements, frame navigation,
   * address change, new tab, alert or confirm dialog) and return what changed (what, details). The AI looks at whether it is done
   */
  'wait',
  /**
   * Dool2 tab list {tabId?}: for each tab, the opener, address, title, when it was opened, window kind, whether it is the front tab, recently closed new windows,
   * tabs closed by cleanup, and blocked new windows (popup blocking). The AI finds late payment or sign-in windows itself
   */
  'tabs',
  /**
   * Puts PC files into a page's file field (input type=file) {tabId, ref, paths} (blog photos, videos, document attachments).
   * If ref is a button or label, it finds the attached file field, and if there is none it intercepts the file picker that pops up when pressed and puts them in.
   * If the extension cannot read the file directly (file access off), it returns {needBytes, token}, and the core sends pieces ({token, part})
   * and finishes with ({token, finish}). Whether to do it (approval) is decided by the core
   */
  'upload',
])
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>

/** Core -> extension */
export interface BridgeRequest {
  id: number
  cmd: BrowserCommand
  args: Record<string, unknown>
}

/** Extension -> core: the reply to a request */
export type BridgeReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

/** Extension -> core: a notification */
export type BridgeNotice =
  | { event: 'hello'; version: string; browser?: string }
  | { event: 'tab-closed'; tabId: number }

export interface ExtensionStatus {
  connected: boolean
  version?: string
  browser?: string
}

export const FocusTabSchema = z.object({ tabId: z.number().int() })

/**
 * Work process: for a turn that worked with tools, a 'tool' message is left right before the answer.
 * The screen draws it as a folded card ("Worked on Catchtable · 5 steps · 32 s"), and expanding it shows the steps
 */
/**
 * What one work step did, for the "how it worked" sheet: the address opened, what was pressed, which field was filled
 * (never the value), what a service was asked for, the page read. Made by the daemon from the tool input and the page
 * it knows; short and already masked
 */
export interface StepDetail {
  k: 'url' | 'press' | 'field' | 'query' | 'page'
  v: string
}

export interface WorkRecordMessage {
  kind: 'work'
  /**
   * Step names and the time taken (ms). If many, only the last 30.
   * act: what the tool did ("웹페이지 여는 중"), place: where it worked (toolPlace: site address, "tool:…", "app" or "file").
   * The screen groups steps with the same place into one service line (older records have neither)
   */
  steps: { text: string; ms: number; act?: string; place?: string; detail?: StepDetail[] }[]
  /** Total number of steps (the original number even when steps was cut) */
  count: number
  /** Time the whole turn took (ms) */
  ms: number
  /** If it worked on the web, the last site it opened (www.catchtable.co.kr) */
  host?: string
}

/**
 * The before-finishing check reached its limit (rounds or time) with something left (ADR 0027). Saved below the
 * answer: what is left, and an [Continue] button that sends Dool2 back to it. Only in this case
 */
export interface LeftRecordMessage {
  kind: 'left'
  /** What is left, in the user's words (the judge's why) */
  why: string
  /** What Dool2 would do next */
  next?: string
}

/** One step while connecting. If there is an ask, a person has to provide it before moving on (that request is opened right from the card) */
export interface ConnectStep {
  text: string
  /** Start time (ms) */
  at: number
  /**
   * A step that needs a person before moving on.
   * login, info: opens that request (id) as the phone input screen / confirm: tap approve in the mobile app (id = tab number, for showing the screen)
   */
  ask?: { kind: 'login' | 'info' | 'confirm'; id: string; label: string; detail?: string }
}

/** Handing over to a person: left in the conversation history as a 'tool' message so [Done] still shows after reopening */
export interface HandoffRecord {
  kind: 'handoff'
  tabId?: number
  reason: string
}

// ── Dool2 vault (ADR 0011): sign-in info is in the PC keychain, and Dool2 fills it in, not the AI ──────

/**
 * Sign-in card in the conversation: on a site not in the vault, Dool2 asks for the ID and password.
 * The values the user puts in the card do not pass through the AI and are saved only in the vault
 */
export interface LoginRequestView {
  id: string
  tabId: number
  /** The site address to save in the vault (https://…) */
  origin: string
  /** The site name to show the user */
  site: string
  status: 'pending' | 'saved' | 'cancelled' | 'expired'
  /** The saved ID (the password is never returned anywhere) */
  username?: string
  /** What Dool2 asked for during a service connection (the phone shows the input screen right away) */
  connect?: boolean
  createdAt: string
  expiresAt: string
}

/**
 * Receives what the screen asks during sign-in (verification code, phone number, etc.) on the phone input screen.
 * The value goes only into that field without passing through the AI, and is not saved
 */
export interface InfoRequestView {
  id: string
  /** The site name and address to show a person */
  site: string
  host: string
  /** otp: numeric verification code (SMS autofill) · tel: phone number · text: other text · form: several fields (my info card) · choice: pick one · password: a new password the user chooses (typed twice, to the PC vault only) · tap: a robot check solved by tapping the picture */
  field: 'otp' | 'tel' | 'text' | 'form' | 'choice' | 'secret' | 'password' | 'tap'
  /** For tap (tap the picture to solve): how many places can be tapped. The answer is "x,y;x,y" (0-1000 relative to the picture) */
  maxTaps?: number
  /** For choice: what to choose from (the answer is the chosen text as is) */
  options?: string[]
  /** For form: the fields to receive. The answer is {key: value} JSON on one line */
  fields?: {
    key: string
    label: string
    type: 'text' | 'tel' | 'email' | 'date' | 'choice' | 'secret'
    example?: string
    /** For choice: what to choose from (e.g. a simple-auth app) */
    options?: readonly string[]
    /** Format check (regex text). If it does not match, the phone shows patternHint before saving */
    pattern?: string
    patternHint?: string
  }[]
  /** Format check for a one-field request (otp, secret, etc.) */
  pattern?: string
  patternHint?: string
  /** The field name on screen ("인증번호 6자리", "6-digit code") */
  label: string
  /** One guidance line on screen ("카카오톡으로 보낸 번호를 넣어 주세요", "Enter the number sent by KakaoTalk") */
  hint?: string
  /** Captcha picture (jpeg base64). If present, the card shows the picture and receives its text */
  image?: string
  /** No notification of its own: the caller already sent one (a verification wait) */
  quiet?: boolean
  status: 'pending' | 'answered' | 'cancelled' | 'expired'
  expiresAt: string
}

/** A sign-in request left in the conversation history (the card is drawn by asking the core for its state) */
export interface LoginRecordMessage {
  kind: 'login'
  tabId?: number
  site: string
}

/**
 * A proactive job left in the conversation history (ADR 0019). It has the same content as the feed post (id),
 * and the reply (handed over, passed on) is read from that feed post in the life record and changes together with the feed card
 */
export interface TellRecordMessage {
  kind: 'tell'
  /** Feed post id */
  id: string
  title: string
  body?: string
  from?: string
  ask?: string
  askLabel?: string
}

/** One card attached to an answer (product, stay, restaurant, show, etc.) */
export interface ChatCard {
  title: string
  /** Photo address (https). The screen asks the PC and gets it (the phone does not connect to outside servers directly) */
  image?: string
  /** One price line (e.g. 350,100 won · 112,260 won per night) */
  price?: string
  /** One short info line (e.g. ★4.8 (1,203) · arrives tomorrow) */
  note?: string
  /** Address to open when pressed (https) */
  url?: string
  /** A word to make it stand out (e.g. lowest price · recommended) */
  badge?: string
}

/** A group of cards left in the conversation history (show_cards). Attached right under the answer */
export interface CardsRecordMessage {
  kind: 'cards'
  cards: ChatCard[]
  /** portrait: vertical poster or book cover (3:4). If missing, square */
  shape?: 'portrait'
}

/** A picture made by image AI (image_make): shown as a big picture under the answer. photo is the "photo:name" picture the PC hands over */
export interface MadeImageRecordMessage {
  kind: 'made'
  title: string
  /** File name in the PC working folder photos/ (made-….jpg) */
  photo: string
  /** Original path kept on the PC (~/Documents/두리/….png) */
  path?: string
}

/** Cleans the cards the AI passed into a shape we can trust: up to 10 cards, text length cut, https addresses only */
export function cleanCards(input: unknown): ChatCard[] {
  const list = Array.isArray(input) ? input : []
  const str = (v: unknown, n: number) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined
  const https = (v: unknown) => {
    const u = str(v, 800)
    if (!u) return undefined
    try {
      const x = new URL(u)
      // Try turning an http address into https (most photos and pages work with both)
      if (x.protocol === 'http:') x.protocol = 'https:'
      return x.protocol === 'https:' ? x.toString() : undefined
    } catch {
      return undefined
    }
  }
  const out: ChatCard[] = []
  for (const raw of list.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const title = str(r.title, 80)
    if (!title) continue
    const card: ChatCard = { title }
    const image = https(r.image)
    const url = https(r.url)
    const price = str(r.price, 40)
    const note = str(r.note, 60)
    const badge = str(r.badge, 12)
    if (image) card.image = image
    if (price) card.price = price
    if (note) card.note = note
    if (url) card.url = url
    if (badge) card.badge = badge
    out.push(card)
  }
  return out
}

/** A service connection request left in the conversation history (connect_ask). The card finds that service in the connection list and draws it */
export interface ConnectRecordMessage {
  kind: 'connect'
  /** Card id or service name (as the AI passed it) */
  service: string
}

export const LoginSubmitSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
})

export const VaultEntryRequestSchema = z.object({
  /** Site address (e.g. https://nid.naver.com/nidlogin.login). Only the origin of the address is saved */
  url: z.string().trim().min(3).max(500),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
})

/** A vault item to show on screen. The password is never sent out */
export interface VaultEntry {
  id: string
  origin: string
  username: string
  createdAt: string
  lastUsedAt?: string
}

// ── Approval gate (M3) ─────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'done' | 'failed'

/** An approval request to show on screen. The button to press and the address are values the Dool2 core read directly from the page */
export interface ApprovalView {
  id: string
  tabId: number
  ref: string
  role: string
  /** The text of the button to press (as read from the page) */
  label: string
  url: string
  /**
   * app: whether Dool2 may operate a PC app it is handling for the first time.
   * file: moving several PC files, restoring from the trash, downloading executables, print: printing on paper,
   * pc: locking or sleeping this PC screen (ADR 0024. All use tabId -2)
   */
  kind: 'money' | 'contact' | 'irreversible' | 'app' | 'file' | 'print' | 'pc'
  reason: string
  /** What follows is the explanation the AI wrote. It can be wrong, so it is shown together with a screen capture */
  what: string
  where: string
  amount?: string
  cancel?: string
  /** The list to approve (moving files: one line each like "a.pdf -> ~/Downloads/receipts/"). A value the core made */
  items?: string[]
  status: ApprovalStatus
  createdAt: string
  expiresAt: string
  /** When it was approved or rejected (by the person or auto-approve); none while pending or if it ran out */
  decidedAt?: string
  /** Approved by auto-approve, not by the user (ADR 0030). A text with this set is sent by the phone on its own */
  auto?: boolean
  /**
   * Auto-approve was on but did not take this request, so it came to the user as a normal card (ADR 0030 amendment).
   * unrelated: the review found it does not match what the user asked. unchecked: the review could not run
   * (no Claude, timeout, no request to compare with). Screens say why on the card
   */
  held?: 'unrelated' | 'unchecked'
  /** The outcome (pressed / could not press because the screen changed) */
  result?: string
  /**
   * What to choose when approving (payment method, 'pay now or pay at the property'). Only fields that really exist on the payment screen are included.
   * What the user chose is bound into the approval signature
   */
  choices?: {
    id: string
    label: string
    /** If it matches my payment method, that name (ADR 0023, e.g. 'Naver Pay · Shinhan Card(1234)') */
    mine?: string
  }[]
  /** Title of the choices (e.g. 'Payment method') */
  choiceTitle?: string
  /** What is chosen by default (the one last used on this site, or if none, what the screen already had chosen) */
  choice?: string
  /** What Dool2 chose on the screen by itself before paying (no insurance, agreeing to terms, etc.). Shown so the user can look and change it */
  chose?: string[]
  /**
   * Delivery address (the shipping address on the payment screen). a0 is the one currently chosen, and from a1 on are other addresses saved on the site.
   * If the user picks another and approves, Dool2 changes the address and then pays (it does not ask again)
   */
  shipOptions?: { id: string; label: string }[]
  /** A warning if the delivery address differs from the address in my info (the core compares. The screen expands the address picker) */
  shipWarn?: string
  /**
   * Payment card (browser_checkout, 11-20 user mockup): for any payment, the AI looks at the payment screen and fills the same frame.
   * title: store or goods group name, goods: product lines, lines: amount lines (goods, shipping, discount, points), info: info lines (arrival, booker, requests, rules).
   * The final amount is amount
   */
  title?: string
  goods?: CheckoutGood[]
  /** What will happen after approving (e.g. "A payment password is received on the phone keypad in the Naver Pay window"). If none, 'Press this payment button just once' */
  after?: string
  lines?: { label: string; value: string; kind?: 'discount' | 'fee' | 'point' }[]
  info?: { label: string; value: string }[]
  /**
   * Detailed choices within a payment method (registered card, installment months, etc., dropdowns on the payment screen).
   * What the user chose is joined with commas together with choice and bound into the approval signature (e.g. "c2,s1o3")
   */
  subChoices?: {
    key: string
    title: string
    options: { id: string; label: string }[]
    choice?: string
    /** A choice that exists only when this payment method (id in choices) is chosen (registered card and installments appear only after choosing a card) */
    when?: string
  }[]
}

/** One product line of the payment card */
export interface CheckoutGood {
  name: string
  /** Option, size, color, room, seat */
  option?: string
  /** Quantity (e.g. "1 item", "2 nights", "2 adults") */
  qty?: string
  /** Price (as on the screen) */
  price?: string
  /** Photo address (https, handed over by the PC) */
  image?: string
}

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  choice: z.string().max(200).optional(),
})

/** An approval request left in the conversation history (when the card is redrawn, the core is asked for its state) */
export interface ApprovalRecordMessage {
  kind: 'approval'
  tabId?: number
  ref?: string
  what: string
}

// ── Phone <-> PC messages (M6, ADR 0012). All go inside an envelope encrypted by e2e.ts ──────

/** Pairing info put in the QR (base64url JSON after #p= in the address) */
export interface PairInvite {
  /** PC id */
  pc: string
  /** PC X25519 public key */
  k: string
  /** One-time pairing secret */
  s: string
  /** PC name */
  n: string
  /** Relay server address. Older invitations may not have it (then the address the phone app was opened from, and the store app uses the official relay server) */
  r?: string
}

/** The remote screen at the phone screen size */
export interface ScreenFit {
  width: number
  height: number
}

/** Phone -> PC */
// ── Dool2's life record: goals, library, memory, feed (kept only in the core's storage) ──

/** When: daily HH:MM · by weekday (0=Sunday, several days) · monthly by day (31=last day) · once · every N minutes (all in Korean time) */
export type RoutineSchedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; days: number[] }
  /** Monthly on day (1-31). In months without that day, the last day of the month */
  | { kind: 'monthly'; time: string; day: number }
  | { kind: 'once'; at: string }
  | { kind: 'every'; minutes: number }

export const GOAL_CATEGORIES = ['건강', '관계', '돈', '일', '관심사', '생산성', '기타'] as const
export type GoalCategory = (typeof GOAL_CATEGORIES)[number]

/**
 * Goals and automatic jobs. With a category it is a "goal" (plan steps, progress log, check-ins),
 * without one it is an "automatic job" (morning briefing, watching for cancellations, monthly bill check)
 */
export interface Routine {
  id: string
  title: string
  /** What to tell Dool2 at the set time */
  prompt: string
  /** Some goals have no set time */
  schedule?: RoutineSchedule
  enabled: boolean
  createdAt: string
  /** Where to put the result: the conversation (default) or the feed */
  target?: 'chat' | 'feed'
  category?: GoalCategory
  plan?: { text: string; done: boolean }[]
  log?: { at: string; text: string }[]
  nextRunAt?: string
  lastRunAt?: string
  lastResult?: string
  /** What watching (when_found) last announced: passed along so the next turn does not announce the same thing again */
  lastTold?: string
  /** The end: a date (YYYY-MM-DD, runs until that day then turns off) or a condition (turns off when Dool2 is told it has been met) */
  until?: string
  /** Notifying: every time (default) or only when it matches the condition (otherwise quietly, with no feed or phone notification) */
  notify?: 'always' | 'when_found'
  /** Time of the result notice HH:MM (Korean time): the work is done at the set time and only the phone notice waits until this time (do it overnight and tell me in the morning) */
  tellAt?: string
  /** The time it turned itself off after the end passed */
  endedAt?: string
  /**
   * Quick check (ADR 0031): a lookup service tool the daemon runs at each set time without the AI. Dool2 (the AI) is
   * woken only when its result changes, so "every N minutes" can go down to 1 minute
   */
  check?: RoutineCheck
  /** Fingerprint and short text of the last quick-check result (to tell a change) */
  checkPrint?: string
  checkText?: string
  /** Quick checks that failed in a row */
  checkFails?: number
}

/** A lookup service tool and its input, run without the AI (ADR 0031) */
export interface RoutineCheck {
  tool: string
  input: Record<string, unknown>
}

/** Library: things Dool2 found or made that were kept */
export interface LibraryItem {
  id: string
  kind: 'note' | 'link' | 'product' | 'place' | 'file'
  title: string
  body: string
  url?: string
  price?: string
  savedAt: string
  /** The list sends only the beginning of the text (the whole is fetched one at a time: GET /api/life/library/<id>, life-item on the phone) */
  cut?: true
  /** A file Dool2 made: the PC path (~/Documents/두리/…) */
  path?: string
  /** A preview the PC drew and captured of HTML Dool2 made (picture, invitation, report) (JPEG base64). Not included in the list */
  image?: string
  /** A small preview to show in the list (JPEG base64, about 128px wide) */
  thumb?: string
}

/** The piece that arrives at a time when receiving a library file original on the phone (to fit in the relay envelope's 500KB, allowing for growth from encryption) */
export const FILE_CHUNK = 192 * 1024
/** The largest size of a file original received on the phone */
export const FILE_MAX = 60 * 1024 * 1024

/** Memory: what was learned about the user (the user can see and delete it) */
/**
 * Where a remembered fact came from. said: the user told Dool2 (or Dool2 did it). account: shown by a service on the
 * user's own signed-in pages (profile, orders, bills, bookings). web: general web pages, search results, or mail,
 * messages and files other people wrote. Facts from the web are kept for searching but never put in the instructions
 * (a page could plant orders there). Missing on items saved before this field existed: read as said
 */
export type InfoOrigin = 'said' | 'account' | 'web'

export interface MemoryItem {
  id: string
  text: string
  /** Who saved it: Dool2 (memory_save) or the user on the screen */
  source: 'doori' | 'user'
  /** Where the fact came from (missing = said) */
  origin?: InfoOrigin
  at: string
}

/**
 * What Dool2 has noted (lookup memory and a ledger of things done). Facts about me seen after signing in (fact) and applications, payments, bookings, deliveries and signups Dool2 did or confirmed (done).
 * Whether it is still usable is judged by the AI from today's date and the reference point, with no fixed validity period
 */
/** A recipe as the memory screen shows it (ADR 0044): what was asked, and the services or sites its steps used */
export interface RecipeView {
  id: string
  /** The person's last words for a request these steps got done */
  ask: string
  /** Services or sites the steps used, in order (names people know, not tool names) */
  steps: string[]
  /** Requests these steps got done */
  ok: number
  lastAt: string
}

export interface KnowItem {
  id: string
  kind: 'fact' | 'done'
  /** What (e.g. "2025 attributed total salary", "Review experience group Sentique application") */
  title: string
  /** A summary value (e.g. "about 77.5 million won", "announced 11/24") */
  value: string
  /** Where it was seen (site or service name) */
  source?: string
  /** What kind of place it came from (missing = said). web items are never put in the instructions */
  origin?: InfoOrigin
  /** That screen's address */
  url?: string
  /** Reference point (e.g. "2025 attribution", "November results", "the day it was looked up") */
  basis?: string
  /** When it was seen or done */
  seenAt: string
  /** When to follow up next (announcement date, free-cancellation deadline, arrival, maturity) */
  next?: string
  /** What to do then (e.g. "check the winner announcement") */
  nextWhat?: string
  /** Status of what was done: in progress or ended (cancelled, terminated, done). It is not deleted, it is left as ended */
  state?: 'open' | 'done'
  updatedAt: string
}

/** Feed: what Dool2 did, did on its own, and tells you first */
/** The input field position on the remote screen (photo ratio 0-1). On the phone, pressing it opens the keyboard right away */
export interface RemoteField {
  x: number
  y: number
  w: number
  h: number
  /** Password field */
  secret?: boolean
  /** Phone keyboard type (numeric, tel, email…) */
  mode?: string
  label?: string
}

/** A button on the remote screen (center position, photo ratio). The phone collects them as big buttons below */
export interface RemoteButton {
  label: string
  x: number
  y: number
  /** A main button like submit */
  main?: boolean
}

/** The field where text goes now */
export interface RemoteFocus {
  label?: string
  secret?: boolean
  mode?: string
  /** Text already in the field (not sent for password fields) */
  value?: string
}

/**
 * "Only the needed fields" of the remote screen: fields a person fills, choices, and buttons to press.
 * Sent to the phone in the same shape whether it is a browser tab (extension) or a PC app window (accessibility)
 */
export interface RemoteFormField {
  id: string
  kind: 'text' | 'secret' | 'number' | 'tel' | 'email' | 'choice' | 'check'
  label: string
  /** Text already in the field (not sent for password fields) */
  value?: string
  checked?: boolean
  options?: { id: string; label: string; on?: boolean }[]
  max?: number
  hint?: string
  /** Verification code field received by SMS (the phone shows six boxes) */
  code?: boolean
  /** Captcha picture (JPEG base64): write the picture's text in this field */
  captcha?: string
}

export interface RemoteFormButton {
  id: string
  label: string
  main?: boolean
}

export interface RemoteForm {
  title?: string
  url?: string
  fields: RemoteFormField[]
  buttons: RemoteFormButton[]
}

/** One value filled in on the phone: text (value), a check (checked), a choice (pick = the id of the chosen one) */
export interface RemoteFormValue {
  id: string
  value?: string
  checked?: boolean
  pick?: string
}

export interface RemoteInfo {
  fields?: RemoteField[]
  actions?: RemoteButton[]
  focus?: RemoteFocus | null
}

export interface FeedItem {
  id: string
  kind: 'done' | 'routine' | 'saved' | 'goal' | 'connected' | 'suggest' | 'post'
  title: string
  body?: string
  /** Related goal, library or conversation id */
  ref?: string
  at: string
  reaction?: 'up' | 'down'
  /** Proactive care (kind 'suggest'): one line about where it was learned (e.g. "after looking at Coupang order history") */
  from?: string
  /** Proactive care: a key so the same thing is not announced twice (e.g. "coupang-order-123-arrived") */
  key?: string
  /** Proactive care: the request to send to Dool2 when [Do it] is pressed. If missing, only an announcement */
  ask?: string
  /** The [Do it] button text (e.g. "Pick for me"). If missing, "Do it" */
  askLabel?: string
  /** The answer the user chose */
  answered?: 'yes' | 'no'
}

/** Dool2 settings: what to call the user, tone, answer length */
export interface Identity {
  userName?: string
  tone?: 'warm' | 'neat' | 'buddy'
  length?: 'short' | 'normal' | 'detail'
}

/** A task Dool2 found first (top of the ideas tab) */
export interface SuggestedIdea {
  /** The request to send to Dool2 as is when pressed */
  text: string
  /** One line on why this is suggested */
  why: string
}

/** A long list received in pages */
export type LifeList = 'feed' | 'library'
/** Library slots: things made (notes, links, products, places) / photos and files */
export type LibraryTab = 'made' | 'files'

export interface LifeState {
  identity?: Identity
  ideas?: SuggestedIdea[]
  /** When ideas were last searched for */
  ideasAt?: string
  /** Searching for ideas now */
  ideasBusy?: boolean
  routines: Routine[]
  /** Library first page: the latest 30 for each of made things, photos and files (text only the beginning, cut). More with libraryNext */
  library: LibraryItem[]
  /** The next page cursor for each library slot (none means the end) */
  libraryNext?: { made?: string; files?: string }
  /** How many there are in total for each library slot */
  libraryCount?: { made: number; files: number }
  memory: MemoryItem[]
  /** What Dool2 has noted (lookup memory and a ledger of things done), newest first */
  know?: KnowItem[]
  /** Steps Dool2 remembered for requests asked more than once (ADR 0044), most recent first */
  recipes?: RecipeView[]
  /** Feed first page (the latest 30). More with GET /api/life/feed?before= via feedNext, life-page on the phone */
  feed: FeedItem[]
  /** The next feed page cursor (none means the end) */
  feedNext?: string
  /** What Dool2 did this week: the number of things done each day for the last 60 days (the last is today, by this PC's time) */
  feedDays?: number[]
  /** What the user wrote about what to post on the feed */
  feedPrompt?: string
  /** Proactive care: every hour from 6 am to 10 pm, it looks at done jobs due for follow-up and the services you connected, and only announces what needs attention (on by default) */
  watch?: { on: boolean; at?: string; busy?: boolean }
}

export type LifeAction =
  | {
      action: 'routine-create'
      title: string
      prompt: string
      schedule?: RoutineSchedule
      category?: GoalCategory
    }
  | { action: 'goal-step'; id: string; index: number; done: boolean }
  | { action: 'feed-react'; id: string; reaction?: 'up' | 'down' }
  /** Replying to the suggestion of a proactive job ([Do it]: the screen sends that request separately into the conversation) */
  | { action: 'feed-answer'; id: string; answer: 'yes' | 'no' }
  | { action: 'feed-prompt'; text: string }
  | { action: 'library-save'; title: string; body: string; itemKind?: LibraryItem['kind'] }
  | { action: 'routine-toggle'; id: string; on: boolean }
  | { action: 'routine-delete'; id: string }
  | { action: 'routine-run'; id: string }
  | { action: 'library-delete'; id: string }
  | { action: 'memory-add'; text: string }
  | { action: 'memory-delete'; id: string }
  | { action: 'know-delete'; id: string }
  | { action: 'recipe-delete'; id: string }
  | ({ action: 'identity' } & Identity)
  | { action: 'ideas-refresh' }
  | { action: 'watch'; on: boolean }
  | { action: 'watch-now' }

/** What the phone app can do (announced with hello) */
export type PhoneCap = 'sms'

export type PhoneToPc =
  | { kind: 'pair'; secret: string; signPub: string; name: string }
  /** caps: what this phone app can do ('sms' = send a text to my own number). Older apps do not send it */
  | { kind: 'hello'; caps?: PhoneCap[] }
  /**
   * Result of sending a text (sent before the approval signature decide). When the user approves on the phone, the phone app sends it directly.
   * message is one line the phone made (the recipient's name and a masked number, or the reason if it could not send). The full number is not included
   */
  | { kind: 'sms-result'; id: string; ok: boolean; message: string }
  /** Rename this PC shown on the phone (saved in PC settings so other phones see it too) */
  | { kind: 'rename-pc'; name: string }
  /** Switch the AI Dool2 runs on to another connected one (saved in the PC settings, every phone sees it) */
  | { kind: 'use-agent'; agent: AgentId }
  /** I have the app open (every minute). The PC sends streaming answers and the live screen only to phones that have them on */
  | { kind: 'ping' }
  /**
   * Report a problem: records what just happened in the phone app (what was pressed, the kind and time of signals received) in the PC's work log.
   * Conversation content and entered values are not included. It stays only a few days on the PC and does not go outside
   */
  | { kind: 'report'; note?: string; trail: { at: number; what: string }[]; app?: string }
  /**
   * Report an AI answer (store AI-content policy): which answer and why. The PC looks up the answer text in its own
   * record and sends it to the Dool2 team with the reason; the phone shows what goes before sending
   */
  | { kind: 'report-answer'; messageId: string; threadId?: string; reason: AnswerReportReason; note?: string }
  /**
   * Start over (test PC only): erases the PC's conversations, memory, goals and library. The PC verifies the phone signature (resetSignText).
   * With services, it also erases the connected-service marks (vault passwords and phone pairing stay)
   */
  | { kind: 'reset'; at: number; services: boolean; sig: string }
  /** Turns auto-approve on or off from the phone. Signed with the phone key (autoApproveSignText), checked by the PC */
  | { kind: 'auto-approve'; on: boolean; at: number; sig: string }
  /** Ask the PC for a card photo (the phone does not connect to outside servers directly) */
  | { kind: 'thumb'; url: string }
  /** Settings > my info and payment methods: view (masked values), edit (empty value = delete), delete all, forget a site's payment method */
  /** Settings > vault: list, view one password (after the phone lock check), edit ID and password, delete (ADR 0026) */
  | { kind: 'vault-get' }
  | { kind: 'vault-reveal'; id: string }
  | { kind: 'vault-set'; id: string; username?: string; password?: string }
  | { kind: 'vault-delete'; id: string }
  | { kind: 'profile-get' }
  | { kind: 'profile-set'; values: Record<string, string> }
  | { kind: 'profile-clear' }
  | { kind: 'pay-choice-forget'; host: string }
  /** Replace the whole list of my payment methods (add, delete, reorder). The top one is the main method (ADR 0023) */
  | { kind: 'pay-methods-set'; methods: PayMethodInput[] }
  | { kind: 'thread'; id: string }
  /** image: a photo shrunk on the phone (JPEG base64, 300KB or less) */
  | { kind: 'ask'; threadId?: string; agent?: AgentId; text: string; image?: string }
  | { kind: 'cancel'; threadId: string }
  | { kind: 'approval'; id: string }
  /**
   * key: which security-chip key signed (ADR 0043): 'pay' (after the phone lock) or 'plain'. Absent = the pairing
   * key (Ed25519, older apps and the browser), which the PC stops accepting once chip keys are registered
   */
  | {
      kind: 'decide'
      id: string
      decision: 'approve' | 'reject'
      sig: string
      choice?: string
      key?: ApproveKeyName
    }
  /** Registers this phone's security-chip approval keys (SPKI, base64url). Signed with the pairing key (approveKeysSignText) */
  | { kind: 'approve-keys'; plain: string; pay?: string; at: number; sig: string }
  /** Phone lock for payment approvals on or off (payConfirmSignText). Off must be signed with the pay key */
  | { kind: 'pay-confirm'; on: boolean; at: number; sig: string; key: ApproveKeyName }
  /** The ID and password put in the sign-in card (saved only in the PC vault) */
  | { kind: 'login'; id: string; username: string; password: string }
  /** Remote screen: ask for one frame of the tab Dool2 handed over */
  /** fit: the phone screen size (CSS px). If given, the PC tab is drawn at that size and sent to fill the phone */
  | { kind: 'screen'; tabId: number; fit?: ScreenFit }
  /**
   * Input on the remote screen. tap and scroll coordinates are photo ratios (0-1).
   * For scroll, dy of ±1 means one screen at a time, and larger is page pixels (as far as the finger dragged).
   * view makes that tab draw at the phone width (w×h CSS pixels), and leave puts it back as it was
   */
  | {
      kind: 'remote'
      tabId: number
      /** done: a person finished the work handed over to them (tells Dool2 without writing 'Done' in the conversation) */
      action: 'tap' | 'text' | 'key' | 'scroll' | 'view' | 'leave' | 'done'
      x?: number
      y?: number
      text?: string
      key?: string
      dy?: number
      fit?: ScreenFit
      w?: number
      h?: number
    }
  /** Ask for the remote screen's "only the needed fields" */
  | { kind: 'form'; tabId: number }
  /** Put in the values filled on the phone for the fields only, and if press is present, press that button */
  | { kind: 'form-fill'; tabId: number; values: RemoteFormValue[]; press?: string }
  /** Web push subscription (null when notifications are turned off). The PC sends notifications directly to this address */
  | { kind: 'push'; sub: PushSubscriptionJSONLike | null }
  /**
   * Store app notifications (ADR 0042): the FCM token and this phone's notification key (32 bytes, base64url).
   * The PC encrypts each notification with the key and the official relay hands it to FCM, so neither Google nor the
   * relay can read it. null when notifications are turned off
   */
  | { kind: 'app-push'; reg: AppPushReg | null }
  /** Ask for the list of service connections (ADR 0014) */
  | { kind: 'connections' }
  /** Ask for the record of one conversation (ADR 0015). With before, the messages before it */
  | { kind: 'conversation'; before?: string; limit?: number }
  /** Stop what is being done in the conversation now */
  | { kind: 'conversation-cancel' }
  /** Dress Doori (the look is shared with the PC and every phone) */
  | { kind: 'doori-look'; look: DooriLook }
  /** Take back a message still waiting in line (sent while Dool2 was answering, not yet read by the AI) */
  | { kind: 'conversation-unqueue'; text: string }
  /** Take the draft as the result and stop further rounds of the before-finishing check (ADR 0027) */
  | { kind: 'conversation-accept' }
  /** Continue what the check left when it reached its limit (the [Continue] button on a 'left' record) */
  | { kind: 'conversation-continue' }
  /** A task's card (ADR 0038): stop it, or take its draft as the result */
  | { kind: 'task'; id: string; action: 'stop' | 'accept' }
  /** Separate conversations: create (-> answered as thread), delete */
  | { kind: 'side-new' }
  | { kind: 'side-delete'; id: string }
  /** Receive goals, library, memory and feed */
  | { kind: 'life' }
  /**
   * The next page of a long list (answered with life-page). Without before, the first page.
   * For feed, kinds can choose the kinds (activity: done, routine), and for library, tab (made things, photos, files)
   */
  | {
      kind: 'life-page'
      list: LifeList
      before?: string
      limit?: number
      kinds?: FeedItem['kind'][]
      tab?: LibraryTab
    }
  /** The full text of one library item (the list carries only the beginning). Answered with life-item */
  | { kind: 'life-item'; id: string }
  /** One piece of a library file original (save and share on the phone). With path, a file link inside an answer (id is the mark the phone is waiting for) */
  | { kind: 'file-chunk'; id: string; offset: number; path?: string }
  | ({ kind: 'life-action' } & LifeAction)
  /**
   * Service connection: open = open that service in PC Chrome and hand it over to the remote screen (sign in on the phone),
   * mark, unmark = mark or unmark as connected
   */
  /** chat: leave "Connect ○○" and the connect card in the conversation right away (does not call the AI) */
  /** verify: when [I signed in] is pressed, the core opens the site, checks it is really signed in, and marks it connected */
  /** start: look whether Chrome is signed in first, then ask on the phone (which account, or ID and password; ADR 0041) */
  | { kind: 'connect'; id: string; action: 'open' | 'mark' | 'unmark' | 'chat' | 'verify' | 'start' }
  /** Connecting: put the ID and password in the vault and the Dool2 core signs in for you (the values do not pass through the AI) */
  | { kind: 'connect-login'; id: string; username: string; password: string }
  /** The answer to what the screen asks during sign-in (verification code, etc.). Without value, cancel */
  | { kind: 'info-answer'; id: string; value?: string }
  /** "First time · sign me up" on the card: the user chose to sign up at that site (address). With loginId, that sign-in card is closed */
  | { kind: 'signup'; site: string; loginId?: string }
  /** I don't know my account: withdraw the sign-in card being waited on, and Dool2 continues with finding the ID or resetting the password */
  | { kind: 'forgot'; site: string; loginId?: string }
  /** Connect with one-tap sign-in (Kakao, Naver…). If sign-in at the provider is needed, hand over to the remote screen */
  | { kind: 'connect-social'; id: string; provider: SocialProvider }

/** Why an AI answer is reported: harmful or offensive, wrong, or something else */
export type AnswerReportReason = 'harmful' | 'wrong' | 'other'

/** Security-chip approval keys (ADR 0043): 'pay' signs only after the phone lock, 'plain' signs right away */
export type ApproveKeyName = 'pay' | 'plain'

/** Store app notification address (ADR 0042) */
export interface AppPushReg {
  /** FCM registration token */
  token: string
  /** AES-256-GCM key for the notification content (base64url, 32 bytes). Made on the phone, never sent anywhere but the PC */
  key: string
}

/** The PushSubscription.toJSON() fields the PC uses, from the phone browser */
export interface PushSubscriptionJSONLike {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** PC -> phone */
/**
 * How the PC is doing, sent to the phones every 30 s while one is around and at once when it changes, so the phone can
 * say why the PC is slow or silent instead of only "the PC is not answering" (user 11-26)
 */
export type PcHealthIssue =
  /** Dool2 itself is stalled (its work loop answered late) */
  | 'slow'
  /** The PC as a whole is busy (other programs) */
  | 'busy'
  /** Little disk space left */
  | 'low-disk'
  /** The Chrome extension is not connected */
  | 'no-extension'
  /** The AI subscription or key hit its usage limit */
  | 'ai-limit'
  /** The AI program is signed out */
  | 'ai-signed-out'
  /** The PC is going to sleep */
  | 'sleeping'

export interface PcHealth {
  /** When the PC sent it (PC clock) */
  at: number
  issues: PcHealthIssue[]
  /** How late Dool2's work loop answered at worst in the last half minute (ms) */
  lagMs: number
  /** Load on the PC: 1 = every core busy */
  load: number
  /** Free disk space where Dool2 keeps its data (GB) */
  diskGb?: number
  /** AI programs Dool2 keeps running now */
  agents: number
  /** When the AI usage limit resets, if known */
  limitResetsAt?: string
}

export type PcToPhone =
  | { kind: 'paired'; pcName: string }
  | { kind: 'pair-rejected' }
  | {
      kind: 'state'
      pcName: string
      agents: AgentId[]
      defaultAgent?: AgentId
      extension: boolean
      threads: ThreadSummary[]
      approvals: ApprovalView[]
      /** A sign-in request being waited on */
      logins?: LoginRequestView[]
      /** What to receive from the phone during sign-in (verification code, etc.) */
      infos?: InfoRequestView[]
      /** The Chrome tab Dool2 handled last (can be seen on the live screen) */
      activeTab?: number
      /** Web push VAPID public key (the phone's applicationServerKey) */
      vapid?: string
      /** Whether this phone's subscription for notifications is registered on the PC */
      push?: boolean
      /** Whether this store app's notification address (ADR 0042) is registered on the PC */
      appPush?: boolean
      /** The service the Dool2 core is signing in to now */
      connecting?: string[]
      /** Test PC: show 'Start over' in the phone settings */
      dev?: boolean
      /** Auto-approve is on (ADR 0030): the phone shows it in settings and sends texts without a card */
      autoApprove?: boolean
      /** How the user dressed Doori (doori-look.ts) */
      dooriLook?: DooriLook
      /** This phone's security-chip approval keys are registered (ADR 0043) */
      approveKeys?: boolean
      /** Payment approvals need the phone lock (only when a pay key is registered) */
      payConfirm?: boolean
      /** A pay key is registered (false: the phone had no screen lock when the keys were made) */
      payKey?: boolean
    }
  | { kind: 'thread'; thread: ThreadSummary; messages: StoredMessage[] }
  | { kind: 'stream'; threadId: string; event: DaemonStreamEvent }
  | { kind: 'approval'; approval: ApprovalView & { shot?: string } }
  /** New sign-in request, save result */
  | { kind: 'login-request'; request: LoginRequestView }
  | { kind: 'info-request'; request: InfoRequestView }
  | { kind: 'info-done'; id: string }
  | { kind: 'login-done'; id: string; ok: boolean; message: string }
  /** One frame of the remote screen (JPEG base64) and its input fields, buttons and the current field. The relay server does not store this kind */
  | ({
      kind: 'screen'
      tabId: number
      shot?: string
      url?: string
      title?: string
      error?: string
    } & RemoteInfo)
  /** The remote screen's "only the needed fields" (sent again after form-fill too) */
  | { kind: 'form'; tabId: number; form?: RemoteForm; error?: string }
  | { kind: 'decided'; id: string; ok: boolean; message: string }
  /** Card photo (the PC fetches it as a data: address). If it cannot, there is no data */
  | { kind: 'thumb'; url: string; data?: string }
  /** Vault list (no passwords). message is the result of what was just done */
  | { kind: 'vault'; entries: (VaultEntry & { name?: string })[]; message?: string }
  /** One password (only when the user asked after the phone lock check). The screen shows it briefly and erases it */
  | { kind: 'vault-secret'; id: string; username: string; password: string }
  /** My info (masked values) and the last payment method per site. message is the result of what was just done */
  | {
      kind: 'profile'
      have: Record<string, string>
      missing: string[]
      payChoices: Record<string, string>
      /** My payment methods (the top one is the main method). Older PCs do not have it */
      payMethods?: PayMethod[]
      message?: string
    }
  /** The result of Start over */
  | { kind: 'reset-done'; ok: boolean; message: string }
  /** Result of reporting an AI answer: id is the report number the Dool2 team got */
  | { kind: 'answer-reported'; messageId: string; ok: boolean; id?: string; message?: string }
  /** The record of one conversation (if it answers before, before comes with it) */
  | { kind: 'conversation'; state: ConversationState; before?: string }
  /** Whether the conversation is answering, and the messages waiting in line (every time it changes) */
  | { kind: 'conversation-status'; busy: boolean; queued: string[]; checking?: boolean }
  /** How the PC is doing (PcHealth) */
  | { kind: 'health'; health: PcHealth }
  /** A task changed (ADR 0038) */
  | { kind: 'task'; task: TaskView }
  | { kind: 'life'; state: LifeState }
  /** One page of a long list (returns what was asked as is: the screen knows which list it is) */
  | {
      kind: 'life-page'
      list: 'feed'
      before?: string
      kinds?: FeedItem['kind'][]
      items: FeedItem[]
      next?: string
    }
  | {
      kind: 'life-page'
      list: 'library'
      before?: string
      tab?: LibraryTab
      items: LibraryItem[]
      next?: string
    }
  /** One library item (full text). If none, no item */
  | { kind: 'life-item'; id: string; item?: LibraryItem }
  | {
      kind: 'file-chunk'
      id: string
      offset: number
      /** Original total size (bytes) */
      size?: number
      name?: string
      mime?: string
      /** This piece (base64) */
      data?: string
      error?: string
    }
  /** The list of service connections (cards + procedure state + connected time) */
  | { kind: 'connections'; services: ConnectionItem[] }
  /** The tab opened in PC Chrome to connect. The phone opens this tab as the remote screen */
  | { kind: 'connect-opened'; id: string; tabId: number }
  /** Sign-in-for-you result. With human, the tab was handed over to the remote screen (robot check, identity verification) */
  | {
      kind: 'connect-result'
      id: string
      ok: boolean
      message: string
      human?: boolean
      tabId?: number
      /**
       * Why it could not: a person's turn (captcha, identity verification) / wrong ID or password / not knowing the
       * sign-in fields or result / Chrome is signed in to another account than the one asked for / the ID and
       * password are needed: the phone opens that card (ADR 0041)
       */
      reason?: 'human' | 'wrong' | 'unknown' | 'other-account' | 'credentials'
      /** The automatic sign-in stopped, and Dool2 (the AI) is continuing in the conversation while looking at that screen */
      agent?: boolean
    }
  /** The Chrome tab Dool2 is handling now (puts the working screen live in the conversation) */
  | { kind: 'work-tab'; tabId: number }
  /** The service the Dool2 core is signing in to now (connecting runs in the background, and when done, connect-result and a conversation notice) */
  | { kind: 'connect-status'; connecting: string[] }
  /** The step the core is doing now while connecting (shown on the connect card. at = start time ms) */
  /** tabId = the tab being signed in now (the connect card shows that screen small and live) */
  | { kind: 'connect-progress'; id: string; steps: ConnectStep[]; tabId?: number }
  | { kind: 'error'; message: string }

export { approvalSignText } from './link.js'
export type { PayKind, PayMethod, PayMethodInput } from './pay-methods.js'

/** A paired phone (kept by the PC) */
export interface PairedPhone {
  id: string
  name: string
  boxPub: string
  signPub: string
  pairedAt: string
  /** Web push subscription. If present, notifications are sent even when the app is off */
  push?: PushSubscriptionJSONLike
  /** Store app notification address (ADR 0042). If present, notifications go through FCM */
  appPush?: AppPushReg
  /**
   * Security-chip approval keys (ADR 0043, SPKI base64url). Once present, approvals signed with the pairing key are
   * no longer accepted from this phone
   */
  approveKeys?: { plain: string; pay?: string }
  /** Payment approvals need the pay key (default on when a pay key exists). Turned off only with a pay-key signature */
  payConfirm?: boolean
}

export interface LinkStatus {
  relay?: string
  connected: boolean
  pcId?: string
  phones: (Omit<PairedPhone, 'boxPub' | 'signPub' | 'push' | 'appPush' | 'approveKeys' | 'payConfirm'> & {
    push: boolean
  })[]
}

export type PairStatus =
  | { state: 'idle' }
  | { state: 'waiting'; url: string; qr: string; expiresAt: string }
  | { state: 'confirm'; code: string; name: string; url: string; qr: string; expiresAt: string }
  | { state: 'done'; name: string }
  | { state: 'expired' }

export const PairConfirmSchema = z.object({ accept: z.boolean() })

/** Simple-auth apps (my info's 'simple-auth app'): exactly the names shown in the simple-auth window of public sites like Gov24 and Hometax */
export const AUTH_APPS = [
  '카카오톡',
  '네이버',
  '토스',
  'PASS',
  'KB국민인증서',
  '신한인증서',
  '삼성패스',
  '페이코',
] as const

/** Mobile carriers (chosen in the identity check window). MVR carriers come with the network name */
export const CARRIERS = ['SKT', 'KT', 'LG U+', 'SKT 알뜰폰', 'KT 알뜰폰', 'LG U+ 알뜰폰'] as const
