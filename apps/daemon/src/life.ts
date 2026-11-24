// Dool2's life record: goals (things it does on its own, repeats), library (saved results), memory (what it learned about the user), feed (what it did, notices).
// Everything stays in this PC's store (the settings table). The AI makes them with tools (life_*), and the phone and PC screens read the same lists.
import { randomUUID } from 'node:crypto'
import type { Lang } from '@dool2/i18n'
import {
  cleanCards,
  type FeedItem,
  GOAL_CATEGORIES,
  type GoalCategory,
  type Identity,
  type KnowItem,
  type LibraryItem,
  type LibraryTab,
  type LifeAction,
  type LifeState,
  type MemoryItem,
  type Routine,
  type RoutineCheck,
  type RoutineSchedule,
  type SuggestedIdea,
} from '@dool2/protocol'
import { cleanDraft, cleanResult, cleanRoute, cleanRows } from '@dool2/protocol/blocks'
import type { ConnectionItem } from '@dool2/protocol/connect'
import { PAGE_SIZE, type Page, pageOf } from '@dool2/protocol/paging'
import { nextRun, ruleLabel, scheduleLabel, untilEnd, untilLabel } from '@dool2/protocol/schedule'

import { FEED_ROUTINE_TITLES, lifeText } from './locales/life-text.js'
import { CONDITIONAL, END_MARK, LIBRARY_LABEL_KR, MORNING, QUIET_MARK } from './region/kr/life.js'

export { END_MARK, nextRun, QUIET_MARK, ruleLabel, scheduleLabel, untilEnd }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** "9:05 AM" from hour and minute (24-hour in) */
const hhmmEn = (h: number, m: number) =>
  `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`

/** For tasks that only report when a condition holds: a run whose answer starts with this stays quiet */

/** Appended to the end of an answer when the end condition came true: the task turns itself off */

/** Reading the answer of a run: whether to stay quiet, whether it ended, and the text without the marks */
export function readRun(r: Pick<Routine, 'notify' | 'until'>, answer: string) {
  const ended = !!r.until && answer.includes(END_MARK)
  const text = answer.split(END_MARK).join('').trim()
  const flat = text.replace(/[\s*_`#>"'“”‘’.,!~-]/g, '')
  const quiet = r.notify === 'when_found' && flat.startsWith(QUIET_MARK.replace(/\s/g, ''))
  return { quiet, ended, text }
}

/** The message sent to Dool2 at the set time: the task + how to put the not-matching case and the end condition in the answer */
export function routineAsk(r: Pick<Routine, 'prompt' | 'notify' | 'until' | 'lastTold'>): string {
  const lines = [
    r.prompt,
    'If the task covers several things, split the answer into "Done" (one or two lines of result per item) and "Needs your decision" (what the user must choose or confirm; leave it out if nothing).',
  ]
  if (r.notify === 'when_found') {
    lines.push(
      `This task only reports when the condition holds. If nothing matches, write only "${QUIET_MARK}" and nothing else (the user is not told). If something matches, start with what you confirmed, briefly.`,
    )
    // A watch must know what was reported last time, so it does not report the same news again
    if (r.lastTold) lines.push(`Already reported last time (the same item is not new):\n${r.lastTold}`)
  }
  if (r.until && !untilEnd(r.until))
    lines.push(
      `End condition: ${r.until}. If this condition came true this time, put "${END_MARK}" at the very end of the answer (this task then turns itself off).`,
    )
  return lines.join('\n')
}

/** Korean time, like "Dec 1 (Tue) 9:00 AM" */
function kstWhen(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600_000)
  const h = d.getUTCHours()
  const m = d.getUTCMinutes()
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} (${WEEKDAYS[d.getUTCDay()]}) ${hhmmEn(h, m)}`
}

/** "07:00" → "7:00 AM" */
function hhmmLabel(t: string): string {
  const [h = 0, m = 0] = t.split(':').map(Number)
  return hhmmEn(h, m)
}

/**
 * How long to hold the phone notice (ms): until the next tellAt (Korean time) if that is within 12 hours, else 0 (now).
 * A job finished at 3 AM with 7 AM → 4 hours later. Finished at 8 AM with 7 AM already passed → now
 */
export function tellDelay(tellAt: string | undefined, now: Date): number {
  if (!tellAt) return 0
  const [h = 0, m = 0] = tellAt.split(':').map(Number)
  const k = new Date(now.getTime() + 9 * 3600_000)
  let at = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), h, m) - 9 * 3600_000
  if (at <= now.getTime()) at += 24 * 3600_000
  const ms = at - now.getTime()
  return ms <= 12 * 3600_000 ? ms : 0
}

/** The one-line rule (the AI tells the user as it is): when it runs · when it ends · when it notifies · the first run */
export function ruleSentence(r: Routine): string {
  const s = r.schedule
  const when = s ? scheduleLabel(s) : 'No set time (does not run by itself)'
  const end =
    !s || s.kind === 'once'
      ? ''
      : r.until
        ? untilEnd(r.until)
          ? `${untilLabel(r.until)}, then turns itself off`
          : `turns off when "${r.until}"`
        : 'No end (until deleted)'
  const tell = !s
    ? ''
    : r.notify === 'when_found'
      ? 'notifies only when the condition holds, otherwise stays quiet'
      : r.target === 'feed'
        ? 'posts to the feed every time'
        : 'notifies every time'
  const later = s && r.tellAt ? `phone notice is held until ${hhmmLabel(r.tellAt)}` : ''
  const first = r.nextRunAt ? `first run ${kstWhen(r.nextRunAt)}` : ''
  return [when, end, tell, later, first].filter(Boolean).join(' · ')
}

/** Wording that makes a task a conditional watch ("when it exceeds", "when it shows up" ...) */
// (the Korean wording list is in region/kr/life.ts)

export interface Kv {
  getSetting(key: string): unknown
  setSetting(key: string, value: unknown): void
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const bad = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

/**
 * Storage limits. The feed is kept by age (90 days), not count, and shown in pages (the count cap is just generous to avoid overflow).
 * The library is what the user saved, so it is never deleted by age
 */
const LIMIT = { routines: 50, library: 2000, memory: 200, feed: 3000, know: 500 }
export const FEED_KEEP_DAYS = 90
/** Length of a library body sent in lists (the full text is fetched one at a time) */
const LIBRARY_PREVIEW = 400
/** Goal progress log: 50 are stored, only the latest are sent to screens (PC detail 20 lines, phone 8) */
const LOG_SENT = 20
/** Feed kinds counted as "what Dool2 did" (this week's activity) */
const DONE_KINDS = new Set<FeedItem['kind']>(['done', 'routine', 'post', 'saved', 'goal', 'connected'])
const FEED_KINDS: FeedItem['kind'][] = ['done', 'routine', 'saved', 'goal', 'connected', 'suggest', 'post']
const FEED_LABEL: Record<FeedItem['kind'], string> = {
  post: 'News',
  done: 'Done',
  routine: 'Scheduled task',
  saved: 'Library',
  goal: 'Goal',
  connected: 'Connected',
  suggest: 'Looked ahead',
}
const feedAt = (f: FeedItem) => f.at
const libraryAt = (it: LibraryItem) => it.savedAt
const inTab = (it: LibraryItem, tab: LibraryTab) =>
  tab === 'files' ? it.kind === 'file' : it.kind !== 'file'

/** For lists: long text keeps only the start (cut by character so emoji do not break) */
function preview(it: LibraryItem): LibraryItem {
  // The preview photo is not sent in the list (fetched one at a time when opened)
  if (it.image) {
    const { image: _i, ...rest } = it
    return { ...rest, body: [...it.body].slice(0, LIBRARY_PREVIEW).join(''), cut: true }
  }
  if (it.body.length <= LIBRARY_PREVIEW) return it
  const chars = [...it.body]
  if (chars.length <= LIBRARY_PREVIEW) return it
  return { ...it, body: chars.slice(0, LIBRARY_PREVIEW).join(''), cut: true }
}
const LIBRARY_KINDS = ['note', 'link', 'product', 'place', 'file'] as const
/** Library kind names (shown to the AI in English; Korean names for matching are in region/kr/life.ts) */
const LIBRARY_LABEL: Record<LibraryItem['kind'], string> = {
  note: 'Note',
  link: 'Link',
  product: 'Product',
  place: 'Place',
  file: 'File',
}
export class Life {
  /** Language of the text people read (feed titles); the daemon sets it from settings */
  lang: () => Lang = () => 'ko'
  /** Read a photo sent from the phone (the daemon attaches it) */
  photo?: (name: string) => Promise<string>
  /** On change (send again to phone and PC) */
  onChange?: () => void
  /** When a scheduled task is due (sent as a chat message and Dool2 does it) */
  onDue?: (r: Routine) => void
  /** When fresh personalized ideas are needed (the daemon asks Dool2 in the feed chat) */
  onIdeas?: () => void
  ideasBusy = false
  /** Looking ahead: whether any service is connected (the daemon attaches it; with none, nothing is checked) */
  watchSources?: () => string[]
  /** Looking ahead: when to look (the daemon asks Dool2 in the feed chat) */
  onWatch?: (lastAt?: string) => void
  /** When a look-ahead item was posted to the feed (the daemon notifies the phone) */
  onTell?: (f: FeedItem) => void
  watchBusy = false
  /** How many were posted in this look (so not too many are announced at once) */
  private told = 0

