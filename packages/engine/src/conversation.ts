import type { AgentId, DaemonStreamEvent, StoredMessage } from '@dool2/protocol'
import { APP_NOTE } from '@dool2/protocol/rich'
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
  /**
   * AI가 마지막 차례에 실제로 읽은 토큰 수. 브라우저 페이지 같은 도구 결과는 저장된 글자 수에 안 잡혀서,
   * 웹 일이 많은 구간은 차례·글자 기준보다 훨씬 먼저 느려지고 사용량이 커진다
   */
  contextTokens: number
}

export const DEFAULT_LIMITS: ConversationLimits = {
  turns: 40,
  chars: 60_000,
  idleMs: 12 * 60 * 60 * 1000,
  contextTokens: 120_000,
}

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

  /** 미리 시작한 요약 (구간 id → 요약) */
  private readonly early = new Map<string, Promise<string | undefined>>()
  /**
   * 답이 끝난 뒤 부른다. 다음 말에서 길어서 구간을 바꿀 참이면 요약을 미리 시작해 둔다.
   * 예전에는 다음 말을 받고 나서야 요약을 부탁해서, 그동안(10초 남짓) 말이 저장되지도 않고 아무 반응이 없었다
   */
  prewarm() {
    const cur = this.current()
    if (!cur || this.early.has(cur.id) || this.needsRotate(cur.agent, cur) !== 'long') return
    this.early.set(
      cur.id,
      this.opts.threads.summarize(cur.id).catch(() => undefined),
    )
  }

  /** 다음 말부터 새 구간으로 (두리 말투 설정을 바꿨을 때: 앞 대화의 말투를 따라가지 않게) */
  private rotateNext = false
  private rotateNote = ''
  rotateSoon(note = '') {
    this.rotateNext = true
    this.rotateNote = note
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
    if (this.rotateNext) return 'idle'
    if (this.now().getTime() - Date.parse(cur.updatedAt) > this.limits.idleMs) return 'idle'
    if (
      size.turns >= this.limits.turns ||
      size.chars >= this.limits.chars ||
      size.contextTokens >= this.limits.contextTokens
    )
      return 'long'
    return undefined
  }

  /**
   * 지난 대화 찾기 (conversation_search 도구). 요약에서 빠진 앞 구간의 말을 AI가 다시 찾아본다.
   * 지금 구간의 말은 AI가 이미 알고 있으니 뺀다 (방금 한 질문이 맨 위에 걸리지 않게)
   */
  search(query: string, limit = 10): string {
    const q = query.replace(/\s+/g, ' ').trim()
    if (!q) return '찾을 낱말을 주세요.'
    const n = Math.min(Math.max(1, Math.floor(limit) || 10), 20)
    const cur = this.current()
    const found = this.opts.store.searchConversation(q, {
      limit: n,
      ...(cur ? { excludeThreadId: cur.id } : {}),
    })
    return formatSearch(q, found, this.now())
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
      const early = this.early.get(cur.id)
      this.early.delete(cur.id)
      const summary = reason === 'long' ? ((await early) ?? (await threads.summarize(cur.id))) : undefined
      store.closeSession(cur.id, summary)
      carry = buildCarry(cur, summary, store.listMessages(cur.id))
      if (this.rotateNote) carry = `${carry}\n\n${this.rotateNote}`
    }
    this.rotateNext = false
    this.rotateNote = ''
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

const SEARCH_DATE = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
})

/** 찾은 말을 AI가 읽을 글로: 날짜(한국 시간)·누가·찾은 낱말 둘레의 짧은 글 */
export function formatSearch(query: string, found: StoredMessage[], now = new Date()): string {
  if (!found.length)
    return `"${query}"에 대한 지난 대화를 찾지 못했어요. 다른 낱말로 다시 찾거나, 기억나지 않는다고 솔직히 말해요.`
  const words = query.split(' ').filter(Boolean)
  const lines = found.map((m) => {
    const who = m.text.startsWith(APP_NOTE) ? '두리 앱 알림' : m.role === 'user' ? '사용자' : '두리'
    return `- ${SEARCH_DATE.format(new Date(m.createdAt))} · ${who}: ${snippet(m.text, words)}`
  })
  return [
    `"${query}"로 찾은 지난 대화 ${found.length}개 (맞는 낱말이 많은 것부터, 같으면 최근 것부터 · 지금 ${SEARCH_DATE.format(now)}):`,
    ...lines,
  ].join('\n')
}

/** 찾은 낱말 둘레만 잘라 한 줄로 */
function snippet(text: string, words: string[], max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const lower = flat.toLowerCase()
  const at = words.map((w) => lower.indexOf(w.toLowerCase())).find((i) => i >= 0) ?? 0
  const start = Math.max(0, Math.min(at - 40, flat.length - max))
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + max).trim()}${start + max < flat.length ? '…' : ''}`
}

function cut(text: string, max: number) {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
