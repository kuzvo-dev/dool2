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
  /** 이 문서 안의 액자(iframe) 상자들 (액자 자리 찾기·화면 순서·글 속 [액자] 자리 표시에 쓴다) */
  kids?: KidBox[]
  /** 이 문서(액자) 자신의 크기와, 같은 주소라 바로 재 본 바깥 상자 */
  self?: FrameSelf
  /** 표시 번호가 대역 끝에 가까워 처음부터 새로 매겼다 (전에 받은 표시는 다른 것을 가리킬 수 있다) */
  renumbered?: boolean
  /** 대역(1만 개)이 다 차서 표시를 못 붙인 누를 것 수 */
  refsCapped?: number
}

/** 문서 안 액자 하나 (그 문서의 보이는 화면 기준, 안쪽 상자) */
export interface KidBox {
  /** 액자 주소 (src를 전체 주소로. 없으면 '') */
  src: string
  srcdoc: boolean
  name: string
  x: number
  y: number
  w: number
  h: number
  /** 크기가 있고 숨지 않았다 */
  shown: boolean
  /** 글 속 자리 표시 번호 (읽은 글에 보이지 않는 구분 문자 U+2063으로 감싼 F{n}이 들어 있다) */
  marker?: number
}

/** 액자 문서 자신: 크기, 같은 주소면 바깥 문서에서 본 자기 상자(frameElement) */
export interface FrameSelf {
  w: number
  h: number
  owner?: { x: number; y: number; w: number; h: number }
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
    /** 이 문서의 표시 대역 시작 (액자 n → n*10000). 글자로 표시 붙이기(pageMarkText)도 같은 대역을 쓴다 */
    base?: number
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
  st.base = base
  // 표시 번호는 문서마다 대역 하나(1만 개) 안에서만 매긴다. 넘치면 다음 액자 대역(e10000…)으로 번져
  // 본체가 다른 액자의 표시로 알아듣는다. 대역의 7할을 넘었으면 읽기 시작 때 처음부터 새로 매기고(알린다),
  // 한 번 읽는 사이에 대역이 다 차면 더 붙이지 않고 몇 개를 못 붙였는지 알린다
  const SPAN = 10_000
  let renumbered = false
  let capped = 0
  if (st.seq > SPAN * 0.7) {
    st.seq = 0
    st.ids = new WeakMap()
    renumbered = true
  }
  const refFor = (el: Element): string | undefined => {
    const had = st.ids.get(el)
    if (had) return had
    if (st.seq >= SPAN - 1) {
      capped++
      return undefined
    }
    const ref = `e${base + ++st.seq}`
    st.ids.set(el, ref)
    return ref
  }
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
    // 편집기가 그려 둔 빈 자리 안내 글("제목"·"본문을 입력하세요"): 글 칸(input·contenteditable)이 아니어도 눌러서 쓰는 자리다.
    // 네이버 블로그(SmartEditor ONE)는 제목·본문을 그림처럼 그려 두고, 누르면 숨은 액자 속 칸으로 글을 받는다.
    // 표시가 없으면 AI가 넣을 곳을 몰라 글을 못 넣었다 (실측 11-21). 칸 옆에 겹쳐 둔 안내 글(진짜 칸이 곁에 있음)은 뺀다
    if (editorPlaceholder(el)) return '입력칸'
    if ((el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') && !wrapsControls(el))
      return '버튼'
    // React·Vue가 클릭 처리기만 붙인 상자 (휴대폰용 사이트의 목록 줄·가게 카드): pageMarkTaps가 표시해 둔다
    if (el.hasAttribute(TAP) && !wrapsControls(el)) return '버튼'
    // 손가락 커서만 준 글자 상자 ("카카오로 로그인" div 등): 짧은 글이면 버튼으로 본다
    if (pointerBox(el)) return '버튼'
    return undefined
  }

  /** 편집기의 빈 자리 안내 글: 이름(class)에 placeholder가 든 짧은 글 상자. 곁(부모 안)에 진짜 칸·버튼이 있으면 아니다 */
  const editorPlaceholder = (el: Element): boolean => {
    if (!['SPAN', 'DIV', 'P'].includes(el.tagName)) return false
    const cls = el.getAttribute('class') ?? ''
    if (!/(^|[\s_-])placeholder/i.test(cls)) return false
    if (el.parentElement?.isContentEditable || el.children.length > 2) return false
    const t = (el as HTMLElement).innerText?.trim() ?? ''
    if (!t || t.length > 80) return false
    const parent = el.parentElement
    return !wrapsControls(el) && !(parent && wrapsControls(parent))
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

  /** 요소 바로 뒤(또는 요소만 감싼 부모 바로 뒤)에 붙은 한 줄짜리 짧은 글자. 다른 누를 것이 들어 있으면 쓰지 않는다 */
  const captionAfter = (el: Element): string => {
    let cur: Element | null = el
    for (let i = 0; i < 2 && cur; i++) {
      let sib: ChildNode | null = cur.nextSibling
      while (sib && sib.nodeType === Node.TEXT_NODE && !sib.textContent?.trim()) sib = sib.nextSibling
      if (sib) {
        const isEl = sib.nodeType === Node.ELEMENT_NODE
        if (isEl && (sib as Element).matches('a,button,input,select,textarea,[role="button"]')) return ''
        if (isEl && (sib as Element).querySelector('a,button,input,select,textarea,[role="button"]'))
          return ''
        const raw = (isEl ? (sib as HTMLElement).innerText : sib.textContent) ?? ''
        const t = raw.trim()
        // 이름다운 글자만 (수량 칸 "0"·가격·기호는 이름이 아니다)
        if (
          t &&
          t.length <= 20 &&
          !t.includes('\n') &&
          /[가-힣A-Za-z]{2,}/.test(t) &&
          !/\d{2,}|[₩원]$/.test(t)
        )
          return clean(t)
        return ''
      }
      // 요소가 부모의 유일한 자식이면 부모 뒤를 본다 (<li><a><img></a></li><li>…</li> 말고 <div><a><img></a></div><span>이름</span>)
      const parent: Element | null = cur.parentElement
      if (!parent || parent.children.length !== 1) return ''
      cur = parent
    }
    return ''
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
    // 그림만 있는 버튼·링크 바로 뒤에 붙은 짧은 글자(아이콘 아래 이름)를 이름으로 본다. 그림 설명(alt)은 틀릴 때가 많다
    // (실측 홈택스 간편인증: 앱 아이콘 alt가 모두 "페이스북 로그인"이거나 비어 있어 카카오톡 대신 카카오뱅크를 눌렀다)
    const cap = captionAfter(el)
    if (cap) return cap
    const img = el.querySelector('img[alt]')
    const own = clean(
      el.getAttribute('placeholder') ??
        el.getAttribute('title') ??
        img?.getAttribute('alt') ??
        el.getAttribute('name'),
    )
    if (own) return own
    // 여기부터는 화면에 적힌 이름이 아니라 두리가 짐작한 이름이다: 표시에 (추정)을 달아 AI가 화면과 견줘 보게 한다
    const quantity = stepperName(el)
    if (quantity) return quantity
    const icon = iconName(el)
    if (icon) guessed = true
    return icon
  }
  /** 이번 표시의 이름이 짐작(아이콘 속성)인지 */
  let guessed = false

  /**
   * 수량 고르기: 한 상자 안에 이름 없는 버튼 둘과 숫자 하나만 있을 때만 앞은 줄이기, 뒤는 늘리기
   * (캐치테이블 추가 상품 등). 다른 글·버튼이 섞인 상자는 짐작하지 않는다
   */
  const stepperName = (el: Element): string => {
    const BTN = 'button,[role=button],a[href]'
    let box: Element | null = el.parentElement
    for (let i = 0; box && i < 3; i++, box = box.parentElement) {
      const btns = Array.from(box.querySelectorAll(BTN)).filter((b) => !b.closest('[aria-hidden="true"]'))
      if (btns.length < 2) continue
      if (btns.length !== 2) return ''
      const named = btns.some(
        (b) =>
          b.getAttribute('aria-label') || (b as HTMLElement).innerText?.trim() || b.getAttribute('title'),
      )
      if (named) return ''
      if (!/^\d{1,3}$/.test((box as HTMLElement).innerText?.replace(/\s+/g, '') ?? '')) return ''
      return btns[0] === el ? '수량 줄이기' : '수량 늘리기'
    }
    return ''
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
    // 글 없는 간편 로그인 아이콘 (실측 알라딘: <a class="naver" href="javascript:goNaverLogin()">)
    [/(?:^|[^a-z])kakao(?:[^a-z]|$)/i, '카카오 로그인'],
    [/(?:^|[^a-z])naver(?:[^a-z]|$)/i, '네이버 로그인'],
    [/(?:^|[^a-z])google(?:[^a-z]|$)/i, '구글 로그인'],
    [/(?:^|[^a-z])apple(?:[^a-z]|$)/i, 'Apple 로그인'],
    [/(?:^|[^a-z])(?:facebook|fb)(?:[^a-z]|$)/i, '페이스북 로그인'],
    [/(?:^|[^a-z])payco(?:[^a-z]|$)/i, '페이코 로그인'],
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
      // 파일 칸: 글자를 넣는 칸이 아니라 browser_upload로 파일을 넣는다
      if (el.type === 'file') {
        const names = Array.from(el.files ?? [], (f) => f.name).join(', ')
        return ` 파일 칸${names ? ` 고른 파일="${clean(names, 80)}"` : ''}`
      }
      if (el.value && !['button', 'submit', 'reset', 'image'].includes(el.type))
        return ` 값="${clean(el.value, 60)}"`
      return ''
    }
    if (el instanceof HTMLTextAreaElement && el.value) return ` 값="${clean(el.value, 60)}"`
    if (el instanceof HTMLSelectElement) return ` 값="${clean(el.selectedOptions[0]?.textContent, 40)}"`
    if (
      el.getAttribute('aria-checked') === 'true' ||
      el.getAttribute('aria-selected') === 'true' ||
      el.getAttribute('aria-pressed') === 'true'
    )
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

  /** 이번 읽기에서 표시를 붙인 것 (빠진 입력칸을 따로 모을 때 견준다) */
  const shownNow = new Set<Element>()
  /** 이 문서 안의 액자들: 확장이 액자마다 화면 자리를 맞춰 보고(중첩 액자 좌표), 화면 순서로 늘어놓는다 */
  const kids: KidBox[] = []
  const kidOf = (f: HTMLIFrameElement): KidBox => {
    const r = f.getBoundingClientRect()
    const cs = getComputedStyle(f)
    const x = r.left + f.clientLeft + (Number.parseFloat(cs.paddingLeft) || 0)
    const y = r.top + f.clientTop + (Number.parseFloat(cs.paddingTop) || 0)
    const w =
      f.clientWidth - (Number.parseFloat(cs.paddingLeft) || 0) - (Number.parseFloat(cs.paddingRight) || 0)
    const h =
      f.clientHeight - (Number.parseFloat(cs.paddingTop) || 0) - (Number.parseFloat(cs.paddingBottom) || 0)
    let src = ''
    try {
      src = f.getAttribute('src') ? new URL(f.getAttribute('src') ?? '', location.href).href : ''
    } catch {}
    return {
      src,
      srcdoc: f.hasAttribute('srcdoc'),
      name: f.name || f.id || '',
      x,
      y,
      w,
      h,
      shown: w > 2 && h > 2 && f.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
    }
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
    // 액자 자리: 글 속 그 자리에 표시를 남긴다 (확장이 [액자 f3]으로 바꾼다. 액자 안 글은 아래에 따로 붙는다)
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      const k = kidOf(el as HTMLIFrameElement)
      if (k.shown) {
        k.marker = kids.length
        cur += ` \u2063F${k.marker}\u2063 `
      }
      kids.push(k)
      return
    }
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
      shownNow.add(el)
      const ref = refFor(el)
      if (ref) {
        st.refs.set(ref, new WeakRef(el))
        ctx.set(ref, ctxOf(el))
      }
      // 클릭 처리기만 붙은 긴 상자 (글 단락·카드 전체): 표시만 붙이고 안의 글은 그대로 읽는다
      const long = el.hasAttribute(TAP) && ((el as HTMLElement).innerText?.trim().length ?? 0) > LONG_TAP
      guessed = false
      const name = long ? clean((el as HTMLElement).innerText, 30) : nameOf(el)
      const label = `${role}${name ? ` "${name}"` : ''}${guessed ? ' (추정)' : ''}${extra(el)}`
      // 대역이 다 차 표시를 못 붙인 것도 글로는 보이게 (누를 수는 없다고 알린다)
      cur += ref ? ` [${ref} ${label}] ` : ` (${label}) `
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
  // 화면에 보이는데 읽기에서 빠진 입력칸: 사이트가 칸을 감싼 상자에 aria-hidden을 잘못 붙이면 통째로 빠진다
  // (실측 금융인증서 창 4user.yeskey.or.kr: "휴대폰번호를 입력해주세요" 아래 칸이 안 보여 두리가 PC 화면을 넘겼다)
  if (budget > 0 && !scope.from) {
    const missed: string[] = []
    for (const el of document.querySelectorAll('input:not([type=hidden]),textarea,select')) {
      if (shownNow.has(el) || missed.length >= 8) continue
      const inp = el as HTMLInputElement
      if (inp.disabled || inp.readOnly) continue
      if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(inp.type)) continue
      const r = el.getBoundingClientRect()
      if (
        r.width < 20 ||
        r.height < 10 ||
        !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      )
        continue
      const role = interactiveRole(el)
      if (!role) continue
      const ref = refFor(el)
      if (!ref) continue
      st.refs.set(ref, new WeakRef(el))
      ctx.set(ref, ctxOf(el))
      const box = el.closest('label, div, li, p, td')
      const near = clean((box as HTMLElement | null)?.innerText, 30)
      // 이름이 '예) 010-…' 같은 보기뿐이면 칸 위의 짧은 글(휴대폰번호)을 앞에 붙인다
      const own = nameOf(el) || el.getAttribute('placeholder') || ''
      const name = near && !own.includes(near) && near.length <= 20 ? `${near} ${own}`.trim() : own || near
      missed.push(`[${ref} ${role}${name ? ` "${clean(name, 40)}"` : ''}${extra(el)}]`)
    }
    if (missed.length) lines.push(`(화면에 보이는 칸) ${missed.join(' ')}`)
  }

  // 읽다가 글 한도로 멈췄거나 숨은 상자 속이라 못 지나간 액자도 자리 맞추기에는 넣는다 (글 속 표시는 없다)
  const met = new Set(kids.map((k) => `${k.src}|${k.x}|${k.y}|${k.w}|${k.h}`))
  for (const f of Array.from(document.querySelectorAll('iframe, frame')).slice(0, 60)) {
    const k = kidOf(f as HTMLIFrameElement)
    if (!met.has(`${k.src}|${k.x}|${k.y}|${k.w}|${k.h}`)) kids.push(k)
  }
  // 같은 주소의 액자면 바깥 문서에서 본 자기 상자를 바로 잴 수 있다 (about:blank·srcdoc 결제 액자 포함)
  let owner: FrameSelf['owner']
  try {
    const fe = window.frameElement as HTMLIFrameElement | null
    if (fe) {
      const r = fe.getBoundingClientRect()
      owner = { x: r.left + fe.clientLeft, y: r.top + fe.clientTop, w: fe.clientWidth, h: fe.clientHeight }
    }
  } catch {}
  const self: FrameSelf = { w: window.innerWidth, h: window.innerHeight, ...(owner ? { owner } : {}) }

  let text = lines.join('\n')
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
    kids,
    self,
    ...(renumbered ? { renumbered } : {}),
    ...(capped ? { refsCapped: capped } : {}),
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
  /** 덮은 것이 다른 버튼·링크다 (force로 불렀을 때만 여기까지 온다: 마우스 대신 그 요소를 직접 누른다) */
  coveredByControl?: boolean
  /** force로 불렀는데 둘레 글이 읽을 때와 달랐다 (알리기만 한다) */
  ctxChanged?: { was: string; now: string }
  /** 굴려도 보이는 화면 밖이다 (화면 아래에 고정된 창 등). y는 실제 자리(잘리지 않은 값) */
  outside?: boolean
  /** type: 글 칸(input·textarea·contenteditable)이 아니다 — 편집기가 그린 자리라 눌러서 초점을 줘야 한다 */
  drawn?: boolean
  /** type(drawn): 안내 글이 아닌 글이 이미 들어 있다 (끝에 이어 쓴다) */
  filled?: boolean
  /** 요소 상자 아래 끝 (이 문서 화면 기준) */
  bottom?: number
}

/**
 * 화면에 보이는 글자로 누를 곳 찾기: 그 글자를 가진 가장 작은 보이는 요소에 표시(ref)를 붙인다.
 * 가게 카드처럼 링크·버튼·손가락 커서 없이 사이트 스크립트로만 눌리는 상자가 있다 (캐치테이블 검색 결과).
 * 글자 요소를 누르면 클릭이 카드까지 올라가 카드가 눌린다
 */
export function pageMarkText(
  text: string,
): { ok: true; ref: string; name: string } | { ok: false; error: string } {
  type State = {
    refs: Map<string, WeakRef<Element>>
    ids: WeakMap<Element, string>
    seq: number
    base?: number
  }
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
    // 표시 대역(1만 개) 안에서만 매긴다 (넘치면 다른 액자의 표시로 읽힌다)
    if (st.seq >= 9_999) return { ok: false, error: '표시 번호가 다 찼어요. 페이지를 다시 읽어 주세요' }
    ref = `e${(st.base ?? 0) + ++st.seq}`
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
export function pageLocate(
  ref: string,
  mode: LocateMode,
  force = false,
): LocateResult | { ok: false; error: string } {
  type State = {
    refs: Map<string, WeakRef<Element>>
    ctx?: Map<string, string>
    ctxOf?: (el: Element, max?: number) => string
  }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  if (!el || !el.isConnected)
    return { ok: false, error: `${ref}를 찾을 수 없어요. 화면이 바뀌었을 수 있으니 다시 읽어 주세요` }
  if (mode === 'type' && el instanceof HTMLInputElement && el.type === 'file')
    return { ok: false, error: `${ref}는 파일 칸이에요. 글자 대신 browser_upload로 PC 파일을 넣어요` }
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
  // 판단은 AI가 한다: 읽을 때·지금 글을 함께 알려 주고, 같은 것이라고 보면 force로 다시 부르게 한다
  const was = st?.ctx?.get(ref)
  let ctxChanged: { was: string; now: string } | undefined
  if (mode !== 'type' && was !== undefined && st?.ctxOf) {
    const now = st.ctxOf(el, 900)
    if (!now.endsWith(was)) {
      const have = new Set(now.split(' '))
      const words = was.split(' ').filter((x) => x.length > 1)
      const gone = words.filter((x) => !have.has(x)).length
      const goneNear = words.slice(-6).filter((x) => !have.has(x)).length
      if ((gone >= 3 && gone >= words.length * 0.2) || goneNear >= 2) {
        ctxChanged = { was: was.slice(-80), now: now.slice(-80) }
        if (!force)
          return {
            ok: false,
            error: `${ref} 둘레 글이 읽을 때와 달라졌어요 (목록이 다시 그려졌을 수 있어요). 읽을 때: "…${ctxChanged.was}" / 지금: "…${ctxChanged.now}". 다시 읽고 골라 주세요. 같은 것이 맞으면 force: true로 누를 수 있어요`,
          }
      }
    }
  }
  const r = box()
  if (r.width === 0 || r.height === 0) return { ok: false, error: `${ref}가 화면에 보이지 않아요` }
  // 굴려도 화면 밖이면(아래에 고정된 창) 실제 자리를 알려 부르는 쪽이 화면을 늘려 다시 재게 한다.
  // 일부만 보이면 보이는 부분의 가운데를 누른다 (화면 끝으로 자른 자리는 다른 것일 수 있다)
  const W = window.innerWidth
  const H = window.innerHeight
  const outside = r.bottom <= 0 || r.top >= H || r.right <= 0 || r.left >= W
  const x = outside
    ? r.left + r.width / 2
    : Math.min(Math.max((Math.max(r.left, 0) + Math.min(r.right, W)) / 2, 1), W - 1)
  const y = outside
    ? r.top + r.height / 2
    : Math.min(Math.max((Math.max(r.top, 0) + Math.min(r.bottom, H)) / 2, 1), H - 1)
  // 그 자리의 맨 위 요소: 열린 shadow DOM 안까지 내려가서 본다 (문서에서 재면 그림자 주인(host)이 나와 덮인 것으로 보였다)
  let top: Element | null = outside ? null : document.elementFromPoint(x, y)
  for (let i = 0; top?.shadowRoot && i < 8; i++) {
    const inner = top.shadowRoot.elementFromPoint(x, y)
    if (!inner || inner === top) break
    top = inner
  }
  /** a가 b를 품는지 (shadow DOM 경계를 넘어 위로) */
  const holds = (a: Element, b: Node | null): boolean => {
    for (let n: Node | null = b; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null)
      if (n === a) return true
    return false
  }
  let coveredBy: string | undefined
  let coveredByControl = false
  if (top && !holds(el, top) && !(label && holds(label, top)) && top.closest('label')?.control !== el) {
    coveredBy = ((top as HTMLElement).innerText || top.tagName).replace(/\s+/g, ' ').trim().slice(0, 60)
    // 덮은 것이 다른 버튼·링크면 누르지 않는다: 그 자리를 누르면 덮은 버튼이 눌린다
    // (캐치테이블: 결제 방식 화면의 '다음' 위에 '이 방식으로 예약' 팝업이 떠 있었다).
    // force면 마우스 대신 그 요소를 직접(키보드·스크립트) 누르게 알린다
    const other = top.closest(
      'a[href],button,input,select,textarea,label,[role=button],[role=link],[role=radio],[role=checkbox],[onclick],[data-dool2-tap]',
    )
    if (other && other !== el && !holds(other, el)) {
      const name = ((other as HTMLElement).innerText || other.getAttribute('aria-label') || other.tagName)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40)
      if (!force)
        return {
          ok: false,
          error: `${ref} 자리를 다른 버튼 "${name}"이(가) 덮고 있어서 누르지 않았어요. 팝업이면 먼저 닫고(닫기·X) 다시 읽어 주세요. 덮인 채로 그 요소를 직접 누르려면 force: true`,
        }
      coveredByControl = true
      coveredBy = name
    }
  }
  const h = el as HTMLElement
  let focused: boolean | undefined
  let drawnBox = false
  let filled = false
  if (mode === 'type') {
    // 버튼·링크는 아니다: 입력하려다 눌러 버리면 안 된다 (발행·보내기 버튼은 승인 카드로만 누른다)
    drawnBox =
      !(
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        h.isContentEditable
      ) &&
      !el.closest(
        'a[href],button,summary,label,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[onclick]',
      )
    if (drawnBox) {
      // 편집기가 그린 자리: 스크립트 초점은 주지 않는다 (누를 때 편집기가 자기 칸에 초점을 준다)
      filled =
        !/(^|[\s_-])placeholder/i.test(el.getAttribute('class') ?? '') &&
        (h.innerText ?? '').replace(/[\u200b\ufeff]/g, '').trim() !== ''
    } else h.focus()
    focused = document.activeElement === el
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
    ...(coveredByControl ? { coveredByControl } : {}),
    ...(ctxChanged ? { ctxChanged } : {}),
    ...(outside ? { outside } : {}),
    ...(drawnBox ? { drawn: true, filled } : {}),
    bottom: r.bottom,
  }
}

/** 넣은 글이 이 문서 화면 글에 보이나 (편집기가 그린 자리에 넣은 뒤 확인). 빈칸·폭 없는 글자는 무시한다 */
export function pageShowsText(probe: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/[\u200b\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  const want = norm(probe)
  if (!want) return true
  return norm(document.body?.innerText ?? '').includes(want)
}

/**
 * 펼침 목록의 고를 것들. 진짜 select는 그대로 읽고, 꾸민 목록(role=combobox: 쿠팡 결제 화면의 카드·할부)은
 * 근처에 숨은 select가 있으면 그것을, 없으면 눌러 열어 새로 보인 항목을 읽은 뒤 다시 닫는다.
 * 못 읽으면 options 없이 왜 못 읽었는지(why: 요소 모양)를 돌려준다 (일한 기록에 남겨 고칠 때 쓴다)
 */
export async function pageSelectOptions(
  ref: string,
  opened = false,
): Promise<{ options?: { label: string; selected: boolean }[]; why?: string }> {
  type State = { refs: Map<string, WeakRef<Element>>; shownBefore?: Set<Element> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  const norm = (x: string | null | undefined) => (x ?? '').replace(/\s+/g, ' ').trim()
  const shownEl = (e: Element) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'
  }
  const press = (t: Element) => {
    // pointer*는 PointerEvent로 (요즘 목록 부품(Radix 등)은 MouseEvent로 온 pointerdown을 무시한다. 실측 무신사·오늘의집)
    const r = t.getBoundingClientRect()
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }
    for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      t.dispatchEvent(
        k.startsWith('pointer')
          ? new PointerEvent(k, {
              ...at,
              bubbles: true,
              cancelable: true,
              view: window,
              pointerType: 'mouse',
              isPrimary: true,
              pointerId: 1,
              buttons: k === 'pointerdown' ? 1 : 0,
            })
          : new MouseEvent(k, {
              ...at,
              bubbles: true,
              cancelable: true,
              view: window,
              buttons: k === 'mousedown' ? 1 : 0,
            }),
      )
  }
  /**
   * 목록 열기. 상자를 눌러 보고, 안 열리면 감싼 칸(…control)을 누르고, 그래도 안 열리면 초점을 주고 ↓ 키
   * (실측 쿠팡: react-select. 보이는 상자는 감싼 칸이고 role=combobox는 숨은 입력칸이라 그 자체를 눌러서는 안 열린다)
   */
  const openList = async (box: HTMLElement) => {
    const opened = () => box.getAttribute('aria-expanded') === 'true'
    const wait = () => new Promise((r) => setTimeout(r, 350))
    press(box)
    await wait()
    if (opened()) return
    const control = box.closest('[class*="control"],[class*="Control"]') ?? box.parentElement?.parentElement
    if (control) {
      press(control)
      await wait()
      if (opened()) return
    }
    box.focus()
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }),
    )
    await wait()
  }
  const fromSelect = (sel: HTMLSelectElement) =>
    [...sel.options]
      .filter((o) => !o.disabled && norm(o.textContent))
      .slice(0, 40)
      .map((o) => ({ label: norm(o.textContent).slice(0, 60), selected: o.selected }))
  if (el instanceof HTMLSelectElement) return { options: fromSelect(el) }
  if (!el || !(el instanceof HTMLElement)) return { why: 'no-element' }
  const shape = (e: Element) =>
    `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${[...e.attributes]
      .filter((a) => /^(role|aria-|class|type|name|data-)/.test(a.name))
      .map((a) => `[${a.name}=${a.value.slice(0, 40)}]`)
      .join('')}`
  // 꾸민 목록 뒤에 숨은 진짜 select (모양만 바꾼 목록)
  let up: Element | null = el
  for (let i = 0; i < 3 && up; i++, up = up.parentElement) {
    const sel = up.querySelector('select')
    if (sel && sel.options.length >= 2) return { options: fromSelect(sel) }
  }
  // opened: 본체가 진짜 마우스로 이미 열었다 (누르기 전 보이던 것은 pageRememberShown이 남겨 둠)
  const before =
    opened && st?.shownBefore
      ? st.shownBefore
      : new Set([...document.querySelectorAll('body *')].filter(shownEl))
  const wasOpen = !opened && el.getAttribute('aria-expanded') === 'true'
  if (!wasOpen && !opened) await openList(el)
  const ids = `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`
    .trim()
    .split(/\s+/)
  let items: Element[] = []
  for (const id of ids) {
    const list = id ? document.getElementById(id) : null
    if (list) items = [...list.querySelectorAll('[role=option],li')].filter(shownEl)
    if (items.length) break
  }
  const fresh = [...document.querySelectorAll('body *')].filter((e) => shownEl(e) && !before.has(e))
  if (items.length < 2)
    items = fresh.filter((e) => e.matches('[role=option],li,[role=menuitem],[role=menuitemradio]'))
  // 같은 모양으로 늘어선 줄 묶음 (줄마다 "S" + "내일 도착보장"처럼 글이 여럿이면 줄 전체가 항목. 실측 무신사)
  if (items.length < 2) {
    let rows: Element[] = []
    for (const e of fresh) {
      const kids = [...e.children].filter((c) => {
        const t = norm(c.textContent)
        return shownEl(c) && !!t && t.length <= 80
      })
      if (kids.length >= 2 && kids.length > rows.length && kids.every((k) => k.tagName === kids[0]?.tagName))
        rows = kids
    }
    if (rows.length >= 2) items = rows
  }
  // 그래도 없으면 새로 보인 글 조각 중 가장 안쪽(글만 있는 것)
  if (items.length < 2)
    items = fresh.filter((e) => {
      const t = norm(e.textContent)
      return !!t && t.length <= 60 && ![...e.children].some((c) => norm(c.textContent))
    })
  items = items.filter((e) => !items.some((o) => o !== e && e.contains(o)))
  const now = norm(el.getAttribute('aria-valuetext') || el.textContent || el.nextElementSibling?.textContent)
  const options = items.slice(0, 40).map((o) => {
    // innerText: 줄 안의 글 조각 사이를 띄운다 ("S내일 도착" → "S 내일 도착")
    const label = norm((o as HTMLElement).innerText || o.textContent).slice(0, 60)
    const selected =
      o.getAttribute('aria-selected') === 'true' ||
      /(?:^|[\s_-])(?:selected|active|is-selected|on|checked)(?:$|[\s_-])/i.test(o.className) ||
      (!!now && label === now)
    return { label, selected }
  })
  // 연 목록은 닫아 둔다
  if (!wasOpen && (el.getAttribute('aria-expanded') === 'true' || items.some(shownEl))) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((r) => setTimeout(r, 150))
    if (el.getAttribute('aria-expanded') === 'true' || items.some(shownEl)) press(el)
    await new Promise((r) => setTimeout(r, 150))
  }
  if (options.length >= 2) return { options: options.filter((o) => o.label) }
  const sample = fresh
    .slice(0, 6)
    .map((e) => `${shape(e)}"${norm(e.textContent).slice(0, 20)}"`)
    .join(' | ')
  return {
    why: `${shape(el)} < ${el.parentElement ? shape(el.parentElement) : ''} · 연 뒤 expanded=${el.getAttribute('aria-expanded')} 새로 보인 요소 ${fresh.length}개: ${sample}`.slice(
      0,
      900,
    ),
  }
}