  constructor(
    private readonly kv: Kv,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Cached lists (so the settings table JSON is not parsed on every call). All writes go through put, which keeps it in sync.
   * If the daemon cleared the settings table directly (start over), empty it with reload()
   */
  private cache = new Map<string, unknown[]>()
  private list<T>(key: string): T[] {
    const hit = this.cache.get(key)
    if (hit) return hit as T[]
    const v = this.kv.getSetting(key)
    const list = Array.isArray(v) ? (v as T[]) : []
    this.cache.set(key, list)
    return list
  }
  /** Read again after the settings table was changed from outside */
  reload() {
    this.cache.clear()
  }
  private put<T>(key: keyof typeof LIMIT, items: T[]) {
    let keep = items.slice(0, LIMIT[key])
    if (key === 'feed') {
      // News older than 90 days is deleted (everything newer can be viewed in pages)
      const since = new Date(this.now().getTime() - FEED_KEEP_DAYS * 86_400_000).toISOString()
      keep = (keep as FeedItem[]).filter((f) => f.at >= since) as T[]
    }
    this.kv.setSetting(key, keep)
    this.cache.set(key, keep)
    this.onChange?.()
  }

  // ── Goals ──
  routines(): Routine[] {
    return this.list<Routine>('routines')
  }
  addRoutine(input: {
    title: string
    prompt: string
    schedule?: RoutineSchedule
    category?: GoalCategory
    plan?: string[]
    target?: 'chat' | 'feed'
    until?: string
    notify?: 'always' | 'when_found'
    tellAt?: string
    check?: RoutineCheck
  }): Routine {
    const now = this.now()
    const next = input.schedule ? nextRun(input.schedule, now) : undefined
    const r: Routine = {
      id: randomUUID(),
      title: input.title.slice(0, 60) || lifeText(this.lang()).unnamedGoal,
      prompt: input.prompt.slice(0, 1000),
      enabled: true,
      createdAt: now.toISOString(),
      ...(input.schedule ? { schedule: input.schedule } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.target === 'feed' ? { target: 'feed' as const } : {}),
      ...(input.plan?.length
        ? { plan: input.plan.slice(0, 12).map((t) => ({ text: t.slice(0, 120), done: false })) }
        : {}),
      ...(next ? { nextRunAt: next.toISOString() } : {}),
      ...(input.until?.trim() ? { until: input.until.trim().slice(0, 120) } : {}),
      ...(input.notify === 'when_found' ? { notify: 'when_found' as const } : {}),
      ...(input.tellAt ? { tellAt: input.tellAt } : {}),
      ...(input.check ? { check: input.check } : {}),
    }
    this.put('routines', [r, ...this.routines()])
    // A task made by a feed instruction is not announced in the feed
    if (r.target !== 'feed')
      this.feed({
        kind: 'goal',
        title: `${r.category ? lifeText(this.lang()).goalMade : lifeText(this.lang()).scheduled}: ${r.title}`,
        ...(r.schedule
          ? { body: [scheduleLabel(r.schedule), ruleLabel(r)].filter(Boolean).join(' · ') }
          : {}),
        ref: r.id,
      })
    return r
  }
  /** Edit a goal: plan steps, progress log, and the notice's time, end and when to notify */
  updateGoal(
    id: string,
    patch: {
      plan?: string[]
      done?: number[]
      log?: string
      title?: string
      prompt?: string
      schedule?: RoutineSchedule
      /** An empty text clears the end */
      until?: string
      notify?: 'always' | 'when_found'
      /** An empty text clears the notice delay */
      tellAt?: string
      /** A new quick check (ADR 0031): starts over from a new baseline */
      check?: RoutineCheck
    },
  ) {
    const list = this.routines()
    const r = list.find((x) => x.id === id || x.id.startsWith(id))
    if (!r) return undefined
    if (patch.title) r.title = patch.title.slice(0, 60)
    if (patch.prompt) r.prompt = patch.prompt.slice(0, 1000)
    if (patch.schedule) {
      r.schedule = patch.schedule
      const next = nextRun(patch.schedule, this.now())
      if (next) {
        r.nextRunAt = next.toISOString()
        r.enabled = true
        delete r.endedAt
      } else delete r.nextRunAt
    }
    if (patch.until !== undefined) {
      if (patch.until.trim()) r.until = patch.until.trim().slice(0, 120)
      else delete r.until
    }
    if (patch.notify === 'when_found') r.notify = 'when_found'
    else if (patch.notify === 'always') delete r.notify
    if (patch.tellAt !== undefined) {
      if (patch.tellAt) r.tellAt = patch.tellAt
      else delete r.tellAt
    }
    if (patch.check) {
      r.check = patch.check
      delete r.checkPrint
      delete r.checkText
      delete r.checkFails
    }
    if (patch.plan) r.plan = patch.plan.slice(0, 12).map((t) => ({ text: t.slice(0, 120), done: false }))
    for (const i of patch.done ?? []) if (r.plan?.[i]) r.plan[i].done = true
    if (patch.log)
      r.log = [{ at: this.now().toISOString(), text: patch.log.slice(0, 300) }, ...(r.log ?? [])].slice(0, 50)
    this.put('routines', list)
    return r
  }
  updateRoutine(id: string, patch: Partial<Pick<Routine, 'enabled' | 'title'>>) {
    const list = this.routines()
    const r = list.find((x) => x.id === id)
    if (!r) return undefined
    Object.assign(r, patch)
    if (patch.enabled) {
      // Turning on one that ended: clear an end date that comes before the next run (so it does not turn off again right away)
      delete r.endedAt
      const end = untilEnd(r.until)
      const next = r.schedule ? nextRun(r.schedule, this.now()) : undefined
      if (end && (end <= this.now() || (next && next >= end))) delete r.until
    }
    if (patch.enabled && r.schedule) {
      const next = nextRun(r.schedule, this.now())
      if (next) r.nextRunAt = next.toISOString()
    }
    this.put('routines', list)
    return r
  }
  removeRoutine(id: string) {
    const list = this.routines()
    const next = list.filter((x) => x.id !== id)
    if (next.length === list.length) return false
    this.put('routines', next)
    return true
  }
  /**
   * Record one quick-check result (ADR 0031). The first result is only the baseline. Returns whether it changed and
   * the short text before and now, so the daemon wakes Dool2 only on a change
   */
  noteCheck(
    id: string,
    print: string,
    text: string,
  ): { first: boolean; changed: boolean; before?: string; now: string } | undefined {
    const list = this.routines()
    const r = list.find((x) => x.id === id)
    if (!r) return undefined
    const first = r.checkPrint === undefined
    const changed = !first && r.checkPrint !== print
    const before = r.checkText
    r.checkPrint = print
    r.checkText = text.slice(0, 600)
    delete r.checkFails
    this.put('routines', list)
    return { first, changed, ...(before !== undefined ? { before } : {}), now: r.checkText }
  }
  /** A quick check failed: how many times in a row now */
  noteCheckFail(id: string): number {
    const list = this.routines()
    const r = list.find((x) => x.id === id)
    if (!r) return 0
    r.checkFails = (r.checkFails ?? 0) + 1
    this.put('routines', list)
    return r.checkFails
  }
  /** Take out what is due now and set the next time (the daemon calls this every 30 seconds) */
  tick() {
    if (this.ideasDue() && !this.ideasBusy && (this.memory().length || this.routines().length))
      this.refreshIdeas()
    if (
      this.watchOn() &&
      !this.watchBusy &&
      (this.watchSources?.().length || this.knowDue().length) &&
      this.watchDue()
    )
      this.watchNow()
    const now = this.now()
    const list = this.routines()
    const ripe = list.filter((r) => r.enabled && r.nextRunAt && Date.parse(r.nextRunAt) <= now.getTime())
    if (!ripe.length) return []
    const due: Routine[] = []
    for (const r of ripe) {
      const end = untilEnd(r.until)
      // If the end date has passed, do not run and turn it off (the PC was off and started late)
      if (end && end <= now) {
        this.end(r)
        continue
      }
      due.push(r)
      r.lastRunAt = now.toISOString()
      const next = r.schedule ? nextRun(r.schedule, now) : undefined
      if (next && !(end && next >= end)) r.nextRunAt = next.toISOString()
      else if (next)
        this.end(r) // this is the last run before the end date
      else {
        delete r.nextRunAt
        r.enabled = false
      }
    }
    this.put('routines', list)
    for (const r of due) this.onDue?.(r)
    return due
  }
  /** Turn itself off when the end time comes */
  private end(r: Routine) {
    delete r.nextRunAt
    r.enabled = false
    r.endedAt = this.now().toISOString()
  }
  /** Try once right now */
  runNow(id: string) {
    const r = this.routines().find((x) => x.id === id)
    if (r) this.onDue?.(r)
    return r
  }
  /**
   * Record the result of a run. For a task that only reports when a condition holds, an answer of "${QUIET_MARK}" is not posted to the feed (quiet),
   * and a mark saying the end condition came true turns it off (ended). The daemon does not notify the phone when quiet
   */
  noteRun(id: string, answer: string): { quiet: boolean; ended: boolean; item?: FeedItem } | undefined {
    const list = this.routines()
    const r = list.find((x) => x.id === id)
    if (!r) return
    const { quiet, ended, text: result } = readRun(r, answer)
    r.lastResult = result.slice(0, 300)
    // Keep plenty of what was reported, so a watch does not report the same news on the next run
    if (r.notify === 'when_found' && !quiet) r.lastTold = result.slice(0, 1500)
    if (ended) this.end(r)
    if (r.category && !quiet)
      r.log = [{ at: this.now().toISOString(), text: result.slice(0, 300) }, ...(r.log ?? [])].slice(0, 50)
    this.put('routines', list)
    if (quiet) return { quiet, ended }
    if (r.target === 'feed') {
      // The first line of the answer is the title, the rest is the text
      const lines = result.trim().split('\n')
      const head = (lines[0] ?? '').replace(/^#+\s*|\*\*/g, '').trim()
      const body = lines.slice(1).join('\n').trim()
      const item = this.feed({
        kind: 'post',
        title: head.slice(0, 80) || lifeText(this.lang()).todayNews,
        body: (body || result).slice(0, 2000),
        ref: r.id,
      })
      return { quiet, ended, item }
    }
    const item = this.feed({ kind: 'routine', title: r.title, body: result.slice(0, 2000), ref: r.id })
    return { quiet, ended, item }
  }

  // ── Library ──
  library(): LibraryItem[] {
    return this.list<LibraryItem>('library')
  }
  save(input: Omit<LibraryItem, 'id' | 'savedAt'>): LibraryItem {
    const item: LibraryItem = { ...input, id: randomUUID(), savedAt: this.now().toISOString() }
    // If the same PC file is made again (rewritten under the same name), drop the old slot and put only the new one on top
    const rest = item.path ? this.library().filter((x) => x.path !== item.path) : this.library()
    this.put('library', [item, ...rest])
    this.feed({
      kind: 'saved',
      title: `${lifeText(this.lang()).savedToLibrary}: ${item.title}`,
      ref: item.id,
    })
    return item
  }
  /** Collapse several slots of the same PC file into the latest one (older versions added a slot on every rewrite). Once at startup */
  tidyLibrary(): number {
    const list = this.library()
    const seen = new Set<string>()
    const next = list.filter((x) => !x.path || (!seen.has(x.path) && Boolean(seen.add(x.path))))
    if (next.length !== list.length) this.put('library', next)
    return list.length - next.length
  }
  /** Attach a small preview for lists (after the PC app shrinks it) */
  setThumb(id: string, thumb: string) {
    const list = this.library()
    const it = list.find((x) => x.id === id)
    if (!it) return
    it.thumb = thumb
    this.put('library', list)
  }
  unsave(id: string) {
    const list = this.library()
    const next = list.filter((x) => x.id !== id)
    this.put('library', next)
    return next.length !== list.length
  }
  /** One page of the library (per tab, latest first). Only the start of the text */
  libraryPage(o: { tab?: LibraryTab; before?: string; limit?: number } = {}): Page<LibraryItem> {
    const tab = o.tab ?? 'made'
    const p = pageOf(
      this.library().filter((it) => inTab(it, tab)),
      libraryAt,
      o,
    )
    // List previews are sent up to 250KB in total (the phone envelope limit is 500KB, including growth from encryption)
    let room = 250_000
    const items = p.items.map(preview).map((it) => {
      if (!it.thumb) return it
      room -= it.thumb.length
      if (room >= 0) return it
      const { thumb: _t, ...rest } = it
      return rest
    })
    return { ...p, items }
  }
  /** One library item (full text) */
  libraryItem(id: string): LibraryItem | undefined {
    return this.library().find((x) => x.id === id)
  }

  // ── Memory ──
  memory(): MemoryItem[] {
    return this.list<MemoryItem>('memory')
  }
  remember(text: string, source: MemoryItem['source'] = 'doori'): MemoryItem {
    const t = text.trim().slice(0, 200)
    const list = this.memory()
    const same = list.find((m) => m.text === t)
    if (same) return same
    const m: MemoryItem = { id: randomUUID(), text: t, source, at: this.now().toISOString() }
    this.put('memory', [m, ...list])
    return m
  }
  forget(id: string) {
    const list = this.memory()
    const next = list.filter((x) => x.id !== id)
    this.put('memory', next)
    return next.length !== list.length
  }
  /** Memories to add to the instructions (latest 40) */
  memoryPrompt(): string {
    const list = this.memory().slice(0, 40)
    if (!list.length) return ''
    return `## What you remember about the user (use it naturally, and call memory_forget if it is wrong)\n${list.map((m) => `- ${m.text}`).join('\n')}`
  }

  // ── Known facts (lookup memory and the ledger of what was done) ──
  know(): KnowItem[] {
    return this.list<KnowItem>('know')
  }
  /** If the same one exists (same kind, name and place), replace it with the new value */
  knowSave(x: Partial<KnowItem> & { title: string; value: string; kind: KnowItem['kind'] }): KnowItem {
    const now = this.now().toISOString()
    const title = x.title.trim().slice(0, 80)
    const source = x.source?.trim().slice(0, 40) || undefined
    const list = this.know()
    const same = list.find(
      (k) => k.kind === x.kind && k.title === title && (k.source ?? '') === (source ?? ''),
    )
    const iso = (v?: string) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined)
    const item: KnowItem = {
      id: same?.id ?? randomUUID(),
      kind: x.kind,
      title,
      value: x.value.trim().slice(0, 200),
      ...(source ? { source } : {}),
      ...(x.url && /^https:\/\//.test(x.url) ? { url: x.url.slice(0, 500) } : {}),
      ...(x.basis ? { basis: x.basis.trim().slice(0, 40) } : {}),
      seenAt: iso(x.seenAt) ?? now,
      ...(iso(x.next) ? { next: iso(x.next) } : {}),
      ...(x.nextWhat ? { nextWhat: x.nextWhat.trim().slice(0, 80) } : {}),
      ...(x.kind === 'done' ? { state: x.state === 'done' ? 'done' : 'open' } : {}),
      updatedAt: now,
    }
    this.put('know', [item, ...list.filter((k) => k.id !== item.id)])
    return item
  }
  knowUpdate(
    q: string,
    patch: { value?: string; state?: 'open' | 'done'; next?: string | null; nextWhat?: string },
  ): KnowItem | undefined {
    const list = this.know()
    const hit = list.find((k) => k.id === q || k.id.startsWith(q)) ?? list.find((k) => k.title.includes(q))
    if (!hit) return undefined
    const next =
      patch.next === null
        ? undefined
        : patch.next && !Number.isNaN(Date.parse(patch.next))
          ? new Date(patch.next).toISOString()
          : hit.next
    const item: KnowItem = {
      ...hit,
      ...(patch.value ? { value: patch.value.trim().slice(0, 200) } : {}),
      ...(patch.state ? { state: patch.state } : {}),
      ...(patch.nextWhat ? { nextWhat: patch.nextWhat.trim().slice(0, 80) } : {}),
      updatedAt: this.now().toISOString(),
    }
    if (next) item.next = next
    else delete item.next
    // Finished tasks are not followed up any more
    if (item.state === 'done') delete item.next
    this.put('know', [item, ...list.filter((k) => k.id !== hit.id)])
    return item
  }
  knowForget(id: string) {
    const list = this.know()
    const next = list.filter((x) => x.id !== id)
    this.put('know', next)
    return next.length !== list.length
  }
  /** Tasks due for a follow-up (the next follow-up time has passed and they are still in progress) */
  knowDue(): KnowItem[] {
    const now = this.now().getTime()
    return this.know().filter((k) => k.state !== 'done' && k.next && Date.parse(k.next) <= now)
  }
  /** Known facts to add to the instructions: tasks in progress and recent facts (with dates, the AI decides whether to use them) */
  knowPrompt(): string {
    const list = this.know()
    if (!list.length) return ''
    const open = list.filter((k) => k.kind === 'done' && k.state !== 'done').slice(0, 15)
    const facts = list.filter((k) => k.kind === 'fact').slice(0, 20)
    return [
      `## What Dool2 knows (today ${knowDay(this.now().toISOString())}. Look at the basis date and the day it was seen and judge for yourself whether it is still usable. Re-check anything a decision depends on. To look for more, use know_find)`,
      ...(open.length ? ['In progress:', ...open.map(knowLine)] : []),
      ...(facts.length ? ['Known facts:', ...facts.map(knowLine)] : []),
    ].join('\n')
  }

  // ── Feed ──
  feedItems(): FeedItem[] {
    return this.list<FeedItem>('feed')
  }
  /** One page of the feed (latest first). With kinds, only those kinds (activity: done, routine) */
  feedPage(o: { before?: string; limit?: number; kinds?: FeedItem['kind'][] } = {}): Page<FeedItem> {
    const kinds = o.kinds?.length ? new Set(o.kinds) : undefined
    const all = this.feedItems()
    return pageOf(kinds ? all.filter((f) => kinds.has(f.kind)) : all, feedAt, o)
  }
  /** What Dool2 did this week: the count per day over the last `days` days (the last is today, in this PC's time) */
  feedDays(days = 60, all = this.feedItems()): number[] {
    const out = Array<number>(days).fill(0)
    const start = new Date(this.now())
    start.setHours(0, 0, 0, 0)
    const today = start.getTime()
    for (const f of all) {
      if (!DONE_KINDS.has(f.kind)) continue
      const d = new Date(f.at)
      d.setHours(0, 0, 0, 0)
      const ago = Math.round((today - d.getTime()) / 86_400_000)
      if (ago >= 0 && ago < days) out[days - 1 - ago] = (out[days - 1 - ago] ?? 0) + 1
    }
    return out
  }
  feed(input: Omit<FeedItem, 'id' | 'at'>): FeedItem {
    const item: FeedItem = { ...input, id: randomUUID(), at: this.now().toISOString() }
    this.put('feed', [item, ...this.feedItems()])
    return item
  }
  react(id: string, reaction?: 'up' | 'down') {
    const list = this.feedItems()
    const f = list.find((x) => x.id === id)
    if (!f) return
    if (reaction) f.reaction = reaction
    else delete f.reaction
    this.put('feed', list)
  }
  /**
   * Post a look-ahead item: skip it if the same key (or the same title when no key) was announced within 30 days.
   * When posted, the phone is notified through onTell. Up to 3 per look
   */
  tell(input: {
    title: string
    body?: string
    from?: string
    key?: string
    ask?: string
    askLabel?: string
  }): FeedItem | 'dup' | 'full' {
    const title = input.title.trim().slice(0, 80)
    const key = (input.key ?? '').trim().toLowerCase().slice(0, 120) || undefined
    const since = this.now().getTime() - 30 * 86_400_000
    const dup = this.feedItems().some(
      (f) => f.kind === 'suggest' && Date.parse(f.at) >= since && (key ? f.key === key : f.title === title),
    )
    if (dup) return 'dup'
    if (this.watchBusy && this.told >= 3) return 'full'
    const f = this.feed({
      kind: 'suggest',
      title: title || lifeText(this.lang()).suggestFallback,
      ...(input.body?.trim() ? { body: input.body.trim().slice(0, 600) } : {}),
      ...(input.from?.trim() ? { from: input.from.trim().slice(0, 60) } : {}),
      ...(key ? { key } : {}),
      ...(input.ask?.trim() ? { ask: input.ask.trim().slice(0, 300) } : {}),
      ...(input.ask?.trim() && input.askLabel?.trim()
        ? { askLabel: input.askLabel.trim().slice(0, 12) }
        : {}),
    })
    if (this.watchBusy) this.told++
    this.onTell?.(f)
    return f
  }
  /** What was announced recently (shown to Dool2 when it looks, so it does not post the same again) */
  recentTells(days = 14): FeedItem[] {
    const since = this.now().getTime() - days * 86_400_000
    return this.feedItems()
      .filter((f) => f.kind === 'suggest' && Date.parse(f.at) >= since)
      .slice(0, 20)
  }

  // ── Looking ahead ──
  watchOn(): boolean {
    return this.kv.getSetting('watchOff') !== true
  }
  setWatch(on: boolean) {
    this.kv.setSetting('watchOff', !on)
    this.onChange?.()
  }
  /**
   * Look once after each full hour from 6 AM to 10 PM Korean time (user decision 11-20: merged with the ledger of what was done, once an hour).
   * Not at night (after 22:00 until 6:00), so the phone does not ring while people sleep. If the PC starts late, it still looks within that day
   */
  private watchDue(): boolean {
    const now = this.now()
    const KST = 9 * 3600_000
    const kst = new Date(now.getTime() + KST)
    const hour = kst.getUTCHours()
    if (hour < 6 || hour > 22) return false
    const last = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), hour, 0) - KST
    const done = this.kv.getSetting('watchAt')
    return typeof done !== 'string' || Date.parse(done) < last
  }
  /** Look now (when the time came, or when pressed on a screen) */
  watchNow() {
    if (this.watchBusy) return
    this.watchBusy = true
    this.told = 0
    const prev = this.kv.getSetting('watchAt')
    this.kv.setSetting('watchAt', this.now().toISOString())
    this.onChange?.()
    this.onWatch?.(typeof prev === 'string' ? prev : undefined)
  }
  watchDone() {
    if (!this.watchBusy) return
    this.watchBusy = false
    this.onChange?.()
  }

