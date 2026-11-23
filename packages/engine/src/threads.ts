import type { Lang } from '@dool2/i18n'
import {
  type AgentEvent,
  type AgentId,
  type ApprovalRecordMessage,
  type CardsRecordMessage,
  type ConnectRecordMessage,
  cleanCards,
  type DaemonStreamEvent,
  type HandoffRecord,
  type LoginRecordMessage,
  type MadeImageRecordMessage,
  type WorkRecordMessage,
} from '@dool2/protocol'
import {
  type BlockRecordMessage,
  cleanDraft,
  cleanResult,
  cleanRoute,
  cleanRows,
  type QuickRecordMessage,
} from '@dool2/protocol/blocks'
import {
  APP_NOTE,
  narrationLine,
  splitQuick,
  stripMonologue,
  toolLabel,
  toolPlace,
} from '@dool2/protocol/rich'
import { isNewThreadTitle, type Store } from '@dool2/store'
import { THREAD_TEXT } from './locales/threads.js'
import { DOOL2_SYSTEM_PROMPT } from './persona.js'
import { ABOVE_BLOCK } from './region/kr/block-below.js'
import type { AgentRuntime, McpServerSpec } from './runtime.js'

export interface ThreadServiceOptions {
  store: Store
  runtimes: Partial<Record<AgentId, AgentRuntime>>
  /** Dool2's own working folder */
  workspaceDir: string
  mcpServers: McpServerSpec[]
  systemPrompt?: string | (() => string)
  /** Tab number → that tab's site host (groups the work steps by site) */
  tabHost?: (tabId: number) => string | undefined
  /** Service tool name → a title people read ("find shops, check hours"). Shown in the work steps instead of "working" */
  toolTitle?: (name: string) => string | undefined
  /** The current-time line sent with each message (nowLine by default, off in tests) */
  timeLine?: () => string | undefined
  /** The picture the image AI just made (taken once when image_make succeeds, and attached below the reply) */
  takeMadeImage?: () => MadeImageRecordMessage | undefined
  /** Language of the text the records show people (card titles, work steps). Korean when not given */
  lang?: () => Lang
}

/** Runs the agent per thread and keeps the record. */
export class ThreadService {
  private readonly running = new Map<string, AbortController>()

  constructor(private readonly opts: ThreadServiceOptions) {}

  runtime(agent: AgentId): AgentRuntime {
    const rt = this.opts.runtimes[agent]
    if (!rt) throw new Error(`Unsupported AI: ${agent}`)
    return rt
  }

  private readonly summarizing = new Set<string>()
  isRunning(threadId: string) {
    return this.running.has(threadId)
  }

  cancel(threadId: string) {
    this.running.get(threadId)?.abort()
  }

  /** Dool2's instructions + what was carried over from the previous segment (ADR 0015) */
  private systemFor(thread: { carry?: string }) {
    const sp = this.opts.systemPrompt
    const base = (typeof sp === 'function' ? sp() : sp) ?? DOOL2_SYSTEM_PROMPT
    return thread.carry ? `${base}\n\n${thread.carry}` : base
  }

  /**
   * A turn that is not recorded: asks the AI for a summary before the segment is closed.
   * Skipped when there is no session to resume or a reply is running. Gives up when it takes too long
   */
  async summarize(threadId: string, timeoutMs = 90_000): Promise<string | undefined> {
    // A reply that is not a summary (a one-liner like "No response requested.") is not used; ask once more
    // (seen 11-21: that reply was taken as the summary, and the new segment went on without knowing the morning's work and payment card)
    for (let i = 0; i < 2; i++) {
      const text = await this.summarizeOnce(threadId, timeoutMs)
      if (text === undefined) return undefined
      if (looksLikeSummary(text)) return text
    }
    return undefined
  }

