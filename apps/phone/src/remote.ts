// Remote screen: handle the PC tab Dool2 handed over, directly from the phone.
// - The PC tab is drawn at phone width (view) so text shows at a readable size
// - Swipe to scroll (follows the finger), pinch to zoom, long press for a magnifier to aim exactly
// - Tapping an input opens a text bar below and the phone keyboard opens at once. What you type goes into the PC field
// - Buttons on the page are also gathered as big buttons below
// This screen is built once and only the image and info change (redrawing would close the keyboard and cut off gestures)
import type { RemoteButton, RemoteField, RemoteFocus, RemoteForm, RemoteFormValue } from '@dool2/protocol'
import { h, icon } from './dom.js'
import { lang } from './lang.js'
import { remoteText } from './locales/remote.js'
import { otpBoxes, reduced, Spring, springTo, tick } from './motion.js'
import { createFormPane } from './remote-form.js'

export interface Shot {
  tabId: number
  shot?: string
  url?: string
  title?: string
  error?: string
  busy?: boolean
  fields?: RemoteField[]
  actions?: RemoteButton[]
  focus?: RemoteFocus | null
}

export type RemoteInput =
  | { action: 'tap'; x: number; y: number }
  | { action: 'text'; text: string }
  | { action: 'key'; key: string }
  | { action: 'scroll'; dy: number; x?: number; y?: number }
  | { action: 'view'; w: number; h: number }
  | { action: 'leave' }

export interface RemoteOpts {
  tabId: number
  connectId?: string
  input(i: RemoteInput): void
  back(): void
  done(): void
  handBack(): void
  hostOf(url: string): string
  /** Ask for "fields only" */
  form(): void
  /** Put in the values filled on the fields-only screen and press a button */
  fill(values: RemoteFormValue[], press?: string): void
}

export interface RemoteScreen {
  tabId: number
  el: HTMLElement
  update(s: Shot | undefined, rate?: number): void
  setForm(form: RemoteForm | undefined, error?: string): void
}

const HOLD_MS = 280
const MOVE_PX = 8

