// Phone app: the remote screen and the working card (the PC tab Dool2 works in, shown small and live in the chat)
import type { ConnectStep, PhoneToPc, StepDetail } from '@dool2/protocol'
import { type ConnectionItem, SOCIAL_LABEL } from '@dool2/protocol/connect'
import type { PlaceCard } from '@dool2/protocol/work-steps'
import { h, icon } from '../dom.js'
import { lang } from '../lang.js'
import { mainWork } from '../locales/main-a-work.js'
import { springTo } from '../motion.js'
import { ID_LOGIN, OPEN_SCREEN_TAIL } from '../region/kr/main-a-chat.js'
import { cardIdFor } from './approval-cards.js'
import { mCards, send, st, type Tab } from './core.js'
import { openOverlay, remoteUi, render } from './shell.js'

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
export const stepInfo: { act: string; place?: string; detail?: StepDetail[] }[] = []
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

function _placeCards(): PlaceCard[] {
  return (st.services ?? []).map((s) => ({
    id: s.card.id,
    name: s.card.name,
    ...(s.card.site ? { site: s.card.site } : {}),
  }))
}

function secs(ms: number) {
  return mainWork(lang).secs(Math.max(1, Math.round(ms / 1000)))
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
