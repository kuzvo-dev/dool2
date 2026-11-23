// Phone app: the Feed, Goals and Library tabs with their detail sheets, and the upcoming and memory sections of the assistant panel.
// The data is the daemon's life record on the PC (LifeState); changes are sent as life-action.
import {
  type FeedItem,
  GOAL_CATEGORIES,
  type GoalCategory,
  type LibraryItem,
  type LifeAction,
  type LifeState,
  type Routine,
} from '@dool2/protocol'
import type { Pager } from '@dool2/protocol/paging'
import { stripLinks, withoutPhotoMark } from '@dool2/protocol/rich'
import { ruleLabel, scheduleLabel } from '@dool2/protocol/schedule'
import { doori, emoTile, h, type IconName, icon, rich, segBtn, shortTime } from './dom.js'
import { lang } from './lang.js'
import { lifeText } from './locales/life.js'
import { burst, drawCheck, rememberFlip, springHeight } from './motion.js'
import { statCard } from './motion-cards.js'
import { FEED_ROUTINE_TITLE, GOAL_CATEGORY_STYLE } from './region/kr/life-views.js'

const L = lifeText(lang)

export interface LifeCtx {
  life?: LifeState
  online: boolean
  act(a: LifeAction): void
  /** Send straight to the chat */
  ask(text: string): void
  /** Put in the chat input and go to the chat tab */
  fill(text: string): void
  openGoal(id: string): void
  openItem(id: string): void
  close(): void
  /** Long lists: what is loaded and the next page (feed, the library segment in view) */
  feedList: Pager<FeedItem>
  libraryList: Pager<LibraryItem>
  /** One library item: if only the start was received, ask for all of it and return what we have */
  fullItem(id: string): LibraryItem | undefined
  /** Top of the feed: "waiting for me / doing now" (approvals, logins, progress) */
  waiting: HTMLElement[]
  /** Fetch the original library file from the PC and save it on the phone or send it to another app */
  fileAction?(it: LibraryItem, how: 'save' | 'share'): void
  /** View an image large */
  view?(src: string, title: string, path?: string): void
  /** Library segment: made / photos and files */
  librarySeg: 'made' | 'media'
  setLibrarySeg(seg: 'made' | 'media'): void
}

const FEED_KIND: Record<FeedItem['kind'], { label: string; icon: IconName; tone: string; emo: string }> = {
  post: { label: L.kindPost, icon: 'feed', tone: 'blue', emo: 'news' },
  done: { label: L.kindDone, icon: 'check', tone: 'mint', emo: 'check' },
  routine: { label: L.kindRoutine, icon: 'clock', tone: 'violet', emo: 'routine' },
  saved: { label: L.kindSaved, icon: 'bookmark', tone: 'amber', emo: 'bookmark' },
  goal: { label: L.kindGoal, icon: 'goal', tone: 'rose', emo: 'other' },
  connected: { label: L.kindConnected, icon: 'link', tone: 'blue', emo: 'link' },
  suggest: { label: L.kindSuggest, icon: 'idea', tone: 'amber', emo: 'bulb' },
}

const CATEGORY = Object.fromEntries(
  Object.entries(GOAL_CATEGORY_STYLE).map(([c, st]) => [c, { ...st, hint: L.hint(st.emo) }]),
) as Record<GoalCategory, { icon: IconName; tone: string; hint: string; emo: string }>

/** A goal category's name in the UI language */
const categoryLabel = (c: GoalCategory) => L.categoryName(CATEGORY[c].emo) || c

