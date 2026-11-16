// 서비스 연결 화면 (ADR 0014): 분류별 목록 → 서비스 상세 → Chrome에서 로그인 → 연결 표시.
// 화면은 카드(skills/<id>/connect.json)를 그리기만 한다. 서비스별 코드는 두지 않는다.
import type { ConnectCard, ConnectionItem, SocialProvider, Tier } from '@dool2/protocol/connect'

/** 간편 로그인 이름 (@dool2/protocol/connect의 SOCIAL_LABEL 복사, 테스트가 같은지 본다) */
export const SOCIAL_LABEL: Record<SocialProvider, string> = {
  kakao: '카카오',
  naver: '네이버',
  google: '구글',
  apple: 'Apple',
  facebook: '페이스북',
  payco: '페이코',
  toss: '토스',
}

/** @dool2/protocol/connect의 분류 이름 (화면 번들에 zod를 넣지 않으려고 복사해 둔다. 테스트가 같은지 본다) */
export const CATEGORY_LABEL: Record<ConnectCard['category'], string> = {
  shopping: '쇼핑',
  grocery: '장보기·배달',
  fashion: '패션·뷰티',
  travel: '여행·숙소',
  flight: '항공',
  tickets: '예매·예약',
  media: '영상·음악',
  books: '책',
  social: 'SNS',
  work: '업무',
  mail: '메일·일정',
  telecom: '통신',
  life: '생활',
  device: '휴대폰',
}
const APPROVAL: readonly Tier[] = ['돈 내기', '연락하기']

export interface ConnectionsOptions {
  api<T>(path: string, init?: RequestInit): Promise<T>
  /** 그릴 자리 (.messages) */
  box: HTMLElement
  setHeader(title: string, sub: string): void
  /** 예시 부탁을 새 대화로 보내기 */
  ask(text: string): void
}

const SVG = 'http://www.w3.org/2000/svg'
/** 24 격자 선 아이콘 (ui.css svg.i) */
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
  찾아보기: ICON.search,
  '채워 두기': ICON.fill,
  '돈 내기': ICON.pay,
  연락하기: ICON.send,
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** 서비스 아이콘: 로고 파일 없이 이름 첫 글자 (ADR 0014) */
function mark(card: ConnectCard, size: 'sm' | 'lg' = 'sm'): HTMLElement {
  const m = el('span', `svc-mark ${size}`, [...card.name][0] ?? '')
  m.setAttribute('aria-hidden', 'true')
  // 로고 (dom.ts의 withLogo와 같다. 이 파일은 시험에서 dom.ts 없이 불러온다)
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
  return `${risky.slice(0, 3).join(', ')} 같은 일은 폰에서 승인한 뒤에만 해요.`
}

