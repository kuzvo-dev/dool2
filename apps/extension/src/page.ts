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
  type State = { refs: Map<string, WeakRef<Element>>; ids: WeakMap<Element, string>; seq: number }
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

  const interactiveRole = (el: Element): string | undefined => {
    const role = el.getAttribute('role')
    if (role && ROLES[role]) return ROLES[role]
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
    if (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') return '버튼'
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

export interface LocateResult {
  ok: true
  x: number
  y: number
  tag: string
  isPassword: boolean
  origin: string
  /** 그 자리를 다른 것이 덮고 있다 (팝업 등) */
  coveredBy?: string
}

/**
 * 표시(ref)가 가리키는 요소를 화면 가운데로 옮기고 좌표를 돌려준다.
 * focus면 입력할 수 있게 초점을 주고 기존 글자를 선택한다(새 글자로 바뀐다).
 */
export function pageLocate(ref: string, focus: boolean): LocateResult | { ok: false; error: string } {
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
  if (focus) {
    const h = el as HTMLElement
    h.focus()
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select()
    else if (h.isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(h)
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }
  return {
    ok: true,
    x,
    y,
    tag: el.tagName.toLowerCase(),
    isPassword: el instanceof HTMLInputElement && el.type === 'password',
    origin: location.origin,
    ...(coveredBy ? { coveredBy } : {}),
  }
}

export function pageViewport() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    url: location.href,
    title: document.title,
  }
}
