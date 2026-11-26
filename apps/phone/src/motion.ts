// Spring motion: driven by stiffness (k) and damping (c). The same values feel the same everywhere.
// 1) springEase(): turns a spring into a CSS linear() curve for element.animate() (one-shot moves)
// 2) Spring + tick(): follows every frame like being pushed by hand (press and hold, etc.)
import { lang } from './lang.js'
import { motionText } from './locales/motion.js'
import { haptic } from './native.js'

/** Springs in use (k stiffness, c damping) */
export const SPRING = {
  /** Settling on release: overshoots slightly once */
  settle: [280, 22],
  /** Big moves: sheets and panels */
  soft: [260, 24],
  /** Leading edge of a stretching highlight */
  lead: [620, 36],
  /** Trailing edge of a stretching highlight (lags behind so it looks stretched) */
  trail: [190, 19],
  /** A quick pop for icons and numbers */
  pop: [520, 16],
  /** Fade in, small moves */
  fade: [420, 32],
  /** Returning when released early */
  release: [260, 14],
  /** Expanding card (reference: expand 240 21) */
  expand: [240, 21],
  /** A pulled list returning */
  pull: [260, 18],
  /** Input box height */
  field: [420, 34],
  /** Button shape change (send / stop) */
  morph: [520, 30],
  /** Menu rows rising one by one */
  item: [260, 22],
  /** A check being drawn */
  check: [140, 20],
  /** Bottom tabs: button and label position */
  bar: [340, 28],
  /** Bottom tabs: the icon squashes then pops */
  squash: [520, 14],
  /** Each digit rolling into place */
  count: [320, 24],
  /** Following the finger directly (no overshoot) */
  follow: [900, 50],
  /** A card thrown too weakly coming back */
  back: [280, 16],
} as const satisfies Record<string, readonly [number, number]>

export type SpringName = keyof typeof SPRING

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

const supportsLinear = (() => {
  try {
    return CSS.supports('animation-timing-function', 'linear(0, 1)')
  } catch {
    return false
  }
})()

const cache = new Map<string, { easing: string; ms: number }>()

/** A spring going from 0 to 1 as a linear() curve and its duration (mass 1) */
export function springEase(name: SpringName): { easing: string; ms: number } {
  const hit = cache.get(name)
  if (hit) return hit
  const [k, c] = SPRING[name]
  const dt = 1 / 600
  let x = 0
  let v = 0
  let t = 0
  const pts: [number, number][] = []
  // Until it stops (very close to 1 and barely moving), 2 s at most
  while (t < 2) {
    const a = -k * (x - 1) - c * v
    v += a * dt
    x += v * dt
    t += dt
    pts.push([t, x])
    if (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01) break
  }
  const total = t
  const N = 40
  const out: string[] = ['0']
  for (let i = 1; i <= N; i++) {
    const p = pts[Math.min(pts.length - 1, Math.round((i / N) * (pts.length - 1)))] as [number, number]
    out.push(`${p[1].toFixed(4)} ${((p[0] / total) * 100).toFixed(1)}%`)
  }
  out[out.length - 1] = '1 100%'
  const r = {
    easing: supportsLinear ? `linear(${out.join(', ')})` : 'cubic-bezier(0.3, 1.25, 0.4, 1)',
    ms: Math.round(total * 1000),
  }
  cache.set(name, r)
  return r
}

/** Moves once with a spring. With reduce-motion on, jumps straight to the end state */
export function springTo(
  el: Element,
  frames: Keyframe[],
  name: SpringName = 'settle',
  opts: { delay?: number; fill?: FillMode } = {},
  pseudoElement?: string,
): Animation | undefined {
  if (reduced()) return undefined
  const { easing, ms } = springEase(name)
  try {
    return el.animate(frames, { duration: ms, easing, ...opts, ...(pseudoElement ? { pseudoElement } : {}) })
  } catch {
    return undefined
  }
}

/** One spring that follows every frame */
export class Spring {
  v = 0
  t: number
  constructor(
    public x: number,
    public k: number = SPRING.settle[0],
    public c: number = SPRING.settle[1],
  ) {
    this.t = x
  }
  use(name: SpringName) {
    ;[this.k, this.c] = SPRING[name]
    return this
  }
  step(dt: number) {
    const a = -this.k * (this.x - this.t) - this.c * this.v
    this.v += a * dt
    this.x += this.v * dt
  }
  get resting() {
    return Math.abs(this.x - this.t) < 0.0005 && Math.abs(this.v) < 0.005
  }
}

