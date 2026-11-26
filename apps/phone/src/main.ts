// Dool2 phone app (v2 design: docs/design/screens/soft). Talks to Dool2 on the PC through the relay with end-to-end encryption (ADR 0012).
// Screens: connect (pairing) -> app (one chat · tasks · ideas · connections) + menu drawer · Dool2 panel · approval and login sheets · PC screen
// The header, tabs and input are built once, and the chat only appends changed messages (so a redraw does not flicker or jump the scroll).

import { linkKey, pairCode } from '@dool2/protocol/e2e'
import { mark, st } from './app/core.js'
import { connect } from './app/link.js'
import { goBack, startPairing } from './app/pairing.js'
import { openPending, pushVars } from './app/push.js'
import { startResync } from './app/resync.js'
import { pillStop, render, renderTabs } from './app/shell.js'
import { lang } from './lang.js'
import { swText } from './locales/sw.js'
import { inviteFrom, isNative, launchInvite, listenNative, onPushOpen } from './native.js'
import { load, loadConv } from './store.js'

// Screen readers and CSS (:lang) follow the UI language (ADR 0029)
document.documentElement.lang = lang
document.title = swText(lang).appName

// ── Start ──

// Scanning a new QR or tapping a notification while the app is open changes only the part after # in the address
window.addEventListener('hashchange', () => {
  const invite = /#p=([\w-]+)/.exec(location.hash)?.[1]
  if (invite) return void startPairing(invite)
  if (/^#([at]=|tab=)/.test(location.hash)) {
    pushVars.pendingOpen = location.hash
    if (st.online) {
      openPending()
      render()
    }
  }
})

async function main() {
  // iPhone Safari ignores the viewport's zoom lock, so pinch zoom is blocked separately (the remote screen handles it itself)
  document.addEventListener('gesturestart', (e) => e.preventDefault())
  // Errors inside the app are noted too (they go along when the user reports a problem)
  window.addEventListener('error', (e) => mark(`error ${e.message}`))
  window.addEventListener('unhandledrejection', (e) =>
    mark(`error ${String((e.reason as Error | undefined)?.message ?? e.reason)}`),
  )
  document.addEventListener('visibilitychange', () => mark(`app ${document.visibilityState}`))
  mark('app started')
  document.documentElement.dataset.theme = 'auto'
  if (!globalThis.crypto?.subtle || !('indexedDB' in window)) {
    st.screen = { name: 'unsupported' }
    return render()
  }
  try {
    // Both encryption (X25519) and signing (Ed25519) are needed. Chrome and WebView support X25519 from 133 and Ed25519 from 137
    await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
    await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
  } catch {
    st.screen = { name: 'unsupported' }
    return render()
  }
  const theme = localStorage.getItem('dool2-theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  // The app doesn't use a service worker (the app code is already inside the app)
  if (!isNative() && 'serviceWorker' in navigator)
    void navigator.serviceWorker.register('sw.js').catch(() => {})
  // A tapped notification (ADR 0042) goes where the PC said, the same way as a web push notification
  onPushOpen((url) => {
    location.hash = url
  })
  listenNative({
    open: (url) => {
      const invite = inviteFrom(url)
      if (invite) void startPairing(invite)
    },
    back: goBack,
  })
  const invite = inviteFrom(location.hash) ?? (await launchInvite())
  if (invite) return startPairing(invite)
  if (/^#([at]=|tab=)/.test(location.hash)) pushVars.pendingOpen = location.hash
  const saved = await load()
  if (!saved) {
    st.screen = { name: 'intro' }
    return render()
  }
  st.saved = saved
  // Show the previous chat first (so the screen isn't empty while waiting for the PC)
  if (saved.paired) st.conv = (await loadConv().catch(() => undefined)) ?? []
  st.key = await linkKey(saved.keys.boxPriv, saved.pcBoxPub, [saved.keys.id, saved.pcId])
  st.screen = saved.paired
    ? { name: 'app' }
    : { name: 'pairing', code: await pairCode(saved.keys.boxPriv, saved.pcBoxPub), pcName: saved.pcName }
  render()
  connect()
  startResync()
  // Re-place the tab pill when the tablet rotates or the window size changes
  // Unfolding, folding or rotating changes the tab bar shape (landscape or portrait, cell width).
  // Measuring mid-change misplaces the pill, so a moving pill stops and is measured again after layout settles
  let settleTabs: ReturnType<typeof setTimeout> | undefined
  const onResize = () => {
    pillStop?.()
    renderTabs()
    clearTimeout(settleTabs)
    settleTabs = setTimeout(() => renderTabs(), 450)
  }
  addEventListener('resize', onResize)
  screen.orientation?.addEventListener?.('change', onResize)
}

void main()
