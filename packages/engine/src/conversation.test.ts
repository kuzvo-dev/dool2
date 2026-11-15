import type { AgentEvent, AgentStatus, DaemonStreamEvent } from '@dool2/protocol'
import { Store } from '@dool2/store'
import { describe, expect, it } from 'vitest'
import { buildCarry, ConversationService } from './conversation.js'
import type { AgentRuntime, TurnInput } from './runtime.js'
import { SUMMARY_REQUEST, ThreadService } from './threads.js'

class EchoRuntime implements AgentRuntime {
  inputs: TurnInput[] = []
  private n = 0
  constructor(readonly id: 'claude' | 'codex') {}
  async detect(): Promise<AgentStatus> {
    return { id: this.id, installed: true, loggedIn: true }
  }
  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    this.inputs.push(input)
    const resumeId = input.resumeId ?? `${this.id}-${++this.n}`
    yield { type: 'started', resumeId, tools: [] }
    const reply = input.text === SUMMARY_REQUEST ? '- 국밥을 좋아함' : `받았어요: ${input.text}`
    yield { type: 'text', delta: reply }
    yield { type: 'done', resumeId, text: reply }
  }
}

async function drain(it: AsyncIterable<DaemonStreamEvent>) {
  for await (const _ of it) {
  }
}

function setup(limits = {}) {
  let t = Date.parse('2026-11-15T00:00:00Z')
  const now = () => new Date(t)
  const tick = (ms: number) => {
    t += ms
  }
  const store = new Store(':memory:', { now })
  const claude = new EchoRuntime('claude')
  const codex = new EchoRuntime('codex')
  const threads = new ThreadService({
    store,
    runtimes: { claude, codex },
    workspaceDir: '/tmp/ws',
    mcpServers: [],
    systemPrompt: '두리 지침',
  })
  const convo = new ConversationService({ store, threads, limits, now })
  return { store, claude, codex, convo, tick }
}

describe('ConversationService (대화는 하나)', () => {
  it('처음 말하면 구간을 하나 열고, 다음 말은 같은 AI 세션으로 잇는다', async () => {
    const { convo, claude } = setup()
    await drain(convo.send('claude', '안녕'))
    await drain(convo.send('claude', '아까 그거'))
    expect(claude.inputs.map((i) => i.resumeId)).toEqual([undefined, 'claude-1'])
    expect(convo.history().map((m) => m.text)).toEqual([
      '안녕',
      '받았어요: 안녕',
      '아까 그거',
      '받았어요: 아까 그거',
    ])
  })

  it('길어지면 요약을 받아 새 구간으로 넘기고, 화면에는 하나로 이어 보인다', async () => {
    const { convo, claude, store } = setup({ turns: 2 })
    await drain(convo.send('claude', '국밥 좋아해'))
    await drain(convo.send('claude', '둘'))
    const first = convo.current()
    await drain(convo.send('claude', '셋'))
    // 요약 부탁은 기록에 남지 않는다
    expect(claude.inputs.some((i) => i.text === SUMMARY_REQUEST)).toBe(true)
    expect(convo.history().map((m) => m.text)).not.toContain(SUMMARY_REQUEST)
    expect(store.getThread(first?.id ?? '')).toMatchObject({ summary: '- 국밥을 좋아함' })
    const now = convo.current()
    expect(now?.id).not.toBe(first?.id)
    // 새 구간은 새 AI 세션으로 시작하고, 지침에 요약과 최근 대화가 붙는다
    const last = claude.inputs.at(-1)
    expect(last?.resumeId).toBeUndefined()
    expect(last?.systemPrompt).toContain('두리 지침')
    expect(last?.systemPrompt).toContain('- 국밥을 좋아함')
    expect(last?.systemPrompt).toContain('사용자: 둘')
    expect(convo.history()).toHaveLength(6)
  })

  it('오래 쉬었으면 요약 없이 최근 대화만 넘긴다', async () => {
    const { convo, claude, tick } = setup()
    await drain(convo.send('claude', '점심 뭐 먹지'))
    tick(13 * 60 * 60 * 1000)
    await drain(convo.send('claude', '좋은 아침'))
    expect(claude.inputs.some((i) => i.text === SUMMARY_REQUEST)).toBe(false)
    expect(claude.inputs.at(-1)?.systemPrompt).toContain('사용자: 점심 뭐 먹지')
  })

  it('AI를 바꾸면 그 AI로 새 구간을 연다', async () => {
    const { convo, codex } = setup()
    await drain(convo.send('claude', '안녕'))
    await drain(convo.send('codex', '이어서'))
    expect(convo.current()?.agent).toBe('codex')
    expect(codex.inputs[0]?.systemPrompt).toContain('사용자: 안녕')
  })

  it('예전에 여러 방이 열려 있었으면 새 구간을 열 때 모두 닫는다', async () => {
    const { convo, store } = setup()
    const a = store.createThread('claude')
    store.createThread('claude')
    await drain(convo.send('codex', '안녕'))
    expect(store.getThread(a.id)?.closedAt).toBeTruthy()
    expect(store.currentSession()?.agent).toBe('codex')
  })

  it('넘길 내용은 길이를 넘지 않는다', () => {
    const long = '가'.repeat(5000)
    const carry = buildCarry(
      { id: 't', agent: 'claude', title: '', createdAt: '', updatedAt: '', carry: long },
      undefined,
      Array.from({ length: 20 }, (_, i) => ({
        id: `${i}`,
        threadId: 't',
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        text: long,
        createdAt: '',
      })),
    )
    expect(carry?.length).toBeLessThanOrEqual(6000)
  })
})
