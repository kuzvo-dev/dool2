import type { AgentEvent, AgentId, AgentStatus } from '@dool2/protocol'

/** MCP server attached to the agent (Dool2 tools). Started over stdio. */
export interface McpServerSpec {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface TurnInput {
  /** What the user sent */
  text: string
  /** Resume id from the previous turn (Claude session id, Codex thread id) */
  resumeId?: string
  /** Dool2's instructions. Appended after the agent's default prompt */
  systemPrompt: string
  /** Dool2 tools. The agent can use only these */
  mcpServers: McpServerSpec[]
  /** Dool2's own working folder. Not where the user's files are */
  cwd: string
  /** Model to use (for Claude, an alias like sonnet, opus or haiku). Each agent's default when missing */
  model?: string
  signal?: AbortSignal
}

/**
 * Common interface for Claude Code and Codex.
 * Principle: run the official programs unmodified. Built-in tools like shell, files and web are turned off, leaving only Dool2 tools.
 */
export interface AgentRuntime {
  readonly id: AgentId
  detect(): Promise<AgentStatus>
  runTurn(input: TurnInput): AsyncIterable<AgentEvent>
}
