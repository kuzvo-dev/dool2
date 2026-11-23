#!/usr/bin/env node
// Measures response size and time of the life records (feed, library, memory, goals). Does not call a real AI: fills a temp folder with full records, starts the daemon and measures.
// Usage: pnpm build && node apps/daemon/scripts/bench-life.mjs [feed count] [library count]
//   Defaults to the old storage limits (feed 300, library 500, memory 200, goals 50). Never touches the user's data folder
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '@dool2/store'
import { startDaemon } from '../dist/index.js'

const FEED = Number(process.argv[2]) || 300
const LIBRARY = Number(process.argv[3]) || 500
const MEMORY = 200
const ROUTINES = 50

// Imitates Korean text (3 bytes each in UTF-8): only the length matters
const WORDS =
  '오늘 택배가 도착했어요 내일 오전 비 소식이 있어요 엄마 생신 선물 꽃다발 러닝화 주문 예약 확인했어요'.split(
    ' ',
  )
let seed = 7
const rand = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}
const text = (n) => {
  let s = ''
  while (s.length < n) s += `${WORDS[Math.floor(rand() * WORDS.length)]} `
  return s.slice(0, n)
}
const now = Date.now()
const ago = (min) => new Date(now - min * 60_000).toISOString()

function fill(dir) {
  const store = new Store(join(dir, 'dool2.db'))
  const kinds = ['done', 'done', 'done', 'routine', 'post', 'saved', 'suggest', 'goal']
  // Feed: about 10 per day (most recent first)
  const feed = Array.from({ length: FEED }, (_, i) => {
    const kind = kinds[i % kinds.length]
    const body = kind === 'routine' ? 600 : kind === 'post' ? 800 : kind === 'saved' ? 0 : 150
    return {
      id: `f-${i}`,
      kind,
      title: text(40),
      ...(body ? { body: text(body) } : {}),
      at: ago(i * 144),
      ...(kind === 'suggest' ? { from: '쿠팡 주문 내역을 보고', key: `k-${i}` } : {}),
    }
  })
  const libKinds = ['note', 'note', 'link', 'product', 'place', 'file']
  const library = Array.from({ length: LIBRARY }, (_, i) => {
    const kind = libKinds[i % libKinds.length]
    return {
      id: `l-${i}`,
      kind,
      title: text(30),
      body: text(kind === 'note' ? 1500 : kind === 'file' ? 100 : 300),
      ...(kind === 'link' || kind === 'product' ? { url: `https://example.com/item/${i}` } : {}),
      ...(kind === 'product' ? { price: '39,900원' } : {}),
      savedAt: ago(i * 300),
    }
  })
  const memory = Array.from({ length: MEMORY }, (_, i) => ({
    id: `m-${i}`,
    text: text(50),
    source: i % 3 ? 'doori' : 'user',
    at: ago(i * 600),
  }))
  // 15 goals (30 plan and progress entries each) + 35 automatic routines
  const routines = Array.from({ length: ROUTINES }, (_, i) => {
    const goal = i < 15
    return {
      id: `r-${i}`,
      title: text(20),
      prompt: text(200),
      enabled: true,
      createdAt: ago(i * 1000),
      schedule: { kind: 'daily', time: '08:00' },
      nextRunAt: new Date(now + 3600_000).toISOString(),
      lastResult: text(300),
      ...(goal
        ? {
            category: '건강',
            plan: Array.from({ length: 6 }, (_, j) => ({ text: text(40), done: j < 2 })),
            log: Array.from({ length: 30 }, (_, j) => ({ at: ago(j * 1440), text: text(200) })),
          }
        : {}),
    }
  })
  store.setSetting('feed', feed)
  store.setSetting('library', library)
  store.setSetting('memory', memory)
  store.setSetting('routines', routines)
  store.setSetting('setupDone', true)
  store.close()
}

const fake = (id) => ({
  id,
  async detect() {
    return { id, installed: false, loggedIn: false }
  },
  async *runTurn() {},
})

const dir = await mkdtemp(join(tmpdir(), 'dool2-bench-'))
fill(dir)
const daemon = await startDaemon({
  dataDir: dir,
  token: 'bench',
  journal: false,
  timeLine: () => undefined,
  runtimes: { claude: fake('claude'), codex: fake('codex') },
  chrome: { detect: async () => ({ installed: true, version: '157.0.0.0' }) },
})

/** Size sent to the phone: {kind, state} as JSON -> AES-GCM (16-byte tag) -> base64url */
const phoneBytes = (kind, body) => {
  const n = Buffer.byteLength(JSON.stringify({ kind, ...body }))
  return Math.ceil(((n + 16) * 4) / 3)
}
const kb = (n) => `${(n / 1024).toFixed(1)}KB`

async function measure(path, phoneKind) {
  const get = () => fetch(`${daemon.url}${path}`, { headers: { authorization: 'Bearer bench' } })
  const first = await get()
  if (!first.ok) return console.log(`${path.padEnd(36)} (missing ${first.status})`)
  const raw = await first.text()
  const times = []
  for (let i = 0; i < 30; i++) {
    const t = performance.now()
    await (await get()).text()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  const body = JSON.parse(raw)
  const items = ['feed', 'library', 'memory', 'routines', 'items']
    .filter((k) => Array.isArray(body[k]))
    .map((k) => `${k} ${body[k].length} items ${kb(Buffer.byteLength(JSON.stringify(body[k])))}`)
    .join(' · ')
  const phone = phoneKind
    ? ` · phone ${kb(phoneBytes(phoneKind, phoneKind === 'life' ? { state: body } : body))}`
    : ''
  console.log(
    `${path.padEnd(36)} ${kb(Buffer.byteLength(raw)).padStart(9)} · median ${times[15].toFixed(1)}ms · max ${times[29].toFixed(1)}ms${phone}\n   ${items}`,
  )
}

console.log(`Records: feed ${FEED} · library ${LIBRARY} · memory ${MEMORY} · goals ${ROUTINES}`)
await measure('/api/life', 'life')
await measure('/api/life/feed?limit=30', 'life-page')
await measure('/api/life/library?limit=30', 'life-page')
await daemon.close()

// Life records the phone receives (what link.ts sends: only 8 goal progress lines)
{
  const { Life } = await import('../dist/life.js')
  const store = new Store(join(dir, 'dool2.db'))
  const life = new Life(store)
  const t = performance.now()
  const state = typeof life.state === 'function' ? life.state({ logs: 8 }) : undefined
  const ms = performance.now() - t
  if (state)
    console.log(
      `phone life state (8 progress lines)    phone ${kb(phoneBytes('life', { state }))} · built in ${ms.toFixed(1)}ms (incl. first read)`,
    )
  store.close()
}
await rm(dir, { recursive: true, force: true })
