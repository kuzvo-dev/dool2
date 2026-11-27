// Phone app: the toast, rendering (shell, header, tabs, composer, page), the continuation suggestion and the remote screen view

import type { TaskView } from '@dool2/protocol'
import { ideaCatalog } from '@dool2/protocol/ideas'
import { doori, h, type IconName, icon } from '../dom.js'
import { matchTextBox, recentTalk, ghostRest as suggestRest } from '../ghost.js'
import { lang } from '../lang.js'
import { feedView, goalsView, libraryView } from '../life-views.js'
import { mainWork } from '../locales/main-a-work.js'
import { mdSide } from '../locales/main-d-side.js'
import { acceptGhost, playFlip, playSeg, Spring, springTo, tick } from '../motion.js'
import { haptic } from '../native.js'
import { createRemote, type RemoteScreen } from '../remote.js'
import { hostOf } from './approval-cards.js'
import { ask, keepConv } from './ask.js'
import { dayAtTop, syncChat } from './chat.js'
import { app, mark, type Overlay, type Screen, send, st, type Tab, tShell } from './core.js'
import { pendingApprovals, pendingLogins } from './decide.js'
import { ideasView } from './ideas.js'
import { lifeCtx, visiblePager } from './lists.js'
import { connectView } from './login-sheets.js'
import { renderOverlay } from './overlays.js'
import { introView, pairingView, unsupportedView } from './pairing.js'
import { pullToRefresh } from './resync.js'
import { consented, consentView, demoBar } from './review.js'
import { settingsView } from './settings.js'
import { infoWaitBar, sideOverlay, sideView } from './threads.js'
import { fps, pollConnect, pollWork, remote, remoteFrom } from './work.js'

// ── Toast ──

/** Toast bar (onTap when it can be tapped, for example [Open screen]) */
let toastTap: (() => void) | undefined
export function toast(text: string, onTap?: () => void) {
  mark(`toast ${text}`)
  st.toast = text
  toastTap = onTap
  render()
  setTimeout(() => {
    if (st.toast === text) {
      st.toast = undefined
      render()
    }
  }, 3200)
}
// ── Screens ──

export const shellVars = {
  /** While viewing the bottom of the chat, stay at the bottom when new messages arrive */
  stickToBottom: true,
  /** Number of steps of the current task already shown (only new steps animate) */
  shownSteps: 0,
}
export let shell:
  | {
      top: HTMLElement
      page: HTMLElement
      chat: HTMLElement
      composerBox: HTMLElement
      textarea: HTMLTextAreaElement
      sendBtn: HTMLButtonElement
      tabs: HTMLElement
      overlay: HTMLElement
      toast: HTMLElement
    }
  | undefined

/**
 * When re-rendering for news from the PC: draw once per frame.
 * While a reply streams in, news arrives dozens of times a second, and drawing on each one rebuilt the whole screen that often
 */
let renderQueued = 0
export function renderSoon() {
  if (renderQueued) return
  renderQueued = requestAnimationFrame(() => {
    renderQueued = 0
    render()
  })
}

