import type { AgentId, DaemonStreamEvent, StoredMessage } from '@dool2/protocol'
import { APP_NOTE } from '@dool2/protocol/rich'
import { NEW_THREAD_TITLE, type Store, type ThreadRecord } from '@dool2/store'
import { OLD_CARRY_HEAD } from './region/kr/carry.js'
import type { ThreadService } from './threads.js'

/** When to start a new segment (ADR 0015) */
export interface ConversationLimits {
  /** Number of user turns */
  turns: number
  /** Stored characters */
  chars: number
  /** New segment after this long since the last message (milliseconds) */
  idleMs: number
  /**
   * Tokens the AI actually read on its last turn. Tool results such as browser pages are not in the stored
   * character count, so segments with a lot of web work slow down and cost more long before the turn or character limits
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
 * There is one conversation with Dool2 (ADR 0015).
 * It is the segments (the threads table) joined in time order, and a new message continues the current segment's AI session.
 * When it gets long, after a long idle, or when the AI changes, the previous segment is closed and a new one opens with the summary and recent messages.
 */
export class ConversationService {
  private readonly limits: ConversationLimits
  private readonly now: () => Date

  constructor(private readonly opts: ConversationOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits }
    this.now = opts.now ?? (() => new Date())
  }

  /** Summaries started ahead (segment id → summary) */
  private readonly early = new Map<string, Promise<string | undefined>>()
  /**
   * Called after a reply ends. If the next message will start a new segment for length, the summary starts now.
   * Before, the summary was requested only after the next message arrived, so for 10 s or so nothing was saved and nothing happened
   */
  prewarm() {
    const cur = this.current()
    if (!cur || this.early.has(cur.id) || this.needsRotate(cur.agent, cur) !== 'long') return
    this.early.set(
      cur.id,
      this.opts.threads.summarize(cur.id).catch(() => undefined),
    )
  }

  /** Start a new segment from the next message (after the tone setting changes, so the old tone isn't followed) */
  private rotateNext = false
  private rotateNote = ''
  rotateSoon(note = '') {
    this.rotateNext = true
    this.rotateNote = note
  }

  /** The current segment */
  current(): ThreadRecord | undefined {
    return this.opts.store.currentSession()
  }

  /** Whether the current segment is replying (one turn at a time) */
  isRunning(): boolean {
    const cur = this.current()
    return cur ? this.opts.threads.isRunning(cur.id) : false
  }

  cancel() {
    const cur = this.current()
    if (cur) this.opts.threads.cancel(cur.id)
  }

  /** History: messages of every segment in time order */
  history(opts: { before?: string; limit?: number } = {}): StoredMessage[] {
    return this.opts.store.listConversation(opts)
  }

  /** Whether a new segment is needed, and why */
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
   * Searches past conversation (the conversation_search tool), so the AI can find messages from earlier segments that the summary left out.
   * The current segment is left out because the AI already knows it (so the question just asked isn't the top hit)
   */
  search(query: string, limit = 10): string {
    const q = query.replace(/\s+/g, ' ').trim()
    if (!q) return 'Give me words to search for.'
    const n = Math.min(Math.max(1, Math.floor(limit) || 10), 20)
    const cur = this.current()
    const found = this.opts.store.searchConversation(q, {
      limit: n,
      ...(cur ? { excludeThreadId: cur.id } : {}),
    })
    return formatSearch(q, found, this.now())
  }

  /**
   * The segment for the next message. Closes the previous one and opens a new one when needed.
   * Asks the AI for a summary only when switching for length (after idle or an AI change, only recent messages are carried)
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
    const next = store.createThread(agent, NEW_THREAD_TITLE.ko, carry)
    store.closeOtherSessions(next.id)
    return { session: next, rotated: reason }
  }

  /** Sends one user message to the current segment */
  async *send(agent: AgentId, text: string): AsyncGenerator<DaemonStreamEvent> {
    const { session } = await this.prepare(agent)
    yield* this.opts.threads.send(session.id, text)
  }
}

const CARRY_MAX = 6000

/** The "continued from the earlier conversation" text appended to a new segment's instructions */
export function buildCarry(
  prev: ThreadRecord,
  summary: string | undefined,
  messages: StoredMessage[],
): string | undefined {
  const recent = messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-8)
  const earlier = summary ?? prev.carry
  if (!recent.length && !earlier) return undefined
  const parts = [
    `${CARRY_HEAD} You are continuing one conversation with the user, who doesn't know it was split. Keep the following in mind and continue naturally.`,
  ]
  if (summary) parts.push(`Summary:\n${cut(summary, 2500)}`)
  else if (prev.carry)
    parts.push(
      `Earlier conversation:\n${cut(prev.carry.replace(OLD_CARRY_HEAD, '').replace(CARRY_HEAD_LINE, ''), 2500)}`,
    )
  if (recent.length)
    parts.push(
      `Recent messages:\n${recent.map((m) => `${m.role === 'user' ? 'User' : 'Dool2'}: ${cut(m.text, 400)}`).join('\n')}`,
    )
  return cut(parts.join('\n\n'), CARRY_MAX)
}

const CARRY_HEAD = '[Continued from the earlier conversation]'
const CARRY_HEAD_LINE = /^\[Continued from the earlier conversation\][^\n]*\n?/

const SEARCH_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
})

/** Found messages as text for the AI: date (Korea time), who, and a short snippet around the search words */
export function formatSearch(query: string, found: StoredMessage[], now = new Date()): string {
  if (!found.length)
    return `No past conversation found for "${query}". Search again with other words, or say honestly that you don't remember.`
  const words = query.split(' ').filter(Boolean)
  const lines = found.map((m) => {
    const who = m.text.startsWith(APP_NOTE) ? 'Dool2 app notice' : m.role === 'user' ? 'User' : 'Dool2'
    return `- ${SEARCH_DATE.format(new Date(m.createdAt))} · ${who}: ${snippet(m.text, words)}`
  })
  return [
    `Found ${found.length} past messages for "${query}" (most matching words first, then most recent · now ${SEARCH_DATE.format(now)}):`,
    ...lines,
  ].join('\n')
}

/** Cuts one line around the search words */
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
