// Calculations for the Feed, Ideas, Goals and Library screens (no DOM, tested)

import type { FeedItem, GoalCategory, LibraryItem, Routine, RoutineSchedule } from '@dool2/protocol'
import type { ConnectionItem } from '@dool2/protocol/connect'
import { lang } from './lang.js'
import { goalCategoryHint, goalCategoryText, lifeModel, lifeTime } from './locales/life.js'
import {
  FEED_ROUTINE_TITLE,
  GOAL_CATEGORY_LIST as GOAL_CATEGORIES_KR,
  PHOTO_MARK_RE,
} from './region/kr/life.js'

/** Schedule text (scheduleLabel from @dool2/protocol/schedule). Passed in because the window loads files unbundled */
export type ScheduleLabel = (s: RoutineSchedule) => string

/** GOAL_CATEGORIES from @dool2/protocol (copied because the window is unbundled; a test checks they match) */
export const GOAL_CATEGORY_LIST: readonly GoalCategory[] = GOAL_CATEGORIES_KR

/** Goal category name in the UI language */
export const goalCategoryLabel = (c: GoalCategory): string => goalCategoryText(lang)[c] ?? c

/** Icon tile color (ui.css .tile.blue etc.) */
export type Tone = 'blue' | 'mint' | 'amber' | 'rose' | 'violet' | ''

const clock = (h: number, m: number) => lifeTime(lang).clock(h, m)

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** The date part of a time near now: today, tomorrow, yesterday or a date ("Thu, Nov 20") */
function dateWord(d: Date, now: Date): string {
  const t = lifeTime(lang)
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  if (sameDay(d, now)) return t.today
  if (sameDay(d, day(1))) return t.tomorrow
  if (sameDay(d, day(-1))) return t.yesterday
  return t.date(d)
}

/** Upcoming or past time: "Today 7:30 PM", "Tomorrow 7:30 AM", "Yesterday 2:00 PM", "Thu, Nov 20 3:00 PM" */
export function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${dateWord(d, now)} ${clock(d.getHours(), d.getMinutes())}`
}

/** Date only, or the time when it is today: "2:00 PM", "Yesterday", "Fri, Nov 14" */
export function shortWhen(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return sameDay(d, now) ? timeLabel(iso) : dateWord(d, now)
}

/** Day divider: Today / Yesterday / Fri, Nov 14 */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const t = lifeTime(lang)
  if (sameDay(d, now)) return t.today
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (sameDay(d, y)) return t.yesterday
  return t.date(d)
}

/** Time only: "2:00 PM" */
export function timeLabel(iso: string): string {
  const d = new Date(iso)
  return clock(d.getHours(), d.getMinutes())
}

/** Preview: one line without markdown marks (**, #, list bullets, `, [text](url)) */
export function plain(text: string, max = 160): string {
  const flat = text
    // Photo markers (cut-off ones too) become "(photo)"
    .replace(PHOTO_MARK_RE, ` ${lifeModel(lang).photo}`)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d{1,3}[.)])\s+/gm, '')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The "when" line of a goal (same words as the phone): "Off" · "Ended" · "No time set" ·
 * "Weekdays 7:30 AM · until Dec 31 · notify only on match · next Tomorrow 7:30 AM". rule is ruleLabel from
 * @dool2/protocol/schedule
 */
export function routineWhen(
  r: Routine,
  label: ScheduleLabel,
  now = new Date(),
  rule?: (r: Routine) => string,
): string {
  const t = lifeModel(lang)
  if (!r.enabled) return r.endedAt ? t.ended : t.off
  if (!r.schedule) return t.noTime
  const head = [label(r.schedule), rule?.(r)].filter(Boolean).join(' · ')
  return `${head}${r.nextRunAt ? ` · ${t.next(whenLabel(r.nextRunAt, now))}` : ''}`
}

/** The routine that posts the feed (not shown in the goal list) */
export const isFeedRoutine = (r: Routine) => r.target === 'feed' && r.title === FEED_ROUTINE_TITLE

/** Plan progress: 2/5 */
export function planProgress(r: Routine): { done: number; total: number } | undefined {
  if (!r.plan?.length) return undefined
  return { done: r.plan.filter((p) => p.done).length, total: r.plan.length }
}

/** In-progress order: enabled first → next run soonest → newest */
export function sortRoutines(list: Routine[]): Routine[] {
  return [...list].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    const an = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.POSITIVE_INFINITY
    const bn = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.POSITIVE_INFINITY
    if (an !== bn) return an - bn
    return b.createdAt.localeCompare(a.createdAt)
  })
}

/** Assistant panel "Schedule": enabled routines with a next run, by time */
export function upcoming(list: Routine[]): Routine[] {
  return list
    .filter((r) => r.enabled && r.nextRunAt)
    .sort((a, b) => Date.parse(a.nextRunAt ?? '') - Date.parse(b.nextRunAt ?? ''))
}

// ── Feed ──