/** Called every frame. Returning false stops it */
export function tick(frame: (dt: number) => boolean | undefined): () => void {
  // Time is measured only between frame timestamps. A frame time can precede the start time (going backwards makes the spring blow up), so clamp at 0
  let last: number | undefined
  let stop = false
  const loop = (now: number) => {
    if (stop) return
    const dt = last === undefined ? 1 / 60 : Math.min(Math.max((now - last) / 1000, 0), 1 / 30)
    last = now
    // Splitting each frame into 4 steps keeps even stiff springs from jittering
    let go: boolean | undefined = true
    for (let i = 0; i < 4 && go !== false; i++) go = frame(dt / 4)
    if (go !== false) requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  return () => {
    stop = true
  }
}

// ── Press and hold to approve: fills from the left while held, approves when full. Released early, it goes back and shakes its head ──
// When full the label drops out and a ring spins (sending), then a check is drawn and the done text rises, then after() a moment later

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path pathLength="1" d="M5 12.5l4.5 4.5L19 7.5"/></svg>'

export function holdButton(o: {
  label: string
  done: string
  cls?: string
  /** Time to fill (seconds) */
  sec?: number
  /** When full. If it returns a promise, a ring spins until it ends, and it rolls back on failure */
  onDone(): unknown
  /** After the check has been shown (collapse the card, etc.) */
  after?(): void
}): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = `hold ${o.cls ?? ''}`.trim()
  btn.type = 'button'
  btn.setAttribute('aria-label', motionText(lang).holdAria(o.label))
  const fill = document.createElement('span')
  fill.className = 'hold-fill'
  const under = document.createElement('span')
  under.className = 'hold-label'
  under.textContent = o.label
  const over = document.createElement('span')
  over.className = 'hold-label top'
  const overText = document.createElement('span')
  overText.textContent = o.label
  const ok = document.createElement('span')
  ok.className = 'hold-ok'
  ok.innerHTML = CHECK_SVG
  over.append(ok, overText)
  const spin = document.createElement('span')
  spin.className = 'hold-spin'
  const hint = document.createElement('span')
  hint.className = 'hold-hint'
  hint.textContent = motionText(lang).holdHint
  btn.append(under, fill, over, spin, hint)
  const sec = o.sec ?? 0.9
  const p = new Spring(0).use('release')
  const shake = new Spring(0, 700, 9)
  let holding = false
  let finished = false
  let stop: (() => void) | undefined
  let hintTimer: ReturnType<typeof setTimeout> | undefined
  const draw = () => {
    const v = Math.max(0, Math.min(1, p.x))
    fill.style.clipPath = `inset(0 ${((1 - v) * 100).toFixed(2)}% 0 0)`
    over.style.clipPath = fill.style.clipPath
    btn.style.transform = `translateX(${shake.x.toFixed(2)}px) scale(${holding ? 0.97 : 1})`
  }
  const run = () => {
    stop?.()
    stop = tick((dt) => {
      if (holding) {
        p.x = Math.min(1, p.x + dt / sec)
        p.v = 0
        p.t = p.x
        if (p.x >= 1 && !finished) {
          finished = true
          holding = false
          btn.classList.remove('holding')
          haptic('confirm')
          complete()
        }
      } else p.step(dt)
      shake.step(dt)
      draw()
      return holding || !p.resting || !shake.resting
    })
  }
  const complete = () => {
    btn.classList.add('busy')
    btn.setAttribute('aria-busy', 'true')
    springTo(
      overText,
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateY(-12px)' },
      ],
      'fade',
      {
        fill: 'forwards',
      },
    )
    springTo(
      spin,
      [
        { opacity: 0, transform: 'scale(0.6)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      'settle',
      {
        fill: 'forwards',
      },
    )
    Promise.resolve()
      .then(() => o.onDone())
      .then(
        () => {
          btn.classList.remove('busy')
          btn.classList.add('done')
          btn.removeAttribute('aria-busy')
          btn.setAttribute('aria-label', o.done)
          overText.textContent = o.done
          under.textContent = o.done
          springTo(spin, [{ opacity: 1 }, { opacity: 0 }], 'fade', { fill: 'forwards' })
          springTo(
            overText,
            [
              { opacity: 0, transform: 'translateY(12px)' },
              { opacity: 1, transform: 'none' },
            ],
            'fade',
            {
              fill: 'forwards',
            },
          )
          springTo(ok, [{ transform: 'scale(0.4)' }, { transform: 'scale(1)' }], 'pop')
          springTo(
            ok.querySelector('path') as Element,
            [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
            'check',
            { delay: 120, fill: 'both' },
          )
          setTimeout(() => o.after?.(), 750)
        },
        () => {
          // If it could not be sent, back to the start: the green drains and it shakes
          btn.classList.remove('busy')
          btn.removeAttribute('aria-busy')
          springTo(spin, [{ opacity: 1 }, { opacity: 0 }], 'fade', { fill: 'forwards' })
          springTo(overText, [{ opacity: 0 }, { opacity: 1 }], 'fade', { fill: 'forwards' })
          finished = false
          p.t = 0
          shake.v += 300
          run()
        },
      )
  }
  const start = (e?: PointerEvent) => {
    if (finished) return
    holding = true
    btn.classList.add('holding')
    hint.classList.remove('show')
    if (e) btn.setPointerCapture?.(e.pointerId)
    run()
  }
  const end = () => {
    if (!holding) return
    holding = false
    btn.classList.remove('holding')
    if (p.x < 1) {
      p.t = 0
      shake.v += 260 * Math.min(1, p.x * 2 + 0.3)
      // If it was just tapped and released, show how it works
      if (p.x < 0.25) {
        hint.classList.add('show')
        clearTimeout(hintTimer)
        hintTimer = setTimeout(() => hint.classList.remove('show'), 1800)
      }
    }
    run()
  }
  btn.addEventListener('pointerdown', start)
  btn.addEventListener('pointerup', end)
  btn.addEventListener('pointercancel', end)
  btn.addEventListener('lostpointercapture', end)
  btn.addEventListener('contextmenu', (e) => e.preventDefault())
  btn.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault()
      start()
    }
  })
  btn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') end()
  })
  draw()
  return btn
}

