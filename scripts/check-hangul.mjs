#!/usr/bin/env node
// Keeps new Korean out of code (ADR 0029). User-facing copy goes in locale files, and code and comments are English.
//
//   node scripts/check-hangul.mjs           check
//   node scripts/check-hangul.mjs --update  write the current counts as the new baseline (after removing Korean)
//
// Files in the baseline still have Korean from before ADR 0029. Changes there only warn, so work in progress is
// not blocked while those files are migrated. Every other file (new files, and files already cleaned to zero)
// fails on any Hangul.
//
// Korean is allowed where it is data: locale files, region/kr modules, service cards, evals, tests and fixtures,
// docs (reviewed by people; Korean originals live in docs/ko/) and the Korean README.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const BASELINE = 'scripts/hangul-baseline.json'
const CODE = /\.(c|m)?(t|j)sx?$|\.(html|css|swift|java|kt|sh|ya?ml|json|webmanifest)$/
const ALLOWED = [
  /(^|\/)locales\//,
  /(^|\/)region\/kr\//,
  /^packages\/skills\/skills\//,
  /^docs\//,
  /(^|\/)fixtures\//,
  /\.test\.(c|m)?(t|j)sx?$/,
  /^packages\/i18n\/src\//,
  /^scripts\/hangul-baseline\.json$/,
  /^\.github\/ISSUE_TEMPLATE\//,
]
const HANGUL = /[\u3131-\u318E\uAC00-\uD7A3]/

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter((f) => f && CODE.test(f) && !ALLOWED.some((re) => re.test(f)))

const counts = {}
for (const f of files) {
  let text
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    continue // deleted in the working tree
  }
  const n = text.split('\n').filter((l) => HANGUL.test(l)).length
  if (n) counts[f] = n
}

const total = Object.values(counts).reduce((a, b) => a + b, 0)

if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`)
  console.log(`hangul baseline: ${Object.keys(counts).length} files, ${total} lines`)
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
const fresh = Object.entries(counts).filter(([f]) => !(f in baseline))
const grew = Object.entries(counts).filter(([f, n]) => f in baseline && n > baseline[f])
const shrank = Object.entries(baseline).filter(([f, n]) => (counts[f] ?? 0) < n)

for (const [f, n] of grew)
  console.warn(
    `warning: ${f} has more Korean (${baseline[f]} → ${n} lines). Prefer English and locale files.`,
  )
if (fresh.length) {
  console.error(
    'Korean in code that must stay English (ADR 0029). Move user-facing copy to a locale file and write code and comments in English:',
  )
  for (const [f, n] of fresh) console.error(`  ${f}: ${n} lines with Hangul`)
  console.error(
    'If this is Korean data (a Korean site text the code matches, for example), put it under region/kr/ or a locale file.',
  )
  process.exit(1)
}
const was = Object.values(baseline).reduce((a, b) => a + b, 0)
if (shrank.length)
  console.log(
    `hangul: ${was} → ${total} lines. Run \`node scripts/check-hangul.mjs --update\` to lock it in.`,
  )
else console.log(`hangul: ${total} lines left in ${Object.keys(counts).length} files`)
