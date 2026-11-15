// 피드 · 아이디어 · 목표 · 보관함 화면과 두리 판의 예정 · 기억 · 활동 (GET /api/life, POST /api/life/action)
// 문구·아이콘·빈 상태는 폰 앱(apps/phone/src/life-views.ts)과 같게 둔다. PC는 넓은 화면에 맞춰 배치만 다르다.
import type { FeedItem, GoalCategory, LibraryItem, LifeAction, LifeState, Routine } from '@dool2/protocol'
import type { ConnectionItem } from '@dool2/protocol/connect'
import { button, doori, el, emptyState, type IconName, icon, setRich, tile, toggle, withLogo } from './dom.js'
import {
  type IdeaGroup,
  type IdeaItem,
  type IdeaSection,
  ideaCatalog,
  ideaCount,
  needsConnect,
  searchIdeas,
} from './ideas.js'
import {
  continueText,
  FEED_KIND,
  GOAL_CATEGORY_LIST,
  GOAL_META,
  goalStarter,
  groupByDay,
  hostOf,
  isFeedRoutine,
  LIBRARY_KIND,
  type LibraryTab,
  libraryTab,
  plain,
  planProgress,
  ROUTINE_EXAMPLES,
  routineWhen,
  sortRoutines,
  timeLabel,
  upcoming,
  whenLabel,
} from './life-model.js'
import { scheduleLabel } from './schedule.js'

export interface LifeCtx {
  life(): LifeState
  /** 연결한 서비스 (맞춤 아이디어) */
  services(): ConnectionItem[]
  /** 동작을 본체에 보내고, 돌아온 상태로 화면을 다시 그린다 */
  act(a: LifeAction): Promise<void>
  /** 바로 대화로 보낸다 */
  send(text: string): void
  /** 대화 입력칸에 넣고 대화로 간다 */
  compose(text: string): void
  openGoal(id: string): void
  openView(view: 'feed' | 'ideas' | 'goals' | 'library' | 'connect'): void
  /** 서비스 연결 화면 (아이디·비밀번호 넣는 곳) */
  openService(id: string): void
  toast(text: string): void
  /** 피드 맨 위: 나를 기다리는 승인·로그인, 지금 하는 일 */
  waiting(): HTMLElement[]
  /** 두리 판 활동 맨 위: 지금 하는 일 */
  working(): HTMLElement | undefined
}

export const emptyLife = (): LifeState => ({ routines: [], library: [], memory: [], feed: [] })

const when = (r: Routine, now?: Date) => routineWhen(r, scheduleLabel, now)

function pageHead(title: string, sub?: string, ...extra: HTMLElement[]) {
  return el('header', 'page-head', el('h1', 'title', title), sub ? el('p', 'cap', sub) : undefined, ...extra)
}

function section(title: string, ...children: (Node | false | undefined)[]) {
  return el('section', 'page-sec', el('h2', 'over', title), ...children)
}

/** 두 번 눌러야 지운다 (실수 방지) */
function confirmButton(
  cls: string,
  label: (Node | string)[],
  ask: string,
  onConfirm: () => void,
): HTMLButtonElement {
  let armed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const b = button(cls, (e) => {
    e.stopPropagation()
    if (armed) {
      clearTimeout(timer)
      onConfirm()
      return
    }
    armed = true
    b.classList.add('armed')
    b.replaceChildren(ask)
    timer = setTimeout(() => {
      armed = false
      b.classList.remove('armed')
      b.replaceChildren(...label)
    }, 3000)
  })
  b.append(...label)
  return b
}

/** 날짜만: "어제", "11월 14일 (금)" (오늘이면 시각) */
const shortWhen = (iso: string) => {
  const w = whenLabel(iso)
  return w.startsWith('오늘') ? timeLabel(iso) : w.replace(/ 오[전후] .*$/, '')
}

// ── 피드 ─────────────────────────────────────────────

