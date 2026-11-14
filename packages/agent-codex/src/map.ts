import type { AgentEvent, UsageLimit } from '@dool2/protocol'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null

/** 두리 도구만 허용한다. 이 밖의 일(셸·파일 수정·웹 검색)이 보이면 멈춘다. */
const UNSAFE_ITEMS = new Set([
  'commandExecution',
  'fileChange',
  'webSearch',
  'dynamicToolCall',
  'imageGeneration',
])

export interface MapResult {
  events: AgentEvent[]
  /** 턴이 끝났는지 */
  finished?: boolean
  /** 즉시 멈춰야 하는지 (안전 문제) */
  abort?: boolean
}

/** app-server 알림을 두리 공통 이벤트로 바꾼다. 한 턴에 하나씩 만든다. */
export class CodexEventMapper {
  private finalText = ''
  private streamed = ''

  constructor(private readonly threadId: string) {}

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
            message: `두리 도구가 아닌 기능(${item.type})을 쓰려고 해서 멈췄어요`,
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
              message: `두리 도구가 아닌 도구(${name})를 쓰려고 해서 멈췄어요`,
            },
          ],
        }
      }
      if (phase === 'started') return { events: [{ type: 'tool', name, input: item.arguments }] }
      return { events: [{ type: 'tool_result', name, ok: item.status === 'completed' }] }
    }
    if (item.type === 'agentMessage' && phase === 'completed' && typeof item.text === 'string') {
      this.finalText = this.finalText ? `${this.finalText}\n\n${item.text}` : item.text
      // 델타 없이 완성본만 온 경우
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
        events: [
          { type: 'limit_reached', message: 'ChatGPT 사용량이 다 찼어요. 한도가 풀리면 다시 할게요.' },
        ],
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
            message: 'ChatGPT 로그인이 필요해요. PC에서 다시 로그인해 주세요.',
          },
        ],
      }
    }
    return {
      events: [
        {
          type: 'error',
          code: 'process_failed',
          message: `Codex가 일을 끝내지 못했어요${msg ? `: ${msg.slice(0, 200)}` : ''}`,
        },
      ],
    }
  }

  private onTurnCompleted(params: Json): MapResult {
    const turn = isObj(params.turn) ? params.turn : {}
    if (turn.status === 'completed') {
      return {
        finished: true,
        events: [{ type: 'done', resumeId: this.threadId, text: this.finalText || this.streamed }],
      }
    }
    if (turn.status === 'interrupted') {
      return { finished: true, events: [{ type: 'error', code: 'aborted', message: '멈췄어요' }] }
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
