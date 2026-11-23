import { describe, expect, it } from 'vitest'
import { LoopGuard, loopNote } from './loop-guard.js'

const text = (t: string, isError = false) => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: 'text', text: t }],
})

describe('LoopGuard', () => {
  it('adds the note from the third identical call with the same result', () => {
    const g = new LoopGuard()
    const r = text('Sold out')
    expect(g.check('browser/click', { ref: 'e12' }, r).count).toBeUndefined()
    expect(g.check('browser/click', { ref: 'e12' }, r).count).toBeUndefined()
    const third = g.check('browser/click', { ref: 'e12' }, r)
    expect(third.count).toBe(3)
    expect(third.result.content).toHaveLength(2)
    expect(third.result.content[1]?.text).toBe(loopNote(3))
    expect(g.check('browser/click', { ref: 'e12' }, r).count).toBe(4)
    // the original result is not changed
    expect(r.content).toHaveLength(1)
  })

  it('does not count a call whose result changed (the page moved on)', () => {
    const g = new LoopGuard()
    for (const page of ['page 1', 'page 2', 'page 3', 'page 4'])
      expect(g.check('browser/snapshot', { tabId: 1 }, text(page)).count).toBeUndefined()
  })

  it('treats the same input in another key order as the same call, other inputs or tools as different', () => {
    const g = new LoopGuard()
    const r = text('No results')
    g.check('service/call', { tool: 'a_search', input: { q: 'x', n: 2 } }, r)
    g.check('service/call', { input: { n: 2, q: 'x' }, tool: 'a_search' }, r)
    expect(g.check('service/call', { tool: 'a_search', input: { q: 'y', n: 2 } }, r).count).toBeUndefined()
    expect(g.check('service/find', { tool: 'a_search', input: { q: 'x', n: 2 } }, r).count).toBeUndefined()
    expect(g.check('service/call', { tool: 'a_search', input: { q: 'x', n: 2 } }, r).count).toBe(3)
  })

  it('an error and a normal answer with the same text are different results', () => {
    const g = new LoopGuard()
    g.check('t', {}, text('x'))
    g.check('t', {}, text('x', true))
    expect(g.check('t', {}, text('x')).count).toBeUndefined()
  })

  it('forgets calls outside the window', () => {
    let now = 0
    const g = new LoopGuard({ windowMs: 1000, now: () => now })
    g.check('t', {}, text('x'))
    now = 500
    g.check('t', {}, text('x'))
    now = 1600
    expect(g.check('t', {}, text('x')).count).toBeUndefined()
  })

  it('leaves waiting tools and results without text alone', () => {
    const g = new LoopGuard({ repeat: 1 })
    expect(g.check('browser/wait_auth', {}, text('Still waiting')).count).toBeUndefined()
    expect(g.check('screen/screenshot', {}, { content: [{ type: 'image' }] }).count).toBeUndefined()
    expect(g.check('x', {}, { ok: true }).count).toBeUndefined()
  })

  it('says which call it is in plain English', () => {
    expect(loopNote(3)).toContain('the 3rd call')
    expect(loopNote(11)).toContain('the 11th call')
    expect(loopNote(22)).toContain('the 22nd call')
  })
})
