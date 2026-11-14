// 앱 빌드가 부르는 도우미: ui.css와 글꼴을 앱의 dist 폴더로 복사한다.
// 앱 화면은 묶지 않고 파일을 그대로 불러오므로, 같은 폴더에 ui.css·fonts/가 있어야 한다.
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
  if (opts.fonts) {
    cpSync(join(here, 'fonts.css'), join(to, 'fonts.css'))
    cpSync(join(here, 'fonts'), join(to, 'fonts'), { recursive: true })
  }
}