export function render() {
  if (renderQueued) {
    cancelAnimationFrame(renderQueued)
    renderQueued = 0
  }
  keepConv()
  const s = st.screen
  // Before the first use: what goes where (review.ts consent, once)
  if (s.name === 'app' && !consented()) {
    shell = undefined
    app.replaceChildren(consentView())
    return
  }
  if (s.name !== 'app') {
    shell = undefined
    const view =
      s.name === 'intro'
        ? introView()
        : s.name === 'unsupported'
          ? unsupportedView()
          : s.name === 'pairing'
            ? pairingView(s)
            : s.name === 'side'
              ? sideView(s.id)
              : remoteView(s)
    if (s.name === 'remote') {
      // Keep the same remote screen as is (re-inserting it closes the keyboard)
      remoteToast ??= h('div', { class: 'toast float-toast' })
      remoteToast.textContent = st.toast ?? ''
      remoteToast.hidden = !st.toast
      if (app.firstElementChild !== view) app.replaceChildren(view, remoteToast)
      return
    }
    const t = h('div', { class: 'toast float-toast', text: st.toast ?? '' })
    t.hidden = !st.toast
    app.replaceChildren(view, t, ...(s.name === 'side' ? sideOverlay() : []))
    return
  }
  if (!shell) buildShell()
  renderTop()
  renderPage()
  renderComposer()
  renderTabs()
  renderOverlay()
  // Demo: a bar on top with the way out
  const bar = demoBar()
  const oldBar = app.querySelector(':scope > .demo-bar')
  if (bar && !oldBar) app.append(bar)
  else if (!bar) oldBar?.remove()
  if (shell) {
    shell.toast.textContent = st.toast ?? ''
    shell.toast.hidden = !st.toast
    shell.toast.classList.toggle('tap', Boolean(toastTap))
    shell.toast.onclick = toastTap
      ? () => {
          const f = toastTap
          toastTap = undefined
          st.toast = undefined
          f?.()
        }
      : null
  }
  // After re-rendering: move the segment highlight and switch knob from the old spot to the new one
  playSeg()
  playFlip()
}

function buildShell() {
  const top = h('header', { class: 'app-top' })
  const page = h('main', { class: 'app-page' })
  const chat = h('div', { class: 'chat-list' })
  // A date that floats on top while scrolling to show when the visible message was sent (fades when scrolling stops)
  const dayPill = h('div', { class: 'day-pill' })
  dayPill.setAttribute('aria-hidden', 'true')
  let dayPillTimer: ReturnType<typeof setTimeout> | undefined
  page.addEventListener(
    'scroll',
    () => {
      // The bottom tabs are not hidden on scroll: hidden, there was no visible way to other tabs (user feedback)
      if (st.tab === 'chat') {
        syncNowBar()
        shellVars.stickToBottom = page.scrollHeight - page.scrollTop - page.clientHeight < 80
        const label = dayAtTop(page, chat)
        dayPill.textContent = label
        dayPill.classList.toggle('on', !!label)
        clearTimeout(dayPillTimer)
        dayPillTimer = setTimeout(() => dayPill.classList.remove('on'), 1400)
      }
      // Feed and library: near the bottom, load the next page
      else if (page.scrollHeight - page.scrollTop - page.clientHeight < 600) visiblePager()?.more()
    },
    { passive: true },
  )
  const textarea = h('textarea')
  textarea.rows = 1
  textarea.placeholder = tShell.askPlaceholder
  textarea.setAttribute('aria-label', tShell.askLabel)
  textarea.addEventListener('input', () => {
    st.draft = textarea.value
    autosize(textarea)
    renderComposer()
  })
  textarea.addEventListener('keydown', (e) => {
    // Accept the continuation suggestion: Tab, or → at the end of the text
    if (
      ghostRest &&
      (e.key === 'Tab' || (e.key === 'ArrowRight' && textarea.selectionStart === textarea.value.length)) &&
      !e.isComposing
    ) {
      e.preventDefault()
      takeGhost()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault()
      ask(st.draft)
      textarea.value = ''
      autosize(textarea)
    }
  })
  const plus = h(
    'button',
    { class: 'cbtn plus', label: tShell.more, onclick: () => openOverlay({ kind: 'plus' }) },
    icon('plus', 'i md'),
  )
  const sendBtn = h('button', { class: 'send-btn', label: tShell.send })
  sendBtn.addEventListener('click', () => {
    if (!st.draft.trim() && !st.attach && working()) {
      haptic('confirm')
      return void send({ kind: 'conversation-cancel' })
    }
    ask(st.draft)
    textarea.value = ''
    autosize(textarea)
    textarea.focus()
  })
  const attachBox = h('div', { class: 'attach-preview' })
  const ghost = h('div', { class: 'ghost' })
  ghost.hidden = true
  ghost.setAttribute('aria-hidden', 'true')
  const field = h('div', { class: 'ghost-wrap' }, textarea, ghost)
  const composerBox = h('div', { class: 'composer float app-composer' }, attachBox, plus, field, sendBtn)
  const tabs = h('nav', { class: 'tabs app-tabs', label: tShell.tabsLabel })
  const overlay = h('div', { class: 'app-overlay' })
  const toast = h('div', { class: 'toast float-toast' })
  toast.setAttribute('role', 'status')
  app.replaceChildren(h('div', { class: 'app-shell' }, top, page, dayPill, composerBox, tabs, overlay, toast))
  shell = { top, page, chat, composerBox, textarea, sendBtn, tabs, overlay, toast }
  ghostEl = ghost
  pullToRefresh(page)
}