export function feedView(ctx: LifeCtx): HTMLElement {
  const life = ctx.life()
  const prompt = life.feedPrompt
  const input = el('input', 'field grow')
  input.placeholder = prompt ? '바꿀 내용을 적어 주세요' : '예: 매일 아침 날씨·일정·오는 택배'
  input.setAttribute('aria-label', '받고 싶은 소식')
  const save = el('button', 'btn sm', prompt ? '바꾸기' : '받기')
  save.type = 'submit'
  const form = el('form', 'feed-form', input, save)
  form.onsubmit = (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    save.disabled = true
    void ctx
      .act({ action: 'feed-prompt', text })
      .then(() => ctx.toast('매일 오전 7:30에 찾아서 올려 드릴게요'))
  }
  const askCard = el(
    'div',
    'card feed-prompt',
    el('div', 'card-label', doori('', 22), '어떤 소식을 받을까요?'),
    prompt
      ? el('p', 'feed-prompt-now', el('strong', '', prompt), el('span', 'meta', ' · 매일 오전 7:30에 올려요'))
      : el('p', 'cap', '적어 두면 두리가 매일 아침 찾아서 짧게 정리해 올려요.'),
    el(
      'div',
      'feed-prompt-row',
      form,
      prompt
        ? button(
            'btn-text sm',
            () =>
              void ctx.act({ action: 'feed-prompt', text: '' }).then(() => ctx.toast('소식 받기를 멈췄어요')),
            '그만 받기',
          )
        : undefined,
    ),
  )

  const body: HTMLElement[] = []
  const waiting = ctx.waiting()
  if (waiting.length) body.push(el('div', 'feed-waiting', ...waiting))
  if (!life.feed.length)
    body.push(
      emptyState(
        'sleeping',
        '아직 올라온 소식이 없어요',
        '두리가 한 일과 알아서 한 일, 받기로 한 소식이 여기에 모여요.',
      ),
    )
  for (const g of groupByDay(life.feed)) {
    const ul = el('ul', 'feed-list')
    for (const f of g.items) ul.append(feedItem(ctx, f))
    body.push(el('section', 'feed-day', el('h2', 'over', g.day), ul))
  }
  return el(
    'div',
    'page page-narrow',
    pageHead('피드', '두리가 한 일과 먼저 알려 드릴 것을 모아 둬요'),
    askCard,
    ...body,
  )
}

function feedItem(ctx: LifeCtx, f: FeedItem): HTMLElement {
  const k = FEED_KIND[f.kind] ?? FEED_KIND.post
  // 두리 소식·알아서 한 일은 긴 글이라 접어 두고 누르면 펼친다
  const long = f.kind === 'post' || f.kind === 'routine'
  let text: HTMLElement | undefined
  if (f.body) {
    if (long) {
      text = el('div', 'feed-text rich clamp')
      setRich(text, f.body)
      const t = text
      t.title = '눌러서 펼치기'
      t.onclick = () => t.classList.toggle('open')
    } else text = el('p', 'feed-text', plain(f.body, 160))
  }
  const react = (r: 'up' | 'down') => () =>
    void ctx.act({ action: 'feed-react', id: f.id, ...(f.reaction === r ? {} : { reaction: r }) })
  const chip = (name: IconName, label: string, on: boolean, onClick: () => void) => {
    const b = button(on ? 'chip quiet on' : 'chip quiet', onClick, icon(name))
    b.setAttribute('aria-label', label)
    b.setAttribute('aria-pressed', String(on))
    b.title = label
    return b
  }
  const actions = el(
    'div',
    'feed-actions',
    chip('up', '좋아요', f.reaction === 'up', react('up')),
    chip('down', '별로예요', f.reaction === 'down', react('down')),
    button('chip quiet', () => ctx.compose(continueText(f)), icon('reply'), '이어서 말하기'),
  )
  // 결과가 흩어지지 않게: 목표·보관함에서 나온 글이면 그리로
  const goal = f.ref ? ctx.life().routines.find((r) => r.id === f.ref) : undefined
  if (goal && !isFeedRoutine(goal))
    actions.append(button('btn-text sm', () => ctx.openGoal(goal.id), '목표 보기', icon('chevron')))
  else if (f.kind === 'saved')
    actions.append(button('btn-text sm', () => ctx.openView('library'), '보관함 보기', icon('chevron')))
  return el(
    'li',
    'feed-item',
    tile(k.icon, k.tone),
    el(
      'div',
      'grow',
      el('p', 'feed-head meta', el('span', '', k.label), el('span', '', timeLabel(f.at))),
      el('p', 'feed-title', plain(f.title, 120)),
      text,
      actions,
    ),
  )
}

// ── 아이디어 ─────────────────────────────────────────

