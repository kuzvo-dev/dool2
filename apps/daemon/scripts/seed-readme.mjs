#!/usr/bin/env node
// Fills a data folder with the demo data used for the README screenshots. No real AI is called and there is no
// personal data: a fictional user ("Minji"), fictional orders and places. The text lives in fixtures/readme-<lang>.json.
// Usage: node apps/daemon/scripts/seed-readme.mjs <data folder> <ko|en>
//   DOOL2_SMOKE=1 DOOL2_DATA_DIR=<data folder> DOOL2_SMOKE_OPEN=feed ./node_modules/.bin/electron . (from apps/desktop)
//
// Times in the fixture are relative to now, so the screens always read "today":
//   "@on:<days>,<hour>,<minute>"  that time of day, <days> from today (0 today, -2 the day before yesterday)
//   "@ago:<minutes>"               that many minutes before now
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '@dool2/store'

const [dir, lang] = process.argv.slice(2)
if (!dir || (lang !== 'ko' && lang !== 'en')) {
  console.error('Usage: node seed-readme.mjs <data folder> <ko|en>')
  process.exit(1)
}
const here = dirname(fileURLToPath(import.meta.url))
const data = JSON.parse(readFileSync(join(here, 'fixtures', `readme-${lang}.json`), 'utf8'))

/** "@on:" and "@ago:" strings become ISO times; everything else is kept */
function when(v) {
  if (typeof v !== 'string') return v
  const on = /^@on:(-?\d+),(\d+),(\d+)$/.exec(v)
  if (on) {
    const d = new Date()
    d.setDate(d.getDate() + Number(on[1]))
    d.setHours(Number(on[2]), Number(on[3]), 0, 0)
    return d.toISOString()
  }
  const ago = /^@ago:(\d+)$/.exec(v)
  if (ago) return new Date(Date.now() - Number(ago[1]) * 60_000).toISOString()
  return v
}
const times = (v) =>
  Array.isArray(v)
    ? v.map(times)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, times(x)]))
      : when(v)

// Start from an empty folder so a rerun gives the same screens
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

// The store stamps messages with this clock: each entry takes its "at", or 20 seconds after the previous one
let t = Date.now()
const store = new Store(join(dir, 'dool2.db'), { now: () => new Date(t) })

const conv = data.conversation
t = Date.parse(when(conv[0]?.at ?? '@ago:60'))
const thread = store.createThread('claude', conv[0]?.text ?? 'Hello')
for (const m of conv) {
  t = m.at ? Date.parse(when(m.at)) : t + 20_000
  store.addMessage(thread.id, m.role, m.role === 'tool' ? JSON.stringify(m.record) : m.text)
}

// Side conversations (listed under the tabs), dated yesterday so the main conversation stays the current one
t = Date.parse(when('@on:-1,21,0'))
for (const side of data.sideThreads ?? []) {
  const th = store.createThread('claude', side.title, undefined, true)
  for (const m of side.messages) {
    t += 20_000
    store.addMessage(th.id, m.role, m.text)
  }
}

for (const key of ['routines', 'library', 'memory', 'know', 'feed', 'connections']) {
  if (data[key]) store.setSetting(key, times(data[key]))
}
store.setSetting('identity', data.identity)
store.setSetting('ideas', data.ideas)
store.setSetting('feedPrompt', data.feedPrompt)
// Keep the daily ideas search and the proactive check from running during capture (they would call a real AI).
// The proactive check runs again at the next full hour, so capture right after seeding
store.setSetting('ideasAt', new Date().toISOString())
store.setSetting('watchAt', new Date().toISOString())

// Leave the first-run wizard finished, without the usage-stats card
store.setSetting('setupDone', true)
store.setSetting('aiChoice', 'claude')
store.setSetting('defaultAgent', 'claude')
store.setSetting('usageStats', false)
store.setSetting('language', lang)
store.close()
console.log(`README demo data (${lang}) created: ${dir}`)