function dateLabel(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}월 ${d.getDate()}일`
}

/** 상세 화면의 "안전하게 지키는 방법" (연결 방식마다) */
export function safetyLines(card: ConnectCard): string[] {
  const approval = card.abilities.some((a) => APPROVAL.includes(a.tier))
    ? ['결제·주문·보내기 같은 마지막 버튼은 폰에서 승인해야만 눌러요.']
    : []
  switch (card.how) {
    case 'browser':
      return [
        `로그인은 내 Chrome에서 직접 해요(${card.login ?? '아이디·비밀번호'}). 두리(AI)는 비밀번호를 보지 않아요.`,
        '로그인이 풀리면 두리 금고에 저장한 값을 두리 본체가 채우거나, 화면을 넘겨 드려요.',
        ...approval,
      ]
    case 'official':
      return [
        '공식 연동이 준비되기 전까지는 내 Chrome에서 로그인해 둔 화면으로 일해요.',
        '두리(AI)는 비밀번호를 보지 않아요.',
        ...approval,
      ]
    case 'open':
      return ['로그인 없이 쓰는 서비스예요. 연결하지 않아도 바로 부탁하면 돼요.', ...approval]
    case 'device':
      return ['폰 앱에서 권한을 켜요. 켠 뒤에도 폰 설정에서 언제든 끌 수 있어요.', ...approval]
  }
}

export function renderConnections(opts: ConnectionsOptions, open?: string): Promise<void> {
  let items: ConnectionItem[] = []
  let query = ''

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
      right.append(el('span', 'dot ok'), el('span', '', '연결됨'))
    } else if (it.card.how === 'open') right.append(el('span', '', '로그인 없이'))
    right.append(icon(ICON.chevron))
    b.append(mark(it.card), text, right)
    b.onclick = () => showDetail(it.card.id)
    li.append(b)
    return li
  }

  const showList = () => {
    opts.setHeader('서비스 연결', '두리에게 맡길 서비스를 연결해요')
    const view = el('div', 'connect-view')
    const intro = el(
      'p',
      'sub',
      '한 번 연결해 두면 폰에서 "주문한 거 언제 와?"처럼 부탁만 하면 돼요. 로그인은 내 Chrome에서 직접 해요.',
    )
    const search = el('input', 'field svc-search') as HTMLInputElement
    search.type = 'search'
    search.placeholder = '서비스 찾기 (예: 쿠팡, 항공권, 택배)'
    search.value = query
    const groups = el('div', 'svc-groups')
    const draw = () => {
      const q = query.trim().toLowerCase()
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
      const connected = shown.filter((it) => it.connectedAt)
      if (connected.length && !q) sections.push(section('연결됨', connected))
      for (const cat of Object.keys(CATEGORY_LABEL) as ConnectCard['category'][]) {
        const list = shown.filter((it) => it.card.category === cat)
        if (list.length) sections.push(section(CATEGORY_LABEL[cat], list))
      }
      if (!sections.length)
        sections.push(
          el(
            'p',
            'cap svc-empty',
            '맞는 서비스가 없어요. 그래도 부탁해 보면 두리가 일반적인 방법으로 해 볼게요.',
          ),
        )
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
    view.append(intro, search, groups)
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
    back.append(icon(ICON.back), '서비스 목록')
    back.onclick = () => showList()

    const head = el('div', 'svc-head')
    const names = el('div')
    names.append(el('h2', 'title', c.name), el('p', 'cap mono', c.site ?? '폰 권한'))
    head.append(mark(c, 'lg'), names)

    // 대화 예시: 부탁 → 일하는 중 → 답
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
        tag.append(el('span', 'dot warn'), el('span', '', '폰 승인'))
        li.append(tag)
      }
      abilities.append(li)
    }

    const safety = el('section', 'svc-safety')
    const ul = el('ul')
    for (const line of safetyLines(c)) ul.append(el('li', '', line))
    safety.append(el('h2', 'over', '안전하게 지키는 방법'), ul)

    const action = el('div', 'svc-action')
    const drawAction = (note?: string) => {
      const kids: (Node | string)[] = []
      const tryAsk = el('button', 'btn-ghost', '부탁해 보기')
      tryAsk.type = 'button'
      tryAsk.onclick = () => opts.ask(c.example.ask)
      if (c.how === 'device') {
        kids.push(el('p', 'cap', '폰 앱의 서비스 연결에서 켜요.'))
      } else if (c.how === 'open') {
        kids.push(tryAsk)
      } else if (it.connectedAt) {
        const state = el('p', 'svc-connected')
        state.append(el('span', 'dot ok'), `${dateLabel(it.connectedAt)}에 연결했어요`)
        const off = el('button', 'btn-text', '연결 끊기')
        off.type = 'button'
        off.onclick = async () => {
          await opts.api(`/api/connections/${c.id}`, { method: 'DELETE' })
          delete it.connectedAt
          drawAction()
        }
        kids.push(state, tryAsk, off)
      } else {
        // 아이디·비밀번호를 넣으면 두리 본체가 Chrome에서 대신 로그인한다 (값은 금고로만)
        const form = el('form', 'svc-login')
        const user = el('input', 'field')
        user.placeholder = '아이디 또는 이메일'
        user.autocomplete = 'username'
        const pw = el('input', 'field')
        pw.type = 'password'
        pw.placeholder = '비밀번호'
        pw.autocomplete = 'current-password'
        const go = el('button', 'btn', '연결하기')
        go.type = 'submit'
        const direct = el('button', 'btn-text', '카카오·네이버로 로그인하는 곳이면 Chrome에서 직접')
        direct.type = 'button'
        direct.onclick = async () => {
          try {
            await opts.api(`/api/connections/${c.id}/open`, { method: 'POST' })
            drawWaiting()
          } catch (e) {
            drawAction((e as Error).message)
          }
        }
        form.onsubmit = async (e) => {
          e.preventDefault()
          if (!user.value.trim() || !pw.value) return
          go.disabled = true
          go.textContent = '두리가 로그인하는 중…'
          try {
            // 뒤에서: 바로 돌아오고, 결과는 대화 알림으로 온다 (이 화면에서 기다리지 않아도 된다)
            const r = await opts.api<{ ok: boolean; message: string; human?: boolean; started?: boolean }>(
              `/api/connections/${c.id}/login`,
              {
                method: 'POST',
                body: JSON.stringify({ username: user.value.trim(), password: pw.value, background: true }),
              },
            )
            pw.value = ''
            if (r.ok) {
              it.connectedAt = new Date().toISOString()
              drawAction(r.message)
            } else if (r.human) drawWaiting()
            else drawAction(r.message)
          } catch (e) {
            drawAction((e as Error).message)
          }
        }
        form.append(user, pw, go)
        // 간편 로그인: 이 PC Chrome의 카카오·네이버… 로그인을 이어 쓰고, 처음이면 그 화면을 띄워 드린다
        if (c.social?.length) {
          const row = el('div', 'social-row')
          for (const provider of c.social) {
            const b = el('button', `btn-social ${provider}`, `${SOCIAL_LABEL[provider]}로 연결`)
            b.type = 'button'
            b.onclick = async () => {
              for (const x of row.querySelectorAll('button')) x.disabled = true
              b.textContent = '두리가 로그인하는 중…'
              try {
                const r = await opts.api<{ ok: boolean; message: string; human?: boolean }>(
                  `/api/connections/${c.id}/social`,
                  { method: 'POST', body: JSON.stringify({ provider, background: true }) },
                )
                if (r.ok) it.connectedAt = new Date().toISOString()
                if (r.human) drawWaiting()
                else drawAction(r.message)
              } catch (e) {
                drawAction((e as Error).message)
              }
            }
            row.append(b)
          }
          kids.push(row, el('p', 'cap social-or', '또는 아이디·비밀번호로'))
        }
        kids.push(
          form,
          el('p', 'cap', 'PC의 두리 금고에만 암호화해 저장돼요. 두리(AI)는 비밀번호를 보지 않아요.'),
          direct,
        )
      }
      if (note) kids.push(el('p', 'cap svc-note', note))
      action.replaceChildren(...kids)
    }
    // Chrome에서 열어 둔 뒤: 사용자가 로그인을 마치면 [로그인했어요]
    // Chrome에서 열어 둔 뒤: 로그인을 마치면 두리가 화면을 보고 알아서 연결로 표시한다. 안 되면 [로그인했어요]
    let poll: ReturnType<typeof setInterval> | undefined
    const stopPoll = () => {
      if (poll) clearInterval(poll)
      poll = undefined
    }
    const drawWaiting = () => {
      const msg = el(
        'p',
        'sub',
        `Chrome에서 ${c.name}을(를) 열었어요. 로그인하면 두리가 화면을 보고 알아서 확인해요.`,
      )
      const done = el('button', 'btn', '로그인했어요')
      done.type = 'button'
      done.onclick = async () => {
        stopPoll()
        const r = await opts.api<{ connectedAt: string }>(`/api/connections/${c.id}`, { method: 'PUT' })
        it.connectedAt = r.connectedAt
        drawAction()
      }
      const cancel = el('button', 'btn-text', '나중에')
      cancel.type = 'button'
      cancel.onclick = () => {
        stopPoll()
        drawAction()
      }
      action.replaceChildren(msg, done, cancel)
      stopPoll()
      poll = setInterval(async () => {
        // 다른 화면으로 가면 그만 묻는다
        if (!action.isConnected) return stopPoll()
        const list = await opts.api<{ services: ConnectionItem[] }>('/api/connections').catch(() => undefined)
        const at = list?.services.find((x) => x.card.id === c.id)?.connectedAt
        if (!at) return
        stopPoll()
        it.connectedAt = at
        drawAction('로그인을 확인했어요. 이제 부탁만 하면 돼요.')
      }, 2_000)
    }
    drawAction()

    const approval = approvalLine(c)
    view.append(
      back,
      head,
      el('p', 'svc-summary', c.summary),
      demo,
      el('h2', 'over', '이렇게 맡겨요'),
      abilities,
      ...(approval ? [el('p', 'cap svc-approval', approval)] : []),
      safety,
      action,
    )
    opts.box.replaceChildren(view)
    opts.box.scrollTop = 0
  }

  return load().then(() => (open ? showDetail(open) : showList()))
}
