import { describe, expect, it } from 'vitest'
import { KeepAwake, loginItemSettings, shouldKeepAwake } from './power.js'

describe('늘 깨어 있기', () => {
  it('"일하는 동안"이면 일할 때만 잠들지 않게 한다', () => {
    expect(shouldKeepAwake({ keepAwake: 'working' }, true)).toBe(true)
    expect(shouldKeepAwake({ keepAwake: 'working' }, false)).toBe(false)
    expect(shouldKeepAwake({ keepAwake: 'always' }, false)).toBe(true)
    expect(shouldKeepAwake({ keepAwake: 'off' }, true)).toBe(false)
    // 아직 묻지 않았으면 바꾸지 않는다
    expect(shouldKeepAwake({}, true)).toBe(false)
  })

  it('필요할 때만 켜고, 끝나면 바로 풀어서 평소 절전을 방해하지 않는다', () => {
    const log: string[] = []
    let n = 0
    const k = new KeepAwake({
      start: () => {
        log.push('start')
        return ++n
      },
      stop: (id) => log.push(`stop ${id}`),
    })
    k.update({ keepAwake: 'working' }, true)
    k.update({ keepAwake: 'working' }, true)
    expect(k.active).toBe(true)
    k.update({ keepAwake: 'working' }, false)
    k.update({ keepAwake: 'always' }, false)
    k.update({ keepAwake: 'off' }, false)
    expect(log).toEqual(['start', 'stop 1', 'start', 'stop 2'])
    expect(k.active).toBe(false)
  })

  it('자동 시작은 창 없이 켠다', () => {
    expect(loginItemSettings({ launchAtLogin: true })).toEqual({
      openAtLogin: true,
      openAsHidden: true,
      args: ['--hidden'],
    })
    expect(loginItemSettings({}).openAtLogin).toBe(false)
  })
})