/** 진짜 마우스로 목록을 열기 전에 지금 보이는 것을 남겨 둔다 (연 뒤 새로 보인 것만 목록으로 읽으려고) */
export function pageRememberShown(): number {
  type State = { refs: Map<string, WeakRef<Element>>; shownBefore?: Set<Element> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  if (!st) return 0
  st.shownBefore = new Set(
    [...document.querySelectorAll('body *')].filter((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }),
  )
  return st.shownBefore.size
}

/**
 * 연 목록에서 글자가 같은 항목의 화면 자리 (본체가 진짜 마우스로 누른다).
 * 새로 보인 것 중 가장 안쪽을 먼저, 같은 글이 없으면 그 글로 시작하는 것이 하나뿐일 때 그것
 */
export function pageOptionPoint(
  label: string,
): { ok: true; x: number; y: number; label: string } | { ok: false; error: string } {
  type State = { shownBefore?: Set<Element> }
  const before = (globalThis as unknown as { __dool2?: State }).__dool2?.shownBefore
  const norm = (x: string | null | undefined) => (x ?? '').replace(/\s+/g, ' ').trim()
  // innerText: 줄 안의 글 조각 사이를 띄운다 ("S내일 도착" → "S 내일 도착"). 목록 읽기와 같은 글
  const text = (e: Element) => norm((e as HTMLElement).innerText || e.textContent)
  const want = norm(label)
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'
  }
  const all = [...document.querySelectorAll('body *')].filter(shown)
  const fresh = before ? all.filter((e) => !before.has(e)) : all
  const inner = (list: Element[]) => list.filter((e) => !list.some((o) => o !== e && e.contains(o)))
  for (const pool of [fresh, all]) {
    // 줄 전체 글이 같으면 그 줄(가장 안쪽 줄)을, 아니면 글 조각이 같은 것을, 그다음 그 글로 시작하는 것이 하나뿐일 때
    let hit = inner(pool.filter((e) => text(e) === want))
    if (!hit.length) {
      const starts = inner(pool.filter((e) => text(e).startsWith(want) && text(e).length <= want.length + 40))
      if (starts.length === 1) hit = starts
    }
    const e = hit[0]
    if (e) {
      e.scrollIntoView({ block: 'nearest' })
      const r = e.getBoundingClientRect()
      return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, label: text(e).slice(0, 60) }
    }
  }
  return { ok: false, error: `"${label}"을(를) 연 목록에서 찾지 못했어요` }
}

