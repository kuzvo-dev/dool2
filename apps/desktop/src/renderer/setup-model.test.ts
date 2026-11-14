import type { AgentStatus } from '@dool2/protocol'
import { describe, expect, it } from 'vitest'
import { checkHeadline, checklist, costLabel, neededAgents, pickDefault } from './setup-model.js'

const claudeReady: AgentStatus = { id: 'claude', installed: true, loggedIn: true, plan: 'max' }
const claudeMissing: AgentStatus = { id: 'claude', installed: false, loggedIn: false }
const codexOut: AgentStatus = { id: 'codex', installed: true, loggedIn: false }
const codexReady: AgentStatus = { id: 'codex', installed: true, loggedIn: true }

describe('첫 실행 마법사', () => {
  it('고른 구독에 맞는 AI만 확인한다', () => {
    expect(neededAgents('claude')).toEqual(['claude'])
    expect(neededAgents('codex')).toEqual(['codex'])
    expect(neededAgents('both')).toEqual(['claude', 'codex'])
  })

  it('준비된 AI를 기본으로 고른다', () => {
    expect(pickDefault('both', [claudeMissing, codexReady])).toBe('codex')
    expect(pickDefault('claude', [claudeMissing, codexReady])).toBeUndefined()
    expect(pickDefault('unsure', [claudeReady, codexOut])).toBe('claude')
  })

  it('없으면 설치, 로그인이 안 됐으면 로그인 버튼을 보여 준다', () => {
    const items = checklist('both', [claudeMissing, codexOut])
    expect(items.map((i) => [i.id, i.ok, i.action])).toEqual([
      ['claude-app', false, 'claude-install'],
      ['codex-app', true, undefined],
      ['codex-login', false, 'codex-login'],
    ])
  })

  it('"잘 모르겠어요"는 이미 로그인된 AI만 보여 준다', () => {
    expect(checklist('unsure', [claudeReady, codexOut]).map((i) => i.id)).toEqual([
      'claude-app',
      'claude-login',
    ])
    expect(checklist('unsure', [claudeMissing, codexOut]).map((i) => i.id)).toEqual([
      'claude-app',
      'codex-app',
      'codex-login',
    ])
  })

  it('구독 종류를 사람 말로 보여 준다', () => {
    expect(checklist('claude', [claudeReady])[1]?.detail).toBe('Max 구독으로 연결됐어요')
  })

  it('상황에 맞는 제목을 고른다', () => {
    expect(checkHeadline('claude', [claudeReady]).title).toBe('준비가 다 됐어요')
    expect(checkHeadline('both', [claudeReady, codexOut]).title).toBe('바로 시작할 수 있어요')
    expect(checkHeadline('both', [claudeMissing, codexOut]).title).toBe('두 가지만 해 주세요')
  })

  it('Chrome이 없으면 설치 버튼을 보여 주지만, 대화 시작은 막지 않는다', () => {
    const items = checklist('claude', [claudeReady], { installed: false })
    expect(items.at(-1)).toMatchObject({ id: 'chrome', ok: false, action: 'chrome-install' })
    expect(checkHeadline('claude', [claudeReady], { installed: false }).title).toBe('바로 시작할 수 있어요')
    expect(checkHeadline('claude', [claudeReady], { installed: true }).title).toBe('준비가 다 됐어요')
  })

  it('구독 없이 쓰기를 고르면 종량제 실행기와 API 키를 확인한다', () => {
    const items = checklist('payg', [{ id: 'opencode', installed: false, loggedIn: false }])
    expect(items.map((i) => [i.id, i.ok, i.action])).toEqual([
      ['opencode-app', false, 'opencode-install'],
      ['payg-key', false, 'payg-key'],
    ])
    expect(pickDefault('payg', [{ id: 'opencode', installed: true, loggedIn: true }])).toBe('opencode')
  })

  it('비용을 달러와 원화 어림값으로 보여 준다', () => {
    expect(costLabel(0.0034)).toBe('$0.0034 · 약 5원')
    expect(costLabel(0.0003)).toBe('$0.0003 · 1원 미만')
    expect(costLabel(1.2)).toBe('$1.20 · 약 1,740원')
  })
})
