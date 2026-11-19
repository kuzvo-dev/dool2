// 목표·알아서 하는 일의 "언제": 다음 시각 계산과 사람이 읽는 말 (본체·폰·PC가 같이 쓴다). 모두 한국 시간.
import type { Routine, RoutineSchedule } from './index.js'

const DAY = ['일', '월', '화', '수', '목', '금', '토']
const KST = 9 * 3600_000

/** 그 달의 날 수 (month 0~11) */
const monthDays = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

/** 한국 시간 기준 다음 실행 시각 (없으면 undefined = 끝난 일회성) */
export function nextRun(s: RoutineSchedule, after: Date): Date | undefined {
  // 한국 시간(UTC+9)으로 계산한다 (서머타임 없음)
  const local = new Date(after.getTime() + KST)
  const at = (d: Date, hh: number, mm: number) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm) - KST)
  if (s.kind === 'once') {
    const t = new Date(s.at)
    return t > after ? t : undefined
  }
  if (s.kind === 'every') {
    const t = new Date(after.getTime() + Math.max(15, s.minutes) * 60_000)
    return t
  }
  const [hh, mm] = s.time.split(':').map(Number) as [number, number]
  if (s.kind === 'monthly') {
    // 이번 달부터 차례로: day일이 없는 달(2월 30일 등)은 그 달 마지막 날
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

/** "매일 오전 7:30", "월·수·금 오후 6:00", "매달 1일 오전 9:00", "매달 말일 …", "11월 20일 오후 3:00 한 번", "3시간마다" */
export function scheduleLabel(s: RoutineSchedule): string {
  const time = (t: string) => {
    const [h, m] = t.split(':').map(Number) as [number, number]
    return `${h < 12 ? '오전' : '오후'} ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`
  }
  if (s.kind === 'daily') return `매일 ${time(s.time)}`
  if (s.kind === 'weekly') {
    const days = [...s.days].sort()
    const label =
      days.join() === '1,2,3,4,5'
        ? '평일'
        : days.join() === '0,6'
          ? '주말'
          : days.map((d) => DAY[d]).join('·')
    return `${label} ${time(s.time)}`
  }
  if (s.kind === 'monthly') {
    const day = s.day >= 31 ? '말일' : s.day >= 29 ? `${s.day}일(없는 달은 말일)` : `${s.day}일`
    return `매달 ${day} ${time(s.time)}`
  }
  if (s.kind === 'every') return s.minutes % 60 === 0 ? `${s.minutes / 60}시간마다` : `${s.minutes}분마다`
  const d = new Date(new Date(s.at).getTime() + 9 * 3600_000)
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${time(`${d.getUTCHours()}:${d.getUTCMinutes()}`)} 한 번`
}

/** 끝나는 때가 날짜인지 ("2026-12-31", "2026-12-31T18:00:00+09:00") */
export const isUntilDate = (until: string) => /^\d{4}-\d{2}-\d{2}/.test(until.trim())

/**
 * 끝나는 날짜의 끝 시각 (이 시각이 지나면 꺼진다). 날짜만 주면 그날 하루(한국 시간)가 끝날 때까지.
 * 조건이거나 읽을 수 없으면 undefined
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

/** 끝나는 때 한 줄: "12월 31일까지" · "끝: 엔진오일을 갈았다고 하면" */
export function untilLabel(until: string): string {
  const end = untilEnd(until)
  if (end) {
    // 끝 시각 바로 앞(그날 23:59)의 날짜
    const d = new Date(end.getTime() - 1 + KST)
    return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일까지`
  }
  return `끝: ${until.trim()}`
}

/** 끝나는 때·알리기 한 줄 (없으면 빈 글): "12월 31일까지 · 맞을 때만 알림" */
export function ruleLabel(r: Pick<Routine, 'until' | 'notify'>): string {
  return [r.until ? untilLabel(r.until) : '', r.notify === 'when_found' ? '맞을 때만 알림' : '']
    .filter(Boolean)
    .join(' · ')
}
