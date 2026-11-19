// 결과 블록 그리기 (폰 앱·PC 앱이 같이 쓴다). 모양 규칙: docs/design/system/components/ChatBlocks
// 스타일은 @dool2/ui의 ui.css (.cb-*, .quick). 바깥 주소(사진)에는 직접 붙지 않고 env.thumb으로 받는다
import {
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
  /** 내 말로 두리에게 보내기 */
  send(text: string): void
  /** https 주소를 앱 밖에서 열기 */
  open(url: string): void
  /** 사진을 PC 본체에서 받아 data: 주소로 */
  thumb(url: string): Promise<string | undefined>
  /** 글 복사 (성공하면 true) */
  copy(text: string): Promise<boolean>
}

/** 목록에서 처음 보이는 줄 수 (나머지는 그 자리에서 펼친다) */
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
  // 마지막 버튼이 주 버튼(ink), 앞의 것은 보조(선)
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

// ── 목록 줄 ─────────────────────────────────────────

function lead(rec: RowsRecordMessage, i: number, env: BlockEnv): HTMLElement | undefined {
  const r = rec.rows[i]
  if (!r) return undefined
  if (rec.lead === 'check') {
    // 쇼핑·장보기처럼 사진이 있으면 체크 옆에 작은 사진도
    return r.image ? el('span', 'cb-lead img sm', photo(r.image, env)) : undefined
  }
  if (rec.lead === 'img' || rec.lead === 'logo')
    return el('span', `cb-lead ${rec.lead}`, r.image ? photo(r.image, env) : undefined)
  if (rec.lead === 'file') return el('span', 'cb-lead file', r.file ?? '파일')
  if (rec.lead === 'date') {
    if (!r.date) return el('span', 'cb-lead date')
    const t = new Date(`${r.date}T00:00:00Z`)
    return el(
      'span',
      'cb-lead date',
      el('b', undefined, String(t.getUTCDate())),
      el('small', undefined, `${t.getUTCMonth() + 1}월 ${'일월화수목금토'[t.getUTCDay()]}`),
    )
  }
  return undefined
}

/**
 * used: 이 뒤에 사용자가 한 말. 있으면 여러 개 고르기는 잠그고, 그 말이 고른 목록이면 고른 대로 체크를 되살린다
 */