/** A reply or text on one line, without bold marks */
export function plain(text: string, max = 120) {
  const t = stripLinks(text)
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/\[( |x|X)\]\s*/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function header(title: string, sub?: string) {
  return [h('h1', { class: 'ptitle', text: title }), sub ? h('p', { class: 'psub', text: sub }) : undefined]
}

function empty(mood: string, title: string, sub: string) {
  return h(
    'div',
    { class: 'empty' },
    doori(mood, 64),
    h('strong', { text: title }),
    h('span', { class: 'meta', text: sub }),
  )
}

/** End-of-list row: loading, [Show more], or "That's all" (more loads on its own when scrolled down) */
export function moreRow(p: Pager<{ id: string }>): HTMLElement | undefined {
  if (!p.items.length) return undefined
  if (p.loading) return h('p', { class: 'wait page-more' }, h('span', { class: 'spin' }), L.loadingMore)
  if (p.next)
    return h(
      'div',
      { class: 'page-more' },
      h('button', { class: 'btn-text small', text: L.more, onclick: () => p.more() }),
    )
  return h('p', { class: 'meta page-more', text: L.endOfList })
}

// ── Feed ──

export function feedView(ctx: LifeCtx): HTMLElement {
  const box = h('section', { class: 'tab-page feed' }, ...header(L.feedTitle))
  // What Dool2 did this week: if there is at least one task
  // (the PC counts every day of the last 60 and sends the numbers, so it is exact regardless of loaded feed pages)
  const days = ctx.life?.feedDays
  if (days?.some((n) => n > 0)) box.append(statCard(days))
  // Feed instruction: say in words what to post
  const prompt = ctx.life?.feedPrompt
  const input = h('input', { class: 'field' })
  input.id = 'feed-prompt'
  input.placeholder = prompt ? L.feedPlaceholderChange : L.feedPlaceholderNew
  const save = h('button', { class: 'btn small', text: prompt ? L.change : L.receive })
  save.type = 'submit'
  const form = h('form', { class: 'feed-form' }, input, save)
  form.onsubmit = (e) => {
    e.preventDefault()
    const t = input.value.trim()
    if (!t) return
    ctx.act({ action: 'feed-prompt', text: t })
    input.value = ''
  }
  box.append(
    h(
      'div',
      { class: 'card feed-prompt' },
      h('div', { class: 'card-label' }, doori('', 22), L.whichNews),
      prompt
        ? h(
            'p',
            { class: 'card-text' },
            h('strong', { text: prompt }),
            h('span', { class: 'meta', text: L.dailyAt }),
          )
        : h('p', { class: 'meta', text: L.feedHelp }),
      form,
      prompt
        ? h('button', {
            class: 'btn-text small',
            text: L.stopReceiving,
            onclick: () => ctx.act({ action: 'feed-prompt', text: '' }),
          })
        : undefined,
    ),
  )
  if (ctx.life) box.append(watchCard(ctx))
  if (ctx.waiting.length) box.append(...ctx.waiting)
  const items = ctx.feedList.items
  if (!ctx.life) box.append(h('p', { class: 'wait' }, h('span', { class: 'spin' }), L.receiving))
  else if (!items.length) box.append(empty('sleeping', L.noNews, L.noNewsSub))
  let day = ''
  for (const f of items) {
    const d = dayLabel(f.at)
    if (d !== day) {
      day = d
      box.append(h('h2', { class: 'over', text: d }))
    }
    box.append(feedCard(ctx, f))
  }
  const more = moreRow(ctx.feedList)
  if (more) box.append(more)
  return box
}

function feedCard(ctx: LifeCtx, f: FeedItem) {
  const k = FEED_KIND[f.kind] ?? FEED_KIND.post
  const long = f.kind === 'post' || f.kind === 'routine'
  const body = h('div', { class: long ? 'feed-body clamp' : 'feed-body' })
  if (f.body) body.append(long ? rich(f.body) : plain(f.body, 160))
  // Long text is folded and opens when tapped
  if (long) body.onclick = () => springHeight(body, () => body.classList.toggle('open'))
  const react = (r: 'up' | 'down') => () =>
    ctx.act({ action: 'feed-react', id: f.id, ...(f.reaction === r ? {} : { reaction: r }) })
  return h(
    'article',
    { class: 'card feed-card' },
    h(
      'div',
      { class: 'feed-head' },
      emoTile(k.emo, 'sm'),
      h('span', { class: 'meta', text: k.label }),
      h('span', { class: 'meta feed-time', text: shortTime(f.at) }),
    ),
    h('strong', { class: 'feed-title', text: withoutPhotoMark(f.title) }),
    f.body ? body : undefined,
    f.from ? h('p', { class: 'meta feed-from', text: f.from }) : undefined,
    f.kind === 'suggest' && f.ask
      ? suggestActions(ctx, f, f.ask)
      : h(
          'div',
          { class: 'feed-actions' },
          h(
            'button',
            {
              class: f.reaction === 'up' ? 'chip on' : 'chip',
              label: L.like,
              onclick: (e: MouseEvent) => {
                // Bursts only on a new tap (quiet when undoing)
                if (f.reaction !== 'up') burst(e.currentTarget as HTMLElement)
                react('up')()
              },
            },
            icon('up'),
          ),
          h(
            'button',
            { class: f.reaction === 'down' ? 'chip on' : 'chip', label: L.dislike, onclick: react('down') },
            icon('down'),
          ),
          h(
            'button',
            {
              class: 'chip',
              onclick: () => ctx.fill(L.aboutPost(plain(f.title, 40))),
            },
            icon('reply'),
            L.continueTalk,
          ),
        ),
  )
}

/** A proactive suggestion: [Do it] sends that request to the chat, [No thanks] skips it */
function suggestActions(ctx: LifeCtx, f: FeedItem, ask: string) {
  if (f.answered)
    return h(
      'div',
      { class: 'feed-actions' },
      h('span', { class: 'meta', text: f.answered === 'yes' ? L.handedOver : L.skipped }),
    )
  return h(
    'div',
    { class: 'feed-actions suggest-actions' },
    h('button', {
      class: 'btn small',
      text: f.askLabel || L.doIt,
      onclick: () => {
        ctx.act({ action: 'feed-answer', id: f.id, answer: 'yes' })
        ctx.ask(ask)
      },
    }),
    h('button', {
      class: 'btn-ghost small',
      text: L.fine,
      onclick: () => ctx.act({ action: 'feed-answer', id: f.id, answer: 'no' }),
    }),
  )
}

/** Proactive check switch: every hour from 6 AM to 10 PM, looks at connected services and what Dool2 did, and only reports what needs attention (ADR 0019, 0025) */
function watchCard(ctx: LifeCtx) {
  const w = ctx.life?.watch ?? { on: true }
  const sw = h('button', {
    class: w.on ? 'switch on' : 'switch',
    label: w.on ? L.watchOff : L.watchOn,
    onclick: () => ctx.act({ action: 'watch', on: !w.on }),
  })
  sw.setAttribute('role', 'switch')
  sw.setAttribute('aria-checked', String(w.on))
  return h(
    'div',
    { class: 'card watch-card' },
    h(
      'div',
      { class: 'watch-row' },
      h(
        'div',
        { class: 'grow' },
        h('strong', { text: L.watchTitle }),
        h('p', {
          class: 'meta',
          text: w.busy ? L.watchBusy : w.on ? L.watchDesc : L.watchIsOff,
        }),
      ),
      sw,
    ),
    w.on && !w.busy
      ? h('button', {
          class: 'btn-text small',
          text: L.watchNow,
          onclick: () => ctx.act({ action: 'watch-now' }),
        })
      : undefined,
  )
}

function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const diff = Math.round(
    (new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000,
  )
  if (diff <= 0) return L.today
  if (diff === 1) return L.yesterday
  return L.dayLong(d)
}

// ── Goals ──

export function whenText(r: Routine) {
  // One that turned itself off after its end time counts as "ended"
  if (!r.enabled) return r.endedAt ? L.ended : L.turnedOff
  if (!r.schedule) return L.noTime
  const next = r.nextRunAt ? L.next(nextText(r.nextRunAt)) : ''
  return `${[scheduleLabel(r.schedule, lang), ruleLabel(r, lang)].filter(Boolean).join(' · ')}${next}`
}

function nextText(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const days = Math.round(
    (new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000,
  )
  const t = d.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' })
  if (days === 0) return L.todayAt(t)
  if (days === 1) return L.tomorrowAt(t)
  return L.dateAt(d.getMonth() + 1, d.getDate(), t)
}

/** Folds left open on the goals screen (kept across redraws) */
const goalsOpen = { off: false, add: false }

/** A fold: stays open across redraws */
function fold(key: keyof typeof goalsOpen, summary: string, ...body: (Node | undefined)[]) {
  const d = h('details', { class: 'goal-fold' }, h('summary', { class: 'over', text: summary }), ...body)
  d.open = goalsOpen[key]
  d.addEventListener('toggle', () => {
    goalsOpen[key] = d.open
  })
  return d
}

/**
 * Goals: goals in progress are cards, scheduled tasks are one row each (soonest first).
 * Turned-off or ended ones and "set a new goal" are folded (too much to scan with many goals, seen in real use 11-20)
 */
export function goalsView(ctx: LifeCtx): HTMLElement {
  const box = h('section', { class: 'tab-page goals' }, ...header(L.goalsTitle, L.goalsSub))
  const list = (ctx.life?.routines ?? []).filter(
    (r) => !(r.target === 'feed' && r.title === FEED_ROUTINE_TITLE),
  )
  const on = list.filter((r) => r.enabled)
  const off = list.filter((r) => !r.enabled)
  const soon = (a: Routine, b: Routine) =>
    (a.nextRunAt ?? '9999').localeCompare(b.nextRunAt ?? '9999') || a.title.localeCompare(b.title)
  const goals = on.filter((r) => r.category).sort(soon)
  const routines = on.filter((r) => !r.category).sort(soon)
  if (!ctx.life) box.append(h('p', { class: 'wait' }, h('span', { class: 'spin' }), L.receiving))
  if (goals.length) {
    box.append(h('h2', { class: 'over', text: L.inProgress(goals.length) }))
    for (const g of goals) box.append(goalCard(ctx, g))
  }
  if (routines.length) {
    box.append(
      h('h2', { class: 'over', text: L.scheduledCount(routines.length) }),
      h('div', { class: 'card goal-rows' }, ...routines.map((r) => goalRow(ctx, r))),
    )
  }
  if (off.length)
    box.append(
      fold(
        'off',
        L.offCount(off.length),
        h('div', { class: 'card goal-rows' }, ...off.map((r) => goalRow(ctx, r))),
      ),
    )
  if (ctx.life && !list.length)
    box.append(
      h(
        'div',
        { class: 'card ask-card' },
        h('div', { class: 'card-label' }, doori('', 22), L.askByChat),
        h('p', {
          class: 'card-text',
          text: L.askByChatText,
        }),
      ),
    )
  const grid = h('div', { class: 'goal-grid' })
  for (const c of GOAL_CATEGORIES) {
    const k = CATEGORY[c]
    grid.append(
      h(
        'button',
        { class: 'goal-tile', onclick: () => ctx.fill(L.newGoalFill(categoryLabel(c))) },
        emoTile(k.emo),
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-t', text: categoryLabel(c) }),
          h('span', { class: 'row-d', text: k.hint }),
        ),
        icon('plus', 'i plus'),
      ),
    )
  }
  const examples = (
    [
      [L.example1, L.exampleNote1],
      [L.example2, L.exampleNote2],
      [L.example3, L.exampleNote3],
      [L.example4, L.exampleNote4],
    ] as [string, string][]
  ).map(([t, note]) =>
    h(
      'button',
      { class: 'idea', onclick: () => ctx.ask(t) },
      emoTile('routine'),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: t }),
        h('span', { class: 'row-d', text: note }),
      ),
    ),
  )
  // With few goals show them open; with many, fold them
  if (list.length < 3) {
    box.append(h('h2', { class: 'over', text: L.newGoal }), grid)
    box.append(h('h2', { class: 'over', text: L.manyScheduled }), ...examples)
  } else
    box.append(fold('add', L.newGoal, grid, h('h2', { class: 'over', text: L.manyScheduled }), ...examples))
  return box
}

