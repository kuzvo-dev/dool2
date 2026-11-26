// Phone app: the connections page and the sign-in sheets (credentials, what the page asks, login, connect)
import { SOCIAL_LABEL, type SocialProvider } from '@dool2/protocol/connect'
import { hyphenate } from '@dool2/protocol/rich'
import { brandMark, SOCIAL_CTA } from '../brands.js'
import { type ConnectCtx, connectionsView, serviceView, socialOrder } from '../connections.js'
import { h, icon, withLogo } from '../dom.js'
import { lang } from '../lang.js'
import { mdCred } from '../locales/main-d-cred.js'
import { otpBoxes } from '../motion.js'
import { DIGITS_RE, ID_PASSWORD_LOGIN_RE, PAY_SECRET_RE } from '../region/kr/main-d.js'
import { cardIdFor, hostOf } from './approval-cards.js'
import { ask, connectInChat } from './ask.js'
import { loginLink } from './cards.js'
import { mSet, send, st } from './core.js'
import { openOverlay, pageSettled, render, setTab, shell, toast } from './shell.js'
import { openRemote } from './work.js'

// ── Connections (connections.ts) ──

function connectCtx(): ConnectCtx {
  return {
    ...(st.services ? { services: st.services } : {}),
    query: st.connectQuery,
    cat: st.connectCat,
    connecting: st.connecting,
    online: st.online,
    ...(st.opening ? { opening: st.opening } : {}),
    header: (title, back) =>
      h(
        'div',
        { class: back ? 'page-head sub' : 'page-head' },
        back && h('button', { class: 'fbtn small', label: mSet.back, onclick: back }, icon('back')),
        title && h(back ? 'h2' : 'h1', { class: back ? 'title-2' : 'ptitle', text: title }),
      ),
    home: () => setTab('chat'),
    list: () => {
      st.connectDetail = undefined
      render()
      shell?.page.scrollTo({ top: 0 })
    },
    detail: (id) => {
      st.connectDetail = id
      render()
      shell?.page.scrollTo({ top: 0 })
    },
    setQuery: (q) => {
      // The connections screen redrew the list in place: only remember the search text
      st.connectQuery = q
      pageSettled()
    },
    setCat: (c) => {
      st.connectCat = c
      pageSettled()
    },
    open: (id) => connectInChat(id),
    mark: (id, on) => void send({ kind: 'connect', id, action: on ? 'mark' : 'unmark' }),
    tryAsk: (text) => ask(text),
  }
}

export function connectView() {
  return st.connectDetail ? serviceView(connectCtx(), st.connectDetail) : connectionsView(connectCtx())
}

/** Sign-in sheet: what is typed is encrypted and goes only to the PC vault. It never reaches the AI or the chat history */
interface CredTarget {
  /** Whether automatic sign-in got stuck earlier: only then is "do it on the screen" shown */
  stuck?: boolean
  key: string
  site: string
  host: string
  busyText: string
  submitText: string
  submit(user: string, password: string): void
  direct?: { text: string; onclick(): void }
  /** Social sign-in buttons (connect with Kakao...): through the provider account, no ID or password */
  social?: { provider: SocialProvider; hint?: string; onclick(): void }[]
  /** Request to start right after connecting */
  next?: string
  /** Id of the connection card whose logo to show */
  logo?: string
  /** The provider's logo when this is a provider account such as Kakao or Naver */
  brand?: SocialProvider
  /** Only social sign-in works here (no ID/password login): the ID field is hidden */
  socialOnly?: boolean
  /** "First time, please sign me up" button (asks Dool2 to create an account) */
  signup?: () => void
  /** "I don't know my account, please find it" button (Dool2 recovers the ID or resets the password) */
  forgot?: () => void
}

