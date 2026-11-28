// The chat window. It wires the DOM to the main process (window.dool2, preload.cts): send a message, switch the
// autonomy level, open the hidden-browser mirror. Every daemon event is turned into one line by lineFor (lines.ts),
// so raw tool JSON never reaches the screen — the user sees a friendly work step, a message, or an approval card.

import type { AgentdEvent } from '@dool2/agentd'
import type { AutonomyLevel } from '@dool2/core'
import type { Lang } from '@dool2/i18n'
import { LEVELS, toLevel } from './levels.js'
import { lineFor, type UiLine } from './lines.js'
import { type AppText, appText } from './locales/app.js'

interface Dool2Api {
  config(): Promise<{ lang: Lang; level: AutonomyLevel; smoke: boolean }>
  send(text: string): Promise<void>
  setLevel(level: AutonomyLevel): Promise<void>
  watchBrowser(on: boolean): Promise<void>
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
}

let t: AppText
let working = false
let watching = false
let hasMessages = false
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
  if (dataUrl) {
    els.paneFrame.src = dataUrl
    els.paneFrame.hidden = false
    els.paneIdle.hidden = true
  } else {
    els.paneFrame.hidden = true
    els.paneIdle.hidden = false
  }
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

  api.onEvent((event) => {
    const line = lineFor(event)
    if (line) addLine(line)
  })
  api.onBrowserFrame(onFrame)
  // The smoke run drives the user message from the main process so the transcript is deterministic.
  api.onUserMessage((text) => addUser(text))

  api.ready(`lang=${config.lang} level=${config.level}`)
}

void main()