/** 두리가 먼저 찾은 할 일 (기억·목표·연결 기반, 매일 아침 새로) */
function suggestedBox(ctx: LifeCtx) {
  const life = ctx.life()
  const ideas = life.ideas ?? []
  const refresh = button(
    'btn-ghost sm',
    () => void ctx.act({ action: 'ideas-refresh' }),
    life.ideasBusy ? '찾는 중…' : ideas.length ? '새로 찾기' : '찾아 줘',
  )
  refresh.disabled = Boolean(life.ideasBusy)
  return el(
    'section',
    'card suggested',
    el(
      'div',
      'suggested-head',
      doori(life.ideasBusy ? 'thinking' : '', 28),
      el(
        'div',
        'grow',
        el('p', 'row-t', '두리가 찾은 할 일'),
        el('p', 'cap', '기억과 목표, 연결한 곳을 보고 매일 아침 새로 찾아요'),
      ),
      refresh,
    ),
    ...ideas.map((i) =>
      button(
        'idea-row',
        () => ctx.send(i.text),
        tile('idea', 'amber'),
        el('span', 'grow', el('span', 'idea-t', i.text), el('span', 'cap', i.why)),
        icon('send', 'i idea-go'),
      ),
    ),
  )
}

/** 아이디어 탭에서 고른 분류와 찾는 말 (탭을 오가도 남는다) */
const ideaPick = { cat: 'all', query: '' }

function ideaRow(ctx: LifeCtx, it: IdeaItem, sec: IdeaSection) {
  const later = needsConnect(it)
  return button(
    'idea-row',
    () => {
      if (later && it.service) {
        ctx.toast(`${it.service.name}을(를) 연결하면 바로 맡길 수 있어요`)
        ctx.openService(it.service.id)
      } else ctx.send(it.ask)
    },
    it.service ? withLogo(el('span', 'svc-mark', it.service.mark), it.service.id) : tile(sec.icon, sec.tone),
    el('span', 'grow', el('span', 'idea-t', it.text), el('span', 'cap', it.note)),
    later ? el('span', 'idea-tag', '연결') : icon('send', 'i idea-go'),
  )
}

function ideaCatalogBox(ctx: LifeCtx, groups: IdeaGroup[]): HTMLElement {
  const box = el('div', 'idea-catalog')
  const search = el('input', 'field idea-search')
  search.type = 'search'
  search.placeholder = '아이디어 찾기 (택배, 항공권, 영수증…)'
  search.value = ideaPick.query
  const chips = el('div', 'chips idea-cats')
  const body = el('div', 'idea-body')
  const list = (items: { section: IdeaSection; item: IdeaItem }[]) =>
    el('div', 'idea-list', ...items.map((x) => ideaRow(ctx, x.item, x.section)))
  const draw = () => {
    const cat = groups.some((g) => g.section.id === ideaPick.cat) ? ideaPick.cat : 'all'
    const q = ideaPick.query.trim()
    const chip = (id: string, label: string) => {
      const c = button(
        `chip quiet${cat === id && !q ? ' on' : ''}`,
        () => {
          ideaPick.cat = id
          ideaPick.query = ''
          search.value = ''
          draw()
        },
        label,
      )
      return c
    }
    chips.replaceChildren(chip('all', '전체'), ...groups.map((g) => chip(g.section.id, g.section.label)))
    body.replaceChildren()
    if (q) {
      const found = searchIdeas(groups, q)
      if (found.length) body.append(list(found))
      body.append(
        el(
          'div',
          'idea-list idea-raw',
          button(
            'idea-row',
            () => ctx.send(q),
            tile('send', ''),
            el(
              'span',
              'grow',
              el('span', 'idea-t', `"${q}" 그대로 부탁하기`),
              el(
                'span',
                'cap',
                found.length
                  ? '찾는 게 없으면 그냥 말해 보세요'
                  : '맞는 아이디어가 없어요. 그래도 두리가 해 볼게요',
              ),
            ),
          ),
        ),
      )
      return
    }
    if (cat === 'all') {
      for (const g of groups) {
        const sec = g.section
        body.append(
          el(
            'section',
            'page-sec idea-sec',
            button(
              'idea-sec-head',
              () => {
                ideaPick.cat = sec.id
                draw()
                chips.scrollIntoView({ block: 'start', behavior: 'smooth' })
              },
              tile(sec.icon, sec.tone, 28),
              el('strong', '', sec.label),
              el('span', 'cap', `${g.items.length}가지 모두 보기`),
              icon('chevron', 'i'),
            ),
            list(g.items.slice(0, 4).map((item) => ({ section: sec, item }))),
          ),
        )
      }
      return
    }
    const g = groups.find((x) => x.section.id === cat)
    if (!g) return
    const ready = g.items.filter((i) => !needsConnect(i))
    const later = g.items.filter(needsConnect)
    if (ready.length)
      body.append(section('바로 할 수 있어요', list(ready.map((item) => ({ section: g.section, item })))))
    if (later.length)
      body.append(
        section(
          '연결하면 할 수 있어요',
          el('p', 'cap idea-later', '아이디·비밀번호를 한 번 넣어 두면 그다음부터는 말로만 맡기면 돼요'),
          list(later.map((item) => ({ section: g.section, item }))),
        ),
      )
  }
  search.oninput = () => {
    ideaPick.query = search.value
    draw()
  }
  draw()
  box.append(search, chips, body)
  return box
}

