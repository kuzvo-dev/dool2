// 두리의 생활 기록: 목표(알아서 하는 일·반복), 보관함(남겨 둔 결과), 기억(사용자에 대해 알게 된 것), 피드(한 일·알림).
// 모두 이 PC의 저장소(설정 표)에만 둔다. AI는 도구(life_*)로 만들고, 폰·PC 화면은 같은 목록을 본다.
import { randomUUID } from 'node:crypto'
import {
  cleanCards,
  type FeedItem,
  GOAL_CATEGORIES,
  type GoalCategory,
  type Identity,
  type LibraryItem,
  type LibraryTab,
  type LifeAction,
  type LifeState,
  type MemoryItem,
  type Routine,
  type RoutineSchedule,
  type SuggestedIdea,
} from '@dool2/protocol'
import { cleanDraft, cleanResult, cleanRoute, cleanRows } from '@dool2/protocol/blocks'
import type { ConnectionItem } from '@dool2/protocol/connect'
import { PAGE_SIZE, type Page, pageOf } from '@dool2/protocol/paging'
import { nextRun, ruleLabel, scheduleLabel, untilEnd, untilLabel } from '@dool2/protocol/schedule'

export { nextRun, ruleLabel, scheduleLabel, untilEnd }

/** 조건에 맞을 때만 알리는 일: 도는 차례의 답이 이 말로 시작하면 조용히 넘어간다 */
export const QUIET_MARK = '알릴 것 없음'
/** 끝나는 조건이 이뤄졌을 때 답 끝에 붙이는 표시: 붙으면 스스로 꺼진다 */
export const END_MARK = '[끝]'

