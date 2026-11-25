import type { AgentEvent } from '@dool2/protocol'
import { describe, expect, it } from 'vitest'
import type { AgentRuntime, TurnInput } from './runtime.js'
import { askSideJob } from './side-job.js'

const fake = (events: AgentEvent[], seen: TurnInput[] = []): AgentRuntime => ({
  id: 'codex',
  detect: async () => ({ id: 'codex', installed: true, loggedIn: true }),
  async *runTurn(input) {
    seen.push(input)
    for (const e of events) yield e
  },
})

describe('askSideJob', () => {
  it('asks once with no tools, as a side job, on the given model', async () => {
    const seen: TurnInput[] = []
    const rt = fake(
      [
        { type: 'text', delta: '{"related":' },
        { type: 'text', delta: ' true}' },
        { type: 'done', resumeId: 'x', text: '{"related": true}' },
      ],
      seen,
    )
    const answer = await askSideJob(rt, { text: 'q', systemPrompt: 'judge', cwd: '/w', model: 'small' })
    expect(answer).toBe('{"related": true}')
    expect(seen[0]).toMatchObject({ mcpServers: [], sideJob: true, model: 'small', systemPrompt: 'judge' })
  })

  it('takes the finished text when nothing streamed', async () => {
    const rt = fake([{ type: 'done', resumeId: 'x', text: 'ok' }])
    expect(await askSideJob(rt, { text: 'q', systemPrompt: 's', cwd: '/w' })).toBe('ok')
  })

  it('fails closed on an error, a limit, a throw or an empty answer', async () => {
    const cases: AgentRuntime[] = [
      fake([{ type: 'error', code: 'not_logged_in', message: 'x' }]),
      fake([{ type: 'limit_reached', message: 'x' }]),
      fake([{ type: 'done', resumeId: 'x', text: '  ' }]),
      {
        ...fake([]),
        // biome-ignore lint/correctness/useYield: throws before its first event
        async *runTurn() {
          throw new Error('spawn failed')
        },
      },
    ]
    for (const rt of cases)
      expect(await askSideJob(rt, { text: 'q', systemPrompt: 's', cwd: '/w' })).toBeUndefined()
  })
})