/** ID and password sheet (sign-in card, connect a service). Values go only to the PC vault */
function credSheet(t: CredTarget) {
  const sheet = h('section', { class: 'sheet float app-sheet rise' })
  const d = st.loginDraft
  if (d.id !== t.key) Object.assign(d, { id: t.key, user: '', pw: '', busy: false, error: undefined })
  const user = h('input', { class: 'field' })
  user.id = 'login-user'
  user.placeholder = mdCred.idPh
  user.autocomplete = 'username'
  user.value = d.user
  user.oninput = () => {
    d.user = user.value
  }
  const pw = h('input', { class: 'field' })
  pw.id = 'login-pw'
  pw.type = 'password'
  pw.placeholder = mdCred.pwPh
  pw.autocomplete = 'current-password'
  pw.value = d.pw
  pw.oninput = () => {
    d.pw = pw.value
  }
  const submit = h('button', { class: 'btn lg', text: d.busy ? t.busyText : t.submitText })
  submit.type = 'submit'
  submit.disabled = !!d.busy
  const form = h(
    'form',
    { class: 'login-form' },
    user,
    pw,
    d.error && h('p', { class: 'login-error', text: d.error }),
    submit,
  )
  form.onsubmit = (e) => {
    e.preventDefault()
    if (!d.user.trim() || !d.pw || d.busy) return
    d.busy = true
    d.error = undefined
    const password = d.pw
    d.pw = ''
    t.submit(d.user.trim(), password)
    render()
  }
  sheet.append(
    h(
      'button',
      { class: 'fbtn small sheet-x', label: mdCred.close, onclick: () => openOverlay(undefined) },
      icon('close'),
    ),
    h(
      'div',
      { class: 'approve-head' },
      t.brand
        ? h('span', { class: `svc-mark lg brand-tile ${t.brand}` }, brandMark(t.brand))
        : withLogo(
            h('span', { class: 'svc-mark lg', text: /^\d+/.exec(t.site)?.[0] ?? [...t.site][0] ?? '' }),
            t.logo,
          ),
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: mdCred.signInTitle(t.site) }),
        h('span', {
          class: 'meta',
          text: mdCred.signInWhere(t.host, st.saved?.pcName ?? mdCred.myPc),
        }),
      ),
    ),
    ...(t.next ? [h('p', { class: 'cred-next' }, icon('idea'), mdCred.startAfter(t.next))] : []),
    ...credBody(t, form, d.error),
  )
  return sheet
}

/** ID and password (plus social sign-in buttons and the find-account / sign-up links) */
function credBody(t: CredTarget, form: HTMLElement, error: string | undefined) {
  return [
    ...(t.social?.length
      ? [
          h(
            'div',
            { class: 'social-list' },
            ...t.social.map((x) => {
              const b = h('button', { class: `btn-social ${x.provider}`, onclick: x.onclick })
              b.type = 'button'
              b.append(brandMark(x.provider), h('span', { text: SOCIAL_CTA[x.provider] }))
              // Mark providers that reuse an existing account instead of creating a new one (recently used, used on N sites)
              if (x.hint) b.append(h('span', { class: 'social-hint', text: x.hint }))
              return b
            }),
          ),
          ...(t.socialOnly ? [] : [h('p', { class: 'social-or' }, h('span', { text: mdCred.orWithId }))]),
        ]
      : []),
    ...(t.socialOnly && t.social?.length ? [] : [form]),
    // Find account | Sign up: a one-line link like on most sign-in screens (two big buttons felt busy, per user feedback)
    ...(t.forgot || t.signup
      ? [
          h(
            'div',
            { class: 'cred-links' },
            ...(t.forgot
              ? [h('button', { class: 'btn-text', text: mdCred.findAccount, onclick: t.forgot })]
              : []),
            ...(t.forgot && t.signup ? [h('span', { class: 'cred-sep' })] : []),
            ...(t.signup ? [h('button', { class: 'btn-text', text: mdCred.signUp, onclick: t.signup })] : []),
          ),
        ]
      : []),
    h('p', { class: 'lock-note' }, icon('lock'), mdCred.vaultNote),
    // Show "watch the screen" only when sign-in failed or the connection got stuck
    ...(t.direct && (error || t.stuck)
      ? [h('button', { class: 'btn-text cred-direct', text: t.direct.text, onclick: t.direct.onclick })]
      : []),
  ]
}

