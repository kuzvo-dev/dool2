import type { ToolCall, TurnEvent } from '@dool2/core'
import { makeFakeBridges } from '@dool2/sandbox'
import { describe, expect, it } from 'vitest'
import { runTurn } from './engine.js'
import { scriptedBrain } from './scripted-brain.js'

const codeCall = (id: string, code: string): ToolCall => ({ id, name: 'code', args: { code } })

describe('runTurn: brain -> code tool -> result -> loop', () => {
  it('runs a code snippet that snapshots the page and returns the snapshot to the brain', async () => {
    const bridges = makeFakeBridges()
    const rounds: TurnEvent[][] = [
      [
        { kind: 'text', text: 'Let me look at the page.' },
        { kind: 'tool_call', call: codeCall('c1', 'page.snapshot()') },
        { kind: 'turn_end', stop: 'tool' },
      ],
      [
        { kind: 'text', text: 'I can see the sign-in form.' },
        { kind: 'turn_end', stop: 'done' },
      ],
    ]

    const result = await runTurn(
      { brain: scriptedBrain(rounds), bridges },
      { message: 'what is on this page?' },
    )

    expect(result.stop).toBe('done')
    // the code hand actually drove page.snapshot through the bridge
    expect(bridges.calls).toContain('page.snapshot')

    const texts = result.transcript.filter((t) => t.kind === 'text').map((t) => t.text)
    expect(texts).toContain('Let me look at the page.')
    expect(texts).toContain('I can see the sign-in form.')

    const toolResults = result.transcript.filter((t) => t.kind === 'tool_result')
    expect(toolResults).toHaveLength(1)
    const content = toolResults[0]?.kind === 'tool_result' ? toolResults[0].result.content : ''
    // the snapshot result flowed back as the tool result the brain reads
    expect(content).toContain('https://example.com/login')
    expect(content).toContain('Sign in')

    // no gate decisions for a read-only snapshot
    expect(result.gateDecisions).toHaveLength(0)
    expect(result.approvals).toHaveLength(0)
  })

  it('handles ask/approve/task/memory tools minimally without a sandbox', async () => {
    const bridges = makeFakeBridges()
    const rounds: TurnEvent[][] = [
      [
        { kind: 'tool_call', call: { id: 'a1', name: 'ask', args: { question: 'which account?' } } },
        { kind: 'turn_end', stop: 'tool' },
      ],
      [{ kind: 'turn_end', stop: 'done' }],
    ]
    const result = await runTurn({ brain: scriptedBrain(rounds), bridges }, { message: 'book it' })
    const toolResults = result.transcript.filter((t) => t.kind === 'tool_result')
    const content = toolResults[0]?.kind === 'tool_result' ? toolResults[0].result.content : ''
    expect(content).toContain('which account?')
  })

  it('defaults the autonomy level to ask and assembles the base prompt', async () => {
    const bridges = makeFakeBridges()
    const result = await runTurn(
      { brain: scriptedBrain([[{ kind: 'turn_end', stop: 'done' }]]), bridges },
      { message: 'hello' },
    )
    expect(result.system).toContain('You are Dool2')
    expect(result.injectedSkills).toHaveLength(0)
  })
})
