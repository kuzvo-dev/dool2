// Three animated cards: number roll (money, percent), what Dool2 did this week (stats card), swiping today's picks (card deck)
// Pages are rebuilt on every redraw, so a card with the same content is plugged back in as the same element to keep motion unbroken
import { lang } from './lang.js'
import { motionText } from './locales/motion.js'
import { reduced, SPRING, Spring, springTo, tick } from './motion.js'
import { haptic } from './native.js'
import { KR_AMOUNT } from './region/kr/motion-cards.js'

// ── Number roll: money and percents in a new reply roll from 0 at each digit and settle on their value (reference: count-roll 320 24) ──

const NUM = KR_AMOUNT

export function rollNumbers(root: HTMLElement) {
  if (reduced()) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  let col = 0
  for (const node of nodes) {
    const text = node.textContent ?? ''
    NUM.lastIndex = 0
    if (!NUM.test(text)) continue
    NUM.lastIndex = 0
    const frag = document.createDocumentFragment()
    let at = 0
    for (const m of text.matchAll(NUM)) {
      frag.append(text.slice(at, m.index))
      const wrap = document.createElement('span')
      wrap.className = 'roll-num'
      wrap.setAttribute('aria-label', m[0])
      for (const ch of m[0]) {
        if (!/\d/.test(ch)) {
          const s = document.createElement('span')
          s.setAttribute('aria-hidden', 'true')
          s.textContent = ch
          wrap.append(s)
          continue
        }
        const c = document.createElement('span')
        c.className = 'roll-col'
        c.setAttribute('aria-hidden', 'true')
        const strip = document.createElement('span')
        strip.className = 'roll-strip'
        strip.textContent = '0123456789'
        c.append(strip)
        wrap.append(c)
        const d = Number(ch)
        springTo(strip, [{ transform: 'translateY(0)' }, { transform: `translateY(${-d * 10}%)` }], 'count', {
          delay: 80 + col++ * 28,
          fill: 'both',
        })
      }
      frag.append(wrap)
      at = (m.index ?? 0) + m[0].length
    }
    frag.append(text.slice(at))
    node.replaceWith(frag)
  }
}

// ── What Dool2 did this week: a smooth line of daily counts, the total rolls up, and switching 7/30 days moves the dots from the left ──

let statCache: { sig: string; el: HTMLElement } | undefined

/** The last `days` days of daily counts (last is today), ending `offset` days ago */
function dayCounts(all: number[], days: number, offset = 0): number[] {
  const end = all.length - offset
  const out = all.slice(Math.max(0, end - days), Math.max(0, end))
  return [...Array<number>(days - out.length).fill(0), ...out]
}