// ── Segment picker: the highlight springs from the old segment to the new one ──

let segMove: { key: string; x: number; w: number } | undefined
const segKey = (seg: Element) => [...seg.children].map((c) => c.textContent).join('|')

/** Call just before a segment is tapped (remembers the position before redraw) */
export function rememberSeg(btn: HTMLElement) {
  const seg = btn.parentElement
  const cur = seg?.querySelector<HTMLElement>('button[aria-pressed="true"]')
  if (seg && cur && cur !== btn) segMove = { key: segKey(seg), x: cur.offsetLeft, w: cur.offsetWidth }
}

/** Call after redrawing: finds the same segment group and moves the highlight */
export function playSeg() {
  const m = segMove
  segMove = undefined
  if (!m || reduced()) return
  const seg = [...document.querySelectorAll('.seg')].find((s) => segKey(s) === m.key)
  const to = seg?.querySelector<HTMLElement>('button[aria-pressed="true"]')
  if (!seg || !to) return
  const hl = document.createElement('span')
  hl.className = 'seg-hl'
  seg.prepend(hl)
  to.classList.add('seg-to')
  const a = springTo(
    hl,
    [
      { left: `${m.x}px`, width: `${m.w}px` },
      { left: `${to.offsetLeft}px`, width: `${to.offsetWidth}px` },
    ],
    'settle',
  )
  const done = () => {
    hl.remove()
    to.classList.remove('seg-to')
  }
  if (a) a.onfinish = done
  else done()
}

// ── Switch: the knob stretches toward where it goes, then bounces slightly and rounds out in place ──

let flip: { id: string; on: boolean; at: number } | undefined

export function rememberFlip(id: string, on: boolean) {
  flip = { id, on, at: Date.now() }
}

export function playFlip() {
  const f = flip
  if (!f) return
  if (Date.now() - f.at > 3000) {
    flip = undefined
    return
  }
  const sw = document.querySelector<HTMLElement>(`.switch[data-id="${CSS.escape(f.id)}"]`)
  if (!sw || sw.getAttribute('aria-checked') !== String(f.on)) return
  flip = undefined
  const from = f.on ? 0 : 18
  const to = f.on ? 18 : 0
  springTo(
    sw,
    [
      { transform: `translateX(${from}px) scaleX(1)` },
      { transform: `translateX(${(from + to) / 2}px) scaleX(1.35)`, offset: 0.35 },
      { transform: `translateX(${to}px) scaleX(1)` },
    ],
    'settle',
    {},
    '::after',
  )
}

