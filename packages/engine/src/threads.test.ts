import type { AgentEvent, AgentStatus, DaemonStreamEvent } from '@dool2/protocol'
import { Store } from '@dool2/store'
import { describe, expect, it } from 'vitest'
import { buildCarry } from './conversation.js'
import type { AgentRuntime, AgentSession, SessionInput, TurnInput } from './runtime.js'
import { fileApprovalWhat, looksLikeSummary, serviceAct, ThreadService, WorkLog } from './threads.js'

describe('PC 파일·PC 승인 카드 (ADR 0024)', () => {
  it('승인을 요청하는 입력에만 카드 글을 만든다', () => {
    expect(fileApprovalWhat('file_trash', { restore: ['a', 'b'] })).toBe('휴지통에서 2개 되살리기')
    expect(fileApprovalWhat('file_trash', { restore: ['a'] })).toBeUndefined()
    expect(fileApprovalWhat('file_trash', { query: '발표' })).toBeUndefined()
    expect(fileApprovalWhat('file_download', { url: 'https://x/a.exe', confirm: true })).toBe(
      '실행 파일 받기',
    )
    expect(fileApprovalWhat('file_download', { url: 'https://x/a.pdf' })).toBeUndefined()
    expect(fileApprovalWhat('pc_screen', { action: 'lock' })).toBe('이 PC 화면 잠그기')
    expect(fileApprovalWhat('pc_screen', { action: 'off' })).toBeUndefined()
    expect(fileApprovalWhat('file_move', { moves: [{}, {}] })).toBe('파일 2개 옮기기')
  })

  it('영어로도 카드 글을 만든다', () => {
    expect(fileApprovalWhat('file_move', { moves: [{}, {}] }, 'en')).toBe('Move 2 files')
    expect(fileApprovalWhat('pc_screen', { action: 'sleep' }, 'en')).toBe('Put this PC to sleep')
  })
})