/** What the page asks during sign-in (verification code, phone number): collected on the phone and typed into the PC field */
export function infoSheet(id: string) {
  const q = st.infos.get(id)
  const sheet = h('section', { class: 'sheet float app-sheet rise info-sheet' })
  if (!q) return sheet
  const answer = (value?: string) => {
    void send({ kind: 'info-answer', id, ...(value ? { value } : {}) })
    st.infos.delete(id)
    st.overlay = undefined
    render()
    if (value) toast(mdCred.filled)
  }
  const head = h(
    'div',
    { class: 'approve-head' },
    withLogo(h('span', { class: 'svc-mark lg', text: [...q.site][0] ?? '' }), undefined),
    h(
      'div',
      {},
      h('strong', {
        class: 'title-2',
        text:
          q.field === 'otp'
            ? mdCred.otpTitle
            : q.field === 'tap'
              ? mdCred.tapTitle
              : q.field === 'form'
                ? mdCred.formTitle
                : q.label,
      }),
      h('span', {
        class: 'meta',
        text: q.field === 'form' ? mdCred.formSub : `${q.site} \u00b7 ${q.host}`,
      }),
    ),
  )
  const body: Node[] = []
  if (q.hint) body.push(h('p', { class: 'info-hint', text: q.hint.replace(/^\s*#+\s*/, '') }))
  // Solve by tapping the image (robot check): taps are sent as 0-1000 ratios, and Dool2 clicks the same spot on the PC screen
  if (q.field === 'tap' && q.image) {
    const max = Math.max(1, q.maxTaps ?? 1)
    const points: [number, number][] = []
    const img = h('img', { class: 'tap-img' }) as HTMLImageElement
    img.src = `data:image/jpeg;base64,${q.image}`
    img.alt = mdCred.tapAlt
    img.draggable = false
    const dots = h('div', { class: 'tap-dots' })
    const done = h('button', { class: 'btn lg', text: mdCred.tapDone }) as HTMLButtonElement
    const redo = h('button', { class: 'btn-ghost lg', text: mdCred.tapRedo }) as HTMLButtonElement
    const draw = () => {
      dots.replaceChildren(
        ...points.map(([x, y], i) => {
          const d = h('span', { class: 'tap-dot', text: String(i + 1) })
          d.style.left = `${x / 10}%`
          d.style.top = `${y / 10}%`
          return d
        }),
      )
      done.disabled = points.length === 0
      done.textContent = max > 1 ? mdCred.tapDoneCount(points.length, max) : mdCred.tapHere
    }
    const box = h('div', { class: 'tap-box' }, img, dots)
    box.onclick = (e) => {
      const r = img.getBoundingClientRect()
      const x = Math.round(((e.clientX - r.left) / r.width) * 1000)
      const y = Math.round(((e.clientY - r.top) / r.height) * 1000)
      if (x < 0 || y < 0 || x > 1000 || y > 1000) return
      // When only one tap is needed, tapping again moves it
      if (max === 1) points.splice(0, points.length, [x, y])
      else if (points.length < max) points.push([x, y])
      draw()
    }
    redo.onclick = () => {
      points.splice(0)
      draw()
    }
    done.onclick = () => {
      if (points.length) answer(points.map(([x, y]) => `${x},${y}`).join(';'))
    }
    draw()
    sheet.append(
      head,
      ...body,
      box,
      h('div', { class: 'tap-actions' }, redo, done),
      h('button', { class: 'btn-link', text: mdCred.later, onclick: () => answer() }),
    )
    return sheet
  }
  // Security code: show the image Dool2 picked and take the letters (no need to look at the PC screen)
  if (q.image) {
    const img = h('img', { class: 'captcha-img' }) as HTMLImageElement
    img.src = `data:image/jpeg;base64,${q.image}`
    img.alt = mdCred.captchaAlt
    body.push(img)
  }
  if (q.field === 'choice' && q.options?.length) {
    // Pick one (e.g. several Google accounts). The chosen text is sent back as is
    body.push(
      h(
        'div',
        { class: 'choice-list' },
        ...q.options.map((o, i) =>
          h('button', {
            class: `${i === 0 ? 'btn' : 'btn-ghost'} lg choice-btn`,
            text: o,
            onclick: () => answer(o),
          }),
        ),
      ),
      h('button', { class: 'btn-link', text: mdCred.later, onclick: () => answer() }),
    )
    sheet.append(head, ...body)
    return sheet
  }
  if (q.field === 'form' && q.fields?.length) {
    // Personal info card: several fields at once. Values go only to the PC vault, and Dool2 (the AI) sees only masked values
    const inputs = q.fields.map((f) => {
      const input = h('input', { class: 'field' })
      input.name = f.key
      if (f.type === 'choice' && f.options?.length) {
        // Pick one (simple-auth app): tapping a chip puts its name in the hidden field
        input.type = 'hidden'
        return { f, input, chips: choiceChips(f.options, '', (v) => (input.value = v)) }
      }
      input.placeholder = f.example ? mdCred.example(f.example) : f.label
      input.setAttribute('aria-label', f.label)
      if (f.type === 'tel') {
        input.type = 'tel'
        input.inputMode = 'tel'
        input.autocomplete = 'tel'
      } else if (f.type === 'email') {
        input.type = 'email'
        input.inputMode = 'email'
        input.autocomplete = 'email'
      } else if (f.type === 'date') {
        input.inputMode = 'numeric'
        input.setAttribute('autocomplete', 'bday')
      } else if (f.key === 'name') input.autocomplete = 'name'
      else if (f.key === 'name_en_last') input.autocomplete = 'family-name'
      else if (f.key === 'name_en_first') input.autocomplete = 'given-name'
      else if (f.key === 'zip') input.autocomplete = 'postal-code'
      else if (f.key === 'address') input.autocomplete = 'street-address'
      autoHyphen(input, f.key)
      return { f, input, chips: undefined as HTMLElement | undefined }
    })
    const go = h('button', { class: 'btn lg', text: mdCred.saveContinue })
    go.type = 'submit'
    const form = h(
      'form',
      { class: 'cred-form profile-form' },
      ...inputs.map(({ f, input, chips }) =>
        chips
          ? h('div', { class: 'field-label' }, h('span', { class: 'meta', text: f.label }), chips, input)
          : h('label', { class: 'field-label' }, h('span', { class: 'meta', text: f.label }), input),
      ),
      go,
    )
    form.onsubmit = (e) => {
      e.preventDefault()
      // Check each field's format: if it doesn't match, show a hint under that field and stop (empty fields are skipped)
      let bad: HTMLInputElement | undefined
      for (const { f, input } of inputs) {
        const v = input.value.trim()
        input.parentElement?.querySelector('.field-err')?.remove()
        input.classList.remove('invalid')
        if (!v || !f.pattern || new RegExp(f.pattern).test(v)) continue
        input.classList.add('invalid')
        input.insertAdjacentElement(
          'afterend',
          h('span', { class: 'field-err', text: f.patternHint || mdCred.badFormatOf(f.label) }),
        )
        bad ??= input
      }
      if (bad) {
        bad.focus()
        return
      }
      const value: Record<string, string> = {}
      for (const { f, input } of inputs) if (input.value.trim()) value[f.key] = input.value.trim()
      if (Object.keys(value).length) answer(JSON.stringify(value))
    }
    body.push(form)
    queueMicrotask(() => inputs.find((x) => !x.chips)?.input.focus())
  } else if (q.field === 'password') {
    // New password chosen by the user: typed twice to check, then sent only to the PC vault (never to Dool2 or the log)
    const mk = (ph: string) => {
      const i = h('input', { class: 'field' }) as HTMLInputElement
      i.type = 'password'
      i.autocomplete = 'new-password'
      i.placeholder = ph
      i.setAttribute('aria-label', ph)
      return i
    }
    const pw1 = mk(mdCred.newPw)
    const pw2 = mk(mdCred.onceMore)
    const err = h('p', { class: 'field-err', text: '' })
    const show = h('button', { class: 'btn-text', text: mdCred.show })
    show.type = 'button'
    show.onclick = () => {
      const t = pw1.type === 'password' ? 'text' : 'password'
      pw1.type = t
      pw2.type = t
      show.textContent = t === 'password' ? mdCred.show : mdCred.hide
    }
    const go = h('button', { class: 'btn lg', text: mdCred.setPw })
    go.type = 'submit'
    const form = h('form', { class: 'cred-form' }, pw1, pw2, show, err, go)
    form.onsubmit = (e) => {
      e.preventDefault()
      const v = pw1.value
      if (q.pattern && !new RegExp(q.pattern).test(v)) {
        err.textContent = q.patternHint || mdCred.badFormat
        return
      }
      if (v !== pw2.value) {
        err.textContent = mdCred.pwMismatch
        return
      }
      answer(v)
    }
    body.push(form)
    queueMicrotask(() => pw1.focus())
  } else if (q.field === 'secret') {
    // Values that are never stored, like the back digits of a resident number: taken on a secure keypad with shuffled digit positions instead of the phone keyboard
    // The same card keeps the same keypad when redrawn: reshuffling on each draw changed the digits 2-3 times,
    // and the positions moved at the moment of a tap so a different digit went in (measured: wrong payment PIN, 11-20)
    let pad = pads.get(q.id)
    if (!pad) {
      pad = securePad(q.pattern, q.patternHint, (v) => {
        pads.delete(q.id)
        answer(v)
      })
      // Mark it as a reusable part: when a redrawn sheet is discarded (the shape is the same so the old one stays), it goes back to the original sheet.
      // Without this it moved into the discarded new sheet and vanished, leaving the visible card without a keypad (measured 11-20, payment PIN in a shop)
      pad.dataset.liveSlot = 'pad'
      pads.set(q.id, pad)
    }
    body.push(pad)
  } else if (q.field === 'otp') {
    // Digit count: use it if the page hint ("4 digits") or the pattern says, else accept 4-8 digits and finish with [Enter]
    const said = `${q.label} ${q.hint ?? ''}`.match(DIGITS_RE)?.[1] ?? q.pattern?.match(/\\d\{(\d)\}/)?.[1]
    const len = said ? Number(said) : undefined
    const otp = otpBoxes({
      ...(len && len >= 4 && len <= 8 ? { length: len } : { flex: true }),
      onDone: (code) => setTimeout(() => answer(code), 500),
    })
    body.push(otp)
    body.push(
      h('p', {
        class: 'meta',
        text: otp.go ? mdCred.otpHintGo : mdCred.otpHintAuto,
      }),
    )
    if (otp.go) body.push(otp.go)
    queueMicrotask(() => document.getElementById('otp-input')?.focus())
  } else {
    const input = h('input', { class: 'field' })
    input.id = 'info-input'
    input.placeholder = q.label
    if (q.field === 'tel') {
      input.type = 'tel'
      input.inputMode = 'tel'
      input.autocomplete = 'tel'
    }
    if (q.image) {
      input.autocomplete = 'off'
      input.setAttribute('autocapitalize', 'off')
      input.setAttribute('autocorrect', 'off')
      input.spellcheck = false
      input.placeholder = mdCred.imagePh
    }
    const go = h('button', { class: 'btn lg', text: mdCred.put })
    go.type = 'submit'
    const form = h('form', { class: 'cred-form' }, input, go)
    form.onsubmit = (e) => {
      e.preventDefault()
      if (input.value.trim()) answer(input.value.trim())
    }
    body.push(form)
    queueMicrotask(() => input.focus())
  }
  sheet.append(
    head,
    ...body,
    h(
      'p',
      { class: 'lock-note' },
      icon('lock'),
      q.field === 'form'
        ? mdCred.noteForm
        : q.field === 'secret' && PAY_SECRET_RE.test(q.label)
          ? mdCred.notePay
          : q.field === 'secret' || q.field === 'password'
            ? mdCred.noteVault
            : mdCred.noteOther,
    ),
    h('button', { class: 'btn-text cred-direct', text: mdCred.notNow, onclick: () => answer() }),
  )
  return sheet
}

/** Phone and birth-date fields add hyphens as you type digits */
export function autoHyphen(input: HTMLInputElement, key: string) {
  if (key !== 'phone' && key !== 'birth') return
  input.inputMode = 'numeric'
  input.addEventListener('input', () => {
    input.value = hyphenate(key, input.value)
  })
}

/**
 * Secure keypad (like banking apps): shuffles digit positions, and a tap flashes another digit too
 * so nobody looking over your shoulder can tell which one it was. The value stays inside this function and is handed over only on [Enter]
 */
/** Open secure keypads (by card id; positions and typed value survive a redraw) */
const pads = new Map<string, HTMLElement>()

function securePad(
  pattern: string | undefined,
  hint: string | undefined,
  onDone: (v: string) => void,
): HTMLElement {
  const max = Number(/\{(\d+)\}\$?$/.exec(pattern ?? '')?.[1] ?? '') + 1 || 7
  let value = ''
  const dots = h('div', { class: 'pad-dots' })
  const err = h('p', { class: 'field-err pad-err', text: '' })
  const go = h('button', { class: 'btn lg', text: mdCred.put }) as HTMLButtonElement
  const grid = h('div', { class: 'pad-grid' })
  const paint = () => {
    dots.replaceChildren(
      ...Array.from({ length: max }, (_, i) => h('span', { class: i < value.length ? 'on' : '' })),
    )
    go.disabled = value.length < max
    err.textContent = ''
  }
  // Another digit key looks pressed together with the tapped one
  const flash = (el: HTMLElement) => {
    const others = [...grid.querySelectorAll<HTMLElement>('.pad-key.num')].filter((k) => k !== el)
    const decoy = others[Math.floor(Math.random() * others.length)]
    for (const k of [el, decoy]) {
      if (!k) continue
      k.classList.remove('pressed')
      void k.offsetWidth
      k.classList.add('pressed')
      setTimeout(() => k.classList.remove('pressed'), 160)
    }
    navigator.vibrate?.(8)
  }
  const key = (label: string | Element, on: (el: HTMLElement) => void, cls: string, aria?: string) => {
    const b = h('button', { class: `pad-key ${cls}` })
    b.append(label)
    b.type = 'button'
    if (aria) b.setAttribute('aria-label', aria)
    b.onpointerdown = (e) => {
      e.preventDefault()
      on(b)
    }
    return b
  }
  const layout = () => {
    const digits = [...'0123456789'].sort(() => Math.random() - 0.5)
    const num = (d: string) =>
      key(
        d,
        (el) => {
          flash(el)
          if (value.length < max) value += d
          paint()
        },
        'num',
      )
    grid.replaceChildren(
      ...digits.slice(0, 9).map(num),
      key(mdCred.shuffle, () => layout(), 'fn', mdCred.shuffleAria),
      num(digits[9] as string),
      key(
        icon('back'),
        () => {
          value = value.slice(0, -1)
          paint()
        },
        'fn',
        mdCred.deleteAria,
      ),
    )
  }
  go.onclick = () => {
    if (pattern && !new RegExp(pattern).test(value)) {
      err.textContent = hint || mdCred.badFormat
      return
    }
    onDone(value)
    value = ''
  }
  layout()
  paint()
  return h('div', { class: 'secure-pad' }, dots, err, grid, go)
}

/** Pick-one chips (simple-auth app etc.). Only the tapped chip turns on and onPick is called */
export function choiceChips(
  options: readonly string[],
  current: string,
  onPick: (v: string) => void,
): HTMLElement {
  const box = h('div', { class: 'choice-chips' })
  for (const o of options) {
    const b = h('button', { class: `chip${o === current ? ' on' : ''}`, text: o })
    b.type = 'button'
    b.onclick = () => {
      for (const c of box.querySelectorAll('.chip')) c.classList.toggle('on', c === b)
      onPick(o)
    }
    box.append(b)
  }
  return box
}

/** The provider when the address is a provider account (accounts.kakao.com -> kakao) */
function brandOf(origin: string): SocialProvider | undefined {
  const h = hostOf(origin)
  if (/(^|\.)kakao\.com$/.test(h)) return 'kakao'
  if (/(^|\.)naver\.com$/.test(h)) return 'naver'
  if (/(^|\.)google\.com$/.test(h)) return 'google'
  if (/(^|\.)apple\.com$/.test(h)) return 'apple'
  if (/(^|\.)facebook\.com$/.test(h)) return 'facebook'
  if (/(^|\.)payco\.com$/.test(h)) return 'payco'
  return undefined
}

export function loginSheet(id: string) {
  const r = st.logins.get(id)
  if (!r) return h('section', { class: 'sheet float app-sheet rise' })
  return credSheet({
    key: r.id,
    site: r.site,
    host: hostOf(r.origin),
    ...(cardIdFor(r.origin) ? { logo: cardIdFor(r.origin) } : {}),
    ...(brandOf(r.origin) ? { brand: brandOf(r.origin) } : {}),
    busyText: mdCred.saving,
    submitText: mdCred.signIn,
    submit: (username, password) => void send({ kind: 'login', id: r.id, username, password }),
    direct: { text: mdCred.directLogin, onclick: () => openRemote(r.tabId) },
    stuck: Boolean(loginLink(r.origin)?.fail),
    // If the user doesn't know the ID or password, Dool2 recovers it: the sign-in card is withdrawn and the request goes to the chat (only identity-check codes use a phone card)
    forgot: () => {
      void send({ kind: 'forgot', site: r.origin, loginId: r.id })
      void send({ kind: 'ask', text: mdCred.forgotAsk(r.site) })
      st.overlay = undefined
      st.tab = 'chat'
      toast(mdCred.forgotToast(r.site))
    },
    // If there is no account, Dool2 signs up: report that sign-up was chosen for this site and send the request to the chat
    signup: () => {
      void send({ kind: 'signup', site: r.origin, loginId: r.id })
      void send({ kind: 'ask', text: mdCred.signupAsk(r.site) })
      st.overlay = undefined
      st.tab = 'chat'
      toast(mdCred.signupToast(r.site))
    },
    // For sites with a connection card, offer social sign-in too (same choices as the connect screen)
    ...loginChoices(cardIdFor(r.origin)),
  })
}

/** Social sign-in buttons of a connection card (the sign-in request card and the connect screen share the same choices) */
function loginChoices(cardId: string | undefined): Pick<CredTarget, 'social' | 'socialOnly'> {
  const it = cardId ? st.services?.find((x) => x.card.id === cardId) : undefined
  if (!it?.card.social?.length) return {}
  const id = it.card.id
  return {
    socialOnly: !ID_PASSWORD_LOGIN_RE.test(it.card.login ?? ''),
    social: socialOrder(it.card, st.services, lang).map(({ provider, hint }) => ({
      provider,
      ...(hint ? { hint } : {}),
      onclick: () => {
        // If the provider is already signed in on the PC's Chrome, Dool2 only passes the button and consent; otherwise it hands over that screen
        void send({ kind: 'connect-social', id, provider })
        st.overlay = undefined
        st.connecting.add(id)
        if (st.tab !== 'chat') toast(mdCred.socialToast(SOCIAL_LABEL[provider], it.card.name))
        render()
      },
    })),
  }
}

/**
 * Start connecting by looking first (ADR 0041): the PC checks in the background whether its Chrome is already signed
 * in (Google: which accounts it has), and the connect card asks "this account, or another one?" as buttons. The ID
 * and password card opens only when needed (connect-result with reason 'credentials')
 */
export function startLook(id: string) {
  st.overlay = undefined
  st.connecting.add(id)
  render()
  void send({ kind: 'connect', id, action: 'start' })
}

/** The sign-in screen on the PC, watched from the phone (opens it first if it is not open yet) */
function openConnectScreen(id: string) {
  const tab = st.connectTabs.get(id)
  if (tab !== undefined) return openRemote(tab, id)
  st.opening = id
  st.overlay = undefined
  render()
  void send({ kind: 'connect', id, action: 'open' })
}

/** Connect a service: after you enter the ID and password, Dool2 signs in on the PC's Chrome for you and reports back */
export function connectSheet(id: string) {
  const it = st.services?.find((x) => x.card.id === id)
  if (!it) return h('section', { class: 'sheet float app-sheet rise' })
  const openScreen = () => openConnectScreen(id)
  return credSheet({
    key: `connect:${id}`,
    site: it.card.name,
    host: it.card.site ?? '',
    busyText: mdCred.connecting,
    submitText: mdCred.connect,
    submit: (username, password) => {
      // Don't wait: close the sheet and Dool2 signs in behind the scenes (reported in the chat or by notification)
      void send({ kind: 'connect-login', id, username, password })
      st.loginDraft.busy = false
      st.overlay = undefined
      st.connecting.add(id)
      if (st.tab !== 'chat') toast(mdCred.connectToast(it.card.name))
    },
    ...(st.afterConnect?.id === id ? { next: st.afterConnect.text } : {}),
    logo: id,
    // Places with only social sign-in or SMS verification: an ID field would only confuse
    socialOnly: Boolean(it.card.social?.length) && !ID_PASSWORD_LOGIN_RE.test(it.card.login ?? ''),
    social: socialOrder(it.card, st.services, lang).map(({ provider, hint }) => ({
      provider,
      ...(hint ? { hint } : {}),
      onclick: () => {
        // If the provider (Kakao etc.) is already signed in on the PC's Chrome, Dool2 only passes the button and consent; otherwise it hands over that screen
        void send({ kind: 'connect-social', id, provider })
        st.overlay = undefined
        st.connecting.add(id)
        if (st.tab !== 'chat') toast(mdCred.socialToast(SOCIAL_LABEL[provider], it.card.name))
      },
    })),
    stuck: st.connectFails.has(id),
    direct: { text: st.connectTabs.has(id) ? mdCred.keepOnPc : mdCred.directConnect, onclick: openScreen },
    // If the user doesn't know the ID or password, Dool2 recovers it: the sign-in card is withdrawn and the request goes to the chat (only identity-check codes use a phone card)
    forgot: () => {
      void send({ kind: 'forgot', site: it.card.site ?? it.card.id })
      void send({ kind: 'ask', text: mdCred.forgotAsk(it.card.name) })
      st.overlay = undefined
      st.tab = 'chat'
      toast(mdCred.forgotToast(it.card.name))
    },
    // If there is no account, Dool2 signs up: the request goes to the chat and Dool2 runs the sign-up flow
    signup: () => {
      if (it.card.site) void send({ kind: 'signup', site: it.card.site })
      void send({ kind: 'ask', text: mdCred.signupAsk(it.card.name) })
      st.overlay = undefined
      st.tab = 'chat'
      toast(mdCred.signupToast(it.card.name))
    },
  })
}
