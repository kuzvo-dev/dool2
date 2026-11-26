// Phone app: the chat list (only changed messages), the return summary and inline chat cards
import type {
  ApprovalRecordMessage,
  CardsRecordMessage,
  ConnectRecordMessage,
  HandoffRecord,
  LeftRecordMessage,
  LoginRecordMessage,
  MadeImageRecordMessage,
  TaskRecordMessage,
  TaskView,
  TellRecordMessage,
  WorkRecordMessage,
} from '@dool2/protocol'
import { type BlockEnv, blockView } from '@dool2/protocol/blocks-view'
import {
  dropEnglishLines,
  finishProgress,
  handoffOpen,
  handoffRecord,
  interimAnswers,
  readAppNote,
  splitPhoto,
} from '@dool2/protocol/rich'
import { AWAY_MIN_MS, awaySummary } from '@dool2/protocol/work-steps'
import { doori, h, type IconName, icon, rich } from '../dom.js'
import { lang } from '../lang.js'
import { gooFilter } from '../motion.js'
import { rollNumbers } from '../motion-cards.js'
import { approvalInline, cardIdFor, connectFor } from './approval-cards.js'
import { ask } from './ask.js'
import {
  cardsInline,
  connectInline,
  loginInline,
  loginLink,
  madeInline,
  tellInline,
  thumbOf,
} from './cards.js'
import { mark, openEarlier, send, st, tChat, tShell } from './core.js'
import { connect, forgetPc } from './link.js'
import { feedPager } from './lists.js'
import { openOverlay, render, setTab, shell } from './shell.js'
import { isSms, smsStates } from './sms.js'
import {
  agentOn,
  connectWaiting,
  openRemote,
  taskInline,
  updateWorkPanel,
  workDone,
  workPanel,
} from './work.js'

// ── Chat: only changed messages ──

/** What the user said after record i (including a message being sent). undefined if none */
function saidAfter(i: number): string | undefined {
  for (const m of st.conv.slice(i + 1)) if (m.role === 'user') return readAppNote(m.text) ?? m.text
  return st.pending[0]?.text
}

/** What result blocks (quick replies, list rows, result card, draft to send) use: send a message, open an outside link, photos, copy */
const blockEnv: BlockEnv = {
  send: (text) => ask(text),
  open: (url) => openOutside(url),
  thumb: (url) => thumbOf(url),
  copy: (text) =>
    navigator.clipboard?.writeText(text).then(
      () => true,
      () => false,
    ) ?? Promise.resolve(false),
}

/** Open in the browser outside the app (or that service's app) */
function openOutside(url: string) {
  try {
    mark(`open external ${new URL(url).host}`)
  } catch {}
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.click()
}

/** Date of the message at the top of the screen. Empty if that day's date line is still visible, so they do not overlap */
export function dayAtTop(page: HTMLElement, chat: HTMLElement): string {
  const top = page.getBoundingClientRect().top + 120
  let label = ''
  for (const sep of chat.querySelectorAll<HTMLElement>(':scope > .day-sep')) {
    const y = sep.getBoundingClientRect().top
    if (y > top) {
      // If the next date line has scrolled up right under the floating date, hide the floating one
      if (y < top + 36) return ''
      break
    }
    label = sep.textContent ?? ''
  }
  return label
}

