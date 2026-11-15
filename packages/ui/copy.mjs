// 앱 빌드가 부르는 도우미: ui.css와 두리 캐릭터(doori/), 글꼴을 앱의 dist 폴더로 복사한다.
// 앱 화면은 묶지 않고 파일을 그대로 불러오므로, 같은 폴더에 ui.css·doori/·fonts/가 있어야 한다.
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
  // 서비스 로고 (연결 카드 id.png). 없는 카드는 화면이 이름 첫 글자를 보여 준다
  cpSync(join(here, 'logos'), join(to, 'logos'), { recursive: true, filter: (f) => !f.endsWith('.md') })
  if (opts.fonts) {
    cpSync(join(here, 'fonts.css'), join(to, 'fonts.css'))
    cpSync(join(here, 'fonts'), join(to, 'fonts'), { recursive: true })
  }
}

/**
 * 3D 두리(doori3d.js + three)를 화면이 따로 불러올 파일 하나로 묶는다. 앱의 esbuild를 넘겨받는다.
 * 화면은 import('./doori3d.js')로 필요할 때만 불러오고, 실패하면 정지 그림을 그대로 둔다.
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
