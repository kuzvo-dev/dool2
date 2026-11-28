import { describe, expect, it } from 'vitest'
import { decide, isAutonomous } from './autonomy.js'

describe('autonomy gate (ADR 0047)', () => {
  it('read is never gated at any level', () => {
    for (const lvl of ['ask', 'auto', 'full'] as const) expect(decide(lvl, 'read').decision).toBe('run')
  })

  it('ask: acts run, pay/contact/delete need a phone signature', () => {
    expect(decide('ask', 'act').decision).toBe('run')
    expect(decide('ask', 'pay').decision).toBe('sign')
    expect(decide('ask', 'contact').decision).toBe('sign')
    expect(decide('ask', 'delete').decision).toBe('sign')
  })

  it('auto: payment always asks, contact/delete go through the reviewer, acts run', () => {
    expect(decide('auto', 'act').decision).toBe('run')
    expect(decide('auto', 'pay').decision).toBe('sign')
    expect(decide('auto', 'contact').decision).toBe('review')
    expect(decide('auto', 'delete').decision).toBe('review')
  })

  it('full: contact/delete run with a notice; pay depends on merchant and cap', () => {
    expect(decide('full', 'contact').decision).toBe('notify')
    expect(decide('full', 'delete').decision).toBe('notify')
    expect(decide('full', 'pay', { merchantKnown: true, underCap: true }).decision).toBe('notify')
    expect(decide('full', 'pay', { merchantKnown: false, underCap: true }).decision).toBe('sign')
    expect(decide('full', 'pay', { merchantKnown: true, underCap: false }).decision).toBe('block')
  })

  it('isAutonomous marks run and notify', () => {
    expect(isAutonomous('run')).toBe(true)
    expect(isAutonomous('notify')).toBe(true)
    expect(isAutonomous('sign')).toBe(false)
    expect(isAutonomous('review')).toBe(false)
    expect(isAutonomous('block')).toBe(false)
  })
})
