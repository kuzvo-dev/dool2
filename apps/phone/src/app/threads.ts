// Phone app: separate chats (side conversations)
import { type DaemonStreamEvent, SIDE_THREAD_PEEK } from '@dool2/protocol'
import { handoffOpen, narrationLine, readAppNote, toolLabel } from '@dool2/protocol/rich'
import { doori, h, icon, rich } from '../dom.js'
import { lang } from '../lang.js'
import { mdSide } from '../locales/main-d-side.js'
import { FEED_THREAD_TITLE } from '../region/kr/main-d.js'
import { approvalSheet } from './approval-sheet.js'
import { thinkingDots, toolCard } from './chat.js'
import { send, st } from './core.js'
import { infoSheet, loginSheet } from './login-sheets.js'
import { renderOverlay } from './overlays.js'
import { autosize, openOverlay, render } from './shell.js'
import { hello } from './sms.js'

// ── Separate chats ──

function sideThreads() {
  return (st.pc?.threads ?? []).filter((t) => t.side && t.title !== FEED_THREAD_TITLE)
}

/** Separate chats in the menu: show the latest few and expand the rest with "Show more" (the drawer scrolls as a whole) */
export function sideMenu(): Node[] {
  const all = sideThreads()
  // Chats that are replying come first, so they show even when the list is folded
  const pinned = all.filter((t) => t.busy)
  const rest = all.filter((t) => !pinned.includes(t))
  const ordered = [...pinned, ...rest]
  const shown = st.sideAll ? ordered : ordered.slice(0, SIDE_THREAD_PEEK)
  const more = ordered.length - shown.length
  const items: Node[] = shown.map((t) =>
    h(
      'button',
      { class: 'navi side-item', onclick: () => openSide(t.id, t.title) },
      h('span', { class: t.busy ? 'dot work pulse' : 'dot' }),
      h('span', { class: 'side-name', text: t.title }),
    ),
  )
  if (!all.length) items.push(h('p', { class: 'meta side-empty', text: mdSide.sideEmpty }))
  if (more > 0 || (st.sideAll && ordered.length > SIDE_THREAD_PEEK))
    items.push(
      h(
        'button',
        {
          class: 'navi side-more',
          onclick: () => {
            st.sideAll = !st.sideAll
            renderOverlay()
          },
        },
        h('span', { text: st.sideAll ? mdSide.fold : mdSide.showMore(more) }),
        icon('chevron', st.sideAll ? 'i more-chev open' : 'i more-chev'),
      ),
    )
  return items
}

export function isSideThread(id: string) {
  return st.side?.id === id || (st.pc?.threads ?? []).some((t) => t.id === id && t.side)
}

export function openSide(id: string, title = mdSide.sideTitle) {
  st.side = { id, title, messages: [], live: '', steps: [], busy: false, draft: '' }
  st.overlay = undefined
  st.screen = { name: 'side', id }
  render()
  void send({ kind: 'thread', id })
}

export function newSide() {
  st.sideWanted = true
  st.overlay = undefined
  render()
  void send({ kind: 'side-new' })
}

export function onSideStream(threadId: string, ev: DaemonStreamEvent) {
  const sd = st.side
  if (!sd || sd.id !== threadId) return
  if (ev.type === 'saved') {
    if (ev.message.role === 'user')
      sd.messages = sd.messages.filter((m) => !(m.id.startsWith('p') && m.text === ev.message.text))
    if (!sd.messages.some((m) => m.id === ev.message.id)) sd.messages = [...sd.messages, ev.message]
    if (ev.message.role === 'assistant') {
      sd.live = ''
      sd.steps = []
    }
  } else if (ev.type === 'agent') {
    sd.busy = true
    if (ev.event.type === 'text') sd.live += ev.event.delta
    else if (ev.event.type === 'tool') {
      const label =
        narrationLine(sd.live, lang) ?? mdSide.stepSuffix(ev.event.title ?? toolLabel(ev.event.name, lang))
      sd.live = ''
      if (sd.steps.at(-1) !== label) sd.steps = [...sd.steps, label]
    }
  } else if (ev.type === 'end') {
    sd.busy = false
    sd.live = ''
    sd.steps = []
    void send({ kind: 'thread', id: sd.id })
    hello()
  }
}

/**
 * A bar that reopens a waiting input card when it is closed (there used to be no way to reopen one dismissed by mistake)
 */
export function infoWaitBar(): HTMLElement[] {
  const open = st.overlay?.kind === 'info' ? (st.overlay as { id: string }).id : undefined
  const q = [...st.infos.values()].filter((x) => x.status === 'pending' && x.id !== open).at(-1)
  if (!q) return []
  return [
    h(
      'button',
      { class: 'info-wait-bar', onclick: () => openOverlay({ kind: 'info', id: q.id }) },
      h('span', { text: mdSide.waitingInput(q.label) }),
      h('strong', { text: mdSide.open }),
    ),
  ]
}

