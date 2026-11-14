// 홈 화면에 추가할 수 있게 하는 최소한의 서비스 워커. 앱 껍데기만 저장하고, 대화 내용은 저장하지 않는다.
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void
}
interface FetchEvent extends ExtendableEvent {
  request: Request
  respondWith(r: Promise<Response>): void
}
const sw = self as unknown as {
  addEventListener(type: 'install' | 'activate', f: (e: ExtendableEvent) => void): void
  addEventListener(type: 'fetch', f: (e: FetchEvent) => void): void
  skipWaiting(): Promise<void>
}
const CACHE = 'dool2-shell-v2'
const SHELL = [
  './',
  './index.html',
  './app.js',
  './ui.css',
  './style.css',
  './manifest.webmanifest',
  './icons/icon192.png',
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
