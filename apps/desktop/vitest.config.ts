import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Window files load the protocol and i18n files copied next to them at build time (./connect-text.js, ../i18n.js).
// Tests use the sources instead
const protocol = (f: string) => fileURLToPath(new URL(`../../packages/protocol/src/${f}`, import.meta.url))
const i18n = fileURLToPath(new URL('../../packages/i18n/src/index.ts', import.meta.url))

export default defineConfig({
  test: { setupFiles: ['./test/setup.ts'] },
  resolve: {
    alias: [
      { find: /^\.\/connect-text\.js$/, replacement: protocol('connect-text.ts') },
      { find: /^\.\.?\/i18n\.js$/, replacement: i18n },
    ],
  },
})