describe('언어', () => {
  it('서비스 도구 일하는 중 글은 언어마다', () => {
    const title = () => '극장 찾기'
    expect(serviceAct('cgv_theaters', {}, title)).toBe('극장 찾기 중')
    expect(serviceAct('cgv_movies', {}, () => '상영 중인 영화')).toBe('상영 중인 영화 보는 중')
    expect(serviceAct('x_find', {}, () => 'Find theaters', 'en')).toBe('Find theaters…')
  })

  it('요약은 글머리표가 있으면 어느 말이든 받는다', () => {
    expect(looksLikeSummary('- 국밥을 좋아함')).toBe(true)
    expect(looksLikeSummary('- Likes gukbap')).toBe(true)
    expect(looksLikeSummary('No response requested.')).toBe(false)
  })

  it('예전 한국어 머리말로 저장된 넘겨받은 내용도 떼고 잇는다', () => {
    const carry = buildCarry(
      { carry: '[앞 대화에서 이어져요] 예전 안내\n요약:\n- 국밥' } as never,
      undefined,
      [],
    )
    expect(carry).toContain('Earlier conversation:\n요약:\n- 국밥')
    expect(carry).not.toContain('예전 안내')
  })
})

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
    timeLine: () => undefined,
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
    // The tool server learns its segment, so the daemon keeps the tool list fixed for it (ADR 0032)
    expect(rt.inputs[0]?.mcpServers[0]?.env).toEqual({ DOOL2_TOOLSET: t.id })
  })

  it('gives each thread its own tool server settings, such as the kind of session (ADR 0038)', async () => {
    const store = new Store(':memory:')
    const rt = new FakeRuntime([{ type: 'done', resumeId: 's1', text: 'ok' }])
    const svc = new ThreadService({
      timeLine: () => undefined,
      store,
      runtimes: { claude: rt },
      workspaceDir: '/tmp/ws',
      mcpServers: [{ name: 'dool2', command: 'node', args: ['mcp.js'], env: { DOOL2_API: 'x' } }],
      toolEnv: (id) => (id === talk.id ? { DOOL2_SESSION: 'conversation' } : undefined),
    })
    const talk = store.createThread('claude')
    const other = store.createThread('claude')
    await collect(svc.send(talk.id, 'hi'))
    await collect(svc.send(other.id, 'hi'))
    expect(rt.inputs[0]?.mcpServers[0]?.env).toEqual({
      DOOL2_API: 'x',
      DOOL2_SESSION: 'conversation',
      DOOL2_TOOLSET: talk.id,
    })
    expect(rt.inputs[1]?.mcpServers[0]?.env).toEqual({ DOOL2_API: 'x', DOOL2_TOOLSET: other.id })
  })

  it('덧붙인 배경(aside)은 AI에게만 가고 기록에는 내 말만 남는다', async () => {
    const { store, rt, svc } = setup([{ type: 'done', resumeId: 's1', text: '내일 오전에 와요' }])
    const t = store.createThread('claude')
    await collect(
      svc.send(t.id, '러닝화 언제 온다고?', { aside: '[두리 앱 알림] 먼저 알린 것: 러닝화 내일 도착' }),
    )
    expect(rt.inputs[0]?.text).toBe('[두리 앱 알림] 먼저 알린 것: 러닝화 내일 도착\n\n러닝화 언제 온다고?')
    expect(store.listMessages(t.id)[0]?.text).toBe('러닝화 언제 온다고?')
  })

  it('도구 앞 혼잣말은 답에 넣지 않고 마지막 말만 저장한다', async () => {
    const { store, svc } = setup([
      { type: 'text', delta: 'No skill; go to SRT site directly.' },
      { type: 'tool', name: 'mcp__dool2__browser_open', input: {} },
      { type: 'tool_result', ok: true, name: 'mcp__dool2__browser_open' },
      { type: 'text', delta: '날짜를 내일로 맞췄어요.' },
      { type: 'tool', name: 'mcp__dool2__browser_click', input: {} },
      { type: 'text', delta: '05:47 열차에 자리가 있어요.' },
      { type: 'done', text: '05:47 열차에 자리가 있어요.' },
    ])
    const t = store.createThread('claude')
    await collect(svc.send(t.id, '기차 찾아 줘'))
    // 웹에서 일했으니 답 바로 앞에 일한 과정 기록이 남는다
    const rows = store.listMessages(t.id).filter((m) => !m.text.includes('"kind":"work"'))
    expect(rows.map((m) => [m.role, m.text])).toEqual([
      ['user', '기차 찾아 줘'],
      ['assistant', '05:47 열차에 자리가 있어요.'],
    ])
  })

  it('마지막이 도구로 끝나 말이 없으면 CLI가 준 마지막 글을 쓴다', async () => {
    const { store, svc } = setup([
      { type: 'text', delta: '열어 볼게요.' },
      { type: 'tool', name: 'mcp__dool2__browser_open', input: {} },
      { type: 'done', text: '열어 뒀어요.' },
    ])
    const t = store.createThread('claude')
    await collect(svc.send(t.id, '열어 줘'))
    expect(store.listMessages(t.id).at(-1)?.text).toBe('열어 뒀어요.')
  })

  it('답은 done이 오자마자 저장한다 (CLI 끝 정리를 기다리지 않는다)', async () => {
    const store = new Store(':memory:')
    let exited = false
    const rt: AgentRuntime = {
      id: 'claude',
      detect: async () => ({ id: 'claude', installed: true, loggedIn: true }),
      async *runTurn() {
        yield { type: 'text', delta: '네' } as AgentEvent
        yield { type: 'done', resumeId: 's2', text: '네' } as AgentEvent
        // 공식 CLI가 끝 정리를 하는 동안
        await new Promise((r) => setTimeout(r, 30))
        exited = true
      },
    }
    const svc = new ThreadService({
      timeLine: () => undefined,
      store,
      runtimes: { claude: rt },
      workspaceDir: '/tmp/ws',
      mcpServers: [],
    })
    const t = store.createThread('claude')
    let savedBeforeExit = false
    for await (const ev of svc.send(t.id, '응')) {
      if (ev.type === 'saved' && ev.message.role === 'assistant') savedBeforeExit = !exited
    }
    expect(savedBeforeExit).toBe(true)
    expect(store.listMessages(t.id).filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(store.getThread(t.id)?.resumeId).toBe('s2')
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

  it('show_cards 카드는 다듬어서(http는 https로, 이상한 주소는 빼고) 답 바로 아래에 남긴다', async () => {
    const { store, svc } = setup([
      {
        type: 'tool',
        name: 'mcp__dool2__show_cards',
        input: {
          cards: [
            {
              title: '고메 돈카츠',
              price: '9,880원',
              image: 'https://img.example.com/a.jpg',
              url: 'https://shop.example/1',
            },
            { title: '나쁜 주소', image: 'javascript:alert(1)', url: 'http://shop.example/2' },
            { price: '이름 없음' },
          ],
        },
      },
      { type: 'text', delta: '돈카츠가 가장 무난해요.' },
      { type: 'done', resumeId: 's1', text: '돈카츠가 가장 무난해요.' },
    ])
    const t = store.createThread('claude')
    await collect(svc.send(t.id, '추천해 줘'))
    const msgs = store.listMessages(t.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(JSON.parse(msgs[2]?.text ?? '{}')).toEqual({
      kind: 'cards',
      cards: [
        {
          title: '고메 돈카츠',
          price: '9,880원',
          image: 'https://img.example.com/a.jpg',
          url: 'https://shop.example/1',
        },
        { title: '나쁜 주소', url: 'https://shop.example/2' },
      ],
    })
  })

  it('결과 블록(show_list·show_result·show_draft)은 다듬어 답 바로 아래에, 답 하나에 하나만(마지막 것)', async () => {
    const { store, svc } = setup([
      {
        type: 'tool',
        name: 'mcp__dool2__show_list',
        input: { lead: 'date', rows: [{ title: '겨울방학', date: '2027-01-07' }] },
      },
      {
        type: 'tool',
        name: 'mcp__dool2__show_result',
        input: {
          title: '예약 확정',
          done: true,
          big: '11/21(토) 19:00',
          facts: [{ label: '예약번호', value: 'CT-1', code: true }],
          actions: [{ label: '결제하기' }, { label: '캘린더에 넣기' }],
        },
      },
      { type: 'done', resumeId: 's1', text: '예약했어요.' },
    ])
    const t = store.createThread('claude')
    await collect(svc.send(t.id, '예약해 줘'))
    const msgs = store.listMessages(t.id).filter((m) => !m.text.includes('"kind":"work"'))
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(JSON.parse(msgs[2]?.text ?? '{}')).toEqual({
      kind: 'result',
      title: '예약 확정',
      done: true,
      big: '11/21(토) 19:00',
      facts: [{ label: '예약번호', value: 'CT-1', code: true }],
      actions: [{ label: '캘린더에 넣기', ask: '캘린더에 넣기' }],
    })
  })

  it('보낼 글 블록과 빠른 답이 같이 오면 답 → 블록 → 빠른 답 순으로', async () => {
    const said = '이렇게 보낼까요?\n[[답: 이대로 보내 줘 | 더 짧게]]'
    const { store, svc } = setup([
      {
        type: 'tool',
        name: 'mcp__dool2__show_draft',
        input: { to: '집주인', via: 'sms', text: '보일러가 고장 났어요.' },
      },
      { type: 'done', resumeId: 's1', text: said },
    ])
    const t = store.createThread('claude')
    await collect(svc.send(t.id, '문자 써 줘'))
    const msgs = store.listMessages(t.id).filter((m) => !m.text.includes('"kind":"work"'))
    expect(msgs.map((m) => (m.role === 'tool' ? JSON.parse(m.text).kind : m.role))).toEqual([
      'user',
      'assistant',
      'draft',
      'quick',
    ])
  })

  it('답 끝 [[답: …]] 줄은 떼어 답 아래 빠른 답 기록으로 남긴다', async () => {
    const said =
      '화요일 10시·목요일 3시가 비어 있어요. 어떻게 할까요?\n[[답: 화요일 10시로 | 목요일 3시로 | 다른 날 볼래]]'
    const { store, svc } = setup([
      { type: 'text', delta: said },
      { type: 'done', resumeId: 's1', text: said },
    ])
    const t = store.createThread('claude')
    await collect(svc.send(t.id, '치과 예약 미뤄 줘'))
    const msgs = store.listMessages(t.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(msgs[1]?.text).toBe('화요일 10시·목요일 3시가 비어 있어요. 어떻게 할까요?')
    expect(JSON.parse(msgs[2]?.text ?? '{}')).toEqual({
      kind: 'quick',
      replies: ['화요일 10시로', '목요일 3시로', '다른 날 볼래'],
    })
  })

  it('빠른 답이 하나뿐이면 줄만 지우고 버튼은 남기지 않는다', async () => {
    const { store, svc } = setup([{ type: 'done', resumeId: 's1', text: '이걸로 할까요?\n[[답: 좋아요]]' }])
    const t = store.createThread('claude')
    await collect(svc.send(t.id, '골라 줘'))
    const msgs = store.listMessages(t.id)
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ['user', '골라 줘'],
      ['assistant', '이걸로 할까요?'],
    ])
  })

  it('세로 포스터 묶음(shape: portrait)은 기록에 남긴다', async () => {
    const { store, svc } = setup([
      {
        type: 'tool',
        name: 'mcp__dool2__show_cards',
        input: { shape: 'portrait', cards: [{ title: '폭설', image: 'https://img.example.com/p.jpg' }] },
      },
      { type: 'done', resumeId: 's1', text: '폭설이 좋아요.' },
    ])
    const t = store.createThread('claude')
    await collect(svc.send(t.id, '영화 추천'))
    const rec = JSON.parse(store.listMessages(t.id).at(-1)?.text ?? '{}')
    expect(rec).toMatchObject({ kind: 'cards', shape: 'portrait' })
  })

  it('사람에게 넘긴 일을 기록에 남긴다', async () => {
    const { store, svc } = setup([
      // 처음 부른 건 관문에 막혀 실패 → 카드 없음, 다시 불러 넘긴 것만 남는다
      { type: 'tool', name: 'mcp__dool2__browser_handoff', input: { tabId: 4, reason: '휴대폰번호' } },
      { type: 'tool_result', ok: false, name: 'mcp__dool2__browser_handoff' },
      { type: 'tool', name: 'mcp__dool2__browser_handoff', input: { tabId: 4, reason: '로그인해 주세요' } },
      { type: 'tool_result', ok: true, name: 'mcp__dool2__browser_handoff' },
      { type: 'text', delta: '로그인만 해 주세요' },
      { type: 'done', text: '로그인만 해 주세요' },
    ])
    const t = store.createThread('claude')
    await collect(svc.send(t.id, '주문 내역 봐 줘'))
    const rows = store.listMessages(t.id).filter((m) => !m.text.includes('"kind":"work"'))
    expect(rows.map((m) => [m.role, m.text])).toEqual([
      ['user', '주문 내역 봐 줘'],
      // 카드는 답 글 아래에
      ['assistant', '로그인만 해 주세요'],
      ['tool', JSON.stringify({ kind: 'handoff', tabId: 4, reason: '로그인해 주세요' })],
    ])
  })

  it('PC 파일 승인(여러 개 옮기기·출력)은 도구가 성공했을 때만 승인 카드를 남긴다', async () => {
    const moves = [
      { from: '~/Downloads/a.pdf', folder: '~/Downloads/영수증' },
      { from: '~/Downloads/b.pdf', folder: '~/Downloads/계약서' },
    ]
    const { store, svc } = setup([
      { type: 'tool', name: 'mcp__dool2__file_move', input: { moves } },
      { type: 'tool_result', ok: true, name: 'mcp__dool2__file_move' },
      // 하나만 옮기기는 바로 해서 승인이 없다
      { type: 'tool', name: 'mcp__dool2__file_move', input: { moves: moves.slice(0, 1) } },
      { type: 'tool_result', ok: true, name: 'mcp__dool2__file_move' },
      // 프린터가 없어 실패한 출력은 카드가 없다
      { type: 'tool', name: 'mcp__dool2__file_print', input: { path: '~/Downloads/학습지.pdf' } },
      { type: 'tool_result', ok: false, name: 'mcp__dool2__file_print' },
      { type: 'done', text: '옮길 목록을 승인해 주세요' },
    ])
    const t = store.createThread('claude')
    await collect(svc.send(t.id, '다운로드 PDF 나눠 줘'))
    const recs = store
      .listMessages(t.id)
      .filter((m) => m.role === 'tool' && m.text.includes('"kind":"approval"'))
      .map((m) => JSON.parse(m.text))
    expect(recs).toEqual([{ kind: 'approval', tabId: -2, ref: 'file_move', what: '파일 2개 옮기기' }])
  })
})

describe('일한 과정 기록 (WorkLog)', () => {
  it('혼잣말 한 줄, 없으면 도구 이름으로 단계를 쌓고 걸린 시간을 잰다', () => {
    let t = 1000
    const log = new WorkLog(() => t)
    t = 1500
    log.tool('mcp__dool2__browser_open', '캐치테이블을 열어 볼게요.', {
      url: 'https://app.catchtable.co.kr/x',
    })
    t = 4500
    log.tool('mcp__dool2__browser_read', '')
    t = 4600
    log.tool('mcp__dool2__browser_read', '')
    t = 9500
    expect(log.record()).toEqual({
      kind: 'work',
      steps: [
        {
          text: '캐치테이블을 열어 볼게요.',
          act: '웹페이지 여는 중',
          place: 'app.catchtable.co.kr',
          ms: 3000,
        },
        { text: '페이지 읽는 중', act: '페이지 읽는 중', place: 'app.catchtable.co.kr', ms: 5000 },
      ],
      count: 2,
      ms: 8500,
      host: 'app.catchtable.co.kr',
    })
  })

  it('탭 번호만 받은 웹 도구는 그 탭의 사이트로 묶는다', () => {
    const tabs: Record<number, string> = { 7: 'search.naver.com', 9: 'www.sparkplus.co.kr' }
    const log = new WorkLog(Date.now, (id) => tabs[id])
    log.tool('mcp__dool2__browser_open', '', { url: 'https://search.naver.com/?q=1' })
    log.tool('mcp__dool2__browser_open', '', { url: 'https://www.sparkplus.co.kr/' })
    log.tool('mcp__dool2__browser_click', '', { tabId: 7, ref: 'e1' })
    log.tool('mcp__dool2__browser_read', '', { tabId: 9 })
    expect(log.record()?.steps.map((s) => s.place)).toEqual([
      'search.naver.com',
      'www.sparkplus.co.kr',
      'search.naver.com',
      'www.sparkplus.co.kr',
    ])
  })

  it('기억·목표 같은 속일만 했으면 남기지 않는다', () => {
    const log = new WorkLog()
    log.tool('mcp__dool2__memory_save', '')
    log.tool('mcp__dool2__status', '')
    expect(log.record()).toBeUndefined()
  })

  it('웹에서 일한 차례는 답 바로 앞에 기록이 남는다', async () => {
    const { store, svc } = setup([
      { type: 'text', delta: '찾아볼게요.' },
      { type: 'tool', name: 'mcp__dool2__browser_open', input: { url: 'https://example.com' } },
      { type: 'text', delta: '세 곳을 찾았어요.' },
      { type: 'done', text: '세 곳을 찾았어요.' },
    ])
    const th = store.createThread('claude')
    await collect(svc.send(th.id, '찾아 줘'))
    const msgs = store.listMessages(th.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'tool', 'assistant'])
    expect(JSON.parse(msgs[1]?.text ?? '')).toMatchObject({ kind: 'work', count: 1, host: 'example.com' })
  })
})

