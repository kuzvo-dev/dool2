import { describe, expect, it } from 'vitest'
import { type CoverageSkill, coverageStats, skillHasDataPath, toCoverageSkill } from './coverage.js'
import { draftSkill } from './draft.js'
import type { SessionRecording } from './recording.js'

describe('coverageStats', () => {
  it('counts covered visited sites and the click-free ratio', () => {
    const skills: CoverageSkill[] = [
      { site: ['coupang.com'], hasDataPath: true },
      { site: ['naver.com'], hasDataPath: true },
      { site: ['gov.kr'], hasDataPath: false },
    ]
    const visited = [
      'order.coupang.com', // covered by coupang.com
      'www.naver.com', // covered by naver.com
      'nts.go.kr', // not covered
      'order.coupang.com', // duplicate — counted once
    ]
    const stats = coverageStats(skills, visited)
    expect(stats.total).toBe(3) // coupang, naver, nts distinct
    expect(stats.covered).toBe(2)
    // 2 of 3 skills have a data path.
    expect(stats.clickFreeRatio).toBeCloseTo(2 / 3)
  })

  it('is zero-safe with no skills', () => {
    expect(coverageStats([], ['x.com'])).toEqual({ covered: 0, total: 1, clickFreeRatio: 0 })
  })

  it('derives the data-path flag from a drafted skill', () => {
    const withApi: SessionRecording = {
      url: 'https://a.com/x',
      host: 'a.com',
      apiCalls: [{ method: 'GET', url: 'https://a.com/api/x' }],
    }
    const uiOnly: SessionRecording = {
      url: 'https://b.com/x',
      host: 'b.com',
      uiSteps: [{ action: 'click', label: 'go' }],
    }
    const a = draftSkill(withApi)
    const b = draftSkill(uiOnly)
    expect(skillHasDataPath(a)).toBe(true)
    expect(skillHasDataPath(b)).toBe(false)

    const stats = coverageStats([toCoverageSkill(a), toCoverageSkill(b)], ['a.com', 'b.com'])
    expect(stats.covered).toBe(2)
    expect(stats.clickFreeRatio).toBeCloseTo(1 / 2)
  })
})
