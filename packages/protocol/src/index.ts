// 두리 공통 타입: 에이전트 이벤트, 대화, 데몬 API.
// 폰↔PC 암호화 규약은 M2에서 이 패키지에 추가한다.
import { z } from 'zod'

/** 두리가 실행할 수 있는 AI. 사용자의 구독으로 돈다. */
/** claude·codex: 구독, opencode: API 키 종량제 (ADR 0010) */
export const AgentIdSchema = z.enum(['claude', 'codex', 'opencode'])
export type AgentId = z.infer<typeof AgentIdSchema>

export const AGENT_LABEL: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'API 키 (종량제)',
}

/** 설치·로그인 상태. 첫 설정 마법사와 진단 화면이 쓴다. */
export interface AgentStatus {
  id: AgentId
  installed: boolean
  version?: string
  /** 실행 파일 위치 */
  path?: string
  loggedIn: boolean
  /** 구독 종류 (예: max, pro, plus) */
  plan?: string
  /** 사용자에게 보여 줄 문제 설명. 없으면 정상 */
  problem?: string
}

/** 사용량 한도 한 칸 (예: 5시간 창, 7일 창) */
export interface UsageLimit {
  kind: string
  /** 0~100 */
  percent: number
  resetsAt?: string
}

/** 에이전트 한 턴 동안 나오는 이벤트. Claude·Codex 어댑터가 이 형태로 바꿔서 낸다. */
export type AgentEvent =
  | { type: 'started'; resumeId?: string; model?: string; tools: string[] }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'tool_result'; name?: string; ok: boolean }
  | { type: 'usage'; limits: UsageLimit[] }
  /** 종량제: 이번 단계에 쓴 돈(USD)과 토큰 */
  | { type: 'cost'; usd: number; inputTokens: number; outputTokens: number }
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
}

export interface StoredMessage {
  id: string
  threadId: string
  role: MessageRole
  text: string
  createdAt: string
}

// ── 데몬 로컬 API (PC 앱 화면 ↔ dool2d) ──────────────────────────

export const CreateThreadRequestSchema = z.object({
  agent: AgentIdSchema,
})
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>

export const SendMessageRequestSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
})
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>

// ── 설정 (이 PC에만 저장) ──────────────────────────────────────

/** 첫 실행 때 고른 AI 구독. 잘 모르면 'unsure' */
export const AiChoiceSchema = z.enum(['claude', 'codex', 'both', 'unsure', 'payg'])
export type AiChoice = z.infer<typeof AiChoiceSchema>