/** A scheduled-task row: name, when (next run), and a switch on the right */
function goalRow(ctx: LifeCtx, r: Routine) {
  const k = r.category ? CATEGORY[r.category] : undefined
  return h(
    'div',
    { class: r.enabled ? 'goal-row' : 'goal-row off', onclick: () => ctx.openGoal(r.id) },
    emoTile(k?.emo ?? 'routine'),
    h(
      'span',
      { class: 'row-text' },
      h('span', { class: 'row-t', text: r.title }),
      h('span', {
        class: 'row-d',
        text: [r.category ? categoryLabel(r.category) : undefined, whenText(r)].filter(Boolean).join(' · '),
      }),
    ),
    toggle(ctx, r),
  )
}

/** On/off switch */
function toggle(ctx: LifeCtx, r: Routine) {
  const sw = h('button', {
    class: r.enabled ? 'switch on' : 'switch',
    label: r.enabled ? L.turnOff : L.turnOn,
    onclick: (e) => {
      e.stopPropagation()
      rememberFlip(r.id, !r.enabled)
      ctx.act({ action: 'routine-toggle', id: r.id, on: !r.enabled })
    },
  })
  sw.dataset.id = r.id
  sw.setAttribute('role', 'switch')
  sw.setAttribute('aria-checked', String(r.enabled))
  return sw
}