  feedPrompt(): string | undefined {
    const v = this.kv.getSetting('feedPrompt')
    return typeof v === 'string' && v ? v : undefined
  }
  /** Feed instruction: write a feed post as told every day at 7:30 AM (only one is kept) */
  setFeedPrompt(text: string) {
    const t = text.trim().slice(0, 300)
    this.kv.setSetting('feedPrompt', t)
    const list = this.routines().filter(
      (r) => !(r.target === 'feed' && FEED_ROUTINE_TITLES.includes(r.title)),
    )
    this.kv.setSetting('routines', list)
    this.cache.set('routines', list)
    if (t)
      this.addRoutine({
        title: lifeText(this.lang()).feedRoutine,
        prompt: `Write today's feed post: ${t}\nThis answer is posted to the feed as it is (do not use the feed_post tool). The first line is a short title, then a list of 3 to 5 key lines. Write only what you confirmed and put the source site names at the very end. Do not write things like "posted". Write in the same language as this request.`,
        schedule: { kind: 'daily', time: '07:30' },
        target: 'feed',
      })
    else this.onChange?.()
  }

  ideas(): SuggestedIdea[] {
    return this.list<SuggestedIdea>('ideas')
  }
  setIdeas(list: SuggestedIdea[]) {
    this.kv.setSetting(
      'ideas',
      list
        .slice(0, 6)
        .map((i) => ({ text: String(i.text).slice(0, 120), why: String(i.why ?? '').slice(0, 120) })),
    )
    this.kv.setSetting('ideasAt', this.now().toISOString())
    this.ideasBusy = false
    this.onChange?.()
  }
  /** Search anew once a day, after 6 AM (Korean time) each day */
  private ideasDue(): boolean {
    const at = this.kv.getSetting('ideasAt')
    const now = this.now()
    const kst = new Date(now.getTime() + 9 * 3600_000)
    const six = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 6) - 9 * 3600_000
    if (now.getTime() < six) return false
    return typeof at !== 'string' || Date.parse(at) < six
  }
  refreshIdeas() {
    if (this.ideasBusy) return
    this.ideasBusy = true
    this.onChange?.()
    this.onIdeas?.()
  }

