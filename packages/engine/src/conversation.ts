import type { AgentId, DaemonStreamEvent, StoredMessage } from '@dool2/protocol'
import { APP_NOTE } from '@dool2/protocol/rich'
import { NEW_THREAD_TITLE, type Store, type ThreadRecord } from '@dool2/store'
import { modelProfile } from './models.js'
import { OLD_CARRY_HEAD } from './region/kr/carry.js'
import type { ThreadService } from './threads.js'

/**
 * How long the provider keeps a conversation cached after its last AI call. Measured on 1,185 turns of this app's
 * sessions: every turn within 60 minutes read 99–100% from the cache, almost none after 65; the subscription CLI
 * writes 1-hour cache entries (ADR 0036)
 */
export const CACHE_LIFE_MS = 60 * 60_000

/**
 * The handoff summary made ahead (ADR 0036): this long after the last reply, while the cache still holds the
 * conversation, so the summary reads it cheaply and the switch on the next message is instant. Late in the cache's
 * life on purpose: most pauses end within half an hour (the summary would be wasted), and those that pass an hour
 * are the ones that switch
 */
export const HANDOFF_AFTER_MS = 50 * 60_000
/** Segments shorter than this (user turns) get no summary: the recent messages carried over hold all of them */
export const HANDOFF_MIN_TURNS = 4

/** When to start a new segment (ADR 0015) */
export interface ConversationLimits {
  /** Number of user turns */
  turns: number
  /** Stored characters */
  chars: number
  /**
   * New segment after this long since the last message, when the switch loses nothing: a handoff was made ahead, or
   * the segment is short enough for the recent messages to carry it. Just past the cache's life (ADR 0036): after it,
   * continuing reads the whole conversation again at full price anyway
   */
  idleMs: number
  /** New segment after this long in any case (recent messages only when there is no handoff) */
  staleMs: number
  /**
   * Tokens the AI actually read on its last turn. Tool results such as browser pages are not in the stored
   * character count, so segments with a lot of web work slow down and cost more long before the turn or character limits
   */
  contextTokens: number
}

/** Limits for the agent's default model; turns, characters and tokens come from the model profile (ADR 0037) */
export const DEFAULT_LIMITS: ConversationLimits = {
  ...modelProfile('claude').limits,
  idleMs: CACHE_LIFE_MS + 5 * 60_000,
  staleMs: 12 * 60 * 60 * 1000,
}

/** The limits for an agent: its model profile, then any override */
export function limitsFor(agent: AgentId, override: Partial<ConversationLimits> = {}): ConversationLimits {
  return { ...DEFAULT_LIMITS, ...modelProfile(agent).limits, ...override }
}

/** The handoff made ahead for a segment, valid while the segment has not changed since (basis: its updatedAt then) */
interface Handoff {
  threadId: string
  basis: string
  summary: string
}
const HANDOFF_KEY = 'handoff'

export type RotateReason = 'first' | 'agent' | 'idle' | 'long'

export interface ConversationOptions {
  store: Store
  threads: ThreadService
  limits?: Partial<ConversationLimits>
  now?: () => Date
  /** Wait after a reply before the handoff is made ahead (HANDOFF_AFTER_MS by default) */
  handoffAfterMs?: number
  /** Work log: a handoff made ahead (or tried and not made), how long it took and the segment's user turns */
  onHandoff?: (x: { made: boolean; ms: number; turns: number }) => void
  /** Work log: a new segment started, and whether it carried the handoff made ahead (ready), a summary made now, or none */
  onRotate?: (x: { reason: RotateReason; handoff: 'ready' | 'summary' | 'none' }) => void
}

/**
 * There is one conversation with Dool2 (ADR 0015).
 * It is the segments (the threads table) joined in time order, and a new message continues the current segment's AI session.
 * When it gets long, after a long idle, or when the AI changes, the previous segment is closed and a new one opens with the summary and recent messages.
 */
export class ConversationService {
  private readonly now: () => Date

