// Task sessions (ADR 0038). The conversation hands longer work to a task with task_start and keeps talking; each task
// runs in its own chat (a task thread). This board keeps the tasks, their line for the one browser, the notes the
// person passes on while they work, and what the screens show of them. The daemon (index.ts) runs the turns.

import { WorkLog } from '@dool2/engine'
import type { Lang } from '@dool2/i18n'
import type { StoredMessage, TaskStatus, TaskView } from '@dool2/protocol'
import { appNote } from '@dool2/protocol/rich'
import { forAI } from './locales/index-text.js'
import { TASKS_TEXT } from './locales/tasks-text.js'

/**
 * Whether the conversation hands longer work to task sessions when the `taskSessions` setting is empty. On: the
 * conversation talks and hands work over, tasks do it (ADR 0038, round 2). The setting stays as the off switch
 */
export const TASK_SESSIONS_DEFAULT = true

/** What the conversation wrote when it handed the work over (task_start) */
export interface TaskSpec {
  title: string
  goal: string
  /** What makes it done; the finish check compares the answer with these */
  doneWhen: string[]
  /** Values already known, so the task does not ask again */
  known: string[]
  /** What must not happen */
  avoid: string[]
  /** It needs the browser or PC apps (one task at a time) */
  browser: boolean
  /**
   * It only reads pages (a quick check): it runs at once in its own background tab, next to a task that holds the
   * browser, and clicks, types, signs in or pays only when no other task holds it
   */
  lookup: boolean
}

const strings = (v: unknown, max: number, len = 200): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .slice(0, max)
        .map((x) => x.trim().slice(0, len))
    : []

/** task_start input → spec, or what is wrong with it (said back to the AI) */
export function parseTaskSpec(a: Record<string, unknown>): TaskSpec | string {
  const goal = typeof a.goal === 'string' ? a.goal.trim().slice(0, 1500) : ''
  if (goal.length < 4) return 'goal is missing: write what to get done, in full.'
  const doneWhen = strings(a.done_when, 6)
  if (!doneWhen.length) return 'done_when is missing: write at least one condition that makes the task done.'
  const title =
    (typeof a.title === 'string' ? a.title.trim().slice(0, 40) : '') || goal.replace(/\s+/g, ' ').slice(0, 30)
  return {
    title,
    goal,
    doneWhen,
    known: strings(a.known, 12),
    avoid: strings(a.avoid, 8),
    browser: a.browser !== false || a.lookup === true,
    lookup: a.lookup === true,
  }
}

/** A task while the daemon runs it */
export interface Task {
  /** "t1", "t2" … (what the AI and the screens use) */
  id: string
  threadId: string
  /** The conversation segment it was started from */
  parentId: string
  spec: TaskSpec
  status: TaskStatus
  createdAt: number
  startedAt?: number
  endedAt?: number
  /** What it is doing now */
  now?: string
  /** The finish check sent it back and it is on another round */
  continuing?: boolean
  /** The answer being checked */
  draft?: string
  /** Notes from the person not yet given to the task */
  notes: TaskNote[]
  /** Notes already in its chat as the person's own words (typed in its detail): not shown again when delivered */
  shownNotes: Set<string>
  /** Its first message (the brief) was sent */
  begun: boolean
  work: WorkLog
  /** Stop or take-as-is was pressed while a turn ran: the end of the turn decides */
  stopping?: boolean
  accepting?: boolean
  /** What the current turn saved: the answer and the cards below it (the result that goes to the conversation) */
  turnOut: StoredMessage[]
  /** The task's card in the conversation */
  recordId?: string
  /** The site it worked on last */
  host?: string
  /**
   * Messages held while it waits for the browser after it had begun: the person's answer to its card, or its own next
   * round when it gave the browser to a task the person answered. Its next turn starts with them
   */
  resume: string[]
  /** The person answered its card while another task held the browser: it is first in line, and the holder yields */
  answered?: boolean
}

/**
 * Something the person passed to a task (task_steer, or typed in its detail): their own words, exactly, and what the
 * conversation AI added to read them, kept apart so the task never takes a guess for something the user said
 */
