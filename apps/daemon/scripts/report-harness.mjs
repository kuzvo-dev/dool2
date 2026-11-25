#!/usr/bin/env node
// Harness numbers in one place, against the targets of the harness plan: prompt template and tool list sizes per kind
// of session (from the built code), and from the work log on this PC: fixed input per kind, cache share by gap,
// result characters per tool, turns / tool calls / approvals per task, ack and first-word times, finish check
// send-backs and their kinds, segment handoffs made but never used. Aggregate numbers only, so the output can be shared.
//
//   pnpm report:harness [--days N] [--json] [--baseline <earlier --json output>] [<data folder>]
//
// Needs `pnpm build` first (it reads the built packages). Older log lines lack later fields; those show as n/a.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')

function args(argv) {
  const o = { days: 7, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--days') o.days = Math.max(1, Number(argv[++i]) || 7)
    else if (a === '--json') o.json = true
    else if (a === '--baseline') o.baseline = argv[++i]
    else o.dir = a
  }
  return o
}

/** Prompt template size per kind: per-kind builders when the engine has them, else the one template */
async function promptSizes() {
  const engine = await import('@dool2/engine')
  const fns = Object.entries(engine).filter(([k, v]) => typeof v === 'function' && /^build\w*Prompt$/.test(k))
  const size = (fn, kind) => {
    try {
      const out = fn({ lang: 'ko', kind, session: kind })
      return typeof out === 'string' ? out.length : undefined
    } catch {
      return undefined
    }
  }
  const of = (re) => fns.find(([k]) => re.test(k))?.[1]
  const conv = of(/conversation/i)
  const task = of(/task/i)
  if (conv && task) return { conversation: size(conv, 'conversation'), task: size(task, 'task') }
  if (typeof engine.buildSystemPrompt !== 'function') return undefined
  const c = size(engine.buildSystemPrompt, 'conversation')
  const t = size(engine.buildSystemPrompt, 'task')
  return { conversation: c, task: t, ...(c === t ? { shared: true } : {}) }
}

/** Visible tool list per kind, counted like the budget tests (JSON of the listed tools) */
async function toolSizes() {
  const tools = await import('@dool2/mcp-tools')
  const req = createRequire(join(root, 'packages', 'mcp-tools', 'package.json'))
  const { Client } = await import(req.resolve('@modelcontextprotocol/sdk/client/index.js'))
  const { InMemoryTransport } = await import(req.resolve('@modelcontextprotocol/sdk/inMemory.js'))
  const out = {}
  for (const kind of ['conversation', 'task', 'all']) {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const server = tools.createServer(kind === 'all' ? {} : { session: kind })
    await server.connect(serverT)
    const client = new Client({ name: 'report', version: '0' })
    await client.connect(clientT)
    const { tools: list } = await client.listTools()
    out[kind] = { count: list.length, bytes: JSON.stringify(list).length }
    await client.close()
  }
  return out
}

/** Tool results in the source that tell the AI to end its answer, and how many also say what is left and what is next */
export function scanEndAnswer(files) {
  const END = /\b(end|finish|stop) (your|the|this) (answer|reply|turn)\b/i
  let total = 0
  let explained = 0
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (/^\s*(\/\/|\*)/.test(line) || !END.test(line)) continue
      total++
      if (/\b(left|remaining)\b/i.test(line) && /\bnext\b/i.test(line)) explained++
    }
  }
  return { total, explained }
}

function sourceFiles() {
  const dirs = ['apps/daemon/src', 'packages/mcp-tools/src', 'packages/engine/src'].map((d) => join(root, d))
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
    }
  }
  for (const d of dirs) walk(d)
  return out
}

function readLog(dir, days) {
  const logs = join(dir, 'logs')
  let files = []
  try {
    files = readdirSync(logs).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
  } catch {
    return undefined
  }
  const from = new Date(Date.now() - (days - 1) * 86_400_000)
  const fromDay = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`
  const entries = []
  for (const f of files.sort()) {
    if (f.slice(0, 10) < fromDay) continue
    for (const line of readFileSync(join(logs, f), 'utf8').split('\n')) {
      if (!line) continue
      try {
        entries.push(JSON.parse(line))
      } catch {}
    }
  }
  return entries
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv.slice(2))
  let report
  let paths
  try {
    report = await import('../dist/harness-report.js')
    paths = await import('../dist/paths.js')
  } catch {
    console.error('Build first: pnpm build')
    process.exit(1)
  }
  const dir = o.dir ?? paths.defaultDataDir()
  const entries = readLog(dir, o.days)
  if (!entries) console.error(`No work log in ${join(dir, 'logs')}: only the code numbers are shown.`)
  const stat = {}
  stat.prompt = await promptSizes().catch(() => undefined)
  stat.tools = await toolSizes().catch(() => undefined)
  stat.endAnswer = scanEndAnswer(sourceFiles())
  const numbers = report.aggregateHarness(entries ?? [])
  let baseline
  if (o.baseline)
    try {
      baseline = JSON.parse(readFileSync(o.baseline, 'utf8')).numbers
    } catch {
      console.error(`Could not read the baseline ${o.baseline}`)
    }
  if (o.json) console.log(JSON.stringify({ days: o.days, static: stat, numbers }, null, 2))
  else console.log(report.renderHarness(numbers, stat, { days: o.days, ...(baseline ? { baseline } : {}) }))
  // The tool servers keep timers (service list polling)
  process.exit(0)
}
