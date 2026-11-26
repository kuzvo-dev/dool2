// Phone app: resyncing with the PC after the background or a dropped signal, and pull to refresh
import { doori, h } from '../dom.js'
import { Spring, tick } from '../motion.js'
import { haptic } from '../native.js'
import { AUTH_DONE_OPTION } from '../region/kr/main-d.js'
import { checkAway, noteSeen } from './chat.js'
import { send, st } from './core.js'
import { connect } from './link.js'
import { openOverlay } from './shell.js'
import { hello } from './sms.js'
import { pollConnect, pollWork } from './work.js'

// ── Resync: after the app was in the background or the signal dropped, show the same as the PC ──

export const resyncVars = { lastStreamAt: Date.now() }

/** Fetch the chat, status, life and connections from the PC again */
function resync() {
  if (!st.online || !st.saved?.paired) return
  hello()
  void send({ kind: 'conversation' })
  void send({ kind: 'life' })
  void send({ kind: 'connections' })
  pollWork()
}

export function startResync() {
  // When the app comes back to the front (while it was in the background the phone may have lost the connection or missed signals)
  // The return summary: coming back after a while sums up what happened, from the records
  checkAway()
  setInterval(() => document.visibilityState === 'visible' && noteSeen(), 60_000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      noteSeen()
      return
    }
    checkAway()
    if (st.client && !st.online) connect()
    else resync()
    // Start fetching the screen being watched (working screen, connecting screen) again
    pollWork()
    pollConnect()
    // If the user approved in an auth app (KakaoTalk, PASS) and came back, bring the [I verified] card to the front (measured 11-22 national checkup: it took 3 minutes to find the card)
    const auth = [...st.infos.values()].find(
      (q) => q.status === 'pending' && q.options?.includes(AUTH_DONE_OPTION),
    )
    if (auth && st.overlay?.kind !== 'info') {
      openOverlay({ kind: 'info', id: auth.id })
      haptic('long')
    }
  })
  // Tell the PC every minute that the app is open (the PC streams replies only to phones that are open)
  setInterval(() => {
    if (st.online && st.saved?.paired && document.visibilityState === 'visible') void send({ kind: 'ping' })
  }, 60_000)
  // If a reply is in progress but no signal came for over 40 seconds, fetch the history again
  setInterval(() => {
    if (st.busy && Date.now() - resyncVars.lastStreamAt > 40_000) {
      resyncVars.lastStreamAt = Date.now()
      resync()
    }
  }, 10_000)
}

/** Pull to refresh: pulling down from the top of a list and releasing fetches again from the PC */
/**
 * Pull to refresh: it follows at half speed at first and gets heavier the further you pull (rubber band).
 * Past the threshold Dool2 pops bigger to show it, and on release it spins in place and springs back
 */
export function pullToRefresh(page: HTMLElement) {
  const ind = h('div', { class: 'ptr' }, doori('', 28))
  page.before(ind)
  const TH = 64
  const HOLD = 56
  const rubber = (d: number) => (d <= 180 ? d * 0.55 : 99 + 60 * (1 - 1 / (((d - 180) * 0.55) / 60 + 1)))
  const P = new Spring(0).use('pull')
  const POP = new Spring(1).use('pop')
  let y0 = -1
  let mode: 'idle' | 'pulling' | 'loading' = 'idle'
  let armed = false
  let stop: (() => void) | undefined
  const draw = () => {
    const d = Math.max(0, P.x)
    ind.style.transform = `translate(-50%, ${d.toFixed(2)}px) rotate(${(mode === 'loading' ? 0 : d * 3).toFixed(1)}deg) scale(${POP.x.toFixed(3)})`
    ind.style.opacity = String(Math.min(1, d / 40))
  }
  const run = () => {
    stop?.()
    stop = tick((dt) => {
      P.step(dt)
      POP.step(dt)
      draw()
      return mode === 'pulling' || !(P.resting && POP.resting)
    })
  }
  page.addEventListener(
    'touchstart',
    (e) => {
      if (mode === 'loading') return
      y0 = page.scrollTop <= 0 ? (e.touches[0]?.clientY ?? -1) : -1
    },
    { passive: true },
  )
  page.addEventListener(
    'touchmove',
    (e) => {
      if (y0 < 0 || mode === 'loading') return
      const dy = (e.touches[0]?.clientY ?? y0) - y0
      if (dy <= 0 || page.scrollTop > 0) return
      if (mode !== 'pulling') {
        mode = 'pulling'
        armed = false
        run()
      }
      // Follows the finger directly
      P.x = P.t = rubber(dy)
      P.v = 0
      const over = P.x >= TH
      if (over && !armed) {
        armed = true
        POP.v += 5
        haptic('tick')
      }
      if (!over) armed = false
      ind.classList.toggle('ready', over)
    },
    { passive: true },
  )
  page.addEventListener('touchend', () => {
    if (mode !== 'pulling') return
    y0 = -1
    if (!armed) {
      mode = 'idle'
      P.t = 0
      ind.classList.remove('ready')
      return run()
    }
    mode = 'loading'
    P.t = HOLD
    ind.classList.add('spinning')
    run()
    resync()
    setTimeout(() => {
      ind.classList.remove('spinning', 'ready')
      mode = 'idle'
      P.t = 0
      run()
    }, 900)
  })
}
