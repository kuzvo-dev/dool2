// 페이지 안에서 도는 함수들. chrome.scripting.executeScript로 확장 전용 공간(ISOLATED world)에 넣는다.
// 그래서 페이지 스크립트는 두리가 붙인 표시(ref)를 볼 수 없다. (예외: pageMarkTaps만 페이지 공간에서 돈다)
// 주의: 각 함수는 바깥 변수를 쓰면 안 된다 (문자열로 옮겨져 따로 실행된다).

export interface SnapshotResult {
  url: string
  title: string
  text: string
  truncated: boolean
  refs: number
  /** 캡차·자동입력 방지 화면이 보인다 */
  captcha: boolean
  /** view로 읽었을 때: 화면 위·아래에 남은 글 (대략의 글자 수) */
  around?: { above: number; below: number }
  /** from·skip으로 앞에서 건너뛴 글자 수 */
  skipped?: number
  /** from 글자를 페이지에서 찾지 못했다 (처음부터 읽었다) */
  fromMissing?: boolean
}

/** 어디를 읽을지. view: 지금 화면에 보이는 부분만, from: 이 글자가 나오는 줄부터, skip: 앞에서 이만큼 건너뛰고 */
export interface ReadScope {
  view?: boolean
  from?: string
  skip?: number
}

/**
 * 페이지 스크립트 공간(MAIN world)에서 돈다: React·Vue가 클릭 처리기만 붙인 상자에 data-dool2-tap 표시를 단다.
 * 휴대폰용 사이트(캐치테이블 등)는 목록 줄·카드를 손가락 커서·role 없이 div + onClick으로 만들어서,
 * 확장 공간에서는 누를 수 있는지 알 길이 없다 (처리기는 페이지 스크립트 쪽 속성에만 있다).
 * 표시만 달고 아무것도 누르거나 읽어 가지 않는다. 사이트가 같은 표시를 직접 달아도 버튼으로 보일 뿐이다.
 */
export function pageMarkTaps(): number {
  const TAP = 'data-dool2-tap'
  const EVENTS = ['onClick', 'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp', 'onTouchEnd']
  const VUE = /^on(click|mousedown|mouseup|pointerdown|pointerup|touchend)/i
  const NATIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'BODY', 'HTML'])
  const hasTap = (el: Element): boolean => {
    const o = el as unknown as Record<string, unknown>
    for (const k of Object.keys(o)) {
      // React 17+: __reactProps$무작위 = 그 요소의 props
      if (k.startsWith('__reactProps$')) {
        const p = o[k] as Record<string, unknown> | null
        if (p && EVENTS.some((e) => typeof p[e] === 'function')) return true
      }
      // Vue 3: _vei = 붙인 처리기 (onClick 등)
      if (k === '_vei') {
        const v = o[k] as Record<string, unknown> | null
        if (v && Object.keys(v).some((e) => VUE.test(e))) return true
      }
    }
    return false
  }
  for (const el of document.querySelectorAll(`[${TAP}]`)) el.removeAttribute(TAP)
  let n = 0
  let seen = 0
  for (const el of document.body?.getElementsByTagName('*') ?? []) {
    if (++seen > 30_000) break
    if (NATIVE.has(el.tagName) || el.hasAttribute('role') || el.hasAttribute('onclick')) continue
    if (hasTap(el)) {
      el.setAttribute(TAP, '')
      n++
    }
  }
  return n
}

