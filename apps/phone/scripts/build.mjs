// Builds the Dool2 phone app into dist/ (the relay serves it at /app/)
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
// Design system. No fonts are bundled (the phone uses the device font)
copyUi(dist)
// The animated Dool2 for big spots: loaded only when a screen needs it
await bundleDoori3d(build, join(dist, 'doori3d.js'))
