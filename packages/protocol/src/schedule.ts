// The "when" of goals and automatic jobs: next-run calculation and the text people read (shared by the core, phone and PC). All times are Korean time.
// This file is copied as-is next to the desktop window, so it takes only type imports and keeps its catalogs as plain objects.
import type { Lang } from '@dool2/i18n'
import type { Routine, RoutineSchedule } from './index.js'

const DAY = {
  ko: ['일', '월', '화', '수', '목', '금', '토'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
} as const
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "1st", "2nd", "3rd", "11th" */
const ordinal = (n: number) => {
  const r = n % 100
  if (r >= 11 && r <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

/** Text for the schedule labels, as plain catalogs (Korean is the reference copy) */
const TEXT = {
  ko: {
    time: (h: number, m: number) =>
      `${h < 12 ? '오전' : '오후'} ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`,
    daily: (t: string) => `매일 ${t}`,
    weekdays: '평일',
    weekends: '주말',
    days: (ds: number[]) => ds.map((d) => DAY.ko[d]).join('·'),
    weekly: (label: string, t: string) => `${label} ${t}`,
    monthly: (day: number, t: string) =>
      `매달 ${day >= 31 ? '말일' : day >= 29 ? `${day}일(없는 달은 말일)` : `${day}일`} ${t}`,
    everyHours: (n: number) => `${n}시간마다`,
    everyMinutes: (n: number) => `${n}분마다`,
    once: (month: number, day: number, t: string) => `${month}월 ${day}일 ${t} 한 번`,
    untilDate: (month: number, day: number) => `${month}월 ${day}일까지`,
    untilCondition: (c: string) => `끝: ${c}`,
    whenFound: '맞을 때만 알림',
  },
  en: {
    time: (h: number, m: number) =>
      `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`,
    daily: (t: string) => `Every day ${t}`,
    weekdays: 'Weekdays',
    weekends: 'Weekends',
    days: (ds: number[]) => ds.map((d) => DAY.en[d]).join(', '),
    weekly: (label: string, t: string) => `${label} ${t}`,
    monthly: (day: number, t: string) =>
      `Monthly on ${day >= 31 ? 'the last day' : day >= 29 ? `the ${ordinal(day)} (last day in shorter months)` : `the ${ordinal(day)}`} ${t}`,
    everyHours: (n: number) => (n === 1 ? 'Every hour' : `Every ${n} hours`),
    everyMinutes: (n: number) => `Every ${n} minutes`,
    once: (month: number, day: number, t: string) => `${MONTH_EN[month - 1]} ${day}, ${t}, once`,
    untilDate: (month: number, day: number) => `Until ${MONTH_EN[month - 1]} ${day}`,
    untilCondition: (c: string) => `Ends: ${c}`,
    whenFound: 'Only notifies on a match',
  },
} as const
const KST = 9 * 3600_000

/** Number of days in the month (month 0-11) */
const monthDays = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

/** Next run time in Korean time (undefined = a one-off that has finished) */
export function nextRun(s: RoutineSchedule, after: Date): Date | undefined {
  // Calculated in Korean time (UTC+9, no daylight saving)
  const local = new Date(after.getTime() + KST)
  const at = (d: Date, hh: number, mm: number) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm) - KST)
  if (s.kind === 'once') {
    const t = new Date(s.at)
    return t > after ? t : undefined
  }
  if (s.kind === 'every') {
    // 1 minute is for quick checks only (ADR 0031); life.ts keeps tasks the AI runs at 15 minutes or more
    const t = new Date(after.getTime() + Math.max(1, s.minutes) * 60_000)
    return t
  }
  const [hh, mm] = s.time.split(':').map(Number) as [number, number]
  if (s.kind === 'monthly') {
    // Month by month from this one: a month without that day (Feb 30 etc.) uses its last day
    for (let i = 0; i < 13; i++) {
      const y = local.getUTCFullYear()
      const m = local.getUTCMonth() + i
      const day = Math.min(Math.max(1, s.day), monthDays(y, m))
      const t = new Date(Date.UTC(y, m, day, hh, mm) - KST)
      if (t > after) return t
    }
    return undefined
  }
  for (let i = 0; i < 8; i++) {
    const d = new Date(local.getTime() + i * 86_400_000)
    const t = at(d, hh, mm)
    if (t <= after) continue
    if (s.kind === 'weekly' && !s.days.includes(d.getUTCDay())) continue
    return t
  }
  return undefined
}

/** "매일 오전 7:30", "월·수·금 오후 6:00", "매달 1일 오전 9:00", "매달 말일 …", "11월 20일 오후 3:00 한 번", "3시간마다" (Korean); "Every day 7:30 AM", "Mon, Wed, Fri 6:00 PM", "Every 3 hours" (English) */
export function scheduleLabel(s: RoutineSchedule, lang: Lang = 'ko'): string {
  const t = TEXT[lang]
  const time = (v: string) => {
    const [h, m] = v.split(':').map(Number) as [number, number]
    return t.time(h, m)
  }
  if (s.kind === 'daily') return t.daily(time(s.time))
  if (s.kind === 'weekly') {
    const days = [...s.days].sort()
    const label = days.join() === '1,2,3,4,5' ? t.weekdays : days.join() === '0,6' ? t.weekends : t.days(days)
    return t.weekly(label, time(s.time))
  }
  if (s.kind === 'monthly') {
    return t.monthly(s.day, time(s.time))
  }
  if (s.kind === 'every')
    return s.minutes % 60 === 0 ? t.everyHours(s.minutes / 60) : t.everyMinutes(s.minutes)
  const d = new Date(new Date(s.at).getTime() + 9 * 3600_000)
  return t.once(d.getUTCMonth() + 1, d.getUTCDate(), time(`${d.getUTCHours()}:${d.getUTCMinutes()}`))
}

/** Whether the end is a date ("2026-12-31", "2026-12-31T18:00:00+09:00") */
export const isUntilDate = (until: string) => /^\d{4}-\d{2}-\d{2}/.test(until.trim())

/**
 * The moment the end date finishes (the job is off after it). A date alone lasts until the end of that day (Korean time).
 * undefined if it is a condition or cannot be read
 */
export function untilEnd(until: string | undefined): Date | undefined {
  const u = until?.trim()
  if (!u || !isUntilDate(u)) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(u)) {
    const [y, m, d] = u.split('-').map(Number) as [number, number, number]
    return new Date(Date.UTC(y, m - 1, d + 1) - KST)
  }
  const t = Date.parse(u)
  return Number.isNaN(t) ? undefined : new Date(t)
}

/** One line for the end: "12월 31일까지" · "끝: 엔진오일을 갈았다고 하면" (Korean); "Until Dec 31" · "Ends: when I say I changed the engine oil" (English) */
export function untilLabel(until: string, lang: Lang = 'ko'): string {
  const t = TEXT[lang]
  const end = untilEnd(until)
  if (end) {
    // The date just before the end moment (23:59 that day)
    const d = new Date(end.getTime() - 1 + KST)
    return t.untilDate(d.getUTCMonth() + 1, d.getUTCDate())
  }
  return t.untilCondition(until.trim())
}

/** One line for the end and notifying (empty text if neither): "12월 31일까지 · 맞을 때만 알림" / "Until Dec 31 · Only notifies on a match" */
export function ruleLabel(r: Pick<Routine, 'until' | 'notify'>, lang: Lang = 'ko'): string {
  return [r.until ? untilLabel(r.until, lang) : '', r.notify === 'when_found' ? TEXT[lang].whenFound : '']
    .filter(Boolean)
    .join(' · ')
}
