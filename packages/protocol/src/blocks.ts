// 답 아래에 붙는 결과 블록 (docs/design/system/components/ChatBlocks).
// AI는 정해진 종류와 칸만 넘기고, 모양은 화면이 정한다. 여기서는 데이터 모양·다듬기·글 대체본만 다룬다
// (화면 그리기는 blocks-view.ts, 폰과 PC가 같이 쓴다)

/** 블록 버튼: 누르면 ask(글)를 내 말로 보내거나 url(https)을 연다 */
export interface BlockAction {
  label: string
  ask?: string
  url?: string
}

/** 목록 줄 앞머리: 작은 사진 · 날짜 · 파일 · 로고 · 체크(여러 개 고르기) · 없음 */
export type RowLead = 'img' | 'date' | 'file' | 'logo' | 'check' | 'none'

/** 목록 한 줄 */
export interface BlockRow {
  title: string
  /** 아래 작은 줄 (21분 전 · 직거래 마포) */
  sub?: string
  /** 오른쪽 굵은 값 (3만 원) */
  value?: string
  /** 값 아래 작은 글 (7,980원 × 2) */
  valueNote?: string
  /** 오른쪽 상태 글자 (받음 · 배송 중 · 1/15쯤) */
  state?: string
  /** 상태 색: done 끝남(민트 글자) · wait 기다림·마감(노랑) · stop 멈춤(빨강) */
  tone?: 'done' | 'wait' | 'stop'
  /** 앞머리 사진 (https). 화면은 PC 본체에 받아 온다 */
  image?: string
  /** 앞머리 날짜 (YYYY-MM-DD) */
  date?: string
  /** 앞머리 파일 종류 (PDF · HWP · XLSX) */
  file?: string
  /** 줄을 눌렀을 때 열 주소 (https). pick이 없을 때만 */
  url?: string
  /** 여러 개 고르기에서 두리가 미리 고른 것 */
  on?: boolean
  /** 합계에 더할 금액(원). 여러 개 고르기 버튼에 "N개 담기 · 합계"로 */
  amount?: number
}

/** 대화 기록에 남기는 목록 줄 블록 (show_list) */
export interface RowsRecordMessage {
  kind: 'rows'
  /** 머리 줄 (공덕초 · 2026학년도) */
  title?: string
  /** 머리 줄 오른쪽 작은 글 (출처·건수) */
  from?: string
  lead: RowLead
  /** one: 줄을 누르면 그걸로 고른다 · multi: 체크해 여러 개 고른다 · 없으면 누르면 url */
  pick?: 'one' | 'multi'
  rows: BlockRow[]
  /** 아래 버튼 하나 (multi면 "N개 {label}") */
  action?: BlockAction
}

/** 대화 기록에 남기는 결과 한 장 (show_result) */
export interface ResultRecordMessage {
  kind: 'result'
  /** 머리 줄 (예약 확정 · 쿠팡 · 접이식 유모차) */
  title?: string
  from?: string
  /** 끝난 일이면 머리에 체크 표시 */
  done?: boolean
  /** 큰 값 하나 (11/21(토) 19:00 · 1,284,300원) */
  big: string
  /** 큰 값 옆 작은 글 (4명 · 룸) */
  bigNote?: string
  /** 정보 줄 (이름·값). code면 고정폭 글꼴 (번호) */
  facts?: { label: string; value: string; code?: boolean }[]
  /** 진행 단계 (주문·출고·배송 중·도착), now는 지금 단계 번호(0부터) */
  steps?: { names: string[]; now: number }
  /** 기한 (YYYY-MM-DD). 화면은 D-n을 노랑으로 */
  due?: string
  /** 기한 꼬리표 말 (결제 · 마감) */
  dueLabel?: string
  actions?: BlockAction[]
}

export type DraftVia = 'sms' | 'kakao' | 'mail' | 'post' | 'other'

/** 대화 기록에 남기는 보낼 글 (show_draft). [보내기]는 두리에게 부탁 → 보내기 직전 승인 */
export interface DraftRecordMessage {
  kind: 'draft'
  /** 받는 사람 (집주인 김OO) */
  to?: string
  via: DraftVia
  /** 메일 제목 */
  subject?: string
  text: string
}

