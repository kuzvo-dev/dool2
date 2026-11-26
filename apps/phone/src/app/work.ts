// Phone app: the remote screen and the working card (the PC tab Dool2 works in, shown small and live in the chat)
import type { ConnectStep, PhoneToPc, TaskRecordMessage, WorkRecordMessage } from '@dool2/protocol'
import { type ConnectionItem, SOCIAL_LABEL } from '@dool2/protocol/connect'
import { dropEnglishLines, finishProgress } from '@dool2/protocol/rich'
import {
  bareHost,
  cardForHost,
  doneLine,
  groupSteps,
  type PlaceCard,
  type WorkGroup,
} from '@dool2/protocol/work-steps'
import { doori, h, type IconName, icon, rich, withLogo } from '../dom.js'
import { lang } from '../lang.js'
import { mainWork } from '../locales/main-a-work.js'
import { springTo } from '../motion.js'
import { ID_LOGIN, OPEN_SCREEN_TAIL } from '../region/kr/main-a-chat.js'
import { cardIdFor } from './approval-cards.js'
import { mCards, send, st, type Tab, tChat } from './core.js'
import { openOverlay, remoteUi, render } from './shell.js'
import { openSide } from './threads.js'

// ── Remote screen: see and tap the PC tab Dool2 handed over, from the phone (turned into a live view in the next step) ──

let screenTimer: ReturnType<typeof setTimeout> | undefined
/** Live screen: when an image arrives, ask for the next one right away (3 to 5 per second). If none comes in 2 seconds, ask again */
export const frameTimes: number[] = []
export function nextScreen(tabId: number) {
  clearTimeout(screenTimer)
  const ask = () => {
    if (st.screen.name === 'remote' && st.screen.tabId === tabId && document.visibilityState === 'visible') {
      void send({ kind: 'screen', tabId })
      screenTimer = setTimeout(ask, 2000)
    }
  }
  screenTimer = setTimeout(ask, 120)
}

/** Images per second (last 2 seconds) */
export function fps() {
  const now = performance.now()
  while (frameTimes.length && now - (frameTimes[0] ?? 0) > 2000) frameTimes.shift()
  return Math.max(1, Math.round(frameTimes.length / 2))
}

/** Tab before the remote screen opened (closing returns there: to the chat if opened from the chat) */
export let remoteFrom: Tab = 'chat'
export function openRemote(tabId: number, connectId?: string) {
  if (st.screen.name === 'app') remoteFrom = st.tab
  st.screenShot = { tabId }
  st.overlay = undefined
  st.screen = { name: 'remote', tabId, ...(connectId ? { connectId } : {}) }
  render()
  void send({ kind: 'screen', tabId })
}

export function remote(input: Omit<Extract<PhoneToPc, { kind: 'remote' }>, 'kind' | 'tabId'>) {
  if (st.screen.name !== 'remote') return
  const tabId = st.screen.tabId
  clearTimeout(screenTimer)
  if (st.screenShot) st.screenShot.busy = true
  remoteUi?.update(st.screenShot, fps())
  void send({ kind: 'remote', tabId, ...input })
}

// ── Working screen: while Dool2 works on the web, that tab shown small and live in the chat ──

let workTimer: ReturnType<typeof setTimeout> | undefined
export function pollWork() {
  clearTimeout(workTimer)
  const tick = () => {
    const tab = st.work.tabId
    const watching =
      st.work.web &&
      st.busy &&
      tab !== undefined &&
      st.tab === 'chat' &&
      st.screen.name === 'app' &&
      document.visibilityState === 'visible'
    if (!watching) return
    void send({ kind: 'screen', tabId: tab })
    workTimer = setTimeout(tick, 1500)
  }
  workTimer = setTimeout(tick, 300)
}

/** While connecting: the screen Dool2 is logging in on, shown small and live on the chat's connect card */
let connectTimer: ReturnType<typeof setTimeout> | undefined
export function pollConnect() {
  clearTimeout(connectTimer)
  const tick = () => {
    const tabs = [...st.connectLive.entries()].filter(([id]) => st.connecting.has(id))
    const watching =
      tabs.length && st.tab === 'chat' && st.screen.name === 'app' && document.visibilityState === 'visible'
    if (!watching) return
    for (const [, l] of tabs) void send({ kind: 'screen', tabId: l.tabId })
    connectTimer = setTimeout(tick, 1500)
  }
  connectTimer = setTimeout(tick, 300)
}