/** 페이지를 AI가 읽기 좋은 글로 바꾼다. 누를 수 있는 것에는 [e12 버튼 "검색"]처럼 표시를 붙인다 */
/** base: 화면 안 액자(iframe)는 표시 번호를 10000씩 띄워 매긴다 (액자 1 → e10001…) */
export function pageSnapshot(maxChars: number, base = 0, scope: ReadScope = {}): SnapshotResult {
  type State = {
    refs: Map<string, WeakRef<Element>>
    ids: WeakMap<Element, string>
    seq: number
    /** 두리 금고가 채운 칸: 값을 글로 내보내지 않는다 */
    filled?: WeakSet<Element>
    /** 표시마다 읽을 때의 앞쪽 글 (누르기 직전에 견줘 다른 칸이 됐는지 본다) */
    ctx?: Map<string, string>
    ctxOf?: (el: Element, max?: number) => string
  }
  const g = globalThis as unknown as { __dool2?: State }
  g.__dool2 ??= { refs: new Map(), ids: new WeakMap(), seq: 0 }
  const st = g.__dool2
  st.refs = new Map()
  const ctx = new Map<string, string>()
  st.ctx = ctx
  // 요소 앞쪽 글 300자. 목록을 굴리면 칸을 재활용하는 사이트(캐치테이블 가게 목록)는 같은 칸에 다른 가게를
  // 그린다: 날짜 칸 글("11.27 (금) 예약 가능")은 같아도 앞쪽의 가게 이름·설명이 달라진다
  const ctxOf = (el: Element, max = 300) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    w.currentNode = el
    let out = ''
    for (let n = w.previousNode(); n && out.length < max; n = w.previousNode()) {
      const t = (n as Text).data.replace(/\s+/g, ' ').trim()
      if (t) out = `${t} ${out}`
    }
    return out.slice(-max)
  }
  st.ctxOf = ctxOf

  const BLOCK = new Set(
    'ADDRESS ARTICLE ASIDE BLOCKQUOTE DD DETAILS DIALOG DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION TABLE TR UL'.split(
      ' ',
    ),
  )
  const SKIP = new Set(
    'SCRIPT STYLE NOSCRIPT TEMPLATE svg SVG CANVAS IFRAME OBJECT EMBED HEAD META LINK'.split(' '),
  )
  const ROLES: Record<string, string> = {
    button: '버튼',
    link: '링크',
    checkbox: '체크박스',
    radio: '라디오',
    switch: '스위치',
    tab: '탭',
    menuitem: '메뉴',
    menuitemcheckbox: '메뉴',
    menuitemradio: '메뉴',
    option: '선택지',
    combobox: '선택 상자',
    textbox: '입력칸',
    searchbox: '검색칸',
    treeitem: '항목',
  }
  const clean = (s: string | null | undefined, max = 80) => {
    // 큰따옴표는 표시 [e1 버튼 "이름"]의 경계라서 작은따옴표로 바꾼다
    const t = (s ?? '').replace(/\s+/g, ' ').replaceAll('"', "'").trim()
    return t.length > max ? `${t.slice(0, max - 1)}…` : t
  }

  /** 안에 누르거나 입력할 것이 따로 있는 큰 상자 (페이지 전체를 감싼 tabindex·role 상자): 하나로 묶지 않는다 */
  const TAP = 'data-dool2-tap'
  /** 이보다 글이 긴 클릭 상자는 이름만 짧게 달고 안을 계속 읽는다 */
  const LONG_TAP = 120
  const INNER =
    'input:not([type=hidden]),select,textarea,button,a[href],[role=button],[role=link],[role=textbox],[data-dool2-tap]'
  const wrapsControls = (el: Element) => {
    for (const c of el.querySelectorAll(INNER)) {
      // 꾸밈용 숨은 칸은 치지 않는다: <label role="radio" aria-label="홀"> 안의 크기 0·aria-hidden input
      // (캐치테이블 테이블 타입). 이걸 진짜 칸으로 보면 라벨을 건너뛰고, 안의 글은 aria-hidden이라 다 사라졌다
      if (c.closest('[aria-hidden="true"]')) continue
      const r = c.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      return true
    }
    return false
  }

  const interactiveRole = (el: Element): string | undefined => {
    const role = el.getAttribute('role')
    if (role && ROLES[role]) {
      // 네이티브가 아닌 role 상자가 안에 칸·버튼을 품고 있으면 안을 읽는다
      if (!['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && wrapsControls(el))
        return undefined
      return ROLES[role]
    }
    switch (el.tagName) {
      case 'A':
        return el.hasAttribute('href') ? '링크' : undefined
      case 'BUTTON':
      case 'SUMMARY':
        return '버튼'
      case 'SELECT':
        return '선택 상자'
      case 'TEXTAREA':
        return '입력칸'
      case 'INPUT': {
        const type = (el as HTMLInputElement).type
        if (type === 'hidden') return undefined
        if (type === 'password') return '비밀번호칸'
        if (type === 'checkbox') return '체크박스'
        if (type === 'radio') return '라디오'
        if (['button', 'submit', 'reset', 'image'].includes(type)) return '버튼'
        if (type === 'search') return '검색칸'
        return '입력칸'
      }
    }
    if ((el as HTMLElement).isContentEditable && !el.parentElement?.isContentEditable) return '입력칸'
    if ((el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') && !wrapsControls(el))
      return '버튼'
    // React·Vue가 클릭 처리기만 붙인 상자 (휴대폰용 사이트의 목록 줄·가게 카드): pageMarkTaps가 표시해 둔다
    if (el.hasAttribute(TAP) && !wrapsControls(el)) return '버튼'
    // 손가락 커서만 준 글자 상자 ("카카오로 로그인" div 등): 짧은 글이면 버튼으로 본다
    if (pointerBox(el)) return '버튼'
    return undefined
  }

  /** 커서가 손가락인 짧은 상자 (부모부터 손가락이면 가장 바깥 하나만) */
  const POINTER_TAGS = new Set(['DIV', 'SPAN', 'LI', 'P', 'LABEL', 'IMG', 'DT', 'DD'])
  const pointerBox = (el: Element): boolean => {
    if (!POINTER_TAGS.has(el.tagName) || wrapsControls(el)) return false
    if (getComputedStyle(el).cursor !== 'pointer') return false
    const parent = el.parentElement
    if (parent && POINTER_TAGS.has(parent.tagName) && getComputedStyle(parent).cursor === 'pointer') {
      // 부모가 짧은 손가락 상자면 부모가 이미 버튼이다
      const pt = (parent as HTMLElement).innerText?.trim() ?? ''
      if (pt.length > 0 && pt.length <= 40) return false
    }
    const t = (el as HTMLElement).innerText?.trim() ?? ''
    if (t.length > 40) return false
    return t.length > 0 || el.hasAttribute('aria-label') || el.querySelector('img[alt]') !== null
  }

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label')
    if (aria) return clean(aria)
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
      if (clean(t)) return clean(t)
    }
    const labels = (el as HTMLInputElement).labels
    if (labels?.length) return clean(Array.from(labels, (l) => l.textContent).join(' '))
    if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type))
      return clean(el.value)
    const text = clean((el as HTMLElement).innerText)
    if (text) return text
    const img = el.querySelector('img[alt]')
    return (
      clean(
        el.getAttribute('placeholder') ??
          el.getAttribute('title') ??
          img?.getAttribute('alt') ??
          el.getAttribute('name'),
      ) || iconName(el)
    )
  }

  /** 글 없는 아이콘 버튼의 뜻을 속성(테스트 id·클래스·아이콘 이름·svg 제목)에서 찾는다. 못 찾으면 '' */
  const ICONS: [RegExp, string][] = [
    [/(?:^|[^a-z])(?:minus|decrease|decrement|subtract|remove-one|qty-down|count-down)(?:[^a-z]|$)/i, '빼기'],
    [/(?:^|[^a-z])(?:plus|increase|increment|add-one|qty-up|count-up)(?:[^a-z]|$)/i, '더하기'],
    [/(?:^|[^a-z])(?:close|dismiss|x-?mark|cancel)(?:[^a-z]|$)/i, '닫기'],
    [/(?:^|[^a-z])(?:search|magnif[a-z]*)(?:[^a-z]|$)/i, '검색'],
    [/(?:^|[^a-z])(?:back|prev|arrow-?left|chevron-?left)(?:[^a-z]|$)/i, '이전'],
    [/(?:^|[^a-z])(?:next|forward|arrow-?right|chevron-?right)(?:[^a-z]|$)/i, '다음'],
    [/(?:^|[^a-z])(?:menu|hamburger|more|kebab|ellipsis)(?:[^a-z]|$)/i, '메뉴'],
    [/(?:^|[^a-z])(?:share)(?:[^a-z]|$)/i, '공유'],
    [/(?:^|[^a-z])(?:heart|like|bookmark|favorite|wish)(?:[^a-z]|$)/i, '찜'],
    [/(?:^|[^a-z])(?:delete|trash|bin)(?:[^a-z]|$)/i, '삭제'],
    [/(?:^|[^a-z])(?:cart|basket)(?:[^a-z]|$)/i, '장바구니'],
    [/(?:^|[^a-z])(?:home)(?:[^a-z]|$)/i, '홈'],
  ]
  const iconName = (el: Element): string => {
    const bits: string[] = []
    for (const e of [el, ...Array.from(el.querySelectorAll('svg, use, img, i, span')).slice(0, 6)]) {
      for (const a of [
        'data-testid',
        'data-icon',
        'data-name',
        'class',
        'id',
        'href',
        'xlink:href',
        'src',
        'name',
      ])
        bits.push(String(e.getAttribute(a) ?? ''))
      const t = e.querySelector?.('title')?.textContent
      if (t) bits.push(t)
    }
    // IconPlus·icMinus 같은 낙타 표기도 단어로 나눈다
    const hay = bits.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2')
    for (const [re, name] of ICONS) if (re.test(hay)) return name
    return ''
  }

  const extra = (el: Element): string => {
    if (st.filled?.has(el)) return ' 금고로 채워짐'
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? ' 선택됨' : ''
      if (el.type === 'password') return el.value ? ' 채워짐' : ''
      if (el.value && !['button', 'submit', 'reset', 'image'].includes(el.type))
        return ` 값="${clean(el.value, 60)}"`
      return ''
    }
    if (el instanceof HTMLTextAreaElement && el.value) return ` 값="${clean(el.value, 60)}"`
    if (el instanceof HTMLSelectElement) return ` 값="${clean(el.selectedOptions[0]?.textContent, 40)}"`
    if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true')
      return ' 선택됨'
    if (el.getAttribute('aria-expanded') === 'true') return ' 펼침'
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return ' 비활성'
    return ''
  }

  const lines: string[] = []
  let cur = ''
  const flush = () => {
    const t = cur.replace(/\s+/g, ' ').trim()
    if (t && t !== lines[lines.length - 1]) lines.push(t)
    cur = ''
  }
  const skip = Math.max(0, Math.floor(Number(scope.skip) || 0))
  // 건너뛸 글도 읽어야 어디서부터인지 안다 (from은 어디 있을지 몰라 넉넉히)
  let budget = scope.from ? Math.max((maxChars + skip) * 2, 400_000) : (maxChars + skip) * 2
  // view: 화면 위·아래로 완전히 벗어난 상자는 읽지 않고 글자 수만 센다 (고정된 머리말·팝업은 화면 안이라 읽는다)
  const vh = window.innerHeight
  const around = { above: 0, below: 0 }
  const offscreen = (el: Element): number => {
    if (!scope.view) return 0
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return 0
    if (r.bottom <= 0) return -1
    if (r.top >= vh) return 1
    return 0
  }

  const walk = (node: Node) => {
    if (budget <= 0) return
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node as Text).data
      cur += t
      budget -= t.length
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as Element
    if (SKIP.has(el.tagName)) return
    if (el.getAttribute('aria-hidden') === 'true') return
    // display: contents 상자는 자기 상자가 없어서 checkVisibility가 늘 false다. 안은 보이니 계속 읽는다
    // (캐치테이블 검색 화면 전체가 이 상자 안에 있다)
    if (!el.checkVisibility({ visibilityProperty: true })) {
      const cs = getComputedStyle(el)
      if (cs.display !== 'contents' || cs.visibility === 'hidden') return
    }
    const off = offscreen(el)
    if (off) {
      const n = (el.textContent ?? '').replace(/\s+/g, ' ').trim().length
      if (off < 0) around.above += n
      else around.below += n
      return
    }

    const role = interactiveRole(el)
    if (role) {
      let ref = st.ids.get(el)
      if (!ref) {
        ref = `e${base + ++st.seq}`
        st.ids.set(el, ref)
      }
      st.refs.set(ref, new WeakRef(el))
      ctx.set(ref, ctxOf(el))
      // 클릭 처리기만 붙은 긴 상자 (글 단락·카드 전체): 표시만 붙이고 안의 글은 그대로 읽는다
      const long = el.hasAttribute(TAP) && ((el as HTMLElement).innerText?.trim().length ?? 0) > LONG_TAP
      const name = long ? clean((el as HTMLElement).innerText, 30) : nameOf(el)
      cur += ` [${ref} ${role}${name ? ` "${name}"` : ''}${extra(el)}] `
      if (!long) return
    }
    const block = BLOCK.has(el.tagName)
    if (block) flush()
    // 팝업인데 버튼 말고 글이 거의 없으면(안내를 그림으로 그린 팝업) AI가 화면을 찍어 보게 알린다
    if (
      el.tagName === 'DIALOG' ||
      el.getAttribute('role') === 'dialog' ||
      el.getAttribute('role') === 'alertdialog' ||
      el.getAttribute('aria-modal') === 'true'
    ) {
      const box = el.getBoundingClientRect()
      if (box.width >= 160 && box.height >= 120) {
        let words = (el as HTMLElement).innerText ?? ''
        for (const b of el.querySelectorAll('button, a, [role=button]'))
          words = words.replace((b as HTMLElement).innerText ?? '', '')
        if (
          words.replace(/\s+/g, '').length < 8 &&
          el.querySelector('img, canvas, svg, picture, [style*="background"]')
        )
          cur +=
            ' [이 창의 안내는 그림이라 글로 읽을 수 없어요. 무엇인지 알아야 하면 화면을 찍어 확인하세요] '
      }
    }
    const h = /^H([1-6])$/.exec(el.tagName)
    if (h) cur += `${'#'.repeat(Number(h[1]))} `
    if (el.tagName === 'IMG') {
      const alt = clean(el.getAttribute('alt'), 60)
      if (alt) cur += ` [그림 "${alt}"] `
    }
    if (el.tagName === 'BR') flush()
    for (const child of Array.from(el.childNodes)) walk(child)
    if (el.shadowRoot) for (const child of Array.from(el.shadowRoot.childNodes)) walk(child)
    if (el.tagName === 'TD' || el.tagName === 'TH') cur += ' | '
    if (block) flush()
  }
  if (document.body) walk(document.body)
  flush()

  let text = lines
    .join('\n')
    // 이름 없는 버튼 둘 사이에 숫자 하나 (수량 고르기): 앞은 줄이기, 뒤는 늘리기 (캐치테이블 추가 상품 등)
    .replace(
      /\[(e\d+) 버튼(( [^\]"]*)?)\](\s+)(\d{1,3})(\s+)\[(e\d+) 버튼(( [^\]"]*)?)\]/g,
      (_m, a: string, ax: string, _a2, s1: string, n: string, s2: string, b: string, bx: string) =>
        `[${a} 버튼 "수량 줄이기"${ax}]${s1}${n}${s2}[${b} 버튼 "수량 늘리기"${bx}]`,
    )
  let start = 0
  let fromMissing = false
  if (scope.from) {
    const at = text.indexOf(scope.from)
    if (at < 0) fromMissing = true
    else start = text.lastIndexOf('\n', at) + 1
  }
  start = Math.min(start + skip, text.length)
  const truncated = text.length > start + maxChars || budget <= 0
  text = text.slice(start, start + maxChars)

  const bodyText = document.body?.innerText ?? ''
  // 보안 문자: 실제로 풀어야 하는 것만. 보이지 않는 reCAPTCHA(오른쪽 아래 배지, "protected by reCAPTCHA")는
  // 사람이 할 게 없는데 예전에는 이것 때문에 KT·CGV·링크드인 같은 곳을 "사람 차례"로 넘겼다
  const shown = (el: Element) => {
    if (el.closest('.grecaptcha-badge')) return false
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return (
      r.width >= 40 &&
      r.height >= 20 &&
      cs.visibility !== 'hidden' &&
      cs.display !== 'none' &&
      Number(cs.opacity) > 0.1
    )
  }
  const challenge = [
    ...document.querySelectorAll(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], [class*="captcha" i], [id*="captcha" i], img[src*="captcha" i]',
    ),
  ].some((el) => {
    if (!shown(el)) return false
    const src = el instanceof HTMLIFrameElement ? el.src : ''
    // 보이지 않는 reCAPTCHA의 틀(size=invisible)은 문제가 아니다
    return !/[?&]size=invisible/.test(src)
  })
  // 글자로만 찾는 것은 짧은 화면(로그인·확인 화면)에서만: 긴 화면(메일함·글)은 내용에 그 말이 섞인다
  // (지메일 받은편지함: 메일 제목의 '보안문자' 때문에 로봇 확인으로 보였다)
  const captcha =
    challenge ||
    (bodyText.length < 6000 &&
      /자동입력\s*방지|보안\s*문자|로봇이 아닙니다|I'm not a robot|아래\s*문제에\s*답해|DKAPTCHA/i.test(
        bodyText,
      ))

  return {
    url: location.href,
    title: document.title,
    text,
    truncated,
    refs: st.refs.size,
    captcha,
    ...(scope.view ? { around } : {}),
    ...(start ? { skipped: start } : {}),
    ...(fromMissing ? { fromMissing } : {}),
  }
}

