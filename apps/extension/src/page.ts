// Functions that run inside the page. Injected with chrome.scripting.executeScript into the extension's own world (ISOLATED world).
// So page scripts cannot see the marks (ref) Dool2 attaches. (Exception: only pageMarkTaps runs in the page world.)
// Caution: each function must not use outside variables (it is serialized to a string and run separately).
// Korean left on purpose (these functions are serialized into the page, so they cannot import region modules): snapshot words the daemon parses
// (role words like 버튼·입력칸·비밀번호칸, state suffixes, [그림 "..."], (화면에 보이는 칸), (추정), icon names), Korean-site regexes (survey, code, captcha,
// carrier, button words), and pageForm `label:` values shown on the phone (고르기, 통신사, 인증 앱, 닫기).

export interface SnapshotResult {
  url: string
  title: string
  text: string
  truncated: boolean
  refs: number
  /** A captcha / anti-automation screen is visible */
  captcha: boolean
  /** When read with view: the text left above and below the screen (approximate character count) */
  around?: { above: number; below: number }
  /** Characters skipped from the start by from/skip */
  skipped?: number
  /** The from text was not found on the page (read from the start) */
  fromMissing?: boolean
  /** Frame (iframe) boxes in this document (used to find frame positions, screen order, and [frame] placeholders in the text) */
  kids?: KidBox[]
  /** This document's (frame's) own size, and the outer box measured directly when same-origin */
  self?: FrameSelf
  /** Mark numbers came near the end of the range, so numbering restarted from the beginning (marks received earlier may point to other things) */
  renumbered?: boolean
  /** Number of clickable items that got no mark because the range (10,000) was full */
  refsCapped?: number
}

/** One frame inside a document (inner box relative to that document's visible viewport) */
export interface KidBox {
  /** Frame URL (src as a full address. '' if none) */
  src: string
  srcdoc: boolean
  name: string
  x: number
  y: number
  w: number
  h: number
  /** Has a size and is not hidden */
  shown: boolean
  /** Placeholder number in the text (the read text contains F{n} wrapped in the invisible separator U+2063) */
  marker?: number
}

/** The frame document itself: its size, and if same-origin its own box seen from the outer document (frameElement) */
export interface FrameSelf {
  w: number
  h: number
  owner?: { x: number; y: number; w: number; h: number }
}

/** Where to read. view: only the part visible now, from: from the line where this text appears, skip: skip this many characters from the start */
export interface ReadScope {
  view?: boolean
  from?: string
  skip?: number
}

/**
 * Runs in the page script world (MAIN world): puts a data-dool2-tap mark on boxes that only have React/Vue click handlers.
 * Mobile sites (Catch Table, etc.) build list rows and cards as div + onClick with no pointer cursor or role,
 * so there is no way to tell from the extension world whether they are clickable (handlers exist only on the page-script side).
 * It only puts a mark and clicks or reads nothing. If a site puts the same mark itself, it just looks like a button.
 */
