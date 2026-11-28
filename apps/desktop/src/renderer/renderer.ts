// The chat window. It wires the DOM to the main process (window.dool2, preload.cts): send a message, switch the
// autonomy level, open the hidden-browser mirror. Every daemon event is turned into one line by lineFor (lines.ts),
// so raw tool JSON never reaches the screen — the user sees a friendly work step, a message, or an approval card.

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
import { LEVELS, toLevel } from './levels.js'
import { lineFor, type UiLine } from './lines.js'
import { type AppText, appText } from './locales/app.js'

interface Dool2Api {
  config(): Promise<{ lang: Lang; level: AutonomyLevel; smoke: boolean }>
  send(text: string): Promise<void>
  setLevel(level: AutonomyLevel): Promise<void>
  watchBrowser(on: boolean): Promise<void>
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

const els = {
  title: $('title'),
  tagline: $('tagline'),
  transcript: $('transcript'),
  composer: $<HTMLFormElement>('composer'),
  input: $<HTMLInputElement>('input'),
  send: $<HTMLButtonElement>('send'),
  levelLabel: $('level-label'),
  level: $<HTMLSelectElement>('level'),
  browserToggle: $<HTMLButtonElement>('browser-toggle'),
  pane: $('browser-pane'),
  paneCaption: $('browser-caption'),
  paneIdle: $('browser-idle'),
  paneFrame: $<HTMLImageElement>('browser-frame'),
  reviewToggle: $<HTMLButtonElement>('review-toggle'),
  reviewToggleLabel: $('review-toggle-label'),
  reviewBadge: $('review-badge'),
  reviewNudge: $<HTMLButtonElement>('review-nudge'),
  reviewPane: $('review-pane'),
  reviewCaption: $('review-caption'),
  reviewIntro: $('review-intro'),
  reviewCoverage: $('review-coverage'),
  reviewStatus: $('review-status'),
  reviewEmpty: $('review-empty'),
  reviewList: $('review-list'),
}

let t: AppText
let working = false
let watching = false
let hasMessages = false
const drafts = new DraftsController({
  list: () => api.drafts(),
  approve: (id) => api.approveDraft(id),
  discard: (id) => api.discardDraft(id),
})
/** The current run's work steps, so we replace the last one instead of stacking forever. */
let workRow: HTMLElement | undefined

function paintStatic(): void {
  els.title.textContent = t.title
  els.tagline.textContent = t.tagline
  els.input.placeholder = t.placeholder
  els.send.textContent = t.send
  els.levelLabel.textContent = t.levelLabel
  els.level.replaceChildren(
    ...LEVELS.map((lvl) => {
      const opt = document.createElement('option')
      opt.value = lvl
      opt.textContent = t.levels[lvl]
      return opt
    }),
  )
  els.browserToggle.textContent = t.browserShow
  els.paneCaption.textContent = t.browserLive
  els.paneIdle.textContent = t.browserIdle
  els.reviewToggleLabel.textContent = t.reviewShow
  els.reviewCaption.textContent = t.review.title
  els.reviewIntro.textContent = t.review.intro
  els.reviewEmpty.textContent = t.review.empty
  els.reviewNudge.textContent = t.review.nudge
  renderReview()
  showEmpty()
}

function showEmpty(): void {
  if (hasMessages) return
  const box = document.createElement('div')
  box.className = 'empty'
  box.innerHTML = `<div class="big">🌱</div>`
  const h = document.createElement('h2')
  h.textContent = t.emptyGreeting
  const p = document.createElement('p')
  p.textContent = t.emptyHint
  box.append(h, p)
  els.transcript.replaceChildren(box)
}

function scrollDown(): void {
  els.transcript.scrollTop = els.transcript.scrollHeight
}

function firstMessage(): void {
  if (!hasMessages) {
    hasMessages = true
    els.transcript.replaceChildren()
  }
}

function addUser(text: string): void {
  firstMessage()
  workRow = undefined
  const row = document.createElement('div')
  row.className = 'row user'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = text
  row.append(bubble)
  els.transcript.append(row)
  scrollDown()
}

function addLine(line: UiLine): void {
  firstMessage()
  if (line.role === 'work') {
    // Collapse consecutive work steps into one updating line.
    if (!workRow) {
      workRow = document.createElement('div')
      workRow.className = 'work'
      workRow.innerHTML = '<span class="dot"></span><span class="step"></span>'
      els.transcript.append(workRow)
    }
    const step = workRow.querySelector('.step')
    if (step) step.textContent = t.work[line.key]
    scrollDown()
    return
  }
  workRow = undefined
  if (line.role === 'dool2') {
    const row = document.createElement('div')
    row.className = 'row dool2'
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = line.text
    row.append(bubble)
    els.transcript.append(row)
  } else if (line.role === 'note') {
    const note = document.createElement('div')
    note.className = 'note'
    note.textContent = line.text
    els.transcript.append(note)
  } else if (line.role === 'blocked') {
    const note = document.createElement('div')
    note.className = 'note'
    note.textContent = t.blocked(line.label)
    els.transcript.append(note)
  } else if (line.role === 'approval') {
    const card = document.createElement('div')
    card.className = 'approval'
    const head = document.createElement('div')
    head.className = 'head'
    head.textContent = t.approvalTitle
    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = line.label
    card.append(head, label)
    if (line.amountKrw !== undefined) {
      const amount = document.createElement('div')
      amount.className = 'amount'
      amount.textContent = t.amount(line.amountKrw)
      card.append(amount)
    }
    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = t.approvalHint
    card.append(hint)
    els.transcript.append(card)
  }
  scrollDown()
}

/** Paint the whole review surface from the controller state: the header toggle + badge, the nudge, and the panel. */
function renderReview(): void {
  els.reviewToggle.textContent = drafts.open ? t.reviewHide : t.reviewShow
  els.reviewToggle.classList.toggle('on', drafts.open)
  // Re-add the badge (textContent above dropped it): show the pending count when there is one.
  els.reviewToggle.append(els.reviewBadge)
  els.reviewBadge.textContent = String(drafts.count)
  els.reviewBadge.hidden = drafts.count === 0
  els.reviewNudge.hidden = !drafts.nudge || drafts.open
  els.reviewPane.hidden = !drafts.open
  if (!drafts.open) return

  els.reviewCoverage.textContent = coverageText(drafts.coverage, t)
  els.reviewEmpty.hidden = drafts.count > 0
  const cards = drafts.drafts.map((draft) => draftCard(draft.id, draftRow(draft, t)))
  els.reviewList.replaceChildren(...cards)
}

/** Build one draft card: the site/host, name, learned summary, the "needs review" marker, and the two actions. */
function draftCard(id: string, row: ReturnType<typeof draftRow>): HTMLElement {
  const card = document.createElement('div')
  card.className = 'draft'

  const head = document.createElement('div')
  head.className = 'draft-head'
  const name = document.createElement('div')
  name.className = 'draft-name'
  name.textContent = row.name
  const marker = document.createElement('span')
  marker.className = 'draft-marker'
  marker.textContent = row.marker
  head.append(name, marker)

  const host = document.createElement('div')
  host.className = 'draft-host'
  host.textContent = row.host

  const learned = document.createElement('div')
  learned.className = 'draft-learned'
  learned.textContent = row.learned

  const actions = document.createElement('div')
  actions.className = 'draft-actions'
  const approve = document.createElement('button')
  approve.type = 'button'
  approve.className = 'approve'
  approve.textContent = t.review.approve
  approve.addEventListener('click', () => void act('approve', id, row.name))
  const discard = document.createElement('button')
  discard.type = 'button'
  discard.className = 'discard'
  discard.textContent = t.review.discard
  discard.addEventListener('click', () => void act('discard', id, row.name))
  actions.append(approve, discard)

  card.append(head, host, learned, actions)
  return card
}

/** Approve or discard a draft, then repaint and show a short confirmation in the panel. */
async function act(kind: 'approve' | 'discard', id: string, name: string): Promise<void> {
  if (kind === 'approve') await drafts.approve(id)
  else await drafts.discard(id)
  els.reviewStatus.textContent = kind === 'approve' ? t.review.approved(name) : t.review.discarded(name)
  els.reviewStatus.hidden = false
  renderReview()
}

/** Open or close the review panel. */
async function toggleReview(): Promise<void> {
  els.reviewStatus.hidden = true
  await drafts.setOpen(!drafts.open)
  renderReview()
}

function setWorking(on: boolean): void {
  working = on
  els.send.disabled = on
  els.input.disabled = on
}

async function submit(text: string): Promise<void> {
  const message = text.trim()
  if (!message || working) return
  addUser(message)
  els.input.value = ''
  setWorking(true)
  try {
    await api.send(message)
  } finally {
    setWorking(false)
    workRow = undefined
    els.input.focus()
  }
}

async function toggleBrowser(): Promise<void> {
  watching = !watching
  els.pane.hidden = !watching
  els.browserToggle.textContent = watching ? t.browserHide : t.browserShow
  els.browserToggle.classList.toggle('on', watching)
  await api.watchBrowser(watching)
}

function onFrame(dataUrl: string | null): void {
  const v = frameView(dataUrl)
  if (v.src) els.paneFrame.src = v.src
  els.paneFrame.hidden = !v.showFrame
  els.paneIdle.hidden = !v.showIdle
}

async function main(): Promise<void> {
  const config = await api.config()
  t = appText(config.lang)
  paintStatic()
  els.level.value = config.level

  els.composer.addEventListener('submit', (e) => {
    e.preventDefault()
    void submit(els.input.value)
  })
  els.level.addEventListener('change', () => {
    void api.setLevel(toLevel(els.level.value))
  })
  els.browserToggle.addEventListener('click', () => void toggleBrowser())
  els.reviewToggle.addEventListener('click', () => void toggleReview())
  els.reviewNudge.addEventListener('click', () => void toggleReview())

  api.onEvent((event) => {
    // A `draft` turn event raises the nudge (learn-by-watching); it is never shown as a chat line (lineFor drops it).
    if (drafts.noteEvent(event)) {
      if (drafts.open) void drafts.refresh().then(renderReview)
      else renderReview()
      return
    }
    const line = lineFor(event)
    if (line) addLine(line)
  })
  api.onBrowserFrame(onFrame)
  // The smoke run drives the user message from the main process so the transcript is deterministic.
  api.onUserMessage((text) => addUser(text))

  // Prime the badge so a pending draft is visible before the panel is opened.
  void drafts
    .refresh()
    .then(renderReview)
    .catch(() => {})

  api.ready(`lang=${config.lang} level=${config.level}`)
}

void main()