/** point: 좌표만 / type: 초점 + 기존 글자 선택 / activate: 키보드로 누를 수 있게 초점만 */
export type LocateMode = 'point' | 'type' | 'activate'

export interface LocateResult {
  ok: true
  x: number
  y: number
  tag: string
  isPassword: boolean
  origin: string
  /** 탭이 화면에 그려지지 않는 중이다 (창이 가려짐·화면 꺼짐). 이때는 마우스 입력이 버려진다 */
  hidden: boolean
  /** activate: 초점을 받았는지 */
  focused?: boolean
  /** activate: 체크박스·라디오처럼 Space로 누르는 요소 */
  toggle?: boolean
  /** 그 자리를 다른 것이 덮고 있다 (팝업 등) */
  coveredBy?: string
  /** 화면 안 액자(iframe) 속 요소 (좌표는 페이지 화면 기준으로 바꿔 둠) */
  frame?: boolean
  /** 화면 밖에 있어서 굴려 옮겼다 (늦게 뜨는 그림·목록으로 자리가 밀릴 수 있어 부르는 쪽이 다시 잰다) */
  moved?: boolean
}

/**
 * 화면에 보이는 글자로 누를 곳 찾기: 그 글자를 가진 가장 작은 보이는 요소에 표시(ref)를 붙인다.
 * 가게 카드처럼 링크·버튼·손가락 커서 없이 사이트 스크립트로만 눌리는 상자가 있다 (캐치테이블 검색 결과).
 * 글자 요소를 누르면 클릭이 카드까지 올라가 카드가 눌린다
 */