export function createRemote(o: RemoteOpts): RemoteScreen {
  const t = remoteText(lang)
  let shot: Shot | undefined
  let viewH = 0
  let viewSent = false

  // ── Header ──
  const host = h('span', { class: 'remote-url-text', text: t.loading })
  const rate = h('span', { class: 'remote-rate', text: '' })
  const head = h(
    'div',
    { class: 'remote-bar' },
    h('button', { class: 'fbtn small', label: t.close, onclick: () => leave(o.back) }, icon('close')),
    h(
      'span',
      { class: 'remote-pill' },
      h('span', { class: 'live-dot' }),
      h('span', { class: 'remote-state', text: t.state }),
    ),
  )
  const where = h('div', { class: 'remote-where' }, icon('lock'), host, rate)

  // ── Screen (image + finger gestures) ──
  const img = h('img', { class: 'remote-shot' })
  img.alt = t.shotAlt
  img.draggable = false
  const marks = h('div', { class: 'remote-marks' })
  const stage = h('div', { class: 'remote-stage' }, img, marks)
  const msg = h('p', { class: 'remote-msg' }, h('span', { class: 'spin' }), t.fetching)
  const loupe = h('div', { class: 'remote-loupe' })
  loupe.hidden = true
  const hint = h('span', {
    class: 'remote-hint',
    text: t.hint,
  })
  const zoomReset = h('button', { class: 'remote-zoom', text: t.resetZoom })
  zoomReset.hidden = true
  const frame = h('div', { class: 'remote-frame' }, msg, stage, loupe, hint, zoomReset)

  // ── Button collection ──
  const acts = h('div', { class: 'remote-acts' })
  let actSig = ''

  // ── Text bar (when an input is tapped) ──
  const typeLabel = h('span', { class: 'remote-type-label', text: '' })
  const typeInput = h('input', { class: 'remote-type-input' })
  typeInput.autocomplete = 'off'
  typeInput.setAttribute('autocapitalize', 'off')
  typeInput.setAttribute('autocorrect', 'off')
  typeInput.spellcheck = false
  const nextBtn = h('button', { class: 'chip', text: t.nextField })
  const doneBtn = h('button', { class: 'chip on', text: t.done })
  const typeBar = h(
    'div',
    { class: 'remote-typebar' },
    h('div', { class: 'remote-type-head' }, typeLabel, nextBtn, doneBtn),
    typeInput,
  )
  typeBar.hidden = true

  // ── Verification code boxes ──
  const otpBox = h('div', { class: 'remote-otp' })
  otpBox.hidden = true

  const tools = h(
    'div',
    { class: 'remote-tools' },
    h('button', { class: 'chip', text: t.keyboard, onclick: () => openType(undefined, true) }),
    h('button', { class: 'chip', text: t.code, onclick: () => toggleOtp() }),
    h('button', { class: 'chip', text: t.enter, onclick: () => o.input({ action: 'key', key: 'Enter' }) }),
  )
  const foot = h(
    'div',
    { class: 'remote-foot' },
    h('button', { class: 'btn-ghost', text: t.handBack, onclick: () => leave(o.handBack) }),
    h('button', {
      class: 'btn btn-approve',
      text: o.connectId ? t.loggedIn : t.allDone,
      onclick: () => leave(o.done),
    }),
  )
  // ── Fields only / view screen ──
  let mode: 'form' | 'screen' = 'screen'
  let chosen = false
  const formPane = createFormPane({
    fill: (values, press) => o.fill(values, press),
    finish: () => leave(o.done),
    showScreen: () => setMode('screen', true),
  })
  formPane.el.hidden = true
  const segForm = h('button', { text: t.onlyFields, onclick: () => setMode('form', true) })
  const segScreen = h('button', { text: t.viewScreen, onclick: () => setMode('screen', true) })
  const seg = h('div', { class: 'remote-seg' }, segForm, segScreen)
  seg.hidden = true
  const setMode = (m: 'form' | 'screen', byUser = false) => {
    if (byUser) chosen = true
    mode = m
    const f = m === 'form'
    formPane.el.hidden = !f
    frame.hidden = f
    acts.hidden = f || !(shot?.actions?.length ?? 0)
    tools.hidden = f
    if (f) {
      typeInput.blur()
      typeBar.hidden = true
      otpBox.hidden = true
    } else {
      // Coming back to the screen view: ask again for phone-width drawing (it may have been reset meanwhile)
      viewSent = false
      requestAnimationFrame(sendView)
    }
    segForm.setAttribute('aria-pressed', String(f))
    segScreen.setAttribute('aria-pressed', String(!f))
    if (f && byUser) o.form()
  }

  const el = h(
    'section',
    { class: 'remote-page' },
    head,
    where,
    seg,
    frame,
    formPane.el,
    acts,
    otpBox,
    typeBar,
    tools,
    foot,
  )

  const leave = (then: () => void) => {
    o.input({ action: 'leave' })
    typeInput.blur()
    then()
  }

  // Decide the screen size and ask the PC to draw at phone width (once at first, measured after attaching)
  const sendView = () => {
    if (viewSent || !frame.isConnected) return
    const w = Math.round(frame.clientWidth)
    viewH = Math.round(Math.max(420, frame.clientHeight || window.innerHeight * 0.62))
    if (!w) return
    viewSent = true
    viewW = w
    o.input({ action: 'view', w, h: viewH })
  }

  // If the image is not phone-width shaped (reset on the PC), ask again (at most once every 3 s)
  let viewW = 0
  let lastViewAsk = 0
  const checkView = () => {
    img.decode?.().then(
      () => {
        if (!viewW || !viewH || !img.naturalWidth || mode !== 'screen') return
        const want = viewW / viewH
        const got = img.naturalWidth / img.naturalHeight
        if (Math.abs(got - want) / want < 0.06) return
        const now = performance.now()
        if (now - lastViewAsk < 3000) return
        lastViewAsk = now
        o.input({ action: 'view', w: viewW, h: viewH })
      },
      () => {},
    )
  }

  // ── Zoom, pan and scroll preview ──
  let zoom = 1
  let panX = 0
  let panY = 0
  let scrollPreview = 0
  const applyStage = () => {
    stage.style.transform = `translate(${panX.toFixed(1)}px, ${(panY + scrollPreview).toFixed(1)}px) scale(${zoom.toFixed(3)})`
    zoomReset.hidden = zoom <= 1.01
  }
  const clampPan = () => {
    const W = frame.clientWidth
    const H = frame.clientHeight
    panX = Math.min(0, Math.max(W - W * zoom, panX))
    panY = Math.min(0, Math.max(H - H * zoom, panY))
  }
  zoomReset.addEventListener('click', (e) => {
    e.stopPropagation()
    const p = new Spring(0).use('settle')
    p.t = 1
    const z0 = zoom
    const x0 = panX
    const y0 = panY
    tick((dt) => {
      p.step(dt)
      zoom = Math.max(1, z0 + (1 - z0) * p.x)
      panX = x0 * (1 - p.x)
      panY = y0 * (1 - p.x)
      applyStage()
      return !p.resting
    })
  })

  // Position in the image > image ratio (0 to 1)
  // The image shrinks to fit (stuck to the top), so measure where it is actually drawn
  const shotRect = () => {
    const b = img.getBoundingClientRect()
    const ar =
      img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : b.width / b.height
    if (b.width / b.height > ar) {
      const w = b.height * ar
      return { left: b.left + (b.width - w) / 2, top: b.top, width: w, height: b.height }
    }
    return { left: b.left, top: b.top, width: b.width, height: b.width / ar }
  }
  // Position relative to the frame (the finger position stays right even if the scroll preview shifted the image)
  const frameFrac = (cx: number, cy: number): [number, number] => {
    const fr = frame.getBoundingClientRect()
    return [(cx - fr.left) / fr.width, (cy - fr.top) / fr.height]
  }
  const toFrac = (cx: number, cy: number) => {
    const r = shotRect()
    return { fx: (cx - r.left) / r.width, fy: (cy - r.top) / r.height, r }
  }

  // ── Fingers ──
  const pts = new Map<number, { x: number; y: number }>()
  let gesture:
    | {
        kind: 'one'
        x0: number
        y0: number
        t0: number
        mode: 'wait' | 'scroll' | 'pan' | 'loupe'
        last: number
        base: number
        px0: number
        py0: number
        timer: ReturnType<typeof setTimeout>
      }
    | { kind: 'pinch'; d0: number; z0: number; cx: number; cy: number; px0: number; py0: number }
    | undefined
  let pendingScroll = 0
  let lastScrollSend = 0
  let scrollTimer: ReturnType<typeof setTimeout> | undefined

  const flushScroll = (fx: number, fy: number) => {
    if (!pendingScroll) return
    const r = shotRect()
    // Screen pixels dragged by the finger > page pixels (less when zoomed in)
    const page = -(pendingScroll * viewH) / Math.max(1, r.height)
    pendingScroll = 0
    lastScrollSend = performance.now()
    o.input({
      action: 'scroll',
      dy: Math.round(page),
      x: Math.min(1, Math.max(0, fx)),
      y: Math.min(1, Math.max(0, fy)),
    })
  }

  const showLoupe = (cx: number, cy: number) => {
    const fr = frame.getBoundingClientRect()
    const r = shotRect()
    const Z = 2.4
    const size = 104
    loupe.hidden = false
    loupe.style.left = `${cx - fr.left - size / 2}px`
    loupe.style.top = `${Math.max(4, cy - fr.top - size - 36)}px`
    loupe.style.backgroundImage = `url("${img.src}")`
    loupe.style.backgroundSize = `${r.width * Z}px ${r.height * Z}px`
    loupe.style.backgroundPosition = `${-(cx - r.left) * Z + size / 2}px ${-(cy - r.top) * Z + size / 2}px`
  }

  frame.addEventListener('pointerdown', (e) => {
    if (!shot?.shot || (e.target as HTMLElement).closest('.remote-zoom')) return
    frame.setPointerCapture?.(e.pointerId)
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    hint.classList.add('gone')
    if (pts.size === 2) {
      if (gesture?.kind === 'one') clearTimeout(gesture.timer)
      loupe.hidden = true
      const [a, b] = [...pts.values()] as [{ x: number; y: number }, { x: number; y: number }]
      gesture = {
        kind: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y),
        z0: zoom,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        px0: panX,
        py0: panY,
      }
      return
    }
    if (pts.size > 2) return
    const g = {
      kind: 'one' as const,
      x0: e.clientX,
      y0: e.clientY,
      t0: performance.now(),
      mode: 'wait' as 'wait' | 'scroll' | 'pan' | 'loupe',
      last: 0,
      base: scrollPreview,
      px0: panX,
      py0: panY,
      timer: setTimeout(() => {
        if (gesture === g && g.mode === 'wait') {
          g.mode = 'loupe'
          navigator.vibrate?.(6)
          const p = pts.get(e.pointerId)
          if (p) showLoupe(p.x, p.y)
        }
      }, HOLD_MS),
    }
    gesture = g
  })

  frame.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture
    if (!g) return
    if (g.kind === 'pinch') {
      const [a, b] = [...pts.values()] as [{ x: number; y: number }, { x: number; y: number }]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const fr = frame.getBoundingClientRect()
      const nz = Math.min(3, Math.max(1, (g.z0 * d) / Math.max(1, g.d0)))
      // Zoom around the midpoint of the two fingers
      const ox = g.cx - fr.left
      const oy = g.cy - fr.top
      panX = ox - ((ox - g.px0) * nz) / g.z0
      panY = oy - ((oy - g.py0) * nz) / g.z0
      zoom = nz
      clampPan()
      applyStage()
      return
    }
    const dx = e.clientX - g.x0
    const dy = e.clientY - g.y0
    if (g.mode === 'loupe') return showLoupe(e.clientX, e.clientY)
    if (g.mode === 'wait' && Math.hypot(dx, dy) > MOVE_PX) {
      clearTimeout(g.timer)
      g.mode = zoom > 1.01 ? 'pan' : 'scroll'
    }
    if (g.mode === 'pan') {
      panX = g.px0 + dx
      panY = g.py0 + dy
      clampPan()
      applyStage()
    } else if (g.mode === 'scroll') {
      // The image follows right away; scrolls are sent to the PC in small batches
      // Only what moved in this gesture (the preview from the earlier gesture is separate)
      pendingScroll += dy - g.last
      g.last = dy
      scrollPreview = g.base + dy
      applyStage()
      const now = performance.now()
      if (now - lastScrollSend > 120) flushScroll(...frameFrac(g.x0, g.y0))
    }
  })

  const end = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return
    pts.delete(e.pointerId)
    const g = gesture
    if (!g) return
    if (g.kind === 'pinch') {
      if (pts.size === 0) gesture = undefined
      return
    }
    clearTimeout(g.timer)
    gesture = undefined
    loupe.hidden = true
    if (e.type === 'pointercancel') return
    if (g.mode === 'scroll') {
      flushScroll(...frameFrac(g.x0, g.y0))
      // When the next image arrives, drop the preview; if none does, spring back into place
      clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => settlePreview(), 900)
      return
    }
    if (g.mode === 'pan') return
    // Tap (a plain tap, or the spot where the finger lifted after aiming with the magnifier)
    tapAt(e.clientX, e.clientY)
  }
  frame.addEventListener('pointerup', end)
  frame.addEventListener('pointercancel', end)
  frame.addEventListener('contextmenu', (e) => e.preventDefault())
  // Keep focus in the text bar when the screen is tapped (so the keyboard does not close and reopen)
  frame.addEventListener('mousedown', (e) => e.preventDefault())

  // When the keyboard rises, move the text bar right above it (the screen size stays the same)
  const onViewport = () => {
    const vv = window.visualViewport
    if (!vv) return
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
    el.style.setProperty('--kb', `${Math.round(kb)}px`)
  }
  window.visualViewport?.addEventListener('resize', onViewport)
  window.visualViewport?.addEventListener('scroll', onViewport)

  const settlePreview = () => {
    if (!scrollPreview) return
    const s = new Spring(scrollPreview).use('pull')
    s.t = 0
    tick((dt) => {
      s.step(dt)
      scrollPreview = s.x
      applyStage()
      return !s.resting
    })
  }

  const tapAt = (cx: number, cy: number) => {
    const { fx, fy } = toFrac(cx, cy)
    if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return
    // Mark the tapped spot
    const sr = marks.getBoundingClientRect()
    const dot = h('span', { class: 'tap-dot' })
    dot.style.left = `${((cx - sr.left) / sr.width) * 100}%`
    dot.style.top = `${((cy - sr.top) / sr.height) * 100}%`
    marks.append(dot)
    setTimeout(() => dot.remove(), 800)
    // For an input, open the keyboard now (the moment the finger lifts): opening it later gets blocked by the phone
    const f = shot?.fields?.find((x) => fx >= x.x && fx <= x.x + x.w && fy >= x.y && fy <= x.y + x.h)
    if (f) openType(f)
    // Tapping outside a field closes the text bar (left as is when there is no field info)
    else if (!typeBar.hidden && shot?.fields?.length) closeType()
    o.input({ action: 'tap', x: fx, y: fy })
  }

  // ── Text bar: compare with what was sent before, type what was added and delete what was removed ──
  let sent = ''
  let fresh = false
  /** The field tapped last (only an image carrying that field's info fills the bar) */
  let tapped: RemoteField | undefined
  const flushType = () => {
    const v = typeInput.value
    let i = 0
    while (i < sent.length && i < v.length && sent[i] === v[i]) i++
    for (let k = 0; k < sent.length - i; k++) o.input({ action: 'key', key: 'Backspace' })
    const add = v.slice(i)
    if (add) o.input({ action: 'text', text: add })
    sent = v
    fresh = false
  }
  typeInput.addEventListener('input', (e) => {
    if (!(e as InputEvent).isComposing) flushType()
  })
  typeInput.addEventListener('compositionend', flushType)
  typeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      flushType()
      o.input({ action: 'key', key: 'Enter' })
      closeType()
    }
  })
  nextBtn.addEventListener('pointerdown', (e) => e.preventDefault())
  nextBtn.addEventListener('click', () => {
    flushType()
    o.input({ action: 'key', key: 'Tab' })
    // The next field's text comes from the next image
    typeInput.value = ''
    sent = ''
    fresh = true
    tapped = undefined
    typeLabel.textContent = t.nextField
  })
  doneBtn.addEventListener('pointerdown', (e) => e.preventDefault())
  doneBtn.addEventListener('click', () => {
    flushType()
    closeType()
  })

  function openType(f?: RemoteField, keep = false) {
    const wasOpen = !typeBar.hidden
    typeBar.hidden = false
    typeInput.type = f?.secret ? 'password' : 'text'
    typeInput.inputMode = (f?.mode as typeof typeInput.inputMode) || 'text'
    typeInput.placeholder = f?.secret ? t.secretPlaceholder : t.typePlaceholder
    typeLabel.textContent = f?.label || (f?.secret ? t.password : t.tappedField)
    tapped = f
    if (!keep) {
      typeInput.value = ''
      sent = ''
      fresh = true
    }
    typeInput.focus({ preventScroll: true })
    if (!wasOpen && !reduced())
      springTo(
        typeBar,
        [
          { opacity: 0, transform: 'translateY(16px)' },
          { opacity: 1, transform: 'none' },
        ],
        'fade',
      )
    otpBox.hidden = true
  }
  function closeType() {
    typeInput.blur()
    typeBar.hidden = true
  }

  function toggleOtp() {
    if (!otpBox.hidden) {
      otpBox.hidden = true
      return
    }
    closeType()
    otpBox.replaceChildren(
      h('p', { class: 'meta', text: t.tapCodeFirst }),
      otpBoxes({
        value: '',
        onDone: (code) => {
          o.input({ action: 'text', text: code })
          setTimeout(() => {
            otpBox.hidden = true
          }, 1400)
        },
      }),
    )
    otpBox.hidden = false
    queueMicrotask(() => document.getElementById('otp-input')?.focus())
  }

  // ── New image and info ──
  let formUrl = ''
  let formAskedAt = 0
  const askForm = () => {
    const now = performance.now()
    if (now - formAskedAt < 1200) return
    formAskedAt = now
    o.form()
  }
  const update = (s: Shot | undefined, fps?: number) => {
    shot = s
    // On the first screen or when the address changes, fetch the fields again
    if (s?.url && s.url !== formUrl) {
      // On the first screen ask right away (the screen stays covered while waiting); on a moved-on page wait briefly for it to render
      const first = !formUrl
      formUrl = s.url
      setTimeout(askForm, first ? 0 : 600)
    }
    if (!viewSent) requestAnimationFrame(sendView)
    if (s?.url || s?.title) host.textContent = o.hostOf(s.url ?? '') || s.title || ''
    rate.textContent = fps ? t.liveFps(fps) : t.live
    if (s?.error) {
      msg.hidden = false
      msg.replaceChildren(s.error)
      stage.hidden = true
    } else if (s?.shot) {
      msg.hidden = true
      stage.hidden = false
      const src = `data:image/jpeg;base64,${s.shot}`
      if (img.src !== src) {
        img.src = src
        checkView()
        // If the image came after a scroll was sent, drop the preview
        if (scrollPreview && !gesture && performance.now() - lastScrollSend > 150) {
          scrollPreview = 0
          applyStage()
        }
      }
    }
    frame.classList.toggle('busy', Boolean(s?.busy))
    // Buttons on the page (redrawn only when they change)
    const list = s?.actions ?? []
    const sig = list.map((a) => `${a.label}@${a.x.toFixed(2)},${a.y.toFixed(2)}`).join('|')
    if (sig !== actSig) {
      actSig = sig
      acts.replaceChildren(
        ...list.map((a) =>
          h('button', {
            class: a.main ? 'chip main' : 'chip',
            text: a.label,
            onclick: () => {
              const r = shotRect()
              tapAt(r.left + a.x * r.width, r.top + a.y * r.height)
            },
          }),
        ),
      )
      acts.hidden = !list.length || mode === 'form'
    }
    // First image after tapping a field: fill the bar with the text already in the field (password fields stay empty)
    // An image taken before the tap can arrive late, so accept it only for the tapped field
    const f = s?.focus
    const same =
      f &&
      (!tapped ||
        (Boolean(f.secret) === Boolean(tapped.secret) &&
          (!tapped.label || !f.label || f.label === tapped.label)))
    if (!typeBar.hidden && fresh && f && same) {
      if (f.label) typeLabel.textContent = f.label
      if (f.secret) typeInput.type = 'password'
      if (f.value && !f.secret && !typeInput.value) {
        typeInput.value = f.value
        sent = f.value
      }
      fresh = false
    }
  }

  const setForm = (form: RemoteForm | undefined, error?: string) => {
    decided()
    formPane.set(form, error)
    const usable = formPane.usable()
    seg.hidden = !usable && mode !== 'form'
    // If there are fields to fill, show only the fields at first (unless the person already picked a view)
    if (!chosen && usable && mode !== 'form') setMode('form')
    if (!chosen && !usable && mode === 'form' && !formPane.finishing()) setMode('screen')
  }

  applyStage()
  setMode('screen')
  // On first open: the web screen used to flash before switching to the fields view, so
  // keep the screen covered until the fields arrive (2.5 s max) and open the screen view only if there are none
  el.classList.add('deciding')
  let decidedYet = false
  function decided() {
    if (decidedYet) return
    decidedYet = true
    el.classList.remove('deciding')
  }
  setTimeout(decided, 2500)
  return { tabId: o.tabId, el, update, setForm }
}