/** Date key (YYYY-M-D in this phone's time zone) */
function dayKey(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** Date line text: Today · Yesterday · Thursday, November 20 (with the year if not this year) */
function dayLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const key = dayKey(iso)
  if (key === dayKey(now.toISOString())) return tChat.today
  if (key === dayKey(new Date(now.getTime() - 86_400_000).toISOString())) return tChat.yesterday
  return d.toLocaleDateString(tChat.locale, {
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
}

/** Time beside a bubble (6:14 PM). If the same person kept talking in the same minute, only on the last bubble */
function bubbleTime(i: number): string {
  const m = st.conv[i]
  if (!m) return ''
  const minute = (iso: string) => iso.slice(0, 16)
  const next = st.conv[i + 1]
  if (
    next &&
    next.role === m.role &&
    minute(next.createdAt) === minute(m.createdAt) &&
    (m.role !== 'user' || readAppNote(next.text) === undefined)
  )
    return ''
  const d = new Date(m.createdAt)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(tChat.locale, { hour: 'numeric', minute: '2-digit' })
}

/** What the chat list should contain (key, signature, build). Unchanged if the signature is the same */
type Item = { key: string; sig: string; make: () => HTMLElement }

function chatItems(): Item[] {
  const items: Item[] = []
  if (st.pcSilent) items.push({ key: 'silent', sig: st.saved?.pcName ?? '', make: silentCard })
  const first = st.conv[0]
  if (st.hasMore && first)
    items.push({
      key: 'more',
      sig: first.id,
      make: () =>
        h('button', {
          class: 'btn-text more',
          text: tChat.earlier,
          onclick: () => void send({ kind: 'conversation', before: first.createdAt }),
        }),
    })
  if (st.convLoaded && !st.conv.length && !st.pending.length)
    items.push({ key: 'hello', sig: st.saved?.pcName ?? '', make: helloCard })
  let lastNote = ''
  let lastDay = ''
  const superseded = oldConnectCards()
  // One answer per request: answers the finish check sent back and replaced are folded (open with "show earlier answers")
  const fold = interimAnswers(st.conv, { running: st.busy })
  // The answer being checked or continued stays in the progress card as a draft, never as a message first (ADR 0027)
  const progress = finishProgress(st.conv, { running: st.busy, checking: st.checking })
  if (progress?.draft) fold.hidden.add(progress.draft)
  const revealed = new Set([...fold.replaced].filter(([f]) => openEarlier.has(f)).flatMap(([, ids]) => ids))
  const roleOf = new Map(st.conv.map((m) => [m.id, m.role]))
  for (const [i, m] of st.conv.entries()) {
    if (fold.hidden.has(m.id) && !revealed.has(m.id)) continue
    const earlier = fold.replaced.get(m.id)
    if (earlier) {
      const n = earlier.filter((id) => roleOf.get(id) === 'assistant').length
      const open = openEarlier.has(m.id)
      items.push({
        key: `earlier:${m.id}`,
        sig: open ? '1' : '0',
        make: () =>
          h('button', {
            class: 'btn-text earlier-answers',
            text: open ? tChat.hideEarlierAnswers : tChat.showEarlierAnswers(n),
            onclick: () => {
              if (open) openEarlier.delete(m.id)
              else openEarlier.add(m.id)
              render()
            },
          }),
      })
    }
    // If the same notice was recorded several times in a row (old records), show only one
    const noteText = m.role !== 'assistant' && m.role !== 'tool' ? readAppNote(m.text) : undefined
    if (noteText !== undefined && noteText === lastNote) continue
    lastNote = noteText ?? ''
    // When the day changes, a date line in the middle (while scrolling, the floating date follows)
    const day = dayKey(m.createdAt)
    if (day && day !== lastDay) {
      lastDay = day
      const label = dayLabel(m.createdAt)
      items.push({ key: `day:${day}`, sig: label, make: () => h('p', { class: 'day-sep', text: label }) })
    }
    // Several connect cards for the same service: only the last one is drawn (it shows the state now). Earlier ones each
    // became a "connected" line too, three in a row after a retry (audit 11-26)
    if (m.role === 'tool' && superseded.has(m.id)) continue
    if (m.role === 'tool') {
      // A hand-off closes once the conversation moved on
      const old = superseded.has(m.id) || (m.text.includes('"kind":"handoff"') && !handoffOpen(st.conv, i))
      // Quick replies and multi-select need to know what the user said next, to draw faded and locked
      const used = /"kind":"quick"|"pick":"multi"/.test(m.text) ? saidAfter(i) : undefined
      items.push({
        key: m.id,
        sig: `${old ? 'old:' : ''}${toolSig(m.text)}:${st.services ? 1 : 0}:${used ?? ''}`,
        make: () => toolCard(m.text, !old, used),
      })
    } else if (m.role === 'user') {
      // Notices the Dool2 app sent to the AI (approval results, etc.) are not my words, so show them as a small centered line
      const note = readAppNote(m.text)
      const time = note === undefined ? bubbleTime(i) : ''
      items.push({
        key: m.id,
        sig: time,
        make: () => {
          if (note !== undefined) return h('p', { class: 'msg note' }, note)
          const b = meBubble(m.text)
          if (time) b.dataset.time = time
          return b
        },
      })
    } else if (m.role === 'assistant') {
      const time = bubbleTime(i)
      items.push({
        key: m.id,
        sig: time,
        make: () => {
          const b = h('div', { class: 'bubble rich' })
          b.append(rich(m.text))
          if (time) b.dataset.time = time
          onLongPress(b, () => openOverlay({ kind: 'msg', id: m.id }))
          // For a reply that just arrived, money and percentages roll into place (loaded older chat stays as is)
          if (Date.now() - Date.parse(m.createdAt) < 60_000) rollNumbers(b)
          return b
        },
      })
    } else {
      const note = readAppNote(m.text)
      items.push({
        key: m.id,
        sig: '',
        make: () => h('p', { class: 'msg note', text: note ?? m.text }),
      })
    }
  }
  const away = awayItem()
  if (away) items.push(away)
  for (const p of st.pending)
    items.push({
      key: `p${p.id}`,
      sig: '',
      make: () => meBubble(p.text, p.photo, 'bubble me sending'),
    })
  st.queued.forEach((q, i) => {
    items.push({
      key: `q${i}`,
      sig: q,
      make: () =>
        h(
          'div',
          { class: 'queued' },
          h('div', { class: 'bubble me', text: q }),
          h('span', { class: 'meta', text: tChat.continued }),
        ),
    })
  })
  if (st.busy || st.pending.length) {
    const shot = st.work.web && st.busy && st.work.tabId !== undefined && st.work.shot
    // The work process is one card: the screen being viewed + steps (like the landing page's "Looking at ...")
    // While the answer is a draft (being written after tools, checked, or continued) it lives in this card too
    const card = st.busy && (st.steps.length || shot || progress)
    if (card) items.push({ key: 'work', sig: '', make: workPanel })
    // Until the reply text starts streaming, keep "•••" under the work card too, so it feels like it is writing (user request, 11-22)
    if (st.live && !card) items.push({ key: 'live', sig: '', make: liveBubble })
    else if (!progress && !st.live)
      items.push({
        key: 'typing',
        sig: '',
        make: thinkingDots,
      })
  }
  return items
}

// ── Return summary: what happened while the person was away, from stored records (no AI) ──

const SEEN_KEY = 'dool2.seenAt'
export const chatVars: {
  /** When the person was last here, if it was long enough ago to sum up */
  awayFrom: number | undefined
} = { awayFrom: undefined }
export function noteSeen() {
  localStorage.setItem(SEEN_KEY, String(Date.now()))
}
export function checkAway() {
  const seen = Number(localStorage.getItem(SEEN_KEY))
  if (seen && Date.now() - seen >= AWAY_MIN_MS) chatVars.awayFrom = seen
  noteSeen()
}
const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(tChat.locale, { hour: 'numeric', minute: '2-digit' })

function awayItem(): Item | undefined {
  if (chatVars.awayFrom === undefined) return undefined
  const s = awaySummary({
    since: chatVars.awayFrom,
    now: Date.now(),
    feed: st.life?.feed ?? [],
    approvals: [...st.approvals.values()],
    logins: [...st.logins.values()],
  })
  if (!s) return undefined
  return {
    key: 'away',
    sig: JSON.stringify(s),
    make: () =>
      h(
        'div',
        { class: 'card quiet away-card' },
        h('div', { class: 'card-label', text: tChat.awayTitle }),
        s.doneCount > 0 && h('p', { text: tChat.awayDone(s.doneCount) }),
        s.doneCount > 0 && h('ul', {}, ...s.done.map((d) => h('li', { text: d.title }))),
        s.decidedCount > 0 && h('p', { text: tChat.awayDecided(s.decidedCount) }),
        s.decidedCount > 0 &&
          h(
            'ul',
            {},
            ...s.decided.map((d) =>
              h(
                'li',
                {},
                d.title,
                h('div', { class: 'away-if', text: d.approved ? tChat.awayApproved : tChat.awayRejected }),
              ),
            ),
          ),
        s.waiting.length > 0 && h('p', { text: tChat.awayWaiting }),
        s.waiting.length > 0 &&
          h(
            'ul',
            {},
            ...s.waiting.map((w) =>
              h(
                'li',
                {},
                w.title,
                h('div', {
                  class: 'away-if',
                  text:
                    w.kind === 'approval'
                      ? tChat.awayApprovalIfNot(timeOf(w.expiresAt))
                      : tChat.awayLoginIfNot(timeOf(w.expiresAt)),
                }),
              ),
            ),
          ),
        h('button', {
          class: 'btn-text sm',
          text: tChat.awayOk,
          onclick: () => {
            chatVars.awayFrom = undefined
            render()
          },
        }),
      ),
  }
}

/** My bubble: if a photo was sent, the photo (right after sending) or a "Photo" chip */
function meBubble(raw: string, photo?: string, cls = 'bubble me') {
  const { text, photo: name } = splitPhoto(raw)
  const b = h('div', { class: `${cls}${photo || name ? ' with-photo' : ''}` })
  if (photo) {
    const img = h('img', { class: 'sent-photo' })
    img.src = `data:image/jpeg;base64,${photo}`
    img.alt = tChat.photoSent
    b.append(img)
  } else if (name) {
    // Photos from earlier messages or other devices: ask the PC and show them (a "Photo" chip before they arrive or if they fail)
    const chip = h('span', { class: 'photo-chip' }, icon('image', 'i'), tChat.photo)
    b.append(chip)
    void thumbOf(`photo:${name}`).then((data) => {
      if (!data) return
      const img = h('img', { class: 'sent-photo' })
      img.src = data
      img.alt = tChat.photoSent
      chip.replaceWith(img)
    })
  }
  if (text) b.append(h('span', { text }))
  return b
}

/** Long press (phone) · right click (desktop browser) */
function onLongPress(el: HTMLElement, fn: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let x = 0
  let y = 0
  const cancel = () => clearTimeout(timer)
  el.addEventListener('pointerdown', (e) => {
    x = e.clientX
    y = e.clientY
    timer = setTimeout(() => {
      navigator.vibrate?.(10)
      fn()
    }, 480)
  })
  el.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - x) > 8 || Math.abs(e.clientY - y) > 8) cancel()
  })
  el.addEventListener('pointerup', cancel)
  el.addEventListener('pointercancel', cancel)
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    cancel()
    fn()
  })
}

