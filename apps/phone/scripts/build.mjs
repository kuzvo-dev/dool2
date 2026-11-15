// 두리 폰 앱 빌드 → dist/ (중계 서버가 /app/으로 내려준다)
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { bundleDoori3d, copyUi } from '../../../packages/ui/copy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
await build({
  entryPoints: { app: join(root, 'src/main.ts'), sw: join(root, 'src/sw.ts') },
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: ['safari17', 'chrome120'],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
})
cpSync(join(root, 'static'), dist, { recursive: true })
// 디자인 시스템. 글꼴은 넣지 않는다 (폰은 기기 글꼴)
copyUi(dist)
// 큰 자리의 움직이는 두리: 화면이 필요할 때만 불러온다
await bundleDoori3d(build, join(dist, 'doori3d.js'))
