import { cpSync, mkdirSync } from 'node:fs'
import { build } from 'esbuild'
import { bundleDoori3d, copyUi } from '../../../packages/ui/copy.mjs'

mkdirSync('dist/renderer', { recursive: true })
for (const f of ['index.html', 'style.css']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`)

// 답 그리기(작은 마크다운)와 일정 문구는 @dool2/protocol의 것을 그대로 쓴다. 화면은 묶지 않고 불러오므로 파일을 옆에 둔다
cpSync('../../packages/protocol/dist/rich.js', 'dist/renderer/rich.js')
cpSync('../../packages/protocol/dist/schedule.js', 'dist/renderer/schedule.js')
cpSync('../../packages/protocol/dist/ideas.js', 'dist/renderer/ideas.js')

// 디자인 시스템(ui.css)과 Pretendard 글꼴
copyUi('dist/renderer', { fonts: true })

// 큰 자리의 움직이는 두리 (three 포함). 화면이 필요할 때만 불러온다
await bundleDoori3d(build, 'dist/renderer/doori3d.js')