export interface TaskNote {
  said: string
  added?: string
}

/** One note as the task reads it: the user's words first, then the conversation's addition marked as its own */
export function noteText(n: TaskNote): string {
  return `"${n.said}"${n.added ? ` (Dool2's own addition, not the user's words: ${n.added})` : ''}`
}

/** Letters and digits only, lower case: spacing, punctuation and quotes do not make words someone else's */
const bare = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')

/** Whether the words handed to task_steer as the user's are in what the user wrote (in one message or across them) */
export function saidIn(said: string, asked: string[]): boolean {
  const w = bare(said)
  if (!w) return false
  return asked.some((a) => bare(a).includes(w)) || bare(asked.join('')).includes(w)
}

/**
 * Browser tools that only open, read, move between or close pages, never bringing a tab forward: what a lookup task
 * does beside the task that drives the browser (ADR 0038). Clicking, typing, scrolling and screenshots front the tab
 */
export const LOOKUP_READS: ReadonlySet<string> = new Set([
  'open',
  'navigate',
  'read',
  'back',
  'tabs',
  'wait',
  'close',
])

const ENDED: ReadonlySet<TaskStatus> = new Set(['done', 'stopped', 'failed'])

export interface TaskBoardOptions {
  now?: () => number
  lang?: () => Lang
  /** Same helpers as the conversation's work steps */
  tabHost?: (tabId: number) => string | undefined
  toolTitle?: (name: string) => string | undefined
  /** Lookup tasks may read beside the holder (the browser extension opens tabs in the background). Default yes */
  parallelReads?: () => boolean
}

export class TaskBoard {
  private readonly tasks = new Map<string, Task>()
  /** Tasks from before a restart, only to draw their cards */
  private readonly frozen = new Map<string, TaskView>()
  private seq = 0
  /**
   * The task that drives the browser now (one Chrome profile, one acting task at a time). A task waiting for the person
   * gives it up; lookup tasks read beside it in their own tabs without it
   */
  holder: string | undefined
  /** Which task each tab belongs to (opened or first used by it): no task touches another task's tab */
  private readonly tabs = new Map<number, string>()
  private readonly now: () => number

  constructor(private readonly o: TaskBoardOptions = {}) {
    this.now = o.now ?? Date.now
  }

