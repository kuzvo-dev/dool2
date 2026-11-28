// The brain-agnostic turn loop contract. Claude Code, Codex, and the pi fork all drive this same shape through a
// thin adapter (see @dool2/brains). The loop here defines the events a turn emits and the hooks a run can use;
// the real engine lives in the daemon, but the types are shared so every brain speaks the same language.

import type { ToolCall, ToolResult } from './tools.js'

/** Events a brain streams during one turn, converted by each adapter into this common shape. */
export type TurnEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; call: ToolCall }
  | { kind: 'turn_end'; stop: 'done' | 'tool' | 'error' | 'aborted' }

export interface TurnInput {
  /** The system prompt + skills already assembled for this turn. */
  system: string
  /** The running transcript the adapter will map to the brain's own format. */
  messages: { role: 'user' | 'assistant' | 'tool'; content: string }[]
}

/** How the daemon feeds tool results back and steers a run mid-turn. */
export interface RunHandle {
  /** Deliver the result of a tool the brain called. */
  toolResult(result: ToolResult): void
  /** Inject a message the user typed while the run was working (steering). */
  steer(text: string): void
  /** Stop the run. */
  abort(): void
}