export function ideasView(ctx: LifeCtx): HTMLElement {
  const groups = ideaCatalog(ctx.services())
  return el(
    'div',
    'page',
    pageHead('아이디어', `누르면 두리가 바로 시작해요 · ${ideaCount(groups)}가지`),
    suggestedBox(ctx),
    ideaCatalogBox(ctx, groups),
    el(
      'div',
      'card ask idea-human',
      el('div', 'card-label', doori('asking', 22), '이건 직접 해 주셔야 해요'),
      el('p', 'cap', '본인인증, 보안 문자, 공동인증서. 대신 그 화면을 바로 띄워 드릴게요.'),
    ),
  )
}

// ── 목표 ─────────────────────────────────────────────

function routineTile(r: Routine) {
  if (r.category) {
    const m = GOAL_META[r.category]
    return tile(m.icon, m.tone)
  }
  return tile('clock', 'violet')
}

function progressBar(done: number, total: number) {
  const fill = el('i')
  fill.style.width = `${Math.round((done / total) * 100)}%`
  return el('span', 'progress-line', fill)
}

function goalRow(ctx: LifeCtx, r: Routine) {
  const p = planProgress(r)
  const row = button(
    `goal-row${r.enabled ? '' : ' off'}`,
    () => ctx.openGoal(r.id),
    routineTile(r),
    el(
      'span',
      'grow',
      el('span', 'row-t', r.title),
      el('span', 'row-d', [r.category, when(r)].filter(Boolean).join(' · ')),
      p
        ? el(
            'span',
            'goal-progress',
            progressBar(p.done, p.total),
            el('span', 'meta', `계획 ${p.done}/${p.total}`),
          )
        : undefined,
      r.lastResult ? el('span', 'meta goal-last', `지난번: ${plain(r.lastResult, 90)}`) : undefined,
    ),
  )
  row.append(
    toggle(
      r.enabled,
      r.enabled ? '끄기' : '켜기',
      (on) => void ctx.act({ action: 'routine-toggle', id: r.id, on }),
    ),
  )
  return row
}

export function goalsView(ctx: LifeCtx): HTMLElement {
  const list = sortRoutines(ctx.life().routines.filter((r) => !isFeedRoutine(r)))
  const goals = list.filter((r) => r.category)
  const routines = list.filter((r) => !r.category)
  const create = GOAL_CATEGORY_LIST.map((c: GoalCategory) => {
    const m = GOAL_META[c]
    return button(
      'goal-new',
      () => ctx.compose(goalStarter(c)),
      tile(m.icon, m.tone),
      el('span', 'grow', el('span', 'row-t', c), el('span', 'cap', m.hint)),
      icon('plus', 'i md goal-plus'),
    )
  })
  return el(
    'div',
    'page',
    pageHead('목표', '두리가 알아서 챙기고, 때가 되면 먼저 알려 줘요'),
    goals.length
      ? section('진행 중인 목표', el('div', 'goal-list', ...goals.map((r) => goalRow(ctx, r))))
      : undefined,
    routines.length
      ? section('알아서 하는 일', el('div', 'goal-list', ...routines.map((r) => goalRow(ctx, r))))
      : undefined,
    list.length
      ? undefined
      : el(
          'div',
          'card goal-hint',
          el('div', 'card-label', doori('', 22), '대화로 말하면 돼요'),
          el(
            'p',
            '',
            '"매일 아침 7시 반에 날씨랑 일정 알려 줘", "주 3회 운동하고 싶어"처럼 말하면 두리가 목표와 일정을 만들어요.',
          ),
        ),
    section('목표 만들기', el('div', 'goal-grid', ...create)),
    section(
      '이런 것도 맡겨 보세요',
      el(
        'div',
        'idea-list',
        ...ROUTINE_EXAMPLES.map(([text, note]) =>
          button(
            'idea-row',
            () => ctx.send(text),
            tile('clock', 'violet'),
            el('span', 'grow', el('span', 'idea-t', text), el('span', 'cap', note)),
            icon('send', 'i idea-go'),
          ),
        ),
      ),
    ),
  )
}

