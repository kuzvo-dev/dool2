#!/usr/bin/env node
// Weekly view of the before-finishing check (ADR 0027): how often it sent work back and why, from the work log.
// Prints counts only (never the reasons' text), so the output can be shared.
//
//   node apps/daemon/scripts/finish-reasons.mjs [<data folder>]   (default: this PC's Dool2 data folder)
//
// If the same reason tops the list week after week, fix its cause (a tool result, a tool description) instead of
// letting the check catch it every time (AGENTS.md "Fix by sharpening tools").
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dataDir =
  process.argv[2] ??
  process.env.DOOL2_DATA_DIR ??
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'dool2')
    : process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'dool2')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'dool2'))

/** Monday of the week (YYYY-MM-DD) */
export function weekOf(iso) {
  const d = new Date(iso)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}

/** Aggregates finish-check entries per week: verdicts, send-back reasons (kind), who decided, judge time */
export function aggregate(entries) {
  const weeks = new Map()
  for (const e of entries) {
    if (e?.kind !== 'finish-check' || typeof e.at !== 'string') continue
    const k = weekOf(e.at)
    const w = weeks.get(k) ?? {
      week: k,
      judged: 0,
      done: 0,
      again: 0,
      stop: 0,
      simple: 0,
      code: 0,
      because: {},
      ms: [],
    }
    weeks.set(k, w)
    if (e.result === 'skip') {
      if (e.reason === 'simple') w.simple++
      continue
    }
    w.judged++
    if (e.result === 'done' || e.result === 'again' || e.result === 'stop') w[e.result]++
    if (e.result !== 'done') {
      const why = e.because ?? 'unlabeled'
      w.because[why] = (w.because[why] ?? 0) + 1
      if (e.source === 'code') w.code++
    }
    if (typeof e.ms === 'number' && e.source !== 'code') w.ms.push(e.ms)
  }
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week))
}

const median = (xs) => {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export function report(weeks) {
  const lines = []
  for (const w of weeks) {
    const back = w.again + w.stop
    const share = w.judged ? Math.round((back / w.judged) * 100) : 0
    const ms = median(w.ms)
    lines.push(
      `Week of ${w.week}: ${w.judged} judged · done ${w.done} · sent back ${w.again} · stopped ${w.stop} (${share}% not done)` +
        ` · not judged (simple) ${w.simple} · caught by code ${w.code}${ms !== undefined ? ` · judge median ${(ms / 1000).toFixed(1)} s` : ''}`,
    )
    const top = Object.entries(w.because).sort((a, b) => b[1] - a[1])
    for (const [kind, n] of top)
      lines.push(`  ${kind.padEnd(13)} ${String(n).padStart(4)}  ${Math.round((n / back) * 100)}%`)
  }
  return lines.join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = join(dataDir, 'logs')
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    console.error(`No work log in ${dir}`)
    process.exit(1)
  }
  const entries = []
  for (const f of files.sort())
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.includes('"finish-check"')) continue
      try {
        entries.push(JSON.parse(line))
      } catch {}
    }
  const weeks = aggregate(entries)
  console.log(weeks.length ? report(weeks) : 'No before-finishing checks in the work log.')
}
