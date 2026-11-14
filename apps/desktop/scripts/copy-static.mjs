import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist/renderer', { recursive: true })
for (const f of ['index.html', 'style.css']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`)

// 답 그리기(작은 마크다운)는 @dool2/protocol의 것을 그대로 쓴다. 화면은 묶지 않고 불러오므로 파일을 옆에 둔다
cpSync('../../packages/protocol/dist/rich.js', 'dist/renderer/rich.js')
