// Zip for the web store: bundle dist/ but remove the development `key` from the manifest.
// The web store assigns a new id on first upload. Put that id in STORE_EXTENSION_ID of @dool2/protocol.
//   pnpm --filter @dool2/extension build && node apps/extension/scripts/pack.mjs [output folder]
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(process.argv[2] ?? join(root, 'out'))
const tmp = mkdtempSync(join(tmpdir(), 'dool2-pack-'))
cpSync(join(root, 'dist'), tmp, { recursive: true })
const manifest = JSON.parse(readFileSync(join(tmp, 'manifest.json'), 'utf8'))
delete manifest.key
writeFileSync(join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
mkdirSync(out, { recursive: true })
const zip = join(out, `dool2-extension-${manifest.version}.zip`)
rmSync(zip, { force: true })
execFileSync('zip', ['-qr', '-X', zip, '.'], { cwd: tmp })
rmSync(tmp, { recursive: true, force: true })
console.log(zip)
