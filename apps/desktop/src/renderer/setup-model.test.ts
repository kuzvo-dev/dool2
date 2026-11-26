import type { AgentStatus } from '@dool2/protocol'
import { describe, expect, it } from 'vitest'
import {
  checkHeadline,
  checklist,
  costLabel,
  neededAgents,
  noSubscriptionFound,
  pickDefault,
  planLabel,
  updateLine,
} from './setup-model.js'

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
      // Its sign-in shows from the start, without a button until the install is done
      ['claude-login', false, undefined],
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
      'claude-login',
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
    expect(checkHeadline('both', [claudeMissing, codexOut]).title).toBe('세 가지만 해 주세요')
  })

  it("'잘 모르겠어요'인데 구독이 없으면 API 키 길을 알린다", () => {
    expect(noSubscriptionFound('unsure', [claudeMissing, codexOut])).toBe(true)
    expect(checkHeadline('unsure', [claudeMissing, codexOut]).title).toBe('Claude·ChatGPT 구독이 안 보여요')
    // A signed-in subscription, or a different choice, keeps the usual headline
    expect(noSubscriptionFound('unsure', [claudeReady, codexOut])).toBe(false)
    expect(noSubscriptionFound('both', [claudeMissing, codexOut])).toBe(false)
    expect(checkHeadline('both', [claudeMissing, codexOut]).title).toBe('세 가지만 해 주세요')
  })

  it('Chrome이 없으면 설치 버튼을 보여 주지만, 대화 시작은 막지 않는다', () => {
    const items = checklist('claude', [claudeReady], { installed: false })
    expect(items.at(-1)).toMatchObject({ id: 'chrome', ok: false, action: 'chrome-install' })
    expect(checkHeadline('claude', [claudeReady], { installed: false }).title).toBe('바로 시작할 수 있어요')
    expect(checkHeadline('claude', [claudeReady], { installed: true }).title).toBe('준비가 다 됐어요')
  })

  it('Chrome이 있으면 두리 확장 연결을 확인한다', () => {
    const off = checklist('claude', [claudeReady], { installed: true }, { connected: false })
    expect(off.at(-1)).toMatchObject({ id: 'extension', ok: false, action: 'extension-install' })
    const on = checklist('claude', [claudeReady], { installed: true }, { connected: true, version: '0.1.0' })
    expect(on.at(-1)).toMatchObject({ id: 'extension', ok: true })
    // Chrome이 없으면 확장은 아직 묻지 않는다
    expect(
      checklist('claude', [claudeReady], { installed: false }, { connected: false }).map((i) => i.id),
    ).not.toContain('extension')
  })

  it('구독 없이 쓰기를 고르면 종량제 실행기와 API 키를 확인한다', () => {
    const items = checklist('payg', [{ id: 'opencode', installed: false, loggedIn: false }])
    expect(items.map((i) => [i.id, i.ok, i.action])).toEqual([
      ['opencode-app', false, 'opencode-install'],
      ['payg-key', false, 'payg-key'],
    ])
    expect(pickDefault('payg', [{ id: 'opencode', installed: true, loggedIn: true }])).toBe('opencode')
    // A saved key keeps its button: change or remove it in Settings → AI
    const ready = checklist('payg', [
      { id: 'opencode', installed: true, loggedIn: true, plan: 'openai · gpt' },
    ])
    expect(ready.map((i) => [i.id, i.ok, i.action])).toEqual([
      ['opencode-app', true, undefined],
      ['payg-key', true, 'payg-key'],
    ])
  })

  it('비용을 달러와 원화 어림값으로 보여 준다', () => {
    expect(costLabel(0.0034)).toBe('$0.0034 · 약 5원')
    expect(costLabel(0.0003)).toBe('$0.0003 · 1원 미만')
    expect(costLabel(1.2)).toBe('$1.20 · 약 1,740원')
  })
})

describe('설정의 두리 버전 한 줄', () => {
  const now = Date.parse('2026-11-23T05:00:00Z')
  it('최신·새 버전·받는 중·실패·개발용', () => {
    expect(updateLine({ status: 'none', current: '0.3.1', checkedAt: now - 5 * 60_000 }, now)).toBe(
      '최신 버전이에요 · 5분 전 확인',
    )
    expect(updateLine({ status: 'none', current: '0.3.1', checkedAt: now - 3 * 3_600_000 }, now)).toBe(
      '최신 버전이에요 · 3시간 전 확인',
    )
    expect(updateLine({ status: 'available', current: '0.3.1', latest: '0.3.2' }, now)).toBe(
      '새 버전이 나왔어요 (0.3.2)',
    )
    expect(updateLine({ status: 'downloading', current: '0.3.1', progress: 0.42 }, now)).toBe(
      '새 버전 받는 중 42%',
    )
    expect(
      updateLine({ status: 'error', current: '0.3.1', error: '버전 안내를 받지 못했어요 (503)' }, now),
    ).toBe('확인하지 못했어요: 버전 안내를 받지 못했어요 (503)')
    expect(updateLine(null, now)).toBe('개발용으로 켠 앱이라 새 버전을 확인하지 않아요')
  })
})

describe('plan names', () => {
  it('reads like the product people bought', () => {
    expect(planLabel('max')).toBe('Max')
    expect(planLabel('chatgpt')).toBe('ChatGPT')
  })
})

describe('API key in Settings', () => {
  const paygReady: AgentStatus = { id: 'opencode', installed: true, loggedIn: true, plan: 'openrouter' }
  it('stays changeable when another subscription was chosen', () => {
    const items = checklist('codex', [codexReady, paygReady], undefined, undefined, { withKey: true })
    expect(items.find((i) => i.id === 'payg-key')).toMatchObject({ ok: true, action: 'payg-key' })
    // The wizard keeps to the chosen subscription
    expect(checklist('codex', [codexReady, paygReady]).some((i) => i.id === 'payg-key')).toBe(false)
  })
})

describe('how many things are left', () => {
  it('counts the sign-in that follows an install', () => {
    const codexMissing: AgentStatus = { id: 'codex', installed: false, loggedIn: false }
    // Install + sign-in, then the sign-in alone (it was "one thing" and then a new row appeared)
    expect(checkHeadline('codex', [codexMissing]).title).toBe('두 가지만 해 주세요')
    expect(checkHeadline('codex', [codexOut]).title).toBe('한 가지만 해 주세요')
  })
})