export function pageMarkTaps(): number {
  const TAP = 'data-dool2-tap'
  const EVENTS = ['onClick', 'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp', 'onTouchEnd']
  const VUE = /^on(click|mousedown|mouseup|pointerdown|pointerup|touchend)/i
  const NATIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'BODY', 'HTML'])
  const hasTap = (el: Element): boolean => {
    const o = el as unknown as Record<string, unknown>
    for (const k of Object.keys(o)) {
      // React 17+: __reactProps$random = that element's props
      if (k.startsWith('__reactProps$')) {
        const p = o[k] as Record<string, unknown> | null
        if (p && EVENTS.some((e) => typeof p[e] === 'function')) return true
      }
      // Vue 3: _vei = attached handlers (onClick, etc.)
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

/** Turn the page into text the AI can read well. Clickable things get a mark like [e12 버튼 "검색"] */
/** base: frames (iframe) on the screen are numbered in steps of 10000 (frame 1 -> e10001...) */
export function pageSnapshot(maxChars: number, base = 0, scope: ReadScope = {}): SnapshotResult {
  type State = {
    refs: Map<string, WeakRef<Element>>
    ids: WeakMap<Element, string>
    seq: number
    /** Start of this document's mark range (frame n -> n*10000). Marking by text (pageMarkText) uses the same range */
    base?: number
    /** Fields filled by the Dool2 vault: the value is not put out as text */
    filled?: WeakSet<Element>
    /** Text before each mark at read time (compared just before clicking to see if it became a different field) */
    ctx?: Map<string, string>
    ctxOf?: (el: Element, max?: number) => string
  }
  const g = globalThis as unknown as { __dool2?: State }
  g.__dool2 ??= { refs: new Map(), ids: new WeakMap(), seq: 0 }
  const st = g.__dool2
  st.refs = new Map()
  st.base = base
  // Mark numbers are assigned only within one range (10,000) per document. Overflow would spill into the next frame range (e10000...)
  // and the daemon would read it as another frame's mark. If over 70% of the range is used, renumber from the start at the start of a read (and report it),
  // and if the range fills up during one read, stop marking and report how many could not be marked
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
  // First 300 characters before the element. On sites that recycle rows when a list scrolls (Catch Table store list), the same row
  // shows a different store: the date text ("11.27 (Fri) available") stays the same but the store name and description before it change
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
    // Double quotes are the boundary of the mark [e1 버튼 "name"], so replace them with single quotes
    const t = (s ?? '').replace(/\s+/g, ' ').replaceAll('"', "'").trim()
    return t.length > max ? `${t.slice(0, max - 1)}…` : t
  }

  /** A big box with separate clickable or typeable things inside (a tabindex/role box wrapping the whole page): not merged into one */
  const TAP = 'data-dool2-tap'
  /** A click box with text longer than this gets only a short name and the inside is still read */
  const LONG_TAP = 120
  const INNER =
    'input:not([type=hidden]),select,textarea,button,a[href],[role=button],[role=link],[role=textbox],[data-dool2-tap]'
  const wrapsControls = (el: Element) => {
    for (const c of el.querySelectorAll(INNER)) {
      // Decorative hidden fields do not count: a size-0 aria-hidden input inside <label role="radio" aria-label="홀">
      // (Catch Table table type). Treating it as a real field skipped the label, and the text inside vanished because it is aria-hidden
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
      // If a non-native role box contains fields or buttons, read the inside
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
    // Empty-slot hint text drawn by an editor ("Title", "Enter the body"): even if it is not a text field (input, contenteditable), it is a place to click and write.
    // Naver Blog (SmartEditor ONE) draws the title and body like pictures, and on click receives text into a hidden field in a frame.
    // Without a mark the AI did not know where to put text and could not enter it (measured 11-21). Hint text overlaid next to a field (a real field beside it) is excluded
    if (editorPlaceholder(el)) return '입력칸'
    if ((el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') && !wrapsControls(el))
      return '버튼'
    // Boxes with only React/Vue click handlers (list rows and store cards on mobile sites): pageMarkTaps marks them
    if (el.hasAttribute(TAP) && !wrapsControls(el)) return '버튼'
    // Text boxes given only a finger cursor (a "Log in with Kakao" div, etc.): short text counts as a button
    if (pointerBox(el)) return '버튼'
    return undefined
  }

  /** Empty-slot hint text in an editor: a short text box whose name (class) contains placeholder. Not it if a real field or button is beside it (in the parent) */
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

  /** Short boxes with a finger cursor (if a parent is a finger too, only the outermost one) */
  const POINTER_TAGS = new Set(['DIV', 'SPAN', 'LI', 'P', 'LABEL', 'IMG', 'DT', 'DD'])
  const pointerBox = (el: Element): boolean => {
    if (!POINTER_TAGS.has(el.tagName) || wrapsControls(el)) return false
    if (getComputedStyle(el).cursor !== 'pointer') return false
    const parent = el.parentElement
    if (parent && POINTER_TAGS.has(parent.tagName) && getComputedStyle(parent).cursor === 'pointer') {
      // If the parent is a short finger box, the parent is already the button
      const pt = (parent as HTMLElement).innerText?.trim() ?? ''
      if (pt.length > 0 && pt.length <= 40) return false
    }
    const t = (el as HTMLElement).innerText?.trim() ?? ''
    if (t.length > 40) return false
    return t.length > 0 || el.hasAttribute('aria-label') || el.querySelector('img[alt]') !== null
  }

  /** Short one-line text right after the element (or right after a parent wrapping only the element). Not used if other clickable things are inside */
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
        // Only name-like text (a quantity field "0", prices and symbols are not names)
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
      // If the element is the parent's only child, look after the parent (<div><a><img></a></div><span>name</span> rather than <li><a><img></a></li><li>...</li>)
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
    // Short text right after an image-only button or link (the name under an icon) counts as the name. Image descriptions (alt) are often wrong
    // (measured Hometax simple authentication: every app icon alt was "페이스북 로그인" or empty, so Kakao Bank was clicked instead of KakaoTalk)
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
    // From here on the name is not what is written on screen but what Dool2 guessed: add (추정) to the mark so the AI compares it with the screen
    const quantity = stepperName(el)
    if (quantity) return quantity
    const icon = iconName(el)
    if (icon) guessed = true
    return icon
  }
  /** Whether this mark's name is a guess (icon attributes) */
  let guessed = false

  /**
   * Quantity choice: only when a box has two unnamed buttons and one number: the first decreases, the second increases
   * (Catch Table add-ons, etc.). Boxes mixed with other text or buttons are not guessed
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

  /** Find the meaning of a text-less icon button from attributes (test id, class, icon name, svg title). '' if not found */
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
    // Text-less simple-login icons (measured Aladin: <a class="naver" href="javascript:goNaverLogin()">)
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
    // Also split camelCase like IconPlus and icMinus into words
    const hay = bits.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2')
    for (const [re, name] of ICONS) if (re.test(hay)) return name
    return ''
  }

  const extra = (el: Element): string => {
    if (st.filled?.has(el)) return ' 금고로 채워짐'
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? ' 선택됨' : ''
      if (el.type === 'password') return el.value ? ' 채워짐' : ''
      // File field: not a field to type text into; put files in with browser_upload
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
  // Text to be skipped must be read too to know where it starts (from: it is unknown where it is, so generous)
  let budget = scope.from ? Math.max((maxChars + skip) * 2, 400_000) : (maxChars + skip) * 2
  // view: boxes entirely above or below the screen are not read, only their characters are counted (fixed headers and popups are on screen so they are read)
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

  /** Items marked in this read (compared when separately collecting missing input fields) */
  const shownNow = new Set<Element>()
  /** Frames in this document: the extension fits each frame's screen position (nested frame coordinates) and lines them up in screen order */
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
    // Frame position: leave a placeholder at that spot in the text (the extension turns it into [frame f3]. Text inside the frame is appended below)
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
    // display: contents boxes have no box of their own, so checkVisibility is always false. The inside is visible, so keep reading
    // (the whole Catch Table search screen is inside such a box)
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
      // Long boxes with only a click handler (text paragraphs, whole cards): only mark them and read the text inside as is
      const long = el.hasAttribute(TAP) && ((el as HTMLElement).innerText?.trim().length ?? 0) > LONG_TAP
      guessed = false
      const name = long ? clean((el as HTMLElement).innerText, 30) : nameOf(el)
      const label = `${role}${name ? ` "${name}"` : ''}${guessed ? ' (추정)' : ''}${extra(el)}`
      // Items that could not be marked because the range is full still show in the text (and are reported as not clickable)
      cur += ref ? ` [${ref} ${label}] ` : ` (${label}) `
      if (!long) return
    }
    const block = BLOCK.has(el.tagName)
    if (block) flush()
    // If it is a popup with almost no text except buttons (a popup whose notice is drawn as an image), tell the AI to take a screenshot
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
            " [This window's notice is an image and cannot be read as text. Take a screenshot to see what it is] "
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
  // Input fields visible on screen but missing from the read: if a site wrongly puts aria-hidden on the box wrapping a field, it is dropped entirely
  // (measured financial certificate window 4user.yeskey.or.kr: the field below "휴대폰번호를 입력해주세요" was not visible, so Dool2 handed the PC screen over)
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
      // If the name is only an example like '예) 010-…', put the short text above the field (phone number) in front
      const own = nameOf(el) || el.getAttribute('placeholder') || ''
      const name = near && !own.includes(near) && near.length <= 20 ? `${near} ${own}`.trim() : own || near
      missed.push(`[${ref} ${role}${name ? ` "${clean(name, 40)}"` : ''}${extra(el)}]`)
    }
    if (missed.length) lines.push(`(화면에 보이는 칸) ${missed.join(' ')}`)
  }

  // Frames that stopped at the text limit or were inside hidden boxes and could not be passed are also included for position fitting (no marks in the text)
  const met = new Set(kids.map((k) => `${k.src}|${k.x}|${k.y}|${k.w}|${k.h}`))
  for (const f of Array.from(document.querySelectorAll('iframe, frame')).slice(0, 60)) {
    const k = kidOf(f as HTMLIFrameElement)
    if (!met.has(`${k.src}|${k.x}|${k.y}|${k.w}|${k.h}`)) kids.push(k)
  }
  // For a same-origin frame its own box seen from the outer document can be measured directly (including about:blank and srcdoc payment frames)
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
  // Captcha: only ones that really must be solved. The invisible reCAPTCHA (bottom-right badge, "protected by reCAPTCHA")
  // needs nothing from a person, yet this used to hand places like KT, CGV and LinkedIn over as "a person's turn"
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
    // The invisible reCAPTCHA frame (size=invisible) is not a problem
    return !/[?&]size=invisible/.test(src)
  })
  // Searching by text only on short screens (login, confirmation): on long screens (inbox, articles) the content mixes in those words
  // (Gmail inbox: the mail subject's '보안문자' made it look like a robot check)
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