describe('pinned instructions (ADR 0032)', () => {
  const done: AgentEvent[] = [
    { type: 'started', resumeId: 's1', tools: [] },
    { type: 'done', resumeId: 's1', text: 'ok' },
  ]
  function pinnedSetup() {
    const store = new Store(':memory:')
    const rt = new FakeRuntime(done)
    let memory = '## What you remember\n- likes gukbap'
    const svc = new ThreadService({
      timeLine: () => undefined,
      store,
      runtimes: { claude: rt },
      workspaceDir: '/tmp/ws',
      mcpServers: [],
      systemPrompt: () => `You are Dool2.\n\n## Rules\n- be kind\n\n${memory}`,
    })
    const setMemory = (m: string) => {
      memory = m
    }
    return { store, rt, svc, setMemory }
  }

  it('keeps the instructions of the segment and sends a changed section once, on the next message', async () => {
    const { store, rt, svc, setMemory } = pinnedSetup()
    const t = store.createThread('claude')
    await collect(svc.send(t.id, 'hi'))
    const first = rt.inputs[0]?.systemPrompt
    setMemory('## What you remember\n- likes gukbap\n- lives in Seongsu')
    await collect(svc.send(t.id, 'next'))
    await collect(svc.send(t.id, 'again'))
    // The instructions stay byte-identical, so the provider's cache keeps the conversation
    expect(rt.inputs.map((i) => i.systemPrompt)).toEqual([first, first, first])
    // The change rides on the next message only, and only the changed section
    expect(rt.inputs[1]?.text).toContain('Update to your instructions')
    expect(rt.inputs[1]?.text).toContain('- lives in Seongsu')
    expect(rt.inputs[1]?.text).not.toContain('be kind')
    expect(rt.inputs[2]?.text).not.toContain('Update to your instructions')
  })

  it('a new segment pins a fresh copy', async () => {
    const { store, rt, svc, setMemory } = pinnedSetup()
    const a = store.createThread('claude')
    await collect(svc.send(a.id, 'hi'))
    setMemory('## What you remember\n- likes naengmyeon')
    const b = store.createThread('claude')
    await collect(svc.send(b.id, 'hi'))
    expect(rt.inputs[1]?.systemPrompt).toContain('likes naengmyeon')
    expect(rt.inputs[1]?.text).not.toContain('Update to your instructions')
  })
})

