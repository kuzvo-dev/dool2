// Feed, Ideas, Goals and Library screens, and the assistant panel's Schedule, Memory and Activity tabs
// (GET /api/life, POST /api/life/action). Copy, icons and empty states match the phone app
// (apps/phone/src/life-views.ts). Only the layout differs, for the wide screen.
import type { FeedItem, GoalCategory, LibraryItem, LifeAction, LifeState, Routine } from '@dool2/protocol'
import type { ConnectionItem } from '@dool2/protocol/connect'
import {
  button,
  doori,
  el,
  emoTile,
  emptyState,
  type IconName,
  icon,
  setRich,
  tile,
  toggle,
  withLogo,
} from './dom.js'
import {
  type IdeaGroup,
  type IdeaItem,
  type IdeaSection,
  ideaCatalog,
  ideaCount,
  needsConnect,
  searchIdeas,
} from './ideas.js'
import { lang } from './lang.js'
import {
  continueText,
  FEED_KIND,
  GOAL_CATEGORY_LIST,
  GOAL_META,
  goalCategoryLabel,
  goalStarter,
  groupByDay,
  hostOf,
  isFeedRoutine,
  LIBRARY_KIND,
  type LibraryTab,
  libraryTab,
  plain,
  planProgress,
  routineWhen,
  shortWhen,
  sortRoutines,
  timeLabel,
  upcoming,
  whenLabel,
} from './life-model.js'
import { lifeModel, lifeText, routineExamples } from './locales/life.js'
import type { Pager } from './paging.js'
import { resultLine } from './rich.js'
import { ruleLabel, scheduleLabel, untilLabel } from './schedule.js'

export interface LifeCtx {
  life(): LifeState
  /** Long lists: what was loaded and the next page (Feed, Library tabs, panel Activity) */
  feedList(): Pager<FeedItem>
  libraryList(tab: LibraryTab): Pager<LibraryItem>
  activityList(): Pager<FeedItem>
  /** Full text of one Library item (lists only carry the start) */
  libraryFull(id: string): Promise<LibraryItem | undefined>
  /** Opens a PC file in its default app (reveal: shows it in Finder or Explorer) */
  openFile(path: string, reveal?: boolean): void
  /** Connected services (for tailored ideas) */
  services(): ConnectionItem[]
  /** Sends an action to the daemon and redraws with the state it returns */
  act(a: LifeAction): Promise<void>
  /** Sends straight to chat */
  send(text: string): void
  /** Puts text in the chat input and goes to Chat */
  compose(text: string): void
  openGoal(id: string): void
  openView(view: 'feed' | 'ideas' | 'goals' | 'library' | 'connect'): void
  /** Service connection screen (where the ID and password go) */
  openService(id: string): void
  toast(text: string): void
  /** Top of the Feed: approvals and logins waiting for me, current work */
  waiting(): HTMLElement[]
  /** Top of the panel's Activity: current work */
  working(): HTMLElement | undefined
}

export const emptyLife = (): LifeState => ({ routines: [], library: [], memory: [], feed: [] })

const when = (r: Routine, now?: Date) => routineWhen(r, scheduleLabel, now, ruleLabel)

function pageHead(title: string, sub?: string, ...extra: HTMLElement[]) {
  return el('header', 'page-head', el('h1', 'title', title), sub ? el('p', 'cap', sub) : undefined, ...extra)
}

function section(title: string, ...children: (Node | false | undefined)[]) {
  return el('section', 'page-sec', el('h2', 'over', title), ...children)
}

/** Deletes only on the second tap (prevents mistakes) */
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

/** Last row of a list: loading · [Show more] · end (scrolling down loads more by itself) */
function moreRow(p: Pager<{ id: string }>): HTMLElement | undefined {
  if (!p.items.length) return undefined
  const t = lifeText(lang)
  if (p.loading) return el('p', 'cap page-more', el('span', 'spin'), t.loadingMore)
  if (p.next)
    return el(
      'div',
      'page-more',
      button('btn-text sm', () => p.more(), t.more),
    )
  return el('p', 'cap page-more', t.end)
}

