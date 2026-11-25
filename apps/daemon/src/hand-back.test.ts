import { describe, expect, it } from 'vitest'
import { handBack, WAIT_MARK, waits } from './hand-back.js'

describe('results that end the turn', () => {
  it('say what was done, what is left, who acts next and that the turn waits', () => {
    const t = handBack({
      done: 'a login card is on the phone.',
      left: 'enter the ID and password',
      who: 'person',
      after: 'you are told in the next message',
      tell: 'to enter the ID and password on the card',
    })
    expect(t.startsWith(`${WAIT_MARK} the person.`)).toBe(true)
    expect(t).toContain('Done: a login card is on the phone.')
    expect(t).toContain('Left: enter the ID and password (the person).')
    expect(t).toContain('Then: you are told in the next message.')
    expect(t).toContain('This turn ends now: tell the user to enter the ID and password on the card')
    expect(waits(t)).toBe(true)
    expect(waits('Pressed the button.')).toBe(false)
    expect(handBack({ done: 'x', left: 'y', who: 'dool2', after: 'z', tell: 'w' })).toContain(
      'Left: y (Dool2, by itself).',
    )
  })
})