describe('cache record', () => {
  it('reports the gap since the previous turn of the same thread (none on the first turn)', async () => {
    const store = new Store(':memory:')
    const rt = new FakeRuntime([
      { type: 'started', resumeId: 's1', tools: [] },
      { type: 'context', tokens: 1000, firstInput: 1000, firstCached: 900 },
      { type: 'done', resumeId: 's1', text: 'ok' },
    ])
    const seen: { input: number; cached: number; gapMs?: number }[] = []
    const svc = new ThreadService({
      timeLine: () => undefined,
      store,
      runtimes: { claude: rt },
      workspaceDir: '/tmp/ws',
      mcpServers: [],
      onCache: (_id, x) => seen.push(x),
    })
    const t = store.createThread('claude')
    await collect(svc.send(t.id, 'hi'))
    await new Promise((r) => setTimeout(r, 20))
    await collect(svc.send(t.id, 'next'))
    expect(seen[0]?.gapMs).toBeUndefined()
    expect(seen[1]?.gapMs).toBeGreaterThanOrEqual(15)
    expect(seen[1]?.gapMs).toBeLessThan(5000)
  })

  it('after a restart, the last message time stands in for the previous turn', async () => {
    const store = new Store(':memory:')
    const t = store.createThread('claude')
    store.addMessage(t.id, 'user', 'earlier')
    const rt = new FakeRuntime([
      { type: 'context', tokens: 1000, firstInput: 1000, firstCached: 0 },
      { type: 'done', text: 'ok' },
    ])
    const seen: { gapMs?: number }[] = []
    const svc = new ThreadService({
      timeLine: () => undefined,
      store,
      runtimes: { claude: rt },
      workspaceDir: '/tmp/ws',
      mcpServers: [],
      onCache: (_id, x) => seen.push(x),
    })
    await collect(svc.send(t.id, 'hi'))
    expect(typeof seen[0]?.gapMs).toBe('number')
  })
})

