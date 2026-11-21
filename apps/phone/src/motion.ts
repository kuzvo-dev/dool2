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
  /** 펼치는 카드 (참고 값: expand 240 21) */
  expand: [240, 21],
  /** 당긴 목록이 돌아오기 */
  pull: [260, 18],
  /** 입력칸 높이 */
  field: [420, 34],
  /** 버튼 모양 바뀜 (보내기 ↔ 멈추기) */
  morph: [520, 30],
  /** 메뉴 줄이 하나씩 떠오르기 */
  item: [260, 22],
  /** 체크가 그려지기 */
  check: [140, 20],
  /** 아래 탭: 버튼·글자 자리 */
  bar: [340, 28],
  /** 아래 탭: 아이콘이 찌그러졌다 톡 */
  squash: [520, 14],
  /** 숫자 자리마다 굴러 서기 */
  count: [320, 24],
  /** 손가락을 바로 따라가기 (넘침 없음) */
  follow: [900, 50],
  /** 덜 던진 카드가 돌아오기 */
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
  // 시간은 프레임 시각끼리만 잰다. 프레임 시각이 시작 시각보다 앞설 수 있어서(뒤로 가면 스프링이 터진다) 0 아래로 내려가지 않게 한다
  let last: number | undefined
  let stop = false
  const loop = (now: number) => {
    if (stop) return
    const dt = last === undefined ? 1 / 60 : Math.min(Math.max((now - last) / 1000, 0), 1 / 30)
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
// 다 차면 글자가 빠지고 도는 고리(보내는 중) → 체크가 그려지며 "승인했어요"가 떠오른다 → 잠깐 뒤 after()

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path pathLength="1" d="M5 12.5l4.5 4.5L19 7.5"/></svg>'

export function holdButton(o: {
  label: string
  done: string
  cls?: string
  /** 다 차는 데 걸리는 시간(초) */
  sec?: number
  /** 다 찼을 때. 프로미스를 돌려주면 끝날 때까지 도는 고리를 보이고, 실패하면 되돌린다 */
  onDone(): unknown
  /** 체크까지 보여 준 뒤 (카드를 접는 등) */
  after?(): void
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
  hint.textContent = '꾹 누르고 있어 주세요'
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
          navigator.vibrate?.(18)
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
          // 보내지 못했으면 처음으로: 초록이 빠지며 흔들린다
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
    // 점은 스프링이 아니라 한 번에 퍼졌다 사라진다 (스프링은 넘쳤다 돌아오며 점이 되돌아온다)
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

// ── 펼치는 카드: 바꾸기 전·후 높이를 재서 스프링으로 늘였다 줄인다 ──

export function springHeight(el: HTMLElement, change: () => void, name: SpringName = 'expand') {
  const h0 = el.getBoundingClientRect().height
  change()
  const h1 = el.getBoundingClientRect().height
  if (Math.abs(h1 - h0) < 1) return
  // 접을 때 최대 높이에 막혀 바로 줄어들지 않게, 움직이는 동안은 풀어 둔다
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

// ── 메뉴 줄: 아래에서 하나씩 떠오른다 ──

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

// ── 체크: 톡 커지며 선이 그려진다 ──

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

// ── 인증번호 칸: 숨은 입력칸 하나 + 보이는 칸 여섯. 숫자가 톡 떨어지고, 다 차면 칸이 붙어 초록 알약이 된다 ──

export function otpBoxes(o: {
  value?: string
  length?: number
  /** 자릿수를 모를 때: 4~8자리를 받고 [넣기]로 보낸다 (사이트마다 4·6·7자리로 달랐다 — 실측 11-22 키즈노트 4자리) */
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
  inp.setAttribute('aria-label', `인증번호 ${N}자리`)
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
  ok.innerHTML = `${CHECK_SVG}<span>넣었어요</span>`
  box.append(row, ok, inp)
  // 자릿수를 모르면 [넣기]: 4자리부터 눌러 보낸다
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'btn lg otp-go'
  go.textContent = '넣기'
  go.disabled = true
  // 버튼은 상자 밖에 둔다 (상자는 높이가 고정이라 안에 넣으면 아래 글 위로 넘쳤다 — 실측 11-22)
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
      // 다시 그려져 다 찬 채로 시작하면 이미 보낸 것: 초록으로만 보이고 다시 보내지 않는다
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
    // 칸 사이가 닫히며 하나로 붙고, 초록이 되며 '넣었어요'
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
      navigator.vibrate?.(12)
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

// ── 이어 쓰기 제안: 쓰는 말 뒤에 흐린 글씨로 나머지를 보여 주고, 받으면 글자가 하나씩 밝아지며 톡 ──

export function acceptGhost(letters: HTMLElement[]) {
  letters.forEach((l, i) => {
    l.classList.add('ok')
    springTo(l, [{ transform: 'translateY(-5px)' }, { transform: 'none' }], 'squash', { delay: i * 16 })
  })
}
