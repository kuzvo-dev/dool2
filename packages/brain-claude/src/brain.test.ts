import type { CliExit, CliProcess, SpawnCli, WhichFn } from '@dool2/brain-cli-util'
import type { RunHandle, TurnEvent } from '@dool2/core'
import { describe, expect, it } from 'vitest'
import { createClaudeBrain } from './brain.js'

const noop: RunHandle = { toolResult() {}, steer() {}, abort() {} }

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

/** A fake `claude` child that streams scripted stream-json lines, then exits. Records argv and stdin. */
function fakeClaude(
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
    const proc: CliProcess = { lines: emit(), exit: Promise.resolve(exit), kill() {} }
    return proc
  }
  return { spawn, calls }
}

const foundWhich: WhichFn = async () => '/usr/local/bin/claude'

// assistant text (streamed as a realtime delta) → a tool_use the daemon will run.
const TEXT_THEN_TOOL = [
  JSON.stringify({ type: 'system', subtype: 'init', tools: [], model: 'claude-sonnet' }),
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'On it. ' } },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'code', input: { expr: '1+1' } }] },
  }),
]

const PLAIN_TEXT = [
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The answer is 42.' } },
  }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'The answer is 42.' }),
]

describe('createClaudeBrain run()', () => {
  it('emits text, a parsed tool_call, then turn_end tool', async () => {
    const { spawn } = fakeClaude(TEXT_THEN_TOOL)
    const brain = createClaudeBrain({ spawn, which: foundWhich, model: 'sonnet' })
    const ev = await collect(brain.run({ system: 's', messages: [{ role: 'user', content: 'go' }] }, noop))

    const text = ev
      .filter((e) => e.kind === 'text')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(text).toBe('On it. ')

    const toolCall = ev.find((e) => e.kind === 'tool_call')
    expect(toolCall).toBeDefined()
    if (toolCall?.kind === 'tool_call') {
      expect(toolCall.call.name).toBe('code')
      expect(toolCall.call.id).toBe('toolu_1')
      expect(toolCall.call.args).toEqual({ expr: '1+1' })
    }

    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'tool' })
    const kinds = ev.map((e) => e.kind)
    expect(kinds.indexOf('text')).toBeLessThan(kinds.indexOf('tool_call'))
    expect(kinds.indexOf('tool_call')).toBeLessThan(kinds.indexOf('turn_end'))
  })

  it('ends a plain text answer with turn_end done', async () => {
    const { spawn } = fakeClaude(PLAIN_TEXT)
    const brain = createClaudeBrain({ spawn, which: foundWhich })
    const ev = await collect(brain.run({ system: 's', messages: [] }, noop))
    expect(ev.some((e) => e.kind === 'tool_call')).toBe(false)
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'done' })
  })

  it('ends with turn_end error when the child exits nonzero', async () => {
    const { spawn } = fakeClaude(['not-a-result-line'], { code: 1, stderrTail: 'crashed' })
    const brain = createClaudeBrain({ spawn, which: foundWhich })
    const ev = await collect(brain.run({ system: 's', messages: [] }, noop))
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'error' })
  })

  it('passes the model and the system prompt as official flags, transcript on stdin', async () => {
    const { spawn, calls } = fakeClaude(PLAIN_TEXT)
    const brain = createClaudeBrain({ spawn, which: foundWhich, model: 'opus' })
    await collect(
      brain.run({ system: 'persona-prompt', messages: [{ role: 'user', content: 'hello' }] }, noop),
    )
    const call = calls[0]
    expect(call?.command).toBe('/usr/local/bin/claude')
    expect(call?.args).toContain('-p')
    expect(call?.args).toEqual(expect.arrayContaining(['--output-format', 'stream-json']))
    expect(call?.args).toEqual(expect.arrayContaining(['--model', 'opus']))
    expect(call?.args).toEqual(expect.arrayContaining(['--append-system-prompt', 'persona-prompt']))
    // The transcript rides on stdin as a stream-json user message, never as a token or a secret.
    const stdin = JSON.parse(call?.stdin ?? '{}') as { type: string; message: { content: string } }
    expect(stdin.type).toBe('user')
    expect(stdin.message.content).toContain('hello')
  })

  it('runs the official binary with no forged identity (no claude-cli UA, no client id)', async () => {
    const { spawn, calls } = fakeClaude(PLAIN_TEXT)
    const brain = createClaudeBrain({ spawn, which: foundWhich })
    await collect(brain.run({ system: 's', messages: [] }, noop))
    const serialized = JSON.stringify(calls[0]).toLowerCase()
    expect(serialized).not.toContain('claude-cli')
    expect(serialized).not.toContain('user-agent')
    expect(serialized).not.toContain('client-id')
    expect(serialized).not.toContain('x-app')
  })
})

describe('createClaudeBrain ready()', () => {
  it('is true when the binary is found and auth status says logged in', async () => {
    const { spawn } = fakeClaude([JSON.stringify({ loggedIn: true, authMethod: 'claudeai' })])
    const brain = createClaudeBrain({ spawn, which: foundWhich })
    expect(await brain.ready()).toBe(true)
  })

  it('is false when which does not find the binary', async () => {
    const brain = createClaudeBrain({
      spawn: fakeClaude([]).spawn,
      which: async () => undefined,
    })
    expect(await brain.ready()).toBe(false)
  })

  it('is false when auth status says not logged in', async () => {
    const { spawn } = fakeClaude([JSON.stringify({ loggedIn: false, authMethod: 'none' })])
    const brain = createClaudeBrain({ spawn, which: foundWhich })
    expect(await brain.ready()).toBe(false)
  })
})
