// 웹 스토어 제출용 zip: dist/를 묶되 manifest의 개발용 `key`는 뺀다.
// 웹 스토어는 처음 올릴 때 id를 새로 정해 준다. 그 id를 @dool2/protocol의 STORE_EXTENSION_ID에 채운다.
//   pnpm --filter @dool2/extension build && node apps/extension/scripts/pack.mjs [나갈 폴더]
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
