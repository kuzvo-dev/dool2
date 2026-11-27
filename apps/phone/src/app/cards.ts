// Phone app: cards attached to a reply (products, stays, restaurants), made images, connect and login cards in the chat
import type {
  CardsRecordMessage,
  ConnectRecordMessage,
  LoginRecordMessage,
  LoginRequestView,
  MadeImageRecordMessage,
  TellRecordMessage,
} from '@dool2/protocol'
import { needsPcChrome } from '@dool2/protocol/connect'
import { josa } from '@dool2/protocol/rich'
import { doori, h, icon, rich, withLogo } from '../dom.js'
import { mdCred } from '../locales/main-d-cred.js'
import { ENTER_SUFFIX, PICK_LABEL } from '../region/kr/main-c-labels.js'
import { cardIdFor, connectFor, hostOf } from './approval-cards.js'
import { ask } from './ask.js'
import { loginFor } from './chat.js'
import { mark, mCards, send, st } from './core.js'
import { feedPager, lifeAct } from './lists.js'
import { startLook } from './login-sheets.js'
import { openOverlay, render, setTab } from './shell.js'
import {
  connectFailCard,
  connectHow,
  connectPeek,
  connectStepList,
  connectWaiting,
  openRemote,
  pickChoices,
} from './work.js'

// ── Cards attached to a reply (products, stays, restaurants) ──
// The phone does not talk to outside servers for photos. It asks the PC and gets a data: URL (kept while the app is open)
const thumbCache = new Map<string, string | null>()
const thumbAsked = new Set<string>()
function wantThumb(url: string) {
  if (thumbCache.has(url) || thumbAsked.has(url)) return
  thumbAsked.add(url)
  void send({ kind: 'thumb', url })
}
/** Blocks waiting for a photo (result blocks get a Promise) */
const thumbWaiting = new Map<string, ((data: string | undefined) => void)[]>()
export function thumbOf(url: string): Promise<string | undefined> {
  const have = thumbCache.get(url)
  if (have !== undefined) return Promise.resolve(have ?? undefined)
  return new Promise((done) => {
    thumbWaiting.set(url, [...(thumbWaiting.get(url) ?? []), done])
    wantThumb(url)
  })
}
export function gotThumb(url: string, data: string | undefined) {
  thumbAsked.delete(url)
  thumbCache.set(url, data ?? null)
  for (const done of thumbWaiting.get(url) ?? []) done(data)
  thumbWaiting.delete(url)
  if (!data) return
  for (const img of document.querySelectorAll<HTMLImageElement>('img[data-thumb]'))
    if (img.dataset.thumb === url) showThumb(img, data)
}
function showThumb(img: HTMLImageElement, data: string) {
  img.onload = () => img.classList.add('on')
  img.src = data
}

/** A picture made by the image AI: large under the reply, tap to fill the screen */
export function madeInline(rec: MadeImageRecordMessage): HTMLElement {
  const box = h('button', { class: 'made-photo', label: mCards.viewBig(rec.title) }, icon('image', 'i'))
  let src = ''
  void thumbOf(`photo:${rec.photo}`).then((data) => {
    if (!data) return
    src = data
    const img = h('img', {}) as HTMLImageElement
    img.src = data
    img.alt = rec.title
    box.replaceChildren(img)
  })
  box.addEventListener('click', () => {
    if (!src) return
    mark('Open made image full screen')
    openViewer(src, rec.title, rec.path)
  })
  return h('div', { class: 'made' }, box)
}

/** Full-screen picture view: tap anywhere to close */
export function openViewer(src: string, title: string, path?: string) {
  const img = h('img', {}) as HTMLImageElement
  img.src = src
  img.alt = title
  const close = () => view.remove()
  const view = h(
    'div',
    { class: 'viewer', onclick: close },
    h(
      'div',
      { class: 'viewer-top' },
      h('span', { text: title }),
      h('button', { class: 'icon-btn', label: mCards.close, onclick: close }, icon('close', 'i')),
    ),
    img,
    path ? h('p', { class: 'viewer-note', text: mCards.originalOnPc(path) }) : undefined,
  )
  document.body.append(view)
}

