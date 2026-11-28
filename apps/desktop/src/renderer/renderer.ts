// The chat window (v2). It fills the 3-column shell (index.html) with the shared design-system parts (@dool2/ui): a
// left nav + Now live tasks, the center chat (character avatar, bubbles, quick replies, date separators, a floating
// composer), and the right "Dool2's screen" pane (a live browser card, an up-next queue, a privacy footer). It wires
// each to the in-process daemon through the preload bridge (window.dool2):
//   - send + stream  -> agentd.send turn events, mapped to one friendly line by lineFor (lines.ts); raw tool JSON
//                        never reaches the screen.
//   - Dool2's screen -> the hidden-browser screencast mirror (watchBrowser); the card shell is from the design.
//   - up next        -> agentd.pending() approval cards, plus the seeded demo queue.
//   - My Dool2       -> the autonomy level (ADR 0047) + the new-skill draft review (ADR 0046).
// With no live daemon data yet, a seeded demo world (locales/seed.ts) makes it a full, working screen offline — the
// same role the base smoke's seed played. Screens the v2 daemon has no data for (Explore, full Tasks history) keep
// the look with a "coming soon" state rather than faking data.

import type { AgentdEvent } from '@dool2/agentd'
import type { AutonomyLevel } from '@dool2/core'
import type { Lang } from '@dool2/i18n'
import {
  coverageText,
  type DraftActionResult,
  DraftsController,
  type DraftsSnapshot,
  draftRow,
} from './drafts.js'
import { frameView } from './frame.js'
import { LEVELS } from './levels.js'
import { lineFor, type UiLine } from './lines.js'
import { type AppText, appText, type Tab } from './locales/app.js'
import { seedDevice, seedNextUp, seedNow, seedScreen, seedThread } from './locales/seed.js'

/** One pending approval card from the daemon (agentd.pending()); only the public facts reach the screen. */
interface PendingCard {
  label: string
  amountKrw?: number
}

interface Dool2Api {
  config(): Promise<{ lang: Lang; level: AutonomyLevel; smoke: boolean }>
  send(text: string): Promise<void>
  setLevel(level: AutonomyLevel): Promise<void>
  watchBrowser(on: boolean): Promise<void>
  pending(): Promise<PendingCard[]>
  drafts(): Promise<DraftsSnapshot>
  approveDraft(id: string): Promise<DraftActionResult>
  discardDraft(id: string): Promise<DraftActionResult>
  onEvent(cb: (event: AgentdEvent) => void): void
  onBrowserFrame(cb: (dataUrl: string | null) => void): void
  onUserMessage(cb: (text: string) => void): void
  ready(summary: string): void
}

declare global {
  interface Window {
    dool2: Dool2Api
  }
}

const api = window.dool2
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const SVG = 'http://www.w3.org/2000/svg'

/** Line-icon paths, copied from the design mock (docs/design/screens/src/PC.dc.html). Stroked, no fill. */
const ICONS: Record<string, string> = {
  chat: '<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/>',
  tasks: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 10l2.5 2.5L16 8M8 16h8"/>',
  explore: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  laptop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  wave: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  cart: '<path d="M3 4h2l2.4 11h10.2L20 7H6.2"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
  box: '<path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
}

function icon(name: keyof typeof ICONS | string, cls = 'i'): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', cls)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = ICONS[name] ?? ''
  return svg
}

type Kid = Node | string | null | undefined
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  ...kids: Kid[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  for (const k of kids) {
    if (k == null) continue
    node.append(typeof k === 'string' ? document.createTextNode(k) : k)
  }
  return node
}

/** The Dool2 character, as an <img> of the shared webp set (idle / working / done …). */
function doori(mood: 'idle' | 'working' | 'done', cls: string): HTMLImageElement {
  const img = el('img', cls)
  img.src = `doori/${mood}.webp`
  img.alt = ''
  return img
}

const TABS: Tab[] = ['talk', 'tasks', 'explore', 'me']
const TAB_ICON: Record<Tab, string> = { talk: 'chat', tasks: 'tasks', explore: 'explore', me: 'person' }

