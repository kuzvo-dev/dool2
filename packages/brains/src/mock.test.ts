import type { RunHandle, TurnEvent } from '@dool2/core'
import { describe, expect, it } from 'vitest'
import { mockBrain } from './mock.js'

const noop: RunHandle = { toolResult() {}, steer() {}, abort() {} }
async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('mockBrain', () => {
  it('ends cleanly with no tool', async () => {
    const b = mockBrain()
    expect(await b.ready()).toBe(true)
    const ev = await collect(b.run({ system: 's', messages: [] }, noop))
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'done' })
  })

  it('emits a tool call then stops for the tool', async () => {
    const b = mockBrain({ id: 't1', name: 'code', args: { expr: '1+1' } })
    const ev = await collect(b.run({ system: 's', messages: [] }, noop))
    expect(ev.some((e) => e.kind === 'tool_call')).toBe(true)
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'tool' })
  })
})
