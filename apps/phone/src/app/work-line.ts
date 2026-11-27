// How Dool2's work shows in the chat: one line, and the "how it worked" sheet behind it.
//
// The chat keeps one line per piece of work: a live dot and what it is doing now, a yellow line when it waits for the
// person, and "worked at … · time" once it is done. Tapping it opens a sheet with the whole timeline: Dool2's one-line
// self-talk between the actions, each action with its service logo and time, and what it did (the address opened,
// what was pressed, the field typed into) when tapped. Stop and take-as-is live in the sheet, not in the chat.
// A turn of the conversation and a task session (ADR 0038) look the same: the person reads one conversation.
import type { StepDetail, TaskRecordMessage, TaskView, WorkRecordMessage } from '@dool2/protocol'
import { dropEnglishLines, finishProgress } from '@dool2/protocol/rich'
import { actDone, cardForHost, groupSteps, type PlaceCard, type WorkGroup } from '@dool2/protocol/work-steps'
import { h, type IconName, icon, rich, withLogo } from '../dom.js'
import { lang } from '../lang.js'
import { mainWork } from '../locales/main-a-work.js'
import { send, st, tChat } from './core.js'
import { pendingApprovals, pendingLogins } from './decide.js'
import { openOverlay } from './shell.js'
import { openRemote, stepAt, stepInfo } from './work.js'

/** Where a sheet's steps come from: the turn running now, a finished turn's record, or a task */
export type SheetSrc = { kind: 'live' } | { kind: 'rec'; key: string } | { kind: 'task'; id: string }

interface Step {
  text: string
  act: string
  place?: string
  ms?: number
  detail?: StepDetail[]
}

/** Finished records the screen drew, by a key made from their text (the sheet looks them up when opened) */
const records = new Map<string, WorkRecordMessage>()

function placeCards(): PlaceCard[] {
  return (st.services ?? []).map((s) => ({
    id: s.card.id,
    name: s.card.name,
    ...(s.card.site ? { site: s.card.site } : {}),
  }))
}

const w = () => mainWork(lang)

function secs(ms: number) {
  return w().secs(Math.max(1, Math.round(ms / 1000)))
}

