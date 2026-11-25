import { paygProviders } from '@dool2/agent-opencode'
import { describe, expect, it } from 'vitest'
import { aiAccountText } from './ai-account.js'

const providers = paygProviders('en')

describe('ai_account_view text', () => {
  it('shows company, model and only the last 4 of the key, and where the person changes it', () => {
    const text = aiAccountText(
      {
        defaultAgent: 'opencode',
        agents: [
          { id: 'opencode', installed: true, loggedIn: true, plan: 'anthropic · claude-sonnet-5-5' },
          { id: 'claude', installed: false, loggedIn: false },
        ],
        payg: { provider: 'anthropic', model: 'claude-sonnet-5-5', hasKey: true, keyHint: '4821' },
        providers,
      },
      'ko',
    )
    expect(text).toContain('Dool2 runs on: API key (pay-as-you-go)')
    expect(text).toContain('Anthropic (Claude), model Claude Sonnet 5.5')
    expect(text).toContain('API key saved (ends in 4821)')
    expect(text).toContain('- Claude Code: not installed')
    expect(text).toContain('"PC 앱 설정 > AI · 브라우저"')
    expect(text).toContain('"바꾸기"')
    expect(text).toContain('never ask for it')
  })

  it('says when pay-as-you-go is not set up, with the path in the user language', () => {
    const text = aiAccountText(
      {
        defaultAgent: 'claude',
        agents: [{ id: 'claude', installed: true, loggedIn: true, plan: 'max' }],
        payg: null,
        providers,
      },
      'en',
    )
    expect(text).toContain('- Claude Code: ready (max plan)')
    expect(text).toContain('Pay-as-you-go: not set up')
    expect(text).toContain('"PC app Settings > AI · Browser"')
  })
})