/** 펼침 목록에서 글자가 같은 것을 고른다 (진짜·숨은 select는 값을 바꾸고 input·change, 꾸민 목록은 열어 그 항목을 누른다) */
export async function pageSelectChoose(ref: string, label: string) {
  type State = { refs: Map<string, WeakRef<Element>> }
  const el = (globalThis as unknown as { __dool2?: State }).__dool2?.refs.get(ref)?.deref()
  const norm = (x: string | null | undefined) => (x ?? '').replace(/\s+/g, ' ').trim()
  const setSelect = (sel: HTMLSelectElement) => {
    const opt = [...sel.options].find((o) => !o.disabled && norm(o.textContent) === norm(label))
    if (!opt) return { ok: false, error: `"${label}"을(를) 목록에서 찾지 못했어요` }
    sel.value = opt.value
    opt.selected = true
    sel.dispatchEvent(new Event('input', { bubbles: true }))
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, label: norm(opt.textContent) }
  }
  if (el instanceof HTMLSelectElement) return setSelect(el)
  if (!(el instanceof HTMLElement)) return { ok: false, error: `${ref}는 펼침 목록이 아니에요` }
  // 꾸민 목록 뒤에 숨은 진짜 select면 그 값을 바꾼다 (읽을 때와 같은 순서)
  let up: Element | null = el
  for (let i = 0; i < 3 && up; i++, up = up.parentElement) {
    const sel = up.querySelector('select')
    if (sel && sel.options.length >= 2) return setSelect(sel)
  }
  const press = (t: Element) => {
    // pointer*는 PointerEvent로 (요즘 목록 부품(Radix 등)은 MouseEvent로 온 pointerdown을 무시한다. 실측 무신사·오늘의집)
    const r = t.getBoundingClientRect()
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }
    for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      t.dispatchEvent(
        k.startsWith('pointer')
          ? new PointerEvent(k, {
              ...at,
              bubbles: true,
              cancelable: true,
              view: window,
              pointerType: 'mouse',
              isPrimary: true,
              pointerId: 1,
              buttons: k === 'pointerdown' ? 1 : 0,
            })
          : new MouseEvent(k, {
              ...at,
              bubbles: true,
              cancelable: true,
              view: window,
              buttons: k === 'mousedown' ? 1 : 0,
            }),
      )
  }
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const before = new Set([...document.querySelectorAll('body *')].filter(shown))
  if (el.getAttribute('aria-expanded') !== 'true') {
    // 읽을 때와 같은 순서로 연다: 상자 → 감싼 칸 → ↓ 키
    const opened = () => el.getAttribute('aria-expanded') === 'true'
    const wait = () => new Promise((r) => setTimeout(r, 350))
    press(el)
    await wait()
    const control = el.closest('[class*="control"],[class*="Control"]') ?? el.parentElement?.parentElement
    if (!opened() && control) {
      press(control)
      await wait()
    }
    if (!opened()) {
      el.focus()
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }),
      )
      await wait()
    }
  }
  // 읽을 때처럼 새로 보인 것 중 글이 같은 가장 안쪽 (늘 DOM에 있는 aria-controls 목록이면 보이는 것 전부)
  const cands = [...document.querySelectorAll('body *')].filter(
    (e) =>
      shown(e) &&
      (!before.has(e) || !!el.getAttribute('aria-controls')) &&
      e !== el &&
      !el.contains(e) &&
      norm(e.textContent) === norm(label),
  )
  const opt = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)))[0]
  if (!opt) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return { ok: false, error: `"${label}"을(를) 목록에서 찾지 못했어요` }
  }
  press(opt)
  await new Promise((r) => setTimeout(r, 250))
  return { ok: true, label: norm(opt.textContent) }
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

