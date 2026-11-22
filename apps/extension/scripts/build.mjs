// 두리 확장 빌드 → dist/ (이 폴더를 Chrome에 올리거나 웹 스토어용으로 압축한다)
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { copyUi } from '../../../packages/ui/copy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 빌드 지문: 소스·버전이 바뀌면 달라진다. 확장이 돌고 있는 코드의 지문과 디스크에 깔린 build.json을 견줘
// 다르면 스스로 다시 켠다 (버전 번호가 같으면 Chrome이 새로 깐 파일을 읽지 않고 예전 코드를 계속 돌린다 — 11-22 탭 72개 쌓임)
const hash = createHash('sha256').update(pkg.version)
const walk = (d) => {
  for (const f of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(d, f.name)
    if (f.isDirectory()) walk(p)
    else hash.update(f.name).update(readFileSync(p))
  }
}
walk(join(root, 'src'))
walk(join(root, 'static'))
const buildId = hash.digest('hex').slice(0, 12)

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
await build({
  entryPoints: { background: join(root, 'src/background.ts'), popup: join(root, 'src/popup.ts') },
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome121',
  // 스토어 심사와 사용자가 읽을 수 있게 줄이지 않는다
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  define: { __DOOL2_BUILD__: JSON.stringify(buildId) },
})
cpSync(join(root, 'static'), dist, { recursive: true })
// 디자인 시스템과 Pretendard 글꼴 (작은 창도 PC 앱과 같은 글꼴로)
copyUi(dist, { fonts: true })
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
manifest.version = pkg.version
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(join(dist, 'build.json'), `${JSON.stringify({ build: buildId })}\n`)
