// 페이지 안에서 도는 함수들. chrome.scripting.executeScript로 확장 전용 공간(ISOLATED world)에 넣는다.
// 그래서 페이지 스크립트는 두리가 붙인 표시(ref)를 볼 수 없다.
// 주의: 각 함수는 바깥 변수를 쓰면 안 된다 (문자열로 옮겨져 따로 실행된다).

export interface SnapshotResult {
  url: string
  title: string
  text: string
  truncated: boolean
  refs: number
  /** 캡차·자동입력 방지 화면이 보인다 */
  captcha: boolean
}

/** 페이지를 AI가 읽기 좋은 글로 바꾼다. 누를 수 있는 것에는 [e12 버튼 "검색"]처럼 표시를 붙인다 */
export function pageSnapshot(maxChars: number): SnapshotResult {
  type State = {
    refs: Map<string, WeakRef<Element>>
    ids: WeakMap<Element, string>
    seq: number
    /** 두리 금고가 채운 칸: 값을 글로 내보내지 않는다 */
    filled?: WeakSet<Element>
  }
  const g = globalThis as unknown as { __dool2?: State }
  g.__dool2 ??= { refs: new Map(), ids: new WeakMap(), seq: 0 }
  const st = g.__dool2
  st.refs = new Map()

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
  const INNER =
    'input:not([type=hidden]),select,textarea,button,a[href],[role=button],[role=link],[role=textbox]'
  const wrapsControls = (el: Element) => el.querySelector(INNER) !== null

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
    return undefined
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
    return clean(
      el.getAttribute('placeholder') ??
        el.getAttribute('title') ??
        img?.getAttribute('alt') ??
        el.getAttribute('name'),
    )
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
    if ((el as HTMLButtonElement).disabled) return ' 비활성'
    return ''
  }

  const lines: string[] = []
  let cur = ''
  const flush = () => {
    const t = cur.replace(/\s+/g, ' ').trim()
    if (t && t !== lines[lines.length - 1]) lines.push(t)
    cur = ''
  }
  let budget = maxChars * 2

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
    if (!el.checkVisibility({ visibilityProperty: true })) return

    const role = interactiveRole(el)
    if (role) {
      let ref = st.ids.get(el)
      if (!ref) {
        ref = `e${++st.seq}`
        st.ids.set(el, ref)
      }
      st.refs.set(ref, new WeakRef(el))
      const name = nameOf(el)
      cur += ` [${ref} ${role}${name ? ` "${name}"` : ''}${extra(el)}] `
      return
    }
    const block = BLOCK.has(el.tagName)
    if (block) flush()
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

  let text = lines.join('\n')
  const truncated = text.length > maxChars || budget <= 0
  if (text.length > maxChars) text = text.slice(0, maxChars)

  const bodyText = document.body?.innerText ?? ''
  const captcha =
    Boolean(
      document.querySelector(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], [class*="captcha" i], [id*="captcha" i], img[src*="captcha" i]',
      ),
    ) || /자동입력\s*방지|보안\s*문자|로봇이 아닙니다|I'm not a robot/i.test(bodyText)

  return { url: location.href, title: document.title, text, truncated, refs: st.refs.size, captcha }
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
}

/** 표시(ref)가 가리키는 요소를 화면 가운데로 옮기고 좌표를 돌려준다 */
export function pageLocate(ref: string, mode: LocateMode): LocateResult | { ok: false; error: string } {
  type State = { refs: Map<string, WeakRef<Element>> }
  const st = (globalThis as unknown as { __dool2?: State }).__dool2
  const el = st?.refs.get(ref)?.deref()
  if (!el || !el.isConnected)
    return { ok: false, error: `${ref}를 찾을 수 없어요. 화면이 바뀌었을 수 있으니 다시 읽어 주세요` }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return { ok: false, error: `${ref}가 화면에 보이지 않아요` }
  const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1)
  const y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1)
  const top = document.elementFromPoint(x, y)
  let coveredBy: string | undefined
  if (top && top !== el && !el.contains(top) && !(top instanceof HTMLLabelElement && top.control === el)) {
    coveredBy = ((top as HTMLElement).innerText || top.tagName).replace(/\s+/g, ' ').trim().slice(0, 60)
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
