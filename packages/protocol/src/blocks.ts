// Result blocks attached under an answer (docs/design/system/components/ChatBlocks).
// The AI passes only fixed kinds and fields, and the screen decides the look. This file handles only the data shapes, cleaning and the text fallback
// (drawing is in blocks-view.ts, shared by the phone and PC)
// Copied as-is next to the desktop window, so it takes only type imports and keeps its catalog as a plain object.
import type { Lang } from '@dool2/i18n'

/** Block button: pressing it sends ask (text) as my own words, or opens url (https) */
export interface BlockAction {
  label: string
  ask?: string
  url?: string
}

/** What leads a list row: small photo, date, file, logo, check (multi-select) or none */
export type RowLead = 'img' | 'date' | 'file' | 'logo' | 'check' | 'none'

/** One list row */
export interface BlockRow {
  title: string
  /** Small line below (21 min ago · local pickup Mapo) */
  sub?: string
  /** Bold value on the right (30,000 won) */
  value?: string
  /** Small text under the value (7,980 won × 2) */
  valueNote?: string
  /** Status word on the right (received · shipping · around 1/15) */
  state?: string
  /** Status color: done (mint text) · wait for waiting or a deadline (yellow) · stop (red) */
  tone?: 'done' | 'wait' | 'stop'
  /** Leading photo (https). The screen fetches it through the PC core */
  image?: string
  /** Leading date (YYYY-MM-DD) */
  date?: string
  /** Leading file kind (PDF · HWP · XLSX) */
  file?: string
  /** Address to open when the row is pressed (https). Only when there is no pick */
  url?: string
  /** What Dool2 pre-selected in multi-select */
  on?: boolean
  /** Amount (won) to add to the total. Shows as "N picked · total" on the multi-select button */
  amount?: number
}

/** A list-row block kept in the conversation history (show_list) */
export interface RowsRecordMessage {
  kind: 'rows'
  /** Header line (Maple Elementary · 2026 school year) */
  title?: string
  /** Small text at the right of the header line (source, count) */
  from?: string
  lead: RowLead
  /** one: pressing a row picks it · multi: tick several · none: pressing opens url */
  pick?: 'one' | 'multi'
  rows: BlockRow[]
  /** One button below (for multi, "N {label}") */
  action?: BlockAction
}

/** A single result kept in the conversation history (show_result) */
export interface ResultRecordMessage {
  kind: 'result'
  /** Header line (Booking confirmed · Coupang · Folding stroller) */
  title?: string
  from?: string
  /** Shows a check in the header when the job is done */
  done?: boolean
  /** One big value (11/21(Sat) 19:00 · 1,284,300 won) */
  big: string
  /** Small text next to the big value (4 people · private room) */
  bigNote?: string
  /** Info rows (name, value). With code, a monospace font (numbers) */
  facts?: { label: string; value: string; code?: boolean }[]
  /** Progress steps (ordered · shipped · on the way · arrived); now is the current step number (from 0) */
  steps?: { names: string[]; now: number }
  /** Deadline (YYYY-MM-DD). The screen shows D-n in yellow */
  due?: string
  /** Deadline tag text (payment · due) */
  dueLabel?: string
  actions?: BlockAction[]
}

export type DraftVia = 'sms' | 'kakao' | 'mail' | 'post' | 'other'

/** A draft kept in the conversation history (show_draft). [Send] asks Dool2 -> approval just before sending */
export interface DraftRecordMessage {
  kind: 'draft'
  /** Recipient (landlord Kim) */
  to?: string
  via: DraftVia
  /** Email subject */
  subject?: string
  text: string
}

/** Quick replies under a Dool2 question (the engine cuts the [[답: a | b]] line off the end of the answer and keeps it) */
export interface QuickRecordMessage {
  kind: 'quick'
  replies: string[]
}

/** One leg of a route card: what (line) from where to where */
export type RouteMode = 'subway' | 'bus' | 'train' | 'walk' | 'etc'
export interface RouteLeg {
  mode: RouteMode
  /** Line name (Line 2 · Express M7731 · Shinbundang Line · walk) */
  line: string
  /** Where to board -> where to get off */
  from: string
  to: string
  /** Minutes this leg takes (bar length) */
  minutes?: number
  /** Last departure where you board (23:29) */
  last?: string
  /** Short note (toward Daehwa · Exit 3) */
  note?: string
}

