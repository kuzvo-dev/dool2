// The phone app (v2). It fills the phone frame (index.html) with the shared design-system parts (@dool2/ui) and drives
// the phone side of the approval loop through a PhoneController (lib/controller.ts):
//
//   - Pair screen  (?screen=pair): enter the PC address + connect code, pairDevice over DaemonHttpClient (POST /pair,
//                                  PUBLIC key only). On success it shows "connected".
//   - Home         : the Dool2 character + a status line (a "waiting for approval" dot when a card is pending, idle else).
//   - Approval sheet: the pending card as a bottom sheet (matches docs/design/screens/m-approve-light.png) — the
//                     amount headline, the detail rows, a black Face-ID primary that SIGNS the card's hash with the
//                     device key and POSTs /approve, a decline that dismisses without signing, and a do-it-myself
//                     hand-off. Then it reflects the "approved" outcome. All copy comes from the locale files.
//
// Offline/demo mode (the default, and what the smoke captures) seeds a GENERIC pending card so the whole screen renders
// with no live daemon. The device key lives in a WebCrypto keystore and never leaves it; only the public key, a
// signature and the bearer token ever cross the wire. No secret (card number, password) is ever in the card.

import { type Lang, resolveLang } from '@dool2/i18n'
import type { CardView } from '../lib/card.js'
import { cardView } from '../lib/card.js'
import { PhoneController, type PhoneState } from '../lib/controller.js'
import { LazyKeyStore } from '../lib/webcrypto.js'
import { type Text, text } from './locales/app.js'
import { demoCard } from './locales/demo.js'

const SVGNS = 'http://www.w3.org/2000/svg'
const app = document.getElementById('app') as HTMLDivElement

// ── Small DOM helpers ───────────────────────────────────────────────────────
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  for (const k of kids) node.append(k)
  return node
}

/** A line icon on the @dool2/ui 24 grid (svg.i). `d` is one or more path commands. */
function icon(d: string, size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVGNS, 'svg')
  svg.setAttribute('class', 'i')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.width = `${size}px`
  svg.style.height = `${size}px`
  const path = document.createElementNS(SVGNS, 'path')
  path.setAttribute('d', d)
  svg.append(path)
  return svg
}

const ICON = {
  menu: 'M4 8h16M4 16h10',
  pc: 'M3 5h18v11H3zM2 20h20',
  faceId:
    'M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M7 21H5a2 2 0 0 1-2-2v-2M17 21h2a2 2 0 0 0 2-2v-2M9 9v1M15 9v1M12 9v4h-1M9.5 16a3.5 3.5 0 0 0 5 0',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z',
} as const

/** The pre-rendered Dool2 character (webp) for a mood. `asking` carries the butter "?" badge, matching the design. */
function dooriImg(mood: 'idle' | 'asking' | 'done', cls: string, alt: string): HTMLImageElement {
  const img = el('img', cls)
  img.src = `doori/${mood}.webp`
  img.alt = alt
  return img
}

function iconButton(d: string, label: string, cls = ''): HTMLButtonElement {
  const b = el('button', `icon-btn lg ${cls}`.trim())
  b.type = 'button'
  b.setAttribute('aria-label', label)
  b.append(icon(d))
  return b
}

// ── App wiring ──────────────────────────────────────────────────────────────
const lang: Lang = resolveLang(navigator.languages as string[] | undefined)
const t: Text = text(lang)
document.documentElement.lang = lang
document.title = t.appName

const params = new URLSearchParams(location.search)
const startScreen = params.get('screen')

const controller = new PhoneController({ keystore: new LazyKeyStore() })

controller.subscribe((state) => render(state))

async function boot(): Promise<void> {
  if (startScreen === 'pair') {
    renderPair()
    return
  }
  // Default: offline demo — seed a generic pending card so the approval screen renders with no daemon.
  const card = await demoCard(lang)
  controller.setDemoCard(card)
  controller.showDemo()
  signalReady('demo')
}