/**
 * 폰 너비로 그렸더니 오른쪽 화면 밖으로 밀려나 잘린 입력칸·버튼 수.
 * 너비가 고정된 PC용 창(정부24 간편인증 액자: 이름·생년월일·[인증 요청]이 412px 밖으로 나감)을 찾는다.
 * 일부러 숨긴 것은 세지 않는다: 가로로 넘기는 목록(잘라 보이는 상자 안), 통째로 밖에 있는 서랍 메뉴(걸친 상자가 없음)
 */
export function pageCutOff() {
  const PICK =
    'input:not([type="hidden"]), button, select, textarea, a[href], [role="button"], [role="radio"]'
  const count = (doc: Document, win: Window): number => {
    const vw = win.innerWidth
    let n = 0
    // 가로로 밀어 볼 수 있는 넓은 페이지(PC용 쇼핑몰 첫 화면)는 지금처럼 둔다. 밀 수도 없게 잘린 것만 센다
    const wide = doc.documentElement.scrollWidth > vw + 8
    if (!wide)
      for (const el of doc.querySelectorAll(PICK)) {
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2 || r.left < vw - 2) continue
        const cs = win.getComputedStyle(el)
        if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue
        let straddle = false
        let clipped = false
        for (
          let p = el.parentElement;
          p && p !== doc.body && p !== doc.documentElement;
          p = p.parentElement
        ) {
          const pr = p.getBoundingClientRect()
          if (win.getComputedStyle(p).overflowX !== 'visible' && pr.right <= vw + 2) {
            clipped = true
            break
          }
          if (pr.left < vw - 40 && pr.right > vw + 4) straddle = true
        }
        if (straddle && !clipped) n++
      }
    // 같은 주소의 액자 안도 (간편인증 창이 액자다). 다른 주소 액자는 읽을 수 없어 넘어간다
    for (const f of doc.querySelectorAll('iframe')) {
      const r = f.getBoundingClientRect()
      if (r.width < 50 || r.height < 50 || r.left >= vw) continue
      try {
        const d = f.contentDocument
        if (d && f.contentWindow) n += count(d, f.contentWindow)
      } catch {}
    }
    return n
  }
  return count(document, window)
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
/** 칸에 실제로 들어간 글자 수 (금고 값이 잘려 들어갔는지 본다. 값은 돌려주지 않는다) */
/** 지금 초점이 있는 칸에 든 글자 수 (원격 '필요한 칸만'으로 넣은 값이 들어갔는지 볼 때). 칸이 아니면 -1 */
export function pageActiveValueLength(): number {
  let a: Element | null = document.activeElement
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) return a.value.length
  return -1
}

