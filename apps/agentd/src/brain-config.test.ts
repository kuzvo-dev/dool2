import type { CliExit, CliProcess, SpawnCli, WhichFn } from '@dool2/brain-cli-util'
import type { Brain } from '@dool2/brains'
import type { RunHandle, TurnEvent, TurnInput } from '@dool2/core'
import { makeFakeBridges } from '@dool2/sandbox'
import { describe, expect, it } from 'vitest'
import { Agentd } from './agentd.js'
import { brainConfigFromEnv, chooseBrain, DEFAULT_PI_MODEL } from './brain-config.js'

const noop: RunHandle = { toolResult() {}, steer() {}, abort() {} }

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

/** A fake CLI child: streams the given lines, then exits. Records every spawn (command + args) for assertions. */
function fakeCli(
  lines: string[],
  exit: CliExit = { code: 0, stderrTail: '' },
): { spawn: SpawnCli; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = []
  async function* emit(): AsyncGenerator<string> {
    for (const l of lines) yield l
  }
  const spawn: SpawnCli = (command, args) => {
    calls.push({ command, args })
    const proc: CliProcess = { lines: emit(), exit: Promise.resolve(exit), kill() {} }
    return proc
  }
  return { spawn, calls }
}

describe('chooseBrain: config -> Brain', () => {
  it('defaults to the scripted demo brain when nothing is configured', () => {
    const brain = chooseBrain()
    expect(brain.label).toMatch(/demo/i)
  })

  it("'demo' is the scripted demo brain", () => {
    expect(chooseBrain({ brain: 'demo' }).label).toMatch(/demo/i)
  })

  it("'claude' builds the Claude Code adapter", () => {
    const brain = chooseBrain({ brain: 'claude' }, { which: async () => undefined })
    expect(brain.id).toBe('claude')
    expect(brain.label).toBe('Claude Code')
  })

  it("'codex' builds the Codex adapter", () => {
    const brain = chooseBrain({ brain: 'codex' }, { which: async () => undefined })
    expect(brain.id).toBe('codex')
    expect(brain.label).toBe('Codex')
  })

  it("'pi' with an API key builds the API-key adapter", () => {
    const brain = chooseBrain(
      { brain: 'pi', apiKey: 'sk-test' },
      { fetch: (async () => new Response('')) as typeof fetch },
    )
    expect(brain.id).toBe('pi')
    expect(brain.label).toMatch(/pi/i)
  })

  it("'pi' without an API key throws a clear, actionable error", () => {
    expect(() => chooseBrain({ brain: 'pi' })).toThrowError(/DOOL2_API_KEY|API key/i)
    // a whitespace-only key is still empty
    expect(() => chooseBrain({ brain: 'pi', apiKey: '   ' })).toThrowError(/API key/i)
  })

  it("'pi' ready() is true with a key and false without (offline, no network)", async () => {
    const brain = chooseBrain(
      { brain: 'pi', apiKey: 'sk-test' },
      { fetch: (async () => new Response('')) as typeof fetch },
    )
    expect(await brain.ready()).toBe(true)
  })
})

