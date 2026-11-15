// 두리의 생활 기록: 목표(알아서 하는 일·반복), 보관함(남겨 둔 결과), 기억(사용자에 대해 알게 된 것), 피드(한 일·알림).
// 모두 이 PC의 저장소(설정 표)에만 둔다. AI는 도구(life_*)로 만들고, 폰·PC 화면은 같은 목록을 본다.
import { randomUUID } from 'node:crypto'
import {
  type FeedItem,
  GOAL_CATEGORIES,
  type GoalCategory,
  type LibraryItem,
  type LifeAction,
  type LifeState,
  type MemoryItem,
  type Routine,
  type RoutineSchedule,
} from '@dool2/protocol'
import { nextRun, scheduleLabel } from '@dool2/protocol/schedule'

export { nextRun, scheduleLabel }

export interface Kv {
  getSetting(key: string): unknown
  setSetting(key: string, value: unknown): void
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const bad = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

const LIMIT = { routines: 50, library: 500, memory: 200, feed: 300 }
export class Life {
  /** 바뀌면 (폰·PC에 다시 보내기) */
  onChange?: () => void
  /** 예약한 일을 할 때 (대화로 보내 두리가 한다) */
  onDue?: (r: Routine) => void

  constructor(
    private readonly kv: Kv,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private list<T>(key: string): T[] {
    const v = this.kv.getSetting(key)
    return Array.isArray(v) ? (v as T[]) : []
  }
  private put<T>(key: keyof typeof LIMIT, items: T[]) {
    this.kv.setSetting(key, items.slice(0, LIMIT[key]))
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
    }
    this.put('routines', [r, ...this.routines()])
    // 피드 지시로 만든 일은 피드에 따로 알리지 않는다
    if (r.target !== 'feed')
      this.feed({
        kind: 'goal',
        title: `${r.category ? '목표를 세웠어요' : '알아서 할 일을 정했어요'}: ${r.title}`,
        ...(r.schedule ? { body: scheduleLabel(r.schedule) } : {}),
        ref: r.id,
      })
    return r
  }
  /** 목표 고치기: 계획 단계·진행 기록 */
  updateGoal(id: string, patch: { plan?: string[]; done?: number[]; log?: string; title?: string }) {
    const list = this.routines()
    const r = list.find((x) => x.id === id || x.id.startsWith(id))
    if (!r) return undefined
    if (patch.title) r.title = patch.title.slice(0, 60)
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
    const now = this.now()
    const list = this.routines()
    const due = list.filter((r) => r.enabled && r.nextRunAt && Date.parse(r.nextRunAt) <= now.getTime())
    if (!due.length) return []
    for (const r of due) {
      r.lastRunAt = now.toISOString()
      const next = r.schedule ? nextRun(r.schedule, now) : undefined
      if (next) r.nextRunAt = next.toISOString()
      else {
        delete r.nextRunAt
        r.enabled = false
      }
    }
    this.put('routines', list)
    for (const r of due) this.onDue?.(r)
    return due
  }
  /** 바로 한 번 해 보기 */
  runNow(id: string) {
    const r = this.routines().find((x) => x.id === id)
    if (r) this.onDue?.(r)
    return r
  }
  noteRun(id: string, result: string) {
    const list = this.routines()
    const r = list.find((x) => x.id === id)
    if (!r) return
    r.lastResult = result.slice(0, 300)
    if (r.category)
      r.log = [{ at: this.now().toISOString(), text: result.slice(0, 300) }, ...(r.log ?? [])].slice(0, 50)
    this.put('routines', list)
    if (r.target === 'feed') {
      // 답 첫 줄이 제목, 나머지가 글
      const lines = result.trim().split('\n')
      const head = (lines[0] ?? '').replace(/^#+\s*|\*\*/g, '').trim()
      const body = lines.slice(1).join('\n').trim()
      this.feed({
        kind: 'post',
        title: head.slice(0, 80) || '오늘의 소식',
        body: (body || result).slice(0, 2000),
        ref: r.id,
      })
      return
    }
    this.feed({ kind: 'routine', title: r.title, body: result.slice(0, 2000), ref: r.id })
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
    if (t)
      this.addRoutine({
        title: '피드',
        prompt: `오늘의 피드 글을 써 주세요: ${t}\n이 답이 그대로 피드에 올라가요(feed_post 도구는 쓰지 않아요). 첫 줄은 짧은 제목, 그다음 핵심 3~5줄 목록. 확인한 것만 쓰고 맨 끝에 출처 사이트 이름을 적어요. "올렸어요" 같은 말은 쓰지 않아요.`,
        schedule: { kind: 'daily', time: '07:30' },
        target: 'feed',
      })
    else this.onChange?.()
  }

  state(): LifeState {
    const feedPrompt = this.feedPrompt()
    return {
      routines: this.routines(),
      library: this.library(),
      memory: this.memory(),
      feed: this.feedItems().slice(0, 100),
      ...(feedPrompt ? { feedPrompt } : {}),
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
    }
  }

  // ── AI 도구 (life_*) ──
  run(tool: string, a: Record<string, unknown>): ToolResult {
    try {
      switch (tool) {
        case 'goal_create': {
          const schedule = a.schedule ? parseSchedule(a) : undefined
          if (a.schedule && !schedule)
            return bad('언제 할지(schedule)를 알 수 없어요. daily·weekly·once·every 중 하나로 주세요.')
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
          })
          return ok(
            `${category ? '목표' : '알아서 할 일'}을 만들었어요: "${r.title}"${r.schedule ? ` (${scheduleLabel(r.schedule)})` : ''} [id ${r.id.slice(0, 8)}]. 사용자에게 무엇을 언제 할지 한두 문장으로 다시 확인해 주세요.`,
          )
        }
        case 'goal_update': {
          const r = this.updateGoal(String(a.id ?? ''), {
            ...(Array.isArray(a.plan) ? { plan: a.plan.map(String) } : {}),
            ...(Array.isArray(a.done) ? { done: a.done.map(Number) } : {}),
            ...(a.log ? { log: String(a.log) } : {}),
            ...(a.title ? { title: String(a.title) } : {}),
          })
          if (!r) return bad('그런 목표가 없어요. goal_list로 id를 확인하세요.')
          return ok(`목표를 고쳤어요: ${r.title}`)
        }
        case 'feed_post': {
          const f = this.feed({
            kind: 'post',
            title: String(a.title ?? '').slice(0, 80) || '두리 소식',
            body: String(a.body ?? '').slice(0, 1500),
          })
          return ok(`피드에 올렸어요: ${f.title}`)
        }
        case 'goal_list': {
          const list = this.routines()
          if (!list.length) return ok('아직 목표가 없어요.')
          return ok(
            list
              .map(
                (r) =>
                  `- [${r.id.slice(0, 8)}] ${r.category ? `(${r.category}) ` : ''}${r.title} · ${r.schedule ? scheduleLabel(r.schedule) : '정한 때 없음'}${r.enabled ? '' : ' (꺼짐)'}${r.plan ? ` · 계획 ${r.plan.filter((p) => p.done).length}/${r.plan.length}` : ''}${r.lastResult ? ` · 지난 결과: ${r.lastResult.slice(0, 80)}` : ''}`,
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
          const kind = (['note', 'link', 'product', 'place', 'file'] as const).includes(a.kind as never)
            ? (a.kind as LibraryItem['kind'])
            : 'note'
          const item = this.save({
            kind,
            title: String(a.title ?? '').slice(0, 80) || '제목 없음',
            body: String(a.body ?? '').slice(0, 4000),
            ...(a.url ? { url: String(a.url).slice(0, 500) } : {}),
            ...(a.price ? { price: String(a.price).slice(0, 40) } : {}),
          })
          return ok(`보관함에 남겼어요: ${item.title}`)
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
  if (kind === 'once' && typeof a.at === 'string' && !Number.isNaN(Date.parse(a.at)))
    return { kind: 'once', at: new Date(a.at).toISOString() }
  if (kind === 'every' && Number(a.minutes) >= 15)
    return { kind: 'every', minutes: Math.round(Number(a.minutes)) }
  return undefined
}