function clock(from: number) {
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The turn running now, as steps (same order as st.steps) */
function liveSteps(): Step[] {
  return st.steps.map((text, i) => {
    const info = stepInfo[i]
    const next = stepAt[i + 1]
    const at = stepAt[i]
    return {
      text,
      act: info?.act ?? text,
      ...(info?.place ? { place: info.place } : {}),
      ...(next && at ? { ms: next - at } : {}),
      ...(info?.detail ? { detail: info.detail } : {}),
    }
  })
}

const asSteps = (list: WorkRecordMessage['steps']): Step[] =>
  list.map((s) => ({ ...s, act: s.act ?? s.text }))

/** The service or site a step worked at (logo, name), or Dool2's own work */
function groupOf(s: Step): WorkGroup | undefined {
  return groupSteps([s], placeCards(), lang)[0]
}

function mark(g: WorkGroup | undefined): HTMLElement {
  const glyph: IconName | undefined =
    !g || g.kind === 'doori' ? 'brain' : g.kind === 'app' ? 'pc' : g.kind === 'file' ? 'note' : undefined
  const m = h('span', {
    class: `svc-mark wl-mark${glyph ? ' plain' : ''}`,
    text: glyph ? '' : (g?.letter ?? ''),
  })
  if (glyph) m.append(icon(glyph, 'i'))
  else withLogo(m, g?.cardId)
  return m
}

/** The places a piece of work went (distinct services and sites), for its finished line */
function places(steps: Step[]): WorkGroup[] {
  const groups = groupSteps(steps, placeCards(), lang)
  return [
    ...new Map(
      groups.filter((g) => g.kind === 'web' || g.kind === 'service').map((g) => [g.key, g]),
    ).values(),
  ]
}

/** What waits for the person now (a card on the phone), to name it and to open it */
function waiting(): { label: string; open: () => void } | undefined {
  const info = [...st.infos.values()].find((q) => q.status === 'pending')
  if (info) return { label: info.label, open: () => openOverlay({ kind: 'info', id: info.id }) }
  const login = pendingLogins()[0]
  if (login) return { label: login.site, open: () => openOverlay({ kind: 'login', id: login.id }) }
  const a = pendingApprovals()[0]
  if (a) return { label: a.what, open: () => openOverlay({ kind: 'approval', id: a.id }) }
  return undefined
}

function lineEl(
  cls: string,
  lead: HTMLElement,
  text: (HTMLElement | string)[],
  meta: string,
  onclick: () => void,
): HTMLElement {
  return h(
    'button',
    { class: `wline ${cls}`, onclick },
    lead,
    h('span', { class: 'wl-text' }, ...text),
    h('span', { class: 'wl-meta', text: meta }),
    icon('chevron', 'i wl-chev'),
  )
}

const dots = () => h('span', { class: 'wl-dots' }, h('i'), h('i'), h('i'), h('i'))

/** What a step did, as specific as its details allow ("pressing 'Track'" instead of "pressing") */
function actText(s: Step, doing: boolean): string {
  const d = s.detail?.at(-1)
  if (d?.k === 'press') return doing ? w().pressing(d.v) : w().pressed(d.v)
  if (d?.k === 'field') return doing ? w().filling(d.v) : w().filled(d.v)
  return doing ? s.act : actDone(s.act, lang)
}

/** "<service> · <what it does now>": the place of the last step, then what it is doing */
function nowText(steps: Step[], fallback: string): (HTMLElement | string)[] {
  const last = steps.at(-1)
  if (!last) return [fallback]
  const g = groupOf(last)
  const place = g && (g.kind === 'web' || g.kind === 'service') ? g.title : ''
  // A bare act ("pressing") says little: Dool2's own line about it says more
  const specific = last.detail?.some((d) => d.k === 'press' || d.k === 'field')
  const what = specific ? actText(last, true) : last.text && last.text !== last.act ? last.text : last.act
  // "Weather · checking the weather" says the name twice: a step that already names its place goes alone
  return place && !what.includes(place) ? [h('b', { text: place }), ` · ${what}`] : [what]
}

/** The newest finished work record in the chat (a live sheet shows it once the turn ended) */
function lastRecord(): WorkRecordMessage | undefined {
  for (let i = st.conv.length - 1; i >= 0; i--) {
    const m = st.conv[i]
    if (m?.role === 'tool' && m.text.includes('"kind":"work"'))
      try {
        return JSON.parse(m.text) as WorkRecordMessage
      } catch {
        return undefined
      }
    if (m?.role === 'user') return undefined
  }
  return undefined
}

// ── In the chat ──

/** The turn running now: one live line (replaces the old working card) */
export function liveLine(): HTMLElement {
  const el = h('div', { class: 'wline-wrap' })
  updateLiveLine(el)
  // The time runs on while the line is on screen
  const tick = () => {
    if (!el.isConnected && el.childElementCount) return
    const t = el.querySelector('.wl-meta')
    const from = st.workFrom ?? stepAt[0]
    if (t && from) t.textContent = clock(from)
    setTimeout(tick, 1000)
  }
  tick()
  return el
}

export function updateLiveLine(el: HTMLElement) {
  const steps = liveSteps()
  const writing = st.live && steps.length ? dropEnglishLines(st.live, lang) : ''
  const fp = finishProgress(st.conv, { running: st.busy, checking: st.checking })
  const text = st.checking
    ? [tChat.checkingTitle]
    : fp?.rounds
      ? [fp.next ? tChat.continuingTitle(fp.next) : tChat.continuingPlain]
      : writing
        ? [tChat.writingTitle]
        : nowText(steps, w().workingTitle)
  const from = st.workFrom ?? stepAt[0]
  const line = lineEl('doing', dots(), text, from ? clock(from) : '', () =>
    openOverlay({ kind: 'work', src: { kind: 'live' } }),
  )
  const sig = line.textContent ?? ''
  if (el.dataset.sig === sig.replace(/\d+:\d+$/, '')) return
  el.dataset.sig = sig.replace(/\d+:\d+$/, '')
  el.replaceChildren(line)
}

/** A finished turn: "worked at … · time", tap for the sheet */
export function doneLine(rec: WorkRecordMessage): HTMLElement {
  const key = `r${rec.ms}-${rec.count}-${rec.steps[0]?.text ?? ''}`
  records.set(key, rec)
  const steps = asSteps(rec.steps)
  const at = places(steps)
  const lead = at[0] ? mark(at[0]) : h('span', { class: 'wl-ok' }, icon('check', 'i'))
  const text =
    at.length === 1
      ? [w().workedAtHead, h('b', { text: at[0]?.title ?? '' }), w().workedAtTail]
      : at.length > 1
        ? [w().lookedAt(at.length)]
        : rec.host
          ? [
              w().workedAtHead,
              h('b', { text: cardForHost(rec.host, placeCards())?.name ?? rec.host }),
              w().workedAtTail,
            ]
          : [`${w().process} · ${w().stepCount(rec.count)}`]
  return lineEl('done', lead, text, secs(rec.ms), () =>
    openOverlay({ kind: 'work', src: { kind: 'rec', key } }),
  )
}

/** A task (ADR 0038): the same line, live while it runs, yellow while it waits for the person, then done */
export function taskLine(rec: TaskRecordMessage): HTMLElement {
  const v = st.tasks.get(rec.id)
  const open = () => openOverlay({ kind: 'work', src: { kind: 'task', id: rec.id } })
  let line: HTMLElement
  if (!v || v.status === 'done' || v.status === 'stopped' || v.status === 'failed') {
    const steps = v ? asSteps(v.steps) : []
    const at = places(steps)
    const ms = v?.endedAt ? Date.parse(v.endedAt) - Date.parse(v.startedAt ?? v.createdAt) : 0
    const lead =
      at[0] && v?.status === 'done'
        ? mark(at[0])
        : h('span', { class: 'wl-ok' }, icon(v?.status === 'done' ? 'check' : 'close', 'i'))
    const text =
      v?.status === 'stopped'
        ? [h('b', { text: rec.title }), ` · ${tChat.taskStopped}`]
        : v?.status === 'failed'
          ? [h('b', { text: rec.title }), ` · ${tChat.taskFailed}`]
          : at.length === 1
            ? [w().workedAtHead, h('b', { text: at[0]?.title ?? '' }), w().workedAtTail]
            : at.length > 1
              ? [w().lookedAt(at.length)]
              : [h('b', { text: rec.title })]
    line = lineEl(`done${v?.status === 'done' ? '' : ' off'}`, lead, text, ms ? secs(ms) : '', open)
  } else if (v.status === 'needs-you') {
    const wait = waiting()
    line = lineEl(
      'wait',
      h('span', { class: 'wl-wait' }),
      [h('b', { text: w().nowWaitsYou }), wait ? ` · ${wait.label}` : ''],
      '',
      wait?.open ?? open,
    )
  } else {
    const steps = asSteps(v.steps)
    const text =
      v.status === 'waiting'
        ? [h('b', { text: rec.title }), ` · ${w().nowInLine(v.ahead ?? 0)}`]
        : v.status === 'checking'
          ? [tChat.checkingTitle]
          : nowText(steps, rec.title)
    line = lineEl('doing', dots(), text, clock(Date.parse(v.startedAt ?? v.createdAt)), open)
  }
  const wrap = h('div', { class: 'wline-wrap' }, line)
  wrap.dataset.task = rec.id
  return wrap
}

// ── The sheet ──

const DETAIL_LABEL: Record<StepDetail['k'], () => string> = {
  url: () => w().dUrl,
  press: () => w().dPress,
  field: () => w().dField,
  query: () => w().dQuery,
  page: () => w().dPage,
}

/** Steps whose details are open in the sheet (kept across redraws while it is open) */
const openRows = new Set<string>()

function timeline(steps: Step[], running: boolean, wait?: { label: string; open: () => void }): HTMLElement {
  const list = h('ol', { class: 'wtl' })
  let said = ''
  steps.forEach((s, i) => {
    // Dool2's self-talk before the action: one grey line (only when it said something, and not the same again)
    if (s.text && s.text !== s.act && s.text !== said) {
      said = s.text
      list.append(h('li', { class: 'wtl-say' }, h('span', { class: 'wtl-dot' }), h('span', { text: s.text })))
    }
    const g = groupOf(s)
    const now = running && i === steps.length - 1
    const title = g && (g.kind === 'web' || g.kind === 'service') ? g.title : s.act
    const sub = g && (g.kind === 'web' || g.kind === 'service') ? actText(s, now) : ''
    const key = `${i}:${s.act}`
    const has = Boolean(s.detail?.length)
    const row = h(
      'li',
      { class: `wtl-act${now ? ' cur' : ''}${has ? ' has' : ''}` },
      mark(g),
      h('span', { class: 'wtl-x' }, h('b', { text: title }), sub ? h('small', { text: sub }) : ''),
      h('span', { class: 'wtl-ms', text: !now && s.ms !== undefined ? secs(s.ms) : '' }),
      has ? icon('chevron', `i wtl-chev${openRows.has(key) ? ' open' : ''}`) : '',
    )
    if (has)
      row.addEventListener('click', () => {
        if (openRows.has(key)) openRows.delete(key)
        else openRows.add(key)
        const box = row.nextElementSibling
        if (box?.classList.contains('wtl-detail')) box.toggleAttribute('hidden')
        row.querySelector('.wtl-chev')?.classList.toggle('open')
      })
    list.append(row)
    if (has) {
      const dl = h('li', { class: 'wtl-detail' })
      if (!openRows.has(key)) dl.hidden = true
      for (const d of s.detail ?? [])
        dl.append(
          h('span', { class: 'dt', text: DETAIL_LABEL[d.k]() }),
          h('span', { class: 'dd', text: d.v }),
        )
      list.append(dl)
    }
  })
  if (wait)
    list.append(
      h(
        'li',
        { class: 'wtl-act wait', onclick: wait.open },
        h('span', { class: 'svc-mark wl-mark plain wait' }, icon('hand', 'i')),
        h('span', { class: 'wtl-x' }, h('b', { text: w().nowWaitsYou }), h('small', { text: wait.label })),
        icon('chevron', 'i wtl-chev'),
      ),
    )
  return list
}

function draftBox(text: string, take?: () => void): HTMLElement[] {
  if (!text) return []
  return [
    h(
      'details',
      { class: 'wc-draft' },
      h('summary', { text: tChat.seeDraft }),
      h('div', { class: 'rich' }, rich(text)),
    ),
    ...(take ? [h('button', { class: 'btn-ghost sm wp-take', text: tChat.takeAsIs, onclick: take })] : []),
  ]
}

/** The "how it worked" sheet for a turn or a task */
export function workSheet(src: SheetSrc): HTMLElement {
  const sheet = h('section', { class: 'sheet float app-sheet rise work-sheet' })
  let steps: Step[] = []
  let meta = ''
  let stop: (() => void) | undefined
  let extra: HTMLElement[] = []
  let wait: { label: string; open: () => void } | undefined
  let running = false
  let view: HTMLElement | undefined
  // The turn ended while the sheet was open: it goes on showing that turn's record
  const ended = src.kind === 'live' && !st.steps.length ? lastRecord() : undefined
  if (ended) {
    steps = asSteps(ended.steps)
    meta = `${secs(ended.ms)} · ${w().stepCount(ended.count)}`
  } else if (src.kind === 'live') {
    steps = liveSteps()
    running = st.busy
    const from = st.workFrom ?? stepAt[0]
    meta = from ? clock(from) : ''
    if (running) stop = () => void send({ kind: 'conversation-cancel' })
    const fp = finishProgress(st.conv, { running: st.busy, checking: st.checking })
    const draft = fp?.draft ? st.conv.find((m) => m.id === fp.draft) : undefined
    const writing = st.live && steps.length ? dropEnglishLines(st.live, lang) : ''
    extra = draftBox(
      writing || draft?.text || '',
      draft ? () => void send({ kind: 'conversation-accept' }) : undefined,
    )
    const tab = st.work.tabId
    if (running && st.work.web && tab !== undefined)
      view = h('button', { class: 'btn-ghost wide', text: w().viewDoori, onclick: () => openRemote(tab) })
  } else if (src.kind === 'rec') {
    const rec = records.get(src.key)
    if (rec) {
      steps = asSteps(rec.steps)
      meta = `${secs(rec.ms)} · ${w().stepCount(rec.count)}`
    }
  } else {
    const v: TaskView | undefined = st.tasks.get(src.id)
    if (v) {
      steps = asSteps(v.steps)
      const ended = v.status === 'done' || v.status === 'stopped' || v.status === 'failed'
      running = !ended && v.status !== 'needs-you'
      const from = Date.parse(v.startedAt ?? v.createdAt)
      meta =
        ended && v.endedAt ? `${secs(Date.parse(v.endedAt) - from)} · ${w().stepCount(v.count)}` : clock(from)
      if (!ended) stop = () => void send({ kind: 'task', id: v.id, action: 'stop' })
      if (v.status === 'needs-you') wait = waiting()
      extra = draftBox(
        v.draft ?? '',
        v.draft || v.continuing ? () => void send({ kind: 'task', id: v.id, action: 'accept' }) : undefined,
      )
    }
  }
  sheet.append(
    h(
      'div',
      { class: 'ws-head' },
      h('h3', { text: w().sheetTitle }),
      h('span', { class: 'ws-meta', text: meta }),
      stop ? h('button', { class: 'ws-stop', text: tChat.stopWork, onclick: stop }) : '',
    ),
    timeline(steps, running, wait),
    ...extra,
    ...(view ? [view] : []),
  )
  return sheet
}