  create(threadId: string, parentId: string, spec: TaskSpec): Task {
    const t: Task = {
      id: `t${++this.seq}`,
      threadId,
      parentId,
      spec,
      status: 'waiting',
      createdAt: this.now(),
      notes: [],
      shownNotes: new Set(),
      begun: false,
      work: new WorkLog(this.now, this.o.tabHost, this.o.toolTitle, this.o.lang?.() ?? 'ko'),
      turnOut: [],
      resume: [],
    }
    this.tasks.set(t.id, t)
    return t
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id.trim())
  }
  byThread(threadId: string): Task | undefined {
    for (const t of this.tasks.values()) if (t.threadId === threadId) return t
    return undefined
  }
  isTask(threadId: string): boolean {
    return this.byThread(threadId) !== undefined
  }
  /** In the order they were started */
  all(): Task[] {
    return [...this.tasks.values()]
  }
  ended(t: Task): boolean {
    return ENDED.has(t.status)
  }
  active(): Task[] {
    return this.all().filter((t) => !this.ended(t))
  }

  /** It drives the browser or PC apps, so it takes turns with them (a lookup task reads beside the holder) */
  needsSlot(t: Task): boolean {
    return t.spec.browser && !(t.spec.lookup && this.parallel())
  }
  private parallel(): boolean {
    return this.o.parallelReads?.() ?? true
  }
  /** Whether it may run now: it needs no slot, or the browser is free or already its own */
  canStart(t: Task): boolean {
    return !this.needsSlot(t) || this.holder === undefined || this.holder === t.id
  }
  /** Tasks ahead of a waiting one: the one holding the browser and the tasks before it in line */
  ahead(t: Task): number {
    if (t.status !== 'waiting' || !this.needsSlot(t)) return 0
    const line = this.line()
    const at = line.indexOf(t)
    return (at < 0 ? line.length : at) + (this.holder && this.holder !== t.id ? 1 : 0)
  }
  /**
   * Who waits for the slot, in order: tasks the person just answered first (they are mid-flow and the person is
   * there), then tasks that had begun, then new ones as they came
   */
  private line(): Task[] {
    const rank = (t: Task) => (t.answered ? 0 : t.begun ? 1 : 2)
    return this.all()
      .filter((t) => t.status === 'waiting' && this.needsSlot(t))
      .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
  }
  /** The first waiting task that may run now */
  nextReady(): Task | undefined {
    const free = this.all().find((t) => t.status === 'waiting' && !this.needsSlot(t))
    if (free) return free
    const first = this.line()[0]
    return first && this.canStart(first) ? first : undefined
  }
  /** Another task the person answered waits for the slot this task holds (it yields at the end of its turn) */
  yieldsTo(t: Task): Task | undefined {
    if (this.holder !== t.id) return undefined
    return this.line().find((x) => x !== t && x.answered)
  }
  start(t: Task): void {
    t.status = 'working'
    t.startedAt ??= this.now()
    t.endedAt = undefined
    t.answered = undefined
    if (this.needsSlot(t)) this.holder = t.id
  }
  /**
   * A browser or PC app call from a chat. read: it only opens, reads or closes pages. A task may act if no other task
   * holds the slot (it then holds it until it waits for the person or ends); a lookup task reads beside the holder
   * (background: in a tab it opens without bringing it forward). The tab it names must not be another task's. Chats
   * that are not tasks are not lined up here (side chats, the feed: as before task sessions)
   */
  claim(
    threadId: string,
    o: { read?: boolean; tabId?: number } = {},
  ): { ok: true; background?: boolean } | { ok: false; holder?: Task; tab?: Task } {
    const t = this.byThread(threadId)
    if (!t) return { ok: true }
    if (o.tabId !== undefined) {
      const owner = this.tabOwner(o.tabId)
      if (owner && owner !== t) return { ok: false, tab: owner }
    }
    const own = () => {
      if (o.tabId !== undefined) this.own(t, o.tabId)
    }
    if (this.holder === t.id) {
      own()
      return { ok: true }
    }
    const h = this.holder ? this.tasks.get(this.holder) : undefined
    const free = !h || this.ended(h)
    if (o.read && t.spec.lookup && this.parallel()) {
      own()
      return free ? { ok: true } : { ok: true, background: true }
    }
    if (free) {
      this.holder = t.id
      own()
      return { ok: true }
    }
    return { ok: false, holder: h }
  }
  /** Whether a lookup task reads in the background now (another task drives the browser) */
  readsBeside(threadId: string): boolean {
    const t = this.byThread(threadId)
    return Boolean(t?.spec.lookup && this.parallel() && this.holder && this.holder !== t.id)
  }
  /** A tab a task opened or used is its own until it ends */
  own(t: Task, tabId: number): void {
    if (!this.tabs.has(tabId) || !this.tabOwner(tabId)) this.tabs.set(tabId, t.id)
  }
  /** The live task a tab belongs to */
  tabOwner(tabId: number): Task | undefined {
    const id = this.tabs.get(tabId)
    const t = id ? this.tasks.get(id) : undefined
    return t && !this.ended(t) ? t : undefined
  }
  release(t: Task): void {
    if (this.holder === t.id) this.holder = undefined
  }
  end(t: Task, status: 'done' | 'stopped' | 'failed'): void {
    t.status = status
    t.endedAt = this.now()
    t.continuing = undefined
    t.draft = undefined
    t.stopping = undefined
    t.accepting = undefined
    t.resume = []
    t.answered = undefined
    this.release(t)
    for (const [tab, id] of this.tabs) if (id === t.id) this.tabs.delete(tab)
  }

  /** A tool call of the task: one more step on its card */
  step(t: Task, name: string, input: unknown, before = ''): void {
    t.work.tool(name, before, input)
    const rec = t.work.record()
    const last = rec?.steps.at(-1)
    if (last) t.now = last.text
    if (rec?.host) t.host = rec.host
  }

  note(t: Task, said: string, added?: string): void {
    const extra = added?.trim().slice(0, 300)
    t.notes.push({ said: said.trim().slice(0, 600), ...(extra ? { added: extra } : {}) })
  }
  /** Notes for the task's next tool result, taken once */
  takeNotes(threadId: string): TaskNote[] {
    const t = this.byThread(threadId)
    if (!t?.notes.length || this.ended(t)) return []
    return t.notes.splice(0)
  }

  view(t: Task): TaskView {
    const rec = t.work.record()
    const iso = (ms: number) => new Date(ms).toISOString()
    const ahead = this.ahead(t)
    return {
      id: t.id,
      title: t.spec.title,
      status: t.status,
      ...(t.now ? { now: t.now } : {}),
      ...(t.continuing ? { continuing: true } : {}),
      steps: rec?.steps ?? [],
      count: rec?.count ?? 0,
      createdAt: iso(t.createdAt),
      ...(t.startedAt ? { startedAt: iso(t.startedAt) } : {}),
      ...(t.endedAt ? { endedAt: iso(t.endedAt) } : {}),
      ...(ahead ? { ahead } : {}),
      ...(t.draft && t.status === 'checking' ? { draft: t.draft } : {}),
      ...(t.notes.length ? { notes: t.notes.length } : {}),
      threadId: t.threadId,
      ...(t.host ? { host: t.host } : {}),
    }
  }

  /** Every task the screens may draw: running ones and the last finished, newest first */
  views(limit = 20): TaskView[] {
    const live = this.all().map((t) => this.view(t))
    const old = [...this.frozen.values()].filter((v) => !this.tasks.has(v.id))
    return [...live, ...old]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit)
  }

  /**
   * Cards of tasks from before the daemon restarted. A task that had not ended lost its program with the daemon: it
   * shows as stopped
   */
  restore(views: unknown): void {
    if (!Array.isArray(views)) return
    for (const v of views as TaskView[]) {
      if (!v || typeof v.id !== 'string' || typeof v.threadId !== 'string') continue
      const n = Number(v.id.replace(/^t/, ''))
      if (Number.isFinite(n)) this.seq = Math.max(this.seq, n)
      const ended = ENDED.has(v.status)
      this.frozen.set(v.id, {
        ...v,
        ...(ended
          ? {}
          : { status: 'stopped' as const, endedAt: v.endedAt ?? new Date(this.now()).toISOString() }),
      })
    }
  }
  /** Start over: no tasks are left (none may be running) */
  clear(): void {
    this.tasks.clear()
    this.frozen.clear()
    this.holder = undefined
  }
  /** A card of a task from before a restart */
  frozenView(id: string): TaskView | undefined {
    return this.frozen.get(id)
  }
}