export function pageValueLength(ref: string, alnum = false): number {
  type State = { refs: Map<string, WeakRef<Element>> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  // 글자·숫자만 센다: 칸이 스스로 붙이는 구분자(010-1234-…, 1999 / 08 / 10)는 잘림이 아니다
  // (비밀번호는 기호가 빠졌는지 봐야 해서 그대로 센다)
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
    return alnum ? el.value.replace(/[^0-9A-Za-z\uAC00-\uD7A3]/g, '').length : el.value.length
  return -1
}

/** 표시 하나의 화면 자리 (이 액자 기준). 키패드 버튼처럼 그림만 있는 것을 하나씩 잘라 볼 때 */
export function pageRect(ref: string): { x: number; y: number; w: number; h: number } | undefined {
  type State = { refs: Map<string, WeakRef<Element>> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  if (!el) return undefined
  const r = el.getBoundingClientRect()
  return r.width > 2 && r.height > 2 ? { x: r.left, y: r.top, w: r.width, h: r.height } : undefined
}

/**
 * 보안문자 그림 후보: 칸 둘레의 그림·캔버스(가까운 순 3개)와, 칸을 품은 덩어리 상자, 칸 위쪽 띠.
 * 어느 게 보안문자인지는 고르지 않는다 — 잘라서 AI에게 보여 주고 AI가 고른다 (화면 보기 좌표, 이 액자 기준)
 */
export function pageCaptchaRects(
  ref: string,
): { x: number; y: number; w: number; h: number; what: string }[] {
  type State = { refs: Map<string, WeakRef<Element>> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  if (!el) return []
  el.scrollIntoView({ block: 'center', inline: 'nearest' })
  const q = el.getBoundingClientRect()
  const out: { x: number; y: number; w: number; h: number; what: string }[] = []
  const pics = [...document.querySelectorAll<HTMLElement>('img, canvas, svg, [style*="background-image"]')]
    .map((img) => ({ img, r: img.getBoundingClientRect() }))
    .filter(({ r }) => r.width >= 40 && r.width <= 480 && r.height >= 16 && r.height <= 200)
    .map(({ img, r }) => {
      const dx = Math.max(0, r.left - q.right, q.left - r.right)
      const dy = Math.max(0, r.top - q.bottom, q.top - r.bottom)
      return { img, r, d: Math.hypot(dx, dy) }
    })
    .filter((x) => x.d < 320)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
  for (const { r } of pics)
    out.push({ x: r.left - 4, y: r.top - 4, w: r.width + 8, h: r.height + 8, what: '칸 둘레 그림' })
  let box: Element | null = el.parentElement
  let rect: DOMRect | undefined
  for (let i = 0; box && i < 6; box = box.parentElement, i++) {
    const b = box.getBoundingClientRect()
    if (b.width > 760 || b.height > 360) break
    if (b.height >= q.height + 30) rect = b
  }
  if (rect) out.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height, what: '칸을 품은 상자' })
  const top = Math.max(0, q.top - 140)
  out.push({
    x: Math.max(0, q.left - 40),
    y: top,
    w: Math.min(q.width + 320, 680),
    h: q.bottom - top + 8,
    what: '칸 위쪽',
  })
  return out.filter((r) => r.w > 8 && r.h > 8)
}

/**
 * 링크가 다른 화면으로 가기만 하는지: 진짜 주소(http)로 가고, 누르면 도는 스크립트(onclick)가 없을 때만.
 * javascript:·#·onclick 링크는 버튼처럼 무엇이든 할 수 있어 아니라고 본다 (승인 게이트가 쓴다)
 */
export function pageLinkNavigates(ref: string): boolean {
  type State = { refs: Map<string, WeakRef<Element>> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  if (!(el instanceof HTMLAnchorElement)) return false
  if (el.hasAttribute('onclick') || el.closest('form')) return false
  const raw = el.getAttribute('href') ?? ''
  if (!raw || raw.startsWith('#') || /^\s*javascript:/i.test(raw)) return false
  try {
    const u = new URL(raw, location.href)
    if (!/^https?:$/.test(u.protocol)) return false
    // 같은 페이지 안 이동(#)만 다른 건 이동이 아니다
    return !(u.origin === location.origin && u.pathname === location.pathname && u.search === location.search)
  } catch {
    return false
  }
}

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

export function pageForm(inFrame = false) {
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
  /**
   * 지금 떠 있는 창(가운데를 덮은 고정 창·대화 상자)이 있으면 그 안의 칸만 본다. 뒤에 깔린 페이지 칸(만족도 설문·검색칸)을
   * 폰에 보여 주면 사용자는 엉뚱한 칸을 본다(정부24: 회원/비회원 창 대신 페이지 맨 아래 설문이 나왔다).
   * 가운데를 덮은 것이 액자면 그 액자 안을 봐 달라고 알린다(간편인증 창)
   */
  let root: Element | Document = document
  let frame: string | undefined
  {
    const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
    if (!inFrame && hit?.tagName === 'IFRAME') {
      const r = hit.getBoundingClientRect()
      if (r.width >= innerWidth * 0.5 && r.height >= innerHeight * 0.3) frame = (hit as HTMLIFrameElement).src
    }
    for (let n: Element | null = hit; !frame && n && n !== document.body; n = n.parentElement) {
      if (
        n.matches('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]') ||
        getComputedStyle(n).position === 'fixed'
      ) {
        const r = n.getBoundingClientRect()
        // 화면 전체를 감싼 앱 껍데기는 창이 아니다
        if (
          r.height < innerHeight * 0.98 ||
          r.width < innerWidth * 0.98 ||
          n.matches('dialog, [role$="dialog"]')
        )
          root = n
        else if (n.querySelector('input, button, a[href], select, textarea')) root = n
        break
      }
    }
  }
  if (frame) return { title: '', fields: [] as FormField[], buttons: [], url: location.href, frame }
  const inRoot = <E extends Element>(sel: string) => [...root.querySelectorAll<E>(sel)]
  // 페이지 끝의 만족도 조사·의견 칸은 사람이 할 일이 아니다
  const SURVEY = /만족도|만족하|불편사항|개선이?\s*필요|의견을?\s*(남겨|입력)|평가해|설문|별점|추천하시겠/
  const inSurvey = (el: Element) => {
    for (let n: Element | null = el, i = 0; n && i < 8; n = n.parentElement, i++) {
      if (
        SURVEY.test((n as HTMLElement).innerText?.slice(0, 300) ?? '') &&
        (n as HTMLElement).innerText.length < 1500
      )
        return true
      if (/survey|satisf|feedback|evaluat|EstCheck|rating/i.test(`${n.id} ${n.className}`)) return true
    }
    return false
  }
  // 영문 변수 이름(MinfoEstCheck)은 사람에게 보일 이름이 아니다
  const human = (t: string) => (/^[A-Za-z_$][\w$-]*$/.test(t.trim()) ? '' : t)
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
    return clip(human(f.name || ''), 30)
  }
  const fields: FormField[] = []
  const used = new Set<Element>()
  const CODE = /인증\s*번호|인증코드|확인\s*코드|otp|verification|auth.?code|certi.?num|보안\s*코드/i
  const CAPTCHA_INPUT = /보안\s*문자|자동\s*입력|captcha|자동등록방지|문자를\s*입력/i
  // 글자 칸
  for (const el of inRoot<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
    if (fields.length >= 16) break
    if (
      el instanceof HTMLInputElement &&
      /^(hidden|checkbox|radio|submit|button|reset|image|file|range|color)$/.test(el.type)
    )
      continue
    if (el.disabled || el.readOnly || !visible(el) || inSurvey(el)) continue
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
  for (const el of inRoot<HTMLSelectElement>('select')) {
    if (fields.length >= 20 || el.disabled || !visible(el) || inSurvey(el)) continue
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
  for (const el of inRoot<HTMLInputElement>('input[type="radio"]')) {
    if (el.disabled) continue
    const vis = visible(el) || (el.labels?.[0] && visible(el.labels[0]))
    if (!vis || inSurvey(el)) continue
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
      label: clip(textOf(legend) || human(first.name) || '고르기', 30),
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
  for (const el of inRoot<HTMLElement>('button, a, label, li, [role="tab"], [role="radio"], span')) {
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
  // 고르기: 그림 타일 (간편인증 앱 카카오톡·네이버·토스…). 페이지 전체의 상품 목록과 헷갈리지 않게 떠 있는 창·액자 안에서만
  const tiles = new Set<Element>()
  if (root !== document || inFrame) {
    for (const list of inRoot<HTMLElement>('ul, ol')) {
      if (fields.length >= 20) break
      const items = [...list.children].filter((li) => {
        const t = textOf(li)
        return (
          li.querySelector('img, svg, [class*="logo"], [class*="icon"]') && t && t.length <= 14 && visible(li)
        )
      })
      if (items.length < 3) continue
      const options = items.slice(0, 20).map((li) => {
        const hit = (li.querySelector('a, button, label, [role="button"]') ?? li) as HTMLElement
        tiles.add(hit)
        for (const x of li.querySelectorAll('a, button')) tiles.add(x)
        return {
          id: keep(hit),
          label: textOf(li),
          ...(/\b(on|active|selected|checked|current)\b/.test(`${li.className} ${hit.className}`) ||
          hit.getAttribute('aria-selected') === 'true' ||
          hit.getAttribute('aria-checked') === 'true'
            ? { on: true }
            : {}),
        }
      })
      const names = options.map((o) => o.label).join(' ')
      fields.push({
        id: options[0]?.id ?? keep(list),
        kind: 'choice',
        label: /카카오|네이버|토스|PASS|인증서|페이코|뱅크/i.test(names) ? '인증 앱' : '고르기',
        options,
      })
    }
  }
  // 체크 (약관 동의 등). 진짜 칸은 숨기고 라벨만 보이는 사이트가 많아 라벨도 본다
  let checks = 0
  for (const el of inRoot<HTMLInputElement>('input[type="checkbox"]')) {
    if (checks >= 8 || el.disabled || inSurvey(el)) continue
    const lab = el.labels?.[0] ?? el.closest('label')
    if (!visible(el) && !(lab && visible(lab))) continue
    const label = clip(lab ? textOf(lab) : labelOf(el), 50)
    if (!label) continue
    checks++
    fields.push({ id: keep(el), kind: 'check', label, ...(el.checked ? { checked: true } : {}) })
  }
  // 보안문자 그림: '보안문자' 칸마다 그 칸에 가장 가까운 그림을 붙인다.
  // 이름에 '보안'이 든 첫 그림을 쓰던 때는 본인확인 창의 PASS 로고를 잘라 보냈다(실측 한국모바일인증) —
  // 그림 이름은 참고만 하고, 칸과의 거리로 고른다
  const CAPTCHA_HINT = /captcha|kaptcha|보안|자동입력|security.?(code|img)|simplecaptcha/i
  const pics = inRoot<HTMLImageElement | HTMLCanvasElement>('img, canvas').filter((img) => {
    if (!visible(img)) return false
    const r = img.getBoundingClientRect()
    return r.width >= 50 && r.width <= 420 && r.height >= 18 && r.height <= 160
  })
  for (const f of fields) {
    if (!f.captchaRect || (f.kind !== 'text' && f.kind !== 'number')) continue
    const el = st.els.get(f.id)?.deref()
    if (!el) continue
    const q = el.getBoundingClientRect()
    let best: { r: DOMRect; d: number } | undefined
    for (const img of pics) {
      const r = img.getBoundingClientRect()
      const hay = `${img.getAttribute('alt') ?? ''} ${img.getAttribute('src') ?? ''} ${img.id} ${img.className} ${img.getAttribute('title') ?? ''}`
      // 칸과 그림 가장자리 사이 거리 (위·왼쪽·같은 줄 어디든)
      const dx = Math.max(0, r.left - q.right, q.left - r.right)
      const dy = Math.max(0, r.top - q.bottom, q.top - r.bottom)
      const d = Math.hypot(dx, dy) * (CAPTCHA_HINT.test(hay) ? 0.6 : 1)
      if (!best || d < best.d) best = { r, d }
    }
    if (best && best.d < 220) {
      const r = best.r
      f.captchaRect = { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }
      f.code = false
      continue
    }
    // 그림 태그를 못 찾았다(배경 그림·캔버스·액자 속 그림): 칸을 품은 덩어리 상자를 통째로 찍는다.
    // 너무 크면(창 전체) 칸 위쪽 120px와 칸 줄만 찍는다 (실측 본인확인 창: 보안문자 그림이 아예 안 보였다)
    let box: Element | null = el.parentElement
    let rect: DOMRect | undefined
    for (let i = 0; box && i < 5; box = box.parentElement, i++) {
      const b = box.getBoundingClientRect()
      if (b.width > 720 || b.height > 320) break
      if (b.height >= q.height + 30) rect = b
    }
    const x = rect ? rect.left : Math.max(0, q.left - 20)
    const y = rect ? rect.top : Math.max(0, q.top - 120)
    const w = rect ? rect.width : Math.min(q.width + 240, 640)
    const h = rect ? rect.height : q.bottom - y + 6
    f.captchaRect = { x: x + window.scrollX, y: y + window.scrollY, w, h }
    f.code = false
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
  // 떠 있는 창 안에서는 글자 링크도 버튼이다(정부24 '비회원 신청하기'는 꾸밈 없는 링크)
  for (const el of inRoot<HTMLElement>(
    root === document && !inFrame
      ? 'button, input[type="submit"], input[type="button"], [role="button"], a[class*="btn"], a[class*="button"]'
      : 'button, input[type="submit"], input[type="button"], [role="button"], a',
  )) {
    if (buttons.length >= 6 || used.has(el) || !visible(el) || inSurvey(el)) continue
    if ((el as HTMLButtonElement).disabled) continue
    const label = clip(
      el instanceof HTMLInputElement ? el.value : el.innerText || el.getAttribute('aria-label') || '',
      20,
    )
    if (!label || seen.has(label) || CARRIER.test(label) || tiles.has(el)) continue
    seen.add(label)
    const main = (el as HTMLButtonElement).type === 'submit' || MAIN.test(label)
    // 머리말·메뉴·바닥글 버튼(정부24·전체메뉴·공유하기)은 할 일과 상관없다
    if (
      !main &&
      el.closest('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')
    )
      continue
    // '공동인증서 등록 레이어 닫기'처럼 사이트가 잘못 붙인 닫기 이름은 '닫기'로
    buttons.push({
      id: keep(el),
      label: /닫기$/.test(label) ? '닫기' : label,
      ...(main ? { main: true } : {}),
    })
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

/**
 * 체크·라디오를 누른 뒤에도 원하는 상태가 아니면 라벨(같은 줄의 글자)을 누른다.
 * 칸을 투명하게 덮어 두고 옆 글자 줄로만 체크되는 화면이 있다 (실측 카카오 동의: 폰에서 체크해도 PC는 그대로였다)
 */
export function pageFormCheckFix(id: string, want: boolean) {
  const st = (globalThis as unknown as { __dool2form?: { els: Map<string, WeakRef<Element>> } }).__dool2form
  const el = st?.els.get(id)?.deref()
  if (!(el instanceof HTMLInputElement)) return { ok: false }
  if (el.checked === want) return { ok: true, checked: el.checked }
  const row =
    (el.labels?.[0] as HTMLElement | undefined) ??
    (el.closest('label') as HTMLElement | null) ??
    (el.id ? (document.querySelector(`[for="${CSS.escape(el.id)}"]`) as HTMLElement | null) : null) ??
    el.parentElement
  row?.click()
  if (el.checked !== want) el.click()
  return { ok: true, checked: el.checked }
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
  /** 읽을 속성 (href·src는 전체 주소로, '@center'는 화면 안 가운데 자리 "x,y"). 없으면 보이는 글 */
  attr?: string
  /** 글을 줄로 나눠 n번째(0부터, 음수는 뒤에서) */
  line?: number
  /** 정규식. 묶음 1이 있으면 그것, 없으면 맞은 글 전체 */
  match?: string
  /** css에 맞는 것을 모두 (글 목록) */
  list?: boolean
  /** 글을 다듬거나 자르지 않고 그대로 (화면에 박힌 JSON 읽기) */
  raw?: boolean
  /** 가장 그럴듯한 사진 주소 하나 (늦게 그리는 사진·배경 그림까지, 아이콘·로고는 빼고, https로) */
  image?: boolean
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
      if (f.attr === '@center') {
        // 화면 안 가운데 자리 "x,y" (CSS 픽셀): 버튼 표시가 없는 그림 타일을 누를 때 (Flow 영상 목록)
        const r = el.getBoundingClientRect()
        v = r.width && r.height ? `${Math.round(r.x + r.width / 2)},${Math.round(r.y + r.height / 2)}` : null
      } else if (f.attr) {
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
    // 사진 고르기: 사이트마다 늦게 그리는 방법이 달라서 주소가 있을 만한 곳을 다 본다
    const NOT_PHOTO =
      /(^|[\W_])(icon|ico|logo|badge|sprite|blank|spacer|placeholder|loading|loader|star|bul|arrow|btn|emoji|flag|rating|avatar-default)([\W_]|$)/i
    const absolute = (u: string): string | null => {
      const t = u.trim()
      if (!t || t.startsWith('data:') || t.startsWith('blob:') || t.startsWith('about:')) return null
      try {
        const x = new URL(t, location.href)
        if (x.protocol === 'http:') x.protocol = 'https:'
        if (x.protocol !== 'https:' || /\.svg($|\?)/i.test(x.pathname)) return null
        return x.href
      } catch {
        return null
      }
    }
    // srcset: 폰 카드에 알맞은 크기(400px 언저리)를 고른다
    const fromSrcset = (v: string | null): string | null => {
      if (!v) return null
      const opts = v
        .split(/,\s+(?=\S)/)
        .map((p) => p.trim().split(/\s+/))
        .map(([u, d]) => ({
          u: u ?? '',
          w: d?.endsWith('w') ? Number.parseInt(d, 10) : d?.endsWith('x') ? Number.parseFloat(d) * 300 : 300,
        }))
        .filter((o) => o.u)
      if (!opts.length) return null
      opts.sort((a, b) => Math.abs(a.w - 400) - Math.abs(b.w - 400))
      return opts[0]?.u ?? null
    }
    const imageOf = (scope: Element): string | null => {
      type Cand = { url: string; area: number }
      const cands: Cand[] = []
      const push = (raw: string | null, el: Element) => {
        const url = raw ? absolute(raw) : null
        if (!url) return
        const hay = `${url} ${el.getAttribute('alt') ?? ''} ${el.getAttribute('class') ?? ''}`
        if (NOT_PHOTO.test(hay)) return
        const r = el.getBoundingClientRect()
        const img = el as HTMLImageElement
        const w = r.width || img.naturalWidth || Number(el.getAttribute('width')) || 0
        const hgt = r.height || img.naturalHeight || Number(el.getAttribute('height')) || 0
        // 그려진 크기를 알면 아주 작은 그림(아이콘)은 뺀다. 아직 안 그려졌으면(0) 일단 받는다
        if (w && hgt && (w < 48 || hgt < 48)) return
        cands.push({ url, area: w * hgt || 1 })
      }
      const els = [
        scope,
        ...Array.from(
          scope.querySelectorAll(
            'img, picture source, [style*="background-image"], [data-src], [data-bg], [data-background]',
          ),
        ),
      ]
      for (const el of els) {
        if (el.tagName === 'IMG') {
          const img = el as HTMLImageElement
          const src = img.getAttribute('src') ?? ''
          const lazy =
            img.getAttribute('data-src') ??
            img.getAttribute('data-lazy-src') ??
            img.getAttribute('data-original') ??
            img.getAttribute('data-lazy') ??
            fromSrcset(img.getAttribute('data-srcset'))
          // src가 투명 그림·자리표시면 늦게 넣는 주소를 먼저
          const placeholder = !src || src.startsWith('data:') || NOT_PHOTO.test(src)
          push(placeholder ? (lazy ?? img.currentSrc ?? null) : img.currentSrc || src, img)
          if (placeholder && !lazy) push(fromSrcset(img.getAttribute('srcset')), img)
        } else if (el.tagName === 'SOURCE') {
          push(
            fromSrcset(el.getAttribute('srcset') ?? el.getAttribute('data-srcset')),
            el.parentElement ?? el,
          )
        } else {
          const bg = (el as HTMLElement).style?.backgroundImage ?? ''
          const m = /url\((['"]?)(.*?)\1\)/.exec(bg)
          push(
            m?.[2] ??
              el.getAttribute('data-src') ??
              el.getAttribute('data-bg') ??
              el.getAttribute('data-background'),
            el,
          )
        }
      }
      if (!cands.length) return null
      cands.sort((a, b) => b.area - a.area)
      return cands[0]?.url ?? null
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
        if (f.image) {
          row[k] = targets[0] ? imageOf(targets[0]) : null
          continue
        }
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

/** 목록의 n번째 줄을 화면 가운데로 (늦게 그리는 사진을 불러오게). 줄 수를 돌려준다. n이 -1이면 맨 위로 */
export function pageRevealItem(items: string, n: number): number {
  let list: Element[] = []
  try {
    list = Array.from(document.querySelectorAll(items))
  } catch {
    return 0
  }
  if (n < 0) window.scrollTo({ top: 0, behavior: 'instant' })
  else list[n]?.scrollIntoView({ block: 'center', behavior: 'instant' })
  return list.length
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

// ── 액자(iframe) 자리 재기 ──
// 액자 속 요소를 누르려면 그 액자가 페이지 화면의 어디에 그려지는지 알아야 한다. 액자 안에 또 액자가 있으면
// (결제 화면 → 배송지 추가 창 → 주소 찾기 창) 단계마다 바깥 문서에서 액자 상자를 재어 더한다.
// 예전에는 맨 바깥 문서에서 주소로만 찾고, 못 찾으면 (0,0)으로 눌러 엉뚱한 곳이 조용히 눌렸다 (실측 11-20 G마켓 주소 찾기)

/**
 * 액자 문서 안에서: 자기 크기, 그리고 같은 주소라 바깥 문서를 볼 수 있으면 자기 상자(frameElement).
 * py(이 액자 화면 기준 누를 자리의 세로 위치)를 주면 그 자리가 바깥 화면에 보이게 바깥을 굴린 뒤 잰다
 */
export function pageFrameSelf(py = -1): FrameSelf {
  const self: FrameSelf = { w: window.innerWidth, h: window.innerHeight }
  try {
    const fe = window.frameElement as HTMLIFrameElement | null
    const win = fe?.ownerDocument?.defaultView
    if (!fe || !win) return self
    const measure = () => {
      const r = fe.getBoundingClientRect()
      return { x: r.left + fe.clientLeft, y: r.top + fe.clientTop, w: fe.clientWidth, h: fe.clientHeight }
    }
    let box = measure()
    if (py >= 0) {
      const at = box.y + py
      if (at < 0 || at > win.innerHeight) {
        let sc: Element | null = fe.parentElement
        while (sc && sc !== fe.ownerDocument.body) {
          const cs = win.getComputedStyle(sc)
          if (/(auto|scroll|overlay)/.test(cs.overflowY) && sc.scrollHeight > sc.clientHeight + 1) break
          sc = sc.parentElement
        }
        const dy = at - win.innerHeight / 2
        if (sc && sc !== fe.ownerDocument.body) sc.scrollBy({ top: dy, behavior: 'instant' })
        box = measure()
        if (box.y + py < 0 || box.y + py > win.innerHeight)
          win.scrollBy({ top: box.y + py - win.innerHeight / 2, behavior: 'instant' })
        box = measure()
      }
    }
    return { ...self, owner: box }
  } catch {
    return self
  }
}

/**
 * 바깥 문서에서: 주소가 url이고 안쪽 크기가 w×h인 액자 상자 (이 문서 화면 기준).
 * 주소(전체 → 주소+경로 → 출처)와 크기로 점수를 매겨 하나로 정해지면 그 상자, 같은 점수가 여럿이면 ambiguous,
 * 없으면 undefined. pick을 주면(본 액자가 알려 준 순번) 그 액자. py를 주면 그 자리가 보이게 굴린 뒤 잰다
 */
export function pageFrameBox(
  url: string,
  w: number,
  h: number,
  py = -1,
  pick = -1,
): { x: number; y: number; w: number; h: number } | { ambiguous: number } | undefined {
  const frames = Array.from(document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[]
  const norm = (u: string, full: boolean) => {
    try {
      const x = new URL(u, location.href)
      return full ? `${x.origin}${x.pathname}` : x.origin
    } catch {
      return u
    }
  }
  const box = (f: HTMLIFrameElement) => {
    const r = f.getBoundingClientRect()
    const cs = getComputedStyle(f)
    const pl = Number.parseFloat(cs.paddingLeft) || 0
    const pt = Number.parseFloat(cs.paddingTop) || 0
    return {
      x: r.left + f.clientLeft + pl,
      y: r.top + f.clientTop + pt,
      w: f.clientWidth - pl - (Number.parseFloat(cs.paddingRight) || 0),
      h: f.clientHeight - pt - (Number.parseFloat(cs.paddingBottom) || 0),
    }
  }
  const score = (f: HTMLIFrameElement) => {
    const raw = f.getAttribute('src') ?? ''
    const src = raw ? new URL(raw, location.href).href : ''
    let s = 0
    if (url === 'about:srcdoc') s = f.hasAttribute('srcdoc') ? 3 : 0
    else if (url === 'about:blank' || url === '')
      s = !f.hasAttribute('srcdoc') && (!src || src === 'about:blank') ? 2 : 0
    else if (src === url) s = 4
    else if (src && norm(src, true) === norm(url, true)) s = 3
    else if (src && norm(src, false) === norm(url, false)) s = 2
    // 액자 안에서 주소가 바뀌었으면(결제 단계 이동) src와 다르다: 크기로 맞춘다
    const b = box(f)
    if (w > 0 && h > 0 && Math.abs(b.w - w) <= 2 && Math.abs(b.h - h) <= 2) s += 2
    return s
  }
  let hit: HTMLIFrameElement | undefined
  if (pick >= 0) hit = frames[pick]
  else {
    const scored = frames.map((f) => ({ f, s: score(f) })).filter((x) => x.s >= 2)
    const best = Math.max(0, ...scored.map((x) => x.s))
    const top = scored.filter((x) => x.s === best)
    if (top.length > 1) return { ambiguous: top.length }
    hit = top[0]?.f
  }
  if (!hit) return undefined
  let b = box(hit)
  if (py >= 0 && (b.y + py < 0 || b.y + py > window.innerHeight)) {
    let sc: Element | null = hit.parentElement
    while (sc && sc !== document.body) {
      const cs = getComputedStyle(sc)
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && sc.scrollHeight > sc.clientHeight + 1) break
      sc = sc.parentElement
    }
    if (sc && sc !== document.body)
      sc.scrollBy({ top: b.y + py - window.innerHeight / 2, behavior: 'instant' })
    b = box(hit)
    if (b.y + py < 0 || b.y + py > window.innerHeight)
      window.scrollBy({ top: b.y + py - window.innerHeight / 2, behavior: 'instant' })
    b = box(hit)
  }
  return b
}

/** 같은 모양 액자가 여럿일 때 가리기: 바깥 문서가 메시지를 기다렸다가, 보낸 창이 어느 액자인지 순번을 남긴다 */
export function pageFrameProbeListen(token: string) {
  const g = globalThis as unknown as { __dool2probe?: Record<string, number> }
  g.__dool2probe ??= {}
  const store = g.__dool2probe
  const on = (e: MessageEvent) => {
    const d = e.data as { __dool2probe?: string } | null
    if (!d || typeof d !== 'object' || d.__dool2probe !== token) return
    const frames = Array.from(document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[]
    store[token] = frames.findIndex((f) => f.contentWindow === e.source)
    removeEventListener('message', on, true)
  }
  addEventListener('message', on, true)
  setTimeout(() => removeEventListener('message', on, true), 3000)
  return true
}
export function pageFrameProbeSend(token: string) {
  parent.postMessage({ __dool2probe: token }, '*')
  return true
}
export function pageFrameProbeRead(token: string): number {
  const g = globalThis as unknown as { __dool2probe?: Record<string, number> }
  const n = g.__dool2probe?.[token]
  if (g.__dool2probe) delete g.__dool2probe[token]
  return typeof n === 'number' ? n : -1
}

// ── 누름이 닿았는지 ──
// 진짜 마우스 입력이 그 요소까지 왔는지를 페이지 안에서 직접 본다. 화면이 안 바뀌는 버튼(키패드 숫자)을
// "안 눌렸다"고 보고 다시 눌러 두 번 들어가던 것을 막는다 (실측 쿠팡 결제 비밀번호 7자리)

/** 누르기 직전에 건다: 사람 입력(isTrusted)으로 온 pointerdown·mousedown·click이 그 요소에 닿으면 남긴다 */
export function pageHitArm(ref: string): boolean {
  type State = { refs: Map<string, WeakRef<Element>> }
  type Hit = { hit: boolean; other: string; n: number; off: () => void }
  const g = globalThis as unknown as { __dool2?: State; __dool2hit?: Hit }
  g.__dool2hit?.off()
  const el = g.__dool2?.refs.get(ref)?.deref()
  if (!el) return false
  const label = el instanceof HTMLInputElement ? Array.from(el.labels ?? []) : []
  const box: Hit = { hit: false, other: '', n: 0, off: () => {} }
  const on = (e: Event) => {
    if (!e.isTrusted) return
    box.n++
    const path = e.composedPath()
    if (path.includes(el) || label.some((l) => path.includes(l))) box.hit = true
    else if (!box.other) {
      const t = e.target as HTMLElement | null
      box.other = ((t?.innerText || t?.tagName) ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    }
  }
  const kinds = ['pointerdown', 'mousedown', 'click', 'touchstart']
  for (const k of kinds) addEventListener(k, on, true)
  box.off = () => {
    for (const k of kinds) removeEventListener(k, on, true)
  }
  g.__dool2hit = box
  return true
}
/** 걸어 둔 것을 읽고 뗀다. armed: 걸려 있었는지 (문서가 바뀌었으면 false) */
export function pageHitRead(keep = false): { armed: boolean; hit: boolean; other?: string; n: number } {
  type Hit = { hit: boolean; other: string; n: number; off: () => void }
  const g = globalThis as unknown as { __dool2hit?: Hit }
  const b = g.__dool2hit
  if (!b) return { armed: false, hit: false, n: 0 }
  if (!keep) {
    b.off()
    g.__dool2hit = undefined
  }
  return { armed: true, hit: b.hit, n: b.n, ...(b.other ? { other: b.other } : {}) }
}

// ── 무엇이 바뀌었나 (누른 뒤 다시 누를지·기다리기) ──

/** 문서 바뀜 세기를 건다 (key마다 따로: 누르기와 기다리기가 서로 끄지 않게) */
export function pageMutArm(key: string): boolean {
  type Box = { n: number; added: number; removed: number; attrs: number; text: string; o: MutationObserver }
  const g = globalThis as unknown as { __dool2mut?: Record<string, Box> }
  g.__dool2mut ??= {}
  g.__dool2mut[key]?.o.disconnect()
  const mine = (n: Node | null) => {
    // 두리 커서·표시 달기는 세지 않는다
    for (let x: Node | null = n; x; x = x.parentNode)
      if ((x as Element).tagName === 'DOOL2-CURSOR') return true
    return false
  }
  const box: Box = {
    n: 0,
    added: 0,
    removed: 0,
    attrs: 0,
    text: '',
    o: new MutationObserver((list) => {
      for (const m of list) {
        if (mine(m.target) || m.attributeName === 'data-dool2-tap') continue
        box.n++
        if (m.type === 'attributes') box.attrs++
        if (m.type === 'characterData' && box.text.length < 160)
          box.text += ` ${(m.target as Text).data.replace(/\s+/g, ' ').trim().slice(0, 60)}`
        box.removed += m.removedNodes.length
        for (const a of Array.from(m.addedNodes)) {
          box.added++
          if (box.text.length < 160) {
            const t = ((a as HTMLElement).innerText ?? a.textContent ?? '').replace(/\s+/g, ' ').trim()
            if (t) box.text += ` ${t.slice(0, 80)}`
          }
        }
      }
    }),
  }
  box.o.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  g.__dool2mut[key] = box
  return true
}
/** 센 것을 읽는다 (stop이면 끈다). 걸려 있지 않았으면 n: -1 */
export function pageMutRead(
  key: string,
  stop = true,
): { n: number; added: number; removed: number; attrs: number; text: string } {
  type Box = { n: number; added: number; removed: number; attrs: number; text: string; o: MutationObserver }
  const g = globalThis as unknown as { __dool2mut?: Record<string, Box> }
  const b = g.__dool2mut?.[key]
  if (!b) return { n: -1, added: 0, removed: 0, attrs: 0, text: '' }
  if (stop) {
    b.o.disconnect()
    delete g.__dool2mut?.[key]
  }
  return { n: b.n, added: b.added, removed: b.removed, attrs: b.attrs, text: b.text.trim().slice(0, 160) }
}

// ── 스크롤 대상 ──

/**
 * 굴릴 상자: ref가 있으면 그 요소(또는 그것을 품은 굴러가는 상자), 없으면 문서.
 * dir를 주면(가려진 창) 그 상자를 페이지 안에서 굴린다. 위치·끝까지 갔는지·휠을 굴릴 가운데 자리를 돌려준다
 */
export function pageScrollInfo(
  ref: string | null,
  dir = 0,
): { ok: boolean; top: number; max: number; h: number; x: number; y: number; box: boolean; error?: string } {
  type State = { refs: Map<string, WeakRef<Element>> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const doc = (document.scrollingElement ?? document.documentElement) as HTMLElement
  let sc: HTMLElement = doc
  if (ref) {
    const el = st?.refs.get(ref)?.deref()
    if (!el)
      return { ok: false, top: 0, max: 0, h: 0, x: 0, y: 0, box: false, error: `${ref}를 찾을 수 없어요` }
    for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; ) {
      const cs = getComputedStyle(e)
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1) {
        sc = e as HTMLElement
        break
      }
      e = e.parentElement ?? ((e.getRootNode() as ShadowRoot).host || null)
    }
  }
  const isDoc = sc === doc
  if (dir) {
    const by = dir * Math.round((isDoc ? window.innerHeight : sc.clientHeight) * 0.8)
    if (isDoc) window.scrollBy({ top: by, behavior: 'instant' })
    else sc.scrollBy({ top: by, behavior: 'instant' })
  }
  const r = isDoc ? new DOMRect(0, 0, window.innerWidth, window.innerHeight) : sc.getBoundingClientRect()
  const top = Math.round(isDoc ? window.scrollY : sc.scrollTop)
  const max = Math.max(
    0,
    Math.round(isDoc ? doc.scrollHeight - window.innerHeight : sc.scrollHeight - sc.clientHeight),
  )
  const cx = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1)
  const cy = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1)
  return { ok: true, top, max, h: isDoc ? window.innerHeight : sc.clientHeight, x: cx, y: cy, box: !isDoc }
}

// ── 요소 사진 ──

/** 찍을 요소를 보이게 굴린 뒤 상자와 상태 (missing: 없음, zeroSize: 크기 0, offscreen: 굴려도 화면 밖) */
export function pageShotRect(ref: string): {
  status: 'ok' | 'missing' | 'zeroSize' | 'offscreen'
  x: number
  y: number
  w: number
  h: number
} {
  type State = { refs: Map<string, WeakRef<Element>> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  if (!el?.isConnected) return { status: 'missing', x: 0, y: 0, w: 0, h: 0 }
  let r = el.getBoundingClientRect()
  if (r.width <= 2 || r.height <= 2)
    return { status: 'zeroSize', x: r.left, y: r.top, w: r.width, h: r.height }
  const off = () => r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth
  if (off()) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    r = el.getBoundingClientRect()
  }
  return { status: off() ? 'offscreen' : 'ok', x: r.left, y: r.top, w: r.width, h: r.height }
}

// ── 막힌 새 창 (팝업 차단) ──
// 결제 창은 누른 뒤 서버에 다녀와 window.open으로 뜨는데, 그때는 사람이 누른 순간이 아니라 Chrome이 막는다
// (실측 11-20 G마켓 카드 결제: 화면만 하얗게 남았다). 두리 탭에서만, 페이지 공간(MAIN)에서 window.open을 지켜본다.
// 열기를 대신하거나 막지 않는다: 부른 주소·때·돌려받은 창이 없었는지만 남기고, 확장이 새 탭이 실제로 열렸는지 견준다

/** 페이지 공간(MAIN)에서 돈다: window.open 부름을 남긴다 (한 문서에 한 번만) */
export function pageHookOpen(): boolean {
  const w = window as unknown as {
    open: typeof window.open
    __dool2opens?: { url: string; at: number; none: boolean }[]
  }
  if (w.__dool2opens) return false
  const log: { url: string; at: number; none: boolean }[] = []
  // 열거되지 않게 (페이지가 window를 훑어도 잘 안 보이게)
  Object.defineProperty(w, '__dool2opens', { value: log, enumerable: false })
  const orig = w.open
  // 원래 함수를 감싼 Proxy: 이름·인자 수·this가 그대로다
  w.open = new Proxy(orig, {
    apply(target, self, args: unknown[]) {
      const r = Reflect.apply(target, self, args) as Window | null
      try {
        let url = String(args[0] ?? '')
        try {
          url = url ? new URL(url, location.href).href : ''
        } catch {}
        log.push({ url: url.slice(0, 300), at: Date.now(), none: r === null })
        if (log.length > 10) log.shift()
      } catch {}
      return r
    },
  })
  return true
}
/** 페이지 공간(MAIN): 남긴 window.open 부름을 가져가고 비운다 */
export function pageReadOpens(): { url: string; at: number; none: boolean }[] {
  const w = window as unknown as { __dool2opens?: { url: string; at: number; none: boolean }[] }
  const log = w.__dool2opens ?? []
  return log.splice(0, log.length)
}

// ── PC 파일 올리기 (browser_upload) ──
// 표시(ref)가 파일 칸이면 그 칸, 버튼·라벨이면 딸린 파일 칸을 찾는다. 확장이 경로로 넣을 수 있으면(CDP) 표시만 달아 두고,
// 못 넣으면 본체가 보낸 조각을 모아 페이지 안에서 파일로 만든다. 아래 셋은 확장 공간(executeScript)과
// 페이지 공간(Runtime.callFunctionOn, this = 파일 칸) 어디서든 돌도록 바깥 것을 쓰지 않는다

export type UploadTarget =
  | { ok: false; error: string }
  | { ok: true; how: 'none' }
  | {
      ok: true
      how: 'self' | 'label' | 'inside' | 'near'
      accept: string
      multiple: boolean
      disabled: boolean
    }

/**
 * 올릴 칸 찾기: 그 칸 → 라벨이 가리키는 칸 → 안에 든 칸 하나. near면 가까운 상자(4단계 위까지)에 하나뿐인 칸도
 * (버튼을 눌러도 고르기 창이 안 뜰 때만: 멀리 있는 다른 칸을 잘못 고르지 않게)
 */
export function pageUploadTarget(ref: string, token: string, near: boolean): UploadTarget {
  type State = { refs: Map<string, WeakRef<Element>> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  if (!el?.isConnected)
    return { ok: false, error: `${ref}를 찾을 수 없어요. 화면이 바뀌었을 수 있으니 다시 읽어 주세요` }
  const isFile = (e: unknown): e is HTMLInputElement => e instanceof HTMLInputElement && e.type === 'file'
  /** 열린 shadow DOM 안까지 파일 칸 모으기 */
  const filesIn = (root: Element | ShadowRoot): HTMLInputElement[] => {
    const out: HTMLInputElement[] = []
    const walk = (r: Element | ShadowRoot) => {
      for (const x of Array.from(r.querySelectorAll('*'))) {
        if (isFile(x)) out.push(x)
        if (x.shadowRoot) walk(x.shadowRoot)
      }
    }
    walk(root)
    return out
  }
  let input: HTMLInputElement | undefined
  let how: 'self' | 'label' | 'inside' | 'near' = 'self'
  if (isFile(el)) input = el
  if (!input) {
    const lab = el instanceof HTMLLabelElement ? el : el.closest('label')
    if (isFile(lab?.control)) {
      input = lab.control as HTMLInputElement
      how = 'label'
    }
  }
  if (!input) {
    const inner = filesIn(el)
    if (inner.length === 1) {
      input = inner[0]
      how = 'inside'
    }
  }
  if (!input && near) {
    let box: Node | null = el.parentNode
    for (let i = 0; box && i < 4; i++) {
      if (box instanceof ShadowRoot) box = box.host
      const list = filesIn(box as Element)
      if (list.length === 1) {
        input = list[0]
        how = 'near'
        break
      }
      // 칸이 여럿이면 어느 것인지 모른다: 눌러서 뜨는 고르기 창으로
      if (list.length > 1) break
      box = (box as Element).parentNode
    }
  }
  if (!input) return { ok: true, how: 'none' }
  const g = globalThis as unknown as { __dool2up?: Record<string, { input: HTMLInputElement }> }
  g.__dool2up ??= {}
  g.__dool2up[token] = { input }
  input.setAttribute('data-dool2-up', token)
  return { ok: true, how, accept: input.accept, multiple: input.multiple, disabled: input.disabled }
}

/** 파일 조각 하나 받기 (base64). 받은 조각 수를 돌려준다 */
export function pageUploadChunk(token: string, b64: string): number {
  const g = globalThis as unknown as { __dool2parts?: Record<string, Uint8Array[]> }
  g.__dool2parts ??= {}
  g.__dool2parts[token] ??= []
  const parts = g.__dool2parts[token]
  const U = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }
  let bytes: Uint8Array
  if (U.fromBase64) bytes = U.fromBase64(b64)
  else {
    const bin = atob(b64)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  }
  parts.push(bytes)
  return parts.length
}

/**
 * 모은 조각으로 파일을 만들어 칸에 넣고 input·change를 알린다 (사람이 파일을 고른 것과 같게).
 * this가 파일 칸이면(페이지 공간) 그것에, 아니면 pageUploadTarget이 찾아 둔 칸에
 */
export function pageUploadFinish(
  this: unknown,
  token: string,
  files: { name: string; type: string; lastModified: number; parts: number }[],
): { names: string[]; accept: string; multiple: boolean } {
  const g = globalThis as unknown as {
    __dool2parts?: Record<string, Uint8Array[]>
    __dool2up?: Record<string, { input: HTMLInputElement }>
  }
  const input =
    this instanceof HTMLInputElement ? this : (g.__dool2up?.[token]?.input as HTMLInputElement | undefined)
  const parts = g.__dool2parts?.[token] ?? []
  if (g.__dool2parts) delete g.__dool2parts[token]
  if (g.__dool2up) delete g.__dool2up[token]
  if (!input) throw new Error('파일 칸이 사라졌어요. 페이지를 다시 읽어 주세요')
  input.removeAttribute('data-dool2-up')
  const dt = new DataTransfer()
  let at = 0
  for (const f of files) {
    const mine = parts.slice(at, at + f.parts)
    at += f.parts
    dt.items.add(new File(mine as BlobPart[], f.name, { type: f.type, lastModified: f.lastModified }))
  }
  input.files = dt.files
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return {
    names: Array.from(input.files ?? [], (f) => f.name),
    accept: input.accept,
    multiple: input.multiple,
  }
}

/** 넣은 뒤 칸에 든 파일 이름 (경로로 넣었을 때). 표시도 지운다 */
export function pageUploadState(
  this: unknown,
  token: string,
): { names: string[]; accept: string; multiple: boolean } | undefined {
  const g = globalThis as unknown as {
    __dool2parts?: Record<string, Uint8Array[]>
    __dool2up?: Record<string, { input: HTMLInputElement }>
  }
  const input =
    this instanceof HTMLInputElement ? this : (g.__dool2up?.[token]?.input as HTMLInputElement | undefined)
  if (g.__dool2up) delete g.__dool2up[token]
  if (g.__dool2parts) delete g.__dool2parts[token]
  if (!input) return undefined
  input.removeAttribute('data-dool2-up')
  return {
    names: Array.from(input.files ?? [], (f) => f.name),
    accept: input.accept,
    multiple: input.multiple,
  }
}