  identity(): Identity {
    const v = this.kv.getSetting('identity')
    return v && typeof v === 'object' ? (v as Identity) : {}
  }

  /**
   * What to send to the first screen of phone and PC. Long lists (feed, library) send only the first page and the rest by page (feedPage, libraryPage).
   * logs: how many progress records to send per goal (the phone shows only 8 lines)
   */
  state(o: { logs?: number } = {}): LifeState {
    const feedPrompt = this.feedPrompt()
    const identity = this.identity()
    const ideas = this.ideas()
    const ideasAt = this.kv.getSetting('ideasAt')
    const watchAt = this.kv.getSetting('watchAt')
    const logs = o.logs ?? LOG_SENT
    const all = this.feedItems()
    const feed = pageOf(all, feedAt, { limit: PAGE_SIZE })
    const lib = this.library()
    const made = this.libraryPage({ tab: 'made' })
    const files = this.libraryPage({ tab: 'files' })
    const fileCount = lib.filter((it) => inTab(it, 'files')).length
    return {
      ...(ideas.length ? { ideas } : {}),
      ...(typeof ideasAt === 'string' ? { ideasAt } : {}),
      ...(this.ideasBusy ? { ideasBusy: true } : {}),
      ...(Object.keys(identity).length ? { identity } : {}),
      routines: this.routines().map((r) =>
        r.log && r.log.length > logs ? { ...r, log: r.log.slice(0, logs) } : r,
      ),
      library: [...made.items, ...files.items],
      ...(made.next || files.next
        ? {
            libraryNext: {
              ...(made.next ? { made: made.next } : {}),
              ...(files.next ? { files: files.next } : {}),
            },
          }
        : {}),
      libraryCount: { made: lib.length - fileCount, files: fileCount },
      memory: this.memory(),
      know: this.know().slice(0, 100),
      feed: feed.items,
      ...(feed.next ? { feedNext: feed.next } : {}),
      feedDays: this.feedDays(60, all),
      ...(feedPrompt ? { feedPrompt } : {}),
      watch: {
        on: this.watchOn(),
        ...(typeof watchAt === 'string' ? { at: watchAt } : {}),
        ...(this.watchBusy ? { busy: true } : {}),
      },
    }
  }

