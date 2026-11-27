// Phone app: notifications, web and store app push registration, and opening what a notification points to
import { fromB64u } from '@dool2/protocol/e2e'
import { type AppPushStatus, appPushRegister, appPushStatus, isNative } from '../native.js'
import { send, st, type Tab } from './core.js'
import { render } from './shell.js'

export function notify(title: string, body: string, tag?: string) {
  // Only while the app is in the background. The tag matches the push notification from the PC, so the two never double up
  if (document.visibilityState === 'visible') return
  if ('Notification' in window && Notification.permission === 'granted')
    new Notification(title, { body, ...(tag ? { tag } : {}) })
}

const pushReady = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array) {
  if (!a) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

/** Store app notifications (ADR 0042): what the phone allows, and the address last sent to the PC */
export let appPush: AppPushStatus | undefined
let syncing = false
const APP_PUSH_SENT = 'dool2-app-push'

/**
 * Store app: get the FCM token and this phone's notification key and tell the PC when it changed or the PC lost it.
 * ask only when the user pressed [Turn on] (shows the permission dialog)
 */
export async function syncAppPush(ask = false) {
  if (syncing || !st.saved?.paired || !st.online) return
  syncing = true
  try {
    appPush = await appPushStatus()
    if (!appPush.available || (!appPush.allowed && !ask)) return
    const reg = await appPushRegister(ask)
    appPush = await appPushStatus()
    if (!reg) return
    const sig = `${reg.token}|${reg.key}`
    if (localStorage.getItem(APP_PUSH_SENT) !== sig || !st.pc?.appPush) {
      await send({ kind: 'app-push', reg })
      localStorage.setItem(APP_PUSH_SENT, sig)
    }
  } finally {
    syncing = false
    if (ask) render()
  }
}

/** If notifications are allowed, subscribe to push with this PC's key and tell the PC */
export async function syncPush() {
  if (isNative()) return syncAppPush()
  const vapid = st.pc?.vapid
  if (syncing || !vapid || !pushReady() || Notification.permission !== 'granted') return
  syncing = true
  try {
    const reg = await navigator.serviceWorker.ready
    const key = fromB64u(vapid)
    let sub = await reg.pushManager.getSubscription()
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe()
      sub = null
    }
    const fresh = !sub
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    if (fresh || !st.pc?.push) {
      const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
      if (j.endpoint && j.keys?.p256dh && j.keys.auth)
        await send({
          kind: 'push',
          sub: { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } },
        })
    }
  } catch {
    // Browsers that cannot get a notification address (e.g. iPhone Safari without Add to Home Screen)
  } finally {
    syncing = false
  }
}

/** If opened from a notification (#a=approval id, #t=chat), go to that screen */
export const pushVars = { pendingOpen: '' }
export function openPending() {
  const tab = /^#tab=(chat|feed|ideas|goals|library)$/.exec(pushVars.pendingOpen)?.[1] as Tab | undefined
  if (tab && st.saved?.paired) {
    pushVars.pendingOpen = ''
    history.replaceState(null, '', location.pathname)
    st.screen = { name: 'app' }
    st.tab = tab
    return
  }
  const m = /^#([at])=([\w-]+)$/.exec(pushVars.pendingOpen)
  if (!m || !st.saved?.paired) return
  pushVars.pendingOpen = ''
  history.replaceState(null, '', location.pathname)
  st.screen = { name: 'app' }
  if (m[1] === 'a') {
    st.overlay = { kind: 'approval', id: m[2] as string }
    void send({ kind: 'approval', id: m[2] as string })
  } else st.tab = 'chat'
}
