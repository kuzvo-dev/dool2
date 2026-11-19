// 원격 화면: 두리가 넘긴 PC 탭을 폰에서 직접 다룬다.
// - PC 탭을 폰 너비로 그리게 해서(view) 글씨가 제 크기로 보인다
// - 쓸어서 내리기(손가락으로 끈 만큼), 두 손가락으로 키우기, 길게 누르면 돋보기로 정확히
// - 입력칸을 누르면 아래에 글자 막대가 뜨고 폰 키보드가 바로 열린다. 쓰는 대로 PC 칸에 들어간다
// - 화면의 버튼은 아래에 큰 버튼으로도 모은다
// 이 화면은 한 번 만들고 그림·정보만 바꾼다 (다시 그리면 키보드가 닫히고 손가락 동작이 끊긴다)
import type { RemoteButton, RemoteField, RemoteFocus, RemoteForm, RemoteFormValue } from '@dool2/protocol'
import { h, icon } from './dom.js'
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
  /** '필요한 칸만'을 달라 */
  form(): void
  /** 칸만 화면에서 채운 값 넣기·버튼 누르기 */
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
  let shot: Shot | undefined
  let viewH = 0
  let viewSent = false

  // ── 머리 ──
  const host = h('span', { class: 'remote-url-text', text: '불러오는 중…' })
  const rate = h('span', { class: 'remote-rate', text: '' })
  const head = h(
    'div',
    { class: 'remote-bar' },
    h('button', { class: 'fbtn small', label: '닫기', onclick: () => leave(o.back) }, icon('close')),
    h(
      'span',
      { class: 'remote-pill' },
      h('span', { class: 'live-dot' }),
      h('span', { class: 'remote-state', text: '직접 하는 중 · 두리는 잠깐 쉬어요' }),
    ),
  )
  const where = h('div', { class: 'remote-where' }, icon('lock'), host, rate)

  // ── 화면 (그림 + 손가락 동작) ──
  const img = h('img', { class: 'remote-shot' })
  img.alt = 'PC 화면. 누르면 PC에서도 그 자리를 눌러요'
  img.draggable = false
  const marks = h('div', { class: 'remote-marks' })
  const stage = h('div', { class: 'remote-stage' }, img, marks)
  const msg = h('p', { class: 'remote-msg' }, h('span', { class: 'spin' }), 'PC 화면을 가져오는 중…')
  const loupe = h('div', { class: 'remote-loupe' })
  loupe.hidden = true
  const hint = h('span', {
    class: 'remote-hint',
    text: '쓸어서 내리기 · 두 손가락으로 크게 · 길게 누르면 돋보기',
  })
  const zoomReset = h('button', { class: 'remote-zoom', text: '원래 크기' })
  zoomReset.hidden = true
  const frame = h('div', { class: 'remote-frame' }, msg, stage, loupe, hint, zoomReset)

  // ── 버튼 모음 ──
  const acts = h('div', { class: 'remote-acts' })
  let actSig = ''

  // ── 글자 막대 (입력칸을 누르면) ──
  const typeLabel = h('span', { class: 'remote-type-label', text: '' })
  const typeInput = h('input', { class: 'remote-type-input' })
  typeInput.autocomplete = 'off'
  typeInput.setAttribute('autocapitalize', 'off')
  typeInput.setAttribute('autocorrect', 'off')
  typeInput.spellcheck = false
  const nextBtn = h('button', { class: 'chip', text: '다음 칸' })
  const doneBtn = h('button', { class: 'chip on', text: '완료' })
  const typeBar = h(
    'div',
    { class: 'remote-typebar' },
    h('div', { class: 'remote-type-head' }, typeLabel, nextBtn, doneBtn),
    typeInput,
  )
  typeBar.hidden = true

  // ── 인증번호 칸 ──
  const otpBox = h('div', { class: 'remote-otp' })
  otpBox.hidden = true

  const tools = h(
    'div',
    { class: 'remote-tools' },
    h('button', { class: 'chip', text: '키보드', onclick: () => openType(undefined, true) }),
    h('button', { class: 'chip', text: '인증번호', onclick: () => toggleOtp() }),
    h('button', { class: 'chip', text: '엔터', onclick: () => o.input({ action: 'key', key: 'Enter' }) }),
  )
  const foot = h(
    'div',
    { class: 'remote-foot' },
    h('button', { class: 'btn-ghost', text: '두리에게 맡기기', onclick: () => leave(o.handBack) }),
    h('button', {
      class: 'btn btn-approve',
      text: o.connectId ? '로그인했어요' : '다 했어요',
      onclick: () => leave(o.done),
    }),
  )
  // ── 필요한 칸만 / 화면 보기 ──
  let mode: 'form' | 'screen' = 'screen'
  let chosen = false
  const formPane = createFormPane({
    fill: (values, press) => o.fill(values, press),
    finish: () => leave(o.done),
    showScreen: () => setMode('screen', true),
  })
  formPane.el.hidden = true
  const segForm = h('button', { text: '필요한 칸만', onclick: () => setMode('form', true) })
  const segScreen = h('button', { text: '화면 보기', onclick: () => setMode('screen', true) })
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
      // 화면 보기로 오면 폰 너비 그리기를 다시 부탁한다 (그동안 풀렸을 수 있다)
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

  // 화면 크기를 정해 PC에 폰 너비로 그려 달라고 한다 (처음 한 번, 붙은 뒤에 잰다)
  const sendView = () => {
    if (viewSent || !frame.isConnected) return
    const w = Math.round(frame.clientWidth)
    viewH = Math.round(Math.max(420, frame.clientHeight || window.innerHeight * 0.62))
    if (!w) return
    viewSent = true
    viewW = w
    o.input({ action: 'view', w, h: viewH })
  }

  // 받은 그림이 폰 너비 모양이 아니면(PC에서 풀렸으면) 다시 부탁한다 (3초에 한 번까지)
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

  // ── 확대·이동·스크롤 미리 보기 ──
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

  // 그림 안 자리 → 사진 비율(0~1)
  // 그림은 칸에 맞춰 줄어(위에 붙어) 보이므로, 실제로 그림이 그려진 자리를 잰다
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
  // 화면 칸 기준 자리 (스크롤 미리 보기로 그림이 밀려 있어도 손가락 자리 그대로)
  const frameFrac = (cx: number, cy: number): [number, number] => {
    const fr = frame.getBoundingClientRect()
    return [(cx - fr.left) / fr.width, (cy - fr.top) / fr.height]
  }
  const toFrac = (cx: number, cy: number) => {
    const r = shotRect()
    return { fx: (cx - r.left) / r.width, fy: (cy - r.top) / r.height, r }
  }

  // ── 손가락 ──
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
    // 손가락으로 끈 화면 픽셀 → 페이지 픽셀 (확대해 있으면 그만큼 덜)
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
      // 두 손가락 가운데를 기준으로 키운다
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
      // 그림은 바로 따라 움직이고, PC에는 조금씩 모아 보낸다
      // 이번 손가락 동작에서 움직인 만큼만 (앞 동작의 미리 보기는 따로)
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
      // 다음 그림이 오면 미리 보기를 풀고, 오지 않으면 스프링으로 제자리
      clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => settlePreview(), 900)
      return
    }
    if (g.mode === 'pan') return
    // 누르기 (그냥 톡, 또는 돋보기로 맞춘 뒤 뗀 자리)
    tapAt(e.clientX, e.clientY)
  }
  frame.addEventListener('pointerup', end)
  frame.addEventListener('pointercancel', end)
  frame.addEventListener('contextmenu', (e) => e.preventDefault())
  // 화면을 눌러도 글자 막대에서 초점이 빠지지 않게 (키보드가 닫혔다 열리며 깜빡이지 않게)
  frame.addEventListener('mousedown', (e) => e.preventDefault())

  // 키보드가 올라오면 글자 막대를 키보드 바로 위로 (화면 크기는 그대로 둔다)
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
    // 누른 자리 표시
    const sr = marks.getBoundingClientRect()
    const dot = h('span', { class: 'tap-dot' })
    dot.style.left = `${((cx - sr.left) / sr.width) * 100}%`
    dot.style.top = `${((cy - sr.top) / sr.height) * 100}%`
    marks.append(dot)
    setTimeout(() => dot.remove(), 800)
    // 입력칸이면 키보드를 지금(손가락을 뗀 그 순간에) 연다: 나중에 열면 폰이 키보드를 막는다
    const f = shot?.fields?.find((x) => fx >= x.x && fx <= x.x + x.w && fy >= x.y && fy <= x.y + x.h)
    if (f) openType(f)
    // 칸이 아닌 곳을 누르면 글자 막대를 닫는다 (칸 정보가 없으면 그대로 둔다)
    else if (!typeBar.hidden && shot?.fields?.length) closeType()
    o.input({ action: 'tap', x: fx, y: fy })
  }

  // ── 글자 막대: 쓴 글자를 앞에 보낸 것과 비교해 늘어난 만큼 넣고 줄어든 만큼 지운다 ──
  let sent = ''
  let fresh = false
  /** 마지막으로 누른 칸 (그 칸의 정보가 온 그림만 막대에 채운다) */
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
    // 다음 칸의 글자는 다음 그림에서 받아 온다
    typeInput.value = ''
    sent = ''
    fresh = true
    tapped = undefined
    typeLabel.textContent = '다음 칸'
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
    typeInput.placeholder = f?.secret ? '비밀번호 (PC 칸에만 들어가요)' : '여기에 쓰면 PC 칸에 들어가요'
    typeLabel.textContent = f?.label || (f?.secret ? '비밀번호' : '누른 칸')
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
      h('p', { class: 'meta', text: 'PC 화면에서 인증번호 칸을 먼저 눌러 주세요' }),
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

  // ── 새 그림·정보 ──
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
    // 처음 화면이 오거나 주소가 바뀌면 칸을 새로 받아 온다
    if (s?.url && s.url !== formUrl) {
      // 처음 화면이면 바로 묻는다 (기다리는 동안 화면을 가려 둔다), 넘어간 화면이면 그려지길 잠깐 기다린다
      const first = !formUrl
      formUrl = s.url
      setTimeout(askForm, first ? 0 : 600)
    }
    if (!viewSent) requestAnimationFrame(sendView)
    if (s?.url || s?.title) host.textContent = o.hostOf(s.url ?? '') || s.title || ''
    rate.textContent = fps ? `실시간 · 초당 ${fps}장` : '실시간'
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
        // 스크롤을 보낸 뒤 온 그림이면 미리 보기를 푼다
        if (scrollPreview && !gesture && performance.now() - lastScrollSend > 150) {
          scrollPreview = 0
          applyStage()
        }
      }
    }
    frame.classList.toggle('busy', Boolean(s?.busy))
    // 화면의 버튼 모음 (바뀔 때만 다시)
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
    // 칸을 누른 뒤 첫 그림: 칸에 이미 있는 글자를 막대에 채운다 (비밀번호 칸은 비워 둔다)
    // 누르기 전에 찍힌 그림이 늦게 올 수 있어서, 누른 칸과 같은 칸일 때만 받는다
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
    // 사람이 채울 칸이 있으면 처음엔 칸만 보여 준다 (사람이 고른 쪽이 있으면 그대로)
    if (!chosen && usable && mode !== 'form') setMode('form')
    if (!chosen && !usable && mode === 'form' && !formPane.finishing()) setMode('screen')
  }

  applyStage()
  setMode('screen')
  // 처음 열 때: '필요한 칸만'을 받기 전에 웹 화면이 먼저 번쩍 보였다가 칸 화면으로 바뀌던 것 →
  // 칸을 받을 때까지(최대 2.5초) 화면을 가려 두고, 칸이 없을 때만 화면 보기로 연다
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
