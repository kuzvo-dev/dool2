// Helper called by app builds: copies ui.css, the Dool2 character (doori/) and fonts into the app's dist folder.
// App screens load files as is (not bundled), so ui.css, doori/ and fonts/ must sit in the same folder.
//   import { copyUi } from '../../../packages/ui/copy.mjs'
//   copyUi('dist/renderer', { fonts: true })
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** @param {string} to @param {{ fonts?: boolean }} [opts] */
export function copyUi(to, opts = {}) {
  mkdirSync(to, { recursive: true })
  cpSync(join(here, 'ui.css'), join(to, 'ui.css'))
  cpSync(join(here, 'doori'), join(to, 'doori'), { recursive: true })
  // 3D emoji (Fluent Emoji 3D, MIT, emoji/LICENSE)
  cpSync(join(here, 'emoji'), join(to, 'emoji'), { recursive: true })
  // Service logos (connect card id.png). Cards without one show the first letter of the name
  cpSync(join(here, 'logos'), join(to, 'logos'), { recursive: true, filter: (f) => !f.endsWith('.md') })
  if (opts.fonts) {
    cpSync(join(here, 'fonts.css'), join(to, 'fonts.css'))
    cpSync(join(here, 'fonts'), join(to, 'fonts'), { recursive: true })
  }
}

/**
 * Bundles the 3D Dool2 (doori3d.js + three) into one file that screens load separately. Takes the app's esbuild.
 * Screens load it with import('./doori3d.js') only when needed, and keep the still image if that fails.
 * @param {typeof import('esbuild').build} build @param {string} outfile
 */
export function bundleDoori3d(build, outfile) {
  return build({
    entryPoints: [join(here, 'doori3d.js')],
    outfile,
    bundle: true,
    format: 'esm',
    target: ['safari17', 'chrome120'],
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  })
}
