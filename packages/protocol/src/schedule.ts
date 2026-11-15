// 목표·알아서 하는 일의 "언제": 다음 시각 계산과 사람이 읽는 말 (본체·폰·PC가 같이 쓴다). 모두 한국 시간.
import type { RoutineSchedule } from './index.js'

const DAY = ['일', '월', '화', '수', '목', '금', '토']

/** 한국 시간 기준 다음 실행 시각 (없으면 undefined = 끝난 일회성) */
export function nextRun(s: RoutineSchedule, after: Date): Date | undefined {
  // 한국 시간(UTC+9)으로 계산한다 (서머타임 없음)
  const KST = 9 * 3600_000
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
  for (let i = 0; i < 8; i++) {
    const d = new Date(local.getTime() + i * 86_400_000)
    const t = at(d, hh, mm)
    if (t <= after) continue
    if (s.kind === 'weekly' && !s.days.includes(d.getUTCDay())) continue
    return t
  }
  return undefined
}

/** "매일 오전 7:30", "월·수·금 오후 6:00", "11월 20일 오후 3:00 한 번", "3시간마다" */
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
  if (s.kind === 'every') return s.minutes % 60 === 0 ? `${s.minutes / 60}시간마다` : `${s.minutes}분마다`
  const d = new Date(new Date(s.at).getTime() + 9 * 3600_000)
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${time(`${d.getUTCHours()}:${d.getUTCMinutes()}`)} 한 번`
}
