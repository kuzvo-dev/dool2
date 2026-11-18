import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// 화면 파일은 빌드 때 옆에 복사되는 protocol 파일(./connect-text.js 등)을 불러온다. 시험에서는 원본을 쓴다
const protocol = (f: string) => fileURLToPath(new URL(`../../packages/protocol/src/${f}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [{ find: /^\.\/connect-text\.js$/, replacement: protocol('connect-text.ts') }],
  },
})
