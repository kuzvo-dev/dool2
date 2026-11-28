import type { CliExit, CliProcess, SpawnCli, WhichFn } from '@dool2/brain-cli-util'
import type { RunHandle, TurnEvent } from '@dool2/core'
import { describe, expect, it } from 'vitest'
import { createCodexBrain } from './brain.js'

const noop: RunHandle = { toolResult() {}, steer() {}, abort() {} }

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

/** A fake `codex` child that streams scripted `exec --json` lines, then exits. Records argv and stdin. */
function fakeCodex(
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

const foundWhich: WhichFn = async () => '/usr/local/bin/codex'

// assistant text (streamed) → an MCP tool call the daemon will run. Codex wraps each EventMsg as { id, msg }.
const TEXT_THEN_TOOL = [
  JSON.stringify({ id: '0', msg: { type: 'task_started' } }),
  JSON.stringify({ id: '0', msg: { type: 'agent_message_delta', delta: 'Let me compute. ' } }),
  JSON.stringify({
    id: '0',
    msg: {
      type: 'mcp_tool_call_begin',
      call_id: 'call_1',
      invocation: { server: 'dool2', tool: 'code', arguments: { expr: '2+2' } },
    },
  }),
]

const PLAIN_TEXT = [
  JSON.stringify({ id: '0', msg: { type: 'agent_message_delta', delta: 'The answer is 42.' } }),
  JSON.stringify({ id: '0', msg: { type: 'task_complete', last_agent_message: 'The answer is 42.' } }),
]

describe('createCodexBrain run()', () => {
  it('emits text, a parsed tool_call, then turn_end tool', async () => {
    const { spawn } = fakeCodex(TEXT_THEN_TOOL)
    const brain = createCodexBrain({ spawn, which: foundWhich })
    const ev = await collect(brain.run({ system: 's', messages: [{ role: 'user', content: 'go' }] }, noop))

    const text = ev
      .filter((e) => e.kind === 'text')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(text).toBe('Let me compute. ')

    const toolCall = ev.find((e) => e.kind === 'tool_call')
    expect(toolCall).toBeDefined()
    if (toolCall?.kind === 'tool_call') {
      expect(toolCall.call.name).toBe('code')
      expect(toolCall.call.id).toBe('call_1')
      expect(toolCall.call.args).toEqual({ expr: '2+2' })
    }

    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'tool' })
    const kinds = ev.map((e) => e.kind)
    expect(kinds.indexOf('text')).toBeLessThan(kinds.indexOf('tool_call'))
    expect(kinds.indexOf('tool_call')).toBeLessThan(kinds.indexOf('turn_end'))
  })

  it('ends a plain text answer with turn_end done', async () => {
    const { spawn } = fakeCodex(PLAIN_TEXT)
    const brain = createCodexBrain({ spawn, which: foundWhich })
    const ev = await collect(brain.run({ system: 's', messages: [] }, noop))
    expect(ev.some((e) => e.kind === 'tool_call')).toBe(false)
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'done' })
  })

  it('ends with turn_end error when the child exits nonzero', async () => {
    const { spawn } = fakeCodex(['{"id":"0","msg":{"type":"task_started"}}'], {
      code: 1,
      stderrTail: 'crashed',
    })
    const brain = createCodexBrain({ spawn, which: foundWhich })
    const ev = await collect(brain.run({ system: 's', messages: [] }, noop))
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'error' })
  })

  it('passes the model flag and reads the prompt (system + transcript) from stdin', async () => {
    const { spawn, calls } = fakeCodex(PLAIN_TEXT)
    const brain = createCodexBrain({ spawn, which: foundWhich, model: 'gpt-5-codex' })
    await collect(
      brain.run({ system: 'persona-prompt', messages: [{ role: 'user', content: 'hello' }] }, noop),
    )
    const call = calls[0]
    expect(call?.command).toBe('/usr/local/bin/codex')
    expect(call?.args).toEqual(expect.arrayContaining(['exec', '--json']))
    expect(call?.args).toEqual(expect.arrayContaining(['--model', 'gpt-5-codex']))
    expect(call?.args.at(-1)).toBe('-')
    expect(call?.stdin).toContain('persona-prompt')
    expect(call?.stdin).toContain('hello')
  })

  it('runs the official binary with no forged identity (no client id, no UA)', async () => {
    const { spawn, calls } = fakeCodex(PLAIN_TEXT)
    const brain = createCodexBrain({ spawn, which: foundWhich })
    await collect(brain.run({ system: 's', messages: [] }, noop))
    const serialized = JSON.stringify(calls[0]).toLowerCase()
    expect(serialized).not.toContain('user-agent')
    expect(serialized).not.toContain('client-id')
    expect(serialized).not.toContain('originator')
  })
})

describe('createCodexBrain ready()', () => {
  it('is true when the binary is found and login status is clean', async () => {
    const { spawn } = fakeCodex(['Logged in using ChatGPT'])
    const brain = createCodexBrain({ spawn, which: foundWhich })
    expect(await brain.ready()).toBe(true)
  })

  it('is false when which does not find the binary', async () => {
    const brain = createCodexBrain({ spawn: fakeCodex([]).spawn, which: async () => undefined })
    expect(await brain.ready()).toBe(false)
  })

  it('is false when login status says not logged in', async () => {
    const { spawn } = fakeCodex(['Not logged in'])
    const brain = createCodexBrain({ spawn, which: foundWhich })
    expect(await brain.ready()).toBe(false)
  })
})
