import { describe, expect, it } from 'vitest'
import { notRecorded, TAPE_MAX_MS, ToolTape } from './tool-tape.js'

const text = (t: string) => ({ content: [{ type: 'text', text: t }] })

describe('ToolTape', () => {
  it('records calls with the approvals they created, and returns them when stopped', () => {
    const t = new ToolTape()
    t.record({ tool: 'x', input: {}, result: text('ignored') }) // off: nothing kept
    t.start('record')
    t.record({ tool: 'service/call', input: { tool: 'a_search' }, result: text('3 results'), approvals: [] })
    t.record({
      tool: 'browser/checkout',
      input: { tabId: 1 },
      result: text('Payment card sent'),
      approvals: [{ label: 'Coupang', what: 'Water', amount: '₩12,000', kind: 'money' }],
    })
    const r = t.stop()
    expect(r.mode).toBe('record')
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0]).not.toHaveProperty('approvals')
    expect(r.entries[1]?.approvals?.[0]?.amount).toBe('₩12,000')
    expect(t.current).toBe('off')
  })

  it('replays the exact call first, in recorded order, then reuses answers', () => {
    const t = new ToolTape()
    t.start('replay', [
      { tool: 'browser/snapshot', input: { tabId: 1 }, result: text('page 1') },
      { tool: 'browser/snapshot', input: { tabId: 1 }, result: text('page 2') },
    ])
    expect(t.replay('browser/snapshot', { tabId: 1 })).toEqual(text('page 1'))
    expect(t.replay('browser/snapshot', { tabId: 1 })).toEqual(text('page 2'))
    expect(t.replay('browser/snapshot', { tabId: 1 })).toEqual(text('page 1'))
    expect(t.stop().replayed.map((x) => x.match)).toEqual(['exact', 'exact', 'exact'])
  })

  it('matches loosely only when search words differ', () => {
    const t = new ToolTape()
    t.start('replay', [
      {
        tool: 'service/call',
        input: { tool: 'a_search', input: { query: 'water 2L', n: 2 } },
        result: text('ok'),
      },
      { tool: 'browser/click', input: { tabId: 1, ref: 'e12' }, result: text('clicked') },
    ])
    expect(t.replay('service/call', { input: { n: 2, query: 'water 2 liters' }, tool: 'a_search' })).toEqual(
      text('ok'),
    )
    // another tool, other non-search values, a different ref: not on the tape
    expect(t.replay('service/call', { tool: 'b_search', input: { query: 'water', n: 2 } })).toEqual(
      notRecorded('service/call'),
    )
    expect(t.replay('service/call', { tool: 'a_search', input: { query: 'water', n: 3 } })).toHaveProperty(
      'isError',
      true,
    )
    expect(t.replay('browser/click', { tabId: 1, ref: 'e13' })).toHaveProperty('isError', true)
    const r = t.stop()
    expect(r.replayed).toEqual([
      {
        tool: 'service/call',
        input: { input: { n: 2, query: 'water 2 liters' }, tool: 'a_search' },
        match: 'loose',
      },
    ])
    expect(r.missed.map((m) => m.tool)).toEqual(['service/call', 'service/call', 'browser/click'])
  })

  it('carries the recorded approvals of replayed calls', () => {
    const t = new ToolTape()
    const approvals = [{ label: 'KakaoTalk', what: 'Send to Mom', kind: 'contact' as const }]
    t.start('replay', [
      { tool: 'screen/request_approval', input: { what: 'x' }, result: text('card'), approvals },
    ])
    t.replay('screen/request_approval', { what: 'x' })
    expect(t.stop().replayed[0]?.approvals).toEqual(approvals)
  })

  it('ignores malformed tape entries', () => {
    const t = new ToolTape()
    t.start('replay', [null, { input: {} }, { tool: 'x', input: {}, result: text('ok') }] as never)
    expect(t.replay('x', {})).toEqual(text('ok'))
  })

  it('turns itself off when left on too long', () => {
    let now = 0
    const t = new ToolTape(() => now)
    t.start('replay', [{ tool: 'x', input: {}, result: text('ok') }])
    now = TAPE_MAX_MS - 1
    expect(t.current).toBe('replay')
    now = TAPE_MAX_MS + 1
    expect(t.current).toBe('off')
  })
})