/** Thinking: three dots bounce in turn and stretch into each other with a gooey filter */
export function thinkingDots() {
  gooFilter()
  return h(
    'span',
    { class: 'typing goo', label: tChat.thinking },
    h('span', { class: 'goo-dots' }, h('i'), h('i'), h('i')),
  )
}

function liveBubble() {
  const b = h('div', { class: 'bubble rich streaming' })
  b.append(rich(dropEnglishLines(st.live, lang)))
  riseWords(b)
  return b
}

/**
 * Streaming reply: only newly arrived words float up from below and sharpen.
 * Words are wrapped on every redraw, and only those after the count of words already shown move
 */
function riseWords(el: HTMLElement) {
  const seen = Number(el.dataset.words ?? 0)
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  let i = 0
  for (const node of nodes) {
    const parts = (node.textContent ?? '').split(/(\s+)/)
    if (parts.length <= 1 && !parts[0]?.trim()) continue
    const frag = document.createDocumentFragment()
    for (const p of parts) {
      if (!p) continue
      if (/^\s+$/.test(p)) {
        frag.append(p)
        continue
      }
      const w = document.createElement('span')
      w.className = i >= seen ? 'wd wd-in' : 'wd'
      if (i >= seen) w.style.animationDelay = `${Math.min(i - seen, 8) * 35}ms`
      w.textContent = p
      frag.append(w)
      i++
    }
    node.replaceWith(frag)
  }
  el.dataset.words = String(i)
}

