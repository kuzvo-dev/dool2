// 두리 폰 앱 빌드 → dist/ (중계 서버가 /app/으로 내려준다)
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

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
