// Bundle the renderer (browser code) and copy its static files next to it. The window loads one ES module without a
// Node resolver, so esbuild bundles src/renderer/renderer.ts (and its local imports: lines/levels/locales) into
// dist/renderer/renderer.js. The @dool2/* imports in the renderer are type-only, so nothing from the daemon is pulled
// into the browser bundle — the renderer talks to the daemon only through the preload bridge (window.dool2).
//
// The look is the shared design system (@dool2/ui): ui.css + fonts + the Dool2 character. copyUi() drops ui.css, the
// doori character set, fonts and logos next to index.html so the window (which loads files as-is, not bundled) finds
// them. The app's own style.css adds only the 3-column layout on top of ui.css's tokens and parts.

import { cpSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const { copyUi } = await import(require.resolve('@dool2/ui/copy.mjs'))

mkdirSync('dist/renderer', { recursive: true })
for (const f of ['index.html', 'style.css']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`)
// ui.css, the doori character (webp set + mark.svg), fonts (Pretendard) and the service logos.
copyUi('dist/renderer', { fonts: true })

await build({
  entryPoints: ['src/renderer/renderer.ts'],
  outfile: 'dist/renderer/renderer.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
})