/** Login screen inside a connect card (tap to open it large and do it yourself) */
export function connectPeek(id: string): HTMLElement | undefined {
  const l = st.connectLive.get(id)
  if (!l?.shot) return undefined
  const img = h('img', { class: 'connect-shot' })
  img.dataset.tab = String(l.tabId)
  img.src = `data:image/jpeg;base64,${l.shot}`
  return h(
    'button',
    { class: 'wp-peek', label: mainWork(lang).loginPeekLabel, onclick: () => openRemote(l.tabId, id) },
    h(
      'span',
      { class: 'wp-bar' },
      h('span', { text: mainWork(lang).loginPeekTitle }),
      h('span', { class: 'wp-live', text: mainWork(lang).now }),
    ),
    img,
  )
}

/** When each step started (same order as st.steps) */
export const stepAt: number[] = []
/** What the tool did and where, per step (same order as st.steps) */
export const stepInfo: { act: string; place?: string }[] = []
export const workVars: {
  /** Last site opened (used by browser_ tools that do not know their tab) */
  workHost: string | undefined
  /** Site just opened with browser_open: the next new tab belongs to it */
  openedHost: string | undefined
  /** Whether earlier steps are expanded on the working card (folded at the start of each turn) */
  workAllSteps: boolean
} = { workHost: undefined, openedHost: undefined, workAllSteps: false }
/** Tab id -> that tab's site. Filled from screen image addresses and "new tab right after opening" notices (so rows stay right across many tabs) */
export const tabHosts = new Map<number, string>()
/** Whether the view Dool2 is looking at stays expanded (folded by default; once expanded it stays so for the next task) */
const PEEK_KEY = 'dool2.workPeek'
const peekOpen = () => localStorage.getItem(PEEK_KEY) === '1'

/** Site address -> connect card name (catchtable.co.kr -> CatchTable), or the address if none */
function siteName(host: string): string {
  return cardForHost(host, placeCards())?.name ?? bareHost(host)
}

function placeCards(): PlaceCard[] {
  return (st.services ?? []).map((s) => ({
    id: s.card.id,
    name: s.card.name,
    ...(s.card.site ? { site: s.card.site } : {}),
  }))
}

function secs(ms: number) {
  return mainWork(lang).secs(Math.max(1, Math.round(ms / 1000)))
}

/** Icon at the left of a row: service logo (first letter if none), line icons for PC apps, files and Dool2's own work. A spinner or check sits in the corner */
function groupMark(g: WorkGroup, state: 'done' | 'doing'): HTMLElement {
  const glyph: IconName | undefined =
    g.kind === 'app' ? 'pc' : g.kind === 'file' ? 'note' : g.kind === 'doori' ? 'brain' : undefined
  const mark = h('span', { class: `svc-mark ws-mark${glyph ? ' plain' : ''}`, text: glyph ? '' : g.letter })
  if (glyph) mark.append(icon(glyph, 'i'))
  else withLogo(mark, g.cardId)
  return h(
    'span',
    { class: 'ws-ico' },
    mark,
    h('span', { class: `ws-badge ${state}` }, state === 'done' ? icon('check', 'i') : ''),
  )
}

/** One service row: icon · name / what it does · time taken */
function groupRow(g: WorkGroup, state: 'done' | 'doing'): HTMLElement {
  const sub = state === 'doing' ? g.act : g.kind === 'doori' ? '' : doneLine(g, lang)
  return h(
    'li',
    { class: `ws ${state}` },
    groupMark(g, state),
    h(
      'span',
      { class: 'wt' },
      h('b', { text: g.title }),
      sub && sub !== g.title ? h('span', { class: 'wsub', text: sub }) : '',
    ),
    h('span', { class: 't', text: state === 'done' && g.ms !== undefined ? secs(g.ms) : '' }),
  )
}

/** Whether it is the same row (so a redraw can leave it alone) */
const groupSig = (g: WorkGroup, state: string) => `${g.key}|${g.title}|${g.act}|${g.count}|${state}`

/** Rows for the current work (finished rows include time taken) */
function liveGroups(): WorkGroup[] {
  const steps = st.steps.map((text, i) => {
    const next = stepAt[i + 1]
    const at = stepAt[i]
    const info = stepInfo[i]
    return {
      text,
      act: info?.act ?? text,
      ...(info?.place ? { place: info.place } : {}),
      ...(next && at ? { ms: next - at } : {}),
    }
  })
  return groupSteps(steps, placeCards(), lang)
}