/** point: coordinates only / type: focus + select existing text / activate: only focus so it can be pressed by keyboard */
export type LocateMode = 'point' | 'type' | 'activate'

export interface LocateResult {
  ok: true
  x: number
  y: number
  tag: string
  isPassword: boolean
  origin: string
  /** The tab is not painting (window occluded, screen off). Mouse input is dropped then */
  hidden: boolean
  /** activate: whether it got focus */
  focused?: boolean
  /** activate: an element pressed with Space, like a checkbox or radio */
  toggle?: boolean
  /** Something else covers that spot (a popup, etc.) */
  coveredBy?: string
  /** An element inside a frame (iframe) on the page (coordinates already converted to page viewport) */
  frame?: boolean
  /** It was off-screen and was scrolled into view (positions may shift from late-loading images or lists, so the caller measures again) */
  moved?: boolean
  /** What covers it is another button or link (only reached when called with force: the element is pressed directly instead of by mouse) */
  coveredByControl?: boolean
  /** Called with force but the surrounding text differed from the read (only reported) */
  ctxChanged?: { was: string; now: string }
  /** Off-screen even when scrolled (a window fixed at the bottom, etc.). y is the real position (uncut value) */
  outside?: boolean
  /** type: not a text field (input, textarea, contenteditable) - a spot drawn by an editor, so click it to give focus */
  drawn?: boolean
  /** type (drawn): text other than the hint text is already there (continue at the end) */
  filled?: boolean
  /** Bottom edge of the element box (relative to this document's viewport) */
  bottom?: number
}

/**
 * Find where to click by on-screen text: put a mark (ref) on the smallest visible element holding that text.
 * Some boxes like store cards have no link, button or finger cursor and are clicked only by site script (Catch Table search results).
 * Clicking the text element lets the click bubble up to the card, so the card is clicked
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
  if (!st) return { ok: false, error: 'Read the page first' }
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const want = norm(text)
  if (!want) return { ok: false, error: 'No text to click was given' }
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
    // If it is on screen but something else covers it (a map label behind a list window, etc.), it is not where to click: put it last
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const inView = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight
    const top = inView ? document.elementFromPoint(cx, cy) : null
    const covered = inView && !(top && (top === el || el.contains(top) || top.contains(el)))
    const rank = (exact ? 2 : 0) + (covered ? 0 : 4)
    if (!best || rank > best.rank || (rank === best.rank && area < best.area))
      best = { el, exact, area, rank }
  }
  if (!best) return { ok: false, error: `Could not find the text "${want}" on the screen` }
  let ref = st.ids.get(best.el)
  if (!ref) {
    // Numbered only within the mark range (10,000) (overflow would read as another frame's mark)
    if (st.seq >= 9_999) return { ok: false, error: 'The mark numbers are used up. Read the page again' }
    ref = `e${(st.base ?? 0) + ++st.seq}`
    st.ids.set(best.el, ref)
  }
  st.refs.set(ref, new WeakRef(best.el))
  return { ok: true, ref, name: norm((best.el as HTMLElement).innerText ?? '').slice(0, 60) }
}

/** Whether the leading text at read time (was) has disappeared from the current leading text (now): it means a different field was drawn.
 *  Added text is fine. If two of the last 6 words vanished it is a different field too (a field where only a short store name or description changed).
 *  (pageLocate has the same rule inside) */
export function ctxReplaced(was: string, now: string): boolean {
  if (now.endsWith(was)) return false
  const have = new Set(now.split(' '))
  const words = was.split(' ').filter((x) => x.length > 1)
  const gone = words.filter((x) => !have.has(x)).length
  const goneNear = words.slice(-6).filter((x) => !have.has(x)).length
  return (gone >= 3 && gone >= words.length * 0.2) || goneNear >= 2
}