// ── Thinking: a gooey filter where dots stretch and merge when they get close (added once) ──

export function gooFilter() {
  if (document.getElementById('goo')) return
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  svg.innerHTML =
    '<filter id="goo"><feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="b"/>' +
    '<feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8" result="g"/>' +
    '<feComposite in="SourceGraphic" in2="g" operator="atop"/></filter>'
  document.body.append(svg)
}

// ── Like burst: small dots spread out in a circle from the tapped spot and vanish ──

const BURST = ['#ff5a76', '#ff9f45', '#ffd34d', '#4cd38a', '#4ea8ff', '#9b7bff', '#ff7ac8', '#ff5a76']

export function burst(from: Element) {
  if (reduced()) return
  const r = from.getBoundingClientRect()
  const box = document.createElement('span')
  box.className = 'burst'
  box.style.left = `${r.left + r.width / 2}px`
  box.style.top = `${r.top + r.height / 2}px`
  document.body.append(box)
  BURST.forEach((c, i) => {
    const d = document.createElement('i')
    d.style.background = c
    box.append(d)
    const a = (i / BURST.length) * Math.PI * 2 + 0.2
    const x = Math.cos(a) * 30
    const y = Math.sin(a) * 30
    // Dots spread and vanish in one go, not by spring (a spring would overshoot and bring the dots back)
    const far = 34 + (i % 2) * 6
    d.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.3)', opacity: 1 },
        {
          transform: `translate(calc(-50% + ${x * 0.8}px), calc(-50% + ${y * 0.8}px)) scale(1.1)`,
          opacity: 1,
          offset: 0.45,
        },
        {
          transform: `translate(calc(-50% + ${(x / 30) * far}px), calc(-50% + ${(y / 30) * far}px)) scale(0.2)`,
          opacity: 0,
        },
      ],
      { duration: 620, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
    )
  })
  springTo(from, [{ transform: 'scale(0.8)' }, { transform: 'scale(1)' }], 'pop')
  setTimeout(() => box.remove(), 900)
}

// ── Expanding card: measures the height before and after the change and springs between them ──

export function springHeight(el: HTMLElement, change: () => void, name: SpringName = 'expand') {
  const h0 = el.getBoundingClientRect().height
  change()
  const h1 = el.getBoundingClientRect().height
  if (Math.abs(h1 - h0) < 1) return
  // Lifted while animating so collapsing is not blocked by the max height
  el.style.overflow = 'hidden'
  el.style.maxHeight = 'none'
  const a = springTo(el, [{ height: `${h0}px` }, { height: `${h1}px` }], name)
  const done = () => {
    el.style.removeProperty('overflow')
    el.style.removeProperty('max-height')
  }
  if (a) a.onfinish = a.oncancel = done
  else done()
}

// ── Menu rows: rise one by one from below ──

export function riseIn(els: Iterable<Element>, gap = 45) {
  let i = 0
  for (const el of els)
    springTo(
      el,
      [
        { opacity: 0, transform: 'translateY(18px)' },
        { opacity: 1, transform: 'none' },
      ],
      'item',
      {
        delay: 60 + i++ * gap,
        fill: 'backwards',
      },
    )
}

// ── Check: pops up while the line is drawn ──

export function drawCheck(box: Element, delay = 0) {
  springTo(box, [{ transform: 'scale(0.7)' }, { transform: 'scale(1)' }], 'pop', { delay })
  for (const path of box.querySelectorAll('path, polyline')) {
    path.setAttribute('pathLength', '1')
    ;(path as SVGElement).style.strokeDasharray = '1'
    springTo(path, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], 'check', {
      delay: delay + 100,
      fill: 'both',
    })
  }
}

// ── Verification code boxes: one hidden input + six visible boxes. Digits drop in, and when full the boxes merge into a green pill ──