export function pageMarkText(
  text: string,
): { ok: true; ref: string; name: string } | { ok: false; error: string } {
  type State = { refs: Map<string, WeakRef<Element>>; ids: WeakMap<Element, string>; seq: number }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  if (!st) return { ok: false, error: '먼저 페이지를 읽어 주세요' }
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const want = norm(text)
  if (!want) return { ok: false, error: '누를 글자를 주세요' }
  let best: { el: Element; exact: boolean; area: number; rank: number } | undefined
  for (const el of Array.from(document.body?.querySelectorAll('*') ?? [])) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HTML|BODY)$/.test(el.tagName)) continue
    const t = norm((el as HTMLElement).innerText ?? '')
    if (!t.includes(want)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
    const exact = t === want
    const area = r.width * r.height
    // 화면 안에 있는데 다른 것이 덮고 있으면(목록 창 뒤 지도 이름표 등) 누를 곳이 아니다: 맨 뒤로
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const inView = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight
    const top = inView ? document.elementFromPoint(cx, cy) : null
    const covered = inView && !(top && (top === el || el.contains(top) || top.contains(el)))
    const rank = (exact ? 2 : 0) + (covered ? 0 : 4)
    if (!best || rank > best.rank || (rank === best.rank && area < best.area))
      best = { el, exact, area, rank }
  }
  if (!best) return { ok: false, error: `화면에서 "${want}" 글자를 찾지 못했어요` }
  let ref = st.ids.get(best.el)
  if (!ref) {
    ref = `e${++st.seq}`
    st.ids.set(best.el, ref)
  }
  st.refs.set(ref, new WeakRef(best.el))
  return { ok: true, ref, name: norm((best.el as HTMLElement).innerText ?? '').slice(0, 60) }
}

/** 읽을 때의 앞쪽 글(was)이 지금 앞쪽 글(now)에서 사라졌나: 다른 칸이 그려졌다는 뜻.
 *  더해진 글은 괜찮다. 바로 앞 낱말 6개 중 둘이 사라져도 다른 칸이다 (짧은 가게 이름·설명만 바뀐 칸).
 *  (pageLocate 안에 같은 규칙이 있다) */
export function ctxReplaced(was: string, now: string): boolean {
  if (now.endsWith(was)) return false
  const have = new Set(now.split(' '))
  const words = was.split(' ').filter((x) => x.length > 1)
  const gone = words.filter((x) => !have.has(x)).length
  const goneNear = words.slice(-6).filter((x) => !have.has(x)).length
  return (gone >= 3 && gone >= words.length * 0.2) || goneNear >= 2
}

/** 표시(ref)가 가리키는 요소를 화면 가운데로 옮기고 좌표를 돌려준다 */
export function pageLocate(ref: string, mode: LocateMode): LocateResult | { ok: false; error: string } {
  type State = {
    refs: Map<string, WeakRef<Element>>
    ctx?: Map<string, string>
    ctxOf?: (el: Element, max?: number) => string
  }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  if (!el || !el.isConnected)
    return { ok: false, error: `${ref}를 찾을 수 없어요. 화면이 바뀌었을 수 있으니 다시 읽어 주세요` }
  // 상자가 없는 요소(display: contents 버튼 등)는 크기가 0으로 재진다: 안에 그려진 자식들의 영역을 쓴다
  // (캐치테이블 날짜·인원 창의 시간 버튼: 화면엔 보이는데 "보이지 않아요"로 못 눌렀다)
  const drawn = (e: Element) => {
    const b = e.getBoundingClientRect()
    return b.width > 0 && b.height > 0
  }
  // 숨긴 라디오·체크박스(크기 0 input)는 감싼 라벨을 누른다 (캐치테이블 시간 칸: <label><input radio><span>오후 7:30</span></label>)
  const label =
    el instanceof HTMLInputElement && !drawn(el) ? Array.from(el.labels ?? []).find(drawn) : undefined
  const anchor = label ?? (drawn(el) ? el : (Array.from(el.querySelectorAll('*')).find(drawn) ?? el))
  const box = (): DOMRect => {
    if (label) return label.getBoundingClientRect()
    if (drawn(el)) return el.getBoundingClientRect()
    const kids = Array.from(el.querySelectorAll('*'))
      .map((k) => k.getBoundingClientRect())
      .filter((k) => k.width > 0 && k.height > 0)
    if (!kids.length) return el.getBoundingClientRect()
    const left = Math.min(...kids.map((k) => k.left))
    const top = Math.min(...kids.map((k) => k.top))
    return new DOMRect(
      left,
      top,
      Math.max(...kids.map((k) => k.right)) - left,
      Math.max(...kids.map((k) => k.bottom)) - top,
    )
  }
  const r0 = box()
  const moved = r0.bottom < 0 || r0.top > window.innerHeight || r0.right < 0 || r0.left > window.innerWidth
  // 가로는 필요할 때만 옮긴다: 가로로 넘기는 달력(캐치테이블)은 가운데로 옮기면 사이트가 바로 되돌려서
  // 두 칸 옆 날짜가 눌렸다 (27일을 눌렀는데 25일)
  anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
  // 읽은 뒤 같은 칸에 다른 것이 그려졌으면 누르지 않는다 (가게 목록 칸 재활용: 아세누 27일을 눌렀는데 다른 가게가 열렸다)
  // 글이 더해진 것(아이디를 넣으면 생기는 '지우기' 버튼·안내 등)은 괜찮다. 읽을 때 있던 글이 사라졌을 때만
  // 다른 칸이 그려진 것으로 본다 (무신사·카카오 로그인: 아이디를 채우자 비밀번호 칸 앞 글이 늘어 채우기가 막혔다).
  // 입력은 목록 칸 재활용과 상관없어 보지 않는다
  // (규칙은 ctxReplaced와 같다. 페이지에 넣는 함수라 따로 부를 수 없어 여기 그대로 둔다)
  const was = st?.ctx?.get(ref)
  if (mode !== 'type' && was !== undefined && st?.ctxOf) {
    const now = st.ctxOf(el, 900)
    if (!now.endsWith(was)) {
      const have = new Set(now.split(' '))
      const words = was.split(' ').filter((x) => x.length > 1)
      const gone = words.filter((x) => !have.has(x)).length
      const goneNear = words.slice(-6).filter((x) => !have.has(x)).length
      if ((gone >= 3 && gone >= words.length * 0.2) || goneNear >= 2)
        return {
          ok: false,
          error: `${ref} 둘레 글이 읽을 때와 달라졌어요 (목록이 다시 그려졌을 수 있어요). 다시 읽고 골라 주세요`,
        }
    }
  }
  const r = box()
  if (r.width === 0 || r.height === 0) return { ok: false, error: `${ref}가 화면에 보이지 않아요` }
  const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1)
  const y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1)
  const top = document.elementFromPoint(x, y)
  let coveredBy: string | undefined
  if (top && top !== el && !el.contains(top) && top.closest('label')?.control !== el) {
    coveredBy = ((top as HTMLElement).innerText || top.tagName).replace(/\s+/g, ' ').trim().slice(0, 60)
    // 덮은 것이 다른 버튼·링크면 누르지 않는다: 그 자리를 누르면 덮은 버튼이 눌린다
    // (캐치테이블: 결제 방식 화면의 '다음' 위에 '이 방식으로 예약' 팝업이 떠 있었다)
    const other = top.closest(
      'a[href],button,input,select,textarea,label,[role=button],[role=link],[role=radio],[role=checkbox],[onclick],[data-dool2-tap]',
    )
    if (other && other !== el && !other.contains(el)) {
      const name = ((other as HTMLElement).innerText || other.getAttribute('aria-label') || other.tagName)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40)
      return {
        ok: false,
        error: `${ref} 자리를 다른 버튼 "${name}"이(가) 덮고 있어서 누르지 않았어요. 팝업이면 먼저 닫고(닫기·X) 다시 읽어 주세요`,
      }
    }
  }
  const h = el as HTMLElement
  let focused: boolean | undefined
  if (mode === 'type') {
    h.focus()
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select()
    else if (h.isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(h)
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  } else if (mode === 'activate') {
    h.focus({ preventScroll: true })
    focused = document.activeElement === el
  }
  const toggle =
    (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) ||
    ['checkbox', 'radio', 'switch'].includes(el.getAttribute('role') ?? '')
  return {
    ok: true,
    ...(moved ? { moved } : {}),
    x,
    y,
    tag: el.tagName.toLowerCase(),
    isPassword: el instanceof HTMLInputElement && el.type === 'password',
    origin: location.origin,
    hidden: document.visibilityState === 'hidden',
    ...(focused !== undefined ? { focused, toggle } : {}),
    ...(coveredBy ? { coveredBy } : {}),
  }
}

