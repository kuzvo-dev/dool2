// Builds a connector pack from skills/ and signs it (ADR 0039, .github/workflows/packs.yml).
//
//   DOOL2_PACK_KEY="$(cat pack-key.pem)" node scripts/pack-build.mjs --out out/packs --min 0.4.6 [--channel beta]
//
// Writes connectors-<pack>.json.gz (every skills/<id>/connect.json and tools.json, _template left out) and the signed
// feed pack.json (or pack-beta.json for --channel beta). The pack number is the Unix seconds of the last skills/ commit,
// the same number apps/desktop/scripts/package.mjs records for the skills/ an app carries, so an app takes a pack only
// when it is newer than what it came with. The app checks the feed in apps/daemon/src/packs.ts (openPack)
import { execFileSync } from 'node:child_process'
import { createHash, sign } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'out/packs' },
    min: { type: 'string' },
    channel: { type: 'string', default: 'stable' },
    base: { type: 'string', default: 'https://github.com/kuzvo-dev/dool2/releases/download/connectors' },
    pack: { type: 'string' },
  },
})
const key = process.env.DOOL2_PACK_KEY
if (!key || !values.min) {
  console.error('--min (oldest app version that reads this pack) and DOOL2_PACK_KEY are required')
  process.exit(1)
}
if (!['stable', 'beta'].includes(values.channel)) {
  console.error('--channel is stable or beta')
  process.exit(1)
}
const root = join(import.meta.dirname, '..')
const skills = join(root, 'skills')
const pack = Number(
  values.pack ??
    execFileSync('git', ['log', '-1', '--format=%ct', '--', 'skills'], { cwd: root, encoding: 'utf8' }),
)
if (!Number.isInteger(pack) || pack <= 0) {
  console.error('Could not tell the pack number (git history of skills/)')
  process.exit(1)
}

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
const files = {}
for (const id of readdirSync(skills).sort()) {
  if (!NAME.test(id)) continue
  for (const f of ['connect.json', 'tools.json']) {
    const p = join(skills, id, f)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    JSON.parse(text) // a broken file stops the build here (the repo tests check the formats)
    files[`${id}/${f}`] = text
  }
}
const services = new Set(Object.keys(files).map((p) => p.split('/')[0])).size
const gz = gzipSync(Buffer.from(JSON.stringify({ pack, files }), 'utf8'), { level: 9 })
const name = `connectors-${pack}.json.gz`
mkdirSync(values.out, { recursive: true })
writeFileSync(join(values.out, name), gz)

const manifest = {
  pack,
  minApp: values.min,
  date: new Date().toISOString(),
  url: `${values.base}/${name}`,
  sha256: createHash('sha256').update(gz).digest('hex'),
  size: gz.length,
}
const data = Buffer.from(JSON.stringify(manifest), 'utf8')
const signed = { payload: data.toString('base64'), signature: sign(null, data, key).toString('base64') }
const feed = values.channel === 'beta' ? 'pack-beta.json' : 'pack.json'
writeFileSync(join(values.out, feed), `${JSON.stringify(signed, null, 2)}\n`)
console.log(
  `pack ${pack}: ${services} services, ${Object.keys(files).length} files, ${gz.length} bytes → ${feed}`,
)