/** Last of Dool2's narration lines (not a tool name) */
function lastNarration(): string | undefined {
  for (let i = st.steps.length - 1; i >= 0; i--) {
    const t = st.steps[i] as string
    if (t !== stepInfo[i]?.act) return t
  }
  return undefined
}

function clockText() {
  const from = st.workFrom ?? stepAt[0]
  if (!from) return ''
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Working card in the chat: Dool2 + what it is saying now · per-service rows (spinner -> check) · a folded "what Dool2 is looking at" view.
 * The view is folded by default (small preview + live dot); tap to expand, tap the expanded view to open it large
 */
export function workPanel(): HTMLElement {
  const toggle = h(
    'button',
    { class: 'wp-peek-bar', label: mainWork(lang).viewExpand },
    h('img', { class: 'work-thumb' }),
    h('span', { class: 'wp-peek-t', text: mainWork(lang).viewTitle }),
    h('span', { class: 'wp-live', text: mainWork(lang).now }),
    icon('chevron', 'i wp-chev'),
  )
  const big = h(
    'button',
    {
      class: 'wp-peek wp-peek-in',
      label: mainWork(lang).viewBig,
      onclick: () => st.work.tabId !== undefined && openRemote(st.work.tabId),
    },
    h('img', { class: 'work-shot' }),
    h('span', { class: 'wp-hint', text: mainWork(lang).viewHint }),
  )
  const wrap = h('div', { class: 'wp-view' }, toggle, h('div', { class: 'wp-shot-box' }, h('div', {}, big)))
  const setOpen = (open: boolean) => {
    wrap.classList.toggle('open', open)
    toggle.setAttribute('aria-expanded', String(open))
  }
  setOpen(peekOpen())
  toggle.addEventListener('click', () => {
    const open = !wrap.classList.contains('open')
    localStorage.setItem(PEEK_KEY, open ? '1' : '0')
    setOpen(open)
  })
  const clock = h('span', { class: 'wp-clock' })
  const draft = h('details', { class: 'wc-draft' }, h('summary', {}), h('div', { class: 'rich' }))
  const take = h('button', {
    class: 'btn-ghost sm wp-take',
    text: tChat.takeAsIs,
    onclick: () => void send({ kind: 'conversation-accept' }),
  })
  const card = h(
    'div',
    { class: 'work-panel' },
    h('div', { class: 'wp-head' }, doori('thinking', 26), h('b', { class: 'wp-title' }), clock),
    h('ol', { class: 'wp-steps' }),
    draft,
    wrap,
    h(
      'div',
      { class: 'wp-foot' },
      take,
      h('span', { class: 'grow' }),
      h('button', {
        class: 'btn-text sm wc-stop',
        text: tChat.stopWork,
        onclick: () => void send({ kind: 'conversation-cancel' }),
      }),
    ),
  )
  // Time taken: updated every second only while the card is on screen
  const tick = () => {
    if (!card.isConnected && clock.textContent) return
    clock.textContent = clockText()
    setTimeout(tick, 1000)
  }
  tick()
  updateWorkPanel(card)
  return card
}

export function updateWorkPanel(card: HTMLElement) {
  const fp = finishProgress(st.conv, { running: st.busy, checking: st.checking })
  const draftMsg = fp?.draft ? st.conv.find((m) => m.id === fp.draft) : undefined
  // Text written after tools is the draft of the answer
  const writing = st.live && st.steps.length ? dropEnglishLines(st.live, lang) : ''
  const title = st.checking
    ? tChat.checkingTitle
    : fp?.rounds
      ? fp.next
        ? tChat.continuingTitle(fp.next)
        : tChat.continuingPlain
      : writing
        ? tChat.writingTitle
        : (lastNarration() ?? mainWork(lang).workingTitle)
  const draftBox = card.querySelector<HTMLDetailsElement>('.wc-draft')
  const draftText = writing || draftMsg?.text || ''
  if (draftBox) {
    draftBox.hidden = !draftText
    const sum = draftBox.querySelector('summary')
    const label = fp?.rounds && !st.checking ? tChat.earlierDraft : tChat.seeDraft
    if (sum && sum.textContent !== label) sum.textContent = label
    const body = draftBox.querySelector<HTMLElement>('.rich')
    if (body && body.dataset.text !== draftText) {
      body.dataset.text = draftText
      body.replaceChildren(rich(draftText))
    }
  }
  const take = card.querySelector<HTMLElement>('.wp-take')
  if (take) take.hidden = !draftMsg
  const t = card.querySelector('.wp-title')
  if (t && t.textContent !== title) t.textContent = title
  // Current screen: only when working on the web and an image has arrived
  const view = card.querySelector<HTMLElement>('.wp-view')
  const shot = st.work.web ? st.work.shot : undefined
  if (view) view.hidden = !shot
  if (shot) {
    const src = `data:image/jpeg;base64,${shot}`
    for (const img of card.querySelectorAll<HTMLImageElement>('.work-shot, .work-thumb'))
      if (img.src !== src) img.src = src
  }
  // Rows: only what changed. New rows rise in from below, and a row that just finished pops its check
  const list = card.querySelector<HTMLElement>('.wp-steps')
  if (!list) return
  const groups = liveGroups()
  const hidden = workVars.workAllSteps ? 0 : Math.max(0, groups.length - 4)
  const shown = groups.slice(hidden)
  const more = list.querySelector<HTMLElement>('.ws.more')
  if (hidden) {
    const text = mainWork(lang).earlier(hidden)
    if (!more)
      list.prepend(
        h(
          'li',
          { class: 'ws more' },
          h('button', {
            text,
            label: mainWork(lang).earlierExpand,
            onclick: () => {
              workVars.workAllSteps = true
              updateWorkPanel(card)
            },
          }),
        ),
      )
    else if (more.textContent !== text) (more.firstElementChild as HTMLElement).textContent = text
  } else more?.remove()
  // One row per place (key): existing rows are moved (a place visited again goes to the bottom) and only changed rows are redrawn
  const old = new Map<string, HTMLElement>()
  // If two rows share a key keep only one (a leftover row would never be removed and would pile up)
  for (const r of list.querySelectorAll<HTMLElement>('.ws:not(.more)')) {
    const k = r.dataset.key ?? ''
    if (old.has(k)) r.remove()
    else old.set(k, r)
  }
  const keep = new Set(shown.map((g) => g.key))
  for (const [k, r] of old) if (!keep.has(k)) r.remove()
  shown.forEach((g, i) => {
    const state = i === shown.length - 1 ? 'doing' : 'done'
    const sig = groupSig(g, state)
    const row = old.get(g.key)
    let el = row
    if (row?.dataset.sig !== sig) {
      el = groupRow(g, state)
      el.dataset.key = g.key
      el.dataset.sig = sig
      if (row) row.replaceWith(el)
    }
    if (!el) return
    // If it is not in place, move it (to position i after the "more" row)
    const at = list.querySelectorAll('.ws:not(.more)')[i]
    if (at !== el) list.insertBefore(el, at ?? null)
    if (!row && (i > 0 || groups.length > 1))
      springTo(
        el,
        [
          { opacity: 0, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'none' },
        ],
        'item',
      )
    else if (row && state === 'done' && row.classList.contains('doing')) {
      const s = el.querySelector('.ws-badge')
      if (s) springTo(s, [{ transform: 'scale(0.4)' }, { transform: 'scale(1)' }], 'pop')
    }
  })
}

/**
 * Whether the connection is waiting for a person: the last step asks for an account or verification code and that request is still open.
 * If no steps arrived (the app opened later, or an older PC), check for an open login request for connecting instead
 */
export function connectWaiting(id: string): ConnectStep['ask'] | undefined {
  const open = (a: NonNullable<ConnectStep['ask']>) =>
    a.kind === 'confirm'
      ? st.connecting.has(id)
      : a.kind === 'login'
        ? st.logins.get(a.id)?.status === 'pending'
        : st.infos.has(a.id)
  const last = st.connectSteps.get(id)?.at(-1)?.ask
  if (last) return open(last) ? last : undefined
  if (!st.connecting.has(id)) return undefined
  const login = [...st.logins.values()].find((l) => l.status === 'pending' && l.connect)
  if (login) return { kind: 'login', id: login.id, label: mainWork(lang).enter(login.site) }
  const info = [...st.infos.values()].at(-1)
  return info ? { kind: 'info', id: info.id, label: mainWork(lang).enter(info.label) } : undefined
}

/**
 * Card for a connection that did not finish: the reason plus one thing to do right away.
 * When it is the person's turn (CAPTCHA, identity check) the card offers [Open screen]; once done, Dool2 marks it connected by itself
 */
export function connectFailCard(
  c: ConnectionItem['card'],
  fail: NonNullable<ReturnType<typeof st.connectFails.get>>,
  mark: HTMLElement,
): HTMLElement {
  const tab = fail.tabId
  const openScreen = () => tab !== undefined && openRemote(tab, c.id)
  const retry = () => openOverlay({ kind: 'connect', id: c.id })
  // If Dool2 raised an ID and password card, that comes first: it is the user's turn (measured 11-21 Asiana: the card was hidden behind "carrying on")
  const waiting = [...st.logins.values()].find((l) => l.status === 'pending' && cardIdFor(l.origin) === c.id)
  if (waiting)
    return h(
      'div',
      { class: 'card approve-card connect-card ask' },
      h(
        'div',
        { class: 'approve-head' },
        mark,
        h(
          'div',
          {},
          h('strong', { text: mainWork(lang).enterCreds(c.name) }),
          h('span', { class: 'meta', text: mainWork(lang).enterCredsMeta }),
        ),
      ),
      h(
        'div',
        { class: 'approve-actions' },
        h('button', {
          class: 'btn',
          text: mainWork(lang).enterBtn,
          onclick: () => openOverlay({ kind: 'login', id: waiting.id }),
        }),
      ),
    )
  // While Dool2 carries on in the chat after the automatic login stopped: it is not a failure but work in progress (progress shows on the working card right below)
  if (agentOn(fail))
    return h(
      'div',
      { class: 'card approve-card connect-card' },
      h(
        'div',
        { class: 'approve-head' },
        mark,
        h(
          'div',
          {},
          h('strong', { text: mainWork(lang).takingOver }),
          h('span', {
            class: 'meta',
            text: mainWork(lang).takingOverMeta,
          }),
        ),
        h('span', { class: 'spin' }),
      ),
    )
  const view =
    fail.reason === 'wrong'
      ? {
          title: mainWork(lang).wrongTitle,
          meta: mainWork(lang).wrongMeta,
          main: h('button', { class: 'btn', text: mainWork(lang).reenter, onclick: retry }),
          sub: undefined,
        }
      : fail.reason === 'human'
        ? {
            title: mainWork(lang).humanTitle,
            meta: mainWork(lang).humanMeta(fail.message.replace(OPEN_SCREEN_TAIL, '')),
            main:
              tab !== undefined
                ? h('button', { class: 'btn', text: mainWork(lang).openScreen, onclick: openScreen })
                : undefined,
            sub: h('button', { class: 'btn-ghost', text: mainWork(lang).startOver, onclick: retry }),
          }
        : {
            title: mainWork(lang).failTitle(c.name),
            meta: fail.message,
            // Viewing the screen directly is left off the card and shows only when trying again (the login screen) fails: not needing it is best (user feedback)
            main: h('button', { class: 'btn', text: mainWork(lang).retry, onclick: retry }),
            sub: undefined,
          }
  return h(
    'div',
    { class: 'card approve-card connect-card ask' },
    h(
      'div',
      { class: 'approve-head' },
      mark,
      h('div', {}, h('strong', { text: view.title }), h('span', { class: 'meta', text: view.meta })),
    ),
    h('div', { class: 'approve-actions' }, view.sub, view.main),
  )
}

/**
 * A short choice (which Google account) answered right on the card: one button per option, no sheet in between.
 * Long lists still open the sheet
 */
export function pickChoices(id: string, cardId: string): HTMLElement | undefined {
  const q = st.infos.get(id)
  const options = q?.field === 'choice' ? (q.options ?? []) : []
  if (!options.length || options.length > 5) return undefined
  return h(
    'div',
    { class: 'pick-list' },
    ...options.map((o, i) =>
      h('button', {
        class: i === options.length - 1 && options.length > 1 ? 'btn-ghost' : 'btn',
        text: o,
        onclick: () => {
          void send({ kind: 'info-answer', id, value: o })
          st.infos.delete(id)
          // Show it moving at once (a step with a spinner) until the PC's next step arrives
          const steps = st.connectSteps.get(cardId) ?? []
          st.connectSteps.set(cardId, [...steps, { text: mCards.goingWith(o), at: Date.now() }])
          render()
        },
      }),
    ),
  )
}

/** Whether Dool2 is carrying on after the automatic login stopped (replying, or took over within 20 seconds) */
export function agentOn(fail: { agent?: boolean; at?: number }): boolean {
  return Boolean(fail.agent) && (st.busy || Date.now() - (fail.at ?? 0) < 20_000)
}

/** Connect card description, matching how the service really works (never say "ID and password" for a social-login-only service) */
export function connectHow(c: ConnectionItem['card']): string {
  // Google and the like: the person picks an account already in Chrome, no password (ADR 0041)
  if (c.account?.pick) return mainWork(lang).howPick
  const social = (c.social ?? []).slice(0, 2).map((p) => SOCIAL_LABEL[p])
  const idLogin = ID_LOGIN.test(c.login ?? '')
  if (social.length && !idLogin) return mainWork(lang).howSocialOnly(social.join('·'))
  if (social.length) return mainWork(lang).howSocialOrId(social.join('·'))
  return mainWork(lang).howId
}

/** Steps while connecting: finished steps get a ✓ and time taken, the current step a spinner */
export function connectStepList(id: string, waiting = false): HTMLElement | undefined {
  const all = st.connectSteps.get(id)
  // When waiting for a person the card title already says "X needed", so the last step with the same words is dropped
  const steps = waiting && all?.at(-1)?.ask ? all.slice(0, -1) : all
  if (!steps?.length) return undefined
  const list = h('ol', { class: 'wp-steps connect-steps' })
  steps.forEach((s, i) => {
    const next = steps[i + 1]
    list.append(stepRow(s.text, next ? 'done' : 'doing', next ? next.at - s.at : undefined))
  })
  // Only the newly arrived step rises in from below
  const last = list.lastElementChild
  if (last && steps.length > 1)
    springTo(
      last,
      [
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'none' },
      ],
      'item',
    )
  return list
}