let t: AppText
let tab: Tab = 'talk'
let working = false
let pending: PendingCard[] = []
/** The seeded + live chat thread, kept across tab switches. */
let threadEl: HTMLElement
/** The current run's work steps, so we replace the last one instead of stacking forever. */
let workRow: HTMLElement | undefined
const drafts = new DraftsController({
  list: () => api.drafts(),
  approve: (id) => api.approveDraft(id),
  discard: (id) => api.discardDraft(id),
})

// ── Left nav ───────────────────────────────────────────
function tasksCount(): number {
  return pending.length + seedNow.filter((n) => n.tone === 'ask').length
}

function navItem(which: Tab): HTMLButtonElement {
  const b = el('button', `navi${which === tab ? ' on' : ''}`)
  b.type = 'button'
  b.append(icon(TAB_ICON[which]))
  if (which === 'tasks') {
    b.append(el('span', 'grow', t.tabs[which]))
    const n = tasksCount()
    if (n > 0) b.append(el('span', 'count', String(n)))
  } else {
    b.append(el('span', undefined, t.tabs[which]))
  }
  b.addEventListener('click', () => setTab(which))
  return b
}

function nowItem(item: (typeof seedNow)[number]): HTMLElement {
  const row = el('div', `now-item${item.tone === 'ask' ? ' ask' : ''}`)
  row.append(el('i', `dot ${item.tone === 'ask' ? 'ask' : 'work pulse'}`))
  const body = el('div', 'now-body', el('b', undefined, item.title))
  if (item.desc) body.append(el('div', 'meta', item.desc))
  else if (item.amount) body.append(el('div', 'meta mono', item.amount))
  row.append(body)
  if (item.count) row.append(el('span', 'now-count mono', item.count))
  else row.append(icon('chevron'))
  return row
}

function deviceFoot(): HTMLElement {
  const foot = el('div', 'side-foot')
  const body = el(
    'div',
    'dev',
    el('div', 'dev-name', seedDevice.name),
    el('div', 'dev-state meta', el('i', 'dot'), seedDevice.on),
  )
  foot.append(icon('laptop'), body)
  return foot
}

function buildSide(): void {
  const brand = el('div', 'brand')
  const mark = el('img', 'brand-mark')
  mark.src = 'doori/mark.svg'
  mark.alt = ''
  const wm = el('span', 'wordmark')
  wm.innerHTML = 'dool<sup>2</sup>'
  brand.append(mark, wm, el('span', 'brand-small meta', t.brandSmall))

  const tabs = el('div', 'side-tabs')
  for (const which of TABS) tabs.append(navItem(which))

  const now = el('section', 'now')
  now.append(el('h2', 'over', t.nowHead), el('div', 'now-list', ...seedNow.map(nowItem)))

  const side = $('side')
  side.setAttribute('aria-label', t.navLabel)
  side.replaceChildren(brand, tabs, now, el('div', 'grow'), deviceFoot())
}

// ── Center: header, chat, composer ─────────────────────
function buildHead(): HTMLElement {
  const head = el('header', 'head')
  const status = el('div', 'head-status meta', el('i', 'dot'), t.headStatus)
  const search = el('button', 'btn-ghost sm', icon('search'), t.search)
  search.type = 'button'
  head.append(
    doori('working', 'head-av bob'),
    el('div', 'head-id', el('div', 'head-name', t.doori), status),
    search,
  )
  return head
}

function sep(label: string): HTMLElement {
  return el('div', 'sep', label)
}

function whoRow(): HTMLElement {
  return el('div', 'who', doori('idle', 'who-av'), t.doori, el('span', 'meta', seedThread.time))
}

function bubble(text: string): HTMLElement {
  return el('div', 'bubble', text)
}

function meBubble(text: string, withReact = false): HTMLElement {
  const b = el('div', 'bubble me', text)
  if (withReact) b.append(el('span', 'react', doori('done', 'react-av')))
  return b
}

function doneRow(done: { text: string; meta: string }): HTMLElement {
  const grow = el('div', 'grow')
  grow.append(done.text, ' ', el('span', 'meta', done.meta))
  const chev = icon('chevron', 'i chev')
  return el('div', 'done-row', icon('check'), grow, chev)
}