  private async summarizeOnce(threadId: string, timeoutMs: number): Promise<string | undefined> {
    const thread = this.opts.store.getThread(threadId)
    if (!thread?.resumeId || this.running.has(threadId) || this.summarizing.has(threadId)) return undefined
    // A summary is not "replying": counted separately so new messages don't queue while it summarizes ahead after a reply
    const ac = new AbortController()
    this.summarizing.add(threadId)
    try {
      let text = ''
      const events = this.runtime(thread.agent).runTurn({
        text: SUMMARY_REQUEST,
        resumeId: thread.resumeId,
        systemPrompt: this.systemFor(thread),
        mcpServers: this.opts.mcpServers,
        cwd: this.opts.workspaceDir,
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]),
      })
      for await (const ev of events) {
        if (ev.type === 'tool') text = ''
        if (ev.type === 'text') text += ev.delta
        if (ev.type === 'done' && !text.trim() && ev.text) text = ev.text
        if (ev.type === 'error' || ev.type === 'limit_reached') return undefined
      }
      return text.trim() || undefined
    } catch {
      return undefined
    } finally {
      this.summarizing.delete(threadId)
    }
  }

  /**
   * Saves the user's message and runs the agent for one turn.
   * Never runs two turns at once in the same thread.
   */
  /** aside: background sent to the AI on this turn only (not recorded or shown, e.g. what was just sent as a proactive alert) */
  async *send(threadId: string, text: string, o: { aside?: string } = {}): AsyncGenerator<DaemonStreamEvent> {
    const { store } = this.opts
    const thread = store.getThread(threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    if (this.running.has(threadId)) throw new Error('This thread is still replying')
    const lang = this.opts.lang?.() ?? 'ko'
    const t = THREAD_TEXT[lang]

    const ac = new AbortController()
    this.running.set(threadId, ac)
    try {
      const userMsg = store.addMessage(threadId, 'user', text)
      yield { type: 'saved', message: userMsg }
      if (isNewThreadTitle(thread.title)) store.updateThread(threadId, { title: titleFrom(text) })

      let answer = ''
      let resumeId = thread.resumeId
      let failed: AgentEvent | undefined
      // Save the reply and send it to the screens as soon as 'done' arrives. Don't wait the ~0.5 s the official CLI spends cleaning up (closing tool servers and so on)
      let saved = false
      const work = new WorkLog(Date.now, this.opts.tabHost, this.opts.toolTitle, lang)
      // Result block for the reply (show_cards, show_list, show_result, show_draft, show_route): saved right after the reply so it shows below it.
      // One result block per reply. Called several times, only the last one stays (photo cards are joined)
      let block: CardsRecordMessage | BlockRecordMessage | undefined
      /** PC file approvals (moving several, printing): a card is kept only when the tool actually asked for approval (a successful result) */
      let fileAsk: { name: string; record: ApprovalRecordMessage } | undefined
      let approvalAsk: { name: string; record: ApprovalRecordMessage } | undefined
      let handoffAsk: { name: string; record: HandoffRecord } | undefined
      const saveBlock = () => {
        if (!block) return undefined
        const m = store.addMessage(threadId, 'tool', JSON.stringify(block))
        block = undefined
        return m
      }
      // Saving the reply: work steps → reply text → result block → quick replies (the quick-reply line at the end becomes buttons)
      /** Cards that go below the reply text (hand-off, login, approval): held until the reply is saved, then saved after it */
      const below: string[] = []
      const saveAnswer = () => {
        const out = []
        const rec = work.record()
        if (rec) out.push(store.addMessage(threadId, 'tool', JSON.stringify(rec)))
        const raw = stripMonologue(answer)
        // Result blocks show below the reply text: if the AI wrote "the list above", change it to below (it calls the tool first, then writes "above")
        const full = block ? blockBelow(raw) : raw
        const { text, replies } = splitQuick(full)
        out.push(store.addMessage(threadId, 'assistant', text || full))
        const c = saveBlock()
        if (c) out.push(c)
        for (const r of below.splice(0)) out.push(store.addMessage(threadId, 'tool', r))
        if (replies && text) {
          const quick: QuickRecordMessage = { kind: 'quick', replies }
          out.push(store.addMessage(threadId, 'tool', JSON.stringify(quick)))
        }
        return out
      }
      const events = this.runtime(thread.agent).runTurn({
        // The current time goes with the message, not the instructions (instructions changing every minute would break the AI's cache). Without it the AI calls status to learn the time
        text: [(this.opts.timeLine ?? nowLine)(), o.aside, text].filter(Boolean).join('\n\n'),
        ...(resumeId ? { resumeId } : {}),
        systemPrompt: this.systemFor(thread),
        mcpServers: this.opts.mcpServers,
        cwd: this.opts.workspaceDir,
        signal: ac.signal,
      })
      for await (const ev of events) {
        if (ev.type === 'started' && ev.resumeId) resumeId = ev.resumeId
        // The reply is only the text after the last tool. Talk before a tool ("setting the date") is just a work-in-progress line
        if (ev.type === 'tool') {
          work.tool(ev.name, answer, ev.input)
          answer = ''
        }
        if (ev.type === 'tool' && /show_cards$/.test(ev.name)) {
          const input = ev.input as { cards?: unknown; shape?: unknown } | undefined
          const list = cleanCards(input?.cards)
          // Called several times in a turn, they are joined (up to 10 cards)
          const prev = block?.kind === 'cards' ? block : undefined
          if (list.length)
            block = {
              kind: 'cards',
              cards: [...(prev?.cards ?? []), ...list].slice(0, 10),
              ...(input?.shape === 'portrait' || prev?.shape === 'portrait'
                ? { shape: 'portrait' as const }
                : {}),
            }
        }
        if (ev.type === 'tool' && /show_(list|result|draft|route)$/.test(ev.name)) {
          const kind = ev.name.match(/show_(list|result|draft|route)$/)?.[1]
          const rec =
            kind === 'list'
              ? cleanRows(ev.input)
              : kind === 'result'
                ? cleanResult(ev.input)
                : kind === 'route'
                  ? cleanRoute(ev.input)
                  : cleanDraft(ev.input)
          if (rec) block = rec
        }
        if (ev.type === 'text') answer += ev.delta
        if (ev.type === 'done') {
          if (ev.resumeId) resumeId = ev.resumeId
          if (!answer.trim() && ev.text) answer = ev.text
        }
        if (ev.type === 'error' || ev.type === 'limit_reached') failed = ev
        // Real size of the segment: used to decide before the next message whether to start a new one (ADR 0015)
        if (ev.type === 'context') store.setContextTokens(threadId, ev.tokens)
        // For service tools, send the title along: the screens show "finding shops" instead of "working"
        // (the screens add the "in progress" word themselves, so it is removed here)
        const svc = ev.type === 'tool' ? serviceAct(ev.name, ev.input, this.opts.toolTitle, lang) : undefined
        const title = svc ? t.stripAct(svc) : undefined
        yield { type: 'agent', event: title && ev.type === 'tool' ? { ...ev, title } : ev }
        if (ev.type === 'done' && answer && !saved) {
          saved = true
          if (resumeId && resumeId !== thread.resumeId) store.updateThread(threadId, { resumeId })
          for (const m of saveAnswer()) yield { type: 'saved', message: m }
        }
        // Hand-offs are kept in the record (so the done button shows after reopening).
        // Only when actually handed off (a successful result): the first call reads the screen again and returns a failure instead
        if (ev.type === 'tool' && /browser_handoff$/.test(ev.name)) {
          const input = (ev.input ?? {}) as { tabId?: unknown; reason?: unknown }
          handoffAsk = {
            name: ev.name,
            record: {
              kind: 'handoff',
              ...(typeof input.tabId === 'number' ? { tabId: input.tabId } : {}),
              reason: typeof input.reason === 'string' ? input.reason : t.handoffReason,
            },
          }
        }
        // A picture made by the image AI: kept as a large picture below the reply text (even if Dool2 attaches no card)
        if (ev.type === 'tool_result' && ev.ok && /image_make$/.test(ev.name ?? '')) {
          const made = this.opts.takeMadeImage?.()
          if (made) below.push(JSON.stringify(made))
        }
        if (ev.type === 'tool_result' && handoffAsk && (!ev.name || ev.name === handoffAsk.name)) {
          const ask = handoffAsk
          handoffAsk = undefined
          // Never above the reply text: if the reply isn't saved yet, save it after the reply (user feedback: the button above the message looked bad)
          if (ev.ok) {
            if (saved)
              yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(ask.record)) }
            else below.push(JSON.stringify(ask.record))
          }
        }
        // Approval requests are kept too. The card asks the daemon for its state (waiting, approved, declined, expired)
        // Login card requests are kept too (no values are stored; the card asks the daemon for its state)
        if (ev.type === 'tool' && /browser_request_login$/.test(ev.name)) {
          const input = (ev.input ?? {}) as { tabId?: unknown; site?: unknown }
          const record: LoginRecordMessage = {
            kind: 'login',
            ...(typeof input.tabId === 'number' ? { tabId: input.tabId } : {}),
            site: typeof input.site === 'string' ? input.site : '',
          }
          yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(record)) }
        }
        // Connection request: keeps a connect card in the conversation (values go only card → vault)
        if (ev.type === 'tool' && /connect_ask$/.test(ev.name)) {
          const input = (ev.input ?? {}) as { service?: unknown }
          if (typeof input.service === 'string' && input.service.trim()) {
            const record: ConnectRecordMessage = {
              kind: 'connect',
              service: input.service.trim().slice(0, 60),
            }
            yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(record)) }
          }
        }
        // PC file and PC approvals use -2 instead of a tab number, and ref is the tool name (ADR 0024).
        // Moving or restoring one item, undo, listing printers, downloads that are not programs, and power-off requests need no approval
        if (ev.type === 'tool') {
          const ref = /(file_move|file_print|file_trash|file_download|pc_screen)$/.exec(ev.name)?.[1]
          const what = ref
            ? fileApprovalWhat(ref, (ev.input ?? {}) as Record<string, unknown>, lang)
            : undefined
          if (ref)
            fileAsk = what ? { name: ev.name, record: { kind: 'approval', tabId: -2, ref, what } } : undefined
        }
        // Sending a text (from the user's phone number): -3 instead of a tab number, ref "sms". The phone card looks up and shows the recipient
        if (ev.type === 'tool' && /phone_sms$/.test(ev.name)) {
          const text = String(((ev.input ?? {}) as { text?: unknown }).text ?? '').slice(0, 300)
          fileAsk = text
            ? { name: ev.name, record: { kind: 'approval', tabId: -3, ref: 'sms', what: text } }
            : undefined
        }
        if (ev.type === 'tool_result' && fileAsk && (!ev.name || ev.name === fileAsk.name)) {
          const ask = fileAsk
          fileAsk = undefined
          if (ev.ok)
            yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(ask.record)) }
        }
        // PC app (screen control) approvals use -1 instead of a tab number, and app access requests use ref "app"
        const screen = ev.type === 'tool' && /screen_request_(?:approval|app)$/.test(ev.name)
        // The payment card (browser_checkout) is the same approval card (title and product names when there is no what)
        if (ev.type === 'tool' && (screen || /browser_(?:request_approval|checkout)$/.test(ev.name))) {
          const input = (ev.input ?? {}) as {
            tabId?: unknown
            ref?: unknown
            what?: unknown
            why?: unknown
            title?: unknown
            goods?: unknown
          }
          if (/browser_checkout$/.test(ev.name) && typeof input.what !== 'string') {
            const names = Array.isArray(input.goods)
              ? input.goods.map((g) => String((g as { name?: unknown })?.name ?? '')).filter(Boolean)
              : []
            input.what =
              [typeof input.title === 'string' ? input.title : '', names.join('·')]
                .filter(Boolean)
                .join(' · ') || t.payment
          }
          const appRequest = /screen_request_app$/.test(ev.name)
          const record: ApprovalRecordMessage = {
            kind: 'approval',
            ...(screen ? { tabId: -1 } : typeof input.tabId === 'number' ? { tabId: input.tabId } : {}),
            ...(appRequest ? { ref: 'app' } : typeof input.ref === 'string' ? { ref: input.ref } : {}),
            what: appRequest
              ? t.appControl(typeof input.why === 'string' ? input.why : undefined)
              : typeof input.what === 'string'
                ? input.what
                : '',
          }
          // Keep the card only when the tool actually asked for approval (a successful result; consent on an already approved site comes back as a failure)
          approvalAsk = { name: ev.name, record }
        }
        if (ev.type === 'tool_result' && approvalAsk && (!ev.name || ev.name === approvalAsk.name)) {
          const ask = approvalAsk
          approvalAsk = undefined
          // Approval and payment cards also go below the reply text (user feedback 11-20: long cards pushed the reply up out of view)
          if (ev.ok) {
            if (saved)
              yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(ask.record)) }
            else below.push(JSON.stringify(ask.record))
          }
        }
      }

      if (resumeId && resumeId !== thread.resumeId) store.updateThread(threadId, { resumeId })
      if (saved) {
        // already saved
      } else if (answer) {
        for (const m of saveAnswer()) yield { type: 'saved', message: m }
      } else if (failed && 'message' in failed) {
        yield { type: 'saved', message: store.addMessage(threadId, 'system', failed.message) }
      }
      // Keep hand-off cards even when the turn ended without a reply
      for (const r of below.splice(0)) yield { type: 'saved', message: store.addMessage(threadId, 'tool', r) }
    } finally {
      this.running.delete(threadId)
      yield { type: 'end' }
    }
  }
}

