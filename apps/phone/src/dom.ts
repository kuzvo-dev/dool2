// Drawing helpers: building elements, line icons, Dool2 replies (paragraphs, lists, bold)
import { type Inline, richBlocks } from '@dool2/protocol/rich'
import { lang } from './lang.js'
import { domText } from './locales/dom.js'
import { rememberSeg } from './motion.js'

type Child = Node | string | false | undefined | null

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; onclick?: (e: MouseEvent) => void; label?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (props.class) e.className = props.class
  if (props.text !== undefined) e.textContent = props.text
  if (props.onclick) e.addEventListener('click', props.onclick as EventListener)
  if (props.label) e.setAttribute('aria-label', props.label)
  if (e instanceof HTMLButtonElement) e.type = 'button'
  for (const c of children) if (c) e.append(c)
  return e
}

/** 24-grid line icons. Characters (›, ✓) are not used as icons */
export const ICON = {
  menu: ['M5 9h14M5 15h14'],
  close: ['M6 6l12 12M18 6 6 18'],
  back: ['M15 18l-6-6 6-6'],
  chevron: ['m9 6 6 6-6 6'],
  plus: ['M12 5v14M5 12h14'],
  mic: ['M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0Z', 'M5 11a7 7 0 0 0 14 0M12 18v3'],
  send: ['M12 19V5M6 11l6-6 6 6'],
  stop: ['M8 8h8v8H8Z'],
  chat: ['M4 12a8 8 0 1 1 3.3 6.5L4 20l1.2-3.4A8 8 0 0 1 4 12Z'],
  tasks: ['M8 4h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4Z', 'm8.5 12 2.5 2.5 4.5-5'],
  idea: ['M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z'],
  apps: [
    'M7.5 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M15 4.5h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 13.5 9V6A1.5 1.5 0 0 1 15 4.5Z',
    'M6 13.5h3a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 9 19.5H6A1.5 1.5 0 0 1 4.5 18v-3A1.5 1.5 0 0 1 6 13.5Z',
    'M16.5 19.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  ],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'],
  cart: [
    'M6 6h15l-1.5 9h-12L6 6Zm0 0L5 3H2',
    'M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM18 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  ],
  lock: ['M6 11h12v10H6Z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  hand: [
    'M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a5 5 0 0 1-4.2-2.3L4 13.7a1.5 1.5 0 0 1 2.4-1.8L8 13',
  ],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  pc: ['M4 5h16v11H4Z', 'M9 20h6M12 16v4'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  card: ['M3 7h18v10H3z', 'M3 11h18'],
  mail: ['M4 7h16v10H4z', 'm4 7 8 6 8-6'],
  star: ['M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9Z'],
  box: ['M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5ZM3.5 7.5 12 12l8.5-4.5M12 12v9'],
  heart: ['M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10Z'],
  calendar: ['M4 6h16v14H4Z', 'M4 10h16M9 3v4M15 3v4'],
  shield: ['M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z'],
  feed: ['M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z', 'M8 8h8M8 12h8M8 16h5'],
  goal: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M12 12h.01'],
  library: ['M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z'],
  up: ['M7 11v9H4v-9Z', 'M7 11l4-7a2 2 0 0 1 3 2l-1 4h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 16.8 20H7'],
  down: ['M17 13V4h3v9Z', 'M17 13l-4 7a2 2 0 0 1-3-2l1-4H6a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 7.2 4H17'],
  reply: ['M9 14 4 9l5-5', 'M4 9h10a6 6 0 0 1 6 6v4'],
  pencil: ['M12 20h8', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
  gear: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  ],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
  brain: [
    'M9 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 4 13a3 3 0 0 0 2 4.5V18a3 3 0 0 0 6 0V5a1 1 0 0 0-1-1Z',
    'M15 4a3 3 0 0 1 3 3v.5a3 3 0 0 1 2 5.5 3 3 0 0 1-2 4.5V18a3 3 0 0 1-6 0',
  ],
  list: ['M9 6h11M9 12h11M9 18h11', 'M4.5 6h.01M4.5 12h.01M4.5 18h.01'],
  copy: ['M9 9h10v10H9Z', 'M5 15V5h10'],
  bookmark: ['M6 4h12v17l-6-4-6 4Z'],
  trash: ['M4 7h16', 'M10 11v6M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  play: ['M8 5v14l11-7Z'],
  link: [
    'M9 15l6-6',
    'M11 6.5l1.5-1.5a4.2 4.2 0 0 1 6 6L17 12.5',
    'M13 17.5 11.5 19a4.2 4.2 0 0 1-6-6L7 11.5',
  ],
  image: ['M4 5h16v14H4Z', 'm4 16 5-5 4 4 3-3 4 4', 'M15.5 9.5h.01'],
  place: [
    'M12 21s7-6.3 7-12a7 7 0 0 0-14 0c0 5.7 7 12 7 12Z',
    'M12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  ],
  note: ['M6 3h9l4 4v14H6Z', 'M14 3v5h5', 'M9 13h7M9 17h5'],
  sun: [
    'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z',
    'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  ],
  plane: [
    'M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2Z',
  ],
  ticket: [
    'M3 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2Z',
    'M13 5v2M13 11v2M13 17v2',
  ],
  users: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    'M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  ],
  download: ['M12 4v11M7 10l5 5 5-5', 'M5 19h14'],
  share: ['M12 15V4M8 8l4-4 4 4', 'M6 12v7h12v-7'],
} as const
export type IconName = keyof typeof ICON

export function icon(name: IconName, cls = 'i'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', cls)
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ICON[name]) {
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', d)
    svg.append(p)
  }
  return svg
}

/** The Dool2 character (moods: idle, working, asking, done, thinking, sleeping) */
export function doori(mood = '', size?: number) {
  const s = h('span', { class: `doori ${mood}`.trim() })
  if (size) s.style.setProperty('--s', `${size}px`)
  s.setAttribute('aria-hidden', 'true')
  return s
}

/** The animated 3D Dool2 (packages/ui/doori3d.js, bundled separately by the build) */
interface LiveDoori {
  setMood(mood: string): void
  destroy(): void
}
type Doori3d = { mountDoori(host: HTMLElement, opts: { mood?: string }): LiveDoori }
const DOORI3D = './doori3d.js' // Passed as a string so the build does not bundle it into app.js
let doori3dModule: Promise<Doori3d> | undefined
const liveSlots = new Map<string, { el: HTMLElement; mood: string; live?: LiveDoori }>()
const MOOD_CLASSES = ['thinking', 'working', 'asking', 'done', 'sleeping']

/**
 * Dool2 in a big spot: shows a still image first, then animates over it once 3D is ready.
 * One per slot, so redraws reuse the same canvas. Devices without 3D keep the still image.
 */
export function liveDoori(slot: string, mood: string, size: number): HTMLElement {
  const hit = liveSlots.get(slot)
  if (hit) {
    if (hit.mood !== mood) {
      hit.mood = mood
      hit.el.classList.remove(...MOOD_CLASSES)
      if (mood) hit.el.classList.add(mood)
      hit.live?.setMood(mood || 'idle')
    }
    hit.el.style.setProperty('--s', `${size}px`)
    return hit.el
  }
  const el = doori(mood, size)
  // Marks a part that is moved on redraw instead of rebuilt (holdLive in main.ts)
  el.dataset.liveSlot = slot
  const rec: { el: HTMLElement; mood: string; live?: LiveDoori } = { el, mood }
  liveSlots.set(slot, rec)
  doori3dModule ??= import(DOORI3D) as Promise<Doori3d>
  doori3dModule
    .then((m) => {
      rec.live = m.mountDoori(el, { mood: rec.mood || 'idle' })
      el.classList.add('live-ready')
    })
    .catch(() => {
      // No WebGL or the file failed to load: keep the still image
    })
  return el
}

/** Dool2 reply: draws only paragraphs, lists and **bold** (never parsed as HTML) */
/** When a PC file link in a reply is tapped (set by main.ts: fetch from the PC and save on the phone) */
let fileOpener: (path: string, name: string) => void = () => {}
export function setFileOpener(fn: (path: string, name: string) => void) {
  fileOpener = fn
}

export function rich(text: string): DocumentFragment {
  const f = document.createDocumentFragment()
  const spans = (parent: HTMLElement, parts: Inline[]) => {
    for (const part of parts) {
      const file = part.file
      if (file) {
        // A file on the PC: tapping fetches it from the PC and saves it on the phone
        parent.append(
          h(
            'button',
            {
              class: 'rich-file',
              label: domText(lang).saveToPhone(part.text),
              onclick: (e) => {
                e.stopPropagation()
                fileOpener(file, part.text)
              },
            },
            icon('download'),
            h('span', { text: part.text }),
          ),
        )
      } else if (part.href) {
        const a = h('a', { class: part.src ? 'rich-src' : 'rich-link', text: part.text }) as HTMLAnchorElement
        a.href = part.href
        a.target = '_blank'
        a.rel = 'noopener'
        parent.append(a)
      } else parent.append(part.bold ? h('strong', { text: part.text }) : part.text)
    }
  }
  for (const block of richBlocks(text)) {
    if (block.type === 'h') {
      const t = h(block.level === 1 ? 'h3' : 'h4', { class: 'rich-h' })
      spans(t, block.text)
      f.append(t)
      continue
    }
    if (block.type === 'table') {
      // Table: scrolls sideways on a narrow phone (so cells do not collapse when wrapping)
      const table = h('table', { class: 'rich-table' })
      if (block.head) {
        const tr = h('tr')
        for (const c of block.head) {
          const th = h('th')
          spans(th, c)
          tr.append(th)
        }
        table.append(h('thead', {}, tr))
      }
      const tbody = h('tbody')
      for (const row of block.rows) {
        const tr = h('tr')
        for (const c of row) {
          const td = h('td')
          spans(td, c)
          tr.append(td)
        }
        tbody.append(tr)
      }
      table.append(tbody)
      f.append(h('div', { class: 'rich-table-wrap' }, table))
      continue
    }
    if (block.type === 'p') {
      const p = h('p')
      block.lines.forEach((line, i) => {
        if (i) p.append(h('br'))
        spans(p, line)
      })
      f.append(p)
      continue
    }
    const list = h(block.type)
    if (block.type === 'ol' && block.start !== 1) (list as HTMLOListElement).start = block.start
    for (const item of block.items) {
      const li = h('li')
      // To-do list "[ ] item" / "[x] item" becomes round checkboxes
      const first = item[0]
      const m = first && !first.bold ? /^\[( |x|X)\]\s*/.exec(first.text) : null
      if (m && first) {
        li.className = m[1] === ' ' ? 'todo' : 'todo done'
        spans(li, [{ ...first, text: first.text.slice(m[0].length) }, ...item.slice(1)])
      } else spans(li, item)
      list.append(li)
    }
    f.append(list)
  }
  return f
}

/** Today: the time ("10:03 AM"); otherwise the short date ("11/14") */
export function shortTime(iso: string) {
  const d = new Date(iso)
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(lang, { month: 'numeric', day: 'numeric' })
}

/** Segmented (.seg) button: the chosen one has aria-pressed */
export function segBtn(on: boolean, props: { text: string; onclick: () => void }) {
  const b: HTMLButtonElement = h('button', {
    text: props.text,
    onclick: () => {
      rememberSeg(b)
      props.onclick()
    },
  })
  b.setAttribute('aria-pressed', String(on))
  return b
}

/** Puts the logo on a service mark (logos/<card id>.png). If missing or failing to load, the first letter of the name stays */
export function withLogo<T extends HTMLElement>(mark: T, id?: string): T {
  if (!id) return mark
  const img = document.createElement('img')
  img.className = 'svc-logo'
  img.alt = ''
  img.decoding = 'async'
  img.onload = () => mark.classList.add('has-logo')
  img.onerror = () => img.remove()
  img.src = `logos/${encodeURIComponent(id)}.png`
  mark.append(img)
  return mark
}

/** 3D emoji tile (packages/ui/emoji/<key>.webp, Fluent Emoji 3D, MIT). Used for content categories */
export function emoTile(key: string, cls = ''): HTMLElement {
  const s = document.createElement('span')
  s.className = `tile emo ${cls}`.trim()
  const img = document.createElement('img')
  img.src = `emoji/${key}.webp`
  img.alt = ''
  img.decoding = 'async'
  s.append(img)
  return s
}
