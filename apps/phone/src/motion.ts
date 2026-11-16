// 스프링 움직임: 단단함(k)·감쇠(c)로 움직인다. 같은 값이면 어디서든 같은 느낌으로 움직인다.
// 1) springEase(): 스프링을 CSS linear() 곡선으로 바꿔 element.animate()에 쓴다 (한 번 움직이고 끝나는 것)
// 2) Spring + tick(): 손으로 미는 것처럼 매 프레임 따라가는 것 (꾹 누르기 등)

/** 쓰는 스프링 (k 단단함, c 감쇠) */
export const SPRING = {
  /** 놓았을 때 자리 잡기: 작게 한 번 넘친다 */
  settle: [280, 22],
  /** 큰 움직임: 시트·판 */
  soft: [260, 24],
  /** 늘어나는 하이라이트의 앞쪽 끝 */
  lead: [620, 36],
  /** 늘어나는 하이라이트의 뒤쪽 끝 (뒤처져서 늘어나 보인다) */
  trail: [190, 19],
  /** 아이콘·숫자가 톡 */
  pop: [520, 16],
  /** 흐려지며 나타나기, 작은 이동 */
  fade: [420, 32],
  /** 일찍 놓았을 때 되돌아가기 */
  release: [260, 14],
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

/** 0에서 1로 가는 스프링을 linear() 곡선과 걸리는 시간으로 (질량 1) */
export function springEase(name: SpringName): { easing: string; ms: number } {
  const hit = cache.get(name)
  if (hit) return hit
  const [k, c] = SPRING[name]
  const dt = 1 / 600
  let x = 0
  let v = 0
  let t = 0
  const pts: [number, number][] = []
  // 멈출 때까지 (1에 아주 가깝고 거의 안 움직이면) 최대 2초
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

/** 스프링으로 한 번 움직인다. 움직임 줄이기 설정이면 바로 끝 모습 */
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

/** 매 프레임 따라가는 스프링 하나 */
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

/** 프레임마다 부른다. false를 돌려주면 멈춘다 */
export function tick(frame: (dt: number) => boolean | undefined): () => void {
  let last = performance.now()
  let stop = false
  const loop = (now: number) => {
    if (stop) return
    const dt = Math.min((now - last) / 1000, 1 / 30)
    last = now
    // 프레임 안에서 4번 나눠 계산하면 단단한 스프링도 튀지 않는다
    let go: boolean | undefined = true
    for (let i = 0; i < 4 && go !== false; i++) go = frame(dt / 4)
    if (go !== false) requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  return () => {
    stop = true
  }
}

// ── 꾹 눌러 승인: 누르는 동안 왼쪽부터 차오르고, 다 차면 승인. 일찍 놓으면 되돌아가며 고개를 젓는다 ──

export function holdButton(o: {
  label: string
  done: string
  cls?: string
  /** 다 차는 데 걸리는 시간(초) */
  sec?: number
  onDone(): void
}): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = `hold ${o.cls ?? ''}`.trim()
  btn.type = 'button'
  btn.setAttribute('aria-label', `${o.label} (꾹 누르기)`)
  const fill = document.createElement('span')
  fill.className = 'hold-fill'
  const under = document.createElement('span')
  under.className = 'hold-label'
  under.textContent = o.label
  const over = document.createElement('span')
  over.className = 'hold-label top'
  over.textContent = o.label
  const hint = document.createElement('span')
  hint.className = 'hold-hint'
  hint.textContent = '꾹 누르고 있어 주세요'
  btn.append(under, fill, over, hint)
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
          btn.classList.add('done')
          over.textContent = o.done
          under.textContent = o.done
          navigator.vibrate?.(18)
          o.onDone()
        }
      } else p.step(dt)
      shake.step(dt)
      draw()
      return holding || !p.resting || !shake.resting
    })
  }
  const start = (e?: PointerEvent) => {
    if (finished) return
    holding = true
    hint.classList.remove('show')
    if (e) btn.setPointerCapture?.(e.pointerId)
    run()
  }
  const end = () => {
    if (!holding) return
    holding = false
    if (p.x < 1) {
      p.t = 0
      shake.v += 260 * Math.min(1, p.x * 2 + 0.3)
      // 그냥 눌렀다 뗐으면 어떻게 하는지 알려 준다
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

// ── 칸 고르기: 하이라이트가 앞 칸에서 새 칸으로 스프링으로 미끄러진다 ──

let segMove: { key: string; x: number; w: number } | undefined
const segKey = (seg: Element) => [...seg.children].map((c) => c.textContent).join('|')

/** 칸을 누르기 직전에 부른다 (다시 그리기 전 자리를 기억) */
export function rememberSeg(btn: HTMLElement) {
  const seg = btn.parentElement
  const cur = seg?.querySelector<HTMLElement>('button[aria-pressed="true"]')
  if (seg && cur && cur !== btn) segMove = { key: segKey(seg), x: cur.offsetLeft, w: cur.offsetWidth }
}

/** 다시 그린 뒤 부른다: 같은 칸 묶음을 찾아 하이라이트를 움직인다 */
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

// ── 스위치: 손잡이가 가는 쪽으로 길게 늘어났다가, 자리에 와서 살짝 튕기며 둥글어진다 ──

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

// ── 생각하는 중: 점들이 가까워지면 서로 늘어나 붙는 쫀득한 필터 (한 번만 넣는다) ──

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

// ── 좋아요 터짐: 누른 자리에서 작은 점들이 둥글게 퍼지며 사라진다 ──

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
    springTo(
      d,
      [
        { transform: 'translate(-50%, -50%) scale(0.4)', opacity: 1 },
        {
          transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(1)`,
          opacity: 1,
          offset: 0.6,
        },
        {
          transform: `translate(calc(-50% + ${x * 1.15}px), calc(-50% + ${y * 1.15}px)) scale(0.2)`,
          opacity: 0,
        },
      ],
      'pop',
    )
  })
  springTo(
    from,
    [{ transform: 'scale(0.82)' }, { transform: 'scale(1.12)', offset: 0.4 }, { transform: 'scale(1)' }],
    'pop',
  )
  setTimeout(() => box.remove(), 900)
}