export function cardsInline(rec: CardsRecordMessage): HTMLElement {
  return h(
    'div',
    { class: rec.shape === 'portrait' ? 'pick-cards portrait' : 'pick-cards' },
    ...rec.cards.map((c) => {
      let img: HTMLImageElement | undefined
      if (c.image) {
        img = document.createElement('img')
        img.alt = ''
        img.dataset.thumb = c.image
      }
      if (img && c.image) {
        const have = thumbCache.get(c.image)
        if (have) showThumb(img, have)
        else wantThumb(c.image)
      }
      return h(
        'div',
        { class: 'pick-card' },
        h(
          'div',
          { class: 'pick-photo' },
          img ?? icon('box', 'i'),
          c.badge ? h('span', { class: 'pick-badge', text: c.badge }) : undefined,
        ),
        h(
          'div',
          { class: 'pick-body' },
          h('span', { class: 'pick-title', text: c.title }),
          // Keep the slot even when empty (so price and info lines line up across cards)
          h('span', { class: 'pick-price', text: c.price ?? '' }),
          h('span', { class: 'pick-note', text: c.note ?? '' }),
        ),
        h(
          'div',
          { class: 'pick-actions' },
          c.url
            ? h('button', {
                text: mCards.view,
                onclick: () => {
                  mark(`Card view ${new URL(c.url ?? '').host}`)
                  // Open in the browser outside the app (or that service's app)
                  const a = document.createElement('a')
                  a.href = c.url ?? ''
                  a.target = '_blank'
                  a.rel = 'noopener noreferrer'
                  a.click()
                },
              })
            : undefined,
          h('button', {
            class: 'go',
            text: mCards.pickThis,
            onclick: () => ask(mCards.pickThisAsk(c.title, c.price ?? '')),
          }),
        ),
      )
    }),
  )
}

export function tellInline(rec: TellRecordMessage): HTMLElement {
  const answered = feedPager.items.find((f) => f.id === rec.id)?.answered
  const say = rec.ask
  return h(
    'div',
    { class: 'card tell-card' },
    h('div', { class: 'card-label' }, doori('', 22), mCards.tellLabel),
    h('strong', { class: 'tell-title', text: rec.title }),
    rec.body ? h('div', { class: 'tell-body rich' }, rich(rec.body)) : undefined,
    rec.from ? h('p', { class: 'meta', text: rec.from }) : undefined,
    say
      ? answered
        ? h('p', {
            class: 'meta tell-done',
            text: answered === 'yes' ? mCards.tellHandedOver : mCards.tellPassed,
          })
        : h(
            'div',
            { class: 'tell-actions' },
            h('button', {
              class: 'btn small',
              text: rec.askLabel || mCards.tellDoIt,
              onclick: () => {
                lifeAct({ action: 'feed-answer', id: rec.id, answer: 'yes' })
                ask(say)
              },
            }),
            h('button', {
              class: 'btn-ghost small',
              text: mCards.tellNoThanks,
              onclick: () => lifeAct({ action: 'feed-answer', id: rec.id, answer: 'no' }),
            }),
          )
      : undefined,
  )
}

