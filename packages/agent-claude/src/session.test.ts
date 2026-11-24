// Resident session (ADR 0035), replayed from lines captured on the installed CLI (fixtures/stream-*.jsonl).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SessionInput, StreamProcess } from '@dool2/engine'
import type { AgentEvent } from '@dool2/protocol'
import { describe, expect, it } from 'vitest'
import { buildClaudeArgs } from './index.js'
import { ClaudeSession } from './session.js'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')
    .split('\n')
    .filter(Boolean)

const typeOf = (l: string) => (JSON.parse(l) as { type: string }).type

/** Splits captured lines into turns: each ends at its result line (lines after the last result go with it) */
function turns(lines: string[]): string[][] {
  const out: string[][] = [[]]
  for (const l of lines) {
    ;(out.at(-1) as string[]).push(l)
    if (typeOf(l) === 'result') out.push([])
  }
  const tail = out.pop() as string[]
  ;(out.at(-1) as string[]).push(...tail)
  return out
}

/** A program that answers each user line with the next captured turn, and a stop request with `onStop` */
class FakeProc implements StreamProcess {
  written: string[] = []
  killed = false
  ended = false
  private queue: string[] = []
  private wake: (() => void) | undefined
  private done = false
  private resolveExit!: (v: { code: number | null; stderrTail: string }) => void
  exit = new Promise<{ code: number | null; stderrTail: string }>((r) => {
    this.resolveExit = r
  })
  lines: AsyncIterator<string>

  constructor(
    private readonly replies: string[][],
    private readonly onStop: string[] = [],
  ) {
    const self = this
    this.lines = (async function* () {
      while (true) {
        while (self.queue.length) yield self.queue.shift() as string
        if (self.done) return
        await new Promise<void>((r) => {
          self.wake = r
        })
      }
    })()
  }
  get alive() {
    return !this.done
  }
  private push(lines: string[]) {
    this.queue.push(...lines)
    this.wake?.()
  }
  /** The program ends on its own (a crash) */
  die(code = 1) {
    this.done = true
    this.wake?.()
    this.resolveExit({ code, stderrTail: 'boom' })
  }
  write(line: string) {
    if (this.done) return false
    this.written.push(line)
    const msg = JSON.parse(line) as { type: string }
    if (msg.type === 'user') this.push(this.replies.shift() ?? [])
    if (msg.type === 'control_request') this.push(this.onStop)
    return true
  }
  end() {
    this.ended = true
    this.die(0)
  }
  kill() {
    this.killed = true
    if (!this.done) this.die(143)
  }
}

const input: SessionInput = {
  systemPrompt: 'Dool2',
  mcpServers: [{ name: 'dool2', command: 'node', args: ['mcp.js'] }],
  cwd: '/tmp/ws',
}

function session(procs: FakeProc[], o: { input?: SessionInput } = {}) {
  const spawned: string[][] = []
  const s = new ClaudeSession({
    bin: 'claude',
    input: o.input ?? input,
    lang: 'en',
    retryDelayMs: 1,
    interruptGraceMs: 50,
    args: (resumeId) => buildClaudeArgs({ ...input, ...(resumeId ? { resumeId } : {}) }, { stream: true }),
    spawn: (_cmd, args) => {
      spawned.push(args)
      const p = procs.shift()
      if (!p) throw new Error('no more programs')
      return p
    },
  })
  return { s, spawned }
}

async function run(it: AsyncIterable<AgentEvent>, onEvent?: (ev: AgentEvent) => void) {
  const out: AgentEvent[] = []
  for await (const ev of it) {
    out.push(ev)
    onEvent?.(ev)
  }
  return out
}
const text = (evs: AgentEvent[]) => evs.map((e) => (e.type === 'text' ? e.delta : '')).join('')

