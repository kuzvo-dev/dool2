// Draws result blocks (shared by the phone app and PC app). Shape rules: docs/design/system/components/ChatBlocks
// Styles are in @dool2/ui's ui.css (.cb-*, .quick). It never reaches outside addresses (photos) itself and gets them through env.thumb
import type { Lang } from '@dool2/i18n'
import {
  BLOCK_TEXT,
  type BlockAction,
  type BlockRecordMessage,
  type DraftRecordMessage,
  daysUntil,
  draftAsk,
  lineColor,
  multiAsk,
  multiLabel,
  type QuickRecordMessage,
  type ResultRecordMessage,
  type RouteRecordMessage,
  type RowsRecordMessage,
  shortDate,
} from './blocks.js'

export interface BlockEnv {
  /** Send to Dool2 as my own words */
  send(text: string): void
  /** Open an https address outside the app */
  open(url: string): void
  /** Fetch a photo through the PC core as a data: address */
  thumb(url: string): Promise<string | undefined>
  /** Copy text (true if it worked) */
  copy(text: string): Promise<boolean>
}

/** Number of rows shown at first in a list (the rest expand in place) */
export const ROWS_VISIBLE = 5

type Child = Node | string | undefined | false

function el(tag: string, cls?: string, ...kids: Child[]): HTMLElement {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  for (const k of kids) if (k !== undefined && k !== false) n.append(k)
  return n
}

function btn(cls: string, label: string, on: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.textContent = label
  b.onclick = (e) => {
    e.stopPropagation()
    on()
  }
  return b
}

function run(a: BlockAction, env: BlockEnv) {
  if (a.ask) env.send(a.ask)
  else if (a.url) env.open(a.url)
}

function head(title?: string, from?: string, mark?: Node): HTMLElement | undefined {
  if (!title && !from && !mark) return undefined
  return el(
    'div',
    'cb-head',
    mark,
    title ? el('span', 'cb-title', title) : undefined,
    from ? el('span', 'cb-from', from) : undefined,
  )
}

function foot(actions: BlockAction[], env: BlockEnv): HTMLElement | undefined {
  if (!actions.length) return undefined
  // The last button is the primary one (ink), the earlier ones are secondary (outline)
  return el(
    'div',
    'cb-foot',
    ...actions.map((a, i) =>
      btn(i === actions.length - 1 ? 'btn sm' : 'btn-ghost sm', a.label, () => run(a, env)),
    ),
  )
}

function photo(url: string, env: BlockEnv): HTMLImageElement {
  const img = document.createElement('img')
  img.alt = ''
  void env.thumb(url).then((data) => {
    if (!data) return
    img.onload = () => img.classList.add('on')
    img.src = data
  })
  return img
}

// ── List rows ─────────────────────────────────────────

function lead(rec: RowsRecordMessage, i: number, env: BlockEnv, lang: Lang): HTMLElement | undefined {
  const t = BLOCK_TEXT[lang]
  const r = rec.rows[i]
  if (!r) return undefined
  if (rec.lead === 'check') {
    // With photos, like shopping or groceries, a small photo goes next to the check
    return r.image ? el('span', 'cb-lead img sm', photo(r.image, env)) : undefined
  }
  if (rec.lead === 'img' || rec.lead === 'logo')
    return el('span', `cb-lead ${rec.lead}`, r.image ? photo(r.image, env) : undefined)
  if (rec.lead === 'file') return el('span', 'cb-lead file', r.file ?? t.file)
  if (rec.lead === 'date') {
    if (!r.date) return el('span', 'cb-lead date')
    const d = new Date(`${r.date}T00:00:00Z`)
    return el(
      'span',
      'cb-lead date',
      el('b', undefined, String(d.getUTCDate())),
      el('small', undefined, `${t.months[d.getUTCMonth()]} ${t.weekdays[d.getUTCDay()]}`),
    )
  }
  return undefined
}

