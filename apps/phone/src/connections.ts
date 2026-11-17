// 폰 앱: 서비스 연결 (ADR 0014). 목록 → 서비스 상세 → 아이디·비밀번호(금고) → 두리가 PC Chrome에서 대신 로그인 → 연결 표시.
// 화면은 연결 카드(skills/<id>/connect.json)를 그리기만 한다. 탭 개편 때 "나의 두리"에 그대로 끼운다.
import type { ConnectCard, ConnectionItem, Tier } from '@dool2/protocol/connect'
import {
  APPROVAL_TIERS,
  approvalLine,
  CATEGORY_LABEL,
  matchesCard,
  safetyLines,
} from '@dool2/protocol/connect-text'
import { withLogo } from './dom.js'

export interface ConnectCtx {
  services?: ConnectionItem[]
  query: string
  online: boolean
  /** 연결하기를 눌러 PC 답을 기다리는 서비스 */
  opening?: string
  /** 두리 본체가 지금 로그인하고 있는 서비스 */
  connecting?: Set<string>
  /** 화면 머리: back이 있으면 뒤로 버튼 */
  header(title: string, back?: () => void): HTMLElement
  home(): void
  list(): void
  detail(id: string): void
  setQuery(q: string): void
  open(id: string): void
  mark(id: string, on: boolean): void
  /** 예시 부탁을 부탁 칸에 넣고 홈으로 */
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
  찾아보기: PATH.search,
  '채워 두기': PATH.fill,
  '돈 내기': PATH.pay,
  연락하기: PATH.send,
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

/** 연결한 날: 오늘 · 어제 · 11월 15일 */
export function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff <= 0) return '오늘'
  if (diff === 1) return '어제'
  return `${d.getMonth() + 1}월 ${d.getDate()}일`
}

/** 서비스 아이콘: 로고 파일 없이 이름 첫 글자 */
function mark(card: ConnectCard, big = false) {
  // 숫자로 시작하면 숫자 묶음(11번가 → 11), 아니면 첫 글자
  const lead = /^\d+/.exec(card.name)?.[0] ?? [...card.name][0] ?? ''
  const m = el('span', big ? 'svc-mark lg' : 'svc-mark', lead)
  m.setAttribute('aria-hidden', 'true')
  return withLogo(m, card.id)
}

/** 홈에 두는 입구 한 줄: "서비스 연결 · 연결한 곳 3" */
export function connectEntry(services: ConnectionItem[] | undefined, onclick: () => void): HTMLElement {
  const n = services?.filter((s) => s.connectedAt).length ?? 0
  const b = el(
    'button',
    'connect-entry',
    el('span', 'svc-mark', svg(PATH.link)),
    el(
      'span',
      'row-text',
      el('strong', 'row-t', '서비스 연결'),
      el(
        'span',
        'row-d',
        n ? `연결한 곳 ${n}개 · 더 연결하기` : '쇼핑·예매·통신사… 한 번 연결해 두고 부탁해요',
      ),
    ),
    svg(PATH.chevron),
  )
  b.type = 'button'
  b.onclick = onclick
  return b
}

function row(it: ConnectionItem, ctx: ConnectCtx): HTMLElement {
  const b = el('button', 'row svc-row')
  b.type = 'button'
  const right = it.connectedAt
    ? el('span', 'meta', whenLabel(it.connectedAt))
    : it.card.how === 'open'
      ? el('span', 'meta', '로그인 없이')
      : it.tools?.some((t) => !t.login)
        ? el('span', 'meta', '연결 없이도 찾기')
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
  const box = el('section', 'tab-page connect', ctx.header('연결'))
  if (!ctx.services) {
    box.append(el('p', 'wait', el('span', 'spin'), 'PC에서 서비스 목록을 받는 중…'))
    return box
  }
  box.append(
    el(
      'p',
      'cap connect-intro',
      '찾기·비교는 연결 없이도 돼요. 주문·예약·내역 보기처럼 로그인이 필요한 일만 한 번 연결해 두면 부탁만 하면 돼요. 아이디·비밀번호는 PC 금고에만 저장돼요.',
    ),
  )
  const search = el('input', 'field connect-search')
  search.id = 'connect-search'
  search.type = 'search'
  search.placeholder = '서비스 찾기 (쿠팡, 항공권, 택배…)'
  search.value = ctx.query
  search.oninput = () => ctx.setQuery(search.value)
  box.append(search)

  const shown = ctx.services
    .filter((it) => matchesCard(it.card, ctx.query))
    .sort((a, b) => a.card.name.localeCompare(b.card.name, 'ko'))
  const group = (name: string, list: ConnectionItem[]) => {
    const ul = el('ul', 'list')
    for (const it of list) ul.append(row(it, ctx))
    return el('section', 'connect-group', el('h2', 'over', `${name} ${list.length}`), ul)
  }
  const connected = shown.filter((it) => it.connectedAt)
  if (connected.length && !ctx.query.trim()) box.append(group('두리가 로그인해 둔 곳', connected))
  for (const cat of Object.keys(CATEGORY_LABEL) as ConnectCard['category'][]) {
    const list = shown.filter((it) => it.card.category === cat)
    if (list.length) box.append(group(CATEGORY_LABEL[cat], list))
  }
  if (!shown.length)
    box.append(
      el('p', 'cap empty', '맞는 서비스가 없어요. 그래도 부탁해 보면 두리가 일반적인 방법으로 해 볼게요.'),
    )
  return box
}

