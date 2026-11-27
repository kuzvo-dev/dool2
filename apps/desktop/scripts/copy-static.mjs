import { cpSync, mkdirSync } from 'node:fs'
import { build } from 'esbuild'
import { bundleDoori3d, copyUi } from '../../../packages/ui/copy.mjs'

mkdirSync('dist/renderer', { recursive: true })
for (const f of ['index.html', 'style.css']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`)

// Answer rendering (small markdown) and schedule text come straight from @dool2/protocol. The window loads files
// without a bundler, so they are copied next to it
cpSync('../../packages/protocol/dist/rich.js', 'dist/renderer/rich.js')
// Result blocks (quick replies, list rows, result card, message drafts): same shapes and drawing as the phone
cpSync('../../packages/protocol/dist/blocks.js', 'dist/renderer/blocks.js')
cpSync('../../packages/protocol/dist/blocks-view.js', 'dist/renderer/blocks-view.js')
cpSync('../../packages/protocol/dist/work-steps.js', 'dist/renderer/work-steps.js')
cpSync('../../packages/protocol/dist/doori-draw.js', 'dist/renderer/doori-draw.js')
cpSync('../../packages/protocol/dist/schedule.js', 'dist/renderer/schedule.js')
cpSync('../../packages/protocol/dist/ideas.js', 'dist/renderer/ideas.js')
cpSync('../../packages/protocol/dist/connect-text.js', 'dist/renderer/connect-text.js')
// Language and messages (ADR 0029): one file with no imports
cpSync('../../packages/i18n/dist/index.js', 'dist/renderer/i18n.js')
// Paging long lists (Feed, Library, activity): same cursors and appending as the phone
cpSync('../../packages/protocol/dist/paging.js', 'dist/renderer/paging.js')

// Design system (ui.css) and the Pretendard font
copyUi('dist/renderer', { fonts: true })

// The big animated Dool2 (includes three). Loaded only when the screen needs it
await bundleDoori3d(build, 'dist/renderer/doori3d.js')