/**
 * used: what the user said after this. If present, multi-select is locked, and if that message is a picked list the checks are restored as picked
 */
export function rowsView(
  rec: RowsRecordMessage,
  env: BlockEnv,
  used?: string,
  lang: Lang = 'ko',
): HTMLElement {
  const t = BLOCK_TEXT[lang]
  const multi = rec.pick === 'multi'
  const done = used !== undefined
  const on = (multi && used !== undefined && pickedFrom(rec, used)) || rec.rows.map((r) => !!r.on)
  const box = el('div', `cb cb-rows${multi ? ' multi' : ''}`)
  const count = multi ? el('span', 'cb-from') : undefined
  const h = head(rec.title, multi ? undefined : rec.from)
  if (h && count) h.append(count)
  else if (count && !h) box.append(el('div', 'cb-head', count))
  if (h) box.append(h)
  const list = el('ul', 'cb-list')
  let go: HTMLButtonElement | undefined
  const update = () => {
    if (count) count.textContent = t.pickedCount(on.filter(Boolean).length, on.length)
    if (go && rec.action) {
      go.textContent = multiLabel(rec.rows, on, rec.action.label, lang)
      go.disabled = !on.some(Boolean)
    }
  }
  rec.rows.forEach((r, i) => {
    const right =
      r.value || r.state
        ? el(
            'span',
            'cb-val',
            r.value ? el('b', undefined, r.value) : undefined,
            r.valueNote ? el('small', undefined, r.valueNote) : undefined,
            r.state ? el('span', `cb-state${r.tone ? ` ${r.tone}` : ''}`, r.state) : undefined,
          )
        : undefined
    const check = multi ? el('span', `cb-check${on[i] ? ' on' : ''}`) : undefined
    const li = el(
      'li',
      `cb-row${multi && !on[i] ? ' off' : ''}${i >= ROWS_VISIBLE ? ' more' : ''}`,
      check,
      lead(rec, i, env, lang),
      el('span', 'cb-text', el('b', undefined, r.title), r.sub ? el('span', undefined, r.sub) : undefined),
      right,
    )
    const tap = multi
      ? () => {
          on[i] = !on[i]
          check?.classList.toggle('on', on[i])
          li.classList.toggle('off', !on[i])
          li.setAttribute('aria-checked', String(on[i]))
          update()
        }
      : rec.pick === 'one'
        ? () => env.send(t.pickThis(r.title, r.value))
        : r.url
          ? () => env.open(r.url ?? '')
          : undefined
    if (tap) {
      li.classList.add('tap')
      li.tabIndex = 0
      li.setAttribute('role', multi ? 'checkbox' : 'button')
      if (multi) li.setAttribute('aria-checked', String(on[i]))
      li.onclick = tap
      li.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          tap()
        }
      }
    }
    list.append(li)
  })
  box.append(list)
  const hidden = rec.rows.length - ROWS_VISIBLE
  if (hidden > 0) {
    const more = btn('cb-more', t.showMore(hidden), () => {
      box.classList.add('open')
      more.remove()
    })
    box.append(more)
  }
  if (rec.action) {
    const a = rec.action
    if (multi) {
      go = btn('btn sm', '', () => {
        if (!on.some(Boolean)) return
        env.send(multiAsk(rec.rows, on, a, lang))
        box.classList.add('sent')
        if (go) go.disabled = true
      })
      box.append(el('div', 'cb-foot', go))
    } else {
      const f = foot([a], env)
      if (f) box.append(f)
    }
  }
  update()
  if (multi && done) {
    box.classList.add('sent')
    if (go) {
      go.textContent = t.sent
      go.disabled = true
    }
  }
  return box
}