// ── Continuation suggestion: if what is typed matches the start of an idea, show the rest faded (tap or press Tab to accept) ──

let ghostEl: HTMLElement | undefined
let ghostRest = ''

function ghostFor(draft: string): string {
  return suggestRest({
    draft,
    talk: recentTalk(st.conv),
    mine: (st.life?.ideas ?? []).map((i) => i.text),
    catalog: ideaCatalog(st.services ?? [], lang).flatMap((g) => g.items.map((i) => i.ask)),
  })
}

function updateGhost() {
  const g = ghostEl
  const t = shell?.textarea
  if (!g || !t) return
  const rest = ghostFor(st.draft)
  // Only on one line: once the text wraps to two lines the letters no longer line up, so it is hidden
  const oneLine = t.scrollHeight <= Number.parseFloat(getComputedStyle(t).minHeight) + 2
  if (!rest || !oneLine) {
    ghostRest = ''
    g.hidden = true
    g.replaceChildren()
    return
  }
  if (rest === ghostRest && !g.hidden) return
  ghostRest = rest
  // Drawn on top with the same font and padding as the input
  matchTextBox(g, t)
  const typed = h('span', { class: 'ghost-typed', text: st.draft })
  const letters = [...rest].map((ch) => h('span', { class: 'g', text: ch }))
  const restEl = h('span', { class: 'ghost-rest', onclick: takeGhost }, ...letters)
  const key = h(
    'button',
    { class: 'ghost-key', label: tShell.ghostKey, onclick: takeGhost },
    icon('chevron', 'i'),
  )
  g.replaceChildren(typed, restEl, key)
  g.hidden = false
  // Fade the right edge only when it overflows (if it all fits, keep the last letter sharp)
  restEl.classList.toggle('clip', restEl.scrollWidth > restEl.clientWidth + 1)
  springTo(restEl, [{ opacity: 0 }, { opacity: 1 }], 'fade')
  springTo(
    key,
    [
      { opacity: 0, transform: 'scale(0.6)' },
      { opacity: 1, transform: 'none' },
    ],
    'squash',
  )
}

function takeGhost() {
  const g = ghostEl
  const t = shell?.textarea
  if (!g || !t || !ghostRest) return
  const full = st.draft + ghostRest
  ghostRest = ''
  // The faded letters light up from the left with a pop, then are swapped for the real text
  const letters = [...g.querySelectorAll<HTMLElement>('.ghost-rest .g')]
  acceptGhost(letters)
  g.querySelector('.ghost-key')?.remove()
  g.classList.add('taking')
  t.classList.add('ghosting')
  setTimeout(
    () => {
      st.draft = full
      t.value = full
      t.classList.remove('ghosting')
      g.classList.remove('taking')
      g.hidden = true
      g.replaceChildren()
      autosize(t)
      renderComposer()
      t.focus()
      t.setSelectionRange(full.length, full.length)
    },
    reducedMotion() ? 0 : 260 + letters.length * 16,
  )
}

/** Input height: springs when lines are added or removed */
export function autosize(t: HTMLTextAreaElement) {
  const h0 = t.offsetHeight
  t.style.height = 'auto'
  const h1 = Math.min(t.scrollHeight, 132)
  t.style.height = `${h1}px`
  if (h0 && Math.abs(h1 - h0) > 1) springTo(t, [{ height: `${h0}px` }, { height: `${h1}px` }], 'field')
}

const TAB_ORDER: Tab[] = ['chat', 'feed', 'ideas', 'goals', 'library']

