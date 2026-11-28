// Bundle the phone app (browser code) and copy its static files next to it. The WebView loads one ES module without a
// Node resolver, so esbuild bundles src/renderer/renderer.ts (and its local imports) into dist/renderer/renderer.js.
//
// The look is the shared design system (@dool2/ui): copyUi() drops ui.css, the Dool2 character webp set, fonts
// (Pretendard) and logos next to index.html, so the phone reads as the same product as the desktop app.
//
// One browser caveat: the reachable code pulls in @dool2/phone's DaemonHttpClient (and @dool2/approvals canonicalize),
// which `import` a couple of names from `node:crypto`. The only one actually CALLED in the browser is randomUUID (a
// device id), which exists on globalThis.crypto; we alias `node:crypto` to a tiny shim that provides it. The phone
// hashes and signs with WebCrypto (lib/webcrypto.ts), never node:crypto.

import { cpSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const require = createRequire(import.meta.url)
const { copyUi } = await import(require.resolve('@dool2/ui/copy.mjs'))

mkdirSync(resolve(appRoot, 'dist/renderer'), { recursive: true })
for (const f of ['index.html', 'style.css']) {
  cpSync(resolve(appRoot, `src/renderer/${f}`), resolve(appRoot, `dist/renderer/${f}`))
}
// ui.css, the doori character (webp set + mark.svg), fonts (Pretendard) and the service logos.
copyUi(resolve(appRoot, 'dist/renderer'), { fonts: true })

await build({
  entryPoints: [resolve(appRoot, 'src/renderer/renderer.ts')],
  outfile: resolve(appRoot, 'dist/renderer/renderer.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  alias: { 'node:crypto': resolve(here, 'node-crypto-shim.mjs') },
})

console.log('phone renderer built -> dist/renderer')