/** 마지막 수단: 초점을 못 받는 요소를 페이지 안에서 누른다 */
export function pageClick(ref: string) {
  type State = { refs: Map<string, WeakRef<Element>> }
  const el = (globalThis as unknown as { __dool2?: State }).__dool2?.refs.get(ref)?.deref()
  ;(el as HTMLElement | undefined)?.click()
  return Boolean(el)
}

export function pageScroll(dir: number) {
  window.scrollBy({ top: dir * Math.round(window.innerHeight * 0.8), behavior: 'instant' })
}

export function pageViewport() {
  // 폰 너비로 그릴 때 페이지가 넓으면 폰처럼 줄여 보인다: 실제로 보이는 영역(visualViewport)도 같이
  const vv = window.visualViewport
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    vv: vv
      ? { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height, scale: vv.scale }
      : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, scale: 1 },
    dpr: window.devicePixelRatio || 1,
    hidden: document.visibilityState === 'hidden',
    url: location.href,
    title: document.title,
  }
}

/** 두리 금고로 채운 칸이라고 표시한다 (그 뒤 페이지 읽기에서 값이 나가지 않게) */
export function pageMarkFilled(ref: string) {
  type State = { refs: Map<string, WeakRef<Element>>; filled?: WeakSet<Element> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  if (!st || !el) return false
  st.filled ??= new WeakSet()
  st.filled.add(el)
  // 칸에서 초점을 뺀다. 비밀번호 칸에 초점이 남아 있으면 Chrome 비밀번호 제안 창이 떠서
  // 다음 클릭(로그인 버튼)을 그 창이 삼킨다 (실측)
  ;(el as HTMLElement).blur()
  return true
}

/**
 * 원격 화면(폰)에서 누른 곳: 창이 가려져 있어 마우스 입력이 버려질 때 쓴다.
 * 그 자리의 요소에 초점을 주고(입력칸이면 거기서 끝), 아니면 누른다. 사이트가 보기에는 스크립트 클릭이다
 */
export function pageTapAt(x: number, y: number) {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  if (!el) return { ok: false }
  const field = el.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  ) as HTMLElement | null
  if (field) {
    field.focus()
    return { ok: true, focused: true }
  }
  const target = (el.closest(
    'a, button, label, [role="button"], [role="link"], [role="checkbox"], [onclick]',
  ) ?? el) as HTMLElement
  target.focus?.()
  target.click()
  return { ok: true, focused: false }
}

/**
 * 원격 화면(폰)에 같이 보낼 것: 보이는 입력칸 자리, 누를 만한 버튼, 지금 글자가 들어갈 칸.
 * 자리는 화면 비율(0~1). 비밀번호 칸의 글자는 보내지 않는다
 */
export function pageRemoteInfo() {
  // 자리는 보이는 영역(visualViewport) 기준 비율: 폰에 간 그림과 같은 기준
  const vv = window.visualViewport
  const OX = vv?.offsetLeft ?? 0
  const OY = vv?.offsetTop ?? 0
  const W = vv?.width || window.innerWidth || 1
  const H = vv?.height || window.innerHeight || 1
  const shown = (el: Element, r: DOMRect) => {
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0 || r.top >= H || r.left >= W)
      return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05
  }
  const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n)
  const labelOf = (el: HTMLElement) => {
    const f = el as HTMLInputElement
    const own = el.getAttribute('aria-label') || f.placeholder || f.labels?.[0]?.innerText || f.title || ''
    return clip(own, 40)
  }
  const modeOf = (el: HTMLElement) => {
    const f = el as HTMLInputElement
    if (f.inputMode) return f.inputMode
    if (f.type === 'tel') return 'tel'
    if (f.type === 'number') return 'numeric'
    if (f.type === 'email') return 'email'
    return ''
  }
  const SKIP = /^(hidden|checkbox|radio|submit|button|reset|image|file|range|color)$/
  const editable = (el: Element | null): el is HTMLElement => {
    if (!el) return false
    if (el instanceof HTMLInputElement) return !SKIP.test(el.type) && !el.disabled && !el.readOnly
    if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly
    return (el as HTMLElement).isContentEditable === true
  }
  const fields: {
    x: number
    y: number
    w: number
    h: number
    secret?: boolean
    mode?: string
    label?: string
  }[] = []
  for (const el of document.querySelectorAll(
    'input, textarea, [contenteditable=""], [contenteditable="true"]',
  )) {
    if (!editable(el)) continue
    const r = el.getBoundingClientRect()
    if (!shown(el, r)) continue
    const mode = modeOf(el)
    const label = labelOf(el)
    fields.push({
      x: (r.left - OX) / W,
      y: (r.top - OY) / H,
      w: r.width / W,
      h: r.height / H,
      ...((el as HTMLInputElement).type === 'password' ? { secret: true } : {}),
      ...(mode ? { mode } : {}),
      ...(label ? { label } : {}),
    })
    if (fields.length >= 24) break
  }
  const seen = new Set<string>()
  const buttons: { label: string; x: number; y: number; main?: boolean; area: number }[] = []
  const BTN =
    'button, [role="button"], input[type="submit"], input[type="button"], a[class*="btn"], a[class*="button"]'
  for (const el of document.querySelectorAll<HTMLElement>(BTN)) {
    const r = el.getBoundingClientRect()
    if (!shown(el, r)) continue
    const text = clip(
      el instanceof HTMLInputElement ? el.value : el.innerText || el.getAttribute('aria-label') || '',
      18,
    )
    if (!text || text.length < 1 || seen.has(text)) continue
    // 다른 것에 가려진 버튼은 빼고
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (cx < OX || cy < OY || cx > OX + W || cy > OY + H) continue
    const top = document.elementFromPoint(cx, cy)
    if (!top || !(top === el || el.contains(top) || top.contains(el))) continue
    seen.add(text)
    const main =
      (el as HTMLButtonElement).type === 'submit' ||
      /^(다음|확인|로그인|인증|완료|동의|신청|제출|계속|next|ok|continue|submit|sign in|log in)/i.test(text)
    buttons.push({
      label: text,
      x: cx / W,
      y: cy / H,
      ...(main ? { main: true } : {}),
      area: r.width * r.height,
    })
  }
  buttons.sort((a, b) => Number(Boolean(b.main)) - Number(Boolean(a.main)) || b.area - a.area)
  const actions = buttons.slice(0, 6).map(({ area: _a, ...b }) => b)
  let a: Element | null = document.activeElement
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement
  let focus: { label?: string; secret?: boolean; mode?: string; value?: string } | null = null
  if (editable(a)) {
    const secret = (a as HTMLInputElement).type === 'password'
    const value = secret
      ? undefined
      : (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement ? a.value : a.innerText).slice(
          0,
          300,
        )
    const label = labelOf(a)
    const mode = modeOf(a)
    focus = {
      ...(label ? { label } : {}),
      ...(secret ? { secret: true } : {}),
      ...(mode ? { mode } : {}),
      ...(value !== undefined ? { value } : {}),
    }
  }
  return { fields, actions, focus }
}

