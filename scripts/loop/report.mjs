#!/usr/bin/env node
// One HTML page from loop runs (scripts/loop/run.mjs): a before/after table per scenario and the share answered in
// one visible reply. Later files win for the same question, so pass the first run first and re-asks after it.
//
//   node scripts/loop/report.mjs <out.html> <run1.json> [run2.json …] [--title "…"] [--notes notes.md]
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { title: { type: 'string' }, notes: { type: 'string' } },
})
const [out, ...runs] = positionals
if (!out || !runs.length) {
  console.error(
    'usage: node scripts/loop/report.mjs <out.html> <run1.json> [run2.json …] [--title t] [--notes f.md]',
  )
  process.exit(1)
}
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const first = new Map()
const last = new Map()
for (const f of runs)
  for (const r of JSON.parse(readFileSync(f, 'utf8'))) {
    if (!first.has(r.q)) first.set(r.q, r)
    last.set(r.q, r)
  }
const qs = [...first.keys()]
const once = (m) => qs.filter((q) => (m.get(q)?.visible ?? m.get(q)?.answers) === 1).length
const rows = qs
  .map((q, i) => {
    const a = first.get(q)
    const b = last.get(q)
    const cls = (v) => (v > 1 ? 'bad' : 'ok')
    return `<tr><td>${i + 1}</td><td>${esc(q)}</td><td>${a.secs}s</td><td class="${cls(a.visible)}">${a.visible}</td><td>${b === a ? '' : `${b.secs}s`}</td><td class="${b === a ? '' : cls(b.visible)}">${b === a ? '' : b.visible}</td><td class="t">${esc(b.tools.join(' '))}</td><td class="t">${esc(b.full.replace(/\n/g, ' ').slice(0, 180))}</td></tr>`
  })
  .join('\n')
const notes = values.notes ? `<h2>Notes</h2><pre>${esc(readFileSync(values.notes, 'utf8'))}</pre>` : ''
const title = values.title ?? 'Dool2 self-improve loop'
writeFileSync(
  out,
  `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#fafaf7;color:#222}
.k{display:inline-block;background:#fff;border:1px solid #e5e5e0;border-radius:12px;padding:10px 14px;margin:0 8px 8px 0}
.k b{display:block;font-size:22px}table{border-collapse:collapse;width:100%;font-size:13px;background:#fff}
td,th{border-bottom:1px solid #eee;padding:6px;text-align:left;vertical-align:top}th{background:#f3f3ee}
.bad{color:#c0392b;font-weight:700}.ok{color:#1e8449;font-weight:700}.t{color:#666;font-size:12px}pre{white-space:pre-wrap}</style>
<h1>${esc(title)}</h1>
<div class="k"><b>${once(first)}/${qs.length}</b>one reply, first ask</div><div class="k"><b>${once(last)}/${qs.length}</b>one reply, latest</div>
${notes}
<table><tr><th>#</th><th>Request</th><th>First</th><th>Replies</th><th>Latest</th><th>Replies</th><th>Tools</th><th>Answer</th></tr>
${rows}</table></html>`,
)
console.log(`${out}: ${qs.length} scenarios, ${once(last)} in one reply`)