/** Recover the picked rows from the sent message (multiAsk). undefined if it is not a picked-list message */
function pickedFrom(rec: RowsRecordMessage, said: string): boolean[] | undefined {
  const cut = Math.min(
    ...(['ko', 'en'] as const).map((l) => {
      const i = said.indexOf(BLOCK_TEXT[l].skipped)
      return i >= 0 ? i : Number.POSITIVE_INFINITY
    }),
  )
  const main = Number.isFinite(cut) ? said.slice(0, cut) : said
  const on = rec.rows.map((r) => main.includes(r.title))
  return on.some(Boolean) ? on : undefined
}

// ── A single result ───────────────────────────────────────

export function resultView(
  rec: ResultRecordMessage,
  env: BlockEnv,
  now = Date.now(),
  lang: Lang = 'ko',
): HTMLElement {
  const box = el('div', 'cb cb-result')
  const mark = rec.done ? el('span', 'cb-done') : undefined
  const h = head(rec.title, rec.from, mark)
  if (h) {
    if (rec.done) h.classList.add('done')
    box.append(h)
  }
  const body = el('div', 'cb-body')
  let dday: HTMLElement | undefined
  if (rec.due) {
    const n = daysUntil(rec.due, now)
    if (n >= 0)
      dday = el('span', 'cb-dday', `${n === 0 ? 'D-day' : `D-${n}`}${rec.dueLabel ? ` ${rec.dueLabel}` : ''}`)
    else dday = el('span', 'cb-dday past', BLOCK_TEXT[lang].past(shortDate(rec.due, lang)))
  }
  body.append(
    el(
      'div',
      'cb-big',
      el('span', undefined, rec.big),
      rec.bigNote ? el('small', undefined, rec.bigNote) : undefined,
      dday,
    ),
  )
  if (rec.steps) {
    const { names, now: at } = rec.steps
    body.append(
      el('div', 'cb-steps', ...names.map((_, i) => el('i', i < at ? 'on' : i === at ? 'now' : undefined))),
      el('div', 'cb-step-names', ...names.map((n, i) => el('span', i === at ? 'now' : undefined, n))),
    )
  }
  if (rec.facts?.length)
    body.append(
      el(
        'dl',
        'cb-facts',
        ...rec.facts.map((f) =>
          el('div', undefined, el('dt', undefined, f.label), el('dd', f.code ? 'code' : undefined, f.value)),
        ),
      ),
    )
  box.append(body)
  const f = foot(rec.actions ?? [], env)
  if (f) box.append(f)
  return box
}

// ── Route card ─────────────────────────────────────────

/** Route result: conclusion (big value) -> line-colored bar (share of travel time) -> leg rows (line, board -> get off, last departure) */
export function routeView(rec: RouteRecordMessage, env: BlockEnv, lang: Lang = 'ko'): HTMLElement {
  const t = BLOCK_TEXT[lang]
  const box = el('div', 'cb cb-route')
  const h = head(rec.title, rec.from)
  if (h) box.append(h)
  const body = el('div', 'cb-body')
  body.append(
    el(
      'div',
      'cb-big',
      el('span', undefined, rec.big),
      rec.bigNote ? el('small', undefined, rec.bigNote) : undefined,
    ),
  )
  // Bar: share of minutes per leg (an equal share when minutes are unknown), with a minimum share so very short legs stay visible
  const total = rec.legs.reduce((a, g) => a + (g.minutes ?? 0), 0)
  const bar = el('div', 'cb-route-bar')
  for (const g of rec.legs) {
    const seg = el('i', g.mode === 'walk' ? 'walk' : undefined)
    const share = total && g.minutes ? g.minutes / total : 1 / rec.legs.length
    seg.style.flexGrow = String(Math.max(share, 0.12))
    seg.style.background = lineColor(g)
    seg.title = `${g.line} ${g.minutes ? t.minutes(g.minutes) : ''}`.trim()
    bar.append(seg)
  }
  body.append(bar)
  const list = el('ol', 'cb-route-legs')
  for (const g of rec.legs) {
    const badge = el('span', 'cb-line', g.line)
    // Walking gets a grey background instead of a color (ui.css)
    if (g.mode !== 'walk') badge.style.background = lineColor(g)
    const where = el(
      'div',
      'cb-route-where',
      el('span', undefined, `${g.from} → ${g.to}`),
      g.note || g.minutes
        ? el('small', undefined, [g.note, g.minutes ? t.minutes(g.minutes) : ''].filter(Boolean).join(' · '))
        : undefined,
    )
    const last = g.last ? el('span', 'cb-route-last', el('small', undefined, t.last), g.last) : undefined
    list.append(el('li', g.mode === 'walk' ? 'walk' : undefined, badge, where, last))
  }
  body.append(list)
  if (rec.facts?.length)
    body.append(
      el(
        'dl',
        'cb-facts',
        ...rec.facts.map((f) =>
          el('div', undefined, el('dt', undefined, f.label), el('dd', undefined, f.value)),
        ),
      ),
    )
  box.append(body)
  const f = foot(rec.actions ?? [], env)
  if (f) box.append(f)
  return box
}