/** Tell the smoke harness the first paint is done (parallels the desktop app's dool2:ready). */
function signalReady(summary: string): void {
  const w = window as unknown as { dool2Ready?: (s: string) => void }
  w.dool2Ready?.(summary)
}

// ── Render ──────────────────────────────────────────────────────────────────
function render(state: PhoneState): void {
  if (state.mode === 'live' && !state.card && !state.connected) {
    renderPair()
    return
  }
  app.replaceChildren(header(state), homeMain(state))
  if (state.card) app.append(scrim(), sheet(state, state.card))
}

function header(state: PhoneState): HTMLElement {
  const waiting = Boolean(state.card) && !state.outcome
  const mood = waiting ? 'asking' : 'idle'
  const statusText = waiting ? t.statusWaiting : state.connected ? t.statusConnected : t.statusIdle

  const status = el('div', 'ph-status')
  const dot = el('span', `dot ${waiting ? 'ask' : 'work'}`)
  status.append(dot, el('span', undefined, statusText))

  const id = el('div', 'ph-id', dooriImg(mood, 'ph-char', t.name), el('div', 'ph-name', t.name), status)

  const pc = iconButton(ICON.pc, t.connectedPc, 'ph-pcbtn')
  if (state.connected) pc.append(el('span', 'dot work ph-pcdot'))

  return el('header', 'ph-head', iconButton(ICON.menu, t.menu), id, pc)
}

function homeMain(state: PhoneState): HTMLElement {
  const main = el('main', 'ph-main')
  main.setAttribute('aria-hidden', state.card ? 'true' : 'false')
  if (state.card) {
    // A faint hint of the conversation behind the sheet, like the design.
    main.append(el('div', 'ph-me', t.threadMe), el('p', 'ph-say', t.threadSay))
  } else {
    const empty = el('div', 'ph-empty')
    empty.append(
      dooriImg('idle', 'ph-char', t.name),
      el('h1', 'title-2', t.homeIdleTitle),
      el('p', 'meta', t.homeIdleBody),
    )
    main.append(empty)
  }
  return main
}

function scrim(): HTMLElement {
  const s = el('div', 'scrim')
  s.setAttribute('aria-hidden', 'true')
  return s
}

function sheet(state: PhoneState, card: Parameters<typeof cardView>[0]): HTMLElement {
  const section = el('section', 'sheet approve-sheet')
  section.setAttribute('role', 'dialog')
  section.setAttribute('aria-label', t.payHeadline(''))
  if (state.outcome) {
    section.append(outcomeView(state))
    return section
  }
  const view = cardView(card)

  // Head: character + source + amount headline.
  const head = el('div', 'sheet-head')
  const col = el('div')
  col.style.flex = '1'
  const sourceName = view.source ?? view.where ?? ''
  col.append(el('div', 'sheet-source', t.approveSource(sourceName)), el('h1', 'sheet-q', headline(view)))
  head.append(dooriImg('asking', 'ph-char', t.name), col)

  // Detail rows.
  const kv = el('dl', 'kv sheet-kv')
  for (const row of view.rows) {
    kv.append(el('dt', undefined, row.key), el('dd', undefined, row.value))
  }

  // Primary: Face ID approve (black, heaviest). Secondary: do-it-myself + decline. Then the privacy note.
  const approve = el('button', 'btn lg sheet-approve')
  approve.type = 'button'
  approve.append(icon(ICON.faceId, 22), document.createTextNode(state.busy ? t.signing : t.approve))
  approve.disabled = state.busy
  approve.addEventListener('click', () => void controller.approve())

  const mine = el('button', 'btn-ghost lg')
  mine.type = 'button'
  mine.textContent = t.doMyself
  mine.addEventListener('click', () => controller.handOff())

  const reject = el('button', 'btn-danger lg')
  reject.type = 'button'
  reject.textContent = t.reject
  reject.addEventListener('click', () => controller.reject())

  const actions = el('div', 'sheet-actions', mine, reject)

  const note = el('div', 'sheet-note', icon(ICON.shield, 14), document.createTextNode(t.privacyNote))

  section.append(head, kv, approve, actions, note)
  if (state.error) section.append(el('p', 'pair-error', t.error(state.error)))
  return section
}