/** A route card kept in the conversation history (show_route) */
export interface RouteRecordMessage {
  kind: 'route'
  /** Header line (Gangnam Station -> Daehwa Station) */
  title?: string
  from?: string
  /** Big value: one conclusion (leave Gangnam Station by 23:25 · 1 hr 16 min) */
  big: string
  /** Small text next to the big value (1 transfer · 2,150 won) */
  bigNote?: string
  legs: RouteLeg[]
  /** Info rows (if you miss it · other route · live), up to 4 */
  facts?: { label: string; value: string }[]
  actions?: BlockAction[]
}

export type BlockRecordMessage =
  | RowsRecordMessage
  | ResultRecordMessage
  | DraftRecordMessage
  | RouteRecordMessage

const BLOCK_TEXT_EN_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** Copy used by the block text fallback and by the block view (Korean is the reference copy) */
export const BLOCK_TEXT = {
  ko: {
    weekdays: ['일', '월', '화', '수', '목', '금', '토'],
    months: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
    shortDate: (month: number, day: number, weekday: string) => `${month}/${day}(${weekday})`,
    recipient: '받는 사람',
    minutes: (n: number) => `${n}분`,
    last: '막차',
    now: '지금',
    postAsIs: '방금 쓴 글 그대로 올려 줘',
    sendAsIs: (to: string | undefined, via: DraftRecordMessage['via']) =>
      `방금 쓴 글 그대로 ${to ? `${to}에게 ` : ''}${{ sms: '문자로 ', kakao: '카카오톡으로 ', mail: '메일로 ', post: '', other: '' }[via]}보내 줘`,
    nothingPicked: '고른 게 없어요',
    picked: (n: number, label: string, sum: string) => `${n}개 ${label}${sum}`,
    sum: (won: number) => ` · ${won.toLocaleString('ko-KR')}원`,
    skipped: ' (뺀 것: ',
    defaultPick: { label: '고르기', ask: '이것만 할게' },
    pickThis: (title: string, value: string | undefined) =>
      `이걸로 할게: ${title}${value ? ` (${value})` : ''}`,
    pickedCount: (on: number, all: number) => `${on}/${all}개 고름`,
    showMore: (n: number) => `${n}개 더 보기`,
    sent: '골라서 보냈어요',
    past: (date: string) => `${date} 지남`,
    file: '파일',
    to: '받는 사람 ',
    copy: '복사',
    copied: '복사했어요',
    copyFailed: '복사 못 했어요',
    via: {
      sms: { name: '문자', send: '문자 보내기' },
      kakao: { name: '카카오톡', send: '카톡 보내기' },
      mail: { name: '메일', send: '메일 보내기' },
      post: { name: '글', send: '올리기' },
      other: { name: '', send: '보내기' },
    },
  },
  en: {
    weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    months: BLOCK_TEXT_EN_MONTHS,
    shortDate: (month: number, day: number, weekday: string) =>
      `${weekday}, ${BLOCK_TEXT_EN_MONTHS[month - 1]} ${day}`,
    recipient: 'To',
    minutes: (n: number) => `${n} min`,
    last: 'Last one',
    now: 'Now',
    postAsIs: 'Post the text I just wrote as it is',
    sendAsIs: (to: string | undefined, via: DraftRecordMessage['via']) =>
      `Send the text I just wrote as it is${to ? ` to ${to}` : ''}${{ sms: ' by text', kakao: ' on KakaoTalk', mail: ' by email', post: '', other: '' }[via]}`,
    nothingPicked: 'Nothing selected',
    picked: (n: number, label: string, sum: string) => `${label} ${n}${sum}`,
    sum: (won: number) => ` · ₩${won.toLocaleString('en-US')}`,
    skipped: ' (Left out: ',
    defaultPick: { label: 'Pick', ask: 'Just these' },
    pickThis: (title: string, value: string | undefined) =>
      `I'll go with this: ${title}${value ? ` (${value})` : ''}`,
    pickedCount: (on: number, all: number) => `${on}/${all} selected`,
    showMore: (n: number) => `Show ${n} more`,
    sent: 'Picks sent',
    past: (date: string) => `Passed ${date}`,
    file: 'File',
    to: 'To ',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: "Couldn't copy",
    via: {
      sms: { name: 'Text', send: 'Send text' },
      kakao: { name: 'KakaoTalk', send: 'Send on KakaoTalk' },
      mail: { name: 'Email', send: 'Send email' },
      post: { name: 'Post', send: 'Post it' },
      other: { name: '', send: 'Send' },
    },
  },
} as const