// ── Draft to send ─────────────────────────────────────────

export function draftView(rec: DraftRecordMessage, env: BlockEnv, lang: Lang = 'ko'): HTMLElement {
  const t = BLOCK_TEXT[lang]
  const v = t.via[rec.via]
  const box = el('div', 'cb cb-draft')
  if (rec.to || v.name)
    box.append(
      el(
        'div',
        'cb-to',
        rec.to ? t.to : '',
        rec.to ? el('b', undefined, rec.to) : undefined,
        v.name ? `${rec.to ? ' · ' : ''}${v.name}` : '',
      ),
    )
  if (rec.subject) box.append(el('div', 'cb-subject', rec.subject))
  box.append(el('div', 'cb-paper', rec.text))
  const copy = btn('btn-ghost sm', t.copy, () => {
    void env.copy(rec.subject ? `${rec.subject}\n\n${rec.text}` : rec.text).then((ok) => {
      copy.textContent = ok ? t.copied : t.copyFailed
      setTimeout(() => {
        copy.textContent = t.copy
      }, 1600)
    })
  })
  const send = btn('btn sm', v.send, () => env.send(draftAsk(rec, lang)))
  box.append(el('div', 'cb-foot', copy, send))
  return box
}

// ── Quick replies ─────────────────────────────────────────

/**
 * Buttons under a Dool2 question. used: what the user said next (if present, all are dimmed, and the one with the same text is made bold)
 */
export function quickView(rec: QuickRecordMessage, env: BlockEnv, used?: string): HTMLElement {
  const box = el('div', `quick cb-quick${used !== undefined ? ' used' : ''}`)
  rec.replies.forEach((r, i) => {
    const b = btn(i === 0 ? 'main' : '', r, () => {
      if (box.classList.contains('used')) return
      box.classList.add('used')
      b.classList.add('picked')
      env.send(r)
    })
    if (used !== undefined && used.trim() === r) b.classList.add('picked')
    box.append(b)
  })
  return box
}

/** Draws a tool message from the history if it is a result block (otherwise undefined). used: what the user said after it (quick reply, multi-select) */
export function blockView(
  rec: { kind?: string },
  env: BlockEnv,
  used?: string,
  lang: Lang = 'ko',
): HTMLElement | undefined {
  if (rec.kind === 'rows') return rowsView(rec as RowsRecordMessage, env, used, lang)
  if (rec.kind === 'result') return resultView(rec as ResultRecordMessage, env, Date.now(), lang)
  if (rec.kind === 'draft') return draftView(rec as DraftRecordMessage, env, lang)
  if (rec.kind === 'route') return routeView(rec as RouteRecordMessage, env, lang)
  if (rec.kind === 'quick') return quickView(rec as QuickRecordMessage, env, used)
  return undefined
}

export type { BlockRecordMessage }
