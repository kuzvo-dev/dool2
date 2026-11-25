import { readFileSync } from 'node:fs'
import type { StreamProcess } from '@dool2/engine'
import type { AgentEvent } from '@dool2/protocol'
import { describe, expect, it } from 'vitest'
import { CodexRuntime, CodexSession, type SpawnCodex } from './index.js'

type Json = Record<string, unknown>
type Msg = Json & { id?: number; method?: string }

/** A fake `codex app-server`: answers requests with handler(msg, emit). Lines it writes go to the session */
class FakeServer implements StreamProcess {
  readonly sent: Msg[] = []
  private queue: string[] = []
  private wake: (() => void) | undefined
  private done = false
  private resolveExit!: (x: { code: number | null; stderrTail: string }) => void
  readonly exit = new Promise<{ code: number | null; stderrTail: string }>((r) => {
    this.resolveExit = r
  })
  readonly lines: AsyncIterator<string>

  constructor(private readonly handler: (msg: Msg, emit: (m: Json) => void) => void) {
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

  emit(m: Json) {
    if (this.done) return
    this.queue.push(JSON.stringify(m))
    this.wake?.()
  }

  write(line: string) {
    if (this.done) return false
    const msg = JSON.parse(line) as Msg
    this.sent.push(msg)
    queueMicrotask(() => this.handler(msg, (m) => this.emit(m)))
    return true
  }

  end() {
    this.kill()
  }

  kill() {
    if (this.done) return
    this.done = true
    this.wake?.()
    this.resolveExit({ code: 0, stderrTail: '' })
  }
}

/** A scripted server: one thread, turns answer `reply` or wait for turn/interrupt */
function scripted(o: { reply?: (n: number) => Json[] | 'hang'; thread?: string } = {}) {
  const servers: FakeServer[] = []
  let turns = 0
  const thread = o.thread ?? 'th-1'
  const spawn: SpawnCodex = () => {
    const s = new FakeServer((msg, emit) => {
      if (msg.id === undefined) return
      const ok = (result: unknown) => emit({ id: msg.id, result })
      switch (msg.method) {
        case 'initialize':
          return ok({ userAgent: 'dool2/0.169.0' })
        case 'model/list':
          return ok({ data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna' }] })
        case 'thread/start':
        case 'thread/resume':
          return ok({ thread: { id: (msg.params as Json).threadId ?? thread } })
        case 'thread/fork':
          return ok({ thread: { id: 'th-copy' } })
        case 'turn/start': {
          const turnId = `turn-${++turns}`
          ok({ turn: { id: turnId, status: 'inProgress' } })
          emit({ method: 'turn/started', params: { threadId: thread, turn: { id: turnId } } })
          const script = o.reply?.(turns) ?? [
            {
              method: 'item/agentMessage/delta',
              params: { threadId: thread, turnId, delta: `answer ${turns}` },
            },
            {
              method: 'turn/completed',
              params: { threadId: thread, turn: { id: turnId, status: 'completed' } },
            },
          ]
          if (script !== 'hang') for (const m of script) emit(m)
          return
        }
        case 'turn/interrupt': {
          ok({})
          const p = msg.params as Json
          return emit({
            method: 'turn/completed',
            params: { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted' } },
          })
        }
        default:
          return emit({ id: msg.id, error: { code: -1, message: `unknown ${msg.method}` } })
      }
    })
    servers.push(s)
    return s
  }
  return { spawn, servers }
}

const input = {
  systemPrompt: 'Dool2',
  mcpServers: [{ name: 'dool2', command: '/x/node', args: ['/x/mcp.js'] }],
  cwd: '/tmp/ws',
}
const session = (spawn: SpawnCodex, more: Partial<ConstructorParameters<typeof CodexSession>[0]> = {}) =>
  new CodexSession({ bin: 'codex', args: ['app-server'], env: {}, input, lang: 'en', spawn, ...more })

async function collect(it: AsyncIterable<AgentEvent>, onEvent?: (e: AgentEvent) => void) {
  const out: AgentEvent[] = []
  for await (const e of it) {
    out.push(e)
    onEvent?.(e)
  }
  return out
}

describe('CodexSession (resident Codex, ADR 0035)', () => {
  it('keeps one program and one thread for several messages', async () => {
    const { spawn, servers } = scripted()
    const s = session(spawn)
    const first = await collect(s.send('hello'))
    const second = await collect(s.send('and then'))
    expect(servers).toHaveLength(1)
    const methods = servers[0]?.sent.map((m) => m.method)
    expect(methods?.filter((m) => m === 'thread/start')).toHaveLength(1)
    expect(methods?.filter((m) => m === 'turn/start')).toHaveLength(2)
    expect(first[0]).toEqual({ type: 'started', resumeId: 'th-1', tools: ['mcp__dool2__*'] })
    expect(first.at(-1)).toEqual({ type: 'done', resumeId: 'th-1', text: 'answer 1' })
    expect(second.at(-1)).toEqual({ type: 'done', resumeId: 'th-1', text: 'answer 2' })
    // Dool2's instructions go in once, as developer instructions
    const start = servers[0]?.sent.find((m) => m.method === 'thread/start')?.params as Json
    expect(start).toMatchObject({
      developerInstructions: 'Dool2',
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    await s.close()
    expect(s.alive).toBe(false)
  })

  it('the stop button ends the turn and the same program takes the next message', async () => {
    const { spawn, servers } = scripted({ reply: (n) => (n === 1 ? 'hang' : (undefined as never)) })
    const s = session(spawn)
    const stopped = await collect(s.send('long job'), (e) => {
      if (e.type === 'started') setTimeout(() => s.interrupt(), 5)
    })
    expect(stopped.at(-1)).toMatchObject({ type: 'error', code: 'aborted' })
    expect(servers[0]?.sent.find((m) => m.method === 'turn/interrupt')?.params).toEqual({
      threadId: 'th-1',
      turnId: 'turn-1',
    })
    const next = await collect(s.send('something else'))
    expect(next.at(-1)).toMatchObject({ type: 'done', text: 'answer 2' })
    expect(servers).toHaveLength(1)
    await s.close()
  })

  it('an aborted signal stops the turn the same way', async () => {
    const { spawn } = scripted({ reply: () => 'hang' })
    const s = session(spawn)
    const ac = new AbortController()
    const evs = await collect(s.send('go', ac.signal), (e) => {
      if (e.type === 'started') setTimeout(() => ac.abort(), 5)
    })
    expect(evs.at(-1)).toMatchObject({ type: 'error', code: 'aborted' })
    await s.close()
  })

  it('a program that ended between messages starts again and resumes the thread', async () => {
    const { spawn, servers } = scripted()
    const s = session(spawn)
    await collect(s.send('one'))
    servers[0]?.kill()
    const evs = await collect(s.send('two'))
    expect(servers).toHaveLength(2)
    expect(servers[1]?.sent.find((m) => m.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'th-1',
      developerInstructions: 'Dool2',
    })
    expect(evs.at(-1)).toMatchObject({ type: 'done', resumeId: 'th-1' })
    await s.close()
  })

  it('a program that ends during a turn is reported, and the next message starts it again', async () => {
    const { spawn, servers } = scripted({ reply: (n) => (n === 1 ? 'hang' : (undefined as never)) })
    const s = session(spawn)
    const evs = await collect(s.send('one'), (e) => {
      if (e.type === 'started') setTimeout(() => servers[0]?.kill(), 5)
    })
    expect(evs.at(-1)).toMatchObject({ type: 'error', code: 'process_failed' })
    const next = await collect(s.send('two'))
    expect(next.at(-1)).toMatchObject({ type: 'done' })
    expect(servers).toHaveLength(2)
    await s.close()
  })

  it('late lines of an ended turn do not leak into the next one', async () => {
    const { spawn } = scripted({
      reply: (n) =>
        n === 1
          ? 'hang'
          : [
              // A late piece of the stopped turn 1, then turn 2's own answer
              {
                method: 'item/agentMessage/delta',
                params: { threadId: 'th-1', turnId: 'turn-1', delta: 'stale' },
              },
              {
                method: 'item/agentMessage/delta',
                params: { threadId: 'th-1', turnId: 'turn-2', delta: 'fresh' },
              },
              {
                method: 'turn/completed',
                params: { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed' } },
              },
              {
                method: 'turn/completed',
                params: { threadId: 'th-1', turn: { id: 'turn-2', status: 'completed' } },
              },
            ],
    })
    const s = session(spawn)
    await collect(s.send('one'), (e) => {
      if (e.type === 'started') setTimeout(() => s.interrupt(), 5)
    })
    const evs = await collect(s.send('two'))
    expect(evs.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'fresh' }])
    expect(evs.at(-1)).toEqual({ type: 'done', resumeId: 'th-1', text: 'fresh' })
    await s.close()
  })

  it('a tool Dool2 does not allow ends the program', async () => {
    const { spawn, servers } = scripted({
      reply: (n) =>
        n === 1
          ? [
              {
                method: 'item/started',
                params: { threadId: 'th-1', turnId: 'turn-1', item: { type: 'commandExecution' } },
              },
            ]
          : (undefined as never),
    })
    const s = session(spawn)
    const evs = await collect(s.send('one'))
    expect(evs.at(-1)).toMatchObject({ type: 'error', code: 'tools_unsafe' })
    expect(servers[0]?.alive).toBe(false)
    const next = await collect(s.send('two'))
    expect(next.at(-1)).toMatchObject({ type: 'done' })
    expect(servers).toHaveLength(2)
    await s.close()
  })

  it('a thread that cannot start (tool server failed) is an error, not a hang', async () => {
    const spawn: SpawnCodex = () =>
      new FakeServer((msg, emit) => {
        if (msg.method === 'initialize') emit({ id: msg.id, result: {} })
        if (msg.method === 'thread/start')
          emit({ id: msg.id, error: { code: -1, message: 'required MCP server dool2 failed to start' } })
      })
    const s = session(spawn)
    const evs = await collect(s.send('hi'))
    expect(evs).toEqual([expect.objectContaining({ type: 'error', code: 'process_failed' })])
    await s.close()
  })
})

/** Lines captured from the pinned Codex 0.169.0: two turns on one program, each stopped with turn/interrupt */
const captured = readFileSync(
  new URL('../fixtures/app-server-two-turns-interrupt.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Msg & { dir: 'in' | 'out' })

/** Replays the capture: each request the session sends must be the next one captured; then the captured answers follow */
function replay(): { spawn: SpawnCodex; unexpected: string[] } {
  const unexpected: string[] = []
  let at = 0
  const spawn: SpawnCodex = () =>
    new FakeServer((msg, emit) => {
      const want = captured[at]
      if (want?.dir !== 'out' || want.method !== msg.method) {
        unexpected.push(`${msg.method} (wanted ${want?.method})`)
        return
      }
      at++
      while (captured[at]?.dir === 'in') {
        const { dir: _d, ms: _m, ...line } = captured[at++] as Msg & { dir: string; ms: number }
        emit(line.id !== undefined && !line.method ? { ...line, id: msg.id } : line)
      }
    })
  return { spawn, unexpected }
}

describe('CodexSession against the captured app-server lines', () => {
  it('two turns on one program, each ended by the stop button', async () => {
    const { spawn, unexpected } = replay()
    const s = new CodexSession({
      bin: 'codex',
      args: ['app-server'],
      env: {},
      input: { systemPrompt: 'x', mcpServers: [], cwd: '/tmp' },
      lang: 'en',
      spawn,
    })
    for (let i = 0; i < 2; i++) {
      const evs = await collect(s.send('hi'), (e) => {
        if (e.type === 'started') setTimeout(() => s.interrupt(), 5)
      })
      expect(evs[0]).toMatchObject({ type: 'started', resumeId: '01a21088-a5b5-78c1-b4ae-f65e1f370a27' })
      // The retrying connection error (willRetry) is not an error of the turn
      expect(evs.filter((e) => e.type === 'error')).toEqual([expect.objectContaining({ code: 'aborted' })])
    }
    expect(unexpected).toEqual([])
    await s.close()
  })
})

describe('CodexRuntime on the session', () => {
  const runtime = (spawn: SpawnCodex) =>
    new CodexRuntime({
      codexHome: '/tmp/dool2-codex-test-home',
      binPath: '/no/such/codex',
      lang: () => 'en',
      spawn,
    })

  it('runTurn is one message on a fresh program, closed after', async () => {
    const { spawn, servers } = scripted()
    const evs = await collect(runtime(spawn).runTurn({ ...input, text: 'hi' }))
    expect(evs.at(-1)).toMatchObject({ type: 'done', text: 'answer 1' })
    expect(servers[0]?.alive).toBe(false)
  })

  it('a side job replaces Codex instructions, saves nothing, thinks little, on the small model', async () => {
    const { spawn, servers } = scripted()
    const evs = await collect(
      runtime(spawn).runTurn({
        text: 'judge this',
        systemPrompt: 'You judge.',
        mcpServers: [],
        cwd: '/tmp/ws',
        model: 'gpt-6-luna',
        sideJob: true,
      }),
    )
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
    const sent = servers[0]?.sent ?? []
    expect(sent.find((m) => m.method === 'thread/start')?.params).toMatchObject({
      baseInstructions: 'You judge.',
      ephemeral: true,
      model: 'gpt-6-luna',
    })
    expect(sent.find((m) => m.method === 'thread/start')?.params).not.toHaveProperty('developerInstructions')
    expect(sent.find((m) => m.method === 'turn/start')?.params).toMatchObject({ effort: 'low' })
  })

  it('a summary continues in a copy of the thread', async () => {
    const { spawn, servers } = scripted({ thread: 'th-copy' })
    const evs = await collect(
      runtime(spawn).runTurn({ ...input, text: 'sum up', resumeId: 'th-1', fork: true }),
    )
    expect(servers[0]?.sent.find((m) => m.method === 'thread/fork')?.params).toMatchObject({
      threadId: 'th-1',
    })
    expect(servers[0]?.sent.some((m) => m.method === 'thread/resume')).toBe(false)
    expect(evs.at(-1)).toMatchObject({ type: 'done', resumeId: 'th-copy' })
  })

  it('openSession gives a resident session that is already starting', async () => {
    const { spawn, servers } = scripted()
    const s = await runtime(spawn).openSession(input)
    expect(s).toBeDefined()
    await new Promise((r) => setTimeout(r, 10))
    expect(servers).toHaveLength(1)
    expect(servers[0]?.sent.map((m) => m.method)).toContain('thread/start')
    const evs = await collect(s?.send('hi') as AsyncIterable<AgentEvent>)
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
    await s?.close()
  })
})