/** The task's first message in its own chat: what to do, by when it is done, what is known, what must not happen */
export function taskBrief(t: Task, lang: Lang = 'ko'): string {
  const s = t.spec
  const list = (head: string, xs: string[]) =>
    xs.length ? `${head}\n${xs.map((x) => `- ${x}`).join('\n')}` : ''
  const ai = [
    'This is a task the user handed over in the conversation with Dool2. You work on it here, in its own session, ' +
      'while the user keeps talking with Dool2 there. Only your final answer reaches the user, as the result of the ' +
      'task: make it the one complete answer (result first, then what was done, then anything left), in the language ' +
      'of the goal below.',
    `Goal: ${s.goal}`,
    list('Done when:', s.doneWhen),
    list('Already known (do not ask again):', s.known),
    list('Must not happen:', s.avoid),
    list('The user also said, while the task waited to start:', t.notes.splice(0).map(noteText)),
    'Notes the user sends while you work arrive at the end of a tool result as "Message from the user". Follow them; ' +
      'where they differ from this spec, they come first.',
  ]
    .filter(Boolean)
    .join('\n\n')
  return appNote(forAI(TASKS_TEXT(lang).briefShown(s.title), ai))
}

/** The person's notes as the next message of a task that is not in a turn (waiting for them, or just done) */
export function notesMessage(notes: TaskNote[], lang: Lang = 'ko', shown?: ReadonlySet<string>): string {
  const said = notes.map(noteText).join(' / ')
  // The task's chat shows only the user's own words, never the conversation's addition
  const fresh = notes.filter((n) => !shown?.has(n.said)).map((n) => n.said)
  return appNote(
    forAI(
      fresh.length ? TASKS_TEXT(lang).noteShown(fresh.join(' / ')) : '',
      `The user sent this through the conversation: ${said}. Continue the task with it; where it differs from the task spec, it comes first. When done, give the one complete answer again.`,
    ),
  )
}

