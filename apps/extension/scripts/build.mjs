// Build the Dool2 extension -> dist/ (load this folder in Chrome or zip it for the web store)
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { copyUi } from '../../../packages/ui/copy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Build fingerprint: it changes when the source or version changes. Compare the fingerprint of the running extension code with the build.json installed on disk,
// and if they differ, restart itself (with the same version number Chrome does not read newly installed files and keeps running old code - 11-22: 72 tabs piled up)
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
  // Not minified, so the store review and users can read it
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  define: { __DOOL2_BUILD__: JSON.stringify(buildId) },
})
cpSync(join(root, 'static'), dist, { recursive: true })
// Design system and the Pretendard font (so the small window uses the same font as the desktop app)
copyUi(dist, { fonts: true })
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
manifest.version = pkg.version
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(join(dist, 'build.json'), `${JSON.stringify({ build: buildId })}\n`)
