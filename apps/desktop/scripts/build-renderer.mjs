// Bundle the renderer (browser code) and copy its static files next to it. The window loads one ES module without a
// Node resolver, so esbuild bundles src/renderer/renderer.ts (and its local imports: lines/levels/locales) into
// dist/renderer/renderer.js. The @dool2/* imports in the renderer are type-only, so nothing from the daemon is pulled
// into the browser bundle — the renderer talks to the daemon only through the preload bridge (window.dool2).
import { cpSync, mkdirSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('dist/renderer', { recursive: true })
for (const f of ['index.html', 'style.css']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`)

await build({
  entryPoints: ['src/renderer/renderer.ts'],
  outfile: 'dist/renderer/renderer.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
})