/** What a tool result carries when the person passed something on (ADR 0038 steering) */
export function steerLines(notes: TaskNote[]): string {
  return notes
    .map(
      (n) =>
        `Message from the user, sent through the conversation while you work (it comes before the task spec where they differ): ${noteText(n)}`,
    )
    .join('\n')
}

/** A tool result with the person's notes added at the end, where the AI reads it (text, and the structured next) */
export function withNotes<T>(result: T, notes: TaskNote[]): T {
  if (!notes.length) return result
  const r = result as {
    content?: { type: string; text?: string }[]
    structuredContent?: unknown
    hint?: string
  }
  if (!r || !Array.isArray(r.content)) return result
  const line = steerLines(notes)
  return {
    ...r,
    content: [...r.content, { type: 'text', text: line }],
    // A service tool's structured result is what the AI reads; its next line rides there (mcp-tools pass)
    ...(r.structuredContent ? { hint: [line, r.hint].filter(Boolean).join('\n') } : {}),
  } as T
}

/** A tool that only a task has, named in a text (mcp-tools TASK_ONLY) */
const TASK_TOOL = /\b(?:browser|screen|kakao|file|video)_[a-z_]+|\b(?:image_make|pc_screen|phone_sms)\b/

/** The line the conversation gets when a result or app note sends it to a tool only a task has (ADR 0038) */
export const TASK_HINT =
  'Those browser, PC app and file steps are done by a task in this conversation: hand them over with task_start (put what you know in known) and tell the user you are on it.'

/** Whether a text points the AI at a tool only a task has */
export function namesTaskTool(text: string): boolean {
  return TASK_TOOL.test(text)
}

/**
 * A tool result for the conversation of task sessions: when it tells the AI to use a tool only a task has (a sign-in
 * flow, a site check, a missing profile field), one line says how to get that done from here, so it never stops at
 * "I can't"
 */
export function withTaskHint<T>(result: T, tool?: string): T {
  const r = result as {
    content?: { type: string; text?: string }[]
    structuredContent?: unknown
    hint?: string
  }
  if (!r || !Array.isArray(r.content)) return result
  const said = [...r.content.map((x) => x.text ?? ''), r.hint ?? ''].join('\n')
  const line = namesTaskTool(said) ? TASK_HINT : tool === 'service/find' ? FIND_HINT : undefined
  if (!line) return result
  return {
    ...r,
    content: [...r.content, { type: 'text', text: line }],
    ...(r.structuredContent ? { hint: [r.hint, line].filter(Boolean).join('\n') } : {}),
  } as T
}

/**
 * The line under service_find's matches in the conversation of task sessions. A loose match ("Busan" in an airline's
 * name for "Busan weather tomorrow") left the conversation with no tool that fits and no browser, and it told the
 * user to search themselves (WP7 bench, twice)
 */
export const FIND_HINT =
  'If none of these answers it, the web does: hand the lookup to a task with task_start (lookup: true) and tell the user you are on it; it starts at once in its own tab, even while another task uses the browser. Do not send the user to look it up themselves.'

/**
 * task_list for the conversation AI: what each task is doing, waiting on, or came out with. waitsOn: the cards a
 * task waiting for the user has open (approval, sign-in), so the AI can say which one instead of guessing (measured on
 * the WP7 bench: "a login or an approval, I can't tell which")
 */