function chipsRow(chips: readonly string[]): HTMLElement {
  const row = el('div', 'quick-row')
  for (const c of chips) {
    const b = el('button', 'chip', c)
    b.type = 'button'
    b.addEventListener('click', () => void submit(c))
    row.append(b)
  }
  return row
}

/** Build the seeded thread once (design mock). Live messages append to it afterwards. */
function buildThread(): void {
  threadEl = el('div', 'thread')
  threadEl.append(
    sep(t.dayYesterday),
    doneRow(seedThread.done),
    sep(t.dayToday),
    whoRow(),
    bubble(seedThread.dooriMorning),
    bubble(seedThread.dooriLunch),
    chipsRow(seedThread.chips),
    meBubble(seedThread.me, true),
    bubble(seedThread.dooriKtx),
  )
}

function buildComposer(): HTMLFormElement {
  const form = el('form', 'composer-dock')
  const comp = el('div', 'composer float')
  const attach = el('button', 'cbtn')
  attach.type = 'button'
  attach.setAttribute('aria-label', t.attachAria)
  attach.append(icon('plus'))
  const input = el('input', 'ask')
  input.id = 'ask'
  input.type = 'text'
  input.autocomplete = 'off'
  input.placeholder = t.placeholder
  const mic = el('button', 'cbtn')
  mic.type = 'button'
  mic.setAttribute('aria-label', t.voiceAria)
  mic.append(icon('mic'))
  const go = el('button', 'cbtn go')
  go.type = 'submit'
  go.append(icon('wave'), t.voice)
  comp.append(attach, input, mic, go)
  form.append(el('div', 'inner', comp))
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void submit(input.value)
  })
  return form
}

function scrollDown(): void {
  const c = $('center')
  c.scrollTop = c.scrollHeight
}

function addUser(text: string): void {
  workRow = undefined
  threadEl.append(meBubble(text))
  scrollDown()
}

/** Map one daemon line onto the thread (same discipline as the base chat: friendly lines, never raw tool JSON). */
function addLine(line: UiLine): void {
  if (line.role === 'work') {
    if (!workRow) {
      workRow = el('div', 'who meta')
      workRow.append(el('i', 'dot work pulse'), el('span', 'step'))
      threadEl.append(workRow)
    }
    const step = workRow.querySelector('.step')
    if (step) step.textContent = t.work[line.key]
    scrollDown()
    return
  }
  workRow = undefined
  if (line.role === 'dool2') threadEl.append(bubble(line.text))
  else if (line.role === 'note') threadEl.append(el('div', 'sep', line.text))
  else if (line.role === 'blocked') threadEl.append(el('div', 'sep', t.blocked(line.label)))
  else if (line.role === 'approval') threadEl.append(approvalCard(line.label, line.amountKrw))
  scrollDown()
}

function approvalCard(label: string, amountKrw?: number): HTMLElement {
  const card = el('article', 'card ask')
  card.append(el('div', 'card-label', icon('lock'), t.approvalTitle))
  card.append(el('div', 'row-t', label))
  if (amountKrw !== undefined) card.append(el('div', 'kv-money mono', t.amount(amountKrw)))
  card.append(el('div', 'meta', t.approvalHint))
  return card
}

// ── Center views ───────────────────────────────────────
function comingView(): HTMLElement {
  const box = el('div', 'coming')
  box.append(doori('idle', 'coming-emoji'), el('h2', undefined, t.comingSoon), el('p', 'meta', t.comingHint))
  return box
}

function levelOption(lvl: AutonomyLevel, current: AutonomyLevel): HTMLButtonElement {
  const b = el('button', `level-opt${lvl === current ? ' on' : ''}`)
  b.type = 'button'
  b.append(
    el('div', undefined, el('div', 'lo-name', t.levels[lvl].name), el('div', 'lo-desc', t.levels[lvl].desc)),
  )
  if (lvl === current) b.append(icon('check', 'i lo-mark'))
  b.addEventListener('click', () => {
    void api.setLevel(lvl)
    renderMe(lvl)
  })
  return b
}

let currentLevel: AutonomyLevel = 'ask'

