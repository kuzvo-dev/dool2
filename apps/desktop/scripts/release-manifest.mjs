// Builds the release version info (version.json) and signs it with our key (ADR 0028, .github/workflows/release.yml).
//
//   DOOL2_UPDATE_KEY="$(cat update-key.pem)" node apps/desktop/scripts/release-manifest.mjs \
//     --dir out --version 0.3.0 --notes "What changed" [--min 0.2.0] [--base https://github.com/kuzvo-dev/dool2/releases/download/v0.3.0]
//
// Finds dool2-<version>-mac-arm64.zip, -mac-x64.zip and -win-x64.exe in the folder and records checksum (sha256) and size.
// The app checks it against the same public key with openRelease in apps/desktop/src/update.ts (payload = Release JSON in base64)
import { createHash, sign } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    version: { type: 'string' },
    notes: { type: 'string', default: '' },
    min: { type: 'string' },
    base: { type: 'string' },
    out: { type: 'string' },
  },
})
const dir = values.dir
const version = values.version
const key = process.env.DOOL2_UPDATE_KEY
if (!dir || !version || !key) {
  console.error('--dir, --version and DOOL2_UPDATE_KEY are required')
  process.exit(1)
}
const base = values.base ?? `https://github.com/kuzvo-dev/dool2/releases/download/v${version}`
const KINDS = [
  ['darwin-arm64', `dool2-${version}-mac-arm64.zip`],
  ['darwin-x64', `dool2-${version}-mac-x64.zip`],
  ['win32-x64', `dool2-${version}-win-x64.exe`],
]
const have = new Set(readdirSync(dir))
const files = {}
for (const [platform, name] of KINDS) {
  if (!have.has(name)) continue
  const p = join(dir, name)
  files[platform] = {
    url: `${base}/${encodeURIComponent(name)}`,
    sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
    size: statSync(p).size,
  }
}
if (!Object.keys(files).length) {
  console.error(`No dool2-${version}-… update files in ${dir}`)
  process.exit(1)
}
const release = {
  version,
  ...(values.min ? { min: values.min } : {}),
  ...(values.notes ? { notes: values.notes } : {}),
  date: new Date().toISOString(),
  files,
}
const data = Buffer.from(JSON.stringify(release), 'utf8')
const signed = { payload: data.toString('base64'), signature: sign(null, data, key).toString('base64') }
const out = values.out ?? join(dir, 'version.json')
writeFileSync(out, `${JSON.stringify(signed, null, 2)}\n`)
console.log(`Wrote version info: ${out} (${Object.keys(files).join(', ')})`)