export function rowsView(rec: RowsRecordMessage, env: BlockEnv, used?: string): HTMLElement {
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
    if (count) count.textContent = `${on.filter(Boolean).length}/${on.length}개 고름`
    if (go && rec.action) {
      go.textContent = multiLabel(rec.rows, on, rec.action.label)
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
      lead(rec, i, env),
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
        ? () => env.send(`이걸로 할게: ${r.title}${r.value ? ` (${r.value})` : ''}`)
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
    const more = btn('cb-more', `${hidden}개 더 보기`, () => {
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
        env.send(multiAsk(rec.rows, on, a))
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
      go.textContent = '골라서 보냈어요'
      go.disabled = true
    }
  }
  return box
}

/** 보낸 말(multiAsk)에서 고른 줄 되찾기. 고른 목록 말이 아니면 undefined */
function pickedFrom(rec: RowsRecordMessage, said: string): boolean[] | undefined {
  const cut = said.indexOf(' (뺀 것: ')
  const main = cut >= 0 ? said.slice(0, cut) : said
  const on = rec.rows.map((r) => main.includes(r.title))
  return on.some(Boolean) ? on : undefined
}

// ── 결과 한 장 ───────────────────────────────────────

export function resultView(rec: ResultRecordMessage, env: BlockEnv, now = Date.now()): HTMLElement {
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
    else dday = el('span', 'cb-dday past', `${shortDate(rec.due)} 지남`)
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

// ── 경로 카드 ─────────────────────────────────────────

/** 길찾기 결과: 결론(큰 값) → 노선 색 막대(걸리는 시간 비율) → 구간 줄(노선·탈 곳→내릴 곳·막차) */
export function routeView(rec: RouteRecordMessage, env: BlockEnv): HTMLElement {
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
  // 막대: 구간 분 비율 (분을 모르면 같은 몫). 너무 짧은 구간도 보이게 최소 몫
  const total = rec.legs.reduce((a, g) => a + (g.minutes ?? 0), 0)
  const bar = el('div', 'cb-route-bar')
  for (const g of rec.legs) {
    const seg = el('i', g.mode === 'walk' ? 'walk' : undefined)
    const share = total && g.minutes ? g.minutes / total : 1 / rec.legs.length
    seg.style.flexGrow = String(Math.max(share, 0.12))
    seg.style.background = lineColor(g)
    seg.title = `${g.line} ${g.minutes ? `${g.minutes}분` : ''}`.trim()
    bar.append(seg)
  }
  body.append(bar)
  const list = el('ol', 'cb-route-legs')
  for (const g of rec.legs) {
    const badge = el('span', 'cb-line', g.line)
    // 걷기는 색 대신 회색 바탕 (ui.css)
    if (g.mode !== 'walk') badge.style.background = lineColor(g)
    const where = el(
      'div',
      'cb-route-where',
      el('span', undefined, `${g.from} → ${g.to}`),
      g.note || g.minutes
        ? el('small', undefined, [g.note, g.minutes ? `${g.minutes}분` : ''].filter(Boolean).join(' · '))
        : undefined,
    )
    const last = g.last ? el('span', 'cb-route-last', el('small', undefined, '막차'), g.last) : undefined
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

// ── 보낼 글 ─────────────────────────────────────────

const VIA: Record<DraftRecordMessage['via'], { name: string; send: string }> = {
  sms: { name: '문자', send: '문자 보내기' },
  kakao: { name: '카카오톡', send: '카톡 보내기' },
  mail: { name: '메일', send: '메일 보내기' },
  post: { name: '글', send: '올리기' },
  other: { name: '', send: '보내기' },
}

export function draftView(rec: DraftRecordMessage, env: BlockEnv): HTMLElement {
  const v = VIA[rec.via]
  const box = el('div', 'cb cb-draft')
  if (rec.to || v.name)
    box.append(
      el(
        'div',
        'cb-to',
        rec.to ? '받는 사람 ' : '',
        rec.to ? el('b', undefined, rec.to) : undefined,
        v.name ? `${rec.to ? ' · ' : ''}${v.name}` : '',
      ),
    )
  if (rec.subject) box.append(el('div', 'cb-subject', rec.subject))
  box.append(el('div', 'cb-paper', rec.text))
  const copy = btn('btn-ghost sm', '복사', () => {
    void env.copy(rec.subject ? `${rec.subject}\n\n${rec.text}` : rec.text).then((ok) => {
      copy.textContent = ok ? '복사했어요' : '복사 못 했어요'
      setTimeout(() => {
        copy.textContent = '복사'
      }, 1600)
    })
  })
  const send = btn('btn sm', v.send, () => env.send(draftAsk(rec)))
  box.append(el('div', 'cb-foot', copy, send))
  return box
}

// ── 빠른 답 ─────────────────────────────────────────

/**
 * 두리 질문 아래 버튼. used: 이 다음에 사용자가 한 말 (있으면 다 흐리게, 같은 글이면 그 버튼만 진하게)
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

/** 기록의 tool 메시지가 결과 블록이면 그린다 (아니면 undefined). used: 이 뒤에 사용자가 한 말 (빠른 답·여러 개 고르기) */
export function blockView(rec: { kind?: string }, env: BlockEnv, used?: string): HTMLElement | undefined {
  if (rec.kind === 'rows') return rowsView(rec as RowsRecordMessage, env, used)
  if (rec.kind === 'result') return resultView(rec as ResultRecordMessage, env)
  if (rec.kind === 'draft') return draftView(rec as DraftRecordMessage, env)
  if (rec.kind === 'route') return routeView(rec as RouteRecordMessage, env)
  if (rec.kind === 'quick') return quickView(rec as QuickRecordMessage, env, used)
  return undefined
}

export type { BlockRecordMessage }