describe('resident sessions (ADR 0035)', () => {
  class FakeSession implements AgentSession {
    sent: string[] = []
    signals: (AbortSignal | undefined)[] = []
    closed = false
    get alive() {
      return !this.closed
    }
    async *send(text: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
      this.sent.push(text)
      this.signals.push(signal)
      yield { type: 'started', resumeId: 'r1', tools: [] }
      yield { type: 'text', delta: `got ${text}` }
      yield { type: 'done', resumeId: 'r1', text: `got ${text}` }
    }
    interrupt() {}
    async close() {
      this.closed = true
    }
  }
  class SessionRuntime extends FakeRuntime {
    opened: SessionInput[] = []
    sessions: FakeSession[] = []
    async openSession(input: SessionInput) {
      this.opened.push(input)
      const s = new FakeSession()
      this.sessions.push(s)
      return s
    }
  }
  function residentSetup(o: { resident?: boolean; idleMs?: number } = {}) {
    const store = new Store(':memory:')
    const rt = new SessionRuntime([{ type: 'done', resumeId: 'r1', text: '- summary' }])
    let resident = o.resident ?? true
    let runs = 0
    const svc = new ThreadService({
      timeLine: () => undefined,
      store,
      runtimes: { claude: rt },
      workspaceDir: '/tmp/ws',
      mcpServers: [{ name: 'dool2', command: 'node', args: ['mcp.js'] }],
      resident: () => resident,
      beforeRun: () => {
        runs++
      },
      ...(o.idleMs ? { residentIdleMs: o.idleMs } : {}),
    })
    return {
      store,
      rt,
      svc,
      runs: () => runs,
      setResident: (v: boolean) => {
        resident = v
      },
    }
  }

  it('sends every message of the segment to one program, opened once', async () => {
    const { store, rt, svc, runs } = residentSetup()
    const t = store.createThread('claude')
    await collect(svc.send(t.id, 'hi'))
    await collect(svc.send(t.id, 'again'))
    expect(rt.opened).toHaveLength(1)
    expect(rt.inputs).toHaveLength(0)
    expect(rt.sessions[0]?.sent).toEqual(['hi', 'again'])
    expect(store.listMessages(t.id).map((m) => m.text)).toEqual(['hi', 'got hi', 'again', 'got again'])
    expect(store.getThread(t.id)?.resumeId).toBe('r1')
    // The tool list file is written when the program starts, not for every message
    expect(runs()).toBe(1)
    expect(rt.opened[0]?.mcpServers[0]?.env?.DOOL2_TOOLSET).toBe(t.id)
  })

  it('stop reaches the session as its abort signal', async () => {
    const { store, rt, svc } = residentSetup()
    const t = store.createThread('claude')
    const it = svc.send(t.id, 'long job')
    for await (const ev of it) if (ev.type === 'agent' && ev.event.type === 'started') svc.cancel(t.id)
    expect(rt.sessions[0]?.signals[0]?.aborted).toBe(true)
    expect(rt.sessions[0]?.closed).toBe(false)
  })

  it('closes the program after a long idle and opens it again with the session id on the next message', async () => {
    const { store, rt, svc } = residentSetup({ idleMs: 10 })
    const t = store.createThread('claude')
    await collect(svc.send(t.id, 'hi'))
    expect(svc.hasSession(t.id)).toBe(true)
    await new Promise((r) => setTimeout(r, 40))
    expect(svc.hasSession(t.id)).toBe(false)
    expect(rt.sessions[0]?.closed).toBe(true)
    await collect(svc.send(t.id, 'back'))
    expect(rt.opened).toHaveLength(2)
    expect(rt.opened[1]?.resumeId).toBe('r1')
  })

  it('a thread that is not resident runs one program per turn and lets go of its session', async () => {
    const { store, rt, svc, setResident } = residentSetup()
    const t = store.createThread('claude')
    await collect(svc.send(t.id, 'hi'))
    setResident(false)
    await collect(svc.send(t.id, 'side'))
    expect(rt.sessions[0]?.closed).toBe(true)
    expect(rt.inputs).toHaveLength(1)
  })

  it('a summary runs in a copy of the session, outside the resident program', async () => {
    const { store, rt, svc } = residentSetup()
    const t = store.createThread('claude')
    await collect(svc.send(t.id, 'hi'))
    expect(await svc.summarize(t.id)).toBe('- summary')
    expect(rt.inputs[0]).toMatchObject({ resumeId: 'r1', fork: true })
    expect(rt.sessions[0]?.sent).toEqual(['hi'])
  })

  it('release ends the program (segment closed)', async () => {
    const { store, rt, svc } = residentSetup()
    const t = store.createThread('claude')
    await collect(svc.send(t.id, 'hi'))
    await svc.release(t.id)
    expect(rt.sessions[0]?.closed).toBe(true)
    expect(svc.hasSession(t.id)).toBe(false)
  })
})

describe('tool_call unwrapping (ADR 0033)', () => {
  it('treats a tool run through tool_call as the tool itself, result included', async () => {
    const { unwrapToolCall } = await import('./threads.js')
    const ev = unwrapToolCall({
      type: 'tool',
      name: 'mcp__dool2__tool_call',
      input: { tool: 'file_move', input: { moves: [{}, {}] } },
    })
    expect(ev).toEqual({ type: 'tool', name: 'mcp__dool2__file_move', input: { moves: [{}, {}] } })
    expect(
      unwrapToolCall(
        { type: 'tool_result', name: 'mcp__dool2__tool_call', ok: true },
        'mcp__dool2__file_move',
      ),
    ).toEqual({
      type: 'tool_result',
      name: 'mcp__dool2__file_move',
      ok: true,
    })
    // other tools pass through
    expect(unwrapToolCall({ type: 'tool', name: 'mcp__dool2__browser_click', input: {} })).toMatchObject({
      name: 'mcp__dool2__browser_click',
    })
  })
})
