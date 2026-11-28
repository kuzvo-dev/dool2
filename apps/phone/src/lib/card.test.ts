// cardView projects a pending card to the flat data the bottom sheet lays out — the detail rows when present, and a
// sensible fallback (what / where / amount) for a bare daemon card that carries none.

import type { ActionEnvelope } from '@dool2/approvals'
import { describe, expect, it } from 'vitest'
import { cardView, type PendingCard } from './card.js'

const envelope: ActionEnvelope = {
  tier: 'pay',
  label: 'Train ticket',
  amountKrw: 59_800,
  merchant: 'Train booking',
  nonce: 'n-1',
  createdAt: 0,
}

describe('cardView', () => {
  it('keeps the display rows and source when the card carries them', () => {
    const card: PendingCard = {
      hash: 'h',
      envelope,
      source: 'Train booking',
      rows: [
        { key: 'Seat', value: 'Car 7, 12A' },
        { key: 'Card', value: 'Saved card ····4821' },
      ],
    }
    const view = cardView(card)
    expect(view.amountKrw).toBe(59_800)
    expect(view.source).toBe('Train booking')
    expect(view.rows).toHaveLength(2)
    // A secret never reaches the view: the card number is masked data the daemon already masked.
    expect(JSON.stringify(view)).not.toMatch(/\b\d{12,}\b/)
  })

  it('falls back to the envelope facts for a bare daemon card (no rows)', () => {
    const view = cardView({ hash: 'h', envelope })
    expect(view.where).toBe('Train booking')
    expect(view.label).toBe('Train ticket')
    expect(view.rows).toEqual([])
  })
})