// ── Feed ─────────────────────────────────────────────

export function feedView(ctx: LifeCtx): HTMLElement {
  const t = lifeText(lang)
  const life = ctx.life()
  const prompt = life.feedPrompt
  const input = el('input', 'field grow')
  input.placeholder = prompt ? t.feedPromptChange : t.feedPromptExample
  input.setAttribute('aria-label', t.feedPromptAria)
  const save = el('button', 'btn sm', prompt ? t.feedPromptUpdate : t.feedPromptSave)
  save.type = 'submit'
  const form = el('form', 'feed-form', input, save)
  form.onsubmit = (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    save.disabled = true
    void ctx.act({ action: 'feed-prompt', text }).then(() => ctx.toast(t.feedPromptSaved))
  }
  const askCard = el(
    'div',
    'card feed-prompt',
    el('div', 'card-label', doori('', 22), t.feedPromptAsk),
    prompt
      ? el('p', 'feed-prompt-now', el('strong', '', prompt), el('span', 'meta', t.feedPromptNow))
      : el('p', 'cap', t.feedPromptHint),
    el(
      'div',
      'feed-prompt-row',
      form,
      prompt
        ? button(
            'btn-text sm',
            () =>
              void ctx.act({ action: 'feed-prompt', text: '' }).then(() => ctx.toast(t.feedPromptStopped)),
            t.feedPromptStop,
          )
        : undefined,
    ),
  )

  const body: HTMLElement[] = []
  const waiting = ctx.waiting()
  if (waiting.length) body.push(el('div', 'feed-waiting', ...waiting))
  const list = ctx.feedList()
  if (!list.items.length) body.push(emptyState('sleeping', t.feedEmptyTitle, t.feedEmptyBody))
  for (const g of groupByDay(list.items)) {
    const ul = el('ul', 'feed-list')
    for (const f of g.items) ul.append(feedItem(ctx, f))
    body.push(el('section', 'feed-day', el('h2', 'over', g.day), ul))
  }
  const more = moreRow(list)
  if (more) body.push(more)
  return el('div', 'page page-narrow', pageHead(t.feedTitle, t.feedSub), askCard, watchCard(ctx), ...body)
}

/** Proactive check: every hour from 6 AM to 10 PM, looks at connected services and Dool2's own work and only reports what needs attention (ADR 0019, 0025) */
function watchCard(ctx: LifeCtx): HTMLElement {
  const t = lifeText(lang)
  const w = ctx.life().watch ?? { on: true }
  const linked = ctx.services().filter((c) => c.connectedAt && c.card.how !== 'device')
  const names = linked.map((c) => c.card.name).join(', ')
  const sub = !linked.length
    ? t.watchNoLinks
    : w.busy
      ? t.watchBusy(names)
      : w.on
        ? t.watchOn(names)
        : t.watchOff
  const now = button(
    'btn-ghost sm',
    () => void ctx.act({ action: 'watch-now' }).then(() => ctx.toast(t.watchNowToast)),
    w.busy ? t.watchBusyButton : t.watchNow,
  )
  now.disabled = Boolean(w.busy) || !linked.length
  return el(
    'div',
    'card watch-card',
    el(
      'div',
      'watch-row',
      el('div', 'grow', el('p', 'row-t', t.watchTitle), el('p', 'cap', sub)),
      linked.length ? now : button('btn-ghost sm', () => ctx.openView('connect'), t.connect),
      toggle(w.on, t.watchTitle, (on) => void ctx.act({ action: 'watch', on })),
    ),
  )
}