export function setTab(tab: Tab) {
  const from = TAB_ORDER.indexOf(st.tab)
  const to = TAB_ORDER.indexOf(tab)
  mark(`tab ${tab}`)
  st.tab = tab
  st.overlay = undefined
  if (tab === 'chat') shellVars.stickToBottom = true
  if (tab === 'connect') st.connectDetail = undefined
  render()
  const page = shell?.page
  if (!page) return
  page.scrollTo({ top: tab === 'chat' ? page.scrollHeight : 0 })
  if (tab === 'chat') {
    pollWork()
    pollConnect()
  }
  // Slide in from the side in tab order
  if (from >= 0 && to >= 0 && from !== to && !reducedMotion())
    page.animate(
      [
        { opacity: 0, transform: `translateX(${to > from ? 18 : -18}px)` },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    )
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** The PC's most urgent health issue as one short line (empty when all is well) */
export function healthLine(): string {
  const h = st.health
  const top = h?.issues[0]
  if (!h || !top) return ''
  const reset = top === 'ai-limit' && h.limitResetsAt ? new Date(h.limitResetsAt) : undefined
  const at =
    reset && !Number.isNaN(reset.getTime())
      ? tShell.limitUntil(reset.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' }))
      : ''
  const text: Record<typeof top, string> = {
    sleeping: tShell.healthSleeping,
    'ai-signed-out': tShell.healthAiSignedOut,
    'ai-limit': tShell.healthAiLimit,
    slow: tShell.healthSlow,
    busy: tShell.healthBusy,
    'low-disk': tShell.healthLowDisk,
    'no-extension': tShell.healthNoExtension,
  }
  return text[top] + at
}

/** Header: menu · Dool2 (what it is doing now) · my PC */
function renderTop() {
  const t = shell?.top
  if (!t) return
  const waiting = pendingApprovals().length + pendingLogins().length
  const mood =
    !st.online || st.pcSilent
      ? 'sleeping'
      : waiting
        ? 'asking'
        : st.busy || st.pending.length
          ? 'working'
          : ''
  const status = !st.online
    ? tShell.pcConnecting
    : st.pcSilent
      ? tShell.pcSilent
      : waiting
        ? pendingApprovals().length
          ? tShell.waitApproval
          : tShell.waitLogin
        : st.busy || st.pending.length
          ? (st.steps.at(-1) ?? tShell.answering)
          : healthLine()
  const pcOn = st.online && !st.pcSilent
  const pcName = shortPc(st.saved?.pcName)
  // Leave it alone if nothing changed. Rebuilding the buttons on every update while a reply streams in
  // made them vanish mid-tap, so the menu and Dool2 buttons sometimes could not be pressed
  const sig = [mood, status, waiting ? 1 : 0, pcOn ? 1 : 0, pcName].join('|')
  if (t.dataset.sig === sig && t.childElementCount) return
  t.dataset.sig = sig
  if (!t.childElementCount)
    t.replaceChildren(
      h(
        'button',
        { class: 'fbtn', label: tShell.menu, onclick: () => openOverlay({ kind: 'drawer' }) },
        icon('menu'),
      ),
      h(
        'button',
        { class: 'agent', label: tShell.openAgent, onclick: () => openOverlay({ kind: 'agent' }) },
        h('span', { class: 'agent-av' }),
        h('span', { class: 'agent-tag' }),
      ),
      h(
        'button',
        { class: 'fpill', label: tShell.myPc, onclick: () => setTab('settings') },
        h('span', { class: 'dot' }),
        h('span', { class: 'fpill-name' }),
      ),
    )
  const av = t.querySelector<HTMLElement>('.agent-av')
  if (av && av.dataset.mood !== mood) {
    av.dataset.mood = mood
    av.replaceChildren(doori(mood))
  }
  t.querySelector('.fpill .dot')?.classList.toggle('work', pcOn)
  const nameEl = t.querySelector('.fpill-name')
  if (nameEl && nameEl.textContent !== pcName) nameEl.textContent = pcName
  // Status island: when the text changes, spring from the old size to the new one (width lands first, height follows); the text fades out and back in
  const old = t.querySelector<HTMLElement>('.agent-tag')
  if (!old || old.dataset.status === status) return
  const before = old.dataset.status !== undefined ? { w: old.offsetWidth, h: old.offsetHeight } : undefined
  const tag = h(
    'span',
    { class: 'agent-tag' },
    tShell.agentName,
    status && h('span', { class: waiting ? 'ask' : !pcOn ? 'off' : '', text: status }),
  )
  tag.dataset.status = status
  old.replaceWith(tag)
  if (before) {
    const w = tag.offsetWidth
    const ht = tag.offsetHeight
    if (Math.abs(w - before.w) > 1) springTo(tag, [{ width: `${before.w}px` }, { width: `${w}px` }], 'lead')
    if (Math.abs(ht - before.h) > 1)
      springTo(tag, [{ height: `${before.h}px` }, { height: `${ht}px` }], 'soft')
    const line = tag.querySelector('span')
    if (line)
      springTo(
        line,
        [
          { opacity: 0, filter: 'blur(4px)', transform: 'translateY(3px)' },
          { opacity: 1, filter: 'blur(0)', transform: 'none' },
        ],
        'fade',
      )
  }
}

function shortPc(name?: string) {
  if (!name) return tShell.myPc
  return name.length > 8 ? `${name.slice(0, 7)}…` : name
}

export function openOverlay(o: Overlay) {
  mark(o ? `open ${o.kind}` : 'close')
  // Closing the vault sheet clears any password that was shown
  if (o?.kind !== 'vault') st.vaultShown = undefined
  st.overlay = o
  render()
}

export let pillStop: (() => void) | undefined

export function renderTabs() {
  const t = shell?.tabs
  if (!t) return
  const waiting = pendingApprovals().length + pendingLogins().length
  const items: [Tab, IconName, string][] = [
    ['chat', 'chat', tShell.tabChat],
    ['feed', 'feed', tShell.tabFeed],
    ['ideas', 'idea', tShell.tabIdeas],
    ['goals', 'goal', tShell.tabGoals],
    ['library', 'library', tShell.tabLibrary],
  ]
  // Build the buttons once: rebuilding would cut the animation
  if (!t.querySelector('.tab')) {
    t.classList.add('has-pill')
    t.replaceChildren(
      h('span', { class: 'tab-pill' }),
      ...items.map(([id, ic, label]) =>
        h(
          'button',
          { class: 'tab', label, onclick: () => setTab(id) },
          icon(ic),
          h('span', { class: 'tab-label', text: label }),
          h('span', { class: 'badge' }),
        ),
      ),
    )
    items.forEach(([id], i) => {
      ;(t.querySelectorAll('.tab')[i] as HTMLElement).dataset.tab = id
    })
  }
  const btns = [...t.querySelectorAll<HTMLElement>('.tab')]
  const pill = t.querySelector<HTMLElement>('.tab-pill') as HTMLElement
  const ready = t.dataset.ready === '1'
  // On tablets the tab bar is a vertical bar on the left: the pill moves up and down
  const vertical = getComputedStyle(t).flexDirection === 'column'
  const pos = (e: HTMLElement) => (vertical ? e.offsetTop : e.offsetLeft)
  const size = (e: HTMLElement) => (vertical ? e.offsetHeight : e.offsetWidth)
  const [P, S] = vertical ? (['top', 'height'] as const) : (['left', 'width'] as const)
  const before = new Map(btns.map((b) => [b, pos(b)]))
  const pillFrom = { x: pos(pill), w: size(pill) }
  let changed = false
  for (const b of btns) {
    const on = b.dataset.tab === st.tab
    if (b.classList.contains('on') !== on) changed = true
    b.classList.toggle('on', on)
    if (on) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
    ;(b.querySelector('.badge') as HTMLElement).hidden = !(b.dataset.tab === 'feed' && waiting > 0)
  }
  const active = btns.find((b) => b.classList.contains('on'))
  pill.hidden = !active
  if (!active) return
  pill.style.removeProperty(vertical ? 'left' : 'top')
  pill.style.removeProperty(vertical ? 'width' : 'height')
  // If the screen is mid-change and a cell has size 0, measure again next time
  if (!size(active)) return
  pill.style[P] = `${pos(active)}px`
  pill.style[S] = `${size(active)}px`
  t.dataset.ready = '1'
  if (!ready || !changed || reducedMotion()) return
  // Pill: the leading edge lands first and the trailing edge follows later, so it stretches and then shrinks while moving
  const toA = pos(active)
  const toB = toA + size(active)
  const fwd = toA > pillFrom.x
  const A = new Spring(pillFrom.x).use(fwd ? 'trail' : 'lead')
  const B = new Spring(pillFrom.x + pillFrom.w).use(fwd ? 'lead' : 'trail')
  A.t = toA
  B.t = toB
  pillStop?.()
  pillStop = tick((dt) => {
    A.step(dt)
    B.step(dt)
    pill.style[P] = `${A.x.toFixed(2)}px`
    pill.style[S] = `${Math.max(8, B.x - A.x).toFixed(2)}px`
    return !(A.resting && B.resting)
  })
  // The other tabs spring back into place; the chosen tab's icon squashes then pops, and its name floats up (reference values: bar 340 28, squash 520 14)
  for (const b of btns) {
    const dx = (before.get(b) ?? 0) - pos(b)
    if (dx)
      springTo(
        b,
        [{ transform: vertical ? `translateY(${dx}px)` : `translateX(${dx}px)` }, { transform: 'none' }],
        'bar',
      )
  }
  const svg = active.querySelector('svg')
  if (svg) springTo(svg, [{ transform: 'scale(0.72)' }, { transform: 'scale(1)' }], 'squash')
  const label = active.querySelector('.tab-label')
  if (label)
    springTo(
      label,
      [
        { opacity: 0, transform: 'translateX(-6px)' },
        { opacity: 1, transform: 'none' },
      ],
      'fade',
      {
        delay: 60,
        fill: 'backwards',
      },
    )
  haptic('tick')
}

function renderComposer() {
  if (!shell) return
  const { composerBox, textarea, sendBtn } = shell
  composerBox.hidden = st.tab !== 'chat'
  // A line above the composer to reopen a waiting input card that was closed
  let slot = composerBox.querySelector<HTMLElement>(':scope > .info-wait-slot')
  if (!slot) {
    slot = h('div', { class: 'info-wait-slot' })
    composerBox.prepend(slot)
  }
  // A waiting input card wins; otherwise the task that is running, while its card is out of sight
  const wait = infoWaitBar()
  slot.replaceChildren(...(wait.length ? wait : nowBar()))
  const attachBox = composerBox.querySelector('.attach-preview') as HTMLElement
  if (st.attach) {
    const img = h('img')
    img.src = `data:image/jpeg;base64,${st.attach}`
    img.alt = tShell.photoToSend
    attachBox.replaceChildren(
      img,
      h(
        'button',
        {
          class: 'fbtn small',
          label: tShell.removePhoto,
          onclick: () => {
            st.attach = undefined
            render()
          },
        },
        icon('close'),
      ),
    )
    attachBox.hidden = false
  } else {
    attachBox.replaceChildren()
    attachBox.hidden = true
  }
  if (textarea.value !== st.draft) {
    textarea.value = st.draft
    autosize(textarea)
  }
  const has = Boolean(st.draft.trim() || st.attach)
  const stop = !has && working()
  // Send <-> stop: the old icon spins and shrinks, and the new icon pops in
  const mode = stop ? 'stop' : 'send'
  if (sendBtn.dataset.mode !== mode) {
    const first = !sendBtn.dataset.mode
    sendBtn.dataset.mode = mode
    const ic = icon(mode, 'i md')
    sendBtn.replaceChildren(ic)
    if (!first)
      springTo(ic, [{ transform: `scale(0) rotate(${stop ? -90 : 90}deg)` }, { transform: 'none' }], 'morph')
  }
  sendBtn.setAttribute('aria-label', stop ? tShell.stop : tShell.send)
  sendBtn.classList.toggle('ready', has)
  sendBtn.classList.toggle('stop', stop)
  sendBtn.disabled = !st.online || (!has && !working())
  if (!shell.textarea.classList.contains('ghosting')) updateGhost()
}

function renderPage() {
  if (!shell) return
  const { page, chat } = shell
  page.dataset.tab = st.tab
  if (st.tab === 'chat') {
    pageDrawn = ''
    if (page.firstChild !== chat || page.childNodes.length !== 1) page.replaceChildren(chat)
    syncChat()
    // (If the user went to another tab meanwhile, do not scroll that tab to the end)
    if (shellVars.stickToBottom)
      requestAnimationFrame(() => {
        if (st.tab === 'chat') page.scrollTo({ top: page.scrollHeight })
      })
    return
  }
  const ctx = lifeCtx()
  const view =
    st.tab === 'feed'
      ? feedView(ctx)
      : st.tab === 'ideas'
        ? ideasView()
        : st.tab === 'goals'
          ? goalsView(ctx)
          : st.tab === 'library'
            ? libraryView(ctx)
            : st.tab === 'settings'
              ? settingsView()
              : connectView()
  // Do not touch it if the shape is unchanged. Re-inserting the whole tab on every news item from the PC
  // makes the picture flicker and drops the cursor and keyboard of text typed in the search box
  const drawn = `${st.tab}\n${view.outerHTML}`
  if (drawn === pageDrawn && page.firstChild && page.firstChild !== chat) return
  pageDrawn = drawn
  const y = page.scrollTop
  const typing = typingIn(page)
  page.replaceChildren(view)
  page.scrollTop = y
  typing?.()
}

/** Shape of the tab screen drawn last (the chat tab syncs only changed messages separately) */
let pageDrawn = ''

/** When a tab screen redraws part of itself (search): remember the current shape (so the next news does not re-insert it whole) */
export function pageSettled() {
  const view = shell?.page.firstElementChild
  if (view && st.tab !== 'chat') pageDrawn = `${st.tab}\n${view.outerHTML}`
}

/**
 * Before re-rendering: if the user is typing inside, remember the text and cursor and give them back to the new field.
 * (Only fields with an id. If the new field was drawn with a value already, keep that value)
 */
export function typingIn(box: HTMLElement): (() => void) | undefined {
  const fields = [...box.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[id], textarea[id]')]
    .filter((f) => f.type !== 'file' && f.value)
    .map((f) => ({ id: f.id, value: f.value }))
  const a = document.activeElement
  const active =
    (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) && a.id && box.contains(a)
      ? { id: a.id, at: safeCaret(a) }
      : undefined
  if (!fields.length && !active) return undefined
  return () => {
    for (const f of fields) {
      const el = document.getElementById(f.id) as HTMLInputElement | null
      if (!el || !box.contains(el) || el.value) continue
      el.value = f.value
      // So things drawn from a field (the verification code box) follow along
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    if (!active) return
    const el = document.getElementById(active.id) as HTMLInputElement | null
    if (!el || !box.contains(el)) return
    el.focus({ preventScroll: true })
    if (active.at !== null)
      try {
        el.setSelectionRange(active.at, active.at)
      } catch {}
  }
}

/** Cursor position (asking an email or number field throws an error) */
function safeCaret(el: HTMLInputElement | HTMLTextAreaElement): number | null {
  try {
    return el.selectionStart
  } catch {
    return null
  }
}

/** PC screen (one still image at a time for now; replaced by a live view at the sign-in step) */
export let remoteUi: RemoteScreen | undefined
let remoteToast: HTMLElement | undefined

/** Remote screen: built once per tab, then only the image and info change (remote.ts) */
function remoteView(v: Extract<Screen, { name: 'remote' }>) {
  if (remoteUi?.tabId !== v.tabId) {
    const back = () => {
      st.screen = { name: 'app' }
      remoteUi = undefined
      // Back to where it was opened from (the chat if opened from a connection card, that service if opened from the connect screen)
      st.tab = remoteFrom
      if (v.connectId && remoteFrom === 'connect') st.connectDetail = v.connectId
      render()
    }
    remoteUi = createRemote({
      tabId: v.tabId,
      ...(v.connectId ? { connectId: v.connectId } : {}),
      input: (i) => remote(i),
      back,
      handBack: back,
      done: () => {
        // Connect: tapping doesn't count as connected right away. The PC checks it is really signed in and reports back
        if (v.connectId) {
          st.connecting.add(v.connectId)
          void send({ kind: 'connect', id: v.connectId, action: 'verify' })
          toast(mdSide.checkingLogin)
        } else {
          // Don't write "done" in the chat; tell the PC instead: Dool2 checks the screen and carries on by itself
          void send({ kind: 'remote', tabId: v.tabId, action: 'done' })
          toast(mdSide.checkingContinue)
        }
        back()
      },
      hostOf,
      form: () => void send({ kind: 'form', tabId: v.tabId }),
      fill: (values, press) =>
        void send({ kind: 'form-fill', tabId: v.tabId, values, ...(press ? { press } : {}) }),
    })
  }
  remoteUi.update(st.screenShot, fps())
  return remoteUi.el
}

// ── The task that is running, at the bottom ──
// A task's progress card sits where it started in the chat, so it scrolls away (and the header covers it): this bar
// above the composer says what is running and takes you to its card. Hidden while the card itself is in sight

/**
 * Whether Dool2 is doing something the stop button stops: the chat's own turn or a task at work (tasks show as one
 * conversation, so stop takes them too; one waiting for the person does not turn the button into stop)
 */
export function working(): boolean {
  return st.busy || [...st.tasks.values()].some((t) => ['working', 'checking', 'waiting'].includes(t.status))
}

/** The task the person most needs to see: waiting for them first, then working, then in line */
function nowTask(): TaskView | undefined {
  const live = [...st.tasks.values()].filter((t) =>
    ['needs-you', 'working', 'checking', 'waiting'].includes(t.status),
  )
  const rank = (t: TaskView) => (t.status === 'needs-you' ? 0 : t.status === 'waiting' ? 2 : 1)
  return live.sort((a, b) => rank(a) - rank(b))[0]
}

function cardInSight(id: string): boolean {
  const card = shell?.page.querySelector<HTMLElement>(`[data-task="${id}"]`)
  if (!card) return false
  const r = card.getBoundingClientRect()
  return r.bottom > 120 && r.top < window.innerHeight - 180
}

function nowBar(): HTMLElement[] {
  const t = nowTask()
  if (!t || st.tab !== 'chat' || cardInSight(t.id)) return []
  const w = mainWork(lang)
  const what =
    t.status === 'needs-you'
      ? w.nowWaitsYou
      : t.status === 'waiting' && t.ahead
        ? w.nowInLine(t.ahead)
        : (t.now ?? w.nowWorking)
  const bar = h(
    'button',
    {
      class: `info-wait-bar now-bar${t.status === 'needs-you' ? ' ask' : ''}`,
      onclick: () => {
        const card = shell?.page.querySelector<HTMLElement>(`[data-task="${t.id}"]`)
        card?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      },
    },
    h('i', { class: 'now-dot' }),
    h('span', { text: `${t.title} · ${what}` }),
  )
  bar.dataset.task = t.id
  return [bar]
}

/** On scroll: show or hide the bar as the task's card leaves or comes into sight */
function syncNowBar() {
  const slot = shell?.composerBox.querySelector<HTMLElement>(':scope > .info-wait-slot')
  if (!slot || slot.querySelector('.info-wait-bar:not(.now-bar)')) return
  const next = nowBar()
  const cur = slot.querySelector<HTMLElement>('.now-bar')
  if (!next.length) cur?.remove()
  else if (!cur || cur.dataset.task !== next[0]?.dataset.task || cur.textContent !== next[0]?.textContent)
    slot.replaceChildren(...next)
}
