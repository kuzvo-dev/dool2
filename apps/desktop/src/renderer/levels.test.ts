import { describe, expect, it } from 'vitest'
import { LEVELS, toLevel } from './levels.js'
import { appText } from './locales/app.js'

describe('autonomy level selector', () => {
  it('offers exactly the three ADR 0047 levels, least to most autonomous', () => {
    expect(LEVELS).toEqual(['ask', 'auto', 'full'])
  })

  it('labels each level in Korean', () => {
    const ko = appText('ko').levels
    expect(ko.ask).toBe('허락받기')
    expect(ko.auto).toBe('자동')
    expect(ko.full).toBe('완전 자동')
    // Every selectable level has a label.
    for (const level of LEVELS) expect(ko[level]).toBeTruthy()
  })

  it('maps a selector value straight to the agentd level', () => {
    expect(toLevel('ask')).toBe('ask')
    expect(toLevel('auto')).toBe('auto')
    expect(toLevel('full')).toBe('full')
  })

  it('falls back to the safest level for an unknown value', () => {
    expect(toLevel('nonsense')).toBe('ask')
    expect(toLevel('')).toBe('ask')
  })
})