function bar(ratio: number) {
  const i = h('i')
  i.style.width = `${Math.round(ratio * 100)}%`
  return h('span', { class: 'bar' }, i)
}

function goalCard(ctx: LifeCtx, r: Routine) {
  const k = r.category ? CATEGORY[r.category] : undefined
  const done = r.plan?.filter((p) => p.done).length ?? 0
  const total = r.plan?.length ?? 0
  // The latest result is left out of the list and shown in the detail (the list got too long)
  return h(
    'div',
    { class: r.enabled ? 'card goal-card' : 'card goal-card off', onclick: () => ctx.openGoal(r.id) },
    h(
      'div',
      { class: 'goal-head' },
      emoTile(k?.emo ?? 'routine'),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: r.title }),
        h('span', {
          class: 'row-d',
          text: [r.category ? categoryLabel(r.category) : undefined, whenText(r)].filter(Boolean).join(' · '),
        }),
      ),
      toggle(ctx, r),
    ),
    total
      ? h(
          'div',
          { class: 'goal-progress' },
          bar(total ? done / total : 0),
          h('span', { class: 'meta', text: L.plan(done, total) }),
        )
      : undefined,
  )
}

/** Goal detail (sheet) */
export function goalSheet(ctx: LifeCtx, id: string): HTMLElement {
  const sheet = h('section', { class: 'sheet float app-sheet rise goal-sheet' })
  const r = ctx.life?.routines.find((x) => x.id === id)
  if (!r) return sheet
  const k = r.category ? CATEGORY[r.category] : undefined
  sheet.append(
    h('button', { class: 'fbtn small sheet-x', label: L.close, onclick: ctx.close }, icon('close')),
    h(
      'div',
      { class: 'approve-head' },
      emoTile(k?.emo ?? 'routine'),
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: r.title }),
        h('span', {
          class: 'meta',
          text: [r.category ? categoryLabel(r.category) : L.kindRoutine, whenText(r)].join(' · '),
        }),
      ),
    ),
  )
  if (r.plan?.length) {
    const ul = h('ul', { class: 'plan' })
    r.plan.forEach((p, i) => {
      const b = h(
        'button',
        {
          class: p.done ? 'plan-step done' : 'plan-step',
          onclick: (e: MouseEvent) => {
            // Tapping done draws the check right away (does not wait for the PC)
            const b = e.currentTarget as HTMLElement
            if (!p.done) {
              b.classList.add('done')
              const box = b.querySelector('.check') as HTMLElement
              box.replaceChildren(icon('check'))
              drawCheck(box)
            }
            ctx.act({ action: 'goal-step', id: r.id, index: i, done: !p.done })
          },
        },
        h('span', { class: 'check' }, p.done ? icon('check') : undefined),
        h('span', { text: p.text }),
      )
      ul.append(h('li', {}, b))
    })
    sheet.append(h('h2', { class: 'over', text: L.planTitle }), ul)
  }
  sheet.append(h('h2', { class: 'over', text: L.doriTodo }), h('p', { class: 'card-text', text: r.prompt }))
  if (r.log?.length) {
    sheet.append(h('h2', { class: 'over', text: L.progressLog }))
    for (const l of r.log.slice(0, 8))
      sheet.append(
        h(
          'p',
          { class: 'log-line' },
          h('span', { class: 'meta', text: shortTime(l.at) }),
          plain(l.text, 200),
        ),
      )
  } else if (r.lastResult)
    sheet.append(
      h('h2', { class: 'over', text: L.lastResult }),
      h('p', { class: 'card-text', text: plain(r.lastResult, 300) }),
    )
  sheet.append(
    h(
      'div',
      { class: 'sheet-actions' },
      h(
        'button',
        { class: 'btn', onclick: () => (ctx.act({ action: 'routine-run', id: r.id }), ctx.close()) },
        icon('play'),
        r.category ? L.checkInNow : L.tryNow,
      ),
      h(
        'button',
        { class: 'btn-ghost', onclick: () => ctx.fill(L.aboutGoal(r.title)) },
        icon('reply'),
        L.continueInChat,
      ),
    ),
    h(
      'div',
      { class: 'sheet-actions' },
      h('button', {
        class: 'btn-text',
        text: r.enabled ? L.pause : L.resume,
        onclick: () => ctx.act({ action: 'routine-toggle', id: r.id, on: !r.enabled }),
      }),
      h('button', {
        class: 'btn-text danger',
        text: L.delete,
        onclick: () => {
          if (confirm(L.confirmDelete(r.title))) {
            ctx.act({ action: 'routine-delete', id: r.id })
            ctx.close()
          }
        },
      }),
    ),
  )
  return sheet
}

