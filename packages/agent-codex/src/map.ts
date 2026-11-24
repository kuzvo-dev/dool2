import type { Lang } from '@dool2/i18n'
import { type AgentEvent, resultChars, type UsageLimit } from '@dool2/protocol'
import { CODEX_TEXT, type CodexText } from './locales/codex.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null

/** Only Dool2 tools are allowed. Anything else (shell, file changes, web search) stops the turn. */
const UNSAFE_ITEMS = new Set([
  'commandExecution',
  'fileChange',
  'webSearch',
  'dynamicToolCall',
  'imageGeneration',
])

export interface MapResult {
  events: AgentEvent[]
  /** Whether the turn is over */
  finished?: boolean
  /** Whether to stop right away (a safety problem) */
  abort?: boolean
}

/** Turns app-server notifications into Dool2's common events. One per turn. */
export class CodexEventMapper {
  private finalText = ''
  private streamed = ''
  private contextTokens = 0

  private readonly t: CodexText
  /** lang: language of the error messages people see */
  constructor(
    private readonly threadId: string,
    lang: Lang = 'ko',
  ) {
    this.t = CODEX_TEXT[lang]
  }

  map(method: string, params: Json): MapResult {
    if (typeof params.threadId === 'string' && params.threadId !== this.threadId) return { events: [] }
    switch (method) {
      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string' && params.delta) {
          this.streamed += params.delta
          return { events: [{ type: 'text', delta: params.delta }] }
        }
        return { events: [] }
      case 'item/started':
        return this.onItem(params.item, 'started')
      case 'item/completed':
        return this.onItem(params.item, 'completed')
      case 'account/rateLimits/updated':
        return { events: rateLimitEvents(params.rateLimits) }
      case 'thread/tokenUsage/updated': {
        // last = usage of the last AI call. Its input tokens (cached ones included) are the session's current size.
        // total is summed over the turn, so it isn't used as the size. Reported once when the turn ends
        const usage = isObj(params.tokenUsage) ? params.tokenUsage : {}
        const last = isObj(usage.last) ? usage.last : {}
        if (typeof last.inputTokens === 'number' && last.inputTokens > 0)
          this.contextTokens = last.inputTokens
        return { events: [] }
      }
      case 'error':
        return this.onError(params)
      case 'turn/completed':
        return this.onTurnCompleted(params)
      default:
        return { events: [] }
    }
  }

  private onItem(item: unknown, phase: 'started' | 'completed'): MapResult {
    if (!isObj(item) || typeof item.type !== 'string') return { events: [] }
    if (UNSAFE_ITEMS.has(item.type)) {
      return {
        abort: true,
        events: [
          {
            type: 'error',
            code: 'tools_unsafe',
            message: this.t.unsafeItem(String(item.type)),
          },
        ],
      }
    }
    if (item.type === 'mcpToolCall' && typeof item.server === 'string' && typeof item.tool === 'string') {
      const name = `mcp__${item.server}__${item.tool}`
      if (item.server !== 'dool2') {
        return {
          abort: true,
          events: [
            {
              type: 'error',
              code: 'tools_unsafe',
              message: this.t.unsafeTool(String(name)),
            },
          ],
        }
      }
      if (phase === 'started') return { events: [{ type: 'tool', name, input: item.arguments }] }
      // The text the tool gave back (result.content), or the error message when it failed
      const chars = isObj(item.result)
        ? resultChars(item.result.content)
        : isObj(item.error) && typeof item.error.message === 'string'
          ? item.error.message.length
          : undefined
      return {
        events: [
          {
            type: 'tool_result',
            name,
            ok: item.status === 'completed',
            ...(chars !== undefined ? { chars } : {}),
          },
        ],
      }
    }
    if (item.type === 'agentMessage' && phase === 'completed' && typeof item.text === 'string') {
      this.finalText = this.finalText ? `${this.finalText}\n\n${item.text}` : item.text
      // Only the finished text came, without deltas
      if (!this.streamed) return { events: [{ type: 'text', delta: item.text }] }
    }
    return { events: [] }
  }

  private onError(params: Json): MapResult {
    if (params.willRetry === true) return { events: [] }
    const err = isObj(params.error) ? params.error : {}
    const info = err.codexErrorInfo
    const msg = typeof err.message === 'string' ? err.message : ''
    if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded') {
      return {
        events: [{ type: 'limit_reached', message: this.t.limit }],
      }
    }
    const httpStatus = isObj(info)
      ? Object.values(info).find((v): v is Json => isObj(v) && typeof v.httpStatusCode === 'number')
          ?.httpStatusCode
      : undefined
    if (info === 'unauthorized' || httpStatus === 401 || /\b401\b|unauthorized/i.test(msg)) {
      return {
        events: [
          {
            type: 'error',
            code: 'not_logged_in',
            message: this.t.loginAgain,
          },
        ],
      }
    }
    return {
      events: [
        {
          type: 'error',
          code: 'process_failed',
          message: this.t.unfinished(msg ? msg.slice(0, 200) : ''),
        },
      ],
    }
  }

  private onTurnCompleted(params: Json): MapResult {
    const turn = isObj(params.turn) ? params.turn : {}
    if (turn.status === 'completed') {
      const done: AgentEvent = {
        type: 'done',
        resumeId: this.threadId,
        text: this.finalText || this.streamed,
      }
      return {
        finished: true,
        events: this.contextTokens ? [{ type: 'context', tokens: this.contextTokens }, done] : [done],
      }
    }
    if (turn.status === 'interrupted') {
      return { finished: true, events: [{ type: 'error', code: 'aborted', message: this.t.stopped }] }
    }
    return { finished: true, events: [] }
  }
}

export function rateLimitEvents(snapshot: unknown): AgentEvent[] {
  if (!isObj(snapshot)) return []
  const limits: UsageLimit[] = []
  for (const key of ['primary', 'secondary'] as const) {
    const w = snapshot[key]
    if (!isObj(w) || typeof w.usedPercent !== 'number') continue
    const mins = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : undefined
    limits.push({
      kind: mins ? windowName(mins) : key,
      percent: Math.round(w.usedPercent),
      ...(typeof w.resetsAt === 'number' ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}),
    })
  }
  return limits.length ? [{ type: 'usage', limits }] : []
}

function windowName(mins: number) {
  if (mins === 300) return 'five_hour'
  if (mins === 10080) return 'seven_day'
  return `${mins}m`
}