/** 두리 질문 아래 빠른 답 (답 끝 [[답: a | b]] 줄을 엔진이 떼어 남긴다) */
export interface QuickRecordMessage {
  kind: 'quick'
  replies: string[]
}

/** 경로 카드 한 구간: 무엇을(노선) 어디서 어디까지 */
export type RouteMode = 'subway' | 'bus' | 'train' | 'walk' | 'etc'
export interface RouteLeg {
  mode: RouteMode
  /** 노선 이름 (2호선 · 광역 M7731 · 신분당선 · 도보) */
  line: string
  /** 탈 곳 → 내릴 곳 */
  from: string
  to: string
  /** 이 구간 걸리는 분 (막대 길이) */
  minutes?: number
  /** 탈 곳 막차 (23:29) */
  last?: string
  /** 짧은 덧말 (대화 방면 · 3번 출구) */
  note?: string
}

/** 대화 기록에 남기는 경로 카드 (show_route) */
export interface RouteRecordMessage {
  kind: 'route'
  /** 머리 줄 (강남역 → 대화역) */
  title?: string
  from?: string
  /** 큰 값: 결론 하나 (23:25까지 강남역 출발 · 1시간 16분) */
  big: string
  /** 큰 값 옆 작은 글 (환승 1회 · 2,150원) */
  bigNote?: string
  legs: RouteLeg[]
  /** 정보 줄 (놓치면 · 다른 길 · 실시간) 4개까지 */
  facts?: { label: string; value: string }[]
  actions?: BlockAction[]
}

export type BlockRecordMessage =
  | RowsRecordMessage
  | ResultRecordMessage
  | DraftRecordMessage
  | RouteRecordMessage

// ── 다듬기: AI가 넘긴 값을 믿을 수 있는 모양으로 ─────────────

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
 * 돈·연락·삭제는 블록 버튼으로 바로 하지 않는다 (두리에게 부탁하는 글은 괜찮다: 그 뒤 승인 카드를 거친다).
 * 그래도 버튼 이름이 "결제하기"처럼 바로 일어나는 것처럼 보이면 사람이 오해하니 그런 이름은 뺀다
 */
const RISKY_LABEL = /결제|송금|이체|구매하기|주문하기|삭제|탈퇴|해지/

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

/** 목록 줄: 30줄까지 (화면은 5줄 보이고 나머지는 펼침), 글 길이 자르기, https만 */
export function cleanRows(input: unknown): RowsRecordMessage | undefined {
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
  // 날짜 앞머리인데 날짜가 하나도 없으면 앞머리 없이
  if (lead === 'date' && !rows.some((x) => x.date)) lead = 'none'
  const out: RowsRecordMessage = { kind: 'rows', lead, rows }
  const title = str(r.title, 40)
  const from = str(r.from, 24)
  const act = action(r.action)
  if (title) out.title = title
  if (from) out.from = from
  if (pick) out.pick = pick
  if (pick === 'multi') out.action = act ?? { label: '고르기', ask: '이것만 할게' }
  else if (act) out.action = act
  return out
}

/** 결과 한 장: 정보 줄 6개, 단계 2~6개, 버튼 2개까지 */
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
    // [이름, 값, "code"] 줄이나 {label, value, code} 둘 다 받는다
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

/** 노선 이름으로 탈것 짐작 (AI가 mode를 빼먹었을 때) */
function guessMode(line: string): RouteMode {
  if (/도보|걷기/.test(line)) return 'walk'
  if (/호선|선$|경의|공항철도|GTX|경춘|수인|신분당|우이|김포골드|서해|에버라인|의정부/.test(line))
    return 'subway'
  if (/KTX|SRT|ITX|무궁화|새마을|기차|열차/.test(line)) return 'train'
  if (/버스|광역|간선|지선|마을|직행|좌석|심야|공항버스|^[MN]?\d|^[가-힣]+\d/.test(line)) return 'bus'
  return 'etc'
}

/** 경로 카드: 구간 2~8개, 정보 줄 4개, 버튼 2개까지 */
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

/** 노선 색 (수도권 지하철 공식 색, 버스는 종류 색). 모르면 탈것 기본 색 */
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

/** 보낼 글: 2000자까지 */
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