export function connectInline(rec: ConnectRecordMessage, live = true): HTMLElement {
  const it = connectFor(rec)
  // If the service list has not arrived yet (app just opened), quietly hold the spot and redraw when it does
  if (!it && !st.services)
    return h('p', { class: 'done-line connect-line' }, icon('link'), mCards.connectCard)
  if (!it) return h('p', { class: 'done-line' }, icon('link'), mCards.connectNotFound(rec.service))
  const c = it.card
  const mark = (big = false) =>
    withLogo(
      h('span', {
        class: big ? 'svc-mark' : 'svc-mark sm',
        text: /^\d+/.exec(c.name)?.[0] ?? [...c.name][0] ?? '',
      }),
      c.id,
    )
  // Connecting again (switching the account) shows the work and the question, not the old "connected" line: tapping an
  // account showed only a toast while the card said "connected" (11-26)
  const busy = st.connecting.has(c.id)
  // Connected, but its tools run in the PC's Chrome: while Chrome or the extension is off, say so, not "connected"
  if (!busy && it.connectedAt && needsPcChrome(c) && st.pc && !st.pc.extension)
    return h('p', { class: 'done-line connect-line off' }, mark(), mCards.chromeOffFor(c.name))
  // Which account it is, when Dool2 read it on the service's page (ADR 0041)
  if (!busy && it.connectedAt)
    return h(
      'p',
      { class: 'done-line connect-line' },
      mark(),
      it.signedInAs ? mCards.isConnectedAs(c.name, it.signedInAs) : mCards.isConnected(c.name),
    )
  if (!live) return h('p', { class: 'done-line connect-line' }, mark(), mCards.cardOf(c.name))
  // Official integrations (Gmail and so on) log in through PC Chrome until they are ready: same card as a browser connection
  const browser = c.how === 'browser' || c.how === 'official'
  // When waiting for an account or code: show what is needed and an enter button (not just a spinner)
  const fail = busy ? undefined : st.connectFails.get(c.id)
  if (fail) return connectFailCard(c, fail, mark(true))
  const wait = busy ? connectWaiting(c.id) : undefined
  if (wait?.kind === 'confirm') {
    // Approval in a phone app: nothing to enter, and Dool2 carries on by itself once tapped
    const step = st.connectSteps.get(c.id)?.at(-1)?.text ?? mCards.tapConfirmOnPhone
    return h(
      'div',
      { class: 'card approve-card connect-card ask' },
      h(
        'div',
        { class: 'approve-head' },
        mark(true),
        h('div', {}, h('strong', { text: step }), h('span', { class: 'meta', text: wait.detail ?? '' })),
        h('span', { class: 'spin' }),
      ),
      connectStepList(c.id, true),
      h(
        'div',
        { class: 'approve-actions' },
        h('button', {
          class: 'btn-ghost',
          text: mCards.viewPcScreen,
          onclick: () => openRemote(Number(wait.id), c.id),
        }),
      ),
    )
  }
  if (wait?.label === PICK_LABEL) {
    // Pick one (which account to use and so on): show the question as is, with a pick button
    const ask = st.connectSteps.get(c.id)?.at(-1)?.text ?? mCards.pickOne
    return h(
      'div',
      { class: 'card approve-card connect-card ask' },
      h(
        'div',
        { class: 'approve-head' },
        mark(true),
        h(
          'div',
          {},
          h('strong', { text: ask }),
          h('span', { class: 'meta', text: mCards.afterPick(c.name) }),
        ),
      ),
      connectStepList(c.id, true),
      pickChoices(wait.id, c.id) ??
        h(
          'div',
          { class: 'approve-actions' },
          h('button', {
            class: 'btn',
            text: mCards.pick,
            onclick: () => openOverlay({ kind: 'info', id: wait.id }),
          }),
        ),
    )
  }
  if (wait) {
    const what = wait.label.replace(ENTER_SUFFIX, '')
    return h(
      'div',
      { class: 'card approve-card connect-card ask' },
      h(
        'div',
        { class: 'approve-head' },
        mark(true),
        h(
          'div',
          {},
          h('strong', { text: mCards.isNeeded(what, josa(what, '이/가')) }),
          h('span', { class: 'meta', text: mCards.afterEnter(c.name) }),
        ),
      ),
      connectStepList(c.id, true),
      h(
        'div',
        { class: 'approve-actions' },
        h('button', {
          class: 'btn',
          text: wait.label,
          onclick: () => openOverlay({ kind: wait.kind === 'login' ? 'login' : 'info', id: wait.id }),
        }),
      ),
    )
  }
  return h(
    'div',
    { class: 'card approve-card connect-card' },
    h(
      'div',
      { class: 'approve-head' },
      mark(true),
      h(
        'div',
        {},
        // Before a sign-in tab exists Dool2 is only looking (is Chrome signed in, which accounts): no screen to watch yet
        h('strong', {
          text: busy
            ? st.connectLive.has(c.id)
              ? mCards.loggingIn(c.name)
              : mCards.lookingAt(c.name)
            : mCards.connectTitle(c.name),
        }),
        h('span', {
          class: 'meta',
          text: busy
            ? st.connectLive.has(c.id)
              ? mCards.watchBelow
              : mCards.lookingMeta
            : browser
              ? connectHow(c)
              : mCards.turnOnInConnect,
        }),
      ),
      busy && !st.connectSteps.get(c.id)?.length ? h('span', { class: 'spin' }) : undefined,
    ),
    busy ? connectPeek(c.id) : undefined,
    busy
      ? connectStepList(c.id)
      : h(
          'div',
          { class: 'approve-actions' },
          h('button', {
            class: 'btn',
            // Google and the like: one tap opens the account chooser itself (no sheet in between, ADR 0041)
            text: c.account?.pick ? mdCred.pickAccount : mCards.connectDo,
            onclick: () => {
              // Look first: the PC checks whether Chrome is already signed in (or which Google accounts it has) and
              // this card asks; the ID and password card opens only when needed (ADR 0041)
              if (browser && st.needCreds.has(c.id)) return openOverlay({ kind: 'connect', id: c.id })
              if (browser) return startLook(c.id)
              st.tab = 'connect'
              st.connectDetail = c.id
              render()
            },
          }),
        ),
  )
}