function meView(): HTMLElement {
  const view = el('div', 'me-view')
  const level = el('section', 'me-sec')
  level.append(el('h3', undefined, t.levelLabel), el('p', 'sub', t.levelSub))
  level.append(el('div', 'level-opts', ...LEVELS.map((l) => levelOption(l, currentLevel))))
  const review = el('section', 'me-sec')
  review.id = 'review-sec'
  review.append(el('h3', undefined, t.review.title), el('p', 'sub', t.review.intro))
  review.append(el('div', 'drafts', el('div', 'draft-status', t.review.empty)))
  view.append(level, review)
  return view
}

function renderMe(level?: AutonomyLevel): void {
  if (level) currentLevel = level
  const center = $('center')
  center.className = 'center-view'
  center.replaceChildren(meView())
  void drafts.setOpen(true).then(() => renderDrafts())
}

function renderDrafts(): void {
  const host = document.querySelector('#review-sec .drafts')
  if (!host) return
  if (drafts.count === 0) {
    host.replaceChildren(el('div', 'draft-status', t.review.empty))
    return
  }
  host.replaceChildren(
    el('div', 'meta', coverageText(drafts.coverage, t)),
    ...drafts.drafts.map((d) => draftCard(d.id, draftRow(d, t))),
  )
}

function draftCard(id: string, row: ReturnType<typeof draftRow>): HTMLElement {
  const card = el('div', 'draft')
  card.append(
    el('div', 'draft-head', el('div', 'draft-name', row.name), el('span', 'draft-marker', row.marker)),
    el('div', 'draft-host', row.host),
    el('div', 'draft-learned', row.learned),
  )
  const approve = el('button', 'btn sm', t.review.approve)
  approve.type = 'button'
  approve.addEventListener('click', () => void act('approve', id))
  const discard = el('button', 'btn-ghost sm', t.review.discard)
  discard.type = 'button'
  discard.addEventListener('click', () => void act('discard', id))
  card.append(el('div', 'draft-actions', approve, discard))
  return card
}

async function act(kind: 'approve' | 'discard', id: string): Promise<void> {
  if (kind === 'approve') await drafts.approve(id)
  else await drafts.discard(id)
  renderDrafts()
}

// ── Right pane: Dool2's screen ─────────────────────────
function seatStrip(pattern: string): HTMLElement {
  const strip = el('div', 'seats')
  for (const ch of pattern) {
    strip.append(el('span', ch === 'x' ? 'x' : ch === 'o' ? 'pick' : ''))
  }
  return strip
}

function workcard(): HTMLElement {
  const card = el('article', 'workcard')
  card.append(
    el(
      'div',
      'workcard-head',
      el('b', undefined, seedScreen.title),
      el('span', undefined, seedScreen.status),
    ),
  )
  // The screen: urlbar + the seeded preview body (swapped for a live frame <img> while watching).
  const screen = el('div', 'screen')
  const url = el('div', 'urlbar', icon('lock'), el('b', undefined, seedScreen.url), el('span', 'grow'))
  url.append(el('span', undefined, t.screenTag))
  const body = el('div', 'screen-body')
  body.id = 'screen-body'
  body.append(
    el(
      'div',
      'screen-top',
      el('div', 'screen-seat', seedScreen.seat),
      el('div', 'screen-price', seedScreen.price),
    ),
    el('div', 'screen-detail meta', seedScreen.detail),
    seatStrip(seedScreen.seats),
  )
  const cursor = el('div', 'screen-cursor')
  const arrow = document.createElementNS(SVG, 'svg')
  arrow.setAttribute('viewBox', '0 0 24 24')
  arrow.innerHTML =
    '<path d="M5 3l14 7-6 2-2 6z" fill="#4cc98f" stroke="#0f2a1d" stroke-width="1.3" stroke-linejoin="round"/>'
  cursor.append(arrow, el('span', 'tag', seedScreen.cursor))
  body.append(cursor)
  const frame = el('img', 'screen-frame')
  frame.id = 'screen-frame'
  frame.alt = ''
  frame.hidden = true
  screen.append(url, body, frame)
  // Progress bar + "before paying I'll ask" (ui.css .workcard-foot).
  const foot = el('div', 'workcard-foot')
  foot.append(
    el('span', 'seg on'),
    el('span', 'seg on'),
    el('span', 'seg half'),
    el('span', 'seg'),
    el('span', 'meta', t.beforePay),
  )
  card.append(screen, foot)
  return card
}