export function goalDetail(ctx: LifeCtx, id: string, back: () => void): HTMLElement {
  const r = ctx.life().routines.find((x) => x.id === id)
  const backBtn = button('btn-text back-btn', back, icon('back'), '목표')
  if (!r)
    return el(
      'div',
      'page',
      backBtn,
      emptyState('', '이 목표는 지워졌어요', '목표 목록에서 다른 목표를 골라 주세요.'),
    )
  const p = planProgress(r)
  const now = new Date()
  const facts = el('dl', 'kv goal-facts')
  const fact = (k: string, v?: string) => {
    if (v) facts.append(el('dt', '', k), el('dd', '', v))
  }
  fact('언제', r.schedule ? scheduleLabel(r.schedule) : '정한 때 없음')
  fact('다음 체크인', r.enabled ? (r.nextRunAt ? whenLabel(r.nextRunAt, now) : undefined) : '꺼 둠')
  fact('지난번', r.lastRunAt ? whenLabel(r.lastRunAt, now) : undefined)
  fact('결과는', r.target === 'feed' ? '피드에 올려요' : '대화로 알려 드려요')

  const actions = el(
    'div',
    'goal-actions',
    button(
      'btn sm',
      () =>
        void ctx
          .act({ action: 'routine-run', id: r.id })
          .then(() => ctx.toast('지금 시작했어요. 끝나면 알려 드릴게요.')),
      icon('play'),
      r.category ? '지금 체크인' : '지금 해 보기',
    ),
    button(
      'btn-ghost sm',
      () => ctx.compose(`"${r.title}" 목표 말인데요, `),
      icon('reply'),
      '대화에서 이어 하기',
    ),
    el('span', 'grow'),
    button(
      'btn-text sm',
      () => void ctx.act({ action: 'routine-toggle', id: r.id, on: !r.enabled }),
      r.enabled ? '잠시 끄기' : '다시 켜기',
    ),
    confirmButton('btn-text sm danger', [icon('trash'), '지우기'], '한 번 더 누르면 지워요', () => {
      void ctx.act({ action: 'routine-delete', id: r.id }).then(() => {
        ctx.toast('목표를 지웠어요')
        back()
      })
    }),
  )

  const plan = r.plan?.length
    ? el(
        'ul',
        'plan',
        ...r.plan.map((step, index) => {
          const b = button(
            `plan-step${step.done ? ' done' : ''}`,
            () => void ctx.act({ action: 'goal-step', id: r.id, index, done: !step.done }),
            el('span', 'plan-box', step.done ? icon('check') : undefined),
            el('span', 'grow', step.text),
          )
          b.setAttribute('role', 'checkbox')
          b.setAttribute('aria-checked', String(step.done))
          return el('li', '', b)
        }),
      )
    : el('p', 'cap', '아직 계획이 없어요. 대화에서 "계획 세워 줘"라고 하면 두리가 단계를 나눠 둘게요.')

  const log = [...(r.log ?? [])].sort((a, b) => b.at.localeCompare(a.at))
  return el(
    'div',
    'page page-narrow goal-detail',
    backBtn,
    el(
      'header',
      'goal-head',
      routineTile(r),
      el(
        'div',
        'grow',
        el('h1', 'title-2', r.title),
        el('p', 'cap', [r.category ?? '알아서 하는 일', when(r, now)].join(' · ')),
      ),
    ),
    actions,
    facts,
    section(p ? `계획 ${p.done}/${p.total}` : '계획', p ? progressBar(p.done, p.total) : undefined, plan),
    section('두리가 할 일', el('p', 'goal-prompt', r.prompt)),
    log.length
      ? section(
          '진행 기록',
          el(
            'ul',
            'goal-log',
            ...log
              .slice(0, 20)
              .map((l) =>
                el('li', '', el('time', 'meta', whenLabel(l.at, now)), el('span', '', plain(l.text, 300))),
              ),
          ),
        )
      : r.lastResult
        ? section('지난 결과', el('p', 'goal-result', plain(r.lastResult, 600)))
        : section('진행 기록', el('p', 'cap', '체크인하면 여기에 날짜별로 남아요.')),
  )
}

