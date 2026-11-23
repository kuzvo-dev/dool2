// Service connection screen (ADR 0014): list by category -> service detail -> sign in in Chrome -> shown as connected.
// The screen only draws cards (skills/<id>/connect.json). No per-service code here.
import type { ConnectCard, ConnectionItem, SocialProvider, Tier } from '@dool2/protocol/connect'
import { lang } from './lang.js'
import { categoryLabels, connectionsText, socialLabels } from './locales/connections.js'

/** A record whose values are looked up in the current language each time they are read (keys and order are fixed) */
function live<K extends string>(pick: (l: typeof lang) => Record<K, string>): Record<K, string> {
  const out = {} as Record<K, string>
  for (const k of Object.keys(pick('ko')) as K[])
    Object.defineProperty(out, k, { enumerable: true, get: () => pick(lang)[k] })
  return out
}

/** Sign-in provider names (copy of SOCIAL_LABEL in @dool2/protocol/connect; a test checks they match) */
export const SOCIAL_LABEL: Record<SocialProvider, string> = live(socialLabels)

/** Category names from @dool2/protocol/connect (copied so the window bundle has no zod; a test checks they match) */
export const CATEGORY_LABEL: Record<ConnectCard['category'], string> = live(categoryLabels)
const APPROVAL: readonly Tier[] = ['pay', 'contact']

export interface ConnectionsOptions {
  api<T>(path: string, init?: RequestInit): Promise<T>
  /** Where to draw (.messages) */
  box: HTMLElement
  setHeader(title: string, sub: string): void
  /** Send an example request as a new chat */
  ask(text: string): void
  /** Connecting happens in the chat (ADR 0021): show a connect card in the chat and go there */
  connect(id: string): Promise<void>
}

