import type { AgentEvent, UsageLimit } from '@dool2/protocol'

/** 두리 도구 이름 앞부분. 이 밖의 도구가 보이면 위험으로 본다. */
export const DOOL2_TOOL_PREFIX = 'mcp__dool2__'

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null

/**
 * `claude -p --output-format stream-json --verbose --include-partial-messages` 출력을
 * 한 줄씩 받아 두리 공통 이벤트로 바꾼다.
 */
export class ClaudeStreamParser {
  private readonly toolNames = new Map<string, string>()
  private sawDelta = false
  private sessionId: string | undefined

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
        return onRateLimit(msg)
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
            message: `두리 도구가 아닌 도구가 켜져 있어서 멈췄어요: ${unsafe.join(', ')}`,
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
          message: 'Claude 로그인이 필요해요. PC에서 다시 로그인해 주세요.',
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
    const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : []
    const out: AgentEvent[] = []
    for (const block of content) {
      if (!isObj(block)) continue
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        if (typeof block.id === 'string') this.toolNames.set(block.id, block.name)
        out.push({ type: 'tool', name: block.name, input: block.input })
      }
      // 부분 메시지를 받았으면 같은 글이 또 오므로 건너뛴다
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
            code === 'not_logged_in'
              ? 'Claude 로그인이 필요해요. PC에서 다시 로그인해 주세요.'
              : `Claude Code가 일을 끝내지 못했어요${text ? `: ${text.slice(0, 200)}` : ''}`,
        },
      ]
    }
    return [{ type: 'done', text, ...(this.sessionId ? { resumeId: this.sessionId } : {}) }]
  }
}

function onRateLimit(msg: Json): AgentEvent[] {
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
      message: 'Claude 사용량이 다 찼어요. 한도가 풀리면 다시 할게요.',
      ...(resetsAt ? { resetsAt } : {}),
    })
  }
  return out
}
