import type { AgentEvent, AgentStatus, DaemonStreamEvent } from '@dool2/protocol'
import { Store } from '@dool2/store'
import { describe, expect, it } from 'vitest'
import { buildCarry, ConversationService, formatSearch } from './conversation.js'
import type { AgentRuntime, TurnInput } from './runtime.js'
import { SUMMARY_REQUEST, ThreadService } from './threads.js'

class EchoRuntime implements AgentRuntime {
  inputs: TurnInput[] = []
  /** 있으면 차례 끝에 세션 크기(토큰)를 알린다 */
  contextTokens: number | undefined
  /** 있으면 요약 부탁에 먼저 이 답들을 차례로 한다 (요약답지 않은 답 시험) */
  summaryReplies: string[] = []
  private n = 0
  constructor(readonly id: 'claude' | 'codex') {}
  async detect(): Promise<AgentStatus> {
    return { id: this.id, installed: true, loggedIn: true }
  }
  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    this.inputs.push(input)
    const resumeId = input.resumeId ?? `${this.id}-${++this.n}`
    yield { type: 'started', resumeId, tools: [] }
    const reply =
      input.text === SUMMARY_REQUEST
        ? (this.summaryReplies.shift() ?? '- 국밥을 좋아함')
        : `받았어요: ${input.text}`
    yield { type: 'text', delta: reply }
    if (this.contextTokens) yield { type: 'context', tokens: this.contextTokens }
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
    timeLine: () => undefined,
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

  it('요약 부탁에 요약이 아닌 답("No response requested.")이 오면 한 번 더 부탁해 진짜 요약을 넘긴다', async () => {
    const { convo, claude, store } = setup({ turns: 2 })
    claude.summaryReplies = ['No response requested.']
    await drain(convo.send('claude', '국밥 좋아해'))
    await drain(convo.send('claude', '둘'))
    const first = convo.current()
    await drain(convo.send('claude', '셋'))
    expect(claude.inputs.filter((i) => i.text === SUMMARY_REQUEST)).toHaveLength(2)
    expect(store.getThread(first?.id ?? '')).toMatchObject({ summary: '- 국밥을 좋아함' })
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
    expect(last?.systemPrompt).toContain('User: 둘')
    expect(convo.history()).toHaveLength(6)
  })

  it('답이 끝난 뒤 미리 요약해 두면 다음 말은 요약을 다시 기다리지 않고, 그동안 답하는 중으로 보이지 않는다', async () => {
    const { convo, claude, store } = setup({ turns: 2 })
    await drain(convo.send('claude', '국밥 좋아해'))
    await drain(convo.send('claude', '둘'))
    const first = convo.current()
    convo.prewarm()
    convo.prewarm() // 두 번 불러도 한 번만
    expect(convo.isRunning()).toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    await drain(convo.send('claude', '셋'))
    expect(claude.inputs.filter((i) => i.text === SUMMARY_REQUEST)).toHaveLength(1)
    expect(store.getThread(first?.id ?? '')).toMatchObject({ summary: '- 국밥을 좋아함' })
    expect(convo.current()?.id).not.toBe(first?.id)
  })

  it('오래 쉬었으면 요약 없이 최근 대화만 넘긴다', async () => {
    const { convo, claude, tick } = setup()
    await drain(convo.send('claude', '점심 뭐 먹지'))
    tick(13 * 60 * 60 * 1000)
    await drain(convo.send('claude', '좋은 아침'))
    expect(claude.inputs.some((i) => i.text === SUMMARY_REQUEST)).toBe(false)
    expect(claude.inputs.at(-1)?.systemPrompt).toContain('User: 점심 뭐 먹지')
  })

  it('AI를 바꾸면 그 AI로 새 구간을 연다', async () => {
    const { convo, codex } = setup()
    await drain(convo.send('claude', '안녕'))
    await drain(convo.send('codex', '이어서'))
    expect(convo.current()?.agent).toBe('codex')
    expect(codex.inputs[0]?.systemPrompt).toContain('User: 안녕')
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

  it('AI가 실제로 읽는 양(토큰)이 기준을 넘으면 차례가 적어도 요약을 받아 새 구간으로 넘긴다', async () => {
    const { convo, claude, store } = setup({ contextTokens: 100_000 })
    // 브라우저 페이지를 많이 읽은 차례: 저장된 글은 짧아도 세션은 크다
    claude.contextTokens = 99_999
    await drain(convo.send('claude', '쿠팡에서 청소기 비교해 줘'))
    const first = convo.current()
    expect(store.sessionSize(first?.id ?? '').contextTokens).toBe(99_999)
    expect(convo.needsRotate('claude')).toBeUndefined()
    claude.contextTokens = 140_000
    await drain(convo.send('claude', '두 번째 것도 봐 줘'))
    expect(convo.needsRotate('claude')).toBe('long')
    claude.contextTokens = undefined
    await drain(convo.send('claude', '셋'))
    expect(convo.current()?.id).not.toBe(first?.id)
    expect(claude.inputs.some((i) => i.text === SUMMARY_REQUEST)).toBe(true)
    expect(store.getThread(first?.id ?? '')).toMatchObject({ summary: '- 국밥을 좋아함' })
    // 새 구간은 크기 0부터
    expect(store.sessionSize(convo.current()?.id ?? '').contextTokens).toBe(0)
  })

  it('지난 대화 찾기: 앞 구간의 말을 날짜(한국 시간)·누가와 함께 찾고, 지금 구간은 뺀다', async () => {
    const { convo, tick } = setup()
    await drain(convo.send('claude', '로봇 청소기 30만 원 아래로 찾아 줘'))
    tick(13 * 60 * 60 * 1000)
    await drain(convo.send('claude', '지난번 청소기 뭐였지?'))
    const out = convo.search('청소기')
    expect(out).toContain('Found 2 past messages')
    // 2026-11-15T00:00Z = 한국 시간 11월 15일(일) 오전 9시
    expect(out).toContain('Sun, Nov 15, 2026, 9:00 AM · User: 로봇 청소기 30만 원 아래로 찾아 줘')
    expect(out).toContain('· Dool2: 받았어요: 로봇 청소기 30만 원 아래로 찾아 줘')
    expect(out).not.toContain('지난번 청소기 뭐였지?')
    expect(convo.search('냉장고')).toContain('No past conversation found')
    expect(convo.search('  ')).toBe('Give me words to search for.')
  })

  it('찾은 말이 길면 낱말 둘레만 잘라 보여 준다', () => {
    const text = `${'가'.repeat(300)} 로보락 Q7 ${'나'.repeat(300)}`
    const out = formatSearch(
      '로보락',
      [{ id: '1', threadId: 't', role: 'assistant', text, createdAt: '2026-11-09T06:20:00Z' }],
      new Date('2026-11-16T00:00:00Z'),
    )
    const line = out.split('\n')[1] ?? ''
    expect(line).toContain('Mon, Nov 9, 2026, 3:20 PM · Dool2: …')
    expect(line).toContain('로보락 Q7')
    expect(line.length).toBeLessThan(220)
  })
})

describe('segment handoff', () => {
  it('asks for a handoff under fixed headings, as bullet lines', async () => {
    const { SUMMARY_REQUEST, looksLikeSummary } = await import('./threads.js')
    for (const h of [
      'Now:',
      'Done:',
      'In progress:',
      'Promised:',
      'About the user:',
      'Did not work:',
      'Next:',
    ])
      expect(SUMMARY_REQUEST).toContain(h)
    expect(looksLikeSummary('Now:\n- book a table for 2\nDid not work:\n- site X blocked login')).toBe(true)
  })
})