export function syncChat() {
  const list = shell?.chat
  if (!list) return
  const want = chatItems()
  const have = new Map<string, HTMLElement>()
  for (const el of [...list.children] as HTMLElement[]) if (el.dataset.key) have.set(el.dataset.key, el)
  const keep = new Set<string>()
  let prev: Element | null = null
  for (const it of want) {
    keep.add(it.key)
    let el = have.get(it.key)
    if (el && it.key === 'live') {
      // A streaming reply only swaps the text
      el.replaceChildren(rich(dropEnglishLines(st.live, lang)))
      riseWords(el)
    } else if (el && it.key === 'work') {
      // The work card only appends new steps (leaving the current screen picture as is)
      updateWorkPanel(el)
    } else if (!el || el.dataset.sig !== it.sig) {
      const fresh = it.make()
      fresh.dataset.key = it.key
      fresh.dataset.sig = it.sig
      if (!el) fresh.classList.add('rise')
      if (el) el.replaceWith(fresh)
      el = fresh
    }
    const next: Element | null = prev ? prev.nextElementSibling : list.firstElementChild
    if (next !== el) {
      if (prev) prev.after(el)
      else list.prepend(el)
    }
    prev = el
  }
  for (const [k, el] of have) if (!keep.has(k)) el.remove()
}