// ── Cleaning: turns what the AI passed into a shape we can trust ─────────────

const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined)

function https(v: unknown): string | undefined {
  const u = str(v, 800)
  if (!u) return undefined
  try {
    const x = new URL(u)
    if (x.protocol === 'http:') x.protocol = 'https:'
    return x.protocol === 'https:' ? x.toString() : undefined
  } catch {
    return undefined
  }
}

function day(v: unknown): string | undefined {
  const s = str(v, 30)
  const m = s?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (!m) return undefined
  const d = `${m[1]}-${m[2]?.padStart(2, '0')}-${m[3]?.padStart(2, '0')}`
  return Number.isNaN(Date.parse(`${d}T00:00:00Z`)) ? undefined : d
}

/**
 * Money, contact and deletion are never done straight from a block button (a text asking Dool2 is fine: it goes through an approval card afterwards).
 * Even so, a button name like "결제하기" ("Pay") looks as if it happens right away and people would be misled, so such names are dropped
 */
const RISKY_LABEL =
  /결제|송금|이체|구매하기|주문하기|삭제|탈퇴|해지|\b(?:pay(?:ment)?|checkout|transfer|send money|buy|purchase|order now|place order|delete|unsubscribe)\b/i

function action(v: unknown): BlockAction | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  const label = str(r.label, 16)
  if (!label || RISKY_LABEL.test(label)) return undefined
  const ask = str(r.ask, 300)
  const url = https(r.url)
  if (!ask && !url) return { label, ask: label }
  return { label, ...(ask ? { ask } : {}), ...(url && !ask ? { url } : {}) }
}

const LEADS: RowLead[] = ['img', 'date', 'file', 'logo', 'check', 'none']

/** List rows: up to 30 rows (the screen shows 5 and expands the rest), text length is cut, https only */
export function cleanRows(input: unknown, lang: Lang = 'ko'): RowsRecordMessage | undefined {
  if (!input || typeof input !== 'object') return undefined
  const r = input as Record<string, unknown>
  const pick = r.pick === 'multi' || r.pick === 'one' ? r.pick : undefined
  let lead: RowLead = LEADS.includes(r.lead as RowLead) ? (r.lead as RowLead) : 'none'
  if (pick === 'multi') lead = 'check'
  const rows: BlockRow[] = []
  for (const raw of Array.isArray(r.rows) ? r.rows.slice(0, 30) : []) {
    if (!raw || typeof raw !== 'object') continue
    const x = raw as Record<string, unknown>
    const title = str(x.title, 60)
    if (!title) continue
    const row: BlockRow = { title }
    const sub = str(x.sub, 60)
    const value = str(x.value, 20)
    const valueNote = str(x.valueNote ?? x.value_note, 24)
    const state = str(x.state, 12)
    const image = https(x.image)
    const date = day(x.date)
    const file = str(x.file, 5)?.toUpperCase()
    const url = https(x.url)
    const amount =
      typeof x.amount === 'number' && Number.isFinite(x.amount) ? Math.round(x.amount) : undefined
    if (sub) row.sub = sub
    if (value) row.value = value
    if (valueNote) row.valueNote = valueNote
    if (state) row.state = state
    if (x.tone === 'done' || x.tone === 'wait' || x.tone === 'stop') row.tone = x.tone
    if (image) row.image = image
    if (date) row.date = date
    if (file) row.file = file
    if (url) row.url = url
    if (pick === 'multi' && x.on !== false) row.on = true
    if (amount !== undefined && amount >= 0) row.amount = amount
    rows.push(row)
  }
  if (!rows.length) return undefined
  // A date lead with no dates at all becomes no lead
  if (lead === 'date' && !rows.some((x) => x.date)) lead = 'none'
  const out: RowsRecordMessage = { kind: 'rows', lead, rows }
  const title = str(r.title, 40)
  const from = str(r.from, 24)
  const act = action(r.action)
  if (title) out.title = title
  if (from) out.from = from
  if (pick) out.pick = pick
  if (pick === 'multi') out.action = act ?? BLOCK_TEXT[lang].defaultPick
  else if (act) out.action = act
  return out
}