  /** Something done on the phone or PC screen */
  act(a: LifeAction): string | undefined {
    switch (a.action) {
      case 'routine-create': {
        const r = this.addRoutine({
          title: a.title,
          prompt: a.prompt,
          ...(a.schedule ? { schedule: a.schedule } : {}),
          ...(a.category ? { category: a.category } : {}),
        })
        return r.id
      }
      case 'routine-toggle':
        this.updateRoutine(a.id, { enabled: a.on })
        return
      case 'routine-delete':
        this.removeRoutine(a.id)
        return
      case 'routine-run':
        this.runNow(a.id)
        return
      case 'goal-step': {
        const list = this.routines()
        const r = list.find((x) => x.id === a.id)
        const step = r?.plan?.[a.index]
        if (step) {
          step.done = a.done
          this.put('routines', list)
        }
        return
      }
      case 'feed-react':
        this.react(a.id, a.reaction)
        return
      case 'feed-answer': {
        const list = this.feedItems()
        const f = list.find((x) => x.id === a.id)
        if (f?.ask && !f.answered) {
          f.answered = a.answer
          this.put('feed', list)
        }
        return
      }
      case 'feed-prompt':
        this.setFeedPrompt(a.text)
        return
      case 'library-save':
        return this.save({
          kind: a.itemKind ?? 'note',
          title: a.title.slice(0, 80) || lifeText(this.lang()).savedNote,
          body: a.body.slice(0, 4000),
        }).id
      case 'library-delete':
        this.unsave(a.id)
        return
      case 'memory-add':
        return this.remember(a.text, 'user').id
      case 'memory-delete':
        this.forget(a.id)
        return
      case 'know-delete':
        this.knowForget(a.id)
        return
      case 'ideas-refresh':
        this.refreshIdeas()
        return
      case 'watch':
        this.setWatch(a.on)
        return
      case 'watch-now':
        if (this.watchSources?.().length || this.knowDue().length) this.watchNow()
        return
      case 'identity': {
        const next: Identity = { ...this.identity() }
        if (a.userName !== undefined) next.userName = a.userName.trim().slice(0, 20) || undefined
        if (a.tone) next.tone = a.tone
        if (a.length) next.length = a.length
        this.kv.setSetting('identity', JSON.parse(JSON.stringify(next)))
        this.onChange?.()
        return
      }
    }
  }

