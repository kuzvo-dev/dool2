import { describe, expect, it, vi } from 'vitest'
import { fillPaymentPin, paymentPinAvailable, type SecureKeypad } from './payment.js'
import type { CardItem, PaymentPinItem } from './types.js'

const pinItem: PaymentPinItem = { id: 'vlt_pin', kind: 'payment-pin', secret: { pin: '482913' } }
const card: CardItem = {
  id: 'vlt_card',
  kind: 'card',
  secret: { number: '4111111111111111', expiry: '12/29', cvc: '123' },
}

describe('paymentPinAvailable — full-auto only (ADR 0047)', () => {
  it('is true only at level full for a payment-pin item', () => {
    expect(paymentPinAvailable(pinItem, 'full')).toBe(true)
    expect(paymentPinAvailable(pinItem, 'auto')).toBe(false)
    expect(paymentPinAvailable(pinItem, 'ask')).toBe(false)
  })

  it('is false for a non payment-pin item at any level', () => {
    expect(paymentPinAvailable(card, 'full')).toBe(false)
  })
})

describe('fillPaymentPin — types into the secure keypad, never returns the PIN', () => {
  it('types the PIN into the keypad at level full', async () => {
    const keypad: SecureKeypad = { typePin: vi.fn(async () => {}) }
    const result = await fillPaymentPin(pinItem, keypad, 'full')
    expect(result).toBeUndefined()
    expect(keypad.typePin).toHaveBeenCalledWith('482913')
  })

  it('refuses below full-auto and never touches the keypad', async () => {
    const keypad: SecureKeypad = { typePin: vi.fn(async () => {}) }
    await expect(fillPaymentPin(pinItem, keypad, 'auto')).rejects.toThrow(/full-auto/u)
    expect(keypad.typePin).not.toHaveBeenCalled()
  })
})