/** 도는 차례의 답 읽기: 조용히 넘길지, 끝났는지, 표시를 뺀 글 */
export function readRun(r: Pick<Routine, 'notify' | 'until'>, answer: string) {
  const ended = !!r.until && answer.includes(END_MARK)
  const text = answer.split(END_MARK).join('').trim()
  const flat = text.replace(/[\s*_`#>"'“”‘’.,!~-]/g, '')
  const quiet = r.notify === 'when_found' && flat.startsWith(QUIET_MARK.replace(/\s/g, ''))
  return { quiet, ended, text }
}

/** 정해진 때 두리에게 보낼 말: 할 일 + 조건에 맞지 않을 때·끝나는 조건을 답에 담는 법 */
export function routineAsk(r: Pick<Routine, 'prompt' | 'notify' | 'until' | 'lastTold'>): string {
  const lines = [r.prompt]
  if (r.notify === 'when_found') {
    lines.push(
      `조건에 맞을 때만 알리는 일이에요. 맞는 게 없으면 다른 말 없이 "${QUIET_MARK}"만 써요(사용자에게 알리지 않아요). 맞으면 확인한 것부터 짧게 써요.`,
    )
    // 지켜보기는 지난번에 알린 것을 알아야 같은 소식을 또 알리지 않는다
    if (r.lastTold) lines.push(`지난번에 이미 알린 것 (같은 건 새 소식이 아니에요):\n${r.lastTold}`)
  }
  if (r.until && !untilEnd(r.until))
    lines.push(
      `끝나는 조건: ${r.until}. 이번에 이 조건이 이뤄졌으면 답 맨 끝에 "${END_MARK}"을 붙여요(이 일이 스스로 꺼져요).`,
    )
  return lines.join('\n')
}

/** 한국 시간 "12월 1일(화) 오전 9:00" */
function kstWhen(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600_000)
  const h = d.getUTCHours()
  const m = d.getUTCMinutes()
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${'일월화수목금토'[d.getUTCDay()]}) ${h < 12 ? '오전' : '오후'} ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`
}

/** 정한 것 한 줄 (AI가 사용자에게 그대로 말한다): 언제 돌고 · 언제 끝나고 · 언제 알리는지 · 처음 할 때 */
export function ruleSentence(r: Routine): string {
  const s = r.schedule
  const when = s
    ? `${scheduleLabel(s)}${s.kind === 'every' || s.kind === 'once' ? '' : '에'} 해요`
    : '정한 때 없이 두어요(저절로 돌지 않아요)'
  const end =
    !s || s.kind === 'once'
      ? ''
      : r.until
        ? untilEnd(r.until)
          ? `${untilLabel(r.until)} 하고 스스로 꺼져요`
          : `"${r.until}" 되면 꺼져요`
        : '끝나는 때 없음(지울 때까지)'
  const tell = !s
    ? ''
    : r.notify === 'when_found'
      ? '조건에 맞을 때만 알리고 아니면 조용히 넘어가요'
      : r.target === 'feed'
        ? '매번 피드에 올려요'
        : '매번 알려요'
  const first = r.nextRunAt ? `처음은 ${kstWhen(r.nextRunAt)}` : ''
  return [when, end, tell, first].filter(Boolean).join(' · ')
}

/** 조건이 있는 지켜보기 같은 말 ("넘으면", "나오면", "뜨면" …) */
const CONDITIONAL =
  /(넘으면|넘어가면|나오면|뜨면|생기면|떨어지면|내려가면|오르면|올라가면|바뀌면|열리면|풀리면|있으면|이하면|이상이면|미만이면|초과하면)/

export interface Kv {
  getSetting(key: string): unknown
  setSetting(key: string, value: unknown): void
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const bad = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

/**
 * 저장 한도. 피드는 개수가 아니라 기간으로(90일) 남기고 페이지로 나눠 보여 준다 (넘치지 않게 개수도 넉넉히 막아 둔다).
 * 보관함은 사용자가 남긴 것이라 기간으로 지우지 않는다
 */
const LIMIT = { routines: 50, library: 2000, memory: 200, feed: 3000 }
export const FEED_KEEP_DAYS = 90
/** 목록에 보내는 보관함 글 길이 (전체는 하나 받기로) */
const LIBRARY_PREVIEW = 400
/** 목표 진행 기록: 저장은 50개, 화면에 보내는 건 최근 것만 (PC 상세 20줄·폰 8줄) */
const LOG_SENT = 20
/** 피드 종류 중 "두리가 한 일"로 세는 것 (이번 주 두리가 한 일) */
const DONE_KINDS = new Set<FeedItem['kind']>(['done', 'routine', 'post', 'saved', 'goal', 'connected'])
const FEED_KINDS: FeedItem['kind'][] = ['done', 'routine', 'saved', 'goal', 'connected', 'suggest', 'post']
const FEED_LABEL: Record<FeedItem['kind'], string> = {
  post: '소식',
  done: '끝낸 일',
  routine: '예약한 일',
  saved: '보관함',
  goal: '목표',
  connected: '연결',
  suggest: '먼저 챙김',
}
const feedAt = (f: FeedItem) => f.at
const libraryAt = (it: LibraryItem) => it.savedAt
const inTab = (it: LibraryItem, tab: LibraryTab) =>
  tab === 'files' ? it.kind === 'file' : it.kind !== 'file'

/** 목록용: 긴 글은 앞부분만 (글자 단위로 잘라 이모지가 깨지지 않게) */
function preview(it: LibraryItem): LibraryItem {
  // 미리보기 사진은 목록에 싣지 않는다 (열 때 하나 받기로)
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
/** 보관함 종류 이름 (폰·PC 화면과 같은 말) */
const LIBRARY_LABEL: Record<LibraryItem['kind'], string> = {
  note: '정리',
  link: '링크',
  product: '상품',
  place: '장소',
  file: '파일',
}
export class Life {
  /** 폰에서 보낸 사진 읽기 (본체가 붙인다) */
  photo?: (name: string) => Promise<string>
  /** 바뀌면 (폰·PC에 다시 보내기) */
  onChange?: () => void
  /** 예약한 일을 할 때 (대화로 보내 두리가 한다) */
  onDue?: (r: Routine) => void
  /** 맞춤 아이디어를 새로 찾을 때 (본체가 피드 대화에서 두리에게 부탁한다) */
  onIdeas?: () => void
  ideasBusy = false
  /** 먼저 챙기기: 연결한 서비스가 있는지 (본체가 붙인다. 없으면 살펴보지 않는다) */
  watchSources?: () => string[]
  /** 먼저 챙기기: 살펴볼 때 (본체가 피드 대화에서 두리에게 부탁한다) */
  onWatch?: () => void
  /** 먼저 챙긴 일을 피드에 올렸을 때 (본체가 폰에 알린다) */
  onTell?: (f: FeedItem) => void
  watchBusy = false
  /** 이번 살펴보기에서 올린 개수 (한 번에 너무 많이 알리지 않게) */
  private told = 0

  constructor(
    private readonly kv: Kv,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * 읽어 둔 목록 (설정 표의 JSON을 부를 때마다 다시 풀지 않게). 쓰기는 모두 put을 거쳐 함께 바뀐다.
   * 본체가 설정 표를 직접 지웠으면(처음부터 다시) reload()로 비운다
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
  /** 설정 표를 밖에서 바꿨을 때 다시 읽게 한다 */
  reload() {
    this.cache.clear()
  }
  private put<T>(key: keyof typeof LIMIT, items: T[]) {
    let keep = items.slice(0, LIMIT[key])
    if (key === 'feed') {
      // 90일이 지난 소식은 지운다 (그 안의 것은 모두 페이지로 볼 수 있다)
      const since = new Date(this.now().getTime() - FEED_KEEP_DAYS * 86_400_000).toISOString()
      keep = (keep as FeedItem[]).filter((f) => f.at >= since) as T[]
    }
    this.kv.setSetting(key, keep)
    this.cache.set(key, keep)
    this.onChange?.()
  }

  // ── 목표 ──
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
  }): Routine {
    const now = this.now()
    const next = input.schedule ? nextRun(input.schedule, now) : undefined
    const r: Routine = {
      id: randomUUID(),
      title: input.title.slice(0, 60) || '이름 없는 목표',
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
    }
    this.put('routines', [r, ...this.routines()])
    // 피드 지시로 만든 일은 피드에 따로 알리지 않는다
    if (r.target !== 'feed')
      this.feed({
        kind: 'goal',
        title: `${r.category ? '목표를 세웠어요' : '예약했어요'}: ${r.title}`,
        ...(r.schedule
          ? { body: [scheduleLabel(r.schedule), ruleLabel(r)].filter(Boolean).join(' · ') }
          : {}),
        ref: r.id,
      })
    return r
  }
  /** 목표 고치기: 계획 단계·진행 기록, 알림의 언제·끝나는 때·알리기 */
  updateGoal(
    id: string,
    patch: {
      plan?: string[]
      done?: number[]
      log?: string
      title?: string
      prompt?: string
      schedule?: RoutineSchedule
      /** 빈 글이면 끝나는 때를 지운다 */
      until?: string
      notify?: 'always' | 'when_found'
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
      // 끝나서 꺼진 걸 다시 켜면: 다음 차례 전에 끝나는 날은 지운다 (켜자마자 다시 꺼지지 않게)
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
  /** 지금 해야 할 일을 꺼내고 다음 시각을 정한다 (본체가 30초마다 부른다) */
  tick() {
    if (this.ideasDue() && !this.ideasBusy && (this.memory().length || this.routines().length))
      this.refreshIdeas()
    if (this.watchOn() && !this.watchBusy && this.watchSources?.().length && this.watchDue()) this.watchNow()
    const now = this.now()
    const list = this.routines()
    const ripe = list.filter((r) => r.enabled && r.nextRunAt && Date.parse(r.nextRunAt) <= now.getTime())
    if (!ripe.length) return []
    const due: Routine[] = []
    for (const r of ripe) {
      const end = untilEnd(r.until)
      // 끝나는 날이 지났으면 하지 않고 끈다 (PC가 꺼져 있다 늦게 켜진 경우)
      if (end && end <= now) {
        this.end(r)
        continue
      }
      due.push(r)
      r.lastRunAt = now.toISOString()
      const next = r.schedule ? nextRun(r.schedule, now) : undefined
      if (next && !(end && next >= end)) r.nextRunAt = next.toISOString()
      else if (next)
        this.end(r) // 이번이 끝나는 날 전 마지막
      else {
        delete r.nextRunAt
        r.enabled = false
      }
    }
    this.put('routines', list)
    for (const r of due) this.onDue?.(r)
    return due
  }
  /** 끝나는 때가 되어 스스로 끈다 */
  private end(r: Routine) {
    delete r.nextRunAt
    r.enabled = false
    r.endedAt = this.now().toISOString()
  }
  /** 바로 한 번 해 보기 */
  runNow(id: string) {
    const r = this.routines().find((x) => x.id === id)
    if (r) this.onDue?.(r)
    return r
  }
  /**
   * 도는 차례의 결과 남기기. 조건에 맞을 때만 알리는 일인데 "알릴 것 없음"이면 피드에 올리지 않고(quiet),
   * 끝나는 조건이 이뤄졌다는 표시가 있으면 끈다(ended). 본체는 quiet면 폰에도 알리지 않는다
   */
  noteRun(id: string, answer: string): { quiet: boolean; ended: boolean; item?: FeedItem } | undefined {
    const list = this.routines()
    const r = list.find((x) => x.id === id)
    if (!r) return
    const { quiet, ended, text: result } = readRun(r, answer)
    r.lastResult = result.slice(0, 300)
    // 지켜보기가 다음 차례에 같은 소식을 또 알리지 않게, 알린 것을 넉넉히 남긴다
    if (r.notify === 'when_found' && !quiet) r.lastTold = result.slice(0, 1500)
    if (ended) this.end(r)
    if (r.category && !quiet)
      r.log = [{ at: this.now().toISOString(), text: result.slice(0, 300) }, ...(r.log ?? [])].slice(0, 50)
    this.put('routines', list)
    if (quiet) return { quiet, ended }
    if (r.target === 'feed') {
      // 답 첫 줄이 제목, 나머지가 글
      const lines = result.trim().split('\n')
      const head = (lines[0] ?? '').replace(/^#+\s*|\*\*/g, '').trim()
      const body = lines.slice(1).join('\n').trim()
      const item = this.feed({
        kind: 'post',
        title: head.slice(0, 80) || '오늘의 소식',
        body: (body || result).slice(0, 2000),
        ref: r.id,
      })
      return { quiet, ended, item }
    }
    const item = this.feed({ kind: 'routine', title: r.title, body: result.slice(0, 2000), ref: r.id })
    return { quiet, ended, item }
  }

  // ── 보관함 ──
  library(): LibraryItem[] {
    return this.list<LibraryItem>('library')
  }
  save(input: Omit<LibraryItem, 'id' | 'savedAt'>): LibraryItem {
    const item: LibraryItem = { ...input, id: randomUUID(), savedAt: this.now().toISOString() }
    this.put('library', [item, ...this.library()])
    this.feed({ kind: 'saved', title: `보관함에 남겼어요: ${item.title}`, ref: item.id })
    return item
  }
  unsave(id: string) {
    const list = this.library()
    const next = list.filter((x) => x.id !== id)
    this.put('library', next)
    return next.length !== list.length
  }
  /** 보관함 한 페이지 (칸별, 최근 것부터). 글은 앞부분만 */
  libraryPage(o: { tab?: LibraryTab; before?: string; limit?: number } = {}): Page<LibraryItem> {
    const tab = o.tab ?? 'made'
    const p = pageOf(
      this.library().filter((it) => inTab(it, tab)),
      libraryAt,
      o,
    )
    return { ...p, items: p.items.map(preview) }
  }
  /** 보관함 하나 (전체 글) */
  libraryItem(id: string): LibraryItem | undefined {
    return this.library().find((x) => x.id === id)
  }

  // ── 기억 ──
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
  /** 지침에 붙일 기억 (최근 40개) */
  memoryPrompt(): string {
    const list = this.memory().slice(0, 40)
    if (!list.length) return ''
    return `## 사용자에 대해 기억하는 것 (자연스럽게 활용하고, 틀리면 memory_forget)\n${list.map((m) => `- ${m.text}`).join('\n')}`
  }

  // ── 피드 ──
  feedItems(): FeedItem[] {
    return this.list<FeedItem>('feed')
  }
  /** 피드 한 페이지 (최근 것부터). kinds를 주면 그 종류만 (활동: done·routine) */
  feedPage(o: { before?: string; limit?: number; kinds?: FeedItem['kind'][] } = {}): Page<FeedItem> {
    const kinds = o.kinds?.length ? new Set(o.kinds) : undefined
    const all = this.feedItems()
    return pageOf(kinds ? all.filter((f) => kinds.has(f.kind)) : all, feedAt, o)
  }
  /** 이번 주 두리가 한 일: 최근 days일 날마다 한 일 개수 (마지막이 오늘, 이 PC 시간 기준) */
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
   * 먼저 챙긴 일 올리기: 같은 열쇠(없으면 같은 제목)로 30일 안에 알린 적 있으면 올리지 않는다.
   * 올리면 onTell로 폰에 알린다. 살펴보기 한 번에 3개까지
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
      title: title || '두리가 먼저 챙겼어요',
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
  /** 최근에 먼저 알린 것 (살펴볼 때 같은 걸 또 올리지 않게 두리에게 보여 준다) */
  recentTells(days = 14): FeedItem[] {
    const since = this.now().getTime() - days * 86_400_000
    return this.feedItems()
      .filter((f) => f.kind === 'suggest' && Date.parse(f.at) >= since)
      .slice(0, 20)
  }

  // ── 먼저 챙기기 ──
  watchOn(): boolean {
    return this.kv.getSetting('watchOff') !== true
  }
  setWatch(on: boolean) {
    this.kv.setSetting('watchOff', !on)
    this.onChange?.()
  }
  /**
   * 하루 두 번(한국 시간 8:30, 18:30) 그 시각이 지나면 한 번씩 살펴본다.
   * 밤(22시~7시)에는 하지 않는다: 자는 사이에 폰을 울리지 않게. PC를 늦게 켜도 그 낮 안이면 한다
   */
  private watchDue(): boolean {
    const now = this.now()
    const KST = 9 * 3600_000
    const kst = new Date(now.getTime() + KST)
    const hour = kst.getUTCHours()
    if (hour < 7 || hour >= 22) return false
    const at = (h: number, m: number) =>
      Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), h, m) - KST
    const slots = [at(8, 30), at(18, 30)].filter((t) => t <= now.getTime())
    const last = slots.at(-1)
    if (last === undefined) return false
    const done = this.kv.getSetting('watchAt')
    return typeof done !== 'string' || Date.parse(done) < last
  }
  /** 지금 살펴보기 (정해진 때가 되었거나, 화면에서 눌렀을 때) */
  watchNow() {
    if (this.watchBusy) return
    this.watchBusy = true
    this.told = 0
    this.kv.setSetting('watchAt', this.now().toISOString())
    this.onChange?.()
    this.onWatch?.()
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
  /** 피드 지시: 매일 아침 7:30에 그 말대로 피드 글을 쓴다 (하나만 둔다) */
  setFeedPrompt(text: string) {
    const t = text.trim().slice(0, 300)
    this.kv.setSetting('feedPrompt', t)
    const list = this.routines().filter((r) => !(r.target === 'feed' && r.title === '피드'))
    this.kv.setSetting('routines', list)
    this.cache.set('routines', list)
    if (t)
      this.addRoutine({
        title: '피드',
        prompt: `오늘의 피드 글을 써 주세요: ${t}\n이 답이 그대로 피드에 올라가요(feed_post 도구는 쓰지 않아요). 첫 줄은 짧은 제목, 그다음 핵심 3~5줄 목록. 확인한 것만 쓰고 맨 끝에 출처 사이트 이름을 적어요. "올렸어요" 같은 말은 쓰지 않아요.`,
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
  /** 매일 아침 6시(한국)가 지나면 하루 한 번 새로 찾는다 */
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
   * 폰·PC 첫 화면에 보낼 것. 긴 목록(피드·보관함)은 첫 페이지만 보내고 나머지는 페이지로 (feedPage·libraryPage).
   * logs: 목표마다 보낼 진행 기록 수 (폰은 8줄만 보여 준다)
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

  /** 폰·PC 화면에서 한 일 */
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
          title: a.title.slice(0, 80) || '남긴 글',
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
      case 'ideas-refresh':
        this.refreshIdeas()
        return
      case 'watch':
        this.setWatch(a.on)
        return
      case 'watch-now':
        if (this.watchSources?.().length) this.watchNow()
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

  // ── AI 도구 (life_*) ──
  run(tool: string, a: Record<string, unknown>): ToolResult {
    try {
      switch (tool) {
        case 'goal_create': {
          const schedule = a.schedule ? parseSchedule(a) : undefined
          if (a.schedule && !schedule) return bad(scheduleHelp(a))
          const rule = readRule(a)
          if (typeof rule === 'string') return bad(rule)
          const end = untilEnd(rule.until)
          const first = schedule ? nextRun(schedule, this.now()) : undefined
          if (end && end <= this.now())
            return bad(
              `끝나는 날(${rule.until})이 벌써 지났어요. 사용자에게 언제까지 할지 다시 물어봐 주세요.`,
            )
          if (end && first && first >= end)
            return bad(
              `처음 할 때(${kstWhen(first.toISOString())})가 끝나는 날(${rule.until})보다 늦어서 한 번도 돌지 않아요. 언제나 끝나는 날을 고쳐 주세요.`,
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
          })
          return ok(
            [
              `${category ? '목표를' : '예약을'} 만들었어요: "${r.title}" [id ${r.id.slice(0, 8)}]`,
              `정한 것: ${ruleSentence(r)}.`,
              ...ruleGaps(r),
              '사용자에게 "정한 것"을 그대로 한 문장으로 말해 확인해 주세요.',
              ...(a.preview === true
                ? [
                    '미리 보기: 지금 이 대화에서 prompt대로 한 번 해서, 예약한 때 받을 것과 같은 모양으로 보여 주세요. 정한 것은 그 아래 한 줄로.',
                  ]
                : []),
            ].join('\n'),
          )
        }
        case 'goal_update': {
          const schedule = a.schedule ? parseSchedule(a) : undefined
          if (a.schedule && !schedule) return bad(scheduleHelp(a))
          const rule = readRule(a)
          if (typeof rule === 'string') return bad(rule)
          const end = untilEnd(rule.until)
          if (end && end <= this.now())
            return bad(
              `끝나는 날(${rule.until})이 벌써 지났어요. 사용자에게 언제까지 할지 다시 물어봐 주세요.`,
            )
          const r = this.updateGoal(String(a.id ?? ''), {
            ...(Array.isArray(a.plan) ? { plan: a.plan.map(String) } : {}),
            ...(Array.isArray(a.done) ? { done: a.done.map(Number) } : {}),
            ...(a.log ? { log: String(a.log) } : {}),
            ...(a.title ? { title: String(a.title) } : {}),
            ...(a.prompt ? { prompt: String(a.prompt) } : {}),
            ...(schedule ? { schedule } : {}),
            ...(typeof a.until === 'string' ? { until: a.until } : {}),
            ...(rule.notify ? { notify: rule.notify } : {}),
          })
          if (!r) return bad('그런 목표가 없어요. goal_list로 id를 확인하세요.')
          const timing = schedule || a.until !== undefined || rule.notify
          return ok(
            timing
              ? [`고쳤어요: "${r.title}"`, `정한 것: ${ruleSentence(r)}.`, ...ruleGaps(r)].join('\n')
              : `목표를 고쳤어요: ${r.title}`,
          )
        }
        case 'idea_suggest': {
          const list = Array.isArray(a.ideas) ? (a.ideas as SuggestedIdea[]) : []
          const ok2 = list.filter((i) => i && typeof i.text === 'string' && i.text.trim())
          if (!ok2.length) return bad('ideas가 비었어요. [{text, why}] 3~6개를 주세요.')
          this.setIdeas(ok2)
          return ok(`아이디어 ${Math.min(ok2.length, 6)}개를 아이디어 탭에 올렸어요.`)
        }
        case 'feed_post': {
          const f = this.feed({
            kind: 'post',
            title: String(a.title ?? '').slice(0, 80) || '두리 소식',
            body: String(a.body ?? '').slice(0, 1500),
          })
          return ok(`피드에 올렸어요: ${f.title}`)
        }
        case 'show_cards': {
          // 기록은 대화 엔진이 답 아래에 남긴다 (threads.ts). 여기서는 다듬은 결과만 알려 준다
          const cards = cleanCards(a.cards)
          if (!cards.length) return bad('붙일 카드가 없어요. title이 있는 카드를 넣어 주세요.')
          const pics = cards.filter((c) => c.image).length
          return ok(
            `카드 ${cards.length}장을 답 아래에 붙여요(사진 ${pics}장). 답 글에는 같은 목록을 되풀이하지 말고 고른 이유·차이만 짧게 말해요.`,
          )
        }
        // 결과 블록: 기록은 대화 엔진이 답 아래에 남긴다 (threads.ts). 여기서는 다듬은 결과만 알려 준다
        case 'show_list': {
          const r = cleanRows(a)
          if (!r) return bad('붙일 줄이 없어요. rows에 title이 있는 줄을 넣어 주세요.')
          const more = r.rows.length > 5 ? ` 5줄까지 보이고 나머지 ${r.rows.length - 5}줄은 펼쳐 봐요.` : ''
          const picked = r.pick === 'multi' ? ` 미리 고른 것 ${r.rows.filter((x) => x.on).length}개.` : ''
          return ok(
            `목록 ${r.rows.length}줄을 답 아래에 붙여요.${more}${picked} 답 하나에 결과 블록 하나라, 다른 블록을 또 부르면 마지막 것만 붙어요. 답 글에는 같은 목록을 되풀이하지 말고 이유·다음 할 일만 짧게 말해요.`,
          )
        }
        case 'show_result': {
          const r = cleanResult(a)
          if (!r) return bad('큰 값(big)이 없어요. 언제·얼마 같은 값 하나를 big에 넣어 주세요.')
          return ok(
            '결과 카드를 답 아래에 붙여요. 답 하나에 결과 블록 하나라, 다른 블록을 또 부르면 마지막 것만 붙어요. 답 글에는 같은 값을 되풀이하지 말고 한두 문장만 말해요.',
          )
        }
        case 'show_route': {
          const r = cleanRoute(a)
          if (!r) return bad('결론(big)과 구간(legs: line·from·to)이 있어야 해요.')
          return ok(
            `경로 카드(구간 ${r.legs.length}개)를 답 아래에 붙여요. 답 하나에 결과 블록 하나라, 다른 블록을 또 부르면 마지막 것만 붙어요. 답 글에는 구간을 되풀이하지 말고 결론 한 줄과 놓쳤을 때 대안만 말해요.`,
          )
        }
        case 'show_draft': {
          const r = cleanDraft(a)
          if (!r) return bad('보낼 글(text)이 비었어요.')
          return ok(
            '보낼 글을 답 아래에 붙여요([복사]·[보내기]). 이 도구는 보내지 않아요. 사용자가 [보내기]를 누르면 "방금 쓴 글 그대로 보내 줘"가 오니, 그때 보내기 직전 승인을 받아요. 답 글에는 글을 되풀이하지 말고 한두 문장만 말해요.',
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
          if (r === 'dup') return ok('이미 알린 일이에요. 다시 올리지 않았어요.')
          if (r === 'full') return bad('이번에는 3개까지만 알려요. 가장 중요한 것만 남기고 마쳐요.')
          return ok(`피드에 올리고 폰에 알렸어요: ${r.title}`)
        }
        case 'goal_list': {
          const list = this.routines()
          if (!list.length) return ok('아직 목표가 없어요.')
          return ok(
            list
              .map(
                (r) =>
                  `- [${r.id.slice(0, 8)}] ${r.category ? `(${r.category}) ` : ''}${r.title} · ${r.schedule ? scheduleLabel(r.schedule) : '정한 때 없음'}${ruleLabel(r) ? ` · ${ruleLabel(r)}` : ''}${r.enabled ? '' : r.endedAt ? ' (끝남)' : ' (꺼짐)'}${r.plan ? ` · 계획 ${r.plan.filter((p) => p.done).length}/${r.plan.length}` : ''}${r.lastResult ? ` · 지난 결과: ${r.lastResult.slice(0, 80)}` : ''}`,
              )
              .join('\n'),
          )
        }
        case 'goal_delete': {
          const id = String(a.id ?? '')
          const r = this.routines().find((x) => x.id === id || x.id.startsWith(id))
          if (!r || !this.removeRoutine(r.id)) return bad('그런 목표가 없어요. goal_list로 id를 확인하세요.')
          return ok(`목표를 지웠어요: ${r.title}`)
        }
        case 'library_save': {
          const kind = LIBRARY_KINDS.includes(a.kind as never) ? (a.kind as LibraryItem['kind']) : 'note'
          const item = this.save({
            kind,
            title: String(a.title ?? '').slice(0, 80) || '제목 없음',
            body: String(a.body ?? '').slice(0, 4000),
            ...(a.url ? { url: String(a.url).slice(0, 500) } : {}),
            ...(a.price ? { price: String(a.price).slice(0, 40) } : {}),
          })
          return ok(`보관함에 남겼어요: ${item.title}`)
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
          return ok(`기억해 둘게요: ${m.text}`)
        }
        case 'memory_forget': {
          const q = String(a.text ?? a.id ?? '')
          const m = this.memory().find((x) => x.id === q || x.id.startsWith(q) || x.text.includes(q))
          if (!m || !this.forget(m.id)) return bad('그런 기억이 없어요.')
          return ok(`잊었어요: ${m.text}`)
        }
      }
      return bad(`모르는 도구예요: ${tool}`)
    } catch (e) {
      return bad((e as Error).message)
    }
  }
}

/** AI가 준 언제를 정리한다 */
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
  if (kind === 'every' && Number(a.minutes) >= 15)
    return { kind: 'every', minutes: Math.round(Number(a.minutes)) }
  return undefined
}

/** 언제를 읽지 못했을 때: 무엇이 빠졌는지 */
function scheduleHelp(a: Record<string, unknown>): string {
  const kind = String(a.schedule ?? '')
  const need: Record<string, string> = {
    daily: 'time("09:00")',
    weekly: 'time과 days(0=일 … 6=토, 여러 개 가능)',
    monthly: 'time과 day(1~31, 말일은 31)',
    once: 'at(ISO 시각, +09:00 포함)',
    every: 'minutes(15 이상)',
  }
  return need[kind]
    ? `${kind}에는 ${need[kind]}이 필요해요.`
    : '언제 할지(schedule)를 알 수 없어요. daily·weekly·monthly·once·every 중 하나로 주세요.'
}

/** AI가 준 끝나는 때·알리기 (잘못이면 고칠 말) */
function readRule(a: Record<string, unknown>): { until?: string; notify?: 'always' | 'when_found' } | string {
  const out: { until?: string; notify?: 'always' | 'when_found' } = {}
  if (a.notify !== undefined) {
    if (a.notify !== 'always' && a.notify !== 'when_found')
      return 'notify는 "always"(매번 알림)나 "when_found"(조건에 맞을 때만) 중 하나예요.'
    out.notify = a.notify
  }
  if (typeof a.until === 'string' && a.until.trim()) {
    const u = a.until.trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(u) && !untilEnd(u))
      return `끝나는 날(${u})을 읽지 못했어요. "2026-12-31"처럼 주세요.`
    out.until = u
  }
  return out
}

/** 빠뜨리기 쉬운 것: 결과에 다음 길로 담는다 */
function ruleGaps(r: Routine): string[] {
  const s = r.schedule
  if (!s) return r.category ? [] : ['정한 때가 없어 저절로 돌지 않아요 — 알림이면 goal_update에 schedule']
  if (s.kind === 'once') return []
  const gaps: string[] = []
  if (r.notify === 'when_found' && !r.until)
    gaps.push(
      '끝나는 때가 없어요 — 지켜보기는 끝이 있는 게 보통이에요. 정하려면 goal_update에 until(날짜 "2026-12-31"이나 조건 "취소표를 잡으면")',
    )
  if (r.notify !== 'when_found' && CONDITIONAL.test(`${r.title} ${r.prompt}`))
    gaps.push(
      '조건이 있는 지켜보기 같아요 — 조건에 맞을 때만 알리려면 goal_update에 notify: "when_found" (아니면 매번 알려요)',
    )
  return gaps
}

/** 낱말 비교용: 띄어쓰기를 없애고 소문자로 ("성수 카페" = "성수카페") */
const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/** 받침에 맞는 "으로/로" ("성수로", "귤로", "카페로", "ABC(으)로") */
function euro(word: string): string {
  const c = word.charCodeAt(word.length - 1)
  if (c < 0xac00 || c > 0xd7a3) return '(으)로'
  const jong = (c - 0xac00) % 28
  return jong === 0 || jong === 8 ? '로' : '으로'
}

/** 저장한 날 (한국 시간 YYYY-MM-DD) */
function savedDay(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '날짜 모름'
  return new Date(t + 9 * 3600_000).toISOString().slice(0, 10)
}

/**
 * 보관함 꺼내 보기 (library_find 도구). 사용자가 앱 보관함에서 보는 칸 그대로 돌려준다.
 * 낱말이 여럿이면 많이 맞은 것부터, 같으면 최근 것부터. 못 찾으면 이유와 저장된 것 목록을 준다
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
    return '보관함이 비어 있어요. 아직 저장한 게 없어요. 예전 대화에서 본 것이면 conversation_search로 찾아봐요.'

  const pool = opts.kind ? recent.filter((x) => x.kind === opts.kind) : recent
  const scored = pool
    .map((it) => {
      const hay = squash([it.title, it.body, it.url ?? '', it.price ?? '', LIBRARY_LABEL[it.kind]].join(' '))
      return { it, score: words.filter((w) => hay.includes(w)).length }
    })
    .filter((x) => !words.length || x.score > 0)
    // sort는 안정 정렬이라 점수가 같으면 최근 순서가 그대로 남는다
    .sort((x, y) => y.score - x.score)
  const found = scored.slice(skip, skip + n).map((x) => x.it)

  if (!found.length && skip && scored.length)
    return `맞는 것은 ${scored.length}개라 ${skip}개를 건너뛰면 남는 게 없어요. 여기까지예요. skip을 줄이거나 빼고 다시 찾아요.`
  if (!found.length) {
    const where = kindLabel ? `보관함의 ${kindLabel} 중에` : '보관함에'
    const what = q ? ` '${q}'${euro(q)}` : ''
    const titles = recent
      .slice(0, 5)
      .map((x) => `${x.title} (${LIBRARY_LABEL[x.kind]} · ${savedDay(x.savedAt)})`)
      .join(', ')
    return [
      `${where}${what} 저장된 게 없어요. 저장된 것 ${recent.length}개, 최근: ${titles}.`,
      '다음: 낱말을 바꾸거나 줄여서 다시 찾거나(예: 동네 이름만), query를 비우고 최근 것을 보거나, 대화에서 본 것이면 conversation_search로 찾아요. 없는 걸 있다고 지어내지 않아요.',
    ].join('\n')
  }

  // 몇 개만 나오면 메모를 길게, 많으면 짧게 (전체 내용은 제목으로 다시 찾으면 길게 나온다)
  const room = found.length <= 3 ? 2000 : 300
  const lines = found.map((it, i) => {
    const head = `${skip + i + 1}. [${LIBRARY_LABEL[it.kind]}] ${it.title} · ${savedDay(it.savedAt)} 저장`
    const body = it.body.trim()
    const memo = body.length > room ? `${body.slice(0, room)}… (잘림)` : body
    return [
      head,
      ...(it.price ? [`   가격: ${it.price}`] : []),
      ...(it.url ? [`   링크: ${it.url}`] : []),
      ...(memo ? [`   메모: ${memo.replace(/\n/g, '\n   ')}`] : []),
    ].join('\n')
  })
  const scope = [q ? `'${q}'` : '최근 것', kindLabel ? `${kindLabel} 종류` : ''].filter(Boolean).join(' · ')
  const more =
    scored.length > found.length
      ? skip
        ? ` (맞는 것 ${scored.length}개 중 ${skip + 1}~${skip + found.length}번째)`
        : ` (맞는 것 ${scored.length}개 중 ${found.length}개)`
      : ''
  const rest = scored.length - skip - found.length
  return [
    `보관함에서 ${scope} ${found.length}개를 찾았어요${more}. 보관함 전체 ${recent.length}개.`,
    '',
    ...lines,
    '',
    '다음: 사용자에게 보여 줄 땐 show_list(줄마다 링크·가격)로 붙이고, 고를 후보(상품·장소)는 show_cards도 돼요(보관함엔 사진이 없어 사진 없이). 위에 있는 값만 쓰고, 메모가 잘렸으면 제목으로 다시 찾아요.',
    ...(rest > 0 ? [`더 있어요(${rest}개): 이어서 보려면 같은 낱말로 skip: ${skip + found.length}`] : []),
  ].join('\n')
}

/**
 * 피드 찾아보기 (feed_find 도구): 두리가 한 일·예약한 일의 결과·소식·먼저 챙긴 일. 사용자가 피드에서 보는 칸 그대로.
 * 최근 것부터 limit개, 더 있으면 다음 커서(before)를 준다. 기간 안 종류별 개수도 함께 ("이번 주 뭐 했어?")
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
    return '피드가 비어 있어요. 아직 두리가 한 일이 없어요. 대화에서 한 일이면 conversation_search로 찾아봐요.'
  const inRange = all.filter((f) => !since || f.at >= since)
  const pool = inRange.filter(
    (f) =>
      (!kinds || kinds.has(f.kind)) &&
      (!words.length || words.every((w) => squash(`${f.title} ${f.body ?? ''} ${f.from ?? ''}`).includes(w))),
  )
  const page = pageOf(pool, feedAt, { limit: n, ...(opts.before ? { before: opts.before } : {}) })
  const period = days ? `최근 ${days}일` : `저장된 ${FEED_KEEP_DAYS}일`
  const scope = [period, q ? `'${q}'` : '', kinds ? [...kinds].map((k) => FEED_LABEL[k]).join('·') : '']
    .filter(Boolean)
    .join(' · ')
  if (!page.items.length) {
    if (opts.before) return `${scope}: 여기까지예요. 더 오래된 건 없어요.`
    return [
      `${scope}에 맞는 게 없어요. 피드 전체 ${all.length}개.`,
      '다음: 낱말을 줄이거나 기간(days)을 늘리거나 종류(kinds)를 빼고 다시 찾아요. 대화에서 한 일이면 conversation_search. 없는 걸 있다고 지어내지 않아요.',
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
      ...(f.from ? [`   어디서: ${f.from}`] : []),
      ...(f.answered ? [`   사용자 답: ${f.answered === 'yes' ? '맡김' : '넘김'}`] : []),
    ].join('\n')
  })
  return [
    `피드에서 ${scope}: 맞는 것 ${pool.length}개 (${byKind}). ${opts.before ? '이어서 ' : '최근 것부터 '}${page.items.length}개.`,
    '',
    ...lines,
    '',
    page.next ? `더 있어요: 이어서 보려면 같은 조건에 before: "${page.next}"` : '여기까지예요(더 없음).',
    '다음: 사용자에게 보여 줄 땐 많으면 show_list로 붙이고 답 글은 요약만. 위에 있는 것만 말해요.',
  ].join('\n')
}

/** 한 줄 미리보기: 마크다운 기호와 줄바꿈을 뺀다 */
function plainLine(text: string, max: number): string {
  const t = text
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 먼저 챙기기: 피드 대화에서 두리에게 보내는 부탁.
 * 연결한 서비스만, 확인한 새 소식만, 한 번에 3개까지, 이미 알린 건 빼고, 없으면 조용히.
 */
export function watchPrompt(services: ConnectionItem[], recent: FeedItem[], now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600_000)
  const when = `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일 ${['일', '월', '화', '수', '목', '금', '토'][kst.getUTCDay()]}요일 ${kst.getUTCHours()}시`
  const list = services
    .map((c) => {
      const look = c.card.abilities.filter((a) => a.tier === '찾아보기').map((a) => a.title)
      return `- ${c.card.name}(${c.card.id})${look.length ? `: ${look.join(', ')}` : ''}`
    })
    .join('\n')
  const told = recent.length
    ? recent.map((f) => `- ${f.title}${f.key ? ` [${f.key}]` : ''}`).join('\n')
    : '- (아직 없음)'
  return [
    `먼저 챙기기 시간이에요 (지금 ${when}, 한국 시간). 사용자는 아무것도 부탁하지 않았어요. 비서처럼 먼저 살펴봐 주세요.`,
    '',
    '연결한 서비스 (이것만 열어 봐요):',
    list,
    '',
    '할 일:',
    '1. 위 서비스에서 사용자가 지금 알면 좋을 새 소식을 확인해요. 예: 배송·도착 예정, 다가오는 예약·일정, 답이 필요한 메일, 기록·결과 발표, 결제·만료·마감 예정. 기억해 둔 기념일·약속이 가까우면 그것도요.',
    '2. 직접 확인한 것만 feed_tell로 하나씩 올려요 (중요한 것부터 3개까지). title은 두리 말투 한 줄, from은 어디서 봤는지, key는 같은 일을 또 알리지 않을 열쇠.',
    '3. 두리가 이어서 해 줄 수 있으면 ask에 부탁을 적어요 (예: 선물 고르기, 답장 초안, 예약 다시 확인). 돈 내기·보내기·지우기는 지금 하지 않아요.',
    '4. 알릴 게 없으면 아무것도 올리지 않아요. 로그인이 풀렸으면 로그인하지 말고 넘어가요. 사람이 해야 하는 단계가 나와도 멈추고 넘어가요.',
    '5. 답은 한 문장으로만 (예: "2개 알렸어요", "새 소식 없어요").',
    '',
    '최근에 이미 알린 것 (다시 올리지 않아요):',
    told,
  ].join('\n')
}
