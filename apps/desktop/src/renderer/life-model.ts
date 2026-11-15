// 피드·아이디어·목표·보관함 화면이 쓰는 계산 (DOM 없음, 테스트한다)

import type { FeedItem, GoalCategory, LibraryItem, Routine, RoutineSchedule } from '@dool2/protocol'
import type { ConnectionItem } from '@dool2/protocol/connect'

/** 일정 문구 (@dool2/protocol/schedule의 scheduleLabel). 화면은 묶지 않고 불러오므로 함수로 받는다 */
export type ScheduleLabel = (s: RoutineSchedule) => string

/** @dool2/protocol의 GOAL_CATEGORIES (화면은 묶지 않고 불러오므로 값을 복사해 둔다. 테스트가 같은지 본다) */
export const GOAL_CATEGORY_LIST: readonly GoalCategory[] = [
  '건강',
  '관계',
  '돈',
  '일',
  '관심사',
  '생산성',
  '기타',
]

/** 아이콘 칸 색 (ui.css .tile.blue 등) */
export type Tone = 'blue' | 'mint' | 'amber' | 'rose' | 'violet' | ''

const DAY = ['일', '월', '화', '수', '목', '금', '토']

const clock = (h: number, m: number) =>
  `${h < 12 ? '오전' : '오후'} ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** 다가오는·지난 시각: "오늘 오후 7:30", "내일 오전 7:30", "어제 오후 2:00", "11월 20일 (목) 오후 3:00" */
export function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const t = clock(d.getHours(), d.getMinutes())
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  if (sameDay(d, now)) return `오늘 ${t}`
  if (sameDay(d, day(1))) return `내일 ${t}`
  if (sameDay(d, day(-1))) return `어제 ${t}`
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAY[d.getDay()]}) ${t}`
}

/** 날짜 나눔: 오늘 / 어제 / 11월 14일 (금) */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (sameDay(d, now)) return '오늘'
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (sameDay(d, y)) return '어제'
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAY[d.getDay()]})`
}

/** 시각만: "오후 2:00" */
export function timeLabel(iso: string): string {
  const d = new Date(iso)
  return clock(d.getHours(), d.getMinutes())
}

/** 미리보기: 마크다운 기호(**, #, 목록 머리, `, [글](주소))를 빼고 한 줄로 */
export function plain(text: string, max = 160): string {
  const flat = text
    // 사진 표시(잘린 것 포함)는 "(사진)"으로
    .replace(/\s*\[사진:[^\]]*\]?/g, ' (사진)')
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

/** 목표의 언제 한 줄 (폰과 같은 말): "꺼 둠" · "정한 때 없음" · "평일 오전 7:30 · 다음 내일 오전 7:30" */
export function routineWhen(r: Routine, label: ScheduleLabel, now = new Date()): string {
  if (!r.enabled) return '꺼 둠'
  if (!r.schedule) return '정한 때 없음'
  return `${label(r.schedule)}${r.nextRunAt ? ` · 다음 ${whenLabel(r.nextRunAt, now)}` : ''}`
}

/** 피드 글을 올리는 데 쓰는 예약 (목표 목록에는 보이지 않는다) */
export const isFeedRoutine = (r: Routine) => r.target === 'feed' && r.title === '피드'

/** 계획 진행: 2/5 */
export function planProgress(r: Routine): { done: number; total: number } | undefined {
  if (!r.plan?.length) return undefined
  return { done: r.plan.filter((p) => p.done).length, total: r.plan.length }
}

/** 진행 중 목록 순서: 켜 둔 것 → 다음 할 때가 가까운 것 → 최근에 만든 것 */
export function sortRoutines(list: Routine[]): Routine[] {
  return [...list].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    const an = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.POSITIVE_INFINITY
    const bn = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.POSITIVE_INFINITY
    if (an !== bn) return an - bn
    return b.createdAt.localeCompare(a.createdAt)
  })
}

/** 두리 판 "예정": 켜 둔 것 중 다음 할 때가 있는 것, 시간순 */
export function upcoming(list: Routine[]): Routine[] {
  return list
    .filter((r) => r.enabled && r.nextRunAt)
    .sort((a, b) => Date.parse(a.nextRunAt ?? '') - Date.parse(b.nextRunAt ?? ''))
}