// ── Library ──

const ITEM: Record<LibraryItem['kind'], { icon: IconName; tone: string; label: string; emo: string }> = {
  note: { icon: 'note', tone: 'blue', label: L.itemNote, emo: 'memo' },
  link: { icon: 'link', tone: 'violet', label: L.itemLink, emo: 'link' },
  product: { icon: 'cart', tone: 'amber', label: L.itemProduct, emo: 'shopping' },
  place: { icon: 'place', tone: 'rose', label: L.itemPlace, emo: 'pin' },
  file: { icon: 'image', tone: 'mint', label: L.itemFile, emo: 'picture' },
}

export function libraryView(ctx: LifeCtx): HTMLElement {
  const box = h('section', { class: 'tab-page library' }, ...header(L.libraryTitle))
  const seg = h('div', { class: 'seg' })
  for (const [id, label] of [
    ['made', L.madeSeg],
    ['media', L.mediaSeg],
  ] as const)
    seg.append(
      segBtn(ctx.librarySeg === id, {
        text: label,
        onclick: () => ctx.setLibrarySeg(id),
      }),
    )
  box.append(seg)
  const list = ctx.libraryList.items
  if (!ctx.life) box.append(h('p', { class: 'wait' }, h('span', { class: 'spin' }), L.receiving))
  else if (!list.length)
    box.append(
      empty(
        '',
        ctx.librarySeg === 'media' ? L.noMedia : L.noSaved,
        ctx.librarySeg === 'media' ? L.noMediaSub : L.noSavedSub,
      ),
    )
  for (const it of list) {
    const k = ITEM[it.kind]
    box.append(
      h(
        'button',
        { class: 'card lib-card', onclick: () => ctx.openItem(it.id) },
        // A file with an image gets a small preview (otherwise the kind icon)
        it.thumb ? thumbTile(it.thumb, it.title) : emoTile(k.emo),
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-t', text: it.title }),
          h('span', { class: 'row-d', text: plain(it.body, 70) || hostOf(it.url) }),
          h('span', {
            class: 'meta',
            text: [k.label, it.price, shortTime(it.savedAt)].filter(Boolean).join(' · '),
          }),
        ),
      ),
    )
  }
  const more = moreRow(ctx.libraryList)
  if (more) box.append(more)
  return box
}