// ── 보관함 ───────────────────────────────────────────

export function libraryView(ctx: LifeCtx, tab: LibraryTab, setTab: (t: LibraryTab) => void): HTMLElement {
  const all = ctx.life().library
  const made = libraryTab(all, 'made')
  const files = libraryTab(all, 'files')
  const seg = el('div', 'seg')
  for (const [id, label, n] of [
    ['made', '만든 것', made.length],
    ['files', '사진·파일', files.length],
  ] as const) {
    const b = button('', () => setTab(id), label, n ? el('span', 'seg-n', String(n)) : undefined)
    b.setAttribute('aria-pressed', String(tab === id))
    seg.append(b)
  }
  const items = tab === 'made' ? made : files
  const body = items.length
    ? el('div', 'lib-grid', ...items.map((it) => libraryCard(ctx, it)))
    : tab === 'made'
      ? emptyState(
          '',
          '아직 남긴 게 없어요',
          '두리가 찾아 준 상품, 정리한 글, 링크를 남겨 두면 여기에 모여요. 답 아래의 [보관함에 남기기]로도 남길 수 있어요.',
        )
      : emptyState('', '아직 사진·파일이 없어요', '두리가 만든 파일과 받은 사진이 여기에 모여요.')
  return el('div', 'page', pageHead('보관함', '두리가 찾아 주거나 만든 것 중 남겨 둔 것', seg), body)
}

function libraryCard(ctx: LifeCtx, it: LibraryItem): HTMLElement {
  const k = LIBRARY_KIND[it.kind] ?? LIBRARY_KIND.note
  const host = hostOf(it.url)
  const actions = el('div', 'lib-actions')
  if (it.url?.startsWith('https://')) {
    const a = el('a', 'btn-text sm', icon('link'), '열기')
    a.href = it.url
    a.target = '_blank'
    a.rel = 'noopener'
    actions.append(a)
  }
  actions.append(
    button(
      'btn-text sm',
      () => ctx.compose(`보관함의 "${plain(it.title, 40)}" 말인데요, `),
      icon('reply'),
      '이어서 말하기',
    ),
    el('span', 'grow'),
    confirmButton('icon-btn lib-del', [icon('trash')], '지울까요?', () => {
      void ctx.act({ action: 'library-delete', id: it.id }).then(() => ctx.toast('보관함에서 지웠어요'))
    }),
  )
  let text: HTMLElement | undefined
  if (it.body) {
    text = el('div', 'lib-text rich clamp')
    setRich(text, it.body)
    const t = text
    t.onclick = () => t.classList.toggle('open')
  }
  return el(
    'article',
    'card lib-card',
    el(
      'div',
      'lib-top',
      tile(k.icon, k.tone),
      el('span', 'meta grow', [k.label, host].filter(Boolean).join(' · ')),
      el('time', 'meta', shortWhen(it.savedAt)),
    ),
    el('p', 'lib-title', plain(it.title, 80)),
    it.price ? el('p', 'lib-price', it.price) : undefined,
    text,
    actions,
  )
}

// ── 두리 판: 예정 · 기억 · 활동 ───────────────────────

const sideEmpty = (text: string) => el('p', 'cap side-empty', text)

export function scheduleTab(ctx: LifeCtx): HTMLElement {
  const list = upcoming(ctx.life().routines)
  if (!list.length) return sideEmpty('예정된 일이 없어요. "내일 10시에 알려 줘"처럼 말하면 여기에 보여요.')
  const now = new Date()
  return el(
    'div',
    'side-list',
    ...list.map((r) =>
      button(
        'side-row',
        () => ctx.openGoal(r.id),
        tile('clock', 'violet', 36),
        el(
          'span',
          'grow',
          el('span', 'side-t', r.title),
          el('span', 'meta', r.schedule ? scheduleLabel(r.schedule) : ''),
        ),
        el('span', 'side-when meta', whenLabel(r.nextRunAt ?? '', now)),
      ),
    ),
  )
}