  // ── AI tools (life_*) ──
  run(tool: string, a: Record<string, unknown>): ToolResult {
    try {
      switch (tool) {
        case 'goal_create': {
          let schedule = a.schedule ? parseSchedule(a) : undefined
          if (a.schedule && !schedule) return bad(scheduleHelp(a))
          // Quick check (ADR 0031): checked by the daemon (index.ts) before it gets here
          const check = readCheck(a)
          if (typeof check === 'string') return bad(check)
          const fast = everyFloor(schedule, check)
          if (typeof fast === 'string') return bad(fast)
          schedule = fast
          const rule = readRule(a)
          if (typeof rule === 'string') return bad(rule)
          const end = untilEnd(rule.until)
          const first = schedule ? nextRun(schedule, this.now()) : undefined
          if (end && end <= this.now())
            return bad(
              `The end date (${rule.until}) has already passed. Ask the user again until when it should run.`,
            )
          if (end && first && first >= end)
            return bad(
              `The first run (${kstWhen(first.toISOString())}) is later than the end date (${rule.until}), so it would never run. Fix the end date.`,
            )
          const category = GOAL_CATEGORIES.includes(a.category as GoalCategory)
            ? (a.category as GoalCategory)
            : undefined
          const plan = Array.isArray(a.plan) ? a.plan.map(String).filter(Boolean) : undefined
          const r = this.addRoutine({
            title: String(a.title ?? ''),
            prompt: String(a.prompt ?? ''),
            ...(schedule ? { schedule } : {}),
            ...(category ? { category } : {}),
            ...(plan ? { plan } : {}),
            ...(a.target === 'feed' ? { target: 'feed' as const } : {}),
            ...rule,
            ...(rule.tellAt === undefined && morningTell(schedule, `${a.title ?? ''} ${a.prompt ?? ''}`)
              ? { tellAt: '07:00' }
              : {}),
            ...(check ? { check: check.check } : {}),
          })
          return ok(
            [
              `${category ? 'Goal' : 'Reminder'} created: "${r.title}" [id ${r.id.slice(0, 8)}]`,
              `What was set: ${ruleSentence(r)}.`,
              ...(check?.note ? [check.note] : []),
              ...ruleGaps(r),
              'Confirm with the user by telling them "What was set" as it is, in one sentence.',
              // Also give what exists now, so an old reminder from the chat is not trusted ("it already exists") and a requested task left out
              otherRoutines(this.routines(), r.id),
              ...(a.preview === true
                ? [
                    'Preview: do the task once now in this chat, following the prompt, in the same shape as what will be received at the set time. Put "What was set" below it in one line.',
                  ]
                : r.notify === 'when_found'
                  ? [
                      // Do not end a watch with only "I will tell you from tomorrow": show what exists now first
                      'Current state: show what exists right now in this answer. If you have not looked yet, search once following the prompt (for news or posts, use show_list with the original link on each row, and widen to this week if today has little. For a condition watch, one or two lines of the current value or state and the source). Put "What was set" below it in one line.',
                    ]
                  : []),
            ].join('\n'),
          )
        }
        case 'goal_update': {
          // If only a time is given ("change it to 7" → time only), keep the rest of the current schedule (daily, weekday, date)
          const cur = this.routines().find((x) => x.id === a.id || x.id.startsWith(String(a.id ?? '-')))
          const whenGiven = WHEN_KEYS.some((k) => a[k] !== undefined)
          const merged = whenGiven
            ? {
                ...(cur?.schedule ?? {}),
                ...Object.fromEntries(WHEN_KEYS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]])),
                schedule: a.schedule ?? cur?.schedule?.kind,
              }
            : undefined
          let schedule = merged ? parseSchedule(merged) : undefined
          if (merged && !schedule) return bad(scheduleHelp(merged))
          const check = readCheck(a)
          if (typeof check === 'string') return bad(check)
          // The interval floor uses the check it will have: the new one, else the one it already has
          const keep = check ?? (cur?.check ? { check: cur.check, minMinutes: 1 } : undefined)
          if (schedule || check) {
            const fast = everyFloor(schedule ?? cur?.schedule, keep)
            if (typeof fast === 'string') return bad(fast)
            if (schedule || fast !== cur?.schedule) schedule = fast
          }
          const rule = readRule(a)
          if (typeof rule === 'string') return bad(rule)
          const end = untilEnd(rule.until)
          if (end && end <= this.now())
            return bad(
              `The end date (${rule.until}) has already passed. Ask the user again until when it should run.`,
            )
          const patch = {
            ...(Array.isArray(a.plan) ? { plan: a.plan.map(String) } : {}),
            ...(Array.isArray(a.done) ? { done: a.done.map(Number) } : {}),
            ...(a.log ? { log: String(a.log) } : {}),
            ...(a.title ? { title: String(a.title) } : {}),
            ...(a.prompt ? { prompt: String(a.prompt) } : {}),
            ...(schedule ? { schedule } : {}),
            ...(typeof a.until === 'string' ? { until: a.until } : {}),
            ...(rule.notify ? { notify: rule.notify } : {}),
            ...(rule.tellAt !== undefined ? { tellAt: rule.tellAt } : {}),
            ...(check ? { check: check.check } : {}),
          }
          if (!cur) return bad('No such goal. Check the id with goal_list.')
          // Do not say "updated" when nothing changed
          if (!Object.keys(patch).length)
            return bad('Nothing to change. Give what to change (time, schedule, prompt, until, etc.).')
          const r = this.updateGoal(cur.id, patch)
          if (!r) return bad('No such goal. Check the id with goal_list.')
          const timing = schedule || a.until !== undefined || rule.notify || rule.tellAt !== undefined
          return ok(
            timing
              ? [`Updated: "${r.title}"`, `What was set: ${ruleSentence(r)}.`, ...ruleGaps(r)].join('\n')
              : `Goal updated: ${r.title}`,
          )
        }
        case 'idea_suggest': {
          const list = Array.isArray(a.ideas) ? (a.ideas as SuggestedIdea[]) : []
          const ok2 = list.filter((i) => i && typeof i.text === 'string' && i.text.trim())
          if (!ok2.length) return bad('ideas is empty. Give 3 to 6 items as [{text, why}].')
          this.setIdeas(ok2)
          return ok(`Posted ${Math.min(ok2.length, 6)} ideas to the Ideas tab.`)
        }
        case 'feed_post': {
          const f = this.feed({
            kind: 'post',
            title: String(a.title ?? '').slice(0, 80) || lifeText(this.lang()).postFallback,
            body: String(a.body ?? '').slice(0, 1500),
          })
          return ok(`Posted to the feed: ${f.title}`)
        }
        case 'show_cards': {
          // The conversation engine keeps the record under the answer (threads.ts). Here we only report the cleaned result
          const cards = cleanCards(a.cards)
          if (!cards.length) return bad('No cards to attach. Give cards that have a title.')
          const pics = cards.filter((c) => c.image).length
          return ok(
            `Attaching ${cards.length} cards under the answer (${pics} with photos). In the answer text, do not repeat the same list; briefly say only why you picked them and the differences.`,
          )
        }
        // Result blocks: the conversation engine keeps the record under the answer (threads.ts). Here we only report the cleaned result
        case 'show_list': {
          const r = cleanRows(a)
          if (!r) return bad('No rows to attach. Give rows that have a title in rows.')
          const more =
            r.rows.length > 5
              ? ` The first 5 rows show and the other ${r.rows.length - 5} open on expand.`
              : ''
          const picked =
            r.pick === 'multi'
              ? ` ${r.rows.filter((x) => x.on).length} pre-selected.`
              : r.pick === 'one'
                ? ' Tapping a row sends the choice, so add no quick replies.'
                : ''
          return ok(
            `Attaching a list of ${r.rows.length} rows under the answer.${more}${picked} One result block per answer, so if you call another block only the last one is attached. In the answer text, do not repeat the same list; briefly say only the reason and what to do next.`,
          )
        }
        case 'show_result': {
          const r = cleanResult(a)
          if (!r) return bad('No big value (big). Put one value, like a time or an amount, in big.')
          return ok(
            'Attaching a result card under the answer. One result block per answer, so if you call another block only the last one is attached. In the answer text, do not repeat the same value; say just a sentence or two.',
          )
        }
        case 'show_route': {
          const r = cleanRoute(a)
          if (!r) return bad('Needs a conclusion (big) and legs (legs: line, from, to).')
          return ok(
            `Attaching a route card (${r.legs.length} legs) under the answer. One result block per answer, so if you call another block only the last one is attached. In the answer text, do not repeat the legs; say only the conclusion in one line and the alternative if they miss it.`,
          )
        }
        case 'show_draft': {
          const r = cleanDraft(a)
          if (!r) return bad('The text to send (text) is empty.')
          return ok(
            'Attaching the text to send under the answer ([Copy] and [Send] buttons). This tool does not send anything. When the user presses [Send], a message like "send the text you just wrote as it is" arrives, and you then get approval right before sending. In the answer text, do not repeat the text; say just a sentence or two.',
          )
        }
        case 'feed_tell': {
          const r = this.tell({
            title: String(a.title ?? ''),
            ...(a.body ? { body: String(a.body) } : {}),
            ...(a.from ? { from: String(a.from) } : {}),
            ...(a.key ? { key: String(a.key) } : {}),
            ...(a.ask ? { ask: String(a.ask) } : {}),
            ...(a.ask_label ? { askLabel: String(a.ask_label) } : {}),
          })
          if (r === 'dup') return ok('Already announced. Not posted again.')
          if (r === 'full')
            return bad('Only 3 are announced this time. Keep the most important ones and finish.')
          return ok(`Posted to the feed and notified the phone: ${r.title}`)
        }
        case 'goal_list': {
          const list = this.routines()
          if (!list.length) return ok('There are no goals yet.')
          return ok(
            list
              .map(
                (r) =>
                  `- [${r.id.slice(0, 8)}] ${r.category ? `(${r.category}) ` : ''}${r.title} · ${r.schedule ? scheduleLabel(r.schedule) : 'no set time'}${ruleLabel(r) ? ` · ${ruleLabel(r)}` : ''}${r.enabled ? '' : r.endedAt ? ' (ended)' : ' (off)'}${r.plan ? ` · plan ${r.plan.filter((p) => p.done).length}/${r.plan.length}` : ''}${r.lastResult ? ` · last result: ${r.lastResult.slice(0, 80)}` : ''}`,
              )
              .join('\n'),
          )
        }
        case 'goal_delete': {
          const id = String(a.id ?? '')
          const r = this.routines().find((x) => x.id === id || x.id.startsWith(id))
          if (!r || !this.removeRoutine(r.id)) return bad('No such goal. Check the id with goal_list.')
          return ok(`Goal deleted: ${r.title}`)
        }
        case 'library_save': {
          const kind = LIBRARY_KINDS.includes(a.kind as never) ? (a.kind as LibraryItem['kind']) : 'note'
          const item = this.save({
            kind,
            title: String(a.title ?? '').slice(0, 80) || lifeText(this.lang()).noTitle,
            body: String(a.body ?? '').slice(0, 4000),
            ...(a.url ? { url: String(a.url).slice(0, 500) } : {}),
            ...(a.price ? { price: String(a.price).slice(0, 40) } : {}),
          })
          return ok(`Saved to the library: ${item.title}`)
        }
        case 'library_find': {
          const kind = LIBRARY_KINDS.includes(a.kind as never) ? (a.kind as LibraryItem['kind']) : undefined
          return ok(
            findLibrary(this.library(), {
              query: String(a.query ?? ''),
              ...(kind ? { kind } : {}),
              limit: typeof a.limit === 'number' ? a.limit : 10,
              ...(typeof a.skip === 'number' ? { skip: a.skip } : {}),
            }),
          )
        }
        case 'feed_find': {
          const kinds = (Array.isArray(a.kinds) ? a.kinds : a.kind ? [a.kind] : []).filter(
            (k): k is FeedItem['kind'] => FEED_KINDS.includes(k as FeedItem['kind']),
          )
          return ok(
            findFeed(
              this.feedItems(),
              {
                query: String(a.query ?? ''),
                kinds,
                ...(typeof a.days === 'number' ? { days: a.days } : {}),
                ...(typeof a.before === 'string' ? { before: a.before } : {}),
                limit: typeof a.limit === 'number' ? a.limit : 15,
              },
              this.now(),
            ),
          )
        }
        case 'memory_save': {
          const m = this.remember(String(a.text ?? ''))
          return ok(`Remembered: ${m.text}`)
        }
        case 'know_save': {
          const kind = a.kind === 'done' ? 'done' : 'fact'
          const title = String(a.title ?? '').trim()
          const value = String(a.value ?? '').trim()
          if (!title || !value) return bad('title and value are required')
          const k = this.knowSave({
            kind,
            title,
            value,
            ...(typeof a.source === 'string' ? { source: a.source } : {}),
            ...(typeof a.url === 'string' ? { url: a.url } : {}),
            ...(typeof a.basis === 'string' ? { basis: a.basis } : {}),
            ...(typeof a.next === 'string' ? { next: a.next } : {}),
            ...(typeof a.next_what === 'string' ? { nextWhat: a.next_what } : {}),
            ...(a.state === 'done' ? { state: 'done' as const } : {}),
          })
          return ok(`Noted: ${knowLine(k)}${k.next ? ` — will look ahead on ${knowDay(k.next)}` : ''}`)
        }
        case 'know_find': {
          const q = String(a.query ?? '').trim()
          const kind = a.kind === 'done' || a.kind === 'fact' ? a.kind : undefined
          const words = q.split(/\s+/).filter(Boolean)
          const hits = this.know().filter(
            (k) =>
              (!kind || k.kind === kind) &&
              (!words.length ||
                words.some((w) => `${k.title} ${k.value} ${k.source ?? ''} ${k.basis ?? ''}`.includes(w))),
          )
          if (!hits.length)
            return ok(
              `Nothing known${q ? ` ("${q}")` : ''}. When you learn it from a lookup, save it with know_save.`,
            )
          return ok(
            [
              `Today is ${knowDay(this.now().toISOString())}. Look at the day it was seen and its basis and judge whether it is still usable (look it up again if it is stale or a decision depends on it):`,
              ...hits.slice(0, 30).map((k) => `${knowLine(k)} [id ${k.id.slice(0, 8)}]`),
            ].join('\n'),
          )
        }
        case 'know_update': {
          const q = String(a.id ?? a.title ?? '').trim()
          if (!q) return bad('id or title is required')
          const k = this.knowUpdate(q, {
            ...(typeof a.value === 'string' ? { value: a.value } : {}),
            ...(a.state === 'done' || a.state === 'open' ? { state: a.state } : {}),
            ...(a.next === null || a.next === ''
              ? { next: null }
              : typeof a.next === 'string'
                ? { next: a.next }
                : {}),
            ...(typeof a.next_what === 'string' ? { nextWhat: a.next_what } : {}),
          })
          if (!k) return bad('No such item. Check the id with know_find')
          return ok(`Updated: ${knowLine(k)}`)
        }
        case 'memory_forget': {
          const q = String(a.text ?? a.id ?? '')
          const m = this.memory().find((x) => x.id === q || x.id.startsWith(q) || x.text.includes(q))
          if (!m || !this.forget(m.id)) return bad('No such memory.')
          return ok(`Forgot: ${m.text}`)
        }
      }
      return bad(`Unknown tool: ${tool}`)
    } catch (e) {
      return bad((e as Error).message)
    }
  }
}

/** The fields that make up "when" */
const WHEN_KEYS = ['schedule', 'time', 'days', 'day', 'at', 'minutes'] as const

/** Clean up the "when" the AI gave */
/** Tasks Dool2 (the AI) runs itself: at most every 15 minutes (each run is a full answer turn) */
export const AI_EVERY_MIN = 15

/**
 * The quick check the daemon checked and attached (`_check`, ADR 0031). The AI cannot set `_check`: the daemon drops
 * it from the AI's input and sets it only after checking `check_tool` (index.ts)
 */
function readCheck(
  a: Record<string, unknown>,
): { check: RoutineCheck; minMinutes: number; note?: string } | undefined | string {
  const c = a._check as { tool?: unknown; input?: unknown; minMinutes?: unknown; note?: unknown } | undefined
  if (!c) return a.check_tool ? 'check_tool could not be checked. Try again.' : undefined
  if (typeof c.tool !== 'string' || !c.tool) return 'check_tool is missing.'
  return {
    check: {
      tool: c.tool,
      input: c.input && typeof c.input === 'object' ? (c.input as Record<string, unknown>) : {},
    },
    minMinutes: Math.max(1, Number(c.minMinutes) || 1),
    ...(typeof c.note === 'string' ? { note: c.note } : {}),
  }
}

