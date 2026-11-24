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
  /**
   * Continue in a copy of the resumed session (summaries): the turn does not become part of the session the user keeps
   * talking in. Runtimes without copies ignore it
   */
  fork?: boolean
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

/** What a resident session is opened with: everything of a turn except the message (fixed for the session's life) */
export type SessionInput = Omit<TurnInput, 'text' | 'signal' | 'fork'>

/**
 * One agent program kept running for a conversation segment (ADR 0035). Messages go in one at a time; the program, its
 * tool server and its sign-in check are not started again for every message.
 */
export interface AgentSession {
  /** Whether the program is still running. A session that ended (crash, idle close) is opened again with resumeId */
  readonly alive: boolean
  /** One turn: sends the user's message and yields that turn's events until done or error */
  send(text: string, signal?: AbortSignal): AsyncIterable<AgentEvent>
  /** Ends the current turn now (the stop button). The session stays usable for the next message */
  interrupt(): void
  /** Ends the program */
  close(): Promise<void>
}

/**
 * Common interface for Claude Code and Codex.
 * Principle: run the official programs unmodified. Built-in tools like shell, files and web are turned off, leaving only Dool2 tools.
 */
export interface AgentRuntime {
  readonly id: AgentId
  detect(): Promise<AgentStatus>
  /** One turn in a fresh program (scheduled tasks, side chats, summaries, and runtimes without sessions) */
  runTurn(input: TurnInput): AsyncIterable<AgentEvent>
  /** Opens a resident session (optional). Undefined when it cannot (not installed): use runTurn, which explains why */
  openSession?(input: SessionInput): Promise<AgentSession | undefined>
}
