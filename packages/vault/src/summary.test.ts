import { describe, expect, it } from 'vitest'
import { type AgentItemSummary, toAgentSummaries, toAgentSummary } from './summary.js'
import type { VaultItem } from './types.js'

const items: VaultItem[] = [
  {
    id: 'vlt_login',
    kind: 'login',
    site: 'naver.com',
    username: 'hong',
    label: 'naver',
    secret: { password: 'super-secret-pw', totpSecret: 'JBSWY3DPEHPK3PXP' },
  },
  {
    id: 'vlt_card',
    kind: 'card',
    label: 'personal card',
    secret: { number: '4111111111111111', expiry: '12/29', cvc: '123', holder: 'HONG GILDONG' },
  },
  { id: 'vlt_id', kind: 'identity', label: 'rrn', secret: { value: '900101-1234567' } },
  { id: 'vlt_totp', kind: 'totp', label: 'authenticator', secret: { totpSecret: 'JBSWY3DPEHPK3PXP' } },
  { id: 'vlt_pin', kind: 'payment-pin', label: 'pay pin', secret: { pin: '482913' } },
]

const SECRET_KEYS = ['secret', 'password', 'number', 'cvc', 'pin', 'value', 'totpSecret', 'expiry', 'holder']
const SECRET_VALUES = [
  'super-secret-pw',
  'JBSWY3DPEHPK3PXP',
  '4111111111111111',
  '123',
  '900101-1234567',
  '482913',
]

describe('toAgentSummary — secrets never reach the AI', () => {
  it('exposes only id/kind/site/username/hasTotp/label', () => {
    for (const item of items) {
      const summary = toAgentSummary(item)
      const allowed = new Set(['id', 'kind', 'site', 'username', 'hasTotp', 'label'])
      for (const key of Object.keys(summary)) expect(allowed.has(key)).toBe(true)
    }
  })

  it('never carries a secret key or secret value', () => {
    for (const item of items) {
      const summary = toAgentSummary(item)
      for (const key of SECRET_KEYS) expect(key in summary).toBe(false)
      const serialized = JSON.stringify(summary)
      for (const value of SECRET_VALUES) expect(serialized).not.toContain(value)
    }
  })

  it('reports hasTotp without revealing the seed', () => {
    const map = new Map(toAgentSummaries(items).map((s) => [s.id, s]))
    expect(map.get('vlt_login')?.hasTotp).toBe(true)
    expect(map.get('vlt_totp')?.hasTotp).toBe(true)
    expect(map.get('vlt_card')?.hasTotp).toBe(false)
    expect(map.get('vlt_pin')?.hasTotp).toBe(false)
  })

  it('a login without a TOTP seed reports hasTotp false', () => {
    const summary = toAgentSummary({
      id: 'vlt_x',
      kind: 'login',
      site: 'example.com',
      secret: { password: 'p' },
    })
    expect(summary.hasTotp).toBe(false)
  })

  it('is assignable to AgentItemSummary with no excess', () => {
    const [first] = items
    const summary: AgentItemSummary = toAgentSummary(first as VaultItem)
    expect(summary.id).toBe('vlt_login')
    expect(summary.kind).toBe('login')
  })
})