/** 원격으로 칸을 누른 뒤: 글자를 이어 쓰기 좋게 커서를 칸 끝으로 */
export function pageCaretEnd() {
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      const n = el.value.length
      el.setSelectionRange(n, n)
    } catch {
      // 숫자·이메일 칸은 커서를 옮길 수 없다
    }
  }
}

/** 원격 화면에서 손가락으로 끈 만큼 (가려진 창용): 그 자리의 스크롤 되는 상자부터 */
export function pageScrollBy(x: number, y: number, dy: number) {
  let el = document.elementFromPoint(x, y) as HTMLElement | null
  while (el && el !== document.body) {
    const cs = getComputedStyle(el)
    if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) {
      el.scrollBy({ top: dy, behavior: 'instant' })
      return
    }
    el = el.parentElement
  }
  window.scrollBy({ top: dy, behavior: 'instant' })
}

// ── 원격 화면 '필요한 칸만': 페이지에서 사람이 채울 칸·고를 것·누를 버튼을 뽑는다 ──
// 폰은 이걸 폰 입력칸으로 다시 그리고, 쓴 값은 pageFormFill로 진짜 칸에 넣는다.
// 비밀번호 칸의 글자는 내보내지 않는다

type FormField = {
  id: string
  kind: 'text' | 'secret' | 'number' | 'tel' | 'email' | 'choice' | 'check'
  label: string
  value?: string
  checked?: boolean
  options?: { id: string; label: string; on?: boolean }[]
  max?: number
  hint?: string
  code?: boolean
  captchaRect?: { x: number; y: number; w: number; h: number }
}

export function pageForm() {
  type Store = { els: Map<string, WeakRef<Element>>; n: number }
  const g = globalThis as unknown as { __dool2form?: Store }
  const st: Store = { els: new Map(), n: 0 }
  g.__dool2form = st
  const keep = (el: Element) => {
    const id = `f${++st.n}`
    st.els.set(id, new WeakRef(el))
    return id
  }
  const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n)
  /**
   * 다른 창(보안문자·안내 팝업·액자)에 가려진 칸인가. 가려진 칸을 폰에 보여 주면 사용자는 엉뚱한 칸을 채운다
   * (카카오 지도 보안문자가 로그인 칸 위에 떠 있는데 로그인 칸을 보여 줬다)
   */
  const covered = (el: Element) => {
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false
    const top = document.elementFromPoint(x, y)
    if (!top || top === el || el.contains(top) || top.contains(el)) return false
    if ([...((el as HTMLInputElement).labels ?? [])].some((l) => l === top || l.contains(top))) return false
    // 덮은 것이 팝업(고정 위치·대화 상자)이나 액자 안이면 가려진 것. 칸 위에 얹힌 자리 글씨는 아니다
    for (let n: Element | null = top; n && n !== document.body; n = n.parentElement) {
      if (n.contains(el)) return false
      if (
        n instanceof HTMLIFrameElement ||
        n.matches('dialog, [role="dialog"], [aria-modal="true"]') ||
        getComputedStyle(n).position === 'fixed'
      )
        return true
    }
    return false
  }
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05 && !covered(el)
  }
  const textOf = (el: Element | null | undefined) =>
    clip((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '', 40)
  const labelOf = (el: HTMLElement) => {
    const f = el as HTMLInputElement
    const by = el.getAttribute('aria-labelledby')
    const cands = [
      el.getAttribute('aria-label'),
      by
        ? by
            .split(/\s+/)
            .map((i) => document.getElementById(i)?.innerText ?? '')
            .join(' ')
        : '',
      f.labels?.[0] ? textOf(f.labels[0]) : '',
      el.closest('label') ? textOf(el.closest('label')) : '',
      el.closest('tr')?.querySelector('th') ? textOf(el.closest('tr')?.querySelector('th')) : '',
      el.closest('dd')?.previousElementSibling?.tagName === 'DT'
        ? textOf(el.closest('dd')?.previousElementSibling)
        : '',
      f.placeholder,
      el.title,
    ]
    for (const c of cands) if (c && clip(c, 40)) return clip(c, 40)
    // 바로 앞의 짧은 글 (같은 줄 제목)
    let p: Element | null = el
    for (let i = 0; i < 3 && p; i++) {
      let s = p.previousElementSibling
      while (s) {
        const t = textOf(s)
        if (t && t.length <= 20) return t
        s = s.previousElementSibling
      }
      p = p.parentElement
    }
    return clip(f.name || '', 30)
  }
  const fields: FormField[] = []
  const used = new Set<Element>()
  const CODE = /인증\s*번호|인증코드|확인\s*코드|otp|verification|auth.?code|certi.?num|보안\s*코드/i
  const CAPTCHA_INPUT = /보안\s*문자|자동\s*입력|captcha|자동등록방지|문자를\s*입력/i
  // 글자 칸
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
    if (fields.length >= 16) break
    if (
      el instanceof HTMLInputElement &&
      /^(hidden|checkbox|radio|submit|button|reset|image|file|range|color)$/.test(el.type)
    )
      continue
    if (el.disabled || el.readOnly || !visible(el)) continue
    const label = labelOf(el)
    const t = el instanceof HTMLInputElement ? el.type : 'text'
    const kind: FormField['kind'] =
      t === 'password'
        ? 'secret'
        : t === 'tel'
          ? 'tel'
          : t === 'email'
            ? 'email'
            : t === 'number'
              ? 'number'
              : 'text'
    const max = el.maxLength > 0 && el.maxLength < 200 ? el.maxLength : undefined
    const hay = `${label} ${el.getAttribute('placeholder') ?? ''} ${el.name} ${el.id}`
    const code = CODE.test(hay) && !/휴대|전화|핸드폰|phone/i.test(hay)
    used.add(el)
    fields.push({
      id: keep(el),
      kind: kind === 'text' && (el.inputMode === 'numeric' || el.inputMode === 'tel') ? 'number' : kind,
      label,
      ...(kind !== 'secret' && el.value ? { value: el.value.slice(0, 200) } : {}),
      ...(max ? { max } : {}),
      ...(el.getAttribute('placeholder') ? { hint: clip(el.getAttribute('placeholder') ?? '', 40) } : {}),
      ...(code ? { code: true } : {}),
      ...(CAPTCHA_INPUT.test(hay) ? { captchaRect: { x: 0, y: 0, w: 0, h: 0 } } : {}),
    })
  }
  // 고르기: 셀렉트
  for (const el of document.querySelectorAll<HTMLSelectElement>('select')) {
    if (fields.length >= 20 || el.disabled || !visible(el)) continue
    const options = [...el.options]
      .filter((o) => !o.disabled && o.value !== '')
      .slice(0, 30)
      .map((o) => ({
        id: `${keep(el)}:${o.index}`,
        label: clip(o.text, 30),
        ...(o.selected ? { on: true } : {}),
      }))
    if (!options.length) continue
    fields.push({ id: keep(el), kind: 'choice', label: labelOf(el), options })
  }
  // 고르기: 라디오 묶음
  const groups = new Map<string, HTMLInputElement[]>()
  for (const el of document.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
    if (el.disabled) continue
    const vis = visible(el) || (el.labels?.[0] && visible(el.labels[0]))
    if (!vis) continue
    const k = el.name || keep(el)
    groups.set(k, [...(groups.get(k) ?? []), el])
  }
  for (const [, els] of groups) {
    if (fields.length >= 20) break
    const first = els[0] as HTMLInputElement
    const box = first.closest('fieldset, tr, dl, ul, div')
    const legend = box?.querySelector('legend, th, dt, strong, h3, h4')
    fields.push({
      id: keep(first),
      kind: 'choice',
      label: clip(textOf(legend) || first.name, 30),
      options: els.map((e) => ({
        id: keep(e),
        label: clip(e.labels?.[0] ? textOf(e.labels[0]) : e.value, 30),
        ...(e.checked ? { on: true } : {}),
      })),
    })
  }
  // 고르기: 통신사 버튼 (폼 칸이 아니라 버튼으로 만든 사이트가 많다)
  const CARRIER =
    /^(SKT|KT|LG\s?U\+|LGU\+|알뜰폰|SKT\s?알뜰폰|KT\s?알뜰폰|LG\s?U\+\s?알뜰폰|SK텔레콤|LG유플러스)$/i
  const carriers: { el: HTMLElement; label: string }[] = []
  for (const el of document.querySelectorAll<HTMLElement>(
    'button, a, label, li, [role="tab"], [role="radio"], span',
  )) {
    const t = textOf(el)
    if (!CARRIER.test(t) || !visible(el)) continue
    if (carriers.some((c) => c.el.contains(el) || el.contains(c.el) || c.label === t)) continue
    carriers.push({ el, label: t })
  }
  if (carriers.length >= 2) {
    for (const c of carriers) used.add(c.el)
    fields.push({
      id: keep(carriers[0]?.el as Element),
      kind: 'choice',
      label: '통신사',
      options: carriers.map((c) => ({
        id: keep(c.el),
        label: c.label,
        ...(/\b(on|active|selected|checked|current)\b/.test(c.el.className) ||
        c.el.getAttribute('aria-selected') === 'true' ||
        c.el.getAttribute('aria-pressed') === 'true' ||
        c.el.getAttribute('aria-checked') === 'true'
          ? { on: true }
          : {}),
      })),
    })
  }
  // 체크 (약관 동의 등). 진짜 칸은 숨기고 라벨만 보이는 사이트가 많아 라벨도 본다
  let checks = 0
  for (const el of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (checks >= 8 || el.disabled) continue
    const lab = el.labels?.[0] ?? el.closest('label')
    if (!visible(el) && !(lab && visible(lab))) continue
    const label = clip(lab ? textOf(lab) : labelOf(el), 50)
    if (!label) continue
    checks++
    fields.push({ id: keep(el), kind: 'check', label, ...(el.checked ? { checked: true } : {}) })
  }
  // 보안문자 그림: 근처 글자 칸에 붙인다
  for (const img of document.querySelectorAll<HTMLImageElement | HTMLCanvasElement>('img, canvas')) {
    const hay = `${img.getAttribute('alt') ?? ''} ${img.getAttribute('src') ?? ''} ${img.id} ${img.className} ${img.getAttribute('title') ?? ''}`
    if (!/captcha|kaptcha|보안|자동입력|security.?(code|img)|simplecaptcha/i.test(hay) || !visible(img))
      continue
    const r = img.getBoundingClientRect()
    let best: { f: FormField; d: number } | undefined
    for (const f of fields) {
      if (f.kind !== 'text' && f.kind !== 'number') continue
      const el = st.els.get(f.id)?.deref()
      if (!el) continue
      const q = el.getBoundingClientRect()
      const d = Math.hypot(q.left - r.left, q.top - r.bottom)
      if (!best || d < best.d) best = { f, d }
    }
    if (best && best.d < 400) {
      best.f.captchaRect = { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }
      best.f.code = false
    }
    break
  }
  for (const f of fields) if (f.captchaRect && !f.captchaRect.w) delete f.captchaRect
  // 페이지에 나온 순서대로 (글자 칸·고르기·체크를 따로 모았으므로)
  const at = (f: FormField) => {
    const id = f.kind === 'choice' && f.options?.[0] && !st.els.get(f.id)?.deref() ? f.options[0].id : f.id
    return st.els.get(id.split(':')[0] ?? id)?.deref()
  }
  fields.sort((a, b) => {
    const x = at(a)
    const y = at(b)
    if (!x || !y || x === y) return 0
    return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  })
  // 누를 버튼
  const buttons: { id: string; label: string; main?: boolean }[] = []
  const seen = new Set<string>()
  const MAIN =
    /^(다음|확인|로그인|인증|인증번호\s*(받기|요청|전송)|본인\s*인증|완료|동의|신청|제출|계속|조회|등록|next|ok|continue|submit|sign in|log in)/i
  for (const el of document.querySelectorAll<HTMLElement>(
    'button, input[type="submit"], input[type="button"], [role="button"], a[class*="btn"], a[class*="button"]',
  )) {
    if (buttons.length >= 6 || used.has(el) || !visible(el)) continue
    if ((el as HTMLButtonElement).disabled) continue
    const label = clip(
      el instanceof HTMLInputElement ? el.value : el.innerText || el.getAttribute('aria-label') || '',
      20,
    )
    if (!label || seen.has(label) || CARRIER.test(label)) continue
    seen.add(label)
    const main = (el as HTMLButtonElement).type === 'submit' || MAIN.test(label)
    buttons.push({ id: keep(el), label, ...(main ? { main: true } : {}) })
  }
  buttons.sort((a, b) => Number(Boolean(b.main)) - Number(Boolean(a.main)))
  const h = document.querySelector('h1, h2, h3')
  const title = clip((h && visible(h) ? textOf(h) : '') || document.title, 40)
  return { title, fields, buttons, url: location.href }
}

