import type { Lang } from '@dool2/i18n'
import type { AgentEvent, UsageLimit } from '@dool2/protocol'
import { CLAUDE_TEXT, type ClaudeText } from './locales/claude.js'

/** Prefix of Dool2 tool names. Any other tool is treated as unsafe. */
export const DOOL2_TOOL_PREFIX = 'mcp__dool2__'

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Takes the output of `claude -p --output-format stream-json --verbose --include-partial-messages`
 * line by line and turns it into Dool2's common events.
 */
export class ClaudeStreamParser {
  private readonly t: ClaudeText
  /** lang: language of the error messages people see */
  constructor(lang: Lang = 'ko') {
    this.t = CLAUDE_TEXT[lang]
  }

  private readonly toolNames = new Map<string, string>()
  private sawDelta = false
  private sessionId: string | undefined
  private contextTokens = 0
  /** The turn's first AI call: all input and the part read from cache (ADR 0032) */
  private first?: { input: number; cached: number }

  push(line: string): AgentEvent[] {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return []
    }
    if (!isObj(msg)) return []
    if (typeof msg.session_id === 'string') this.sessionId = msg.session_id

    switch (msg.type) {
      case 'system':
        return this.onSystem(msg)
      case 'stream_event':
        return this.onStreamEvent(msg)
      case 'assistant':
        return this.onAssistant(msg)
      case 'user':
        return this.onUser(msg)
      case 'rate_limit_event':
        return onRateLimit(msg, this.t)
      case 'result':
        return this.onResult(msg)
      default:
        return []
    }
  }

  private onSystem(msg: Json): AgentEvent[] {
    if (msg.subtype === 'init') {
      const tools = Array.isArray(msg.tools)
        ? msg.tools.filter((t): t is string => typeof t === 'string')
        : []
      const unsafe = tools.filter((t) => !t.startsWith(DOOL2_TOOL_PREFIX))
      const started: AgentEvent = {
        type: 'started',
        tools,
        ...(this.sessionId ? { resumeId: this.sessionId } : {}),
        ...(typeof msg.model === 'string' ? { model: msg.model } : {}),
      }
      if (unsafe.length > 0) {
        return [
          started,
          {
            type: 'error',
            code: 'tools_unsafe',
            message: this.t.toolsUnsafe(unsafe.join(', ')),
          },
        ]
      }
      return [started]
    }
    if (msg.subtype === 'api_retry' && msg.error === 'authentication_failed') {
      return [
        {
          type: 'error',
          code: 'not_logged_in',
          message: this.t.loginAgain,
        },
      ]
    }
    return []
  }

  private onStreamEvent(msg: Json): AgentEvent[] {
    const ev = msg.event
    if (!isObj(ev) || ev.type !== 'content_block_delta' || !isObj(ev.delta)) return []
    if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
      this.sawDelta = true
      return [{ type: 'text', delta: ev.delta.text }]
    }
    return []
  }

  private onAssistant(msg: Json): AgentEvent[] {
    // Usage arrives with every AI call. The last call's input tokens (cache included) are the session's current size.
    // The usage in result is the sum over calls, so it must not be used as the size
    if (isObj(msg.message) && isObj(msg.message.usage) && typeof msg.parent_tool_use_id !== 'string') {
      const u = msg.message.usage
      const tokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
      if (tokens > 0) this.contextTokens = tokens
      if (tokens > 0 && !this.first) this.first = { input: tokens, cached: num(u.cache_read_input_tokens) }
    }
    const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : []
    const out: AgentEvent[] = []
    for (const block of content) {
      if (!isObj(block)) continue
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        if (typeof block.id === 'string') this.toolNames.set(block.id, block.name)
        out.push({ type: 'tool', name: block.name, input: block.input })
      }
      // Skip when partial messages already came, since the same text arrives again
      if (block.type === 'text' && typeof block.text === 'string' && !this.sawDelta) {
        out.push({ type: 'text', delta: block.text })
      }
    }
    return out
  }

  private onUser(msg: Json): AgentEvent[] {
    const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : []
    const out: AgentEvent[] = []
    for (const block of content) {
      if (!isObj(block) || block.type !== 'tool_result') continue
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
      const name = id ? this.toolNames.get(id) : undefined
      out.push({ type: 'tool_result', ok: block.is_error !== true, ...(name ? { name } : {}) })
    }
    return out
  }

  private onResult(msg: Json): AgentEvent[] {
    const text = typeof msg.result === 'string' ? msg.result : ''
    if (msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error'))) {
      const lower = text.toLowerCase()
      const code = lower.includes('login') || lower.includes('api key') ? 'not_logged_in' : 'process_failed'
      return [
        {
          type: 'error',
          code,
          message:
            code === 'not_logged_in' ? this.t.loginAgain : this.t.unfinished(text ? text.slice(0, 200) : ''),
        },
      ]
    }
    const done: AgentEvent = { type: 'done', text, ...(this.sessionId ? { resumeId: this.sessionId } : {}) }
    return this.contextTokens
      ? [
          {
            type: 'context',
            tokens: this.contextTokens,
            ...(this.first ? { firstInput: this.first.input, firstCached: this.first.cached } : {}),
          },
          done,
        ]
      : [done]
  }
}

function onRateLimit(msg: Json, t: ClaudeText): AgentEvent[] {
  const info = msg.rate_limit_info
  if (!isObj(info)) return []
  const limits: UsageLimit[] = []
  if (isObj(info.unifiedWindows)) {
    for (const [kind, w] of Object.entries(info.unifiedWindows)) {
      if (!isObj(w) || typeof w.utilization !== 'number') continue
      limits.push({
        kind,
        percent: Math.round(w.utilization * 100),
        ...(typeof w.resetsAt === 'number' ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}),
      })
    }
  }
  const out: AgentEvent[] = []
  if (limits.length) out.push({ type: 'usage', limits })
  if (info.status === 'rejected') {
    const resetsAt =
      typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : undefined
    out.push({
      type: 'limit_reached',
      message: t.limit,
      ...(resetsAt ? { resetsAt } : {}),
    })
  }
  return out
}