/** A single result: 6 info rows, 2-6 steps, up to 2 buttons */
export function cleanResult(input: unknown): ResultRecordMessage | undefined {
  if (!input || typeof input !== 'object') return undefined
  const r = input as Record<string, unknown>
  const big = str(r.big, 40)
  if (!big) return undefined
  const out: ResultRecordMessage = { kind: 'result', big }
  const title = str(r.title, 40)
  const from = str(r.from, 24)
  const bigNote = str(r.bigNote ?? r.big_note, 24)
  if (title) out.title = title
  if (from) out.from = from
  if (r.done === true) out.done = true
  if (bigNote) out.bigNote = bigNote
  const facts: NonNullable<ResultRecordMessage['facts']> = []
  for (const raw of Array.isArray(r.facts) ? r.facts.slice(0, 6) : []) {
    // Both [name, value, "code"] rows and {label, value, code} are accepted
    const [label, value, code] = Array.isArray(raw)
      ? [raw[0], raw[1], raw[2] === 'code' || raw[2] === true]
      : raw && typeof raw === 'object'
        ? [
            (raw as Record<string, unknown>).label,
            (raw as Record<string, unknown>).value,
            (raw as Record<string, unknown>).code === true,
          ]
        : [undefined, undefined, false]
    const l = str(label, 14)
    const v = str(value, 40)
    if (l && v) facts.push({ label: l, value: v, ...(code ? { code: true } : {}) })
  }
  if (facts.length) out.facts = facts
  const s = r.steps as Record<string, unknown> | undefined
  if (s && typeof s === 'object' && Array.isArray(s.names)) {
    const names = s.names
      .map((n) => str(n, 10))
      .filter((n): n is string => !!n)
      .slice(0, 6)
    const now = typeof s.now === 'number' ? Math.round(s.now) : -1
    if (names.length >= 2 && now >= 0 && now < names.length) out.steps = { names, now }
  }
  const due = day(r.due)
  if (due) {
    out.due = due
    const dueLabel = str(r.dueLabel ?? r.due_label, 8)
    if (dueLabel) out.dueLabel = dueLabel
  }
  const actions = (Array.isArray(r.actions) ? r.actions : [])
    .map(action)
    .filter((a): a is BlockAction => !!a)
    .slice(0, 2)
  if (actions.length) out.actions = actions
  return out
}

const MODES: RouteMode[] = ['subway', 'bus', 'train', 'walk', 'etc']

/** Guess the vehicle from the line name (when the AI left out mode) */
function guessMode(line: string): RouteMode {
  if (/도보|걷기/.test(line)) return 'walk'
  if (/호선|선$|경의|공항철도|GTX|경춘|수인|신분당|우이|김포골드|서해|에버라인|의정부/.test(line))
    return 'subway'
  if (/KTX|SRT|ITX|무궁화|새마을|기차|열차/.test(line)) return 'train'
  if (/버스|광역|간선|지선|마을|직행|좌석|심야|공항버스|^[MN]?\d|^[가-힣]+\d/.test(line)) return 'bus'
  return 'etc'
}