/**
 * The separate-chat screen also shows the cards that ask the person (personal info, secure keypad, verification code, approval, sign-in).
 * This screen redraws on every update, so the same card reuses what was already built (typed values aren't lost)
 */
let sideSheet: { key: string; el: HTMLElement } | undefined
export function sideOverlay(): HTMLElement[] {
  const ov = st.overlay
  if (!ov || !('id' in ov) || !['info', 'approval', 'login'].includes(ov.kind)) {
    sideSheet = undefined
    return []
  }
  const key = `${ov.kind}:${ov.id}`
  if (sideSheet?.key !== key) {
    const body =
      ov.kind === 'info'
        ? infoSheet(ov.id)
        : ov.kind === 'approval'
          ? approvalSheet(ov.id)
          : loginSheet(ov.id)
    const box = h('div', { class: 'app-overlay' })
    box.dataset.kind = ov.kind
    // Input cards don't close when you tap outside (dismissing by mistake blocked people). Only [Later] closes them
    box.append(
      h('div', { class: 'scrim', onclick: () => ov.kind !== 'info' && openOverlay(undefined) }),
      body,
    )
    sideSheet = { key, el: box }
  }
  return [sideSheet.el]
}

export function sideView(id: string) {
  const sd = st.side?.id === id ? st.side : undefined
  const back = () => {
    st.screen = { name: 'app' }
    render()
  }
  const list = h('div', { class: 'chat-list side-list' })
  // A task's own chat (its card's Details): its hand-off cards close when the task ended
  const task = sd ? [...st.tasks.values()].find((t) => t.threadId === sd.id) : undefined
  const ended = task !== undefined && ['done', 'stopped', 'failed'].includes(task.status)
  for (const [i, m] of (sd?.messages ?? []).entries()) {
    if (m.role === 'user') {
      const note = readAppNote(m.text)
      list.append(
        note !== undefined
          ? h('p', { class: 'msg note' }, note)
          : h('div', { class: 'bubble me', text: m.text }),
      )
    } else if (m.role === 'assistant') {
      const b = h('div', { class: 'bubble rich' })
      b.append(rich(m.text))
      list.append(b)
    } else if (m.role === 'tool') {
      // Quick replies go to the main chat, so they are not drawn in a separate chat
      if (!m.text.includes('"kind":"quick"'))
        list.append(
          toolCard(
            m.text,
            !m.text.includes('"kind":"handoff"') || handoffOpen(sd?.messages ?? [], i, { ended }),
          ),
        )
    }
  }
  if (sd?.busy) {
    const step = sd.steps.at(-1)
    if (step) list.append(h('p', { class: 'meta step' }, h('span', { class: 'dot work pulse' }), step))
    if (sd.live) {
      const b = h('div', { class: 'bubble rich streaming' })
      b.append(rich(sd.live))
      list.append(b)
    } else list.append(thinkingDots())
  }
  if (sd && !sd.messages.length && !sd.busy)
    list.append(
      h(
        'div',
        { class: 'card ask-card' },
        h('div', { class: 'card-label' }, doori('', 22), mdSide.sideIntro),
        h('p', {
          class: 'card-text',
          text: mdSide.sideIntroText,
        }),
      ),
    )
  const ta = h('textarea')
  ta.id = 'side-input'
  ta.rows = 1
  ta.placeholder = mdSide.askPh
  ta.value = sd?.draft ?? ''
  ta.oninput = () => {
    if (sd) sd.draft = ta.value
    autosize(ta)
  }
  const go = h('button', { class: 'send-btn ready', label: mdSide.send }, icon('send', 'i md'))
  const submit = () => {
    const text = ta.value.trim()
    if (!text || !sd || !st.online) return
    sd.draft = ''
    sd.busy = true
    sd.messages = [
      ...sd.messages,
      { id: `p${Date.now()}`, threadId: sd.id, role: 'user', text, createdAt: new Date().toISOString() },
    ]
    render()
    void send({ kind: 'ask', threadId: sd.id, text })
  }
  go.onclick = submit
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      submit()
    }
  }
  const page = h(
    'section',
    { class: 'side-page' },
    h(
      'header',
      { class: 'side-top' },
      h('button', { class: 'fbtn', label: mdSide.back, onclick: back }, icon('back')),
      h('strong', { class: 'side-title', text: sd?.title ?? mdSide.sideTitle }),
      h(
        'button',
        {
          class: 'fbtn',
          label: mdSide.delete,
          onclick: () => {
            if (!confirm(mdSide.confirmDelete)) return
            void send({ kind: 'side-delete', id })
            back()
          },
        },
        icon('trash'),
      ),
    ),
    h('div', { class: 'side-scroll' }, list),
    ...infoWaitBar(),
    h('div', { class: 'composer float side-composer' }, ta, go),
  )
  requestAnimationFrame(() => {
    const sc = page.querySelector('.side-scroll')
    sc?.scrollTo({ top: sc.scrollHeight })
    if (sd?.draft && document.activeElement?.id !== 'side-input') {
      const el = document.getElementById('side-input') as HTMLTextAreaElement | null
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    }
  })
  return page
}