// ── 피드 ──

/** dom.ts ICON의 이름 중 이 화면들이 쓰는 것 */
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

/** 피드 종류 (폰 앱과 같은 이름·아이콘·색) */
export const FEED_KIND: Record<FeedItem['kind'], { label: string; icon: IconKey; tone: Tone }> = {
  post: { label: '두리 소식', icon: 'feed', tone: 'blue' },
  done: { label: '끝낸 일', icon: 'check', tone: 'mint' },
  routine: { label: '알아서 한 일', icon: 'clock', tone: 'violet' },
  saved: { label: '보관함', icon: 'bookmark', tone: 'amber' },
  goal: { label: '목표', icon: 'goal', tone: 'rose' },
  connected: { label: '연결', icon: 'link', tone: 'blue' },
  suggest: { label: '제안', icon: 'idea', tone: 'amber' },
}

/** 피드를 날짜별로 묶는다 (새 것부터) */
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

/** "이어서 말하기": 피드 글을 대화 입력칸에 (폰과 같은 말) */
export function continueText(item: Pick<FeedItem, 'title'>): string {
  return `"${plain(item.title, 40)}" 이야기인데요, `
}

// ── 목표 ──

/** 목표 분류 7개 (폰 앱과 같은 아이콘·색·힌트) */
export const GOAL_META: Record<GoalCategory, { icon: IconKey; tone: Tone; hint: string }> = {
  건강: { icon: 'heart', tone: 'rose', hint: '운동·잠·식단' },
  관계: { icon: 'mail', tone: 'violet', hint: '가족·친구 챙기기' },
  돈: { icon: 'card', tone: 'mint', hint: '저축·지출 줄이기' },
  일: { icon: 'pc', tone: 'blue', hint: '업무·이직·공부' },
  관심사: { icon: 'star', tone: 'amber', hint: '취미·여행·배우기' },
  생산성: { icon: 'list', tone: 'blue', hint: '습관·정리·루틴' },
  기타: { icon: 'goal', tone: 'mint', hint: '무엇이든' },
}

/** 맡겨 볼 만한 알아서 하는 일 (폰과 같은 예시) */
export const ROUTINE_EXAMPLES: [string, string][] = [
  ['매일 아침 7시 반에 날씨·일정·오는 택배 알려 줘', '아침 브리핑'],
  ['매주 월요일 아침에 지난주 카드 쓴 돈 정리해 줘', '주간 가계부'],
  ['매달 25일에 이번 달 휴대폰 요금 확인해 줘', '요금 확인'],
  ['KTX 금요일 저녁 부산 가는 표, 취소표 나오면 알려 줘', '취소표 지켜보기'],
]

/** 목표 만들기: 분류를 누르면 입력칸에 넣는 말 */
export function goalStarter(category: GoalCategory): string {
  return `${category} 목표를 세우고 싶어요: `
}

// ── 보관함 ──

/** 보관함 종류 (폰 앱과 같은 이름·아이콘·색) */
export const LIBRARY_KIND: Record<LibraryItem['kind'], { label: string; icon: IconKey; tone: Tone }> = {
  note: { label: '정리', icon: 'note', tone: 'blue' },
  link: { label: '링크', icon: 'link', tone: 'violet' },
  product: { label: '상품', icon: 'cart', tone: 'amber' },
  place: { label: '장소', icon: 'place', tone: 'rose' },
  file: { label: '파일', icon: 'image', tone: 'mint' },
}

export type LibraryTab = 'made' | 'files'
export function libraryTab(items: LibraryItem[], tab: LibraryTab): LibraryItem[] {
  return items
    .filter((it) => (tab === 'files' ? it.kind === 'file' : it.kind !== 'file'))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

/** 주소에서 도메인만: "https://www.coupang.com/vp/1" → "coupang.com" */
export function hostOf(url?: string): string {
  if (!url) return ''
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** 답 하나를 보관함에 남길 때 제목: 첫 줄(마크다운 뺀 것)을 짧게 */
export function titleFrom(text: string): string {
  const first = text.split('\n').find((l) => plain(l))
  return plain(first ?? text, 40) || '두리의 답'
}