/** Scroll the element the mark (ref) points to to the center of the screen and return coordinates */
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
    return { ok: false, error: `${ref} was not found. The screen may have changed, so read it again` }
  if (mode === 'type' && el instanceof HTMLInputElement && el.type === 'file')
    return { ok: false, error: `${ref} is a file field. Put PC files in with browser_upload instead of text` }
  // Elements with no box (display: contents buttons, etc.) measure as size 0: use the area of the children drawn inside
  // (Catch Table date/party window time buttons: visible on screen but could not be clicked as "not visible")
  const drawn = (e: Element) => {
    const b = e.getBoundingClientRect()
    return b.width > 0 && b.height > 0
  }
  // For hidden radios and checkboxes (size-0 input), click the wrapping label (Catch Table time field: <label><input radio><span>7:30 PM</span></label>)
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
  // Move horizontally only when needed: on horizontally paged calendars (Catch Table) centering made the site snap back at once,
  // so the date two cells over was clicked (clicked the 27th, got the 25th)
  anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
  // If something else was drawn in the same field after the read, do not click (store list field recycling: clicked Aseno's 27th and another store opened)
  // Added text (a 'clear' button or hint that appears after typing an ID) is fine. Only when text that was there at read time disappeared
  // is it treated as a different field being drawn (Musinsa / Kakao login: filling the ID lengthened the text before the password field and blocked filling).
  // Typing does not care about list field recycling, so it is not checked
  // (the rule equals ctxReplaced. This is a function put into the page and cannot call it separately, so it stays here as is)
  // The AI decides: tell it the text at read time and now, and if it judges them the same, have it call again with force
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
            error: `The text around ${ref} differs from when it was read (the list may have been redrawn). At read time: "…${ctxChanged.was}" / now: "…${ctxChanged.now}". Read again and choose. If it is really the same one, you can click with force: true`,
          }
      }
    }
  }
  const r = box()
  if (r.width === 0 || r.height === 0) return { ok: false, error: `${ref} is not visible on the screen` }
  // If it is off-screen even when scrolled (a window fixed at the bottom), report the real position so the caller stretches the viewport and measures again.
  // If only partly visible, click the center of the visible part (a spot cut at the screen edge may be something else)
  const W = window.innerWidth
  const H = window.innerHeight
  const outside = r.bottom <= 0 || r.top >= H || r.right <= 0 || r.left >= W
  const x = outside
    ? r.left + r.width / 2
    : Math.min(Math.max((Math.max(r.left, 0) + Math.min(r.right, W)) / 2, 1), W - 1)
  const y = outside
    ? r.top + r.height / 2
    : Math.min(Math.max((Math.max(r.top, 0) + Math.min(r.bottom, H)) / 2, 1), H - 1)
  // The topmost element at that spot: look down into open shadow DOM too (measuring in the document gave the shadow host and looked covered)
  let top: Element | null = outside ? null : document.elementFromPoint(x, y)
  for (let i = 0; top?.shadowRoot && i < 8; i++) {
    const inner = top.shadowRoot.elementFromPoint(x, y)
    if (!inner || inner === top) break
    top = inner
  }
  /** Whether a contains b (going up across shadow DOM boundaries) */
  const holds = (a: Element, b: Node | null): boolean => {
    for (let n: Node | null = b; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null)
      if (n === a) return true
    return false
  }
  let coveredBy: string | undefined
  let coveredByControl = false
  if (top && !holds(el, top) && !(label && holds(label, top)) && top.closest('label')?.control !== el) {
    coveredBy = ((top as HTMLElement).innerText || top.tagName).replace(/\s+/g, ' ').trim().slice(0, 60)
    // If what covers it is another button or link, do not click: clicking that spot would press the covering button
    // (Catch Table: a 'Reserve with this method' popup was over 'Next' on the payment method screen).
    // With force, tell it to click the element directly (keyboard or script) instead of by mouse
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
          error: `${ref} is covered by another button "${name}", so nothing was clicked. If it is a popup, close it first (Close or X) and read again. To click the element directly while covered, use force: true`,
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
    // Not a button or link: typing must not click it by accident (publish and send buttons are pressed only through an approval card)
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
      // A spot drawn by an editor: no script focus is given (the editor focuses its own field when clicked)
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

/** Whether the typed text is visible in this document's screen text (checked after typing into an editor-drawn spot). Blanks and zero-width characters are ignored */
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
 * Choices of a dropdown. A real select is read as is; for a styled list (role=combobox: card and installments on Coupang's payment screen),
 * a nearby hidden select is used if there is one, otherwise it is clicked open, the newly visible items are read, and it is closed again.
 * If it cannot be read, return why (the element shape) without options (kept in the activity log for fixing)
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
    // Use PointerEvent for pointer* (modern list components (Radix, etc.) ignore a pointerdown sent as MouseEvent. Measured Musinsa, Today's House)
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
   * Open the list. Click the box; if it does not open, click the wrapping field (...control); if it still does not open, give focus and press the down arrow
   * (measured Coupang: react-select. The visible box is the wrapping field and role=combobox is a hidden input, so clicking it does not open the list)
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
  // The real select hidden behind a styled list (a list that only changed the look)
  let up: Element | null = el
  for (let i = 0; i < 3 && up; i++, up = up.parentElement) {
    const sel = up.querySelector('select')
    if (sel && sel.options.length >= 2) return { options: fromSelect(sel) }
  }
  // opened: the daemon already opened it with the real mouse (what was visible before the click is kept by pageRememberShown)
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
  // A group of rows lined up in the same shape (if each row has several texts like "S" + "Arrives tomorrow guaranteed", the whole row is the item. Measured Musinsa)
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
  // If still none, the innermost of the newly visible text pieces (the one with only text)
  if (items.length < 2)
    items = fresh.filter((e) => {
      const t = norm(e.textContent)
      return !!t && t.length <= 60 && ![...e.children].some((c) => norm(c.textContent))
    })
  items = items.filter((e) => !items.some((o) => o !== e && e.contains(o)))
  const now = norm(el.getAttribute('aria-valuetext') || el.textContent || el.nextElementSibling?.textContent)
  const options = items.slice(0, 40).map((o) => {
    // innerText: put a space between text pieces inside a row ("S내일 도착" -> "S 내일 도착")
    const label = norm((o as HTMLElement).innerText || o.textContent).slice(0, 60)
    const selected =
      o.getAttribute('aria-selected') === 'true' ||
      /(?:^|[\s_-])(?:selected|active|is-selected|on|checked)(?:$|[\s_-])/i.test(o.className) ||
      (!!now && label === now)
    return { label, selected }
  })
  // Close the list that was opened
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
    why: `${shape(el)} < ${el.parentElement ? shape(el.parentElement) : ''} · after opening expanded=${el.getAttribute('aria-expanded')} newly visible elements ${fresh.length}: ${sample}`.slice(
      0,
      900,
    ),
  }
}

/** Before opening a list with the real mouse, keep what is visible now (so only what is newly visible after opening is read as the list) */
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
 * Screen position of the item with the same text in the opened list (the daemon clicks it with the real mouse).
 * The innermost of the newly visible ones first; if no same text, the one that starts with that text when there is only one
 */
export function pageOptionPoint(
  label: string,
): { ok: true; x: number; y: number; label: string } | { ok: false; error: string } {
  type State = { shownBefore?: Set<Element> }
  const before = (globalThis as unknown as { __dool2?: State }).__dool2?.shownBefore
  const norm = (x: string | null | undefined) => (x ?? '').replace(/\s+/g, ' ').trim()
  // innerText: put a space between text pieces inside a row ("S내일 도착" -> "S 내일 도착"). Same text as when reading the list
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
    // If the whole row text is the same, that row (the innermost row); otherwise the one with the same text piece; then the one that starts with that text if only one
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
  return { ok: false, error: `"${label}" was not found in the opened list` }
}

/** Choose the one with the same text in a dropdown (real and hidden selects get their value changed with input and change events; a styled list is opened and that item clicked) */
export async function pageSelectChoose(ref: string, label: string) {
  type State = { refs: Map<string, WeakRef<Element>> }
  const el = (globalThis as unknown as { __dool2?: State }).__dool2?.refs.get(ref)?.deref()
  const norm = (x: string | null | undefined) => (x ?? '').replace(/\s+/g, ' ').trim()
  const setSelect = (sel: HTMLSelectElement) => {
    const opt = [...sel.options].find((o) => !o.disabled && norm(o.textContent) === norm(label))
    if (!opt) return { ok: false, error: `"${label}" was not found in the list` }
    sel.value = opt.value
    opt.selected = true
    sel.dispatchEvent(new Event('input', { bubbles: true }))
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, label: norm(opt.textContent) }
  }
  if (el instanceof HTMLSelectElement) return setSelect(el)
  if (!(el instanceof HTMLElement)) return { ok: false, error: `${ref} is not a dropdown list` }
  // If it is the real select hidden behind a styled list, change its value (same order as when reading)
  let up: Element | null = el
  for (let i = 0; i < 3 && up; i++, up = up.parentElement) {
    const sel = up.querySelector('select')
    if (sel && sel.options.length >= 2) return setSelect(sel)
  }
  const press = (t: Element) => {
    // Use PointerEvent for pointer* (modern list components (Radix, etc.) ignore a pointerdown sent as MouseEvent. Measured Musinsa, Today's House)
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
    // Open in the same order as when reading: box -> wrapping field -> down arrow
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
  // As when reading, among the newly visible ones the innermost with the same text (if it is an aria-controls list that is always in the DOM, all the visible ones)
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
    return { ok: false, error: `"${label}" was not found in the list` }
  }
  press(opt)
  await new Promise((r) => setTimeout(r, 250))
  return { ok: true, label: norm(opt.textContent) }
}

/** Last resort: click an element that cannot take focus from inside the page */
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
 * Number of input fields and buttons that were pushed off the right edge and cut off when drawn at phone width.
 * Finds PC windows with a fixed width (Gov24 simple authentication frame: name, birth date and [Request authentication] go beyond 412px).
 * Things hidden on purpose are not counted: horizontally paged lists (inside a clipping box), drawer menus entirely outside (no straddling box)
 */