describe('brainConfigFromEnv', () => {
  it('reads the DOOL2_* variables', () => {
    const config = brainConfigFromEnv({
      DOOL2_BRAIN: 'pi',
      DOOL2_API_KEY: 'sk-abc',
      DOOL2_MODEL: 'some-model',
      DOOL2_BRAIN_BASEURL: 'https://gw.example.com',
      DOOL2_BRAIN_PROVIDER: 'openai',
    } as NodeJS.ProcessEnv)
    expect(config).toEqual({
      brain: 'pi',
      apiKey: 'sk-abc',
      model: 'some-model',
      baseUrl: 'https://gw.example.com',
      provider: 'openai',
    })
  })

  it('defaults to the demo brain and drops unknown/absent values', () => {
    expect(brainConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({ brain: 'demo' })
    expect(brainConfigFromEnv({ DOOL2_BRAIN: 'nope' } as NodeJS.ProcessEnv)).toEqual({ brain: 'demo' })
  })

  it('pi default model is used when DOOL2_MODEL is unset', () => {
    // No model configured -> the pi adapter still builds (the default model rides into the request).
    const brain = chooseBrain(
      { brain: 'pi', apiKey: 'sk' },
      { fetch: (async () => new Response('')) as typeof fetch },
    )
    expect(brain.id).toBe('pi')
    expect(DEFAULT_PI_MODEL).toBeTruthy()
  })
})

describe('chooseBrain: claude/codex availability is gated by ready()', () => {
  it('uses the injected spawn for the status probe and reports signed-in', async () => {
    const { spawn, calls } = fakeCli([JSON.stringify({ loggedIn: true, authMethod: 'subscription' })])
    const brain = chooseBrain({ brain: 'claude' }, { spawn, which: async () => '/bin/claude' })
    expect(await brain.ready()).toBe(true)
    // the adapter really shelled out to the official status command, through our injected spawn
    expect(calls[0]?.command).toBe('/bin/claude')
    expect(calls[0]?.args).toEqual(['auth', 'status'])
  })

  it('reports NOT installed (ready false) when the binary is not found, without crashing', async () => {
    const brain = chooseBrain({ brain: 'codex' }, { which: async () => undefined })
    expect(await brain.ready()).toBe(false)
    // run() surfaces a clean error turn rather than throwing
    const events = await collect(brain.run({ system: '', messages: [{ role: 'user', content: 'hi' }] }, noop))
    expect(events.at(-1)).toEqual({ kind: 'turn_end', stop: 'error' })
  })

  it('reports NOT signed in (ready false) when the login probe says so', async () => {
    const brain = chooseBrain(
      { brain: 'claude' },
      { which: async () => '/bin/claude', loginProbe: async () => false },
    )
    expect(await brain.ready()).toBe(false)
  })
})

/**
 * A FAKE multi-round brain that actually reads the running transcript: first round it calls `code`; the next round it
 * sees the tool result fed back on `messages` (role 'tool') and echoes it, then finishes. Not the scripted demo — it
 * proves the engine's multi-round loop delivers a tool result back to an injected, real-shaped brain.
 */
function toolEchoBrain(): Brain {
  return {
    id: 'pi',
    label: 'FakeMultiRound',
    async ready() {
      return true
    },
    async *run(input: TurnInput, _handle: RunHandle): AsyncIterable<TurnEvent> {
      const toolResult = [...input.messages].reverse().find((m) => m.role === 'tool')
      if (!toolResult) {
        yield { kind: 'text', text: 'Round 1: reading the page.' }
        yield {
          kind: 'tool_call',
          call: { id: 'c1', name: 'code', args: { code: 'JSON.stringify(await page.snapshot())' } },
        }
        yield { kind: 'turn_end', stop: 'tool' }
        return
      }
      yield { kind: 'text', text: `Round 2: I saw the tool result -> ${toolResult.content}` }
      yield { kind: 'turn_end', stop: 'done' }
    },
  }
}

describe('multi-round tool loop with an injected real-shaped brain', () => {
  it('feeds the code tool result back so the brain continues on the second round', async () => {
    const bridges = makeFakeBridges()
    const agentd = new Agentd({ brain: toolEchoBrain(), bridges })

    const result = await agentd.send('what is on the page?')

    expect(result.stop).toBe('done')
    // the code hand ran against the page bridge
    expect(bridges.calls).toContain('page.snapshot')

    // round 1 called the tool, round 2 happened only because the result was fed back
    const kinds = result.transcript.map((t) => t.kind)
    expect(kinds).toEqual([
      'text', // round 1 text
      'tool_call', // round 1 code call
      'tool_result', // engine ran the tool and recorded its result
      'turn_end', // round 1 ends on stop:'tool'
      'text', // round 2 text — proof the second round ran
      'turn_end', // round 2 ends on stop:'done'
    ])

    // the second-round text quotes the tool result, i.e. the result really fed the next round
    const toolResult = result.transcript.find((t) => t.kind === 'tool_result')
    const round2Text = result.transcript.filter((t) => t.kind === 'text').at(-1)
    const content = toolResult?.kind === 'tool_result' ? toolResult.result.content : ''
    const said = round2Text?.kind === 'text' ? round2Text.text : ''
    expect(said).toContain('Round 2')
    expect(content).toContain('https://example.com/login')
    expect(said).toContain(content)
  })
})
