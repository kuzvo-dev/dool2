// 릴리스 버전 안내(version.json)를 만들고 우리 서명키로 서명한다 (ADR 0028, .github/workflows/release.yml).
//
//   DOOL2_UPDATE_KEY="$(cat update-key.pem)" node apps/desktop/scripts/release-manifest.mjs \
//     --dir out --version 0.3.0 --notes "바뀐 점" [--min 0.2.0] [--base https://github.com/kuzvo-dev/dool2/releases/download/v0.3.0]
//
// 폴더의 dool2-<버전>-mac-arm64.zip · -mac-x64.zip · -win-x64.exe를 찾아 확인값(sha256)·크기를 적는다.
// 앱은 apps/desktop/src/update.ts의 openRelease로 같은 공개키를 맞춰 본다 (payload = Release JSON의 base64)
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
  console.error('--dir, --version과 DOOL2_UPDATE_KEY가 필요해요')
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
  console.error(`${dir}에 dool2-${version}-… 업데이트 파일이 없어요`)
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
console.log(`버전 안내를 만들었어요: ${out} (${Object.keys(files).join(', ')})`)