function headline(view: CardView): string {
  if (view.tier === 'pay' && view.amountKrw !== undefined) return t.payHeadline(t.amount(view.amountKrw))
  return t.askHeadline(view.label)
}

function outcomeView(state: PhoneState): HTMLElement {
  const wrap = el('div', 'sheet-outcome')
  const map = {
    approved: { mood: 'done' as const, title: t.approved, body: t.approvedBody },
    rejected: { mood: 'idle' as const, title: t.rejected, body: t.rejectedBody },
    'handed-off': { mood: 'idle' as const, title: t.handedOff, body: t.handedOffBody },
  }
  const o = map[state.outcome ?? 'approved']
  const close = el('button', 'btn lg')
  close.type = 'button'
  close.textContent = t.close
  close.style.width = '100%'
  close.style.marginTop = '8px'
  close.addEventListener('click', () => controller.dismiss())
  wrap.append(
    dooriImg(o.mood, 'ph-char', t.name),
    el('h1', undefined, o.title),
    el('p', undefined, o.body),
    close,
  )
  return wrap
}

// ── Pairing screen ──────────────────────────────────────────────────────────
function renderPair(): void {
  const form = el('div', 'pair')

  const field = (
    id: string,
    label: string,
    hint: string,
    placeholder: string,
    value = '',
  ): { wrap: HTMLElement; input: HTMLInputElement } => {
    const input = el('input', 'field')
    input.id = id
    input.placeholder = placeholder
    input.value = value
    input.autocomplete = 'off'
    const lab = el('label', undefined, label)
    lab.htmlFor = id
    const wrap = el('div', 'pair-field', lab, input, el('div', 'hint', hint))
    return { wrap, input }
  }

  const url = field('pair-url', t.pairUrlLabel, t.pairUrlHint, 'http://127.0.0.1:53219')
  const code = field('pair-code', t.pairCodeLabel, t.pairCodeHint, '000000')
  const name = field('pair-name', t.pairNameLabel, '', t.pairNamePlaceholder)

  const connect = el('button', 'btn pair-connect')
  connect.type = 'button'
  connect.textContent = t.pairConnect

  const error = el('p', 'pair-error')
  error.hidden = true

  connect.addEventListener('click', () => {
    connect.disabled = true
    connect.textContent = t.pairConnecting
    error.hidden = true
    void controller
      .connect({
        baseUrl: url.input.value.trim(),
        token: code.input.value.trim(),
        label: name.input.value.trim() || undefined,
      })
      .then((ok) => {
        if (ok) {
          void controller.refresh()
          return
        }
        connect.disabled = false
        connect.textContent = t.pairConnect
        error.hidden = false
        error.textContent = t.pairFailed(controller.state.error ?? 'unknown')
      })
  })

  const note = el('div', 'pair-note', icon(ICON.shield, 14), document.createTextNode(t.pairKeyNote))

  form.append(
    el('h1', 'title-2', t.pairTitle),
    el('p', 'pair-intro', t.pairIntro),
    url.wrap,
    code.wrap,
    name.wrap,
    connect,
    error,
    note,
  )
  app.replaceChildren(el('header', 'ph-head', spacer(), pairTitleId(), spacer()), form)
  signalReady('pair')
}

function spacer(): HTMLElement {
  return el('div')
}
function pairTitleId(): HTMLElement {
  const id = el('div', 'ph-id')
  id.append(dooriImg('idle', 'ph-char', t.name), el('div', 'ph-name', t.name))
  return id
}

void boot()
