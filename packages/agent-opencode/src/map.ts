// Turns OpenCode v2 server events (`GET /api/event`, SSE) into Dool2's common AgentEvent.
// Event shapes were checked against OpenCode v2.3.0 schema/session-event.ts and real output.
import type { Lang } from '@dool2/i18n'
import type { AgentEvent } from '@dool2/protocol'
import { DOOL2_TOOL_PREFIX } from './config.js'
import { OPENCODE_TEXT, type OpenCodeText } from './locales/opencode.js'

export interface OpenCodeEvent {
  type: string
  data?: Record<string, unknown>
}

interface StructuredError {
  type?: string
  message?: string
  status?: number
  retryAfterMs?: number
}

export interface MapResult {
  events: AgentEvent[]
  /** The turn is over */
  finished?: boolean
  /** It tried to use a tool other than Dool2's, so stop right away */
  abort?: boolean
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Turns an error into plain words and a common error code */
export function mapError(err: StructuredError | undefined, lang: Lang = 'ko'): AgentEvent {
  const t = OPENCODE_TEXT[lang]
  const type = err?.type ?? ''
  const status = err?.status ?? 0
  if (status === 401 || status === 403 || /auth/.test(type))
    return {
      type: 'error',
      code: 'not_logged_in',
      message: t.badKey,
    }
  if (status === 402 || /credit|billing|quota|insufficient/i.test(`${type} ${err?.message ?? ''}`))
    return {
      type: 'limit_reached',
      message: t.noCredit,
    }
  if (status === 429 || /rate|limit/.test(type)) {
    const resetsAt = err?.retryAfterMs ? new Date(Date.now() + err.retryAfterMs).toISOString() : undefined
    return {
      type: 'limit_reached',
      message: t.tooMany,
      ...(resetsAt ? { resetsAt } : {}),
    }
  }
  return {
    type: 'error',
    code: 'process_failed',
    message: t.noAnswer(err?.message ? err.message.slice(0, 200) : ''),
  }
}

export class OpenCodeEventMapper {
  private text = ''
  private toolNames = new Map<string, string>()
  private reported = false
  private contextTokens = 0

  private readonly t: OpenCodeText
  /** lang: language of the error messages people see */
  constructor(
    private readonly sessionId: string,
    private readonly lang: Lang = 'ko',
  ) {
    this.t = OPENCODE_TEXT[lang]
  }

  map(ev: OpenCodeEvent): MapResult {
    const d = ev.data ?? {}
    if (d.sessionID !== undefined && d.sessionID !== this.sessionId) return { events: [] }
    switch (ev.type) {
      case 'session.execution.started':
        return { events: [{ type: 'started', resumeId: this.sessionId, tools: [] }] }
      case 'session.text.delta': {
        const delta = typeof d.delta === 'string' ? d.delta : ''
        this.text += delta
        return { events: delta ? [{ type: 'text', delta }] : [] }
      }
      case 'session.tool.input.started': {
        const id = String(d.id ?? '')
        const name = String(d.name ?? '')
        this.toolNames.set(id, name)
        if (!name.startsWith(DOOL2_TOOL_PREFIX))
          return {
            events: [
              {
                type: 'error',
                code: 'tools_unsafe',
                message: this.t.unsafeTool(name),
              },
            ],
            abort: true,
            finished: true,
          }
        return { events: [] }
      }
      case 'session.tool.called': {
        const name = this.toolNames.get(String(d.id ?? '')) ?? ''
        return { events: [{ type: 'tool', name, input: d.input ?? {} }] }
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const name = this.toolNames.get(String(d.id ?? ''))
        return {
          events: [
            { type: 'tool_result', ...(name ? { name } : {}), ok: ev.type === 'session.tool.success' },
          ],
        }
      }
      case 'session.step.ended': {
        const tokens = (d.tokens ?? {}) as {
          input?: number
          output?: number
          cache?: { read?: number; write?: number }
        }
        // A step's (one AI call's) input excludes the cache, so cache reads and writes are added to get the session size.
        // The last step's value is reported once at the end of the turn
        const size = num(tokens.input) + num(tokens.cache?.read) + num(tokens.cache?.write)
        if (size > 0) this.contextTokens = size
        return {
          events: [
            {
              type: 'cost',
              usd: num(d.cost),
              inputTokens: num(tokens.input),
              outputTokens: num(tokens.output),
            },
          ],
        }
      }
      case 'session.execution.succeeded': {
        const done: AgentEvent = { type: 'done', resumeId: this.sessionId, text: this.text }
        return {
          events: this.contextTokens ? [{ type: 'context', tokens: this.contextTokens }, done] : [done],
          finished: true,
        }
      }
      case 'session.execution.failed':
      case 'session.step.failed': {
        // A step failure is followed by an execution failure. Report only once
        if (this.reported) return { events: [], finished: ev.type === 'session.execution.failed' }
        this.reported = true
        return {
          events: [mapError(d.error as StructuredError, this.lang)],
          finished: ev.type === 'session.execution.failed',
        }
      }
      case 'session.execution.interrupted':
        return { events: [{ type: 'error', code: 'aborted', message: this.t.stopped }], finished: true }
      default:
        return { events: [] }
    }
  }
}
