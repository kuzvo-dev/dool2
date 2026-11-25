import { describe, expect, it } from 'vitest'
import { LoginRequests } from './logins.js'

describe('sign-in cards', () => {
  it('a stopped task closes only its own waiting sign-in cards', () => {
    const logins = new LoginRequests(() => 0)
    const mine = logins.create({ tabId: 1, origin: 'https://a.example', site: 'A' })
    const other = logins.create({ tabId: 2, origin: 'https://b.example', site: 'B' })
    const saved = logins.create({ tabId: 3, origin: 'https://c.example', site: 'C' })
    logins.finish(saved.id, 'saved')
    const owner = new Map([
      [mine.id, 'task-thread'],
      [other.id, 'other-thread'],
      [saved.id, 'task-thread'],
    ])
    expect(logins.cancelWhere((id) => owner.get(id) === 'task-thread')).toEqual([mine.id])
    expect(logins.get(mine.id)?.status).toBe('cancelled')
    expect(logins.get(other.id)?.status).toBe('pending')
    expect(logins.get(saved.id)?.status).toBe('saved')
  })
})
