// 두리 확장 빌드 → dist/ (이 폴더를 Chrome에 올리거나 웹 스토어용으로 압축한다)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { copyUi } from '../../../packages/ui/copy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

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
})
cpSync(join(root, 'static'), dist, { recursive: true })
// 디자인 시스템과 Pretendard 글꼴 (작은 창도 PC 앱과 같은 글꼴로)
copyUi(dist, { fonts: true })
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
manifest.version = pkg.version
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
