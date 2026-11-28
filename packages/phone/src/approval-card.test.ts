import { envelopeForAction, envelopeHash } from '@dool2/approvals'
import { describe, expect, it } from 'vitest'
import { type ApprovalNeeded, buildCard } from './approval-card.js'

function payload(action: Parameters<typeof envelopeForAction>[0], expiresAt?: number): ApprovalNeeded {
  const envelope = envelopeForAction(action)
  return { hash: envelopeHash(envelope), envelope, ...(expiresAt !== undefined ? { expiresAt } : {}) }
}

describe('buildCard: the human approval card (무엇을/어디서/얼마)', () => {
  it('shows the amount, merchant and label from the envelope (Korean, the default)', () => {
    const card = buildCard(
      payload(
        { tier: 'pay', label: 'Pay 50,000 won', amountKrw: 50_000, merchant: 'Coupang' },
        1_700_000_000,
      ),
    )
    expect(card.tier).toBe('pay')
    expect(card.title).toBe('결제 승인')
    expect(card.what).toBe('Pay 50,000 won')
    expect(card.where).toBe('Coupang')
    expect(card.amountKrw).toBe(50_000)
    expect(card.amountText).toBe('50,000원')
    expect(card.fieldLabels).toEqual({ what: '무엇을', where: '어디서', amount: '얼마' })
    expect(card.buttons).toEqual({ approve: '승인', deny: '거절' })
    expect(card.expiresAt).toBe(1_700_000_000)
  })

  it('carries the exact hash the daemon minted, so the signed value matches', () => {
    const p = payload({ tier: 'pay', label: 'Pay 9,900 won', amountKrw: 9_900, merchant: 'Baemin' })
    expect(buildCard(p).hash).toBe(p.hash)
  })

  it('uses recipient then site when there is no merchant', () => {
    expect(buildCard(payload({ tier: 'contact', label: 'Message Jisoo', recipient: 'Jisoo' })).where).toBe(
      'Jisoo',
    )
    expect(
      buildCard(payload({ tier: 'delete', label: 'Cancel order', site: 'shop.example.com' })).where,
    ).toBe('shop.example.com')
  })

  it('omits the amount for a non-pay action', () => {
    const card = buildCard(payload({ tier: 'contact', label: 'Message Jisoo', recipient: 'Jisoo' }))
    expect(card.amountKrw).toBeUndefined()
    expect(card.amountText).toBeUndefined()
  })

  it('renders English copy on request', () => {
    const p = payload({ tier: 'pay', label: 'Pay 50,000 won', amountKrw: 50_000, merchant: 'Coupang' })
    expect(buildCard(p).title).toBe('결제 승인') // default is Korean
    const enCard = buildCard(p, 'en')
    expect(enCard.title).toBe('Approve payment')
    expect(enCard.amountText).toBe('50,000 won')
    expect(enCard.fieldLabels).toEqual({ what: 'What', where: 'Where', amount: 'Amount' })
  })

  it('exposes no secret fields — only public action facts', () => {
    const card = buildCard(
      payload({ tier: 'pay', label: 'Pay 50,000 won', amountKrw: 50_000, merchant: 'Coupang' }),
    )
    const serialized = JSON.stringify(card).toLowerCase()
    for (const forbidden of ['password', 'pin', 'secret', 'cardnumber', 'cvc', 'cvv']) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})
