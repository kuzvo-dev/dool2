import { describe, expect, it } from 'vitest'
import { canAgentUse, effectivePolicy } from './access.js'
import type { LoginItem } from './types.js'

const base: LoginItem = { id: 'vlt_1', kind: 'login', site: 'example.com', secret: { password: 'p' } }

describe('canAgentUse — the access gate', () => {
  it('never: blocked whether locked or unlocked', () => {
    const item = { ...base, accessPolicy: 'never' as const }
    expect(canAgentUse(item, 'always', { unlocked: true })).toBe(false)
    expect(canAgentUse(item, 'always', { unlocked: false })).toBe(false)
  })

  it('always: allowed whether locked or unlocked', () => {
    const item = { ...base, accessPolicy: 'always' as const }
    expect(canAgentUse(item, 'never', { unlocked: false })).toBe(true)
    expect(canAgentUse(item, 'never', { unlocked: true })).toBe(true)
  })

  it('while-unlocked: allowed only when unlocked', () => {
    const item = { ...base, accessPolicy: 'while-unlocked' as const }
    expect(canAgentUse(item, 'never', { unlocked: true })).toBe(true)
    expect(canAgentUse(item, 'never', { unlocked: false })).toBe(false)
  })

  it('falls back to the account default when the item sets no override', () => {
    expect(canAgentUse(base, 'never', { unlocked: true })).toBe(false)
    expect(canAgentUse(base, 'while-unlocked', { unlocked: true })).toBe(true)
    expect(canAgentUse(base, 'while-unlocked', { unlocked: false })).toBe(false)
  })

  it('the per-item override wins over the account default', () => {
    const item = { ...base, accessPolicy: 'never' as const }
    expect(effectivePolicy(item, 'always')).toBe('never')
    expect(canAgentUse(item, 'always', { unlocked: true })).toBe(false)
  })
})
