import { describe, expect, it } from 'vitest'
import { appNote, handoffOpen, handoffRecord } from './rich.js'

describe('hand-off cards', () => {
  it('only a handoff record with a reason is drawn as one', () => {
    expect(handoffRecord({ kind: 'handoff', tabId: 3, reason: ' Solve the robot check ' })).toEqual({
      kind: 'handoff',
      tabId: 3,
      reason: 'Solve the robot check',
    })
    expect(handoffRecord({ kind: 'handoff', reason: 'Sign in' })).toEqual({
      kind: 'handoff',
      reason: 'Sign in',
    })
    // A record kind the screen does not know yet (an older phone and the task card, 11-25) is not a hand-off
    expect(handoffRecord({ kind: 'task', id: 't1', title: 'Mail summary' })).toBeUndefined()
    expect(handoffRecord({ kind: 'something-new' })).toBeUndefined()
    // A hand-off without its reason is never an empty card
    expect(handoffRecord({ kind: 'handoff', tabId: 3 })).toBeUndefined()
    expect(handoffRecord({ kind: 'handoff', reason: '   ' })).toBeUndefined()
    expect(handoffRecord(undefined)).toBeUndefined()
    expect(handoffRecord('handoff')).toBeUndefined()
  })

  it('closes once the conversation moved on or the task ended', () => {
    const list = [
      { role: 'user' },
      { role: 'assistant' },
      { role: 'tool' }, // the hand-off
    ]
    expect(handoffOpen(list, 2)).toBe(true)
    // Dool2's own reply after it keeps it open
    expect(handoffOpen([...list, { role: 'assistant' }], 2)).toBe(true)
    // The person said something, or the app said it for them ("the screen changed")
    expect(handoffOpen([...list, { role: 'user' }], 2)).toBe(false)
    expect(handoffOpen([...list, { role: 'user', text: appNote('The screen changed') }], 2)).toBe(false)
    // Its task ended
    expect(handoffOpen(list, 2, { ended: true })).toBe(false)
  })
})