const SVG = 'http://www.w3.org/2000/svg'
/** Line icons on a 24 grid (ui.css svg.i) */
function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'i')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const p = document.createElementNS(SVG, 'path')
    p.setAttribute('d', d)
    svg.append(p)
  }
  return svg
}
const ICON = {
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm20 20-4-4'],
  fill: ['M12 20h8', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
  pay: ['M3 7h18v10H3z', 'M3 11h18', 'M7 15h3'],
  send: ['M4 12 20 4l-6 16-3-7-7-1Z', 'm11 13 9-9'],
  chevron: ['m9 6 6 6-6 6'],
  back: ['M15 6l-6 6 6 6'],
  shield: ['M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z', 'm9 12 2 2 4-4'],
}
const TIER_ICON: Record<Tier, string[]> = {
  lookup: ICON.search,
  fill: ICON.fill,
  pay: ICON.pay,
  contact: ICON.send,
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** Service mark: first letter of the name, no logo file needed (ADR 0014) */
function mark(card: ConnectCard, size: 'sm' | 'lg' = 'sm'): HTMLElement {
  const m = el('span', `svc-mark ${size}`, [...card.name][0] ?? '')
  m.setAttribute('aria-hidden', 'true')
  // Logo (same as withLogo in dom.ts; tests load this file without dom.ts)
  const img = document.createElement('img')
  img.className = 'svc-logo'
  img.alt = ''
  img.onload = () => m.classList.add('has-logo')
  img.onerror = () => img.remove()
  img.src = `logos/${encodeURIComponent(card.id)}.png`
  m.append(img)
  return m
}

function approvalLine(card: ConnectCard): string | undefined {
  const risky = card.abilities.filter((a) => APPROVAL.includes(a.tier)).map((a) => a.title)
  if (!risky.length) return undefined
  return connectionsText(lang).approvalLine(risky.slice(0, 3).join(', '))
}

function dateLabel(iso: string): string {
  return connectionsText(lang).date(new Date(iso))
}

/** "How we keep it safe" lines on the detail screen (per connection method) */
export function safetyLines(card: ConnectCard): string[] {
  const m = connectionsText(lang)
  const approval = card.abilities.some((a) => APPROVAL.includes(a.tier)) ? [m.safetyApproval] : []
  switch (card.how) {
    case 'browser':
      return [m.safetyBrowserLogin(card.login ?? m.defaultLogin), m.safetyBrowserRelogin, ...approval]
    case 'official':
      return [m.safetyOfficial, m.safetyNoPassword, ...approval]
    case 'open':
      return [m.safetyOpen, ...approval]
    case 'device':
      return [m.safetyDevice, ...approval]
  }
}

export function renderConnections(opts: ConnectionsOptions, open?: string): Promise<void> {
  const m = connectionsText(lang)
  let items: ConnectionItem[] = []
  let query = ''
  /** Selected category chip: 'all', 'mine' (connected) or a card category */
  let cat = 'all'

  const load = async () => {
    items = (await opts.api<{ services: ConnectionItem[] }>('/api/connections')).services.sort((a, b) =>
      a.card.name.localeCompare(b.card.name, 'ko'),
    )
  }

  const row = (it: ConnectionItem): HTMLElement => {
    const li = el('li')
    const b = el('button', 'svc-row')
    b.type = 'button'
    const text = el('span', 'svc-text')
    text.append(
      el('span', 'svc-name', it.card.name),
      el(
        'span',
        'cap',
        it.card.abilities
          .slice(0, 3)
          .map((a) => a.title)
          .join(' · '),
      ),
    )
    const right = el('span', 'svc-state')
    if (it.connectedAt) {
      right.append(el('span', 'dot ok'), el('span', '', m.connected))
    } else if (it.card.how === 'open') right.append(el('span', '', m.noLogin))
    else if (it.tools?.some((t) => !t.login)) right.append(el('span', '', m.findWithout))
    right.append(icon(ICON.chevron))
    b.append(mark(it.card), text, right)
    b.onclick = () => showDetail(it.card.id)
    li.append(b)
    return li
  }

  const showList = () => {
    opts.setHeader(m.title, m.sub)
    const view = el('div', 'connect-view')
    const intro = el('p', 'sub', m.intro)
    const search = el('input', 'field svc-search') as HTMLInputElement
    search.type = 'search'
    search.placeholder = m.search
    search.value = query
    const chips = el('div', 'chips idea-cats svc-cats')
    const groups = el('div', 'svc-groups')
    // Services for another region (ADR 0029) are listed last, under "Other regions"
    const here = (it: ConnectionItem) => it.local !== false
    const cats = (Object.keys(CATEGORY_LABEL) as ConnectCard['category'][]).filter((c) =>
      items.some((it) => it.card.category === c && here(it)),
    )
    const draw = () => {
      const q = query.trim().toLowerCase()
      const mine = items.filter((it) => it.connectedAt)
      if (
        (cat === 'mine' && !mine.length) ||
        (cat !== 'all' && cat !== 'mine' && !cats.includes(cat as never))
      )
        cat = 'all'
      const chip = (id: string, label: string) => {
        const b = el('button', `chip quiet${cat === id && !q ? ' on' : ''}`, label)
        b.type = 'button'
        b.onclick = () => {
          cat = id
          query = ''
          search.value = ''
          draw()
          opts.box.scrollTop = 0
        }
        return b
      }
      chips.replaceChildren(
        chip('all', m.all),
        ...(mine.length ? [chip('mine', m.connectedCount(mine.length))] : []),
        ...cats.map((c) => chip(c, CATEGORY_LABEL[c])),
      )
      const shown = q
        ? items.filter((it) =>
            [it.card.name, it.card.id, it.card.site ?? '', CATEGORY_LABEL[it.card.category], it.card.summary]
              .concat(it.card.abilities.map((a) => a.title))
              .join(' ')
              .toLowerCase()
              .includes(q),
          )
        : items
      const sections: HTMLElement[] = []
      if (!q && cat === 'mine') sections.push(section(m.connected, mine))
      else {
        if (!q && cat === 'all' && mine.length) sections.push(section(m.connected, mine))
        for (const c of cats) {
          if (!q && cat !== 'all' && c !== cat) continue
          const list = shown.filter((it) => it.card.category === c && here(it))
          if (list.length) sections.push(section(CATEGORY_LABEL[c], list))
        }
        const away = shown.filter((it) => !here(it) && (q || cat === 'all'))
        if (away.length) sections.push(section(m.otherRegions, away))
      }
      if (!sections.length) sections.push(el('p', 'cap svc-empty', m.empty))
      groups.replaceChildren(...sections)
    }
    const section = (name: string, list: ConnectionItem[]) => {
      const s = el('section', 'svc-group')
      const ul = el('ul', 'list svc-list')
      ul.append(...list.map(row))
      s.append(el('h2', 'over', `${name} ${list.length}`), ul)
      return s
    }
    search.oninput = () => {
      query = search.value
      draw()
    }
    draw()
    view.append(intro, search, chips, groups)
    opts.box.replaceChildren(view)
    opts.box.scrollTop = 0
  }

  const showDetail = (id: string) => {
    const it = items.find((x) => x.card.id === id)
    if (!it) return showList()
    const c = it.card
    opts.setHeader(c.name, CATEGORY_LABEL[c.category])
    const view = el('div', 'connect-view svc-detail')

    const back = el('button', 'btn-text svc-back')
    back.type = 'button'
    back.append(icon(ICON.back), m.back)
    back.onclick = () => showList()

    const head = el('div', 'svc-head')
    const names = el('div')
    names.append(el('h2', 'title', c.name), el('p', 'cap mono', c.site ?? m.phonePermission))
    head.append(mark(c, 'lg'), names)

    // Chat example: request -> working -> answer
    const demo = el('div', 'card quiet svc-demo')
    const working = el('p', 'svc-working')
    working.append(el('span', 'dot ok'), `${c.example.working}…`)
    demo.append(el('div', 'msg user', c.example.ask), working, el('div', 'msg assistant', c.example.reply))

    const abilities = el('ul', 'list svc-abilities')
    for (const a of c.abilities) {
      const li = el('li')
      const text = el('span', 'svc-text')
      text.append(el('span', 'svc-name', a.title), el('span', 'cap', `“${a.say}”`))
      li.append(icon(TIER_ICON[a.tier]), text)
      if (APPROVAL.includes(a.tier)) {
        const tag = el('span', 'svc-state')
        tag.append(el('span', 'dot warn'), el('span', '', m.phoneApproval))
        li.append(tag)
      }
      abilities.append(li)
    }

    // With service tools (ADR 0018): things done directly, without tapping through screens
    const fast = (it.tools ?? []).length ? el('section', 'svc-fast') : undefined
    if (fast) {
      const list = el('ul', 'list svc-abilities')
      for (const t of it.tools ?? []) {
        const li = el('li')
        li.append(icon(TIER_ICON[t.tier]), el('span', 'svc-name', t.title))
        if (!it.connectedAt) {
          // Show which work right away without sign-in and which need a connection
          const tag = el('span', 'svc-state')
          tag.append(
            el('span', t.login ? 'dot' : 'dot ok'),
            el('span', '', t.login ? m.ifConnected : m.noLogin),
          )
          li.append(tag)
        }
        list.append(li)
      }
      fast.append(el('h2', 'over', m.fastTitle), el('p', 'cap', m.fastBody), list)
    }

    const safety = el('section', 'svc-safety')
    const ul = el('ul')
    for (const line of safetyLines(c)) ul.append(el('li', '', line))
    safety.append(el('h2', 'over', m.safetyTitle), ul)

    const action = el('div', 'svc-action')
    const drawAction = (note?: string) => {
      const kids: (Node | string)[] = []
      const tryAsk = el('button', 'btn-ghost', m.tryAsk)
      tryAsk.type = 'button'
      tryAsk.onclick = () => opts.ask(c.example.ask)
      if (c.how === 'device') {
        kids.push(el('p', 'cap', m.deviceHint))
      } else if (c.how === 'open') {
        kids.push(tryAsk)
      } else if (it.connectedAt) {
        const state = el('p', 'svc-connected')
        state.append(el('span', 'dot ok'), m.connectedOn(dateLabel(it.connectedAt)))
        const off = el('button', 'btn-text', m.disconnect)
        off.type = 'button'
        off.onclick = async () => {
          await opts.api(`/api/connections/${c.id}`, { method: 'DELETE' })
          delete it.connectedAt
          drawAction()
        }
        kids.push(state, tryAsk, off)
      } else {
        // Connecting happens in the chat: ID/password, sign-in accounts and doing it yourself continue on the chat's connect card
        const go = el('button', 'btn', m.connect)
        go.type = 'button'
        go.onclick = async () => {
          go.disabled = true
          try {
            await opts.connect(c.id)
          } catch (e) {
            go.disabled = false
            drawAction((e as Error).message)
          }
        }
        kids.push(go, el('p', 'cap', m.connectHint))
      }
      if (note) kids.push(el('p', 'cap svc-note', note))
      action.replaceChildren(...kids)
    }
    drawAction()

    const approval = approvalLine(c)
    view.append(
      back,
      head,
      el('p', 'svc-summary', c.summary),
      demo,
      el('h2', 'over', m.abilitiesTitle),
      abilities,
      ...(approval ? [el('p', 'cap svc-approval', approval)] : []),
      ...(fast ? [fast] : []),
      safety,
      action,
    )
    opts.box.replaceChildren(view)
    opts.box.scrollTop = 0
  }

  return load().then(() => (open ? showDetail(open) : showList()))
}