/** Route card: 2-8 legs, 4 info rows, up to 2 buttons */
export function cleanRoute(input: unknown): RouteRecordMessage | undefined {
  if (!input || typeof input !== 'object') return undefined
  const r = input as Record<string, unknown>
  const big = str(r.big, 40)
  if (!big) return undefined
  const legs: RouteLeg[] = []
  for (const raw of Array.isArray(r.legs) ? r.legs.slice(0, 8) : []) {
    if (!raw || typeof raw !== 'object') continue
    const g = raw as Record<string, unknown>
    const line = str(g.line, 24)
    const from = str(g.from, 30)
    const to = str(g.to, 30)
    if (!line || !from || !to) continue
    const mode = MODES.includes(g.mode as RouteMode) ? (g.mode as RouteMode) : guessMode(line)
    const leg: RouteLeg = { mode, line, from, to }
    const min = typeof g.minutes === 'number' ? Math.round(g.minutes) : Number.NaN
    if (min > 0 && min < 600) leg.minutes = min
    const last = str(g.last, 8)?.match(/^(\d{1,2}):(\d{2})/)
    if (last) leg.last = `${last[1]?.padStart(2, '0')}:${last[2]}`
    const note = str(g.note, 30)
    if (note) leg.note = note
    legs.push(leg)
  }
  if (!legs.length) return undefined
  const out: RouteRecordMessage = { kind: 'route', big, legs }
  const title = str(r.title, 40)
  const from = str(r.from, 24)
  const bigNote = str(r.bigNote ?? r.big_note, 30)
  if (title) out.title = title
  if (from) out.from = from
  if (bigNote) out.bigNote = bigNote
  const facts: NonNullable<RouteRecordMessage['facts']> = []
  for (const raw of Array.isArray(r.facts) ? r.facts.slice(0, 4) : []) {
    const f = raw as Record<string, unknown> | undefined
    const l = str(f?.label, 14)
    const v = str(f?.value, 60)
    if (l && v) facts.push({ label: l, value: v })
  }
  if (facts.length) out.facts = facts
  const actions = (Array.isArray(r.actions) ? r.actions : [])
    .map(action)
    .filter((a): a is BlockAction => !!a)
    .slice(0, 2)
  if (actions.length) out.actions = actions
  return out
}

/** Line colors (official Seoul metro area colors, bus colors by type). Unknown ones get the vehicle's default color */
export function lineColor(leg: Pick<RouteLeg, 'mode' | 'line'>): string {
  const l = leg.line.replace(/\s+/g, '')
  const metro: [RegExp, string][] = [
    [/^1호선/, '#0052A4'],
    [/^2호선/, '#00A84D'],
    [/^3호선/, '#EF7C1C'],
    [/^4호선/, '#00A5DE'],
    [/^5호선/, '#996CAC'],
    [/^6호선/, '#CD7C2F'],
    [/^7호선/, '#747F00'],
    [/^8호선/, '#E6186C'],
    [/^9호선/, '#BDB092'],
    [/신분당/, '#D4003B'],
    [/수인|분당/, '#F5A200'],
    [/경의|중앙/, '#77C4A3'],
    [/공항철도/, '#0090D2'],
    [/경춘/, '#0C8E72'],
    [/GTX/, '#9A6292'],
    [/우이/, '#B0CE18'],
    [/서해/, '#81A914'],
    [/김포/, '#AD8605'],
    [/에버라인|용인/, '#509F22'],
    [/의정부/, '#FDA600'],
    [/신림/, '#6789CA'],
  ]
  if (leg.mode === 'subway') for (const [re, c] of metro) if (re.test(l)) return c
  if (leg.mode === 'bus') {
    if (/광역|^M|직행|좌석|빨간/.test(l)) return '#E60012'
    if (/간선/.test(l)) return '#3D5BAB'
    if (/지선|마을/.test(l)) return '#5BB025'
    if (/심야|^N/.test(l)) return '#2B2D72'
    if (/순환/.test(l)) return '#F2B70A'
    return '#3D5BAB'
  }
  if (leg.mode === 'train') return '#1E3A8A'
  if (leg.mode === 'walk') return '#9AA0A6'
  return '#6B7280'
}

const VIAS: DraftVia[] = ['sms', 'kakao', 'mail', 'post', 'other']

/** Draft: up to 2000 characters */
export function cleanDraft(input: unknown): DraftRecordMessage | undefined {
  if (!input || typeof input !== 'object') return undefined
  const r = input as Record<string, unknown>
  const text = typeof r.text === 'string' ? r.text.trim().slice(0, 2000) : ''
  if (!text) return undefined
  const via = VIAS.includes(r.via as DraftVia) ? (r.via as DraftVia) : 'other'
  const out: DraftRecordMessage = { kind: 'draft', via, text }
  const to = str(r.to, 30)
  const subject = str(r.subject, 80)
  if (to) out.to = to
  if (subject && via === 'mail') out.subject = subject
  return out
}

// Cutting the quick-reply line is in rich.ts (the answer drawing must always hide it, so it lives in that dependency-free file)
export { hideQuickTail, splitQuick } from './rich.js'