/** all: daily task counts for the last 60 days counted by the PC (LifeState.feedDays, last is today) */
export function statCard(feed: number[]): HTMLElement {
  const txt = motionText(lang)
  const sig = feed.join(',')
  if (statCache?.sig === sig) return statCache.el
  const prev = statCache?.el
  const card = document.createElement('div')
  card.className = 'card stat-card'
  card.innerHTML = `<div class="stat-head"><span class="stat-label">${txt.statWeek}</span><div class="stat-seg" role="group" aria-label="${txt.statPeriod}"><span class="stat-pill"></span><button type="button" aria-pressed="true">${txt.days7}</button><button type="button" aria-pressed="false">${txt.days30}</button></div></div>
<div class="stat-num"><b class="stat-big">0</b><span class="stat-unit">${txt.statUnit}</span><span class="stat-delta"></span></div>
<svg class="stat-chart" height="72" preserveAspectRatio="none"><path class="stat-fill"/><path class="stat-line"/></svg>`
  const big = card.querySelector('.stat-big') as HTMLElement
  const label = card.querySelector('.stat-label') as HTMLElement
  const delta = card.querySelector('.stat-delta') as HTMLElement
  const chart = card.querySelector('.stat-chart') as SVGSVGElement
  const line = card.querySelector('.stat-line') as SVGPathElement
  const fill = card.querySelector('.stat-fill') as SVGPathElement
  const pill = card.querySelector('.stat-pill') as HTMLElement
  const btns = [...card.querySelectorAll<HTMLButtonElement>('.stat-seg button')]
  const N = 30
  // There are always 30 dots: for 7 days the first 23 are stacked on the first day's value
  const pts = [...Array(N)].map(() => new Spring(0, 200, 17))
  const val = new Spring(0, 160, 22)
  const px = new Spring(0).use('bar')
  const pw = new Spring(0).use('bar')
  let range = 7
  let stop: (() => void) | undefined
  const draw = () => {
    const W = chart.clientWidth || 300
    const H = 72
    chart.setAttribute('viewBox', `0 0 ${W} ${H}`)
    const max = Math.max(1, ...pts.map((p) => p.t))
    const xy = pts.map((p, i): [number, number] => [
      4 + (i / (N - 1)) * (W - 8),
      6 + (1 - Math.max(-0.05, p.x / max)) * (H - 12),
    ])
    let d = `M${xy[0]?.[0].toFixed(1)} ${xy[0]?.[1].toFixed(1)}`
    for (let i = 0; i < N - 1; i++) {
      const p0 = xy[i - 1] ?? xy[i]
      const p1 = xy[i]
      const p2 = xy[i + 1]
      const p3 = xy[i + 2] ?? p2
      if (!p0 || !p1 || !p2 || !p3) continue
      d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
    }
    line.setAttribute('d', d)
    fill.setAttribute('d', `${d} L${W - 4} ${H} L4 ${H} Z`)
    big.textContent = String(Math.max(0, Math.round(val.x)))
    pill.style.transform = `translateX(${px.x.toFixed(2)}px)`
    pill.style.width = `${pw.x.toFixed(2)}px`
  }
  const run = () => {
    stop?.()
    stop = tick((dt) => {
      for (const p of pts) p.step(dt)
      val.step(dt)
      px.step(dt)
      pw.step(dt)
      draw()
      return !(pts.every((p) => p.resting) && val.resting && px.resting && pw.resting)
    })
  }
  const pick = (days: number, first = false) => {
    range = days
    const counts = dayCounts(feed, days)
    const before = dayCounts(feed, days, days).reduce((a, b) => a + b, 0)
    const total = counts.reduce((a, b) => a + b, 0)
    label.textContent = days === 7 ? txt.statWeek : txt.statMonth
    const diff = total - before
    delta.textContent = diff === 0 ? txt.sameAsBefore : txt.vsBefore(`${diff > 0 ? '+' : ''}${diff}`)
    delta.classList.toggle('up', diff > 0)
    btns.forEach((b, i) => {
      b.setAttribute('aria-pressed', String(i === (days === 7 ? 0 : 1)))
    })
    const on = btns[days === 7 ? 0 : 1] as HTMLButtonElement
    px.t = on.offsetLeft
    pw.t = on.offsetWidth
    if (first) {
      px.x = px.t
      pw.x = pw.t
    }
    val.t = total
    // One by one from the left to the new values
    const full = days === 7 ? [...Array(N - 7).fill(counts[0] ?? 0), ...counts] : counts
    pts.forEach((p, i) => {
      setTimeout(() => {
        if (range === days) {
          p.t = full[i] ?? 0
          run()
        }
      }, i * 12)
    })
    run()
  }
  btns.forEach((b, i) => {
    b.addEventListener('click', () => pick(i === 0 ? 7 : 30))
  })
  // Measure after attaching to know where the buttons are
  requestAnimationFrame(() => {
    // When the same card is redrawn (a new task appeared), keep rolling from the previous number
    if (prev) val.x = Number(prev.querySelector('.stat-big')?.textContent ?? 0)
    pick(7, true)
  })
  statCache = { sig, el: card }
  return card
}

// ── Today's picks deck: dragging the top card tilts and follows the hand, and a far or fast throw sends it flying ──
// Right = hand it over, left = later (goes to the back). Reference values: drag 900 50, return 280 16, threshold 110px

export interface DeckItem {
  text: string
  why?: string
}

let deckCache: { sig: string; el: HTMLElement } | undefined