/** 두리 설정: 나를 부르는 이름 · 말투 · 답 길이 */
function identityBlock(ctx: LifeCtx): HTMLElement {
  const id = ctx.life().identity ?? {}
  const name = el('input', 'field grow')
  name.placeholder = '예: 민지 (비우면 호칭 없이)'
  name.setAttribute('aria-label', '나를 부르는 이름')
  name.value = id.userName ?? ''
  const save = el('button', 'btn sm', '저장')
  save.type = 'submit'
  const form = el('form', 'feed-form', name, save)
  form.onsubmit = (e) => {
    e.preventDefault()
    void ctx.act({ action: 'identity', userName: name.value }).then(() => ctx.toast('이제 그렇게 부를게요'))
  }
  const seg = <T extends string>(cur: T, opts: [T, string][], pick: (v: T) => void) => {
    const box = el('div', 'seg')
    for (const [v, label] of opts) {
      const b = el('button', '', label)
      b.type = 'button'
      b.setAttribute('aria-pressed', String(cur === v))
      b.onclick = () => pick(v)
      box.append(b)
    }
    return box
  }
  return el(
    'div',
    'identity',
    el('p', 'over', '나를 부르는 이름'),
    form,
    el('p', 'over', '말투'),
    seg(
      id.tone ?? 'warm',
      [
        ['warm', '다정하게'],
        ['neat', '깔끔하게'],
        ['buddy', '친구처럼'],
      ],
      (tone) => void ctx.act({ action: 'identity', tone }),
    ),
    el('p', 'over', '답 길이'),
    seg(
      id.length ?? 'normal',
      [
        ['short', '짧게'],
        ['normal', '보통'],
        ['detail', '자세히'],
      ],
      (length) => void ctx.act({ action: 'identity', length }),
    ),
    el('p', 'over', '기억'),
  )
}

export function memoryTab(ctx: LifeCtx): HTMLElement {
  const input = el('input', 'field grow')
  input.placeholder = '예: 아이가 초3이에요'
  input.setAttribute('aria-label', '두리가 알아 두면 좋은 것')
  const add = el('button', 'btn sm', '기억하기')
  add.type = 'submit'
  const form = el('form', 'feed-form', input, add)
  form.onsubmit = (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    add.disabled = true
    input.blur()
    void ctx.act({ action: 'memory-add', text }).then(() => ctx.toast('기억해 둘게요'))
  }
  const items = [...ctx.life().memory].sort((a, b) => b.at.localeCompare(a.at))
  return el(
    'div',
    'memory',
    identityBlock(ctx),
    el(
      'p',
      'cap',
      '두리가 대화하며 알게 된 것이에요. 틀린 건 지우면 다음 대화부터 잊어요. 이 PC에만 저장돼요.',
    ),
    form,
    items.length
      ? el(
          'div',
          'side-list',
          ...items.map((m) => {
            const forget = confirmButton('icon-btn', [icon('trash')], '잊을까요?', () => {
              void ctx.act({ action: 'memory-delete', id: m.id }).then(() => ctx.toast('잊었어요'))
            })
            forget.setAttribute('aria-label', '잊기')
            forget.title = '잊기'
            return el(
              'div',
              'side-row',
              tile('brain', 'mint', 36),
              el(
                'span',
                'grow',
                el('span', 'side-t', m.text),
                el('span', 'meta', `${m.source === 'user' ? '직접 적음' : '대화에서'} · ${shortWhen(m.at)}`),
              ),
              forget,
            )
          }),
        )
      : sideEmpty('아직 기억한 게 없어요.'),
  )
}

export function activityTab(ctx: LifeCtx): HTMLElement {
  const done = ctx.life().feed.filter((f) => f.kind === 'done' || f.kind === 'routine')
  const working = ctx.working()
  if (!done.length && !working) return sideEmpty('아직 한 일이 없어요')
  return el(
    'div',
    'activity',
    working,
    ...groupByDay(done)
      .slice(0, 14)
      .map((g) =>
        el(
          'section',
          '',
          el('h3', 'over', g.day),
          el(
            'div',
            'side-list',
            ...g.items.map((f) =>
              el(
                'div',
                'side-row',
                tile(f.kind === 'done' ? 'check' : 'clock', f.kind === 'done' ? 'blue' : 'violet', 36),
                el(
                  'span',
                  'grow',
                  el('span', 'side-t', plain(f.title, 80)),
                  f.body ? el('span', 'meta clamp-2', plain(f.body, 120)) : undefined,
                ),
                el('span', 'side-when meta', timeLabel(f.at)),
              ),
            ),
          ),
        ),
      ),
  )
}
