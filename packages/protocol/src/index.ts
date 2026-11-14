// 두리 공통 타입: 에이전트 이벤트, 대화, 데몬 API.
// 폰↔PC 암호화 규약은 M2에서 이 패키지에 추가한다.
import { z } from 'zod'

/** 두리가 실행할 수 있는 AI. 사용자의 구독으로 돈다. */
export const AgentIdSchema = z.enum(['claude', 'codex'])
export type AgentId = z.infer<typeof AgentIdSchema>

export const AGENT_LABEL: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
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

/** 데몬이 SSE로 흘려보내는 이벤트 */
export type DaemonStreamEvent =
  | { type: 'agent'; event: AgentEvent }
  | { type: 'saved'; message: StoredMessage }
  | { type: 'end' }