/** Whether the reply to a summary request looks like a summary: it has at least one bullet line */
export function looksLikeSummary(text: string): boolean {
  return /^\s*[-*•]\s+\S/m.test(text)
}

/** Summary request sent to the AI when a segment is closed (not recorded) */
export const SUMMARY_REQUEST =
  `${APP_NOTE}The conversation is getting long, so it will continue in a new one. Summarize what you need to keep remembering ` +
  'from the conversation with the user so far (their preferences, promises, tasks in progress or done, set dates, times and amounts) ' +
  'in up to 15 bullet lines, in the language you and the user have been using. ' +
  "Don't use tools; reply with the summary only. Always write a summary instead of saying there is nothing to reply to."

/** For PC file and PC tool input that asks for approval, the text for the approval card; otherwise undefined (same rules as the daemon's file-ops.ts) */
export function fileApprovalWhat(
  ref: string,
  input: Record<string, unknown>,
  lang: Lang = 'ko',
): string | undefined {
  const t = THREAD_TEXT[lang]
  const base = (p: unknown) => String(p).split(/[\\/]/).pop()
  if (ref === 'file_move')
    return input.undo !== true && Array.isArray(input.moves) && input.moves.length >= 2
      ? t.fileMove(input.moves.length)
      : undefined
  if (ref === 'file_print')
    return typeof input.path === 'string' && input.path.trim()
      ? t.filePrint(String(base(input.path)))
      : undefined
  if (ref === 'file_trash')
    return Array.isArray(input.restore) && input.restore.length >= 2
      ? t.fileRestore(input.restore.length)
      : undefined
  if (ref === 'file_download')
    return input.confirm === true && typeof input.url === 'string' ? t.fileDownload : undefined
  if (ref === 'pc_screen')
    return input.action === 'lock' ? t.pcLock : input.action === 'sleep' ? t.pcSleep : undefined
  return undefined
}

