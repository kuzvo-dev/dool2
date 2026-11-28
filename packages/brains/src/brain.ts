// A brain is one AI runner (Claude Code, Codex, or the pi fork). Each is a thin adapter that converts its own
// stream into the shared TurnEvent shape (see @dool2/core). The daemon owns the tools, the skills, and the
// autonomy gate; a brain only turns a TurnInput into a stream of events and accepts tool results back.

import type { RunHandle, TurnEvent, TurnInput } from '@dool2/core'

export type BrainId = 'claude' | 'codex' | 'pi'

export interface Brain {
  readonly id: BrainId
  /** Human label, e.g. "Claude Code". */
  readonly label: string
  /** Whether this brain is installed and signed in right now. */
  ready(): Promise<boolean>
  /**
   * Run one turn. Returns an async iterable of events; the handle lets the daemon feed tool results and steer.
   * The adapter never sees secrets and never decides what may act — that is the gate's job.
   */
  run(input: TurnInput, handle: RunHandle): AsyncIterable<TurnEvent>
}