export function otpBoxes(o: {
  value?: string
  length?: number
  /** When the digit count is unknown: accept 4 to 8 digits and send with the Enter button (sites differ: 4, 6 or 7 digits; measured 11-22: one site used 4) */
  flex?: boolean
  onInput?(v: string): void
  onDone(code: string): void
}): HTMLElement & { go?: HTMLButtonElement } {
  const flex = Boolean(o.flex) && !o.length
  const N = flex ? 8 : (o.length ?? 6)
  const shown = (len: number) => (flex ? Math.min(N, Math.max(6, len + 1)) : N)
  const box = document.createElement('div')
  box.className = 'otp'
  const row = document.createElement('div')
  row.className = 'otp-row'
  const inp = document.createElement('input')
  inp.className = 'otp-input'
  inp.id = 'otp-input'
  inp.inputMode = 'numeric'
  inp.autocomplete = 'one-time-code'
  inp.maxLength = N
  inp.setAttribute('aria-label', motionText(lang).otpAria(N))
  const cells = [...Array(N)].map(() => {
    const el = document.createElement('span')
    el.className = 'otp-bx'
    const d = document.createElement('i')
    el.append(d)
    row.append(el)
    return { el, d }
  })
  const ok = document.createElement('span')
  ok.className = 'otp-ok'
  ok.innerHTML = `${CHECK_SVG}<span>${motionText(lang).otpDone}</span>`
  box.append(row, ok, inp)
  // Unknown digit count: the Enter button, usable from 4 digits
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'btn lg otp-go'
  go.textContent = motionText(lang).otpGo
  go.disabled = true
  // The button stays outside the box (the box has a fixed height, so inside it overflowed onto the text below; measured 11-22)
  let val = ''
  let done = false
  const set = (raw: string, quiet = false) => {
    const v = raw.replace(/\D/g, '').slice(0, N)
    const n = shown(v.length)
    cells.forEach((c, i) => {
      c.el.hidden = i >= n
      const ch = v[i] ?? ''
      if (ch && c.d.textContent !== ch && !quiet)
        springTo(
          c.d,
          [
            { opacity: 0, transform: 'translateY(-14px)' },
            { opacity: 1, transform: 'none' },
          ],
          'squash',
        )
      c.d.textContent = ch
      c.el.classList.toggle('on', !done && i === Math.min(v.length, n - 1))
    })
    val = v
    inp.value = v
    go.disabled = done || v.length < 4
    if (!flex && v.length === N && !done) {
      // If redrawn already full, it was already sent: shown green only and not sent again
      if (quiet) {
        done = true
        for (const c of cells) c.el.classList.remove('on')
        row.style.gap = '0px'
        box.classList.add('joined', 'ok')
        ok.style.opacity = '1'
        ;(ok.querySelector('path') as SVGElement | null)?.style.setProperty('stroke-dashoffset', '0')
      } else finish()
    }
  }
  const finish = () => {
    done = true
    go.hidden = true
    cells.forEach((c, i) => {
      c.el.classList.remove('on')
      if (i >= val.length) c.el.hidden = true
    })
    // The gaps close and the boxes merge into one, turn green, and show the done text
    springTo(row, [{ gap: '8px' }, { gap: '0px' }], 'soft', { delay: 200, fill: 'forwards' })
    setTimeout(() => box.classList.add('joined'), 200)
    setTimeout(() => {
      box.classList.add('ok')
      springTo(
        ok,
        [
          { opacity: 0, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'none' },
        ],
        'fade',
        {
          fill: 'forwards',
        },
      )
      drawCheck(ok.querySelector('svg') as Element)
      haptic('tick')
      o.onDone(val)
    }, 520)
  }
  inp.addEventListener('input', () => {
    if (done) return
    set(inp.value)
    o.onInput?.(val)
  })
  go.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!done && val.length >= 4) finish()
  })
  inp.addEventListener('keydown', (e) => {
    if (flex && e.key === 'Enter' && !done && val.length >= 4) finish()
  })
  box.addEventListener('click', () => inp.focus())
  set(o.value ?? '', true)
  return flex ? Object.assign(box, { go }) : box
}

// ── Continue-typing suggestion: shows the rest in faint text after what is typed, and on accept the letters brighten one by one ──

export function acceptGhost(letters: HTMLElement[]) {
  letters.forEach((l, i) => {
    l.classList.add('ok')
    springTo(l, [{ transform: 'translateY(-5px)' }, { transform: 'none' }], 'squash', { delay: i * 16 })
  })
}
