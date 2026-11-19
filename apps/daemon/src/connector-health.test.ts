import { describe, expect, it } from 'vitest'
import { ConnectorHealth, REST_MS } from './connector-health.js'

describe('서비스 도구 건강 기록 (ADR 0020)', () => {
  it('잇달아 3번 깨지면 6시간 쉬고, 지나면 다시 해 본다', () => {
    let now = 1_000_000
    const h = new ConnectorHealth(undefined, () => now)
    h.record('a_search', 'broke', '2단계(wait)')
    h.record('a_search', 'empty')
    expect(h.resting('a_search')).toBeUndefined()
    h.record('a_search', 'broke', '3단계(extract): 목록 0줄')
    expect(h.resting('a_search')?.reason).toBe('3단계(extract): 목록 0줄')
    now += REST_MS + 1
    expect(h.resting('a_search')).toBeUndefined()
    // 한 번 되면 바로 돌아온다
    h.record('a_search', 'ok')
    expect(h.summary().a_search).toMatchObject({ last: 'ok', resting: false, failures24h: 3 })
  })

  it('도구 정의가 바뀌면(고친 도구) 예전 고장으로 쉬지 않는다', () => {
    const h = new ConnectorHealth(undefined, () => 5)
    for (let i = 0; i < 3; i++) h.record('c_gifts', 'broke', '4단계(capture)', 'old')
    expect(h.resting('c_gifts', 'old')).toBeDefined()
    expect(h.resting('c_gifts', 'new')).toBeUndefined()
    // 지문 없이 묻거나(점검 화면) 예전 기록에 지문이 없으면 그대로 센다
    expect(h.resting('c_gifts')).toBeDefined()
  })

  it('정상 멈춤(마감·로그인 필요)은 고장으로 세지 않는다', () => {
    const h = new ConnectorHealth(undefined, () => 5)
    for (let i = 0; i < 5; i++) h.record('b_track', 'stopped')
    expect(h.resting('b_track')).toBeUndefined()
  })
})
