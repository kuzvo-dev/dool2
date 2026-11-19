import { cpSync, mkdirSync } from 'node:fs'
import { build } from 'esbuild'
import { bundleDoori3d, copyUi } from '../../../packages/ui/copy.mjs'

mkdirSync('dist/renderer', { recursive: true })
for (const f of ['index.html', 'style.css']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`)

// 답 그리기(작은 마크다운)와 일정 문구는 @dool2/protocol의 것을 그대로 쓴다. 화면은 묶지 않고 불러오므로 파일을 옆에 둔다
cpSync('../../packages/protocol/dist/rich.js', 'dist/renderer/rich.js')
// 결과 블록 (빠른 답·목록 줄·결과 한 장·보낼 글): 모양·그리기를 폰과 같이 쓴다
cpSync('../../packages/protocol/dist/blocks.js', 'dist/renderer/blocks.js')
cpSync('../../packages/protocol/dist/blocks-view.js', 'dist/renderer/blocks-view.js')
cpSync('../../packages/protocol/dist/work-steps.js', 'dist/renderer/work-steps.js')
cpSync('../../packages/protocol/dist/schedule.js', 'dist/renderer/schedule.js')
cpSync('../../packages/protocol/dist/ideas.js', 'dist/renderer/ideas.js')
cpSync('../../packages/protocol/dist/connect-text.js', 'dist/renderer/connect-text.js')

// 디자인 시스템(ui.css)과 Pretendard 글꼴
copyUi('dist/renderer', { fonts: true })

// 큰 자리의 움직이는 두리 (three 포함). 화면이 필요할 때만 불러온다
await bundleDoori3d(build, 'dist/renderer/doori3d.js')