// 빠른 답 줄 떼기는 rich.ts에 있다 (답 그리기가 늘 감춰야 해서, 의존성 없는 그 파일에 둔다)
export { hideQuickTail, splitQuick } from './rich.js'

// ── 글 대체본: 블록을 못 그리는 곳(알림·예전 앱·AI에게 돌려줄 때) ──

/** 블록을 글 몇 줄로 */
export function blockText(rec: BlockRecordMessage | QuickRecordMessage): string {
  if (rec.kind === 'quick') return rec.replies.map((r) => `· ${r}`).join('\n')
  if (rec.kind === 'draft') return `${rec.to ? `받는 사람: ${rec.to}\n` : ''}${rec.text}`
  if (rec.kind === 'route') {
    const lines = [`${rec.title ? `${rec.title}: ` : ''}${rec.big}${rec.bigNote ? ` (${rec.bigNote})` : ''}`]
    for (const g of rec.legs)
      lines.push(
        `- ${g.line} ${g.from} → ${g.to}${g.minutes ? ` · ${g.minutes}분` : ''}${g.last ? ` · 막차 ${g.last}` : ''}`,
      )
    for (const f of rec.facts ?? []) lines.push(`${f.label}: ${f.value}`)
    return lines.join('\n')
  }
  if (rec.kind === 'result') {
    const lines = [`${rec.title ? `${rec.title}: ` : ''}${rec.big}${rec.bigNote ? ` (${rec.bigNote})` : ''}`]
    if (rec.steps) lines.push(`지금: ${rec.steps.names[rec.steps.now]}`)
    for (const f of rec.facts ?? []) lines.push(`${f.label}: ${f.value}`)
    return lines.join('\n')
  }
  const lines = rec.title ? [rec.title] : []
  for (const r of rec.rows) {
    const parts = [
      r.date ? `${shortDate(r.date)} ` : '',
      r.title,
      r.sub ? ` · ${r.sub}` : '',
      r.value ? ` · ${r.value}` : '',
      r.state ? ` · ${r.state}` : '',
    ]
    lines.push(`- ${parts.join('')}`)
  }
  return lines.join('\n')
}

/** 2027-01-07 → 1/7(목) */
export function shortDate(d: string): string {
  const t = new Date(`${d}T00:00:00Z`)
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()}(${'일월화수목금토'[t.getUTCDay()]})`
}

/** 오늘(한국 시간)부터 그날까지 며칠: 0이면 오늘, 음수면 지남 */
export function daysUntil(d: string, now = Date.now()): number {
  const today = new Date(now + 9 * 3600_000).toISOString().slice(0, 10)
  return Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
}

/** 보낼 글 [보내기]를 누르면 두리에게 가는 말 (두리는 보내기 직전 승인을 받는다) */
export function draftAsk(rec: DraftRecordMessage): string {
  if (rec.via === 'post') return '방금 쓴 글 그대로 올려 줘'
  const how = { sms: '문자로 ', kakao: '카카오톡으로 ', mail: '메일로 ', other: '' }[rec.via]
  return `방금 쓴 글 그대로 ${rec.to ? `${rec.to}에게 ` : ''}${how}보내 줘`
}

/** 여러 개 고르기 버튼 글자: "3개 담기 · 25,860원" (금액이 다 있을 때만 합계) */
export function multiLabel(rows: BlockRow[], on: boolean[], label: string): string {
  const picked = rows.filter((_, i) => on[i])
  if (!picked.length) return '고른 게 없어요'
  const sum = picked.every((r) => typeof r.amount === 'number')
    ? ` · ${picked.reduce((a, r) => a + (r.amount ?? 0), 0).toLocaleString('ko-KR')}원`
    : ''
  return `${picked.length}개 ${label}${sum}`
}

/** 여러 개 고르기에서 보낼 말: "고른 것만 담아 줘: 떡국떡 1kg, 한우 양지" */
export function multiAsk(rows: BlockRow[], on: boolean[], a: BlockAction): string {
  const names = rows.filter((_, i) => on[i]).map((r) => r.title)
  const skipped = rows.filter((_, i) => !on[i]).map((r) => r.title)
  return `${a.ask ?? a.label}: ${names.join(', ')}${skipped.length ? ` (뺀 것: ${skipped.join(', ')})` : ''}`
}