export function taskListText(
  board: TaskBoard,
  results: Map<string, string>,
  now = Date.now(),
  waitsOn: (id: string) => string[] = () => [],
): string {
  const views = board.views(12)
  if (!views.length) return 'No tasks yet.'
  const age = (iso?: string) => {
    if (!iso) return ''
    const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
    return m < 1 ? 'just now' : `${m} min ago`
  }
  const line = (v: TaskView) => {
    const what =
      v.status === 'waiting'
        ? `waiting for the browser (${v.ahead ?? 0} ahead)`
        : v.status === 'working'
          ? `working${v.continuing ? ' on what the check found missing' : ''}: ${v.now ?? 'starting'}`
          : v.status === 'checking'
            ? 'checking its answer before it finishes'
            : v.status === 'needs-you'
              ? waitingFor(v, waitsOn(v.id))
              : v.status === 'done'
                ? `done ${age(v.endedAt)}`
                : v.status === 'stopped'
                  ? `stopped ${age(v.endedAt)}`
                  : `stopped by an error ${age(v.endedAt)}`
    const result = results.get(v.id)
    return [
      `- ${v.id} "${v.title}": ${what}; ${v.count} steps${v.notes ? `; ${v.notes} note(s) not read yet` : ''}`,
      // Said so: the AI read "done" plus a result it had not seen and told the user the result never came (11-26)
      result
        ? `  Result (already shown to the user in the chat as your message; do not say it is missing): ${result.slice(0, 400)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
  return `${views.map(line).join('\n')}\nSteer a running or waiting task with task_steer, stop one with task_stop.`
}

/** What a task waiting for the user waits on: its open cards, else its last step */
function waitingFor(v: TaskView, cards: string[]): string {
  if (cards.length) return `waiting for the user: ${cards.join('; ')}`
  return `waiting for the user (an approval, a sign-in or a card in the conversation)${v.now ? `; last step: ${v.now}` : ''}`
}

/**
 * task_stop's result: where the task was when it stopped and whether anything it asked for was approved, so the
 * conversation can say what did and did not happen (measured: "if you worry the booking went through, tell me")
 */
export function stoppedText(t: Task, approved: string[]): string {
  const steps = t.work.record()?.count ?? 0
  return [
    `Task ${t.id} is stopped.`,
    `It was at: ${t.now ?? 'not started yet'} (${steps} steps).`,
    approved.length
      ? `Approved by the user while it ran, so it may have happened: ${approved.join('; ')}.`
      : 'Nothing it asked for was approved, so nothing was paid, sent or booked by it.',
    'Tell the user in one sentence.',
  ].join(' ')
}

/**
 * Where an automatic sign-in that stopped partway goes (it needs the browser, ADR 0038): the task that asked for the
 * connection while it still runs; otherwise, when the conversation has no browser (task sessions), a new sign-in task;
 * otherwise the conversation as before
 */
export function takeoverTarget(
  board: TaskBoard,
  askerThread: string | undefined,
  conversationKind: 'conversation' | 'task' | undefined,
): { kind: 'task'; task: Task } | { kind: 'new-task' } | { kind: 'conversation' } {
  const asker = askerThread ? board.byThread(askerThread) : undefined
  if (asker && !board.ended(asker)) return { kind: 'task', task: asker }
  return conversationKind === 'conversation' ? { kind: 'new-task' } : { kind: 'conversation' }
}

/** A task that finishes a sign-in the automatic one could not (its brief carries the steps for the AI) */
export function signInSpec(service: string, steps: string, lang: Lang = 'ko'): TaskSpec {
  return {
    title: TASKS_TEXT(lang).signInTitle(service).slice(0, 40),
    goal: steps,
    doneWhen: [`signed in to ${service}: a page only a signed-in person sees was read`],
    known: ['The ID and password are in the vault (browser_login)'],
    avoid: ['asking the user for the password', 'signing up for a new account without the user choosing it'],
    browser: true,
    lookup: false,
  }
}