/**
 * The shortest interval: 15 minutes for tasks the AI runs, down to 1 minute (or the service's own minimum) with a
 * quick check. Raises a quick check's interval to the service minimum instead of refusing
 */
function everyFloor(
  schedule: RoutineSchedule | undefined,
  check: { minMinutes: number } | undefined,
): RoutineSchedule | undefined | string {
  if (schedule?.kind !== 'every') return schedule
  if (!check && schedule.minutes < AI_EVERY_MIN)
    return `Every ${schedule.minutes} minutes is too often for a task Dool2 runs itself (${AI_EVERY_MIN} or more). For things that vanish fast (cancelled tickets, open tables, restocks), give check_tool (a lookup service tool) and check_input: the daemon then checks every 1 minute or more without you and wakes you only when the result changes. Otherwise use ${AI_EVERY_MIN} or more.`
  if (check && schedule.minutes < check.minMinutes) return { kind: 'every', minutes: check.minMinutes }
  return schedule
}

export function parseSchedule(a: Record<string, unknown>): RoutineSchedule | undefined {
  const kind = String(a.schedule ?? a.kind ?? '')
  const time = String(a.time ?? '')
  const okTime = /^([01]?\d|2[0-3]):[0-5]\d$/.test(time)
  const hhmm = okTime ? time.padStart(5, '0') : ''
  if (kind === 'daily' && hhmm) return { kind: 'daily', time: hhmm }
  if (kind === 'weekly' && hhmm) {
    const days = (Array.isArray(a.days) ? a.days : [])
      .map(Number)
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    if (days.length) return { kind: 'weekly', time: hhmm, days: [...new Set(days)] }
  }
  if (kind === 'monthly' && hhmm) {
    const day = Math.round(Number(a.day))
    if (day >= 1 && day <= 31) return { kind: 'monthly', time: hhmm, day }
  }
  if (kind === 'once' && typeof a.at === 'string' && !Number.isNaN(Date.parse(a.at)))
    return { kind: 'once', at: new Date(a.at).toISOString() }
  if (kind === 'every' && Number(a.minutes) >= 1)
    return { kind: 'every', minutes: Math.round(Number(a.minutes)) }
  return undefined
}

/** When "when" could not be read: what is missing */
function scheduleHelp(a: Record<string, unknown>): string {
  const kind = String(a.schedule ?? '')
  const need: Record<string, string> = {
    daily: 'time("09:00")',
    weekly: 'time and days (0=Sun … 6=Sat, several allowed)',
    monthly: 'time and day (1-31, 31 for the last day)',
    once: 'at (ISO time, with +09:00)',
    every: 'minutes (15 or more; 1 or more only with check_tool)',
  }
  return need[kind]
    ? `${kind} needs ${need[kind]}.`
    : 'Cannot tell when to run (schedule). Give one of daily, weekly, monthly, once, every.'
}

/** The end and notify settings the AI gave (the message to fix it if wrong) */
function readRule(
  a: Record<string, unknown>,
): { until?: string; notify?: 'always' | 'when_found'; tellAt?: string } | string {
  const out: { until?: string; notify?: 'always' | 'when_found'; tellAt?: string } = {}
  if (typeof a.tell_at === 'string') {
    const t = a.tell_at.trim()
    if (t && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(t))
      return `Could not read the notice time (tell_at "${t}"). Give it like "07:00".`
    out.tellAt = t ? t.padStart(5, '0') : ''
  }
  if (a.notify !== undefined) {
    if (a.notify !== 'always' && a.notify !== 'when_found')
      return 'notify must be "always" (notify every time) or "when_found" (only when the condition holds).'
    out.notify = a.notify
  }
  if (typeof a.until === 'string' && a.until.trim()) {
    const u = a.until.trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(u) && !untilEnd(u))
      return `Could not read the end date (${u}). Give it like "2026-12-31".`
    out.until = u
  }
  return out
}

/** Names of the other reminders that are on now (any not here were deleted) */
function otherRoutines(list: Routine[], except: string): string {
  const names = list.filter((x) => x.id !== except && x.enabled).map((x) => `"${x.title}"`)
  return names.length
    ? `Other reminders now: ${names.slice(0, 10).join(' · ')}${names.length > 10 ? ` and ${names.length - 10} more` : ''} (even if one came up in the chat, if it is not here the user deleted it, so do not recreate it. Do not leave out a task you were just given by saying another reminder has it; put it all in this one)`
    : 'There are no other reminders now (reminders that came up in the chat were deleted by the user, so do not recreate them).'
}

/** A one-off task done before dawn (0-6 AM) that should tell "in the morning": the phone notice waits until 7 AM */
function morningTell(s: RoutineSchedule | undefined, text: string): boolean {
  if (s?.kind !== 'once') return false
  return new Date(Date.parse(s.at) + 9 * 3600_000).getUTCHours() < 6 && MORNING.test(text)
}

/** Easy to miss: put the next step in the result */
function ruleGaps(r: Routine): string[] {
  const s = r.schedule
  if (!s)
    return r.category
      ? []
      : ['No set time, so it does not run by itself — if it is a reminder, add schedule with goal_update']
  if (s.kind === 'once') {
    // A task done before dawn: ask for a morning time so the phone notice does not ring at that hour
    const h = new Date(Date.parse(s.at) + 9 * 3600_000).getUTCHours()
    return h < 6 && !r.tellAt
      ? [
          'This runs before dawn — if it was "tell me in the morning", add tell_at "07:00" with goal_update (only the phone notice waits). If it is a reminder meant to wake them at that time, leave it as it is',
        ]
      : []
  }
  const gaps: string[] = []
  if (r.notify === 'when_found' && !r.until)
    gaps.push(
      'No end — a watch usually has an end. To set one, add until with goal_update (a date "2026-12-31" or a condition "when you get a cancellation seat")',
    )
  if (r.notify !== 'when_found' && CONDITIONAL.test(`${r.title} ${r.prompt}`))
    gaps.push(
      'This looks like a conditional watch — to notify only when the condition holds, set notify: "when_found" with goal_update (otherwise it notifies every time)',
    )
  return gaps
}

/** For comparing words: remove spaces and lowercase ("Seongsu cafe" = "Seongsucafe") */
const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/** The day saved (Korean time YYYY-MM-DD) */
function savedDay(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'unknown date'
  return new Date(t + 9 * 3600_000).toISOString().slice(0, 10)
}

/**
 * Look through the library (library_find tool). Returns the slots as the user sees them in the app's library.
 * With several words, the best matches first, then the latest. If nothing is found, gives the reason and the list of what is saved
 */
export function findLibrary(
  all: LibraryItem[],
  opts: { query?: string; kind?: LibraryItem['kind']; limit?: number; skip?: number },
): string {
  const n = Math.min(Math.max(1, Math.floor(opts.limit ?? 10) || 10), 20)
  const skip = Math.max(0, Math.floor(opts.skip ?? 0) || 0)
  const q = (opts.query ?? '').replace(/\s+/g, ' ').trim()
  const words = q ? [...new Set(q.split(' ').map(squash).filter(Boolean))] : []
  const recent = [...all].sort((x, y) => y.savedAt.localeCompare(x.savedAt))
  const kindLabel = opts.kind ? LIBRARY_LABEL[opts.kind] : ''
  if (!recent.length)
    return 'The library is empty. Nothing is saved yet. If it was in an earlier conversation, look with conversation_search.'

  const pool = opts.kind ? recent.filter((x) => x.kind === opts.kind) : recent
  const scored = pool
    .map((it) => {
      const hay = squash(
        [
          it.title,
          it.body,
          it.url ?? '',
          it.price ?? '',
          LIBRARY_LABEL[it.kind],
          LIBRARY_LABEL_KR[it.kind],
        ].join(' '),
      )
      return { it, score: words.filter((w) => hay.includes(w)).length }
    })
    .filter((x) => !words.length || x.score > 0)
    // sort is stable, so with equal scores the latest-first order stays
    .sort((x, y) => y.score - x.score)
  const found = scored.slice(skip, skip + n).map((x) => x.it)

  if (!found.length && skip && scored.length)
    return `There are ${scored.length} matches, so skipping ${skip} leaves nothing. That is all. Lower skip or leave it out and search again.`
  if (!found.length) {
    const where = kindLabel ? `Among ${kindLabel} items in the library,` : 'In the library,'
    const what = q ? ` '${q}'` : ''
    const titles = recent
      .slice(0, 5)
      .map((x) => `${x.title} (${LIBRARY_LABEL[x.kind]} · ${savedDay(x.savedAt)})`)
      .join(', ')
    return [
      `${where}${what} nothing is saved. ${recent.length} saved, latest: ${titles}.`,
      'Next: change or shorten the words and search again (for example just the neighborhood name), or clear query and look at the latest, or if it was in the conversation look with conversation_search. Do not make up what is not there.',
    ].join('\n')
  }

  // With few results show the memo longer, with many shorter (the full content comes out long when searched again by title)
  const room = found.length <= 3 ? 2000 : 300
  const lines = found.map((it, i) => {
    const head = `${skip + i + 1}. [${LIBRARY_LABEL[it.kind]}] ${it.title} · saved ${savedDay(it.savedAt)}`
    const body = it.body.trim()
    const memo = body.length > room ? `${body.slice(0, room)}… (cut)` : body
    return [
      head,
      ...(it.price ? [`   Price: ${it.price}`] : []),
      ...(it.url ? [`   Link: ${it.url}`] : []),
      ...(memo ? [`   Memo: ${memo.replace(/\n/g, '\n   ')}`] : []),
    ].join('\n')
  })
  const scope = [q ? `'${q}'` : 'latest', kindLabel ? `${kindLabel} type` : ''].filter(Boolean).join(' · ')
  const more =
    scored.length > found.length
      ? skip
        ? ` (matches ${skip + 1}-${skip + found.length} of ${scored.length})`
        : ` (${found.length} of ${scored.length} matches)`
      : ''
  const rest = scored.length - skip - found.length
  return [
    `Found ${found.length} in the library for ${scope}${more}. ${recent.length} in the library in total.`,
    '',
    ...lines,
    '',
    'Next: to show them to the user, attach with show_list (link and price on each row); for candidates to choose from (products, places), show_cards also works (the library has no photos, so without photos). Use only the values above, and if a memo is cut, search again by title.',
    ...(rest > 0
      ? [`There is more (${rest}): to continue, use the same words with skip: ${skip + found.length}`]
      : []),
  ].join('\n')
}

