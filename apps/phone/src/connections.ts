// Phone app: service connections (ADR 0014). List > service detail > ID and password (vault) > Dool2 logs in on the PC's Chrome > connected.
// The screen only draws connect cards (skills/<id>/connect.json).
import type { ConnectCard, ConnectionItem, Tier } from '@dool2/protocol/connect'

export { socialOrder } from '@dool2/protocol/connect'

import {
  APPROVAL_TIERS,
  approvalLine,
  CATEGORY_EMO,
  CATEGORY_LABEL,
  matchesCard,
  safetyLines,
} from '@dool2/protocol/connect-text'
import { emoTile, withLogo } from './dom.js'
import { lang } from './lang.js'
import { connectionsText } from './locales/connections.js'

export interface ConnectCtx {
  services?: ConnectionItem[]
  query: string
  /** Chosen category chip: 'all' · 'mine' (logged-in services) · a card category */
  cat: string
  online: boolean
  /** The service waiting for the PC after tapping Connect */
  opening?: string
  /** Services the Dool2 daemon is logging in to right now */
  connecting?: Set<string>
  /** Screen header: a back button if `back` is given */
  header(title: string, back?: () => void): HTMLElement
  home(): void
  list(): void
  detail(id: string): void
  setQuery(q: string): void
  setCat(cat: string): void
  open(id: string): void
  mark(id: string, on: boolean): void
  /** Puts the example request in the request box and goes home */
  tryAsk(text: string): void
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  ...kids: (Node | string | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  for (const k of kids) if (k) e.append(k)
  return e
}

const PATH = {
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm20 20-4-4'],
  fill: ['M12 20h8', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
  pay: ['M3 7h18v10H3z', 'M3 11h18', 'M7 15h3'],
  send: ['M4 12 20 4l-6 16-3-7-7-1Z', 'm11 13 9-9'],
  chevron: ['m9 6 6 6-6 6'],
  link: [
    'M9 15l6-6',
    'M11 6.5l1.5-1.5a4.2 4.2 0 0 1 6 6L17 12.5',
    'M13 17.5L11.5 19a4.2 4.2 0 0 1-6-6L7 11.5',
  ],
}
const TIER_ICON: Record<Tier, string[]> = {
  lookup: PATH.search,
  fill: PATH.fill,
  pay: PATH.pay,
  contact: PATH.send,
}
function svg(paths: string[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const s = document.createElementNS(ns, 'svg')
  s.setAttribute('class', 'i')
  s.setAttribute('viewBox', '0 0 24 24')
  s.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', d)
    s.append(p)
  }
  return s
}

/** Connection date: today, yesterday, or the date */
export function whenLabel(iso: string, now = new Date()): string {
  const m = connectionsText(lang)
  const d = new Date(iso)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff <= 0) return m.today
  if (diff === 1) return m.yesterday
  return m.monthDay(d.getMonth() + 1, d.getDate())
}

/** Service icon: the first letter of the name, no logo file */
function mark(card: ConnectCard, big = false) {
  // If it starts with digits, use them as a group (11st → 11), otherwise the first letter
  const lead = /^\d+/.exec(card.name)?.[0] ?? [...card.name][0] ?? ''
  const m = el('span', big ? 'svc-mark lg' : 'svc-mark', lead)
  m.setAttribute('aria-hidden', 'true')
  return withLogo(m, card.id)
}

/** The entry row on home: "Connect services · 3 connected" */
export function connectEntry(services: ConnectionItem[] | undefined, onclick: () => void): HTMLElement {
  const m = connectionsText(lang)
  const n = services?.filter((s) => s.connectedAt).length ?? 0
  const b = el(
    'button',
    'connect-entry',
    el('span', 'svc-mark', svg(PATH.link)),
    el(
      'span',
      'row-text',
      el('strong', 'row-t', m.entryTitle),
      el('span', 'row-d', n ? m.entryCount(n) : m.entryEmpty),
    ),
    svg(PATH.chevron),
  )
  b.type = 'button'
  b.onclick = onclick
  return b
}

function row(it: ConnectionItem, ctx: ConnectCtx): HTMLElement {
  const m = connectionsText(lang)
  const b = el('button', 'row svc-row')
  b.type = 'button'
  const right = it.connectedAt
    ? el('span', 'meta', whenLabel(it.connectedAt))
    : it.card.how === 'open'
      ? el('span', 'meta', m.noLogin)
      : it.tools?.some((t) => !t.login)
        ? el('span', 'meta', m.searchWithoutConnect)
        : svg(PATH.chevron)
  b.append(
    mark(it.card),
    el(
      'span',
      'row-text',
      el('span', 'row-t', it.card.name),
      el(
        'span',
        'row-d',
        it.card.abilities
          .slice(0, 3)
          .map((a) => a.title)
          .join(' · '),
      ),
    ),
    right,
  )
  b.onclick = () => ctx.detail(it.card.id)
  return el('li', '', b)
}

export function connectionsView(ctx: ConnectCtx): HTMLElement {
  const m = connectionsText(lang)
  const box = el('section', 'tab-page connect', ctx.header(m.title))
  if (!ctx.services) {
    box.append(el('p', 'wait', el('span', 'spin'), m.loading))
    return box
  }
  box.append(el('p', 'cap connect-intro', m.intro))
  const search = el('input', 'field connect-search')
  search.id = 'connect-search'
  search.type = 'search'
  search.placeholder = m.searchPlaceholder
  search.value = ctx.query
  // While typing a search, redraw only the list below (rebuilding the input would cut off IME composition)
  const chips = el('div', 'chips idea-cats connect-cats')
  const results = el('div', 'connect-results')
  const services = [...ctx.services].sort((a, b) => a.card.name.localeCompare(b.card.name, 'ko'))
  const cats = (Object.keys(CATEGORY_LABEL) as ConnectCard['category'][])
    .map((id) => ({
      id,
      label: CATEGORY_LABEL[id],
      emo: CATEGORY_EMO[id],
      list: services.filter((it) => it.card.category === id),
    }))
    .filter((c) => c.list.length)
  const mine = services.filter((it) => it.connectedAt)
  let cat = ctx.cat
  const ul = (list: ConnectionItem[]) => {
    const u = el('ul', 'list')
    for (const it of list) u.append(row(it, ctx))
    return u
  }
  const group = (name: string, list: ConnectionItem[]) =>
    el('section', 'connect-group', el('h2', 'over', `${name} ${list.length}`), ul(list))
  const pick = (id: string) => {
    cat = id
    ctx.setCat(id)
    if (search.value) {
      search.value = ''
      ctx.setQuery('')
    }
    draw('')
    chips.querySelector('.chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' })
    chips.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  const draw = (query: string) => {
    const q = query.trim()
    if (cat === 'mine' && !mine.length) cat = 'all'
    if (cat !== 'all' && cat !== 'mine' && !cats.some((c) => c.id === cat)) cat = 'all'
    const chip = (id: string, label: string) => {
      const b = el('button', `chip quiet${cat === id && !q ? ' on' : ''}`, label)
      b.type = 'button'
      b.onclick = () => pick(id)
      return b
    }
    chips.replaceChildren(
      chip('all', m.all),
      ...(mine.length ? [chip('mine', m.loggedInCount(mine.length))] : []),
      ...cats.map((c) => chip(c.id, c.label)),
    )
    results.replaceChildren()
    if (q) {
      const shown = services.filter((it) => matchesCard(it.card, q))
      for (const c of cats) {
        const list = shown.filter((it) => it.card.category === c.id)
        if (list.length) results.append(group(c.label, list))
      }
      if (!shown.length) results.append(el('p', 'cap empty', m.noMatch))
      return
    }
    if (cat === 'mine') {
      results.append(group(m.loggedInGroup, mine))
      return
    }
    if (cat === 'all') {
      if (mine.length) results.append(group(m.loggedInGroup, mine))
      for (const c of cats) {
        const head = el(
          'button',
          'idea-sec-head',
          emoTile(c.emo, 'sm'),
          el('strong', '', c.label),
          el('span', 'meta', m.placesCount(c.list.length)),
          svg(PATH.chevron),
        )
        head.lastElementChild?.setAttribute('class', 'i chev')
        head.type = 'button'
        head.onclick = () => pick(c.id)
        results.append(el('section', 'connect-group', head, ul(c.list.slice(0, 3))))
      }
      return
    }
    const c = cats.find((x) => x.id === cat)
    if (c) results.append(group(c.label, c.list))
  }
  search.oninput = () => {
    draw(search.value)
    ctx.setQuery(search.value)
  }
  draw(ctx.query)
  box.append(search, chips, results)
  return box
}

export function serviceView(ctx: ConnectCtx, id: string): HTMLElement {
  const m = connectionsText(lang)
  const it = ctx.services?.find((s) => s.card.id === id)
  if (!it) return connectionsView(ctx)
  const c = it.card
  const box = el('section', 'tab-page connect service', ctx.header('', ctx.list))

  box.append(
    el(
      'div',
      'svc-head',
      mark(c, true),
      el('div', '', el('h1', 'title', c.name), el('p', 'meta mono', c.site ?? m.phonePermission)),
    ),
    el('p', 'svc-summary', c.summary),
  )

  // Chat example: request > working > reply (Dool2 in a gray bubble, mine in ink)
  box.append(
    el(
      'div',
      'svc-demo',
      el('div', 'bubble me', c.example.ask),
      el('p', 'meta svc-working', el('span', 'dot work'), `${c.example.working}…`),
      el('div', 'bubble', c.example.reply),
    ),
  )

  const abilities = el('ul', 'list svc-abilities')
  for (const a of c.abilities) {
    const li = el(
      'li',
      'row',
      svg(TIER_ICON[a.tier]),
      el('span', 'row-text', el('span', 'row-t', a.title), el('span', 'row-d', `“${a.say}”`)),
    )
    if (APPROVAL_TIERS.includes(a.tier)) li.append(el('span', 'pill ask', m.phoneApproval))
    abilities.append(li)
  }
  const approval = approvalLine(c)
  box.append(el('h2', 'over', m.howToAsk), abilities)
  if (approval) box.append(el('p', 'cap', approval))

  // If there are service tools (ADR 0018): things done directly without tapping through screens
  if (it.tools?.length) {
    const fast = el('ul', 'list svc-abilities')
    for (const t of it.tools) {
      const li = el('li', 'row', svg(TIER_ICON[t.tier]), el('span', 'row-text', el('span', 'row-t', t.title)))
      if (!it.connectedAt)
        li.append(el('span', t.login ? 'pill' : 'meta', t.login ? m.whenConnected : m.noLogin))
      fast.append(li)
    }
    box.append(el('h2', 'over', m.doItDirectly), el('p', 'cap', m.directlyNote), fast)
  }

  const safety = el('ul', 'svc-safety')
  for (const line of safetyLines(c)) safety.append(el('li', '', line))
  box.append(el('h2', 'over', m.safety), safety)

  // Button row at the bottom
  const bar = el('div', 'svc-action')
  const tryAsk = el('button', 'btn-ghost', m.tryAsk)
  tryAsk.type = 'button'
  tryAsk.onclick = () => ctx.tryAsk(c.example.ask)
  if (c.how === 'device') {
    bar.append(el('p', 'cap', m.devicePending))
  } else if (c.how === 'open') {
    bar.append(tryAsk)
  } else if (it.connectedAt) {
    const off = el('button', 'btn-text', m.disconnect)
    off.type = 'button'
    off.onclick = () => ctx.mark(c.id, false)
    bar.append(el('p', 'meta svc-connected', m.connectedOn(whenLabel(it.connectedAt))), tryAsk, off)
  } else {
    const busy = ctx.connecting?.has(c.id)
    const go = el('button', 'btn lg', busy ? m.loggingIn : ctx.opening === c.id ? m.openingOnPc : m.connect)
    go.type = 'button'
    go.disabled = !ctx.online || ctx.opening === c.id || Boolean(busy)
    go.onclick = () => ctx.open(c.id)
    bar.append(go, el('p', 'cap', m.connectNote))
  }
  box.append(bar)
  return box
}