function titleFrom(text: string) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 30 ? `${one.slice(0, 30)}…` : one
}

/** Turns that only did housekeeping like organizing or remembering leave no work steps (so not every reply gets a card) */
const QUIET_TOOL =
  /(goal|memory|library|feed|idea)_|status$|skill_|conversation_search|show_(cards|list|result|draft)/

/** Collects what was done in a turn into a work record (WorkRecordMessage). Uses the same names as the step display on the phone and PC screens */
export class WorkLog {
  private readonly started: number
  private steps: { text: string; act: string; place?: string; at: number }[] = []
  private worked = false
  private host: string | undefined
  constructor(
    private readonly now: () => number = Date.now,
    private readonly tabHost?: (tabId: number) => string | undefined,
    private readonly toolTitle?: (name: string) => string | undefined,
    private readonly lang: Lang = 'ko',
  ) {
    this.started = now()
  }
  /** On a tool call: the one line said before it, else the tool name ("opening a web page"). Also records where (place) */
  tool(name: string, before: string, input?: unknown) {
    const bare = name.replace(/^(mcp__dool2__|dool2_)/, '')
    if (!QUIET_TOOL.test(bare)) this.worked = true
    // Web tools without a URL: that tab's site, else the last site opened
    const tabId = (input as { tabId?: unknown } | undefined)?.tabId
    const here = (typeof tabId === 'number' ? this.tabHost?.(tabId) : undefined) ?? this.host
    const place = toolPlace(name, input, here)
    if (/^browser_(open|navigate)$/.test(bare) && place) this.host = place
    // Service tools use their title ("find shops, check hours" instead of "Naver Map · working")
    const act =
      serviceAct(name, input, this.toolTitle, this.lang) ?? THREAD_TEXT[this.lang].toolAct(toolLabel(name))
    const text = narrationLine(before) ?? act
    const last = this.steps.at(-1)
    if (last?.text !== text || last.place !== place)
      this.steps.push({ text, act, ...(place ? { place } : {}), at: this.now() })
  }
  record(): WorkRecordMessage | undefined {
    if (!this.worked || !this.steps.length) return undefined
    const end = this.now()
    const steps = this.steps.map(({ at, ...s }, i) => ({ ...s, ms: (this.steps[i + 1]?.at ?? end) - at }))
    return {
      kind: 'work',
      steps: steps.slice(-30),
      count: steps.length,
      ms: end - this.started,
      ...(this.host ? { host: this.host } : {}),
    }
  }
}

/**
 * Work line for a service tool (called directly or through service_call), from its title.
 * Undefined when the title is unknown (toolLabel is used then)
 */
export function serviceAct(
  name: string,
  input: unknown,
  toolTitle?: (name: string) => string | undefined,
  lang: Lang = 'ko',
): string | undefined {
  const bare = name.replace(/^(mcp__dool2__|dool2_)/, '')
  const inner = (input as { tool?: unknown } | undefined)?.tool
  const target = bare === 'service_call' && typeof inner === 'string' ? inner : bare
  const title = toolTitle?.(target)
  if (!title) return undefined
  const t = THREAD_TEXT[lang]
  return t.serviceAct(t.serviceBare(title))
}

/** The current-time line sent with each message (for the AI) */
export function nowLine(now = Date.now()): string {
  const d = new Date(now + 9 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]
  return `(Now ${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} (${day}) ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}, Korea time)`
}

/** Turns "above" into "below" where it points at the reply's result block (blocks show below the reply text) */
export function blockBelow(text: string): string {
  return ABOVE_BLOCK.reduce((s, [re, to]) => s.replace(re, to), text)
}