/** 폰에서 고른 것: 진짜 칸을 화면 가운데로 옮기고 자리를 알려 준다 (보이는 화면 기준, CSS 픽셀) */
export function pageFormTarget(id: string) {
  const st = (globalThis as unknown as { __dool2form?: { els: Map<string, WeakRef<Element>> } }).__dool2form
  const [base, opt] = id.split(':')
  const el = st?.els.get(base ?? '')?.deref() as HTMLElement | undefined
  if (!el) return { ok: false as const }
  if (el instanceof HTMLSelectElement && opt !== undefined) {
    el.selectedIndex = Number(opt)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true as const, done: true }
  }
  // 숨긴 체크·라디오는 라벨을 누른다
  let target: HTMLElement = el
  if (
    el instanceof HTMLInputElement &&
    (el.type === 'checkbox' || el.type === 'radio') &&
    el.getBoundingClientRect().width < 4
  ) {
    target = (el.labels?.[0] ?? el.closest('label') ?? el) as HTMLElement
  }
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = target.getBoundingClientRect()
  const vv = window.visualViewport
  const ox = vv?.offsetLeft ?? 0
  const oy = vv?.offsetTop ?? 0
  const sc = vv?.scale ?? 1
  return {
    ok: true as const,
    done: false,
    x: (r.left + r.width / 2 - ox) * sc,
    y: (r.top + r.height / 2 - oy) * sc,
    lx: r.left + r.width / 2,
    ly: r.top + r.height / 2,
    checked: el instanceof HTMLInputElement ? el.checked : undefined,
    text: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement,
  }
}

/** 글자 칸 비우고 초점 (그다음 확장이 진짜 키 입력처럼 넣는다) */
export function pageFormFocus(id: string) {
  const st = (globalThis as unknown as { __dool2form?: { els: Map<string, WeakRef<Element>> } }).__dool2form
  const el = st?.els.get(id)?.deref()
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false
  el.focus()
  el.select?.()
  return true
}

/** 보안문자 그림 자리 (문서 기준 → 지금 보이는 화면 기준) */
export function pageScrollToDoc(x: number, y: number) {
  window.scrollTo({ left: Math.max(0, x - 40), top: Math.max(0, y - 120), behavior: 'instant' })
  return { sx: window.scrollX, sy: window.scrollY }
}

// ── 커넥터 엔진 동작 (ADR 0018): 목록 뽑기·글자 찾기 (페이지가 받은 응답 읽기는 background.ts의 capture) ──
// 커넥터(tools.json)는 데이터라서, 무엇을 뽑을지만 넘기고 실제 일은 여기 고정된 함수가 한다.