function previewImg(b64: string, alt: string, onOpen?: (src: string) => void) {
  const img = h('img', { class: 'item-shot' }) as HTMLImageElement
  img.src = `data:image/jpeg;base64,${b64}`
  img.alt = alt
  if (onOpen) {
    img.classList.add('zoomable')
    img.addEventListener('click', () => onOpen(img.src))
  }
  return img
}

/** Small preview in a list row */
function thumbTile(b64: string, alt: string) {
  const img = h('img', { class: 'lib-thumb' }) as HTMLImageElement
  img.src = `data:image/jpeg;base64,${b64}`
  img.alt = alt
  return img
}

export function itemSheet(ctx: LifeCtx, id: string): HTMLElement {
  const sheet = h('section', { class: 'sheet float app-sheet rise item-sheet' })
  const it = ctx.fullItem(id)
  if (!it) return sheet
  const k = ITEM[it.kind]
  const body = h('div', { class: 'item-body bubble rich' })
  // Only the start was received: the sheet is redrawn when the whole thing arrives
  body.append(rich(it.cut ? `${it.body}…` : it.body))
  sheet.append(
    h('button', { class: 'fbtn small sheet-x', label: L.close, onclick: ctx.close }, icon('close')),
    h(
      'div',
      { class: 'approve-head' },
      it.thumb ? thumbTile(it.thumb, it.title) : emoTile(k.emo),
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: it.title }),
        h('span', {
          class: 'meta',
          text: [k.label, it.price, shortTime(it.savedAt)].filter(Boolean).join(' · '),
        }),
      ),
    ),
    // A picture or invitation Dool2 made: a preview rendered by the PC
    ...(it.image ? [previewImg(it.image, it.title, (src) => ctx.view?.(src, it.title, it.path))] : []),
    ...(it.body ? [body] : []),
    // The original file on the PC: save it on the phone or send it by messenger or mail
    ...(it.path && ctx.fileAction
      ? [
          h(
            'div',
            { class: 'sheet-actions file-actions' },
            h(
              'button',
              { class: 'btn', onclick: () => ctx.fileAction?.(it, 'save') },
              icon('download'),
              L.saveToPhone,
            ),
            h(
              'button',
              { class: 'btn-ghost', onclick: () => ctx.fileAction?.(it, 'share') },
              icon('share'),
              L.send,
            ),
          ),
        ]
      : []),
    h(
      'div',
      { class: 'sheet-actions' },
      it.url ? h('a', { class: 'btn' }, icon('link'), L.openHost(hostOf(it.url))) : undefined,
      h(
        'button',
        { class: 'btn-ghost', onclick: () => ctx.fill(L.aboutItem(it.title)) },
        icon('reply'),
        L.continueTalk,
      ),
    ),
    h('button', {
      class: 'btn-text danger',
      text: L.deleteFromLibrary,
      onclick: () => {
        ctx.act({ action: 'library-delete', id: it.id })
        ctx.close()
      },
    }),
  )
  const a = sheet.querySelector('a.btn') as HTMLAnchorElement | null
  if (a && it.url) {
    a.href = it.url
    a.target = '_blank'
    a.rel = 'noopener'
  }
  return sheet
}

