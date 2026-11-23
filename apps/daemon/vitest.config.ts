import { defineConfig } from 'vitest/config'

// Tests check the Korean reference copy. The default language depends on the region, which is guessed from the
// time zone: pin it to Korea so CI machines (UTC, English locale) behave like a Korean PC
export default defineConfig({
  test: { env: { TZ: 'Asia/Seoul' } },
})