// ── Text fallback: where blocks cannot be drawn (notifications, older apps, handing back to the AI) ──

/** Turn a block into a few lines of text */
export function blockText(rec: BlockRecordMessage | QuickRecordMessage, lang: Lang = 'ko'): string {
  const t = BLOCK_TEXT[lang]
  if (rec.kind === 'quick') return rec.replies.map((r) => `· ${r}`).join('\n')
  if (rec.kind === 'draft') return `${rec.to ? `${t.recipient}: ${rec.to}\n` : ''}${rec.text}`
  if (rec.kind === 'route') {
    const lines = [`${rec.title ? `${rec.title}: ` : ''}${rec.big}${rec.bigNote ? ` (${rec.bigNote})` : ''}`]
    for (const g of rec.legs)
      lines.push(
        `- ${g.line} ${g.from} → ${g.to}${g.minutes ? ` · ${t.minutes(g.minutes)}` : ''}${g.last ? ` · ${t.last} ${g.last}` : ''}`,
      )
    for (const f of rec.facts ?? []) lines.push(`${f.label}: ${f.value}`)
    return lines.join('\n')
  }
  if (rec.kind === 'result') {
    const lines = [`${rec.title ? `${rec.title}: ` : ''}${rec.big}${rec.bigNote ? ` (${rec.bigNote})` : ''}`]
    if (rec.steps) lines.push(`${t.now}: ${rec.steps.names[rec.steps.now]}`)
    for (const f of rec.facts ?? []) lines.push(`${f.label}: ${f.value}`)
    return lines.join('\n')
  }
  const lines = rec.title ? [rec.title] : []
  for (const r of rec.rows) {
    const parts = [
      r.date ? `${shortDate(r.date, lang)} ` : '',
      r.title,
      r.sub ? ` · ${r.sub}` : '',
      r.value ? ` · ${r.value}` : '',
      r.state ? ` · ${r.state}` : '',
    ]
    lines.push(`- ${parts.join('')}`)
  }
  return lines.join('\n')
}

/** 2027-01-07 -> 1/7(Thu) in Korean, "Thu, Jan 7" in English */
export function shortDate(d: string, lang: Lang = 'ko'): string {
  const t = new Date(`${d}T00:00:00Z`)
  const c = BLOCK_TEXT[lang]
  return c.shortDate(t.getUTCMonth() + 1, t.getUTCDate(), c.weekdays[t.getUTCDay()] as string)
}

/** Days from today (Korean time) to that day: 0 is today, negative is past */
export function daysUntil(d: string, now = Date.now()): number {
  const today = new Date(now + 9 * 3600_000).toISOString().slice(0, 10)
  return Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
}

/** What goes to Dool2 when [Send] on a draft is pressed (Dool2 gets approval just before sending) */
export function draftAsk(rec: DraftRecordMessage, lang: Lang = 'ko'): string {
  const t = BLOCK_TEXT[lang]
  return rec.via === 'post' ? t.postAsIs : t.sendAsIs(rec.to, rec.via)
}

/** Multi-select button text: "Add 3 · 25,860 won" (total only when every row has an amount) */
export function multiLabel(rows: BlockRow[], on: boolean[], label: string, lang: Lang = 'ko'): string {
  const t = BLOCK_TEXT[lang]
  const picked = rows.filter((_, i) => on[i])
  if (!picked.length) return t.nothingPicked
  const sum = picked.every((r) => typeof r.amount === 'number')
    ? t.sum(picked.reduce((a, r) => a + (r.amount ?? 0), 0))
    : ''
  return t.picked(picked.length, label, sum)
}

/** What to send for multi-select: "고른 것만 담아 줘: 떡국떡 1kg, 한우 양지" */
export function multiAsk(rows: BlockRow[], on: boolean[], a: BlockAction, lang: Lang = 'ko'): string {
  const names = rows.filter((_, i) => on[i]).map((r) => r.title)
  const skipped = rows.filter((_, i) => !on[i]).map((r) => r.title)
  return `${a.ask ?? a.label}: ${names.join(', ')}${skipped.length ? `${BLOCK_TEXT[lang].skipped}${skipped.join(', ')})` : ''}`
}