export function serviceView(ctx: ConnectCtx, id: string): HTMLElement {
  const it = ctx.services?.find((s) => s.card.id === id)
  if (!it) return connectionsView(ctx)
  const c = it.card
  const box = el('section', 'tab-page connect service', ctx.header('', ctx.list))

  box.append(
    el(
      'div',
      'svc-head',
      mark(c, true),
      el('div', '', el('h1', 'title', c.name), el('p', 'meta mono', c.site ?? '폰 권한')),
    ),
    el('p', 'svc-summary', c.summary),
  )

  // 대화 예시: 부탁 → 일하는 중 → 답 (두리 말은 회색 말풍선, 내 말은 ink)
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
    if (APPROVAL_TIERS.includes(a.tier)) li.append(el('span', 'pill ask', '폰 승인'))
    abilities.append(li)
  }
  const approval = approvalLine(c)
  box.append(el('h2', 'over', '이렇게 맡겨요'), abilities)
  if (approval) box.append(el('p', 'cap', approval))

  // 서비스 도구(ADR 0018)가 있으면: 화면을 하나씩 누르지 않고 바로 하는 일
  if (it.tools?.length) {
    const fast = el('ul', 'list svc-abilities')
    for (const t of it.tools) {
      const li = el('li', 'row', svg(TIER_ICON[t.tier]), el('span', 'row-text', el('span', 'row-t', t.title)))
      if (!it.connectedAt)
        li.append(el('span', t.login ? 'pill' : 'meta', t.login ? '연결하면' : '로그인 없이'))
      fast.append(li)
    }
    box.append(
      el('h2', 'over', '바로 해요'),
      el('p', 'cap', '두리가 이 일은 화면을 하나씩 누르지 않고 바로 해서 빨라요.'),
      fast,
    )
  }

  const safety = el('ul', 'svc-safety')
  for (const line of safetyLines(c)) safety.append(el('li', '', line))
  box.append(el('h2', 'over', '안전하게 지키는 방법'), safety)

  // 아래 버튼 줄
  const bar = el('div', 'svc-action')
  const tryAsk = el('button', 'btn-ghost', '부탁해 보기')
  tryAsk.type = 'button'
  tryAsk.onclick = () => ctx.tryAsk(c.example.ask)
  if (c.how === 'device') {
    bar.append(el('p', 'cap', '폰 권한으로 켜는 연결은 두리 폰 앱(네이티브)에서 준비 중이에요.'))
  } else if (c.how === 'open') {
    bar.append(tryAsk)
  } else if (it.connectedAt) {
    const off = el('button', 'btn-text', '연결 끊기')
    off.type = 'button'
    off.onclick = () => ctx.mark(c.id, false)
    bar.append(el('p', 'meta svc-connected', `${whenLabel(it.connectedAt)} 연결했어요`), tryAsk, off)
  } else {
    const busy = ctx.connecting?.has(c.id)
    const go = el(
      'button',
      'btn lg',
      busy ? '두리가 로그인하는 중…' : ctx.opening === c.id ? 'PC에서 여는 중…' : '연결하기',
    )
    go.type = 'button'
    go.disabled = !ctx.online || ctx.opening === c.id || Boolean(busy)
    go.onclick = () => ctx.open(c.id)
    bar.append(go, el('p', 'cap', '아이디·비밀번호를 넣으면 두리가 PC의 Chrome에서 대신 로그인해요.'))
  }
  box.append(bar)
  return box
}
