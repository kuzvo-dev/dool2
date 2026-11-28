// The offline demo brain. A real brain (Claude Code / Codex / the pi fork, @dool2/brains) is injected later; until
// then the app runs against this scripted brain so it works with no model and no network — the same spine the
// agentd CLI's `say` uses. It drives the code hand over the fake bridges: open a page, read it, sign in with the
// vault, then answer. The Korean copy is demo/test data (a made-up gift-card balance) and lives in locales/demo.ts.

import type { Brain } from '@dool2/brains'
import type { TurnEvent } from '@dool2/core'
import { scriptedBrain } from '@dool2/engine'
import { DEMO_LINES, DEMO_MESSAGE } from './locales/demo.js'

export { DEMO_MESSAGE }

/**
 * A three-round scripted turn. Each round is one brain `run()`: say something, call the `code` hand, end with `tool`
 * so the engine runs the code and feeds the result back; the final round answers and ends with `done`.
 */
export function demoBrain(): Brain {
  const rounds: TurnEvent[][] = [
    [
      { kind: 'text', text: DEMO_LINES.start },
      {
        kind: 'tool_call',
        call: {
          id: 'c1',
          name: 'code',
          args: {
            code: "(async () => { await page.goto('https://www.starbucks.co.kr'); return JSON.stringify(await page.snapshot()) })()",
          },
        },
      },
      { kind: 'turn_end', stop: 'tool' },
    ],
    [
      { kind: 'text', text: DEMO_LINES.login },
      {
        kind: 'tool_call',
        call: {
          id: 'c2',
          name: 'code',
          args: { code: "await vault.fillLogin('v1'); JSON.stringify(await page.snapshot())" },
        },
      },
      { kind: 'turn_end', stop: 'tool' },
    ],
    [
      { kind: 'text', text: DEMO_LINES.answer },
      { kind: 'turn_end', stop: 'done' },
    ],
  ]
  return scriptedBrain(rounds)
}