export const SettingsSchema = z.object({
  /** 첫 실행 마법사를 끝냈는지 */
  setupDone: z.boolean(),
  aiChoice: AiChoiceSchema.optional(),
  /** 새 대화를 시작할 때 고를 AI */
  defaultAgent: AgentIdSchema.optional(),
  /** PC가 잠들지 않게: 일하는 동안만 / 항상 / 안 함 (docs/architecture.md 7.1) */
  keepAwake: z.enum(['working', 'always', 'off']).optional(),
  /** PC를 켜면 두리도 자동으로 켜기 */
  launchAtLogin: z.boolean().optional(),
  /** 종량제 모드에서 고른 제공자·모델 (API 키는 여기 두지 않고 OS 키체인에) */
  payg: z.object({ provider: z.string(), model: z.string() }).optional(),
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = { setupDone: false }

/** 바꿀 항목만 보낸다. 모르는 항목은 거절한다 */
export const SettingsPatchSchema = SettingsSchema.partial().strict()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

// ── Claude 로그인 (공식 `claude auth login`을 띄워 진행) ─────────────

export type ClaudeLoginStatus =
  | { state: 'idle' }
  /** url: 브라우저에서 열 로그인 주소. codeRejected: 붙여 넣은 코드가 맞지 않았음 */
  | { state: 'waiting'; url?: string; codeRejected?: boolean }
  | { state: 'done' }
  | { state: 'failed'; message: string }

// ── 부품 설치 (Claude Code, Chrome) ─────────────────────────

export type InstallPhase = 'prepare' | 'download' | 'verify' | 'setup'

export type InstallStatus =
  | { state: 'idle' }
  /** percent: 내려받기 진행률(0~100) */
  | { state: 'running'; phase: InstallPhase; percent?: number }
  | { state: 'done'; version?: string }
  | { state: 'failed'; message: string }

export interface ChromeStatus {
  installed: boolean
  version?: string
  path?: string
}

// ── 종량제 (API 키) ──────────────────────────────────────────────

export interface PaygModel {
  id: string
  label: string
}

export interface PaygProvider {
  id: string
  label: string
  /** 키를 받는 곳 */
  keyUrl: string
  models: PaygModel[]
}

/** 저장된 종량제 계정. API 키 자체는 절대 내보내지 않는다 */
export interface PaygAccount {
  provider: string
  model: string
  hasKey: boolean
  /** 키 끝 4자리 (확인용) */
  keyHint?: string
}

export const PaygAccountRequestSchema = z.object({
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(120),
  /** 비우면 모델만 바꾼다 */
  apiKey: z.string().trim().min(8).max(500).optional(),
})

export const ClaudeLoginCodeSchema = z.object({
  code: z.string().trim().min(1).max(2_000),
})

/** 데몬이 SSE로 흘려보내는 이벤트 */
export type DaemonStreamEvent =
  | { type: 'agent'; event: AgentEvent }
  | { type: 'saved'; message: StoredMessage }
  | { type: 'end' }

// ── 브라우저 손 (ADR 0006): 두리 본체 ↔ native messaging ↔ 두리 확장 ──────

/** native messaging 호스트 이름. Chrome이 이 이름으로 등록 파일을 찾는다 */
export const BROWSER_HOST_NAME = 'com.dool2.host'

/**
 * 개발용 확장 id. apps/extension/manifest.json의 `key`(공개키)에서 나온다.
 * 웹 스토어에 올리면 스토어 id를 여기에 더한다 (M5).
 */
export const DEV_EXTENSION_ID = 'mgjjgnbhoaalicncjbbcldjffpecocah'
export const EXTENSION_IDS = [DEV_EXTENSION_ID]

/** 확장이 할 수 있는 일. 판단은 하지 않고 시킨 것만 한다 */
export const BrowserCommandSchema = z.enum([
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
])
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>

/** 본체 → 확장 */
export interface BridgeRequest {
  id: number
  cmd: BrowserCommand
  args: Record<string, unknown>
}

/** 확장 → 본체: 요청에 대한 답 */
export type BridgeReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

/** 확장 → 본체: 알림 */
export type BridgeNotice =
  | { event: 'hello'; version: string; browser?: string }
  | { event: 'tab-closed'; tabId: number }

export interface ExtensionStatus {
  connected: boolean
  version?: string
  browser?: string
}

export const FocusTabSchema = z.object({ tabId: z.number().int() })

/** 사람에게 넘기기: 대화 기록에 'tool' 메시지로 남겨 다시 열어도 [다 했어요]를 보여 준다 */
export interface HandoffRecord {
  kind: 'handoff'
  tabId?: number
  reason: string
}

// ── 두리 금고 (ADR 0011): 로그인 정보는 PC 키체인에, AI가 아니라 두리가 채운다 ──────

export const VaultEntryRequestSchema = z.object({
  /** 사이트 주소 (예: https://nid.naver.com/nidlogin.login). 주소의 origin만 저장한다 */
  url: z.string().trim().min(3).max(500),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
})

/** 화면에 보여 줄 금고 항목. 비밀번호는 절대 내보내지 않는다 */
export interface VaultEntry {
  id: string
  origin: string
  username: string
  createdAt: string
  lastUsedAt?: string
}