/**
 * Connection state for the same site as a login request (a card Dool2 raised while working).
 * If an easy login is in progress or stopped on the person's turn, the login card shows that state too (no going in circles)
 */
export function loginLink(origin: string) {
  const cid = cardIdFor(origin)
  if (!cid) return undefined
  const busy = st.connecting.has(cid)
  const fail = st.connectFails.get(cid)
  return busy || fail ? { cid, busy, fail } : undefined
}

/** Tapping a login card under "waiting for me": the screen if it is the person's turn, the chat (card) if in progress, else the login sheet */
export function openLogin(l: LoginRequestView) {
  const link = loginLink(l.origin)
  if (link?.fail?.tabId !== undefined && link.fail.reason === 'human')
    return openRemote(link.fail.tabId, link.cid)
  if (link?.busy) return setTab('chat')
  openOverlay({ kind: 'login', id: l.id })
}

export function loginInline(rec: LoginRecordMessage): HTMLElement {
  const r = loginFor(rec)
  // Same site being linked by easy login, or stopped: same look as the connect card (steps, reason, open screen)
  const link = r?.status === 'pending' ? loginLink(r.origin) : undefined
  if (link) return connectInline({ kind: 'connect', service: link.cid }, true)
  if (!r || r.status !== 'pending')
    return h(
      'p',
      { class: 'done-line' },
      icon('lock'),
      r?.status === 'saved' ? mCards.loginSaved(r.site) : mCards.loginDone(rec.site || mCards.siteFallback),
    )
  return h(
    'div',
    { class: 'card approve-card' },
    h(
      'div',
      { class: 'approve-head' },
      withLogo(h('span', { class: 'svc-mark', text: [...r.site][0] ?? '' }), cardIdFor(r.origin)),
      h(
        'div',
        {},
        h('strong', { text: mCards.loginNeeded(r.site) }),
        h('span', { class: 'meta', text: hostOf(r.origin) }),
      ),
    ),
    h(
      'div',
      { class: 'approve-actions' },
      h('button', {
        class: 'btn',
        text: mCards.loginDo,
        onclick: () => openOverlay({ kind: 'login', id: r.id }),
      }),
    ),
  )
}