/** 한 칸을 어떻게 뽑을지 */
export interface ExtractField {
  /** 줄(항목) 안에서 찾을 선택자. 없으면 줄 자체 */
  css?: string
  /** 읽을 속성 (href·src는 전체 주소로). 없으면 보이는 글 */
  attr?: string
  /** 글을 줄로 나눠 n번째(0부터, 음수는 뒤에서) */
  line?: number
  /** 정규식. 묶음 1이 있으면 그것, 없으면 맞은 글 전체 */
  match?: string
  /** css에 맞는 것을 모두 (글 목록) */
  list?: boolean
  /** 글을 다듬거나 자르지 않고 그대로 (화면에 박힌 JSON 읽기) */
  raw?: boolean
}
export interface ExtractSpec {
  /** 목록의 줄(항목) 선택자 */
  items: string
  fields: Record<string, ExtractField>
  /** 이 안에서만 찾기 */
  within?: string
  limit?: number
  /** 보이지 않는 요소도 (script 안의 데이터 등) */
  hidden?: boolean
}
export type ExtractValue = string | string[] | null
export type ExtractResult =
  | { ok: true; rows: Record<string, ExtractValue>[]; total: number; url: string }
  | { ok: false; error: string }

/** 화면의 목록을 칸별로 뽑는다 (보이지 않는 줄은 건너뛴다). 읽기만 하고 아무것도 누르지 않는다 */
export function pageExtract(spec: ExtractSpec): ExtractResult {
  const norm = (s: string) =>
    s
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n[\s]*/g, '\n')
      .trim()
  const q = (root: ParentNode, sel: string, all: boolean): Element[] => {
    try {
      return all
        ? Array.from(root.querySelectorAll(sel))
        : [root.querySelector(sel)].filter((x) => x !== null)
    } catch {
      throw new Error(`선택자가 틀렸어요: ${sel}`)
    }
  }
  try {
    let root: ParentNode = document
    if (spec.within) {
      const w = q(document, spec.within, false)[0]
      if (!w) return { ok: false, error: `"${spec.within}" 영역이 화면에 없어요` }
      root = w
    }
    const res: Record<string, RegExp | undefined> = {}
    for (const [k, f] of Object.entries(spec.fields)) {
      try {
        res[k] = f.match ? new RegExp(f.match) : undefined
      } catch {
        return { ok: false, error: `${k}의 정규식이 틀렸어요: ${f.match}` }
      }
    }
    const read = (el: Element, f: ExtractField, re: RegExp | undefined): string | null => {
      let v: string | null
      if (f.attr) {
        v = el.getAttribute(f.attr)
        if (v !== null && (f.attr === 'href' || f.attr === 'src')) {
          try {
            v = new URL(v, location.href).href
          } catch {}
        }
      } else v = f.raw ? el.textContent : ((el as HTMLElement).innerText ?? el.textContent)
      if (v === null) return null
      if (f.raw) return v.slice(0, 3_000_000)
      v = norm(v)
      if (f.line !== undefined) v = v.split('\n').filter(Boolean).at(f.line) ?? null
      if (v !== null && re) {
        const m = re.exec(v)
        v = m ? (m[1] ?? m[0]).trim() : null
      }
      return v === null ? null : v.slice(0, 500)
    }
    const items = q(root, spec.items, true)
    const limit = Math.min(Math.max(spec.limit ?? 30, 1), 200)
    const rows: Record<string, ExtractValue>[] = []
    for (const el of items) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const shown = cs.display === 'contents' || r.width > 0 || r.height > 0
      if (!spec.hidden && (!shown || cs.visibility === 'hidden')) continue
      const row: Record<string, ExtractValue> = {}
      for (const [k, f] of Object.entries(spec.fields)) {
        const targets = f.css ? q(el, f.css, Boolean(f.list)) : [el]
        if (f.list) {
          row[k] = targets.map((t) => read(t, f, res[k])).filter((x): x is string => Boolean(x))
          continue
        }
        const t = targets[0]
        row[k] = t ? read(t, f, res[k]) : null
      }
      rows.push(row)
      if (rows.length >= limit) break
    }
    return { ok: true, rows, total: items.length, url: location.href }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 화면 글에 이 말들이 있는지 (정규식, 여러 개). 기다리기·화면 확인에 쓴다 */
export function pageFind(patterns: Record<string, string>): {
  url: string
  title: string
  found: Record<string, string | null>
} {
  const text = (document.body?.innerText ?? '').replace(/[ \t ]+/g, ' ')
  const found: Record<string, string | null> = {}
  for (const [k, p] of Object.entries(patterns)) {
    let m: RegExpExecArray | null = null
    try {
      m = new RegExp(p).exec(text)
    } catch {}
    found[k] = m ? (m[1] ?? m[0]).slice(0, 200) : null
  }
  return { url: location.href, title: document.title, found }
}

/**
 * 두리가 누르거나 입력하는 자리를 페이지 위에 잠깐 보여 준다 (일하는 화면·Chrome에서 무엇을 하는지 보이게).
 * 마우스 입력을 받지 않고(pointer-events: none) 읽기에도 빠진다(aria-hidden, body 밖). 2.5초 뒤 사라진다
 */
export function pageCursor(x: number, y: number, label: string) {
  const TAG = 'dool2-cursor'
  type Host = HTMLElement & { __dool2Hide?: ReturnType<typeof setTimeout>; __dool2Label?: HTMLElement }
  let host = document.querySelector(TAG) as Host | null
  if (!host) {
    host = document.createElement(TAG) as Host
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText =
      'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform .18s ease-out,opacity .3s;opacity:0;contain:layout'
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = `<svg width="22" height="24" viewBox="0 0 22 24" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))"><path d="M2 2 L2 19 L7 14.5 L10.5 22 L13.5 20.6 L10 13.3 L16.5 13.3 Z" fill="#4cc98f" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span style="position:absolute;left:20px;top:18px;white-space:nowrap;font:600 12px/1.2 -apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#0b2a1c;background:#4cc98f;border-radius:10px;padding:4px 8px;box-shadow:0 1px 4px rgba(0,0,0,.25)"></span>`
    host.__dool2Label = root.querySelector('span') as HTMLElement
    document.documentElement.append(host)
  }
  if (host.__dool2Label) host.__dool2Label.textContent = label
  host.style.transform = `translate(${Math.round(x) - 2}px, ${Math.round(y) - 2}px)`
  host.style.opacity = '1'
  clearTimeout(host.__dool2Hide)
  const h = host
  host.__dool2Hide = setTimeout(() => {
    h.style.opacity = '0'
  }, 2500)
}

/** 액자(iframe) 속 화면이 페이지의 어디에 그려지는지: 주소가 같은 액자의 안쪽 상자 왼쪽 위 (없으면 undefined).
 *  다른 주소의 액자는 Chrome이 따로 그려서 디버거의 액자 목록으로는 자리를 못 찾을 때가 있다 */
export function pageFrameBox(url: string): { x: number; y: number } | undefined {
  const norm = (u: string) => {
    try {
      const x = new URL(u, location.href)
      return `${x.origin}${x.pathname}`
    } catch {
      return u
    }
  }
  const want = norm(url)
  const frames = Array.from(document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[]
  const hit = frames.find((f) => f.src === url) ?? frames.find((f) => norm(f.src) === want)
  if (!hit) return undefined
  const r = hit.getBoundingClientRect()
  const cs = getComputedStyle(hit)
  return {
    x: r.left + hit.clientLeft + Number.parseFloat(cs.paddingLeft || '0'),
    y: r.top + hit.clientTop + Number.parseFloat(cs.paddingTop || '0'),
  }
}