function hostOf(url?: string) {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// ── Assistant panel: upcoming and memory ──

export function upcomingSeg(ctx: LifeCtx): HTMLElement[] {
  const list = (ctx.life?.routines ?? [])
    .filter((r) => r.enabled && r.nextRunAt)
    .sort((a, b) => Date.parse(a.nextRunAt ?? '') - Date.parse(b.nextRunAt ?? ''))
  if (!list.length)
    return [
      h('p', {
        class: 'meta seg-empty',
        text: L.noUpcoming,
      }),
    ]
  return list.map((r) =>
    h(
      'button',
      { class: 'act-row', onclick: () => ctx.openGoal(r.id) },
      emoTile('routine', 'sm'),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: r.title }),
        h('span', { class: 'row-d', text: r.schedule ? scheduleLabel(r.schedule, lang) : '' }),
      ),
      h('span', { class: 'meta', text: r.nextRunAt ? nextText(r.nextRunAt) : '' }),
    ),
  )
}

/** Dool2 settings: what to call me, tone, reply length */
function identityBlock(ctx: LifeCtx): HTMLElement {
  const id = ctx.life?.identity ?? {}
  const name = h('input', { class: 'field' })
  name.id = 'identity-name'
  name.placeholder = L.namePlaceholder
  name.value = id.userName ?? ''
  const save = h('button', { class: 'btn small', text: L.save })
  save.type = 'submit'
  const form = h('form', { class: 'feed-form' }, name, save)
  form.onsubmit = (e) => {
    e.preventDefault()
    ctx.act({ action: 'identity', userName: name.value })
  }
  const seg = <T extends string>(cur: T, opts: [T, string][], pick: (v: T) => void) =>
    h(
      'div',
      { class: 'seg' },
      ...opts.map(([v, label]) => segBtn(cur === v, { text: label, onclick: () => pick(v) })),
    )
  return h(
    'div',
    { class: 'identity' },
    h('p', { class: 'over', text: L.callMe }),
    form,
    h('p', { class: 'over', text: L.tone }),
    seg(
      id.tone ?? 'warm',
      [
        ['warm', L.toneWarm],
        ['neat', L.toneNeat],
        ['buddy', L.toneBuddy],
      ],
      (tone) => ctx.act({ action: 'identity', tone }),
    ),
    h('p', { class: 'over', text: L.length }),
    seg(
      id.length ?? 'normal',
      [
        ['short', L.lengthShort],
        ['normal', L.lengthNormal],
        ['detail', L.lengthDetail],
      ],
      (length) => ctx.act({ action: 'identity', length }),
    ),
    h('p', { class: 'over', text: L.memory }),
  )
}