/**
 * Look through the feed (feed_find tool): what Dool2 did, results of scheduled tasks, news, look-ahead items. The slots as the user sees them in the feed.
 * The latest `limit` first, with the next cursor (before) if there is more. Also the counts per kind in the period ("what did you do this week?")
 */
export function findFeed(
  all: FeedItem[],
  opts: { query?: string; kinds?: FeedItem['kind'][]; days?: number; before?: string; limit?: number },
  now = new Date(),
): string {
  const n = Math.min(Math.max(1, Math.floor(opts.limit ?? 15) || 15), 30)
  const days = opts.days ? Math.min(Math.max(1, Math.floor(opts.days)), FEED_KEEP_DAYS) : undefined
  const since = days ? new Date(now.getTime() - days * 86_400_000).toISOString() : ''
  const q = (opts.query ?? '').replace(/\s+/g, ' ').trim()
  const words = q ? [...new Set(q.split(' ').map(squash).filter(Boolean))] : []
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : undefined
  if (!all.length)
    return 'The feed is empty. Dool2 has not done anything yet. If it was done in a conversation, look with conversation_search.'
  const inRange = all.filter((f) => !since || f.at >= since)
  const pool = inRange.filter(
    (f) =>
      (!kinds || kinds.has(f.kind)) &&
      (!words.length || words.every((w) => squash(`${f.title} ${f.body ?? ''} ${f.from ?? ''}`).includes(w))),
  )
  const page = pageOf(pool, feedAt, { limit: n, ...(opts.before ? { before: opts.before } : {}) })
  const period = days ? `last ${days} days` : `saved ${FEED_KEEP_DAYS} days`
  const scope = [period, q ? `'${q}'` : '', kinds ? [...kinds].map((k) => FEED_LABEL[k]).join('·') : '']
    .filter(Boolean)
    .join(' · ')
  if (!page.items.length) {
    if (opts.before) return `${scope}: that is all. Nothing older.`
    return [
      `Nothing matches in ${scope}. ${all.length} in the feed in total.`,
      'Next: shorten the words, widen the period (days), or drop the kinds and search again. If it was done in a conversation, use conversation_search. Do not make up what is not there.',
    ].join('\n')
  }
  const count = new Map<FeedItem['kind'], number>()
  for (const f of pool) count.set(f.kind, (count.get(f.kind) ?? 0) + 1)
  const byKind = [...count].map(([k, c]) => `${FEED_LABEL[k]} ${c}`).join(' · ')
  const lines = page.items.map((f, i) => {
    const body = f.body ? plainLine(f.body, page.items.length <= 5 ? 600 : 140) : ''
    return [
      `${i + 1}. [${FEED_LABEL[f.kind]}] ${kstWhen(f.at)} · ${f.title}`,
      ...(body ? [`   ${body}`] : []),
      ...(f.from ? [`   From: ${f.from}`] : []),
      ...(f.answered ? [`   User answer: ${f.answered === 'yes' ? 'handed over' : 'skipped'}`] : []),
    ].join('\n')
  })
  return [
    `In the feed, ${scope}: ${pool.length} matches (${byKind}). ${opts.before ? 'Continuing, ' : 'Latest first, '}${page.items.length} shown.`,
    '',
    ...lines,
    '',
    page.next
      ? `There is more: to continue, use the same conditions with before: "${page.next}"`
      : 'That is all (no more).',
    'Next: to show them to the user, attach with show_list if there are many and keep the answer text to a summary. Say only what is above.',
  ].join('\n')
}

/** One-line preview: remove markdown marks and line breaks */
function plainLine(text: string, max: number): string {
  const t = text
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * Looking ahead: the request sent to Dool2 in the feed chat.
 * Only connected services, only new things you confirmed, up to 3 at a time, skip what was already announced, and stay quiet if nothing.
 */
export function watchPrompt(
  services: ConnectionItem[],
  recent: FeedItem[],
  now = new Date(),
  due: KnowItem[] = [],
  lastAt?: string,
): string {
  const kst = new Date(now.getTime() + 9 * 3600_000)
  const when = `${MONTHS[kst.getUTCMonth()]} ${kst.getUTCDate()}, ${WEEKDAYS[kst.getUTCDay()]}, ${hhmmEn(kst.getUTCHours(), 0)}`
  const list = services
    .map((c) => {
      const look = c.card.abilities.filter((a) => a.tier === 'lookup').map((a) => a.title)
      return `- ${c.card.name}(${c.card.id})${look.length ? `: ${look.join(', ')}` : ''}`
    })
    .join('\n')
  const told = recent.length
    ? recent.map((f) => `- ${f.title}${f.key ? ` [${f.key}]` : ''}`).join('\n')
    : '- (none yet)'
  const ago = lastAt ? Math.round((now.getTime() - Date.parse(lastAt)) / 60_000) : undefined
  return [
    `It is time to look ahead (now ${when}, Korean time). The user has not asked for anything. Look ahead first, like an assistant.`,
    ...(ago !== undefined && ago > 0 && ago < 24 * 60
      ? [
          `Last looked: ${ago < 90 ? `${ago} min` : `${Math.round(ago / 60)} h`} ago. Skip places that are unlikely to have changed since, and start with things that change often (deliveries, mail, deadlines close).`,
        ]
      : []),
    ...(due.length
      ? [
          '',
          'Tasks due for a follow-up (things Dool2 did or checked — look at these first):',
          ...due.map(knowLine),
          '→ For each, check its current state in that service (announcement, arrival, deadline, expiry), and if there is something the user would want to know, tell it with feed_tell (put what can be done right away in ask). Then update the state with know_update (state "done" if it is finished) or the next follow-up time (next). If there is nothing more to follow up, clear next.',
        ]
      : []),
    '',
    'Connected services (open only these):',
    list || '- (none)',
    '',
    'To do:',
    '1. In the services above, check for new things the user would want to know now. For example: deliveries and arrival times, upcoming reservations and events, mail that needs a reply, announcements of records or results, payments, expiries and deadlines. Also remembered anniversaries and appointments if they are close.',
    '2. Post only what you confirmed yourself, one by one with feed_tell (most important first, up to 3). title is one line in Dool2 voice, from is where you saw it, key is a key so the same thing is not announced again.',
    '3. If Dool2 can carry on and do something, write the request in ask (for example: choosing a gift, drafting a reply, re-checking a reservation). Do not pay, send or delete now.',
    '4. If there is nothing to announce, post nothing. If a login has expired, do not log in; move on. If a step only a person can do comes up, stop and move on.',
    '5. Newly learned applications, payments, reservations and deliveries go in the ledger with know_save (kind "done", next = when to follow up).',
    '6. Answer in one sentence only (for example: "Announced 2", "No new news"). Write it in the language the user speaks.',
    '',
    'Already announced recently (do not post again):',
    told,
  ].join('\n')
}

/** Date of a known fact: 2026-11-20(Thu) */
export function knowDay(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}(${WEEKDAYS[d.getUTCDay()]})`
}

/** One line for a known fact: what: value (where · basis · day seen) [next] */
export function knowLine(k: KnowItem): string {
  const meta = [k.source, k.basis, `${k.kind === 'done' ? 'done' : 'seen'} ${knowDay(k.seenAt)}`]
    .filter(Boolean)
    .join(' · ')
  const state = k.kind === 'done' ? (k.state === 'done' ? ' [finished]' : ' [in progress]') : ''
  const next = k.next ? ` → ${knowDay(k.next)} ${k.nextWhat ?? 'follow up'}` : ''
  return `- ${k.title}: ${k.value} (${meta})${state}${next}`
}
