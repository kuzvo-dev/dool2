// A scripted brain for tests and daemon development, alongside @dool2/brains' mockBrain. The mock does one line and
// at most one tool call; a real turn loop needs several rounds (call a tool, read the result, call another, then
// finish). scriptedBrain plays a fixed list of rounds: each `run()` yields the next round's events, so the engine's
// multi-round loop can be exercised without a real model. No secrets, no I/O — just canned events.

import type { Brain } from '@dool2/brains'
import type { RunHandle, TurnEvent, TurnInput } from '@dool2/core'

/** Build a brain that plays `rounds` in order, one round per `run()` call. Extra calls yield a done turn. */
export function scriptedBrain(rounds: TurnEvent[][]): Brain {
  let next = 0
  return {
    id: 'pi',
    label: 'Scripted',
    async ready() {
      return true
    },
    async *run(_input: TurnInput, _handle: RunHandle): AsyncIterable<TurnEvent> {
      const round = rounds[next] ?? [{ kind: 'turn_end', stop: 'done' }]
      next++
      for (const event of round) yield event
    },
  }
}