/** One step row while connecting: finished steps get a ✓ and time taken, the current step a spinner */
function stepRow(text: string, state: 'done' | 'doing', ms?: number) {
  return h(
    'li',
    { class: `ws ${state}` },
    h('span', { class: 's' }, state === 'done' ? icon('check', 'i') : ''),
    h('span', { class: 'wt', text }),
    h('span', { class: 't', text: ms !== undefined ? secs(ms) : '' }),
  )
}

/**
 * After it ends: a folded line above the reply, "icon stack · Looked at 4 places · 41s" (tap to open the per-service rows).
 * Older records (no place info) read "How it worked · N steps"
 */
/**
 * A task's card (ProgressCard, ADR 0038): work handed over runs on its own while the conversation goes on. Steps,
 * elapsed time, stop and take-as-is while it runs; one line when it ended. Details opens the task's own chat
 */
export function taskInline(rec: TaskRecordMessage): HTMLElement {
  const v = st.tasks.get(rec.id)
  const ended = !v || v.status === 'done' || v.status === 'stopped' || v.status === 'failed'
  const groups = v ? groupSteps(v.steps, placeCards(), lang) : []
  const open = h('button', {
    class: 'btn-text sm',
    text: tChat.taskOpen,
    onclick: () => v && openSide(v.threadId, rec.title),
  })
  if (ended) {
    const ms = v?.endedAt ? Date.parse(v.endedAt) - Date.parse(v.startedAt ?? v.createdAt) : 0
    const line = !v
      ? ''
      : v.status === 'done'
        ? `${mainWork(lang).stepCount(v.count)} · ${secs(ms)}`
        : v.status === 'stopped'
          ? tChat.taskStopped
          : tChat.taskFailed
    const card = h(
      'div',
      { class: 'work-panel done task-card' },
      h(
        'div',
        { class: 'wd-head' },
        h('span', { class: 'wd-ok' }, icon(v?.status === 'done' ? 'check' : 'close', 'i')),
        h('span', { class: 'wd-title', text: rec.title }),
        h('span', { class: 'wd-meta', text: line }),
      ),
      ...(v ? [h('div', { class: 'wp-foot' }, h('span', { class: 'grow' }), open)] : []),
    )
    card.dataset.task = rec.id
    return card
  }
  const now =
    v.status === 'waiting'
      ? tChat.taskWaiting(v.ahead ?? 0)
      : v.status === 'needs-you'
        ? tChat.taskNeedsYou
        : v.status === 'checking'
          ? tChat.checkingTitle
          : v.continuing && v.now
            ? tChat.continuingTitle(v.now)
            : v.now
              ? `${v.now}…`
              : tChat.taskStarting
  const from = Date.parse(v.startedAt ?? v.createdAt)
  const clock = h('span', { class: 'wp-clock' })
  const tick = () => {
    if (!clock.isConnected && clock.textContent) return
    const s = Math.max(0, Math.floor((Date.now() - from) / 1000))
    clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    setTimeout(tick, 1000)
  }
  tick()
  const act = (action: 'stop' | 'accept') => () => void send({ kind: 'task', id: v.id, action })
  const steps = h('ol', { class: 'wp-steps' })
  for (const g of groups.slice(-3)) steps.append(groupRow(g, 'done'))
  const parts: HTMLElement[] = [
    h(
      'div',
      { class: 'wp-head' },
      doori(v.status === 'needs-you' ? '' : 'thinking', 26),
      h('b', { class: 'wp-title', text: rec.title }),
      clock,
    ),
    h('p', { class: 'wc-now', text: now }),
    steps,
  ]
  if (v.notes) parts.push(h('p', { class: 'wc-notes meta', text: tChat.taskNotes(v.notes) }))
  if (v.draft)
    parts.push(
      h(
        'details',
        { class: 'wc-draft' },
        h('summary', { text: tChat.seeDraft }),
        h('div', { class: 'rich' }, rich(v.draft)),
      ),
    )
  parts.push(
    h(
      'div',
      { class: 'wp-foot' },
      ...(v.draft || v.continuing
        ? [h('button', { class: 'btn-ghost sm', text: tChat.takeAsIs, onclick: act('accept') })]
        : []),
      h('span', { class: 'grow' }),
      open,
      h('button', { class: 'btn-text sm wc-stop', text: tChat.stopWork, onclick: act('stop') }),
    ),
  )
  const card = h(
    'div',
    { class: `work-panel task-card${v.status === 'needs-you' ? ' needs-you' : ''}` },
    ...parts,
  )
  card.dataset.task = rec.id
  return card
}