/** When the PC is not answering: the reason and what to do, instead of a blank screen */
function silentCard() {
  const pc = st.saved?.pcName ?? 'PC'
  return h(
    'div',
    { class: 'card ask-card silent-card' },
    h('div', { class: 'card-label' }, doori('sleeping', 22), tChat.pcSilentTitle(pc)),
    h('p', {
      class: 'card-text',
      text: tChat.pcSilentBody,
    }),
    h(
      'div',
      { class: 'approve-actions' },
      h('button', { class: 'btn-ghost', text: tChat.retry, onclick: () => connect() }),
      h('button', { class: 'btn', text: tChat.reconnect, onclick: () => void forgetPc() }),
    ),
  )
}

function helloCard() {
  return h(
    'div',
    { class: 'hello' },
    h('div', { class: 'bubble', text: tChat.hello(st.saved?.pcName ?? tShell.myPc) }),
    h('div', {
      class: 'bubble',
      text: tChat.helloBody,
    }),
    h(
      'div',
      { class: 'quick' },
      ...[tChat.quick1, tChat.quick2, tChat.quick3].map((q) =>
        h('button', { text: q, onclick: () => ask(q) }),
      ),
    ),
    h(
      'div',
      { class: 'card start-card' },
      h('strong', { text: tChat.startTitle }),
      ...(
        [
          ['apps', '1', tChat.start1, () => setTab('connect')],
          ['feed', '2', tChat.start2, () => setTab('feed')],
          ['goal', '3', tChat.start3, () => setTab('goals')],
        ] as [IconName, string, string, () => void][]
      ).map(([ic, n, t, go]) =>
        h(
          'button',
          { class: 'start-step', onclick: go },
          h('span', { class: 'start-n', text: n }),
          h('span', { class: 'row-t', text: t }),
          icon(ic, 'i'),
        ),
      ),
    ),
  )
}

