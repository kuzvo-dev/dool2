// Convert Claude Code's `--output-format stream-json` lines into the shared TurnEvent shape. The event names are the
// CLI's own (verified against Claude Code 2.x): `system` (init), `stream_event` (realtime content deltas),
// `assistant` (a full assistant message with text and/or tool_use blocks), `user` (tool results — the daemon owns
// those, so they are ignored), and `result` (the turn's end).
//
// v2 is one turn per run (like @dool2/brain-pi): the moment Claude asks for a tool, the adapter emits the tool_call
// and ends the turn with stop 'tool'. The daemon runs the tool, appends the result to the transcript, and calls
// run() again. A plain answer ends at the `result` line with stop 'done'.

import type { CliExit, CliStreamParser, MakeParserOptions } from '@dool2/brain-cli-util'
import type { ToolCall, ToolName, TurnEvent } from '@dool2/core'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null

class ClaudeParser implements CliStreamParser {
  /** Realtime text deltas already streamed, so the final assistant text block is not emitted twice. */
  private sawTextDelta = false
  private toolCalls = 0
  /** When tools are serviced by an attached MCP server, a tool-use does not end the turn — the CLI keeps running. */
  private readonly toolsViaMcp: boolean

  constructor(opts?: MakeParserOptions) {
    this.toolsViaMcp = opts?.toolsViaMcp === true
  }

  push(line: unknown): TurnEvent[] {
    if (!isObj(line)) return []
    switch (line.type) {
      case 'stream_event':
        return this.onStreamEvent(line)
      case 'assistant':
        return this.onAssistant(line)
      case 'result':
        return this.onResult(line)
      // 'system' (init / retries) and 'user' (tool results fed back) carry nothing for the turn stream.
      default:
        return []
    }
  }

  end(exit: CliExit): TurnEvent[] {
    // The stream closed without a `result`: a nonzero exit (or spawn error, code -1) is an error; a clean exit that
    // nonetheless produced a tool call ends as 'tool' (legacy) — but when MCP serviced the calls inline, the CLI
    // completed the whole turn itself, so a clean exit is 'done'.
    if (exit.code !== 0 && exit.code !== null) return [{ kind: 'turn_end', stop: 'error' }]
    return [{ kind: 'turn_end', stop: this.terminalStop() }]
  }

  /** The clean-exit terminal stop: 'done' when tools round-trip over MCP, else 'tool' if a call was seen. */
  private terminalStop(): 'done' | 'tool' {
    return !this.toolsViaMcp && this.toolCalls > 0 ? 'tool' : 'done'
  }

  private onStreamEvent(msg: Json): TurnEvent[] {
    const ev = msg.event
    if (!isObj(ev) || ev.type !== 'content_block_delta' || !isObj(ev.delta)) return []
    const d = ev.delta
    if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
      this.sawTextDelta = true
      return [{ kind: 'text', text: d.text }]
    }
    if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
      return [{ kind: 'thinking', text: d.thinking }]
    }
    return []
  }

  private onAssistant(msg: Json): TurnEvent[] {
    const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : []
    const out: TurnEvent[] = []
    for (const block of content) {
      if (!isObj(block)) continue
      if (block.type === 'text' && typeof block.text === 'string' && !this.sawTextDelta && block.text) {
        out.push({ kind: 'text', text: block.text })
      }
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const call: ToolCall = {
          id: typeof block.id === 'string' ? block.id : '',
          name: block.name as ToolName,
          args: 'input' in block ? block.input : {},
        }
        this.toolCalls++
        if (this.toolsViaMcp) {
          // The MCP server services the call inline; record it for the transcript and keep reading — the CLI runs the
          // tool over MCP and continues in the same process until its own `result` ends the turn.
          out.push({ kind: 'tool_call', call, serviced: true })
          continue
        }
        out.push({ kind: 'tool_call', call })
        // Legacy path (no MCP): one turn per run — hand control back so the daemon runs the tool and re-invokes.
        out.push({ kind: 'turn_end', stop: 'tool' })
        break
      }
    }
    return out
  }

  private onResult(msg: Json): TurnEvent[] {
    const isError =
      msg.is_error === true ||
      (typeof msg.subtype === 'string' && msg.subtype !== 'success' && msg.subtype.startsWith('error'))
    if (isError) return [{ kind: 'turn_end', stop: 'error' }]
    return [{ kind: 'turn_end', stop: this.terminalStop() }]
  }
}

/** A fresh parser for one Claude turn. */
export const makeClaudeParser = (opts?: MakeParserOptions): CliStreamParser => new ClaudeParser(opts)
