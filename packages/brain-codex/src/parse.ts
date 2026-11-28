// Convert Codex's `exec --json` event stream into the shared TurnEvent shape. Codex prints one EventMsg per line,
// wrapped as `{ id, msg: { type, ... } }` (newer builds may print the inner `{ type, ... }` directly, so this unwraps
// `msg` when present). The msg types used here — `agent_message_delta`, `agent_reasoning_delta`, `agent_message`,
// `mcp_tool_call_begin`, `task_complete`, `error` — are Codex's own, verified against the pinned build.
//
// v2 is one turn per run (like @dool2/brain-pi): when Codex calls a tool the adapter emits the tool_call and ends the
// turn with stop 'tool'; the daemon runs the tool, appends the result, and calls run() again. A plain answer ends at
// `task_complete` with stop 'done'.

import type { CliExit, CliStreamParser, MakeParserOptions } from '@dool2/brain-cli-util'
import type { ToolCall, ToolName, TurnEvent } from '@dool2/core'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null

class CodexParser implements CliStreamParser {
  private sawTextDelta = false
  private toolCalls = 0
  /** When tools are serviced by an attached MCP server, a tool call does not end the turn — Codex keeps running. */
  private readonly toolsViaMcp: boolean

  constructor(opts?: MakeParserOptions) {
    this.toolsViaMcp = opts?.toolsViaMcp === true
  }

  push(line: unknown): TurnEvent[] {
    if (!isObj(line)) return []
    // Unwrap the `{ id, msg: {...} }` envelope; tolerate a bare `{ type, ... }` event too.
    const msg = isObj(line.msg) ? line.msg : line
    switch (msg.type) {
      case 'agent_message_delta':
        return this.textDelta(msg.delta)
      case 'agent_reasoning_delta':
        return this.thinkingDelta(msg.delta)
      case 'agent_message':
        // The final assistant message; skip it if realtime deltas already carried the text.
        if (this.sawTextDelta) return []
        return this.textDelta(msg.message ?? msg.text)
      case 'mcp_tool_call_begin':
        return this.onToolCall(msg)
      case 'task_complete':
        return [{ kind: 'turn_end', stop: this.terminalStop() }]
      case 'error':
        return [{ kind: 'turn_end', stop: 'error' }]
      // task_started, token_count, mcp_tool_call_end, exec_command_* and the rest carry nothing for the turn stream.
      default:
        return []
    }
  }

  end(exit: CliExit): TurnEvent[] {
    if (exit.code !== 0 && exit.code !== null) return [{ kind: 'turn_end', stop: 'error' }]
    return [{ kind: 'turn_end', stop: this.terminalStop() }]
  }

  /** The clean-exit terminal stop: 'done' when tools round-trip over MCP, else 'tool' if a call was seen. */
  private terminalStop(): 'done' | 'tool' {
    return !this.toolsViaMcp && this.toolCalls > 0 ? 'tool' : 'done'
  }

  private textDelta(v: unknown): TurnEvent[] {
    if (typeof v !== 'string' || !v) return []
    this.sawTextDelta = true
    return [{ kind: 'text', text: v }]
  }

  private thinkingDelta(v: unknown): TurnEvent[] {
    if (typeof v !== 'string' || !v) return []
    return [{ kind: 'thinking', text: v }]
  }

  private onToolCall(msg: Json): TurnEvent[] {
    // Codex reports an MCP tool call as `invocation: { server, tool, arguments }` with a `call_id`.
    const inv = isObj(msg.invocation) ? msg.invocation : msg
    const name = typeof inv.tool === 'string' ? inv.tool : 'code'
    const call: ToolCall = {
      id: typeof msg.call_id === 'string' ? msg.call_id : typeof msg.id === 'string' ? msg.id : '',
      name: name as ToolName,
      args: 'arguments' in inv ? inv.arguments : {},
    }
    this.toolCalls++
    if (this.toolsViaMcp) {
      // Codex called the tool over the attached MCP server; record it and keep reading until `task_complete`.
      return [{ kind: 'tool_call', call, serviced: true }]
    }
    // Legacy path: one turn per run — hand control back so the daemon runs the tool and re-invokes.
    return [
      { kind: 'tool_call', call },
      { kind: 'turn_end', stop: 'tool' },
    ]
  }
}

/** A fresh parser for one Codex turn. */
export const makeCodexParser = (opts?: MakeParserOptions): CliStreamParser => new CodexParser(opts)