/** What a task card shows, so the chat list redraws it when the task moves on (and leaves it alone otherwise) */
function taskSig(v: TaskView | undefined): string {
  if (!v) return 'task:none'
  const last = v.steps.at(-1)
  return [
    'task',
    v.status,
    v.count,
    v.steps.length,
    last ? JSON.stringify(last) : '',
    v.now ?? '',
    v.continuing ? 1 : 0,
    v.ahead ?? '',
    v.notes ?? '',
    v.draft?.length ?? 0,
    v.endedAt ?? '',
    v.title,
  ].join(':')
}

function toolSig(raw: string) {
  try {
    const rec = JSON.parse(raw) as { kind?: string }
    if (rec.kind === 'approval') {
      const a = approvalFor(rec as ApprovalRecordMessage)
      // Also include the payment method, card and installments chosen on the approval card. Without them, tapping a chip did not redraw the card and the choice did not change (measured)
      const picked = a
        ? [...st.choice]
            .filter(([k]) => k === a.id || k.startsWith(`${a.id}:`))
            .map(([k, v]) => `${k}=${v}`)
            .join(',')
        : ''
      // Text card: also the recipient search result, the chosen person and the error (leave out the number being typed, or the field is redrawn and typing breaks)
      const sms = a && isSms(a) ? smsStates.get(a.id) : undefined
      const smsSig = sms ? `${sms.state}:${sms.people.length}:${sms.pick}:${sms.error ?? ''}` : ''
      return `${a?.id}:${a?.status}:${a ? (st.decided.get(a.id)?.message ?? '') : ''}:${picked}:${smsSig}`
    }
    if (rec.kind === 'login') {
      const l = loginFor(rec as LoginRecordMessage)
      const link = l ? loginLink(l.origin) : undefined
      const steps = link ? (st.connectSteps.get(link.cid)?.length ?? 0) : 0
      const agent = link?.fail && agentOn(link.fail) ? 'agent' : ''
      return `${l?.id}:${l?.status}:${link?.busy ?? ''}:${link?.fail?.reason ?? ''}:${agent}:${steps}`
    }
    if (rec.kind === 'tell')
      return `tell:${feedPager.items.find((f) => f.id === (rec as TellRecordMessage).id)?.answered ?? ''}`
    if (rec.kind === 'task') return taskSig(st.tasks.get((rec as TaskRecordMessage).id))
    if (rec.kind === 'connect') {
      const it = connectFor(rec as ConnectRecordMessage)
      const steps = it ? (st.connectSteps.get(it.card.id)?.length ?? 0) : 0
      const wait = it ? (connectWaiting(it.card.id)?.kind ?? '') + (connectWaiting(it.card.id)?.id ?? '') : ''
      const f = it ? st.connectFails.get(it.card.id) : undefined
      const fail = f ? `${f.reason}${agentOn(f) ? ':agent' : ''}` : ''
      const peek = it && st.connectLive.get(it.card.id)?.shot ? 1 : 0
      // Whether that service's ID and password card is showing (the connect card points to it)
      const login = it
        ? ([...st.logins.values()].find((l) => l.status === 'pending' && cardIdFor(l.origin) === it.card.id)
            ?.id ?? '')
        : ''
      const chrome = st.pc?.extension === false ? 'off' : ''
      return `${it?.card.id}:${it?.connectedAt ?? ''}:${it && st.connecting.has(it.card.id)}:${steps}:${wait}:${fail}:${peek}:${login}:${chrome}`
    }
  } catch {}
  return ''
}

export function approvalFor(rec: ApprovalRecordMessage) {
  return [...st.approvals.values()]
    .filter((x) => x.tabId === rec.tabId && x.ref === rec.ref)
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0]
}