export function workDone(rec: WorkRecordMessage): HTMLElement {
  const groups = groupSteps(rec.steps, placeCards(), lang)
  const places = [
    ...new Map(
      groups.filter((g) => g.kind === 'web' || g.kind === 'service').map((g) => [g.key, g]),
    ).values(),
  ]
  const list = h('ol', { class: 'wp-steps' })
  if (rec.count > rec.steps.length)
    list.append(h('li', { class: 'ws more', text: mainWork(lang).trimmed(rec.count - rec.steps.length) }))
  for (const g of groups) list.append(groupRow(g, 'done'))
  list.hidden = true
  const lead = places.length
    ? h(
        'span',
        { class: 'wd-stack' },
        ...places
          .slice(0, 4)
          .map((g) => withLogo(h('span', { class: 'svc-mark', text: g.letter }), g.cardId)),
      )
    : h('span', { class: 'wd-ok' }, icon('check', 'i'))
  const title = places.length
    ? places.length === 1
      ? mainWork(lang).workedAt(places[0]?.title ?? '')
      : mainWork(lang).lookedAt(places.length)
    : rec.host
      ? mainWork(lang).workedAt(siteName(rec.host))
      : mainWork(lang).process
  const head = h(
    'button',
    { class: 'wd-head', label: mainWork(lang).processExpand },
    lead,
    h('span', { class: 'wd-title', text: title }),
    h('span', {
      class: 'wd-meta',
      text: places.length ? secs(rec.ms) : `${mainWork(lang).stepCount(rec.count)} · ${secs(rec.ms)}`,
    }),
    icon('chevron', 'i wd-chev'),
  )
  head.setAttribute('aria-expanded', 'false')
  const card = h('div', { class: 'work-panel done' }, head, list)
  head.addEventListener('click', () => {
    const open = list.hidden !== false
    list.hidden = !open
    card.classList.toggle('open', open)
    head.setAttribute('aria-expanded', String(open))
    if (open)
      springTo(
        list,
        [
          { opacity: 0, transform: 'translateY(-6px)' },
          { opacity: 1, transform: 'none' },
        ],
        'item',
      )
  })
  return card
}