export function pageCutOff() {
  const PICK =
    'input:not([type="hidden"]), button, select, textarea, a[href], [role="button"], [role="radio"]'
  const count = (doc: Document, win: Window): number => {
    const vw = win.innerWidth
    let n = 0
    // Wide pages that can be swiped horizontally (the first screen of a PC shopping site) stay as they are. Only things cut off so they cannot even be pushed are counted
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
    // Inside a same-origin frame too (the simple authentication window is a frame). Frames at another address cannot be read and are skipped
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
  // When drawn at phone width a wide page looks shrunk like on a phone: the actually visible area (visualViewport) too
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

/** Mark a field as filled by the Dool2 vault (so the value does not go out in later page reads) */
/** Number of characters actually in the field (to see whether the vault value was cut. The value is not returned) */
/** Number of characters in the field that has focus now (to check whether a value entered via the remote "only needed fields" went in). -1 if not a field */
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
  // Count only letters and digits: separators the field adds itself (010-1234-..., 1999 / 08 / 10) are not truncation
  // (passwords are counted as is because we need to see whether symbols were dropped)
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
    return alnum ? el.value.replace(/[^0-9A-Za-z\uAC00-\uD7A3]/g, '').length : el.value.length
  return -1
}

/** Screen position of one mark (relative to this frame). For cutting out and viewing picture-only items one at a time, like keypad buttons */
export function pageRect(ref: string): { x: number; y: number; w: number; h: number } | undefined {
  type State = { refs: Map<string, WeakRef<Element>> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  if (!el) return undefined
  const r = el.getBoundingClientRect()
  return r.width > 2 && r.height > 2 ? { x: r.left, y: r.top, w: r.width, h: r.height } : undefined
}

/**
 * Captcha picture candidates: pictures and canvases around the field (3 nearest), the box wrapping the field, and a strip above the field.
 * It does not choose which is the captcha - they are cut out and shown to the AI, and the AI chooses (screen-view coordinates, relative to this frame)
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
    out.push({
      x: r.left - 4,
      y: r.top - 4,
      w: r.width + 8,
      h: r.height + 8,
      what: 'picture around the field',
    })
  let box: Element | null = el.parentElement
  let rect: DOMRect | undefined
  for (let i = 0; box && i < 6; box = box.parentElement, i++) {
    const b = box.getBoundingClientRect()
    if (b.width > 760 || b.height > 360) break
    if (b.height >= q.height + 30) rect = b
  }
  if (rect)
    out.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height, what: 'box wrapping the field' })
  const top = Math.max(0, q.top - 140)
  out.push({
    x: Math.max(0, q.left - 40),
    y: top,
    w: Math.min(q.width + 320, 680),
    h: q.bottom - top + 8,
    what: 'above the field',
  })
  return out.filter((r) => r.w > 8 && r.h > 8)
}

/**
 * Whether a link only goes to another screen: only when it goes to a real address (http) and has no script run on click (onclick).
 * javascript:, # and onclick links can do anything like a button, so they count as no (used by the approval gate)
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
    // Only a same-page jump (#) differing is not navigation
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
  // Take focus off the field. If a password field keeps focus, Chrome's password suggestion window appears
  // and swallows the next click (the login button) (measured)
  ;(el as HTMLElement).blur()
  return true
}

/**
 * Where it was tapped on the remote screen (phone): used when the window is occluded and mouse input is dropped.
 * Give focus to the element at that spot (if it is an input field, that is all), otherwise click it. To the site it looks like a script click
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
 * What to send along to the remote screen (phone): visible input field spots, buttons worth clicking, and the field where text goes now.
 * Spots are ratios of the screen (0-1). Text in password fields is not sent
 */
export function pageRemoteInfo() {
  // Spots are ratios of the visible area (visualViewport): same basis as the image sent to the phone
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
    // Leave out buttons covered by something else
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

/** After tapping a field remotely: put the caret at the end of the field so continuing to write is easy */
export function pageCaretEnd() {
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      const n = el.value.length
      el.setSelectionRange(n, n)
    } catch {
      // Number and email fields cannot move the caret
    }
  }
}

/** As far as a finger dragged on the remote screen (for occluded windows): starting from the scrollable box at that spot */
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

// ── Remote screen "only needed fields": pull from the page the fields a person fills, the things to choose and the buttons to click ──
// The phone redraws these as phone input fields, and the values written are put into the real fields with pageFormFill.
// Text in password fields is not sent out

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
   * Whether the field is covered by another window (captcha, notice popup, frame). Showing a covered field on the phone makes the user fill the wrong field
   * (a Kakao Map captcha floated over the login field, yet the login field was shown)
   */
  const covered = (el: Element) => {
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false
    const top = document.elementFromPoint(x, y)
    if (!top || top === el || el.contains(top) || top.contains(el)) return false
    if ([...((el as HTMLInputElement).labels ?? [])].some((l) => l === top || l.contains(top))) return false
    // If what covers it is a popup (fixed position or dialog) or inside a frame, it is covered. Placeholder text laid over the field is not
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
   * If a window is open now (a fixed window or dialog covering the center), look only at fields inside it. Showing page fields behind it (a satisfaction survey, a search field)
   * on the phone shows the user the wrong fields (Gov24: instead of the member / non-member window the survey at the bottom of the page appeared).
   * If what covers the center is a frame, report that the frame's inside should be looked at (the simple authentication window)
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
        // An app shell wrapping the whole screen is not a window
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
  // The satisfaction survey and feedback fields at the end of a page are not something a person should do
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
  // An English variable name (MinfoEstCheck) is not a name to show a person
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
    // The short text right before (a title on the same line)
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
  // Text fields
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
  // Choice: select
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
  // Choice: radio group
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
  // Choice: carrier buttons (many sites build them as buttons, not form fields)
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
  // Choice: picture tiles (simple-authentication apps KakaoTalk, Naver, Toss...). Only inside an open window or frame, so they are not confused with the product list of the whole page
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
  // Checks (terms agreement, etc.). Many sites hide the real field and show only the label, so the label is looked at too
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
  // Captcha picture: attach to each 'captcha' field the picture nearest to that field.
  // When the first picture whose name contained 'security' was used, the PASS logo of an identity check window was cut out and sent (measured Korea Mobile Authentication) -
  // the picture name is only a hint; choose by distance to the field
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
      // Distance between the field and the picture edge (above, left, or on the same line, anywhere)
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
    // No picture tag found (background image, canvas, picture in a frame): capture the whole box wrapping the field.
    // If it is too big (the whole window), capture only 120px above the field and the field's row (measured identity check window: the captcha picture was not visible at all)
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
  // In the order they appear on the page (since text fields, choices and checks were collected separately)
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
  // Buttons to click
  const buttons: { id: string; label: string; main?: boolean }[] = []
  const seen = new Set<string>()
  const MAIN =
    /^(다음|확인|로그인|인증|인증번호\s*(받기|요청|전송)|본인\s*인증|완료|동의|신청|제출|계속|조회|등록|next|ok|continue|submit|sign in|log in)/i
  // Inside an open window, text links are buttons too (Gov24 'Apply as non-member' is a plain link with no decoration)
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
    // Header, menu and footer buttons (Gov24, full menu, share) have nothing to do with the task
    if (
      !main &&
      el.closest('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')
    )
      continue
    // A close name wrongly put on by a site, like '공동인증서 등록 레이어 닫기', becomes '닫기'
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

/** What was chosen on the phone: scroll the real field to the center of the screen and report the position (relative to the visible screen, CSS pixels) */
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
  // Hidden checks and radios click the label
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
 * After clicking a check or radio, if it is still not in the wanted state, click the label (the text on the same line).
 * Some screens cover the field transparently and check only through the text beside it (measured Kakao consent: checking on the phone left the PC unchanged)
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

/** Clear a text field and focus it (the extension then types as with real key input) */
export function pageFormFocus(id: string) {
  const st = (globalThis as unknown as { __dool2form?: { els: Map<string, WeakRef<Element>> } }).__dool2form
  const el = st?.els.get(id)?.deref()
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false
  el.focus()
  el.select?.()
  return true
}

/** Captcha picture position (document-based -> relative to the screen visible now) */
export function pageScrollToDoc(x: number, y: number) {
  window.scrollTo({ left: Math.max(0, x - 40), top: Math.max(0, y - 120), behavior: 'instant' })
  return { sx: window.scrollX, sy: window.scrollY }
}

// ── Connector engine actions (ADR 0018): pulling lists and finding text (reading responses the page received is capture in background.ts) ──
// Connectors (tools.json) are data, so only what to pull is passed and the real work is done by fixed functions here.

/** How to pull one field */
export interface ExtractField {
  /** Selector to find inside a row (item). The row itself if none */
  css?: string
  /** Attribute to read (href and src as full addresses, '@center' is the center spot on screen "x,y"). Visible text if none */
  attr?: string
  /** Split the text into lines and take the nth (from 0, negative from the end) */
  line?: number
  /** Regex. Group 1 if there is one, otherwise the whole match */
  match?: string
  /** All that match the css (a list of texts) */
  list?: boolean
  /** The text as is, without trimming or cutting (for reading JSON embedded in the screen) */
  raw?: boolean
  /** The single most likely photo address (including late-drawn photos and background images, without icons and logos, as https) */
  image?: boolean
}
export interface ExtractSpec {
  /** Selector of the list's rows (items) */
  items: string
  fields: Record<string, ExtractField>
  /** Search only inside this */
  within?: string
  limit?: number
  /** Also invisible elements (data inside a script, etc.) */
  hidden?: boolean
}
export type ExtractValue = string | string[] | null
export type ExtractResult =
  | { ok: true; rows: Record<string, ExtractValue>[]; total: number; url: string }
  | { ok: false; error: string }

/** Pull the on-screen list field by field (invisible rows are skipped). Only reads and clicks nothing */
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
      throw new Error(`Bad selector: ${sel}`)
    }
  }
  try {
    let root: ParentNode = document
    if (spec.within) {
      const w = q(document, spec.within, false)[0]
      if (!w) return { ok: false, error: `The "${spec.within}" area is not on the screen` }
      root = w
    }
    const res: Record<string, RegExp | undefined> = {}
    for (const [k, f] of Object.entries(spec.fields)) {
      try {
        res[k] = f.match ? new RegExp(f.match) : undefined
      } catch {
        return { ok: false, error: `Bad regex for ${k}: ${f.match}` }
      }
    }
    const read = (el: Element, f: ExtractField, re: RegExp | undefined): string | null => {
      let v: string | null
      if (f.attr === '@center') {
        // Center spot on screen "x,y" (CSS pixels): when clicking a picture tile that has no button mark (Flow video list)
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
    // Choosing a photo: sites draw late in different ways, so look at every place an address might be
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
    // srcset: choose a size suited to the phone card (around 400px)
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
        // If the drawn size is known, drop very small pictures (icons). If not drawn yet (0), take it for now
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
          // If src is a transparent image or placeholder, the late-inserted address first
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

/** Scroll the nth row of the list to the center of the screen (so late-drawn photos load). Returns the row count. n of -1 means the top */
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

/** Whether these words are in the screen text (regexes, several). Used for waiting and screen checks */
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
 * Briefly show on the page where Dool2 clicks or types (so the working screen and Chrome show what it is doing).
 * It takes no mouse input (pointer-events: none) and is left out of reads too (aria-hidden, outside body). Disappears after 2.5 seconds
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

// ── Measuring frame (iframe) position ──
// To click an element in a frame, you must know where that frame is drawn on the page viewport. If a frame is inside a frame
// (payment screen -> add delivery address window -> address search window), measure the frame box in the outer document at each step and add them up.
// It used to find it only by address in the outermost document, and if not found clicked (0,0), so the wrong place was quietly clicked (measured 11-20 Gmarket address search)

/**
 * Inside a frame document: its own size, and if same-origin so the outer document can be seen, its own box (frameElement).
 * Given py (vertical position of the spot to click relative to this frame's viewport), scroll the outer one so that spot is visible on the outer screen, then measure
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
 * In the outer document: the frame box whose address is url and inner size is w x h (relative to this document's viewport).
 * Score by address (full -> address+path -> origin) and size; if one is settled, that box; if several tie, ambiguous;
 * undefined if none. Given pick (the index the viewed frame told us), that frame. Given py, scroll so that spot is visible, then measure
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
    // If the address changed inside the frame (payment step moved), it differs from src: match by size
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

/** Telling apart several look-alike frames: the outer document waits for a message, and the sending window leaves its index */
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

// ── Whether a click reached ──
// Check directly inside the page whether real mouse input reached that element. This prevents buttons whose screen does not change (keypad digits)
// from being reported "not clicked" and clicked again so the digit went in twice (measured Coupang payment PIN, 7 digits)

/** Set just before clicking: record when a pointerdown, mousedown or click that came as human input (isTrusted) reaches that element */
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
/** Read and remove what was set. armed: whether it was set (false if the document changed) */
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

// ── What changed (whether to click again after a click, and waiting) ──

/** Set document change counting (separately per key: so clicking and waiting do not turn each other off) */
export function pageMutArm(key: string): boolean {
  type Box = { n: number; added: number; removed: number; attrs: number; text: string; o: MutationObserver }
  const g = globalThis as unknown as { __dool2mut?: Record<string, Box> }
  g.__dool2mut ??= {}
  g.__dool2mut[key]?.o.disconnect()
  const mine = (n: Node | null) => {
    // Dool2 cursor and marks are not counted
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
/** Read the counts (turn off if stop). n: -1 if it was not set */
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

// ── Scroll target ──

/**
 * The box to scroll: with ref, that element (or the scrolling box containing it); without, the document.
 * Given dir (occluded window), scroll that box inside the page. Returns the position, whether it reached the end, and the center spot to roll the wheel at
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
    if (!el) return { ok: false, top: 0, max: 0, h: 0, x: 0, y: 0, box: false, error: `${ref} was not found` }
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

// ── Element photo ──

/** After scrolling the element to be captured into view, the box and status (missing: none, zeroSize: size 0, offscreen: off-screen even when scrolled) */
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

// ── Blocked new windows (popup blocking) ──
// A payment window is opened by window.open after a round trip to the server following the click, and then Chrome blocks it because it is not the moment a person clicked
// (measured 11-20 Gmarket card payment: the screen stayed white). Only in Dool2 tabs, window.open is watched in the page world (MAIN).
// It neither performs nor blocks the opening: it only records the called address, the time and whether no window was returned, and the extension compares whether a new tab really opened

/** Runs in the page world (MAIN): record window.open calls (once per document) */
export function pageHookOpen(): boolean {
  const w = window as unknown as {
    open: typeof window.open
    __dool2opens?: { url: string; at: number; none: boolean }[]
  }
  if (w.__dool2opens) return false
  const log: { url: string; at: number; none: boolean }[] = []
  // Not enumerable (so it is hard to see even if the page sweeps window)
  Object.defineProperty(w, '__dool2opens', { value: log, enumerable: false })
  const orig = w.open
  // A Proxy wrapping the original function: name, argument count and this stay the same
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
/** Page world (MAIN): take away the recorded window.open calls and clear them */
export function pageReadOpens(): { url: string; at: number; none: boolean }[] {
  const w = window as unknown as { __dool2opens?: { url: string; at: number; none: boolean }[] }
  const log = w.__dool2opens ?? []
  return log.splice(0, log.length)
}

// ── Uploading PC files (browser_upload) ──
// If the mark (ref) is a file field, that field; if a button or label, find its attached file field. If the extension can insert by path (CDP), only a mark is put,
// and if not, the chunks the daemon sent are collected and built into a file inside the page. The three below do not use outside things so they run
// anywhere: the extension world (executeScript) or the page world (Runtime.callFunctionOn, this = the file field)

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
 * Find the field to upload to: that field -> the field a label points to -> the one field inside. With near, also the single field in a nearby box (up to 4 levels up)
 * (only when clicking the button opens no chooser: so a far-away other field is not chosen by mistake)
 */
export function pageUploadTarget(ref: string, token: string, near: boolean): UploadTarget {
  type State = { refs: Map<string, WeakRef<Element>> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  if (!el?.isConnected)
    return { ok: false, error: `${ref} was not found. The screen may have changed, so read it again` }
  const isFile = (e: unknown): e is HTMLInputElement => e instanceof HTMLInputElement && e.type === 'file'
  /** Collect file fields, including inside open shadow DOM */
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
      // If there are several fields it is unknown which: use the chooser that opens on click
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

/** Receive one file chunk (base64). Returns the number of chunks received */
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
 * Build a file from the collected chunks, put it into the field and fire input and change (same as a person choosing the file).
 * If this is a file field (page world), into it; otherwise into the field pageUploadTarget found
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
  if (!input) throw new Error('The file field is gone. Read the page again')
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

/** After inserting, the file name in the field (when inserted by path). The mark is also cleared */
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

/**
 * browser_save_pdf prints only the document a viewer shows, not the viewer (ADR 0045 follow-up). A certificate viewer
 * drew the page on one canvas between a toolbar and a [Close] button, and printing the whole tab put both into the
 * PDF (test PC 11-27). This lays copies of the document's page elements (the canvases, images or SVGs that make up
 * the pages, or the element `ref` names) one per A4 sheet in a box only the print view shows. pagePrintCleanup takes
 * it away again. Returns how many pages went in (0: nothing that looks like a document, print the whole page)
 */
export function pagePrintPrepare(ref: string | null): { count: number; what: string } {
  type State = { refs: Map<string, WeakRef<Element>> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect()
    const cs = getComputedStyle(e)
    return r.width > 80 && r.height > 80 && cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  const area = (e: Element) => {
    const r = e.getBoundingClientRect()
    return r.width * r.height
  }
  let picks: Element[] = []
  if (ref) {
    const el = st?.refs.get(ref)?.deref()
    if (el) picks = [el]
  } else {
    const all = [...document.querySelectorAll('canvas, img, svg, embed, object')].filter(shown)
    const big = [...all].sort((a, b) => area(b) - area(a))[0]
    if (big && area(big) >= 0.2 * innerWidth * innerHeight) {
      const w = big.getBoundingClientRect().width
      // A document of several pages: the elements like the biggest one (same kind and width), in page order
      picks = all.filter(
        (e) =>
          e.tagName === big.tagName &&
          Math.abs(e.getBoundingClientRect().width - w) <= w * 0.1 &&
          area(e) >= area(big) * 0.5,
      )
    }
  }
  if (!picks.length) return { count: 0, what: '' }
  document.getElementById('dool2-print-only')?.remove()
  document.getElementById('dool2-print-style')?.remove()
  const box = document.createElement('div')
  box.id = 'dool2-print-only'
  for (const el of picks) {
    let copy: Element
    if (el instanceof HTMLCanvasElement) {
      // A copied canvas is blank: draw the original's pixels into it at full resolution
      const c = document.createElement('canvas')
      c.width = el.width
      c.height = el.height
      c.getContext('2d')?.drawImage(el, 0, 0)
      copy = c
    } else copy = el.cloneNode(true) as Element
    const sheet = document.createElement('div')
    sheet.className = 'dool2-print-page'
    sheet.appendChild(copy)
    box.appendChild(sheet)
  }
  const style = document.createElement('style')
  style.id = 'dool2-print-style'
  style.textContent = [
    '@media screen { #dool2-print-only { display: none !important } }',
    '@media print {',
    '@page { size: A4; margin: 0 }',
    'html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; height: auto !important; overflow: visible !important }',
    'body > *:not(#dool2-print-only) { display: none !important }',
    '#dool2-print-only { display: block !important }',
    '.dool2-print-page { width: 210mm; height: 296mm; display: flex; align-items: center; justify-content: center; overflow: hidden; break-after: page }',
    '.dool2-print-page:last-child { break-after: auto }',
    '.dool2-print-page > * { max-width: 100% !important; max-height: 100% !important; width: auto !important; height: auto !important; object-fit: contain }',
    '}',
  ].join('\n')
  document.head.appendChild(style)
  document.body.appendChild(box)
  return { count: picks.length, what: picks[0]?.tagName.toLowerCase() ?? '' }
}

/** Takes away what pagePrintPrepare added */
export function pagePrintCleanup(): void {
  document.getElementById('dool2-print-only')?.remove()
  document.getElementById('dool2-print-style')?.remove()
}

/**
 * Before Dool2 presses a site's own print button (browser_save_pdf with print): catch the print the site asks for
 * instead of opening Chrome's print window, so what the site prints can be kept as the file. A certificate viewer
 * builds a print PDF in a hidden frame and prints that frame; printing the viewer page itself only gave a picture of
 * the screen (test PC 11-27). Runs in the page's own world, in every frame. pagePrintTake reads what was asked and
 * puts everything back
 */
export function pagePrintHook(): void {
  type Call = { kind: 'window' | 'iframe' | 'open'; src?: string; id?: string; url?: string }
  type St = { calls: Call[]; restore: (() => void)[] }
  const w = window as unknown as Window & { __dool2Print?: St }
  if (w.__dool2Print) return
  const st: St = { calls: [], restore: [] }
  w.__dool2Print = st
  const origPrint = w.print
  w.print = () => {
    st.calls.push({ kind: 'window' })
  }
  st.restore.push(() => {
    w.print = origPrint
  })
  // A site that prints a frame calls frame.contentWindow.print(): catch it on the way
  const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')
  if (d?.get) {
    const get = d.get
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      enumerable: d.enumerable ?? true,
      get(this: HTMLIFrameElement) {
        const win = get.call(this) as (Window & { __dool2Hooked?: boolean }) | null
        if (win && !win.__dool2Hooked) {
          try {
            win.print = () => {
              st.calls.push({ kind: 'iframe', src: this.src, id: this.id })
            }
            win.__dool2Hooked = true
          } catch {}
        }
        return win
      },
    })
    st.restore.push(() => Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', d))
  }
  // A site that opens the print copy in a new window: note where, and let it open
  const origOpen = w.open
  w.open = function (this: Window, ...args: Parameters<Window['open']>) {
    st.calls.push({ kind: 'open', url: String(args[0] ?? '') })
    return origOpen.apply(this, args)
  }
  st.restore.push(() => {
    w.open = origOpen
  })
}

/**
 * What pagePrintHook caught: the file the site would print (a PDF in a frame or a new window, fetched as the page
 * fetches it), or 'page' when the site printed this page itself. Puts the page's own print and frames back
 */
export async function pagePrintTake(): Promise<{
  calls: number
  via?: 'frame' | 'window' | 'page' | 'frame-page'
  data?: string
  type?: string
  error?: string
}> {
  type Call = { kind: 'window' | 'iframe' | 'open'; src?: string; id?: string; url?: string }
  type St = { calls: Call[]; restore: (() => void)[] }
  const w = window as unknown as Window & { __dool2Print?: St }
  const st = w.__dool2Print
  if (!st) return { calls: 0 }
  const done = () => {
    for (const r of st.restore.splice(0)) r()
    delete w.__dool2Print
  }
  const call = st.calls[0]
  if (!call) return { calls: 0 }
  const b64 = (buf: ArrayBuffer) => {
    const b = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
    return btoa(s)
  }
  const grab = async (url: string) => {
    const r = await fetch(url)
    return { type: r.headers.get('content-type') ?? '', data: b64(await r.arrayBuffer()) }
  }
  try {
    if (call.kind === 'iframe') {
      const el =
        (call.id ? (document.getElementById(call.id) as HTMLIFrameElement | null) : null) ??
        [...document.querySelectorAll('iframe')].find((f) => f.src === call.src)
      let url = el?.src || call.src || ''
      if (!url || url === 'about:blank') {
        const inner = el?.contentDocument?.querySelector('embed[src], object[data], iframe[src]')
        url = inner?.getAttribute('src') || inner?.getAttribute('data') || ''
      }
      if (url && url !== 'about:blank') return { calls: st.calls.length, via: 'frame', ...(await grab(url)) }
      return { calls: st.calls.length, via: 'frame-page' }
    }
    if (call.kind === 'open' && call.url)
      return { calls: st.calls.length, via: 'window', ...(await grab(new URL(call.url, location.href).href)) }
    return { calls: st.calls.length, via: 'page' }
  } catch (e) {
    return { calls: st.calls.length, error: (e as Error).message }
  } finally {
    done()
  }
}

/** Puts a page's own print back without taking anything (browser_save_pdf gave up waiting) */
export function pagePrintUnhook(): void {
  const w = window as unknown as Window & { __dool2Print?: { restore: (() => void)[] } }
  for (const r of w.__dool2Print?.restore.splice(0) ?? []) r()
  delete w.__dool2Print
}

/**
 * A frame printed itself (a viewer whose document sits in an inner frame, test PC 11-27: the government portal's
 * resident certificate). Chrome can print only the top page, so the frame's document is copied into a box only the
 * print view shows, with its own styles (its print rules too) and its canvases' pixels; pagePrintCleanup takes it
 * away. Same-origin frames only. Returns whether the frame was found
 */
export function pagePrintFrameCopy(href: string): boolean {
  const find = (w: Window): Document | null => {
    for (let i = 0; i < w.frames.length; i++) {
      try {
        const f = w.frames[i] as Window
        if (f.location.href === href) return f.document
        const deeper = find(f)
        if (deeper) return deeper
      } catch {}
    }
    return null
  }
  const doc = find(window)
  if (!doc?.body) return false
  document.getElementById('dool2-print-only')?.remove()
  document.getElementById('dool2-print-style')?.remove()
  const box = document.createElement('div')
  box.id = 'dool2-print-only'
  for (const s of doc.querySelectorAll('style, link[rel~="stylesheet"]')) {
    const c = s.cloneNode(true) as HTMLElement
    if (c instanceof HTMLLinkElement) c.href = (s as HTMLLinkElement).href
    box.appendChild(c)
  }
  const body = doc.body.cloneNode(true) as HTMLElement
  // Copied canvases are blank: draw the originals' pixels in, in the same order
  const from = [...doc.body.querySelectorAll('canvas')]
  const to = [...body.querySelectorAll('canvas')]
  to.forEach((c, i) => {
    const o = from[i]
    if (!o) return
    c.width = o.width
    c.height = o.height
    c.getContext('2d')?.drawImage(o, 0, 0)
  })
  // Relative image and link addresses resolve against the frame, not this page
  for (const el of body.querySelectorAll('img[src]'))
    (el as HTMLImageElement).src = (el as HTMLImageElement).src
  const inner = document.createElement('div')
  inner.className = doc.body.className
  inner.append(...body.childNodes)
  box.appendChild(inner)
  const style = document.createElement('style')
  style.id = 'dool2-print-style'
  style.textContent = [
    '@media screen { #dool2-print-only { display: none !important } }',
    '@media print {',
    'html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; height: auto !important; overflow: visible !important }',
    'body > *:not(#dool2-print-only) { display: none !important }',
    '#dool2-print-only { display: block !important }',
    '}',
  ].join('\n')
  document.head.appendChild(style)
  document.body.appendChild(box)
  return true
}
