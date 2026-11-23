// A minimal service worker so the app can be added to the home screen. It caches only the app shell, never chat content.
import { lang } from './lang.js'
import { swText } from './locales/sw.js'

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void
}
interface FetchEvent extends ExtendableEvent {
  request: Request
  respondWith(r: Promise<Response>): void
}
interface PushEvent extends ExtendableEvent {
  data?: { json(): unknown; text(): string }
}
interface NotificationEvent extends ExtendableEvent {
  notification: Notification & { data?: { url?: string } }
}
interface WindowClientLike {
  url: string
  focus(): Promise<unknown>
  navigate(url: string): Promise<unknown>
}
const sw = self as unknown as {
  addEventListener(type: 'install' | 'activate', f: (e: ExtendableEvent) => void): void
  addEventListener(type: 'fetch', f: (e: FetchEvent) => void): void
  addEventListener(type: 'push', f: (e: PushEvent) => void): void
  addEventListener(type: 'notificationclick', f: (e: NotificationEvent) => void): void
  skipWaiting(): Promise<void>
  registration: {
    scope: string
    showNotification(title: string, opts: NotificationOptions & { data?: unknown }): Promise<void>
  }
  clients: {
    matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClientLike[]>
    openWindow(url: string): Promise<unknown>
  }
}
const CACHE = 'dool2-shell-v4'
const SHELL = [
  './',
  './index.html',
  './app.js',
  './ui.css',
  './style.css',
  './manifest.webmanifest',
  './icons/icon192.png',
  './doori/idle.webp',
]

sw.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)))
  void sw.skipWaiting()
})
sw.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  )
})
// Network first, then the cached shell
sw.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return
  e.respondWith(fetch(e.request).catch(async () => (await caches.match(e.request)) ?? Response.error()))
})

// ── Notifications (web push) ──
// The PC sends these for approval requests, hand-offs and finished tasks. The payload is encrypted so only this browser can read it.
// Always shown, even with the app open (iPhone revokes permission if a push arrives without a notification). The same tag is replaced by the newer one
sw.addEventListener('push', (e) => {
  let msg: { title?: string; body?: string; tag?: string; url?: string } = {}
  try {
    msg = (e.data?.json() ?? {}) as typeof msg
  } catch {}
  e.waitUntil(
    sw.registration.showNotification(msg.title || swText(lang).appName, {
      body: msg.body ?? '',
      ...(msg.tag ? { tag: msg.tag } : {}),
      icon: 'icons/icon192.png',
      badge: 'icons/icon192.png',
      data: { url: msg.url ?? '' },
    }),
  )
})

// Tapping a notification opens the app at that approval or chat. An already open window is reused
sw.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const hash = String(e.notification.data?.url ?? '')
  // #a=approval, #t=chat, #tab=tab (scheduled and proactive tasks go to the feed)
  const ok = /^#(?:[at]=[\w-]+|tab=(?:chat|feed|ideas|goals|library))$/.test(hash)
  const target = new URL(`./${ok ? hash : ''}`, sw.registration.scope).href
  e.waitUntil(
    (async () => {
      const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const win = wins.find((w) => w.url.startsWith(sw.registration.scope))
      if (win) {
        await win.navigate(target).catch(() => {})
        await win.focus()
      } else await sw.clients.openWindow(target)
    })(),
  )
})
