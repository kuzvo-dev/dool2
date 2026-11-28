import type { RunHandle, TurnEvent } from '@dool2/core'
import { describe, expect, it } from 'vitest'
import { type CliBrainSpec, createCliBrain, runCli } from './bridge.js'
import type { CliExit, CliProcess, CliStreamParser, SpawnCli, WhichFn } from './types.js'

const noop: RunHandle = { toolResult() {}, steer() {}, abort() {} }

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

/** A fake child that streams the given lines then resolves exit. Records the stdin and args it was started with. */
function fakeSpawn(
  lines: string[],
  exit: CliExit = { code: 0, stderrTail: '' },
): {
  spawn: SpawnCli
  calls: Array<{ command: string; args: string[]; stdin?: string }>
} {
  const calls: Array<{ command: string; args: string[]; stdin?: string }> = []
  async function* emit(): AsyncGenerator<string> {
    for (const l of lines) yield l
  }
  const spawn: SpawnCli = (command, args, opts) => {
    calls.push({ command, args, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) })
    const proc: CliProcess = {
      lines: emit(),
      exit: Promise.resolve(exit),
      kill() {},
    }
    return proc
  }
  return { spawn, calls }
}

/** A parser that turns a one-field JSON line into the matching TurnEvent, and ends from the exit code. */
const testParser = (): CliStreamParser => {
  let tools = 0
  return {
    push(line) {
      const o = line as { text?: string; tool?: string; end?: boolean }
      const out: TurnEvent[] = []
      if (o.text) out.push({ kind: 'text', text: o.text })
      if (o.tool) {
        tools++
        out.push({ kind: 'tool_call', call: { id: 't1', name: 'code', args: {} } })
        out.push({ kind: 'turn_end', stop: 'tool' })
      }
      if (o.end) out.push({ kind: 'turn_end', stop: 'done' })
      return out
    },
    end(exit) {
      if (exit.code !== 0) return [{ kind: 'turn_end', stop: 'error' }]
      return [{ kind: 'turn_end', stop: tools > 0 ? 'tool' : 'done' }]
    },
  }
}

describe('runCli', () => {
  it('stops at the first turn_end the parser emits and kills the child', async () => {
    const { spawn } = fakeSpawn([
      JSON.stringify({ text: 'hi' }),
      JSON.stringify({ tool: 'code' }),
      JSON.stringify({ text: 'never read' }),
    ])
    const ev = await collect(runCli({ spawn, command: 'x', argv: [], parser: testParser(), stdin: 'p' }))
    expect(ev.map((e) => e.kind)).toEqual(['text', 'tool_call', 'turn_end'])
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'tool' })
    expect(ev.some((e) => e.kind === 'text' && e.text === 'never read')).toBe(false)
  })

  it('ends a plain stream with turn_end done via the parser end()', async () => {
    const { spawn } = fakeSpawn([JSON.stringify({ text: 'done soon' })])
    const ev = await collect(runCli({ spawn, command: 'x', argv: [], parser: testParser() }))
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'done' })
  })

  it('ends with turn_end error when the child exits nonzero without a terminal', async () => {
    const { spawn } = fakeSpawn([JSON.stringify({ text: 'partial' })], { code: 1, stderrTail: 'boom' })
    const ev = await collect(runCli({ spawn, command: 'x', argv: [], parser: testParser() }))
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'error' })
  })

  it('skips a non-JSON line without throwing', async () => {
    const { spawn } = fakeSpawn(['not json', JSON.stringify({ end: true })])
    const ev = await collect(runCli({ spawn, command: 'x', argv: [], parser: testParser() }))
    expect(ev).toEqual([{ kind: 'turn_end', stop: 'done' }])
  })
})

const spec: CliBrainSpec = {
  id: 'claude',
  label: 'Test CLI',
  binaryName: 'testcli',
  buildArgs: () => ['-p'],
  buildStdin: () => 'prompt',
  makeParser: testParser,
  statusArgs: ['auth', 'status'],
  parseStatus: (out) => out.includes('logged in'),
}

describe('createCliBrain ready()', () => {
  const foundWhich: WhichFn = async () => '/bin/testcli'
  const missingWhich: WhichFn = async () => undefined

  it('is true when which finds the binary and the login probe passes', async () => {
    const brain = createCliBrain(spec, {
      which: foundWhich,
      loginProbe: async () => true,
      spawn: fakeSpawn([]).spawn,
    })
    expect(await brain.ready()).toBe(true)
  })

  it('is false when which does not find the binary', async () => {
    const brain = createCliBrain(spec, { which: missingWhich, loginProbe: async () => true })
    expect(await brain.ready()).toBe(false)
  })

  it('is false when the login probe fails', async () => {
    const brain = createCliBrain(spec, { which: foundWhich, loginProbe: async () => false })
    expect(await brain.ready()).toBe(false)
  })

  it('uses the official status command for the default probe', async () => {
    const { spawn, calls } = fakeSpawn(['logged in as test'])
    const brain = createCliBrain(spec, { which: foundWhich, spawn })
    expect(await brain.ready()).toBe(true)
    expect(calls.at(-1)?.args).toEqual(['auth', 'status'])
  })
})
