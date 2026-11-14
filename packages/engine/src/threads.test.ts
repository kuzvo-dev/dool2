import type { AgentEvent, AgentStatus, DaemonStreamEvent } from '@dool2/protocol'
import { Store } from '@dool2/store'
import { describe, expect, it } from 'vitest'
import type { AgentRuntime, TurnInput } from './runtime.js'
import { ThreadService } from './threads.js'

class FakeRuntime implements AgentRuntime {
  readonly id = 'claude' as const
  inputs: TurnInput[] = []
  constructor(private readonly script: AgentEvent[]) {}
  async detect(): Promise<AgentStatus> {
    return { id: 'claude', installed: true, loggedIn: true }
  }
  async *runTurn(input: TurnInput) {
    this.inputs.push(input)
    for (const ev of this.script) yield ev
  }
}

async function collect(it: AsyncIterable<DaemonStreamEvent>) {
  const out: DaemonStreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

function setup(script: AgentEvent[]) {
  const store = new Store(':memory:')
  const rt = new FakeRuntime(script)
  const svc = new ThreadService({
    store,
    runtimes: { claude: rt },
    workspaceDir: '/tmp/ws',
    mcpServers: [{ name: 'dool2', command: 'node', args: ['mcp.js'] }],
  })
  return { store, rt, svc }
}

describe('ThreadService', () => {
  it('사용자 글과 답을 저장하고 이어 하기 id를 남긴다', async () => {
    const { store, rt, svc } = setup([
      { type: 'started', resumeId: 's1', tools: ['mcp__dool2__status'] },
      { type: 'text', delta: '안녕' },
      { type: 'text', delta: '하세요' },
      { type: 'done', resumeId: 's1', text: '안녕하세요' },
    ])
    const t = store.createThread('claude')
    const events = await collect(svc.send(t.id, '인사해 줘'))

    expect(events.at(-1)).toEqual({ type: 'end' })
    expect(store.listMessages(t.id).map((m) => [m.role, m.text])).toEqual([
      ['user', '인사해 줘'],
      ['assistant', '안녕하세요'],
    ])
    expect(store.getThread(t.id)).toMatchObject({ resumeId: 's1', title: '인사해 줘' })
    expect(rt.inputs[0]?.resumeId).toBeUndefined()
    expect(rt.inputs[0]?.mcpServers[0]?.name).toBe('dool2')
  })

  it('두 번째 턴에는 이어 하기 id를 넘긴다', async () => {
    const { store, rt, svc } = setup([{ type: 'done', resumeId: 's9', text: '네' }])
    const t = store.createThread('claude')
    await collect(svc.send(t.id, '하나'))
    await collect(svc.send(t.id, '둘'))
    expect(rt.inputs[1]?.resumeId).toBe('s9')
  })

  it('실패하면 사용자에게 보일 안내를 기록한다', async () => {
    const { store, svc } = setup([
      { type: 'error', code: 'not_logged_in', message: 'Claude 로그인이 필요해요' },
    ])
    const t = store.createThread('claude')
    await collect(svc.send(t.id, '해 줘'))
    expect(store.listMessages(t.id).at(-1)).toMatchObject({
      role: 'system',
      text: 'Claude 로그인이 필요해요',
    })
  })
})