export function swipeDeck(items: DeckItem[], o: { onTake(text: string): void }): HTMLElement {
  const txt = motionText(lang)
  const sig = items.map((i) => i.text).join('\n')
  if (deckCache?.sig === sig) return deckCache.el
  const TH = 110
  const deck = document.createElement('div')
  deck.className = 'deck'
  const cards = items.map((it, i) => {
    const el = document.createElement('article')
    el.className = 'deck-card'
    el.setAttribute('aria-label', it.text)
    const t = document.createElement('strong')
    t.className = 'deck-t'
    t.textContent = it.text
    const w = document.createElement('span')
    w.className = 'deck-why'
    w.textContent = it.why ?? ''
    const save = document.createElement('span')
    save.className = 'stamp take'
    save.textContent = txt.take
    const skip = document.createElement('span')
    skip.className = 'stamp skip'
    skip.textContent = txt.later
    el.append(t, w, save, skip)
    deck.append(el)
    return {
      el,
      it,
      save,
      skip,
      x: new Spring(0, ...SPRING.follow),
      y: new Spring(0, ...SPRING.follow),
      d: new Spring(i, 260, 22),
      sign: 1,
      flying: false,
    }
  })
  type Card = (typeof cards)[number]
  let order: Card[] = [...cards]
  const bar = document.createElement('div')
  bar.className = 'deck-bar'
  const skipBtn = document.createElement('button')
  skipBtn.className = 'btn-ghost'
  skipBtn.textContent = txt.later
  const takeBtn = document.createElement('button')
  takeBtn.className = 'btn'
  takeBtn.textContent = txt.take
  bar.append(skipBtn, takeBtn)
  const wrap = document.createElement('div')
  wrap.className = 'deck-wrap'
  wrap.append(deck, bar)
  let stop: (() => void) | undefined
  let drag:
    | { c: Card; id: number; x0: number; y0: number; lx: number; lt: number; vx: number; moved: boolean }
    | undefined
  const tune = (s: Spring, k: number, c: number) => {
    s.k = k
    s.c = c
  }
  const draw = () => {
    const top = order[0]
    const p = top && !top.flying ? Math.min(1, Math.abs(top.x.x) / (TH * 1.6)) : 0
    for (const c of cards) {
      const isTop = c === top
      const depth = Math.max(0, c.d.x - (isTop || c.flying ? 0 : p))
      const s = 1 - Math.min(depth, 3) * 0.05
      const y = Math.min(depth, 3) * 12
      const rot = c.x.x * 0.06 * c.sign
      c.el.style.transform = `translate(${c.x.x.toFixed(1)}px, ${(c.y.x + y).toFixed(1)}px) rotate(${rot.toFixed(2)}deg) scale(${s.toFixed(4)})`
      c.el.style.opacity = String(Math.max(0, Math.min(1, 3.4 - depth)))
      c.el.style.zIndex = String(c.flying ? 50 : 40 - Math.round(c.d.t))
      c.el.classList.toggle('top', isTop)
      c.save.style.opacity = isTop || c.flying ? String(Math.max(0, Math.min(1, c.x.x / TH))) : '0'
      c.skip.style.opacity = isTop || c.flying ? String(Math.max(0, Math.min(1, -c.x.x / TH))) : '0'
    }
  }
  const run = () => {
    stop?.()
    stop = tick((dt) => {
      order.forEach((c, i) => {
        c.d.t = i
      })
      for (const c of cards) {
        c.x.step(dt)
        c.y.step(dt)
        c.d.step(dt)
      }
      draw()
      return Boolean(drag) || !cards.every((c) => c.x.resting && c.y.resting && c.d.resting)
    })
  }
  const fling = (dir: number, vx = 0) => {
    const c = order[0]
    if (!c || c.flying) return
    const p = Math.min(1, Math.abs(c.x.x) / (TH * 1.6))
    for (const o of order) if (o !== c) o.d.x = Math.max(0, o.d.x - p)
    c.flying = true
    tune(c.x, 70, 17)
    tune(c.y, 70, 17)
    c.x.v = dir * Math.max(Math.abs(vx), 1500)
    c.x.t = dir * (innerWidth / 2 + 360)
    order = [...order.slice(1), c]
    haptic('tick')
    if (dir > 0) o.onTake(c.it.text)
    setTimeout(() => {
      c.flying = false
      tune(c.x, ...SPRING.follow)
      tune(c.y, ...SPRING.follow)
      c.x.x = c.x.t = c.x.v = 0
      c.y.x = c.y.t = c.y.v = 0
      c.d.x = order.length + 0.5
      run()
    }, 420)
    run()
  }
  for (const c of cards) {
    c.el.addEventListener('pointerdown', (e) => {
      if (c !== order[0] || c.flying) return
      const r = c.el.getBoundingClientRect()
      drag = {
        c,
        id: e.pointerId,
        x0: e.clientX - c.x.x,
        y0: e.clientY - c.y.x,
        lx: e.clientX,
        lt: performance.now(),
        vx: 0,
        moved: false,
      }
      c.sign = e.clientY < r.top + r.height / 2 ? 1 : -1
      tune(c.x, ...SPRING.follow)
      tune(c.y, ...SPRING.follow)
      c.el.setPointerCapture?.(e.pointerId)
      run()
    })
    c.el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return
      const now = performance.now()
      const dt = Math.max(1, now - drag.lt) / 1000
      drag.vx = drag.vx * 0.5 + ((e.clientX - drag.lx) / dt) * 0.5
      drag.lx = e.clientX
      drag.lt = now
      drag.c.x.t = e.clientX - drag.x0
      drag.c.y.t = (e.clientY - drag.y0) * 0.4
      if (Math.abs(drag.c.x.t) > 6) drag.moved = true
    })
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      const { c: d, vx } = drag
      drag = undefined
      const x = d.x.t
      const dir =
        Math.abs(x) > TH
          ? Math.sign(x)
          : Math.abs(vx) > 700 && Math.sign(vx) === Math.sign(x || vx)
            ? Math.sign(vx)
            : 0
      if (dir) fling(dir, vx)
      else {
        tune(d.x, ...SPRING.back)
        tune(d.y, ...SPRING.back)
        d.x.t = 0
        d.y.t = 0
        run()
      }
    }
    c.el.addEventListener('pointerup', up)
    c.el.addEventListener('pointercancel', up)
  }
  skipBtn.addEventListener('click', () => fling(-1))
  takeBtn.addEventListener('click', () => fling(1))
  requestAnimationFrame(() => {
    run()
  })
  deckCache = { sig, el: wrap }
  return wrap
}