describe('resident Claude session', () => {
  it('sends stream-json input to one program', () => {
    const args = buildClaudeArgs(input, { stream: true })
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json')
    expect(buildClaudeArgs(input)[args.indexOf('--input-format') + 1]).toBe('text')
  })

  it('runs several turns on one program, each ending at its result line', async () => {
    const proc = new FakeProc(turns(fixture('stream-multi-turn.jsonl')))
    const { s, spawned } = session([proc], { input: { ...input, mcpServers: [] } })
    s.start()
    const a = await run(s.send('Remember the word PELICAN. Reply OK.'))
    const b = await run(s.send('Which word did I ask you to remember?'))
    expect(text(a)).toBe('OK')
    expect(a.at(-1)).toMatchObject({ type: 'done' })
    expect(text(b)).toBe('PELICAN')
    expect(b.at(-1)).toMatchObject({ type: 'done', resumeId: '5c3554ad-c193-41e2-894f-b465de8f98e7' })
    expect(spawned).toHaveLength(1)
    expect(proc.written.map((l) => JSON.parse(l))).toEqual([
      { type: 'user', message: { role: 'user', content: 'Remember the word PELICAN. Reply OK.' } },
      { type: 'user', message: { role: 'user', content: 'Which word did I ask you to remember?' } },
    ])
    expect(proc.killed).toBe(false)
  })

  it('stop ends the turn as stopped and the same program takes the next message', async () => {
    const lines = fixture('stream-interrupt.jsonl')
    const at = lines.findIndex((l) => typeOf(l) === 'control_response')
    const firstResult = lines.findIndex((l) => typeOf(l) === 'result')
    const proc = new FakeProc(
      [lines.slice(0, at), lines.slice(firstResult + 1)],
      lines.slice(at, firstResult + 1),
    )
    const { s } = session([proc], { input: { ...input, mcpServers: [] } })
    s.start()
    const ac = new AbortController()
    const a = await run(s.send('Count from 1 to 300', ac.signal), (ev) => {
      if (ev.type === 'started') ac.abort()
    })
    expect(a.at(-1)).toEqual({ type: 'error', code: 'aborted', message: 'Stopped' })
    expect(a.some((e) => e.type === 'error' && e.code === 'process_failed')).toBe(false)
    expect(JSON.parse(proc.written[1] ?? '{}')).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    })
    expect(s.alive).toBe(true)
    const b = await run(s.send('Reply with the single word READY.'))
    expect(text(b)).toBe('READY')
    expect(proc.killed).toBe(false)
  })

  it('ends the program when a stopped turn does not end soon', async () => {
    const lines = fixture('stream-interrupt.jsonl')
    const at = lines.findIndex((l) => typeOf(l) === 'control_response')
    // A program that ignores the stop request
    const proc = new FakeProc([lines.slice(0, at)], [])
    const { s } = session([proc], { input: { ...input, mcpServers: [] } })
    s.start()
    const ac = new AbortController()
    const a = await run(s.send('Count', ac.signal), (ev) => {
      if (ev.type === 'started') ac.abort()
    })
    expect(a.at(-1)).toMatchObject({ type: 'error', code: 'aborted' })
    expect(proc.killed).toBe(true)
    expect(s.alive).toBe(false)
  })

  it('a program that ended between messages starts again and continues the same session', async () => {
    const multi = turns(fixture('stream-multi-turn.jsonl'))
    const first = new FakeProc([multi[0] as string[]])
    const again = new FakeProc(turns(fixture('stream-resume.jsonl')))
    const { s, spawned } = session([first, again], { input: { ...input, mcpServers: [] } })
    s.start()
    await run(s.send('Remember the word PELICAN. Reply OK.'))
    first.die()
    const b = await run(s.send('Which word did I ask you to remember? One word.'))
    expect(text(b)).toBe('PELICAN')
    expect(spawned).toHaveLength(2)
    expect(spawned[0]).not.toContain('--resume')
    expect(spawned[1]?.[spawned[1].indexOf('--resume') + 1]).toBe('5c3554ad-c193-41e2-894f-b465de8f98e7')
  })

  it('a program that crashes partway reports it', async () => {
    const multi = turns(fixture('stream-multi-turn.jsonl'))
    const proc = new FakeProc([(multi[0] as string[]).slice(0, 3)])
    const { s } = session([proc], { input: { ...input, mcpServers: [] } })
    s.start()
    const out = run(s.send('hi'))
    await new Promise((r) => setTimeout(r, 5))
    proc.die(1)
    const evs = await out
    expect(evs.at(-1)).toMatchObject({ type: 'error', code: 'process_failed' })
  })

  it('starts again when the program came up without Dool2 tools', async () => {
    const noTools = new FakeProc(turns(fixture('stream-multi-turn.jsonl')))
    const withTools = new FakeProc(turns(fixture('stream-tools.jsonl')))
    const { s, spawned } = session([noTools, withTools])
    s.start()
    const evs = await run(s.send('Call the echo tool'))
    expect(noTools.killed).toBe(true)
    expect(spawned).toHaveLength(2)
    expect(evs.filter((e) => e.type === 'started')).toHaveLength(1)
    expect(evs.find((e) => e.type === 'started')).toMatchObject({ tools: ['mcp__dool2__echo'] })
    expect(evs.some((e) => e.type === 'tool' && e.name === 'mcp__dool2__echo')).toBe(true)
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
    // The message went to the new program too
    expect(withTools.written).toHaveLength(1)
  })

  it('a turn left partway ends the program, so its lines never reach the next turn', async () => {
    const multi = turns(fixture('stream-multi-turn.jsonl'))
    const first = new FakeProc([multi[0] as string[]])
    const again = new FakeProc([multi[1] as string[]])
    const { s, spawned } = session([first, again], { input: { ...input, mcpServers: [] } })
    s.start()
    for await (const ev of s.send('Remember the word PELICAN. Reply OK.')) if (ev.type === 'started') break
    expect(first.killed).toBe(true)
    const b = await run(s.send('Which word did I ask you to remember?'))
    expect(text(b)).toBe('PELICAN')
    expect(spawned).toHaveLength(2)
  })

  it('close ends the program by closing its input', async () => {
    const proc = new FakeProc([])
    const { s } = session([proc])
    s.start()
    await s.close()
    expect(proc.ended).toBe(true)
    expect(s.alive).toBe(false)
    await expect(run(s.send('hi'))).rejects.toThrow('closed')
  })
})
