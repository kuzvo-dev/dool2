import { describe, expect, it } from 'vitest'
import { staleBuild } from './fresh.js'

describe('새 코드로 다시 켜기', () => {
  it('지문이 다를 때만 다시 켠다', () => {
    expect(staleBuild('aaa', 'bbb')).toBe(true)
    expect(staleBuild('aaa', 'aaa')).toBe(false)
    expect(staleBuild('aaa', undefined)).toBe(false)
    expect(staleBuild('dev', 'bbb')).toBe(false)
  })
})
