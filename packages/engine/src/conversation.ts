import type { AgentId, DaemonStreamEvent, StoredMessage } from '@dool2/protocol'
import type { Store, ThreadRecord } from '@dool2/store'
import type { ThreadService } from './threads.js'

/** 구간을 바꾸는 기준 (ADR 0015) */
export interface ConversationLimits {
  /** 사용자 차례 수 */
  turns: number
  /** 저장된 글자 수 */
  chars: number
  /** 마지막 말에서 이만큼 지나면 새 구간 (밀리초) */
  idleMs: number
}

export const DEFAULT_LIMITS: ConversationLimits = { turns: 40, chars: 60_000, idleMs: 12 * 60 * 60 * 1000 }

export type RotateReason = 'first' | 'agent' | 'idle' | 'long'

export interface ConversationOptions {
  store: Store
  threads: ThreadService
  limits?: Partial<ConversationLimits>
  now?: () => Date
}

/**
 * 두리와의 대화는 하나 (ADR 0015).
 * 대화는 구간(threads 표)들을 시간순으로 이은 것이고, 새 말은 지금 구간의 AI 세션으로 이어 간다.
 * 길어지거나 오래 쉬었거나 AI를 바꾸면 앞 구간을 닫고, 요약·최근 대화를 넘겨 새 구간을 연다.
 */
export class ConversationService {
  private readonly limits: ConversationLimits
  private readonly now: () => Date

  constructor(private readonly opts: ConversationOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits }
    this.now = opts.now ?? (() => new Date())
  }

  /** 지금 구간 */
  current(): ThreadRecord | undefined {
    return this.opts.store.currentSession()
  }

  /** 지금 구간이 답하는 중인지 (한 번에 한 차례) */
  isRunning(): boolean {
    const cur = this.current()
    return cur ? this.opts.threads.isRunning(cur.id) : false
  }

  cancel() {
    const cur = this.current()
    if (cur) this.opts.threads.cancel(cur.id)
  }

  /** 대화 기록: 모든 구간의 말을 시간순으로 */
  history(opts: { before?: string; limit?: number } = {}): StoredMessage[] {
    return this.opts.store.listConversation(opts)
  }

  /** 새 구간이 필요한지, 필요하면 그 이유 */
  needsRotate(agent: AgentId, cur = this.current()): RotateReason | undefined {
    if (!cur) return 'first'
    if (cur.agent !== agent) return 'agent'
    const size = this.opts.store.sessionSize(cur.id)
    if (size.turns === 0) return undefined
    if (this.now().getTime() - Date.parse(cur.updatedAt) > this.limits.idleMs) return 'idle'
    if (size.turns >= this.limits.turns || size.chars >= this.limits.chars) return 'long'
    return undefined
  }

  /**
   * 다음 말을 보낼 구간. 필요하면 앞 구간을 닫고 새 구간을 연다.
   * 길어서 바꿀 때만 AI에게 요약을 부탁한다 (쉬었거나 AI를 바꿀 때는 최근 대화만 넘긴다)
   */
  async prepare(agent: AgentId): Promise<{ session: ThreadRecord; rotated?: RotateReason }> {
    const { store, threads } = this.opts
    const cur = this.current()
    const reason = this.needsRotate(agent, cur)
    if (!reason && cur) return { session: cur }

    let carry: string | undefined
    if (cur) {
      const summary = reason === 'long' ? await threads.summarize(cur.id) : undefined
      store.closeSession(cur.id, summary)
      carry = buildCarry(cur, summary, store.listMessages(cur.id))
    }
    const next = store.createThread(agent, '새 대화', carry)
    store.closeOtherSessions(next.id)
    return { session: next, rotated: reason }
  }

  /** 사용자 말 하나를 지금 구간으로 보낸다 */
  async *send(agent: AgentId, text: string): AsyncGenerator<DaemonStreamEvent> {
    const { session } = await this.prepare(agent)
    yield* this.opts.threads.send(session.id, text)
  }
}

const CARRY_MAX = 6000

/** 새 구간의 지침에 붙일 "앞 대화에서 이어져요" 내용 */
export function buildCarry(
  prev: ThreadRecord,
  summary: string | undefined,
  messages: StoredMessage[],
): string | undefined {
  const recent = messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-8)
  const earlier = summary ?? prev.carry
  if (!recent.length && !earlier) return undefined
  const parts = [
    '[앞 대화에서 이어져요] 사용자와는 하나의 대화를 이어 가고 있어요. 사용자는 대화가 나뉜 줄 몰라요. 아래 내용을 기억한 채로 자연스럽게 이어서 답해 주세요.',
  ]
  if (summary) parts.push(`요약:\n${cut(summary, 2500)}`)
  else if (prev.carry)
    parts.push(`그 전 대화:\n${cut(prev.carry.replace(/^\[앞 대화에서 이어져요\][^\n]*\n?/, ''), 2500)}`)
  if (recent.length)
    parts.push(
      `최근 대화:\n${recent.map((m) => `${m.role === 'user' ? '사용자' : '두리'}: ${cut(m.text, 400)}`).join('\n')}`,
    )
  return cut(parts.join('\n\n'), CARRY_MAX)
}

function cut(text: string, max: number) {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