function nextUpList(): HTMLElement {
  const sec = el('div', 'nextup')
  sec.append(el('div', 'over meta', t.nextUp))
  // Live pending approvals first, then the seeded queue.
  for (const p of pending) {
    const grow = el('div', 'grow')
    grow.append(p.label)
    if (p.amountKrw !== undefined) grow.append(' ', el('span', 'mono meta', t.amount(p.amountKrw)))
    sec.append(el('div', 'row', icon('cart'), grow, el('span', 'pill ask', t.awaitingApproval)))
  }
  for (const n of seedNextUp) {
    const grow = el('div', 'grow')
    grow.append(n.title)
    if (n.amount) grow.append(' ', el('span', 'mono meta', n.amount))
    const trailing = n.pill
      ? el('span', 'pill ask', t.awaitingApproval)
      : el('span', 'mono meta', n.time ?? '')
    sec.append(el('div', 'row', icon(n.icon), grow, trailing))
  }
  return sec
}

function buildPanel(): void {
  const head = el('div', 'panel-head')
  const takeOver = el('button', 'btn-ghost sm', t.takeOver)
  takeOver.type = 'button'
  const stop = el('button', 'btn-danger sm', icon('stop'), t.stop)
  stop.type = 'button'
  head.append(el('h2', undefined, t.screenTitle), takeOver, stop)
  const foot = el('div', 'panel-foot', icon('shield'), t.localFoot)
  const panel = $('panel')
  panel.setAttribute('aria-label', t.screenTitle)
  panel.replaceChildren(head, workcard(), nextUpList(), el('div', 'grow'), foot)
}

function onFrame(dataUrl: string | null): void {
  const body = document.getElementById('screen-body')
  const frame = document.getElementById('screen-frame') as HTMLImageElement | null
  if (!body || !frame) return
  const v = frameView(dataUrl)
  if (v.src) frame.src = v.src
  frame.hidden = !v.showFrame
  body.classList.toggle('hidden', v.showFrame)
}

// ── View switching ─────────────────────────────────────
function setTab(which: Tab): void {
  tab = which
  // Nav highlight + badge.
  const tabsEl = document.querySelector('.side-tabs')
  if (tabsEl) tabsEl.replaceChildren(...TABS.map(navItem))
  const app = $('app')
  app.classList.toggle('panel-open', which === 'talk')
  renderCenter()
}

function renderCenter(): void {
  const center = $('center')
  const composer = $('composer-dock')
  composer.hidden = tab !== 'talk'
  if (tab === 'talk') {
    center.className = 'messages'
    center.replaceChildren(threadEl)
    scrollDown()
  } else if (tab === 'me') {
    renderMe()
  } else {
    center.className = 'center-view'
    center.replaceChildren(comingView())
  }
}

function buildMain(): void {
  const main = $('main')
  const center = el('div', 'messages')
  center.id = 'center'
  const composer = buildComposer()
  composer.id = 'composer-dock'
  main.replaceChildren(buildHead(), center, composer)
}

async function submit(text: string): Promise<void> {
  const message = text.trim()
  if (!message || working) return
  if (tab !== 'talk') setTab('talk')
  const input = $<HTMLInputElement>('ask')
  addUser(message)
  input.value = ''
  working = true
  input.disabled = true
  try {
    await api.send(message)
  } finally {
    working = false
    workRow = undefined
    input.disabled = false
    input.focus()
  }
}

async function main(): Promise<void> {
  const config = await api.config()
  t = appText(config.lang)
  currentLevel = config.level
  pending = await api.pending().catch(() => [])

  buildThread()
  buildSide()
  buildMain()
  buildPanel()
  $('app').classList.add('panel-open')
  renderCenter()

  api.onEvent((event) => {
    if (drafts.noteEvent(event)) {
      if (tab === 'me') void drafts.refresh().then(renderDrafts)
      return
    }
    const line = lineFor(event)
    if (line) addLine(line)
  })
  api.onBrowserFrame(onFrame)
  api.onUserMessage((text) => addUser(text))
  if (!config.smoke) void api.watchBrowser(true)

  api.ready(`lang=${config.lang} level=${config.level}`)
}

void main()