export function loginFor(rec: LoginRecordMessage) {
  return [...st.logins.values()]
    .filter((x) => x.tabId === rec.tabId)
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0]
}

/** Cards that have another connect card for the same service after them (message ids) */
function oldConnectCards(): Set<string> {
  const lastFor = new Map<string, string>()
  const out = new Set<string>()
  // Quick replies the daemon added after the answer (what the check found left, as a button) carry the earlier ones
  // too: only the last row under one answer is drawn
  let lastQuick: string | undefined
  for (const m of st.conv) {
    if (m.role !== 'tool') lastQuick = undefined
    else if (m.text.includes('"kind":"quick"')) {
      if (lastQuick) out.add(lastQuick)
      lastQuick = m.id
    }
    if (m.role !== 'tool' || !m.text.includes('"kind":"connect"')) continue
    try {
      const rec = JSON.parse(m.text) as ConnectRecordMessage
      const id = connectFor(rec)?.card.id ?? rec.service
      const prev = lastFor.get(id)
      if (prev) out.add(prev)
      lastFor.set(id, m.id)
    } catch {}
  }
  return out
}

export function toolCard(raw: string, live = true, used?: string): HTMLElement {
  let rec:
    | HandoffRecord
    | ApprovalRecordMessage
    | LoginRecordMessage
    | ConnectRecordMessage
    | WorkRecordMessage
    | TellRecordMessage
    | CardsRecordMessage
  try {
    rec = JSON.parse(raw)
  } catch {
    return h('span')
  }
  const block = blockView(rec as { kind?: string }, blockEnv, used, lang)
  if (block) return block
  if (rec.kind === 'approval') return approvalInline(rec)
  if (rec.kind === 'login') return loginInline(rec)
  if (rec.kind === 'connect') return connectInline(rec, live)
  if (rec.kind === 'work') return workDone(rec)
  if ((rec as { kind?: string }).kind === 'task') return taskInline(rec as unknown as TaskRecordMessage)
  if ((rec as { kind?: string }).kind === 'left') return leftInline(rec as unknown as LeftRecordMessage, live)
  if (rec.kind === 'tell') return tellInline(rec)
  if (rec.kind === 'cards') return cardsInline(rec)
  if ((rec as { kind?: string }).kind === 'made') return madeInline(rec as unknown as MadeImageRecordMessage)
  // Your turn. Only a real hand-off with its reason: a record this app does not know yet draws nothing (an older
  // phone drew the task card record as an empty "Your turn" card that never went away, 11-25)
  const hand = handoffRecord(rec)
  if (!hand) return h('span')
  // Once the conversation moved on (or its task ended), one quiet line without the button
  if (!live) return h('p', { class: 'done-line hand-line' }, icon('check', 'i'), tChat.handDone(hand.reason))
  const tabId = hand.tabId
  return h(
    'div',
    { class: 'card ask-card' },
    h('div', { class: 'card-label' }, doori('asking', 22), tChat.handTitle),
    h('p', { class: 'card-text', text: hand.reason }),
    tabId !== undefined &&
      h('button', { class: 'btn-ghost', text: tChat.openPc, onclick: () => openRemote(tabId) }),
  )
}

/** What the before-finishing check left at its limit, with [Continue] (only until the next message) */
function leftInline(rec: LeftRecordMessage, live: boolean): HTMLElement {
  const go = h('button', {
    class: 'btn-ghost sm',
    text: tChat.continueLeft,
    onclick: () => {
      go.setAttribute('disabled', '')
      void send({ kind: 'conversation-continue' })
    },
  })
  if (!live || st.busy) go.setAttribute('disabled', '')
  return h(
    'div',
    { class: 'card quiet left-card' },
    h('div', { class: 'card-label', text: tChat.leftTitle }),
    h('p', { text: rec.why }),
    go,
  )
}
