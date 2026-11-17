// 홈 화면에 추가할 수 있게 하는 최소한의 서비스 워커. 앱 껍데기만 저장하고, 대화 내용은 저장하지 않는다.
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
// 네트워크 먼저, 안 되면 저장해 둔 껍데기
sw.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return
  e.respondWith(fetch(e.request).catch(async () => (await caches.match(e.request)) ?? Response.error()))
})

// ── 알림 (웹 푸시) ──
// PC가 승인 요청·직접 해 주세요·맡긴 일이 끝났을 때 보낸다. 내용은 이 브라우저만 풀 수 있게 암호화돼 온다.
// 앱이 열려 있어도 항상 띄운다 (아이폰은 푸시를 받고 알림을 안 띄우면 권한을 거둔다). 같은 tag는 새 것으로 바뀐다
sw.addEventListener('push', (e) => {
  let msg: { title?: string; body?: string; tag?: string; url?: string } = {}
  try {
    msg = (e.data?.json() ?? {}) as typeof msg
  } catch {}
  e.waitUntil(
    sw.registration.showNotification(msg.title || '두리', {
      body: msg.body ?? '',
      ...(msg.tag ? { tag: msg.tag } : {}),
      icon: 'icons/icon192.png',
      badge: 'icons/icon192.png',
      data: { url: msg.url ?? '' },
    }),
  )
})

// 알림을 누르면 앱을 열고 그 승인·대화로 간다. 열려 있는 앱이 있으면 그 창을 쓴다
sw.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const hash = String(e.notification.data?.url ?? '')
  // #a=승인, #t=대화, #tab=탭 (예약한 일·먼저 챙긴 일은 피드로)
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
