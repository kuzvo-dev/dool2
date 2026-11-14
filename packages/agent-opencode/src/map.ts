// OpenCode v2 서버 사건(`GET /api/event`, SSE)을 두리 공통 AgentEvent로 바꾼다.
// 사건 모양은 OpenCode v2.3.0 schema/session-event.ts와 실제 출력으로 확인했다.
import type { AgentEvent } from '@dool2/protocol'
import { DOOL2_TOOL_PREFIX } from './config.js'

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
  /** 이 턴이 끝났다 */
  finished?: boolean
  /** 두리 도구가 아닌 도구를 쓰려 해서 바로 멈춰야 한다 */
  abort?: boolean
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 오류를 사람 말과 공통 오류 코드로 바꾼다 */
export function mapError(err: StructuredError | undefined): AgentEvent {
  const type = err?.type ?? ''
  const status = err?.status ?? 0
  if (status === 401 || status === 403 || /auth/.test(type))
    return {
      type: 'error',
      code: 'not_logged_in',
      message: 'API 키가 맞지 않아요. 설정에서 키를 다시 넣어 주세요',
    }
  if (status === 402 || /credit|billing|quota|insufficient/i.test(`${type} ${err?.message ?? ''}`))
    return {
      type: 'limit_reached',
      message: 'AI 제공자 계정의 잔액이나 한도가 부족해요. 제공자 사이트에서 확인해 주세요',
    }
  if (status === 429 || /rate|limit/.test(type)) {
    const resetsAt = err?.retryAfterMs ? new Date(Date.now() + err.retryAfterMs).toISOString() : undefined
    return {
      type: 'limit_reached',
      message: '요청이 너무 많아 잠시 쉬어야 해요',
      ...(resetsAt ? { resetsAt } : {}),
    }
  }
  return {
    type: 'error',
    code: 'process_failed',
    message: `AI가 답하지 못했어요${err?.message ? `: ${err.message.slice(0, 200)}` : ''}`,
  }
}

export class OpenCodeEventMapper {
  private text = ''
  private toolNames = new Map<string, string>()
  private reported = false

  constructor(private readonly sessionId: string) {}

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
                message: `두리 도구가 아닌 도구를 쓰려 해서 멈췄어요: ${name}`,
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
        const tokens = (d.tokens ?? {}) as { input?: number; output?: number }
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
      case 'session.execution.succeeded':
        return { events: [{ type: 'done', resumeId: this.sessionId, text: this.text }], finished: true }
      case 'session.execution.failed':
      case 'session.step.failed': {
        // 단계 실패 다음에 실행 실패가 한 번 더 온다. 한 번만 알린다
        if (this.reported) return { events: [], finished: ev.type === 'session.execution.failed' }
        this.reported = true
        return {
          events: [mapError(d.error as StructuredError)],
          finished: ev.type === 'session.execution.failed',
        }
      }
      case 'session.execution.interrupted':
        return { events: [{ type: 'error', code: 'aborted', message: '멈췄어요' }], finished: true }
      default:
        return { events: [] }
    }
  }
}
