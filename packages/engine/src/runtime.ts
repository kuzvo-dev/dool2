import type { AgentEvent, AgentId, AgentStatus } from '@dool2/protocol'

/** 에이전트에게 붙일 MCP 서버 (두리 도구). stdio로 띄운다. */
export interface McpServerSpec {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface TurnInput {
  /** 사용자가 보낸 글 */
  text: string
  /** 이전 턴에서 받은 이어 하기 id (Claude 세션 id, Codex 스레드 id) */
  resumeId?: string
  /** 두리 지침. 에이전트 기본 프롬프트 뒤에 붙는다 */
  systemPrompt: string
  /** 두리 도구. 에이전트는 이 도구만 쓸 수 있다 */
  mcpServers: McpServerSpec[]
  /** 두리 전용 작업 폴더. 사용자 파일이 있는 곳이 아니다 */
  cwd: string
  /** 쓸 모델 (Claude: sonnet·opus·haiku 같은 별칭). 없으면 에이전트별 기본값 */
  model?: string
  signal?: AbortSignal
}

/**
 * Claude Code·Codex 공통 인터페이스.
 * 원칙: 공식 프로그램을 수정 없이 실행만 한다. 셸·파일·웹 같은 내장 도구는 끄고 두리 도구만 남긴다.
 */
export interface AgentRuntime {
  readonly id: AgentId
  detect(): Promise<AgentStatus>
  runTurn(input: TurnInput): AsyncIterable<AgentEvent>
}
