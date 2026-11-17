// 두리의 생활 기록: 목표(알아서 하는 일·반복), 보관함(남겨 둔 결과), 기억(사용자에 대해 알게 된 것), 피드(한 일·알림).
// 모두 이 PC의 저장소(설정 표)에만 둔다. AI는 도구(life_*)로 만들고, 폰·PC 화면은 같은 목록을 본다.
import { randomUUID } from 'node:crypto'
import {
  type FeedItem,
  GOAL_CATEGORIES,
  type GoalCategory,
  type Identity,
  type LibraryItem,
  type LifeAction,
  type LifeState,
  type MemoryItem,
  type Routine,
  type RoutineSchedule,
  type SuggestedIdea,
} from '@dool2/protocol'
import type { ConnectionItem } from '@dool2/protocol/connect'
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
        title: `${r.category ? '목표를 세웠어요' : '예약했어요'}: ${r.title}`,
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
    if (this.ideasDue() && !this.ideasBusy && (this.memory().length || this.routines().length))
      this.refreshIdeas()
    if (this.watchOn() && !this.watchBusy && this.watchSources?.().length && this.watchDue()) this.watchNow()
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

  state(): LifeState {
    const feedPrompt = this.feedPrompt()
    const identity = this.identity()
    const ideas = this.ideas()
    const ideasAt = this.kv.getSetting('ideasAt')
    const watchAt = this.kv.getSetting('watchAt')
    return {
      ...(ideas.length ? { ideas } : {}),
      ...(typeof ideasAt === 'string' ? { ideasAt } : {}),
      ...(this.ideasBusy ? { ideasBusy: true } : {}),
      ...(Object.keys(identity).length ? { identity } : {}),
      routines: this.routines(),
      library: this.library(),
      memory: this.memory(),
      feed: this.feedItems().slice(0, 100),
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
            `${category ? '목표를' : '예약을'} 만들었어요: "${r.title}"${r.schedule ? ` (${scheduleLabel(r.schedule)})` : ''} [id ${r.id.slice(0, 8)}]. 사용자에게 무엇을 언제 할지 한두 문장으로 다시 확인해 주세요.`,
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