/** dom.ts ICON names these screens use */
export type IconKey =
  | 'check'
  | 'clock'
  | 'feed'
  | 'bookmark'
  | 'goal'
  | 'link'
  | 'idea'
  | 'heart'
  | 'mail'
  | 'card'
  | 'pc'
  | 'star'
  | 'list'
  | 'note'
  | 'cart'
  | 'place'
  | 'image'
  | 'calendar'
  | 'sun'
  | 'box'

type KindMeta = { readonly label: string; icon: IconKey; tone: Tone; emo: string }
type ModelKey = keyof ReturnType<typeof lifeModel>

/** Kind with a label looked up in the UI language each time it is read */
const kind = (key: ModelKey, icon: IconKey, tone: Tone, emo: string): KindMeta => ({
  get label() {
    return lifeModel(lang)[key] as string
  },
  icon,
  tone,
  emo,
})

/** Feed kinds (same names, icons and colors as the phone app) */
export const FEED_KIND: Record<FeedItem['kind'], KindMeta> = {
  post: kind('feedPost', 'feed', 'blue', 'news'),
  done: kind('feedDone', 'check', 'mint', 'check'),
  routine: kind('feedRoutine', 'clock', 'violet', 'routine'),
  saved: kind('feedSaved', 'bookmark', 'amber', 'bookmark'),
  goal: kind('feedGoal', 'goal', 'rose', 'other'),
  connected: kind('feedConnected', 'link', 'blue', 'link'),
  suggest: kind('feedSuggest', 'idea', 'amber', 'bulb'),
}

/** Groups the feed by day (newest first) */
export function groupByDay<T extends { at: string }>(
  items: T[],
  now = new Date(),
): { day: string; items: T[] }[] {
  const out: { day: string; items: T[] }[] = []
  for (const it of [...items].sort((a, b) => b.at.localeCompare(a.at))) {
    const day = dayLabel(it.at, now)
    const last = out.at(-1)
    if (last && last.day === day) last.items.push(it)
    else out.push({ day, items: [it] })
  }
  return out
}

/** "Continue in chat": puts a feed post in the chat input (same words as the phone) */
export function continueText(item: Pick<FeedItem, 'title'>): string {
  return lifeModel(lang).continueText(plain(item.title, 40))
}

// ── Goals ──

type GoalMeta = { icon: IconKey; tone: Tone; readonly hint: string; emo: string }

const goalMeta = (c: GoalCategory, icon: IconKey, tone: Tone, emo: string): GoalMeta => ({
  icon,
  tone,
  get hint() {
    return goalCategoryHint(lang)[c]
  },
  emo,
})

const [HEALTH, RELATION, MONEY, WORK, INTEREST, PRODUCTIVITY, OTHER] = GOAL_CATEGORIES_KR

/** The 7 goal categories (same icons, colors and hints as the phone app) */
export const GOAL_META: Record<GoalCategory, GoalMeta> = {
  [HEALTH]: goalMeta(HEALTH, 'heart', 'rose', 'health'),
  [RELATION]: goalMeta(RELATION, 'mail', 'violet', 'relation'),
  [MONEY]: goalMeta(MONEY, 'card', 'mint', 'money'),
  [WORK]: goalMeta(WORK, 'pc', 'blue', 'work'),
  [INTEREST]: goalMeta(INTEREST, 'star', 'amber', 'interest'),
  [PRODUCTIVITY]: goalMeta(PRODUCTIVITY, 'list', 'blue', 'productivity'),
  [OTHER]: goalMeta(OTHER, 'goal', 'mint', 'other'),
}

/** New goal: what goes into the input when a category is tapped */
export function goalStarter(category: GoalCategory): string {
  return lifeModel(lang).goalStarter(goalCategoryLabel(category))
}

// ── Library ──

/** Library kinds (same names, icons and colors as the phone app) */
export const LIBRARY_KIND: Record<LibraryItem['kind'], KindMeta> = {
  note: kind('libNote', 'note', 'blue', 'memo'),
  link: kind('libLink', 'link', 'violet', 'link'),
  product: kind('libProduct', 'cart', 'amber', 'shopping'),
  place: kind('libPlace', 'place', 'rose', 'pin'),
  file: kind('libFile', 'image', 'mint', 'picture'),
}

export type LibraryTab = 'made' | 'files'
export function libraryTab(items: LibraryItem[], tab: LibraryTab): LibraryItem[] {
  return items
    .filter((it) => (tab === 'files' ? it.kind === 'file' : it.kind !== 'file'))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

/** Domain only: "https://www.coupang.com/vp/1" → "coupang.com" */
export function hostOf(url?: string): string {
  if (!url) return ''
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Title when saving one answer to the Library: the first line, without markdown, kept short */
export function titleFrom(text: string): string {
  const first = text.split('\n').find((l) => plain(l))
  return plain(first ?? text, 40) || lifeModel(lang).answerTitle
}