export function memorySeg(ctx: LifeCtx): HTMLElement[] {
  const out: HTMLElement[] = [identityBlock(ctx)]
  const input = h('input', { class: 'field' })
  input.id = 'memory-add'
  input.placeholder = L.memoryPlaceholder
  const add = h('button', { class: 'btn small', text: L.remember })
  add.type = 'submit'
  const form = h('form', { class: 'feed-form' }, input, add)
  form.onsubmit = (e) => {
    e.preventDefault()
    const t = input.value.trim()
    if (!t) return
    ctx.act({ action: 'memory-add', text: t })
    input.value = ''
  }
  out.push(
    h('p', {
      class: 'meta seg-note',
      text: L.memoryNote,
    }),
    form,
  )
  const list = ctx.life?.memory ?? []
  if (!list.length) out.push(h('p', { class: 'meta seg-empty', text: L.noMemory }))
  for (const m of list)
    out.push(
      h(
        'div',
        { class: 'act-row' },
        h('span', { class: 'tile sm mint' }, icon('brain', 'i')),
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-t', text: m.text }),
          h('span', {
            class: 'row-d',
            text: `${m.source === 'user' ? L.writtenByMe : L.fromChat} · ${shortTime(m.at)}`,
          }),
        ),
        h(
          'button',
          {
            class: 'fbtn small',
            label: L.forget,
            onclick: () => ctx.act({ action: 'memory-delete', id: m.id }),
          },
          icon('trash'),
        ),
      ),
    )
  // What Dool2 knows: facts seen after logging in and applications or bookings it made (with the date seen and the as-of time)
  const know = ctx.life?.know ?? []
  if (know.length) {
    out.push(
      h('p', {
        class: 'meta seg-note',
        text: L.knowNote,
      }),
    )
    for (const k of know)
      out.push(
        h(
          'div',
          { class: 'act-row' },
          h(
            'span',
            { class: `tile sm ${k.kind === 'done' ? 'violet' : 'mint'}` },
            icon(k.kind === 'done' ? 'check' : 'brain', 'i'),
          ),
          h(
            'span',
            { class: 'row-text' },
            h('span', { class: 'row-t', text: `${k.title}: ${k.value}` }),
            h('span', {
              class: 'row-d',
              text: [
                k.source,
                k.basis,
                shortTime(k.seenAt),
                k.kind === 'done'
                  ? k.state === 'done'
                    ? L.knowEnded
                    : k.next
                      ? L.knowNext(shortTime(k.next))
                      : L.knowRunning
                  : '',
              ]
                .filter(Boolean)
                .join(' · '),
            }),
          ),
          h(
            'button',
            {
              class: 'fbtn small',
              label: L.delete,
              onclick: () => ctx.act({ action: 'know-delete', id: k.id }),
            },
            icon('trash'),
          ),
        ),
      )
  }
  return out
}
