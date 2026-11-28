import type { RunHandle, ToolCall, TurnEvent, TurnInput } from '@dool2/core'
import type { Brain } from './brain.js'

/** A stand-in brain for tests and local wiring: says a line, calls one tool, waits for its result, then ends. */
export function mockBrain(toolCall?: ToolCall): Brain {
  return {
    id: 'pi',
    label: 'Mock',
    async ready() {
      return true
    },
    async *run(_input: TurnInput, _handle: RunHandle): AsyncIterable<TurnEvent> {
      yield { kind: 'text', text: '알겠어요.' }
      if (toolCall) {
        yield { kind: 'tool_call', call: toolCall }
        yield { kind: 'turn_end', stop: 'tool' }
        return
      }
      yield { kind: 'turn_end', stop: 'done' }
    },
  }
}