  constructor(private readonly opts: ConversationOptions) {
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

  /** Segments a handoff was already tried for (at most once each, to spare the user's quota) */
  private readonly handoffTried = new Set<string>()
  private handoffTimer: ReturnType<typeof setTimeout> | undefined
  private handoffRun: AbortController | undefined

  /**
   * Called after a reply ends. Makes the handoff summary later (HANDOFF_AFTER_MS), while the provider's cache still
   * holds the conversation, if the user has not written by then. Once per segment, not for short segments
   */
  handoffLater() {
    clearTimeout(this.handoffTimer)
    const cur = this.current()
    if (!cur || this.handoffTried.has(cur.id)) return
    if (this.opts.store.sessionSize(cur.id).turns < HANDOFF_MIN_TURNS) return
    const id = cur.id
    this.handoffTimer = setTimeout(
      () => void this.makeHandoff(id),
      this.opts.handoffAfterMs ?? HANDOFF_AFTER_MS,
    )
    this.handoffTimer.unref?.()
  }

  /** A new message came: the handoff waiting or being made is not needed now */
  cancelHandoff() {
    clearTimeout(this.handoffTimer)
    this.handoffTimer = undefined
    this.handoffRun?.abort()
    this.handoffRun = undefined
  }

  private async makeHandoff(id: string) {
    const cur = this.current()
    if (cur?.id !== id || this.handoffTried.has(id) || this.opts.threads.isRunning(id)) return
    // The PC slept past the cache's life: a summary now reads everything at full price, as continuing would. Skip it
    // (the segment switches after staleMs then, as before)
    const started = this.now().getTime()
    if (started - Date.parse(cur.updatedAt) >= CACHE_LIFE_MS) return
    this.handoffTried.add(id)
    const ac = new AbortController()
    this.handoffRun = ac
    const turns = this.opts.store.sessionSize(id).turns
    const summary = await this.opts.threads.summarize(id, 90_000, ac.signal).catch(() => undefined)
    if (this.handoffRun === ac) this.handoffRun = undefined
    const made = Boolean(summary) && !ac.signal.aborted
    if (made && summary) {
      const h: Handoff = { threadId: id, basis: cur.updatedAt, summary }
      this.opts.store.setSetting(HANDOFF_KEY, h)
    }
    this.opts.onHandoff?.({ made, ms: this.now().getTime() - started, turns })
  }

  /** The handoff made ahead for this segment, if nothing was said in it since */
  readyHandoff(cur: ThreadRecord | undefined = this.current()): string | undefined {
    if (!cur) return undefined
    const h = this.opts.store.getSetting(HANDOFF_KEY) as Partial<Handoff> | undefined
    return h && h.threadId === cur.id && h.basis === cur.updatedAt && typeof h.summary === 'string'
      ? h.summary
      : undefined
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
    const limits = limitsFor(agent, this.opts.limits)
    const idle = this.now().getTime() - Date.parse(cur.updatedAt)
    if (idle > limits.staleMs) return 'idle'
    // Past the cache's life: switch when it loses nothing (a handoff is ready, or the segment is short)
    if (idle > limits.idleMs && (size.turns < HANDOFF_MIN_TURNS || this.readyHandoff(cur))) return 'idle'
    if (
      size.turns >= limits.turns ||
      size.chars >= limits.chars ||
      size.contextTokens >= limits.contextTokens
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
   * A handoff made ahead is used whatever the reason. Without one, the AI is asked for a summary only when switching for
   * length (after idle or an AI change, only recent messages are carried)
   */
  async prepare(agent: AgentId): Promise<{ session: ThreadRecord; rotated?: RotateReason }> {
    const { store, threads } = this.opts
    this.cancelHandoff()
    const cur = this.current()
    const reason = this.needsRotate(agent, cur)
    if (!reason && cur) return { session: cur }

    let carry: string | undefined
    let handoff: 'ready' | 'summary' | 'none' = 'none'
    if (cur) {
      const early = this.early.get(cur.id)
      this.early.delete(cur.id)
      const ready = this.readyHandoff(cur)
      const summary =
        ready ?? (reason === 'long' ? ((await early) ?? (await threads.summarize(cur.id))) : undefined)
      if (ready) store.setSetting(HANDOFF_KEY, undefined)
      handoff = ready ? 'ready' : summary ? 'summary' : 'none'
      store.closeSession(cur.id, summary)
      // The closed segment's resident agent program is not needed any more (ADR 0036)
      void threads.release(cur.id)
      carry = buildCarry(cur, summary, store.listMessages(cur.id))
      if (this.rotateNote) carry = `${carry}\n\n${this.rotateNote}`
    }
    this.rotateNext = false
    this.rotateNote = ''
    this.opts.onRotate?.({ reason: reason ?? 'first', handoff })
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
  if (summary) parts.push(`Handoff from the earlier conversation:\n${cut(summary, 3500)}`)
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