function feedItem(ctx: LifeCtx, f: FeedItem): HTMLElement {
  const t = lifeText(lang)
  const k = FEED_KIND[f.kind] ?? FEED_KIND.post
  // Dool2's news and scheduled work are long, so they start folded and expand on tap
  const long = f.kind === 'post' || f.kind === 'routine'
  let text: HTMLElement | undefined
  if (f.body) {
    if (long) {
      text = el('div', 'feed-text rich clamp')
      setRich(text, f.body)
      const box = text
      box.title = t.tapToExpand
      box.onclick = () => box.classList.toggle('open')
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
    chip('up', t.like, f.reaction === 'up', react('up')),
    chip('down', t.dislike, f.reaction === 'down', react('down')),
    button('chip quiet', () => ctx.compose(continueText(f)), icon('reply'), t.continueTalk),
  )
  // A proactive suggestion: [Do it] sends the request to chat, [No thanks] skips it. After answering only the choice stays
  if (f.kind === 'suggest' && f.ask) {
    const ask = f.ask
    actions.replaceChildren(
      ...(f.answered
        ? [el('span', 'cap', f.answered === 'yes' ? t.suggestYes : t.suggestNo)]
        : [
            button(
              'btn sm',
              () =>
                void ctx.act({ action: 'feed-answer', id: f.id, answer: 'yes' }).then(() => ctx.send(ask)),
              f.askLabel || t.doIt,
            ),
            button(
              'btn-ghost sm',
              () => void ctx.act({ action: 'feed-answer', id: f.id, answer: 'no' }),
              t.noThanks,
            ),
          ]),
    )
  }
  // Keep results in one place: posts from a goal or the Library link back there
  const goal = f.ref ? ctx.life().routines.find((r) => r.id === f.ref) : undefined
  if (goal && !isFeedRoutine(goal))
    actions.append(button('btn-text sm', () => ctx.openGoal(goal.id), t.seeGoal, icon('chevron')))
  else if (f.kind === 'saved')
    actions.append(button('btn-text sm', () => ctx.openView('library'), t.seeLibrary, icon('chevron')))
  return el(
    'li',
    'feed-item',
    emoTile(k.emo),
    el(
      'div',
      'grow',
      el('p', 'feed-head meta', el('span', '', k.label), el('span', '', timeLabel(f.at))),
      el('p', 'feed-title', plain(f.title, 120)),
      text,
      f.from ? el('p', 'cap feed-from', f.from) : undefined,
      actions,
    ),
  )
}

// ── Ideas ────────────────────────────────────────────

/** Things Dool2 found to do (from memory, goals and connections, fresh every morning) */
function suggestedBox(ctx: LifeCtx) {
  const t = lifeText(lang)
  const life = ctx.life()
  const ideas = life.ideas ?? []
  const refresh = button(
    'btn-ghost sm',
    () => void ctx.act({ action: 'ideas-refresh' }),
    life.ideasBusy ? t.ideasFinding : ideas.length ? t.ideasRefresh : t.ideasFind,
  )
  refresh.disabled = Boolean(life.ideasBusy)
  return el(
    'section',
    'card suggested',
    el(
      'div',
      'suggested-head',
      doori(life.ideasBusy ? 'thinking' : '', 28),
      el('div', 'grow', el('p', 'row-t', t.ideasToday), el('p', 'cap', t.ideasTodaySub)),
      refresh,
    ),
    ...ideas.map((i) =>
      button(
        'idea-row',
        () => ctx.send(i.text),
        emoTile('bulb'),
        el('span', 'grow', el('span', 'idea-t', i.text), el('span', 'cap', i.why)),
        icon('send', 'i idea-go'),
      ),
    ),
  )
}

/** Category and search text picked on the Ideas tab (kept when switching tabs) */
const ideaPick = { cat: 'all', query: '' }

function ideaRow(ctx: LifeCtx, it: IdeaItem, sec: IdeaSection) {
  const t = lifeText(lang)
  const later = needsConnect(it)
  return button(
    'idea-row',
    () => {
      if (later && it.service) {
        ctx.toast(t.ideaConnectToast(it.service.name))
        ctx.openService(it.service.id)
      } else if (it.fill) ctx.compose(it.fill)
      else ctx.send(it.ask)
    },
    it.service ? withLogo(el('span', 'svc-mark', it.service.mark), it.service.id) : emoTile(sec.emo),
    el('span', 'grow', el('span', 'idea-t', it.text), el('span', 'cap', it.note)),
    later
      ? el('span', 'idea-tag', t.ideaTagConnect)
      : it.fill
        ? el('span', 'idea-tag', t.ideaTagFill)
        : icon('send', 'i idea-go'),
  )
}

function ideaCatalogBox(ctx: LifeCtx, groups: IdeaGroup[]): HTMLElement {
  const t = lifeText(lang)
  const box = el('div', 'idea-catalog')
  const search = el('input', 'field idea-search')
  search.type = 'search'
  search.placeholder = t.ideaSearch
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
    chips.replaceChildren(chip('all', t.ideaAll), ...groups.map((g) => chip(g.section.id, g.section.label)))
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
              el('span', 'idea-t', t.ideaAskAsIs(q)),
              el('span', 'cap', found.length ? t.ideaNoMatchSome : t.ideaNoMatch),
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
              emoTile(sec.emo, 'sm'),
              el('strong', '', sec.label),
              el('span', 'cap', t.ideaSeeAll(g.items.length)),
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
      body.append(section(t.ideaReady, list(ready.map((item) => ({ section: g.section, item })))))
    if (later.length)
      body.append(
        section(
          t.ideaLater,
          el('p', 'cap idea-later', t.ideaLaterHint),
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
  const t = lifeText(lang)
  const groups = ideaCatalog(ctx.services(), lang)
  return el(
    'div',
    'page',
    pageHead(t.ideasTitle, t.ideasSub(ideaCount(groups))),
    suggestedBox(ctx),
    ideaCatalogBox(ctx, groups),
    el(
      'div',
      'card ask idea-human',
      el('div', 'card-label', doori('asking', 22), t.ideasHumanTitle),
      el('p', 'cap', t.ideasHumanBody),
    ),
  )
}

// ── Goals ────────────────────────────────────────────

function routineTile(r: Routine) {
  if (r.category) {
    return emoTile(GOAL_META[r.category].emo)
  }
  return emoTile('routine')
}

function progressBar(done: number, total: number) {
  const fill = el('i')
  fill.style.width = `${Math.round((done / total) * 100)}%`
  return el('span', 'progress-line', fill)
}

function goalRow(ctx: LifeCtx, r: Routine) {
  const t = lifeText(lang)
  const p = planProgress(r)
  const row = button(
    `goal-row${r.enabled ? '' : ' off'}`,
    () => ctx.openGoal(r.id),
    routineTile(r),
    el(
      'span',
      'grow',
      el('span', 'row-t', r.title),
      el('span', 'row-d', [r.category && goalCategoryLabel(r.category), when(r)].filter(Boolean).join(' · ')),
      p
        ? el(
            'span',
            'goal-progress',
            progressBar(p.done, p.total),
            el('span', 'meta', t.plan(p.done, p.total)),
          )
        : undefined,
      r.lastResult
        ? el('span', 'meta goal-last', t.lastResultLine(plain(resultLine(r.lastResult, lang), 90)))
        : undefined,
    ),
  )
  row.append(
    toggle(
      r.enabled,
      r.enabled ? t.turnOff : t.turnOn,
      (on) => void ctx.act({ action: 'routine-toggle', id: r.id, on }),
    ),
  )
  return row
}

export function goalsView(ctx: LifeCtx): HTMLElement {
  const t = lifeText(lang)
  const list = sortRoutines(ctx.life().routines.filter((r) => !isFeedRoutine(r)))
  const goals = list.filter((r) => r.category)
  const routines = list.filter((r) => !r.category)
  const create = GOAL_CATEGORY_LIST.map((c: GoalCategory) => {
    const m = GOAL_META[c]
    return button(
      'goal-new',
      () => ctx.compose(goalStarter(c)),
      emoTile(m.emo),
      el('span', 'grow', el('span', 'row-t', goalCategoryLabel(c)), el('span', 'cap', m.hint)),
      icon('plus', 'i md goal-plus'),
    )
  })
  return el(
    'div',
    'page',
    pageHead(t.goalsTitle, t.goalsSub),
    goals.length
      ? section(t.goalsActive, el('div', 'goal-list', ...goals.map((r) => goalRow(ctx, r))))
      : undefined,
    routines.length
      ? section(t.goalsScheduled, el('div', 'goal-list', ...routines.map((r) => goalRow(ctx, r))))
      : undefined,
    list.length
      ? undefined
      : el(
          'div',
          'card goal-hint',
          el('div', 'card-label', doori('', 22), t.goalsHintTitle),
          el('p', '', t.goalsHintBody),
        ),
    section(t.goalsNew, el('div', 'goal-grid', ...create)),
    section(
      t.goalsExamples,
      el(
        'div',
        'idea-list',
        ...routineExamples[lang].map(([text, note]) =>
          button(
            'idea-row',
            () => ctx.send(text),
            emoTile('routine'),
            el('span', 'grow', el('span', 'idea-t', text), el('span', 'cap', note)),
            icon('send', 'i idea-go'),
          ),
        ),
      ),
    ),
  )
}

export function goalDetail(ctx: LifeCtx, id: string, back: () => void): HTMLElement {
  const t = lifeText(lang)
  const r = ctx.life().routines.find((x) => x.id === id)
  const backBtn = button('btn-text back-btn', back, icon('back'), t.goalBack)
  if (!r) return el('div', 'page', backBtn, emptyState('', t.goalGoneTitle, t.goalGoneBody))
  const p = planProgress(r)
  const now = new Date()
  const facts = el('dl', 'kv goal-facts')
  const fact = (k: string, v?: string) => {
    if (v) facts.append(el('dt', '', k), el('dd', '', v))
  }
  const m = lifeModel(lang)
  fact(t.factWhen, r.schedule ? scheduleLabel(r.schedule, lang) : m.noTime)
  fact(
    t.factNext,
    r.enabled ? (r.nextRunAt ? whenLabel(r.nextRunAt, now) : undefined) : r.endedAt ? m.ended : m.off,
  )
  if (r.schedule && r.schedule.kind !== 'once')
    fact(t.factUntil, r.until ? untilLabel(r.until, lang) : t.untilDeleted)
  fact(t.factLast, r.lastRunAt ? whenLabel(r.lastRunAt, now) : undefined)
  fact(
    t.factResult,
    `${r.notify === 'when_found' ? t.resultOnlyMatch : ''}${r.target === 'feed' ? t.resultFeed : t.resultChat}`,
  )

  const actions = el(
    'div',
    'goal-actions',
    button(
      'btn sm',
      () => void ctx.act({ action: 'routine-run', id: r.id }).then(() => ctx.toast(t.runStarted)),
      icon('play'),
      r.category ? t.checkInNow : t.tryNow,
    ),
    button('btn-ghost sm', () => ctx.compose(t.goalTalk(r.title)), icon('reply'), t.goalContinue),
    el('span', 'grow'),
    button(
      'btn-text sm',
      () => void ctx.act({ action: 'routine-toggle', id: r.id, on: !r.enabled }),
      r.enabled ? t.pause : t.resume,
    ),
    confirmButton('btn-text sm danger', [icon('trash'), t.delete], t.deleteConfirm, () => {
      void ctx.act({ action: 'routine-delete', id: r.id }).then(() => {
        ctx.toast(t.goalDeleted)
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
    : el('p', 'cap', t.noPlan)

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
        el(
          'p',
          'cap',
          [r.category ? goalCategoryLabel(r.category) : t.goalsScheduled, when(r, now)].join(' · '),
        ),
      ),
    ),
    actions,
    facts,
    section(p ? t.plan(p.done, p.total) : t.planTitle, p ? progressBar(p.done, p.total) : undefined, plan),
    section(t.goalTask, el('p', 'goal-prompt', r.prompt)),
    log.length
      ? section(
          t.goalLog,
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
        ? section(t.goalLastResult, el('p', 'goal-result', plain(r.lastResult, 600)))
        : section(t.goalLog, el('p', 'cap', t.goalLogEmpty)),
  )
}

// ── Library ──────────────────────────────────────────

export function libraryView(ctx: LifeCtx, tab: LibraryTab, setTab: (t: LibraryTab) => void): HTMLElement {
  const t = lifeText(lang)
  const count = ctx.life().libraryCount
  const seg = el('div', 'seg')
  for (const [id, label] of [
    ['made', t.libMade],
    ['files', t.libFiles],
  ] as const) {
    const n = count?.[id] ?? ctx.libraryList(id).items.length
    const b = button('', () => setTab(id), label, n ? el('span', 'seg-n', String(n)) : undefined)
    b.setAttribute('aria-pressed', String(tab === id))
    seg.append(b)
  }
  const list = ctx.libraryList(tab)
  const items = libraryTab(list.items, tab)
  const body = items.length
    ? el('div', 'lib-list', el('div', 'lib-grid', ...items.map((it) => libraryCard(ctx, it))), moreRow(list))
    : tab === 'made'
      ? emptyState('', t.libEmptyMadeTitle, t.libEmptyMadeBody)
      : emptyState('', t.libEmptyFilesTitle, t.libEmptyFilesBody)
  return el('div', 'page', pageHead(t.libTitle, t.libSub, seg), body)
}

/** Expanded Library cards (so they stay open when the screen redraws while Dool2 works) */
const openCards = new Set<string>()

/** Text of a file item: drops the trailing "PC: path" line, since buttons replace it */
const fileBody = (it: LibraryItem, body: string) =>
  it.path ? body.replace(/\s*PC: [^\n]*$/, '').trim() : body

function libraryCard(ctx: LifeCtx, it: LibraryItem): HTMLElement {
  const t = lifeText(lang)
  const k = LIBRARY_KIND[it.kind] ?? LIBRARY_KIND.note
  const host = hostOf(it.url)
  const path = it.path
  const actions = el('div', 'lib-actions')
  if (path)
    actions.append(
      button('btn-text sm', () => ctx.openFile(path), icon('external'), t.open),
      (() => {
        const b = button('icon-btn', () => ctx.openFile(path, true), icon('library'))
        b.title = t.showInFolder
        b.setAttribute('aria-label', t.showInFolder)
        return b
      })(),
    )
  if (it.url?.startsWith('https://')) {
    const a = el('a', 'btn-text sm', icon('link'), t.open)
    a.href = it.url
    a.target = '_blank'
    a.rel = 'noopener'
    actions.append(a)
  }
  actions.append(
    button(
      'btn-text sm',
      () => ctx.compose(t.libTalk(plain(it.title, 40))),
      icon('reply'),
      path ? t.askEdit : t.continueTalk,
    ),
    el('span', 'grow'),
    confirmButton('icon-btn lib-del', [icon('trash')], t.deleteAsk, () => {
      openCards.delete(it.id)
      void ctx.act({ action: 'library-delete', id: it.id }).then(() => ctx.toast(t.libDeleted))
    }),
  )
  // Files with a picture: a small preview in the list too (tap to open)
  let thumb: HTMLElement | undefined
  if (it.thumb) {
    const img = el('img', 'lib-thumb-img') as HTMLImageElement
    img.src = `data:image/jpeg;base64,${it.thumb}`
    img.alt = ''
    img.loading = 'lazy'
    thumb = path ? button('lib-thumb', () => ctx.openFile(path), img) : el('div', 'lib-thumb', img)
    if (path) thumb.title = t.tapToOpen
  }
  const shown = fileBody(it, it.body)
  let text: HTMLElement | undefined
  if (shown) {
    text = el('div', 'lib-text rich clamp')
    setRich(text, it.cut ? `${shown}…` : shown)
    const t = text
    // Lists only carry the start: fetch the full text on expand and swap it in
    let full = !it.cut
    const fill = () => {
      if (full) return
      full = true
      void ctx
        .libraryFull(it.id)
        .then((x) => {
          if (!x) return
          setRich(t, fileBody(x, x.body))
          // Pictures and invitations Dool2 made: a preview the PC rendered
          if (x.image) {
            const img = el('img', 'lib-shot') as HTMLImageElement
            img.src = `data:image/jpeg;base64,${x.image}`
            img.alt = x.title
            t.prepend(img)
          }
        })
        .catch(() => (full = false))
    }
    t.onclick = (e) => {
      // Do not expand when a link or file chip inside the text was clicked
      if ((e.target as HTMLElement).closest('a, button')) return
      t.classList.toggle('open')
      if (t.classList.contains('open')) {
        openCards.add(it.id)
        fill()
      } else openCards.delete(it.id)
    }
    if (openCards.has(it.id)) {
      t.classList.add('open')
      fill()
    }
  }
  return el(
    'article',
    'card lib-card',
    el(
      'div',
      'lib-top',
      thumb ?? emoTile(k.emo),
      el('span', 'meta grow', [k.label, host].filter(Boolean).join(' · ')),
      el('time', 'meta', shortWhen(it.savedAt)),
    ),
    el('p', 'lib-title', plain(it.title, 80)),
    it.price ? el('p', 'lib-price', it.price) : undefined,
    text,
    actions,
  )
}

// ── Assistant panel: Schedule · Memory · Activity ─────

const sideEmpty = (text: string) => el('p', 'cap side-empty', text)

export function scheduleTab(ctx: LifeCtx): HTMLElement {
  const list = upcoming(ctx.life().routines)
  if (!list.length) return sideEmpty(lifeText(lang).scheduleEmpty)
  const now = new Date()
  return el(
    'div',
    'side-list',
    ...list.map((r) =>
      button(
        'side-row',
        () => ctx.openGoal(r.id),
        emoTile('routine'),
        el(
          'span',
          'grow',
          el('span', 'side-t', r.title),
          el('span', 'meta', r.schedule ? scheduleLabel(r.schedule, lang) : ''),
        ),
        el('span', 'side-when meta', whenLabel(r.nextRunAt ?? '', now)),
      ),
    ),
  )
}

/** Assistant settings: what to call me · tone · answer length */
function identityBlock(ctx: LifeCtx): HTMLElement {
  const t = lifeText(lang)
  const id = ctx.life().identity ?? {}
  const name = el('input', 'field grow')
  name.placeholder = t.namePlaceholder
  name.setAttribute('aria-label', t.nameLabel)
  name.value = id.userName ?? ''
  const save = el('button', 'btn sm', t.save)
  save.type = 'submit'
  const form = el('form', 'feed-form', name, save)
  form.onsubmit = (e) => {
    e.preventDefault()
    void ctx.act({ action: 'identity', userName: name.value }).then(() => ctx.toast(t.nameSaved))
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
    el('p', 'over', t.nameLabel),
    form,
    el('p', 'over', t.tone),
    seg(
      id.tone ?? 'warm',
      [
        ['warm', t.toneWarm],
        ['neat', t.toneNeat],
        ['buddy', t.toneBuddy],
      ],
      (tone) => void ctx.act({ action: 'identity', tone }),
    ),
    el('p', 'over', t.length),
    seg(
      id.length ?? 'normal',
      [
        ['short', t.lengthShort],
        ['normal', t.lengthNormal],
        ['detail', t.lengthDetail],
      ],
      (length) => void ctx.act({ action: 'identity', length }),
    ),
    el('p', 'over', t.memory),
  )
}

export function memoryTab(ctx: LifeCtx): HTMLElement {
  const t = lifeText(lang)
  const input = el('input', 'field grow')
  input.placeholder = t.memoryPlaceholder
  input.setAttribute('aria-label', t.memoryAria)
  const add = el('button', 'btn sm', t.remember)
  add.type = 'submit'
  const form = el('form', 'feed-form', input, add)
  form.onsubmit = (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    add.disabled = true
    input.blur()
    void ctx.act({ action: 'memory-add', text }).then(() => ctx.toast(t.remembered))
  }
  const items = [...ctx.life().memory].sort((a, b) => b.at.localeCompare(a.at))
  return el(
    'div',
    'memory',
    identityBlock(ctx),
    el('p', 'cap', t.memoryAbout),
    form,
    items.length
      ? el(
          'div',
          'side-list',
          ...items.map((m) => {
            const forget = confirmButton('icon-btn', [icon('trash')], t.forgetAsk, () => {
              void ctx.act({ action: 'memory-delete', id: m.id }).then(() => ctx.toast(t.forgotten))
            })
            forget.setAttribute('aria-label', t.forget)
            forget.title = t.forget
            return el(
              'div',
              'side-row',
              tile('brain', 'mint', 36),
              el(
                'span',
                'grow',
                el('span', 'side-t', m.text),
                el('span', 'meta', `${m.source === 'user' ? t.byUser : t.fromChat} · ${shortWhen(m.at)}`),
              ),
              forget,
            )
          }),
        )
      : sideEmpty(t.memoryEmpty),
    ...knowBlock(ctx),
  )
}

/** What Dool2 knows: facts seen after logging in and applications or bookings it made (with seen date and basis) */
function knowBlock(ctx: LifeCtx): HTMLElement[] {
  const know = ctx.life().know ?? []
  if (!know.length) return []
  const t = lifeText(lang)
  return [
    el('p', 'cap', t.knowAbout),
    el(
      'div',
      'side-list',
      ...know.map((k) => {
        const forget = confirmButton('icon-btn', [icon('trash')], t.deleteAsk, () => {
          void ctx.act({ action: 'know-delete', id: k.id }).then(() => ctx.toast(t.deleted))
        })
        forget.setAttribute('aria-label', t.delete)
        forget.title = t.delete
        const meta = [
          k.source,
          k.basis,
          shortWhen(k.seenAt),
          k.kind === 'done'
            ? k.state === 'done'
              ? t.knowDone
              : k.next
                ? t.knowNext(shortWhen(k.next))
                : t.knowOngoing
            : '',
        ]
          .filter(Boolean)
          .join(' · ')
        return el(
          'div',
          'side-row',
          tile(k.kind === 'done' ? 'check' : 'brain', k.kind === 'done' ? 'violet' : 'mint', 36),
          el('span', 'grow', el('span', 'side-t', `${k.title}: ${k.value}`), el('span', 'meta', meta)),
          forget,
        )
      }),
    ),
  ]
}

export function activityTab(ctx: LifeCtx): HTMLElement {
  const t = lifeText(lang)
  const list = ctx.activityList()
  const done = list.items
  const working = ctx.working()
  if (!list.started && !working) return el('p', 'cap side-empty', el('span', 'spin'), t.loading)
  if (!done.length && !working) return sideEmpty(t.activityEmpty)
  return el(
    'div',
    'activity',
    working,
    ...groupByDay(done).map((g) =>
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
    moreRow(list),
  )
}
