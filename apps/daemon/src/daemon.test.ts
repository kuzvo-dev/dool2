import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ClaudeLogin } from '@dool2/agent-claude'
import type { AgentRuntime, TurnInput } from '@dool2/engine'
import type { AgentEvent, AgentStatus, DaemonStreamEvent } from '@dool2/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { type Daemon, defaultDataDir, startDaemon } from './index.js'

class EchoRuntime implements AgentRuntime {
  readonly id = 'claude' as const
  last?: TurnInput
  async detect(): Promise<AgentStatus> {
    return { id: 'claude', installed: true, loggedIn: true, version: '9.9.9' }
  }
  async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
    this.last = input
    yield { type: 'started', resumeId: 'r1', tools: ['mcp__dool2__status'] }
    yield { type: 'text', delta: `받았어요: ${input.text}` }
    yield { type: 'done', resumeId: 'r1', text: `받았어요: ${input.text}` }
  }
}

let daemon: Daemon | undefined
let dir: string | undefined
afterEach(async () => {
  await daemon?.close()
  daemon = undefined
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

/** 열어 줄 때까지 답을 끝내지 않는 AI (줄 세우기 시험용) */
class GateRuntime extends EchoRuntime {
  inputs: string[] = []
  private open: (() => void)[] = []
  release() {
    for (const f of this.open.splice(0)) f()
  }
  override async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
    this.inputs.push(input.text)
    await new Promise<void>((r) => this.open.push(r))
    yield* super.runTurn(input)
  }
}

async function boot(
  rt: EchoRuntime = new EchoRuntime(),
  more: Partial<Parameters<typeof startDaemon>[0]> = {},
) {
  dir = await mkdtemp(join(tmpdir(), 'dool2-test-'))
  daemon = await startDaemon({
    timeLine: () => undefined,
    dataDir: dir,
    token: 't0ken',
    runtimes: { claude: rt },
    chrome: { detect: async () => ({ installed: true, version: '157.0.8103.79' }) },
    // Tests never ask an AI company about a key, or OpenRouter for prices
    checkKey: async () => 'ok',
    paygPrices: async () => new Map(),
    ...more,
  })
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${daemon?.url}${path}`, {
      ...init,
      headers: { authorization: 'Bearer t0ken', 'content-type': 'application/json', ...init.headers },
    })
  return { rt, api }
}

async function readSse(res: Response): Promise<DaemonStreamEvent[]> {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)) as DaemonStreamEvent)
}

describe('dool2d 로컬 API', () => {
  it('토큰이 없으면 거절한다', async () => {
    await boot()
    const res = await fetch(`${daemon?.url}/api/health`)
    expect(res.status).toBe(401)
  })

  it('127.0.0.1에서만 받는다', async () => {
    await boot()
    expect(daemon?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('AI 상태를 알려 준다', async () => {
    const { api } = await boot()
    const body = (await (await api('/api/agents')).json()) as { agents: AgentStatus[] }
    expect(body.agents).toEqual([{ id: 'claude', installed: true, loggedIn: true, version: '9.9.9' }])
  })

  it('대화를 만들고, 보내고, 기록을 돌려준다', async () => {
    const { api, rt } = await boot()
    const { thread } = (await (
      await api('/api/threads', { method: 'POST', body: '{"agent":"claude"}' })
    ).json()) as {
      thread: { id: string }
    }
    const res = await api(`/api/threads/${thread.id}/messages`, { method: 'POST', body: '{"text":"안녕"}' })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const events = await readSse(res)
    expect(events.at(-1)).toEqual({ type: 'end' })
    expect(events.filter((e) => e.type === 'saved')).toHaveLength(2)

    const detail = (await (await api(`/api/threads/${thread.id}`)).json()) as {
      messages: { role: string; text: string }[]
    }
    expect(detail.messages.map((m) => m.text)).toEqual(['안녕', '받았어요: 안녕'])
    // 홈의 맡긴 일 카드: 목록에 마지막 답 미리보기가 같이 온다 (답하는 중이 아니면 busy는 없다)
    const list = (await (await api('/api/threads')).json()) as {
      threads: { id: string; preview?: string; busy?: boolean }[]
    }
    expect(list.threads[0]).toMatchObject({ id: thread.id, preview: '받았어요: 안녕' })
    expect(list.threads[0]?.busy).toBeUndefined()
    expect(rt.last?.mcpServers[0]?.name).toBe('dool2')
    expect(rt.last?.cwd).toBe(join(dir as string, 'workspace'))
  })

  it('writes the service tool list before the agent starts, for the tool server to read at once', async () => {
    const { api, rt } = await boot()
    const { thread } = (await (
      await api('/api/threads', { method: 'POST', body: '{"agent":"claude"}' })
    ).json()) as { thread: { id: string } }
    await readSse(await api(`/api/threads/${thread.id}/messages`, { method: 'POST', body: '{"text":"hi"}' }))
    const env = rt.last?.mcpServers[0]?.env
    expect(env?.DOOL2_SERVICE_TOOLS).toBe(join(dir as string, 'service-tools'))
    // One file per segment, named by the segment id the tool server gets as DOOL2_TOOLSET
    expect(env?.DOOL2_TOOLSET).toBe(thread.id)
    const { readFile } = await import('node:fs/promises')
    const file = join(dir as string, 'service-tools', `${thread.id}.json`)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ tools: expect.any(Array) })
  })

  it('지원하지 않는 AI로는 대화를 만들지 않는다', async () => {
    const { api } = await boot()
    const res = await api('/api/threads', { method: 'POST', body: '{"agent":"codex"}' })
    expect(res.status).toBe(400)
  })

  it('일하는 동안 busy를 알린다', async () => {
    const { api } = await boot()
    const seen: boolean[] = []
    daemon?.events.on('busy', (b) => seen.push(b))
    const { thread } = (await (
      await api('/api/threads', { method: 'POST', body: '{"agent":"claude"}' })
    ).json()) as { thread: { id: string } }
    await readSse(
      await api(`/api/threads/${thread.id}/messages`, { method: 'POST', body: '{"text":"안녕"}' }),
    )
    expect(seen).toEqual([true, false])
    expect(daemon?.busy).toBe(false)
  })

  it('빈 글은 받지 않는다', async () => {
    const { api } = await boot()
    const { thread } = (await (
      await api('/api/threads', { method: 'POST', body: '{"agent":"claude"}' })
    ).json()) as {
      thread: { id: string }
    }
    const res = await api(`/api/threads/${thread.id}/messages`, { method: 'POST', body: '{"text":"   "}' })
    expect(res.status).toBe(400)
  })

  it('PC 화면의 따로 하는 대화: 기본 AI로 만들고, 메인 대화에 섞지 않고, 지울 수 있다', async () => {
    const { api } = await boot()
    const { thread } = (await (
      await api('/api/threads', { method: 'POST', body: '{"side":true}' })
    ).json()) as {
      thread: { id: string; agent: string; side?: boolean }
    }
    expect(thread).toMatchObject({ agent: 'claude', side: true })
    await readSse(
      await api(`/api/threads/${thread.id}/messages`, { method: 'POST', body: '{"text":"여행"}' }),
    )
    const conv = (await (await api('/api/conversation')).json()) as { messages: unknown[] }
    expect(conv.messages).toHaveLength(0)
    const list = (await (await api('/api/threads')).json()) as { threads: { id: string; side?: boolean }[] }
    expect(list.threads.find((t) => t.id === thread.id)?.side).toBe(true)
    expect((await api(`/api/threads/${thread.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await api(`/api/threads/${thread.id}`)).status).toBe(404)
  })

  it('메인 대화의 구간은 지우지 않는다', async () => {
    const { api } = await boot()
    const { thread } = (await (
      await api('/api/threads', { method: 'POST', body: '{"agent":"claude"}' })
    ).json()) as { thread: { id: string } }
    expect((await api(`/api/threads/${thread.id}`, { method: 'DELETE' })).status).toBe(400)
  })
})

describe('답 속 파일 링크 열기 (/api/files/open)', () => {
  it('사용자 폴더 안 파일은 PC 앱에 열라고 넘기고, 실행 파일은 폴더에서 보여 주고, 밖은 막는다', async () => {
    const docs = await mkdtemp(join(tmpdir(), 'dool2-docs-'))
    const outside = await mkdtemp(join(tmpdir(), 'dool2-out-'))
    writeFileSync(join(docs, '초대장.png'), 'x')
    writeFileSync(join(docs, '설치.dmg'), 'x')
    writeFileSync(join(docs, 'id_rsa'), 'x')
    writeFileSync(join(outside, '남의.txt'), 'x')
    const opened: [string, string][] = []
    const { api } = await boot(undefined, {
      fileFolders: { desktop: [], documents: [docs], downloads: [] },
      openFile: async (p, how) => {
        opened.push([p, how])
        return undefined
      },
    })
    const open = async (path: string, reveal?: boolean) =>
      api('/api/files/open', {
        method: 'POST',
        body: JSON.stringify({ path, ...(reveal ? { reveal } : {}) }),
      })
    expect((await open(join(docs, '초대장.png'))).status).toBe(200)
    expect((await open(join(docs, '초대장.png'), true)).status).toBe(200)
    expect(await (await open(join(docs, '설치.dmg'))).json()).toEqual({ ok: true, how: 'reveal' })
    expect((await open(join(outside, '남의.txt'))).status).toBe(404)
    expect((await open(join(docs, 'id_rsa'))).status).toBe(404)
    expect((await open(join(docs, '없음.png'))).status).toBe(404)
    expect(opened.map(([p, how]) => [p.split(/[\\/]/).at(-1), how])).toEqual([
      ['초대장.png', 'open'],
      ['초대장.png', 'reveal'],
      ['설치.dmg', 'reveal'],
    ])
    await rm(docs, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
})

describe('대화 하나 (ADR 0015)', () => {
  type State = { messages: { role: string; text: string }[]; busy: boolean; queued: string[] }
  const until = async (f: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await f()) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('기다리다 지쳤어요')
  }

  it('말을 보내면 대화에 이어 쌓이고, 화면은 live로 진행을 받는다', async () => {
    const { api } = await boot()
    const live = await api('/api/conversation/live')
    const reader = live.body?.getReader()
    const r = await api('/api/conversation/messages', { method: 'POST', body: '{"text":"안녕"}' })
    expect(r.status).toBe(202)
    expect(await r.json()).toEqual({ queued: false })
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await until(async () => (await state()).messages.length === 2 && !(await state()).busy)
    expect((await state()).messages.map((m) => m.text)).toEqual(['안녕', '받았어요: 안녕'])
    // live: 일하는 중 → 차례 진행 → 끝
    let seen = ''
    const dec = new TextDecoder()
    while (!seen.includes('"type":"end"')) seen += dec.decode((await reader?.read())?.value)
    expect(seen).toContain('"kind":"turn"')
    await reader?.cancel()
  })

  it('도구 서버는 지난 대화를 찾을 수 있다 (도구 토큰으로만)', async () => {
    const { api, rt } = await boot()
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"청소기 찾아 줘"}' })
    await until(async () => (await state()).messages.length === 2 && !(await state()).busy)
    const toolToken = rt.last?.mcpServers[0]?.env?.DOOL2_TOOL_TOKEN
    expect(toolToken).toBeTruthy()
    const search = (token: string) =>
      fetch(`${daemon?.url}/api/tools/life/conversation_search`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: '청소기' }),
      })
    expect((await search('t0ken')).status).toBe(401)
    // 지금 구간의 말은 AI가 이미 알고 있어서 빼고 찾는다
    const r = (await (await search(toolToken ?? '')).json()) as { content: { text: string }[] }
    expect(r.content[0]?.text).toContain('No past conversation found')
  })

  it('records tool answers on a test PC and plays them back instead of running the tool', async () => {
    const { api, rt } = await boot(undefined, { devReset: true })
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"hello"}' })
    await until(async () => (await state()).messages.length === 2 && !(await state()).busy)
    const toolToken = rt.last?.mcpServers[0]?.env?.DOOL2_TOOL_TOKEN ?? ''
    const search = async (query: string) =>
      (await (
        await fetch(`${daemon?.url}/api/tools/life/conversation_search`, {
          method: 'POST',
          headers: { authorization: `Bearer ${toolToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query }),
        })
      ).json()) as { isError?: boolean; content: { text: string }[] }
    const tape = async (body: unknown) =>
      (await (
        await api('/api/eval/tape', { method: 'POST', body: JSON.stringify({ ...(body as object) }) })
      ).json()) as {
        entries: { tool: string; input: unknown; result: { content: { text: string }[] } }[]
        replayed: { match: string }[]
        missed: { tool: string }[]
      }
    await tape({ mode: 'record' })
    const real = await search('vacuum')
    const rec = await tape({ mode: 'off' })
    expect(rec.entries).toEqual([
      { tool: 'life/conversation_search', input: { query: 'vacuum' }, result: real },
    ])
    // Replay: the tape answers, the tool does not run
    const entries = rec.entries.map((e) => ({
      ...e,
      result: { content: [{ type: 'text', text: 'from the tape' }] },
    }))
    await tape({ mode: 'replay', entries })
    expect((await search('vacuum')).content[0]?.text).toBe('from the tape')
    expect((await search('robot vacuum')).content[0]?.text).toBe('from the tape') // search words may differ
    const report = await tape({ mode: 'off' })
    expect(report.replayed.map((x) => x.match)).toEqual(['exact', 'loose'])
    // After the test the real tool runs again
    expect((await search('vacuum')).content[0]?.text).toContain('No past conversation found')
  })

  it('evals pick the model of the next requests on a test PC only (ADR 0037)', async () => {
    const { api, rt } = await boot(undefined, { devReset: true })
    const state = async () => (await (await api('/api/conversation')).json()) as State
    const r = await api('/api/eval/model', { method: 'POST', body: '{"model":"haiku"}' })
    expect(await r.json()).toEqual({ ok: true, model: 'haiku' })
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"hello"}' })
    await until(async () => (await state()).messages.length === 2 && !(await state()).busy)
    expect(rt.last?.model).toBe('haiku')
    expect((await api('/api/eval/model', { method: 'POST', body: '{"model":"a b"}' })).status).toBe(400)
    await api('/api/eval/model', { method: 'POST', body: '{}' })
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"again"}' })
    await until(async () => (await state()).messages.length === 4 && !(await state()).busy)
    expect(rt.last?.model).toBeUndefined()
  })

  it('the eval model is closed on a normal PC', async () => {
    const { api } = await boot()
    expect((await api('/api/eval/model', { method: 'POST', body: '{"model":"haiku"}' })).status).toBe(403)
  })

  it('the tool tape is only for a test PC', async () => {
    const { api } = await boot()
    const r = await api('/api/eval/tape', { method: 'POST', body: '{"mode":"record"}' })
    expect(r.status).toBe(403)
  })

  it('a watch can use a quick check: only lookup tools, at least the service minimum, never a forged _check', async () => {
    const { api, rt } = await boot()
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"hello"}' })
    await until(async () => (await state()).messages.length === 2 && !(await state()).busy)
    const toolToken = rt.last?.mcpServers[0]?.env?.DOOL2_TOOL_TOKEN ?? ''
    const goal = async (args: Record<string, unknown>) =>
      (await (
        await fetch(`${daemon?.url}/api/tools/life/goal_create`, {
          method: 'POST',
          headers: { authorization: `Bearer ${toolToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Open tables', prompt: 'p', schedule: 'every', minutes: 1, ...args }),
        })
      ).json()) as { isError?: boolean; content: { text: string }[] }
    // A forged _check without check_tool is dropped: 1 minute is refused for a task the AI runs
    const forged = await goal({ _check: { tool: 'catchtable_search', input: {}, minMinutes: 1 } })
    expect(forged.isError).toBe(true)
    // A tool that pays is refused
    const pay = await goal({ check_tool: 'catchtable_prepare_booking' })
    expect(pay.isError).toBe(true)
    expect(pay.content[0]?.text).toContain('lookup')
    // A lookup tool works, raised to the service minimum (5 minutes for open tables)
    const ok = await goal({ check_tool: 'catchtable_search', check_input: { query: 'Seongsu' } })
    expect(ok.isError).toBeUndefined()
    const life = (await (await api('/api/life')).json()) as {
      routines: { schedule?: { minutes: number }; check?: { tool: string } }[]
    }
    expect(life.routines[0]?.check?.tool).toBe('catchtable_search')
    expect(life.routines[0]?.schedule?.minutes).toBe(5)
  })

  it('the same tool call with the same result a third time gets a loop note', async () => {
    const { api, rt } = await boot()
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"hello"}' })
    await until(async () => (await state()).messages.length === 2 && !(await state()).busy)
    const toolToken = rt.last?.mcpServers[0]?.env?.DOOL2_TOOL_TOKEN ?? ''
    const search = async (query: string) =>
      (await (
        await fetch(`${daemon?.url}/api/tools/life/conversation_search`, {
          method: 'POST',
          headers: { authorization: `Bearer ${toolToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query }),
        })
      ).json()) as { content: { text: string }[] }
    const texts = async (query: string) => (await search(query)).content.map((x) => x.text).join('\n')
    expect(await texts('vacuum')).not.toContain('Loop check')
    expect(await texts('vacuum')).not.toContain('Loop check')
    // A different input is a different call
    expect(await texts('robot vacuum')).not.toContain('Loop check')
    const third = await texts('vacuum')
    expect(third).toContain('No past conversation found')
    expect(third).toContain('Loop check: this is the 3rd call')
  })

  it('답하는 동안 보낸 말은 줄을 섰다가 한 차례로 이어서 간다', async () => {
    const rt = new GateRuntime()
    const { api } = await boot(rt)
    const send = async (text: string) =>
      (await (
        await api('/api/conversation/messages', { method: 'POST', body: JSON.stringify({ text }) })
      ).json()) as {
        queued: boolean
      }
    expect(await send('KTX 잡아줘')).toEqual({ queued: false })
    await until(async () => rt.inputs.length === 1)
    expect(await send('창가로')).toEqual({ queued: true })
    expect(await send('9시 전후')).toEqual({ queued: true })
    const state = async () => (await (await api('/api/conversation')).json()) as State
    expect((await state()).queued).toEqual(['창가로', '9시 전후'])
    rt.release()
    await until(async () => rt.inputs.length === 2)
    expect(rt.inputs[1]).toBe('창가로\n\n9시 전후')
    rt.release()
    await until(async () => !(await state()).busy && (await state()).messages.length === 4)
    expect((await state()).queued).toEqual([])
    // 두 차례 모두 같은 AI 세션으로 이어 간다
    expect(rt.last?.resumeId).toBe('r1')
  })

  it('finish check in the conversation: what is left becomes a button under the one answer, not a second reply', async () => {
    class ToolRuntime extends EchoRuntime {
      inputs: string[] = []
      override async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
        this.inputs.push(input.text)
        yield { type: 'tool', name: 'mcp__dool2__browser_open', input: {} }
        yield* super.runTurn(input)
      }
    }
    const rt = new ToolRuntime()
    const prompts: string[] = []
    const { api } = await boot(rt, {
      finishJudge: async (p) => {
        prompts.push(p)
        return '{"done":false,"why":"보험 1곳만 봤어요","next":"다른 보험사","offer":"2곳 더 비교해 줘"}'
      },
    })
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"차 보험 3곳 비교해 줘"}' })
    await until(async () => prompts.length === 1 && !(await state()).busy)
    await new Promise((r) => setTimeout(r, 50))
    // One answer: the judge is asked once and Dool2 is not sent back
    expect(rt.inputs).toHaveLength(1)
    const msgs = (await state()).messages
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1)
    const quick = msgs.filter((m) => m.role === 'tool' && m.text.includes('"kind":"quick"'))
    expect(JSON.parse(quick.at(-1)?.text ?? '{}')).toMatchObject({ replies: ['2곳 더 비교해 줘'] })
  })

  it('a claimed booking with no approval and no finished page is sent back by code, and the log says why', async () => {
    class ClaimRuntime extends EchoRuntime {
      inputs: string[] = []
      override async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
        this.inputs.push(input.text)
        yield { type: 'started', resumeId: 'r1', tools: [] }
        yield { type: 'tool', name: 'mcp__dool2__browser_click', input: {} }
        const text =
          this.inputs.length === 1 ? '내일 7시로 예약했어요.' : '아직 예약은 안 됐어요. 시간을 골라 주세요.'
        yield { type: 'text', delta: text }
        yield { type: 'done', resumeId: 'r1', text }
      }
    }
    const rt = new ClaimRuntime()
    const prompts: string[] = []
    const { api } = await boot(rt, {
      finishJudge: async (p) => {
        prompts.push(p)
        return '{"done":true,"why":"asked the time"}'
      },
    })
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"내일 7시 2명 예약해 줘"}' })
    await until(async () => prompts.length === 1 && !(await state()).busy)
    // The first answer never reached the judge: code sent it back, the second answer was judged
    expect(rt.inputs).toHaveLength(2)
    expect(prompts[0]).toContain('Approval requests during this request: none')
    const { readdir, readFile } = await import('node:fs/promises')
    const logs = join(dir ?? '', 'logs')
    const checks = (
      await Promise.all(
        (await readdir(logs)).filter((f) => f.endsWith('.jsonl')).map((f) => readFile(join(logs, f), 'utf8')),
      )
    )
      .join('\n')
      .split('\n')
      .filter((l) => l.includes('"kind":"finish-check"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(checks[0]).toMatchObject({ result: 'again', because: 'unverified', source: 'code' })
    expect(checks[1]).toMatchObject({ result: 'done' })
  })

  it('with no AI ready, keeps the message, says how to connect one, and answers once one is', async () => {
    class SignedOut extends EchoRuntime {
      ready = false
      inputs: string[] = []
      override async detect(): Promise<AgentStatus> {
        return { id: 'claude', installed: true, loggedIn: this.ready }
      }
      override async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
        this.inputs.push(input.text)
        yield* super.runTurn(input)
      }
    }
    const rt = new SignedOut()
    const { api } = await boot(rt)
    const state = async () => (await (await api('/api/conversation')).json()) as State
    const r = await api('/api/conversation/messages', { method: 'POST', body: '{"text":"오늘 날씨 어때?"}' })
    expect(r.status).toBe(202)
    const msgs = (await state()).messages
    expect(msgs.map((x) => x.role)).toEqual(['user', 'assistant'])
    expect(msgs[1]?.text).toContain('설정 → AI · 브라우저')
    expect(rt.inputs).toHaveLength(0)
    // Signed in: the next look at the AIs answers the waiting message
    rt.ready = true
    await api('/api/agents')
    await until(async () => rt.inputs.length === 1)
    expect(rt.inputs[0]).toContain('오늘 날씨 어때?')
  })

  it('acknowledges a message before the AI is called, and logs how long that took', async () => {
    const { api } = await boot()
    const live = await api('/api/conversation/live')
    const reader = live.body?.getReader()
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"hello"}' })
    await until(async () => (await state()).messages.length === 2 && !(await state()).busy)
    let seen = ''
    const dec = new TextDecoder()
    while (!seen.includes('"type":"end"')) seen += dec.decode((await reader?.read())?.value)
    await reader?.cancel()
    expect(seen.indexOf('"kind":"ack"')).toBeGreaterThan(0)
    expect(seen.indexOf('"kind":"ack"')).toBeLessThan(seen.indexOf('"role":"user"'))
    const { readdir, readFile } = await import('node:fs/promises')
    const logs = join(dir ?? '', 'logs')
    const turn = (
      await Promise.all(
        (await readdir(logs)).filter((f) => f.endsWith('.jsonl')).map((f) => readFile(join(logs, f), 'utf8')),
      )
    )
      .join('\n')
      .split('\n')
      .find((l) => l.includes('"kind":"turn"'))
    expect(typeof JSON.parse(turn ?? '{}').ackMs).toBe('number')
  })

  it('the draft design: checking is said before the answer, and busy ends once after it', async () => {
    class ToolRuntime extends EchoRuntime {
      inputs: string[] = []
      override async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
        this.inputs.push(input.text)
        yield { type: 'tool', name: 'mcp__dool2__browser_open', input: {} }
        yield* super.runTurn(input)
      }
    }
    const rt = new ToolRuntime()
    const { api } = await boot(rt, {
      finishJudge: async () =>
        JSON.stringify({ done: false, why: '보험사 1곳만 봤어요', next: 'compare 2 more insurers' }),
    })
    const live = await api('/api/conversation/live')
    const reader = live.body?.getReader()
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"compare 3 car insurers"}' })
    await until(async () => rt.inputs.length === 1 && !(await state()).busy)
    let seen = ''
    const dec = new TextDecoder()
    const deadline = Date.now() + 2000
    while (!seen.includes('"busy":false') && Date.now() < deadline)
      seen += dec.decode((await reader?.read())?.value)
    await reader?.cancel()
    const events = seen
      .split('\n\n')
      .filter((c) => c.startsWith('data: '))
      .map(
        (c) =>
          JSON.parse(c.slice(6)) as {
            kind: string
            busy?: boolean
            checking?: boolean
            event?: { type: string; message?: { role: string } }
          },
      )
    // "checking" comes before the answer it is about
    const firstCheck = events.findIndex((e) => e.kind === 'checking' && e.checking)
    const firstAnswer = events.findIndex(
      (e) => e.event?.type === 'saved' && e.event.message?.role === 'assistant',
    )
    expect(firstCheck).toBeGreaterThanOrEqual(0)
    expect(firstCheck).toBeLessThan(firstAnswer)
    // No offer from the judge: no button and no "still left" card either
    const msgs = (await state()).messages
    expect(msgs.filter((m) => m.role === 'tool' && m.text.includes('"kind":"left"'))).toHaveLength(0)
    expect(rt.inputs).toHaveLength(1)
  })

  it('take it as is: ends the check, keeps the draft and starts no round', async () => {
    class ToolRuntime extends EchoRuntime {
      inputs: string[] = []
      override async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
        this.inputs.push(input.text)
        yield { type: 'tool', name: 'mcp__dool2__browser_open', input: {} }
        yield* super.runTurn(input)
      }
    }
    const rt = new ToolRuntime()
    let judged = 0
    const { api } = await boot(rt, {
      finishJudge: (_p, signal) => {
        judged++
        return new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve('{"done":false,"why":"x","next":"y"}')),
        )
      },
    })
    const state = async () =>
      (await (await api('/api/conversation')).json()) as State & { checking?: boolean }
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"compare 3 car insurers"}' })
    await until(async () => judged === 1)
    expect((await state()).checking).toBe(true)
    await api('/api/conversation/accept', { method: 'POST' })
    await until(async () => !(await state()).busy)
    await new Promise((r) => setTimeout(r, 50))
    expect(rt.inputs).toHaveLength(1)
    const s = await state()
    expect(s.checking).toBeUndefined()
    expect(s.messages.at(-1)).toMatchObject({ role: 'assistant' })
  })

  it('작업 기록에 AI가 뜬 시각, 첫 말까지 걸린 시간, 실패 까닭을 남긴다', async () => {
    class LimitRuntime extends EchoRuntime {
      override async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
        if (input.text.includes('한도')) {
          yield { type: 'started', resumeId: 'r1', tools: [] }
          yield { type: 'limit_reached', message: '사용량 한도' }
          return
        }
        if (input.text.includes('도구')) {
          yield { type: 'started', resumeId: 'r1', tools: [] }
          yield { type: 'tool', name: 'mcp__dool2__browser_read', input: {} }
          yield { type: 'tool', name: 'mcp__dool2__service_find', input: {} }
          // Results can come back in another order than the calls
          yield { type: 'tool_result', name: 'mcp__dool2__service_find', ok: true, chars: 30 }
          yield { type: 'tool_result', name: 'mcp__dool2__browser_read', ok: true, chars: 1200 }
          yield { type: 'tool', name: 'mcp__dool2__browser_read', input: {} }
          yield { type: 'tool_result', name: 'mcp__dool2__browser_read', ok: false }
          yield { type: 'text', delta: '다 봤어요' }
          yield { type: 'done', resumeId: 'r1', text: '다 봤어요' }
          return
        }
        yield* super.runTurn(input)
      }
    }
    const { api } = await boot(new LimitRuntime())
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"안녕"}' })
    await until(async () => !(await state()).busy && (await state()).messages.length >= 2)
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"한도 시험"}' })
    await until(async () => !(await state()).busy && (await state()).messages.length >= 3)
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"도구 시험"}' })
    await until(async () => !(await state()).busy && (await state()).messages.length >= 5)
    const { readdir, readFile } = await import('node:fs/promises')
    const logs = join(dir ?? '', 'logs')
    const lines = (
      await Promise.all(
        (await readdir(logs)).filter((f) => f.endsWith('.jsonl')).map((f) => readFile(join(logs, f), 'utf8')),
      )
    )
      .join('\n')
      .split('\n')
      .filter((l) => l.includes('"kind":"turn"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines[0]).toMatchObject({ answered: true })
    expect(typeof lines[0]?.startMs).toBe('number')
    expect(typeof lines[0]?.firstMs).toBe('number')
    // Phases: request received → turn start, the first AI event after the program is ready, the first word
    expect(typeof lines[0]?.prepMs).toBe('number')
    expect(typeof lines[0]?.eventMs).toBe('number')
    expect(typeof lines[0]?.textMs).toBe('number')
    expect(lines[1]).toMatchObject({ code: 'limit_reached' })
    // How much text each tool result gave the AI, next to its call (sizes only; null = not known)
    expect(lines[0]).not.toHaveProperty('chars')
    expect(lines[2]).toMatchObject({
      tools: ['browser_read', 'service_find', 'browser_read'],
      chars: [1200, 30, null],
    })
  })

  it('멈추기는 지금 차례를 그만두게 한다', async () => {
    const rt = new GateRuntime()
    const { api } = await boot(rt)
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"오래 걸리는 일"}' })
    await until(async () => rt.inputs.length === 1)
    const r = await api('/api/conversation/cancel', { method: 'POST' })
    expect(r.status).toBe(200)
    rt.release()
  })

  it('인증 승인을 기다리며 끝낸 답은 끝내기 전 검사로 되돌리지 않는다', async () => {
    class AuthRuntime extends EchoRuntime {
      override async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
        yield { type: 'tool', name: 'mcp__dool2__browser_wait_auth', input: {} }
        yield* super.runTurn(input)
      }
    }
    let judged = 0
    const { api } = await boot(new AuthRuntime(), {
      finishJudge: async () => {
        judged++
        return '{"done":false,"why":"인증이 아직 안 끝났어요"}'
      },
    })
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"건강보험 자격 확인해 줘"}' })
    await until(async () => !(await state()).busy && (await state()).messages.length >= 2)
    await new Promise((r) => setTimeout(r, 50))
    expect(judged).toBe(0)
  })

  it('멈추기는 끝내기 전 검사도 끝내고, 늦게 온 판정으로 일을 다시 시작하지 않는다', async () => {
    class ToolRuntime extends EchoRuntime {
      inputs: string[] = []
      override async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
        this.inputs.push(input.text)
        yield { type: 'tool', name: 'mcp__dool2__browser_open', input: {} }
        yield* super.runTurn(input)
      }
    }
    const rt = new ToolRuntime()
    let judged = 0
    let aborted = false
    const { api } = await boot(rt, {
      // A judge that answers only when stopped, and then says "not done" (a verdict that arrives late)
      finishJudge: (_p, signal) => {
        judged++
        return new Promise((resolve) =>
          signal.addEventListener('abort', () => {
            aborted = true
            resolve('{"done":false,"why":"1곳만 봤어요","next":"다른 곳"}')
          }),
        )
      },
    })
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"차 보험 3곳 비교해 줘"}' })
    await until(async () => judged === 1)
    expect((await state()).busy).toBe(true)
    await api('/api/conversation/cancel', { method: 'POST' })
    await until(async () => !(await state()).busy)
    expect(aborted).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(rt.inputs).toHaveLength(1)
  })
})

describe('설정', () => {
  it('처음에는 기본값을 준다', async () => {
    const { api } = await boot()
    expect(await (await api('/api/settings')).json()).toEqual({ settings: { setupDone: false } })
  })

  it('바꾼 항목만 저장하고, 다시 켜도 남아 있다', async () => {
    const { api } = await boot()
    const res = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ aiChoice: 'both', defaultAgent: 'codex' }),
    })
    expect(await res.json()).toEqual({
      settings: { setupDone: false, aiChoice: 'both', defaultAgent: 'codex' },
    })
    await api('/api/settings', { method: 'PATCH', body: '{"setupDone":true}' })

    const keep = dir
    dir = undefined // 첫 데몬을 닫아도 폴더는 남긴다
    await daemon?.close()
    daemon = await startDaemon({
      timeLine: () => undefined,
      dataDir: keep,
      token: 't0ken',
      runtimes: { claude: new EchoRuntime() },
    })
    dir = keep
    const again = await fetch(`${daemon.url}/api/settings`, { headers: { authorization: 'Bearer t0ken' } })
    expect(await again.json()).toEqual({
      settings: { setupDone: true, aiChoice: 'both', defaultAgent: 'codex' },
    })
  })

  it('바뀐 설정을 PC 앱에 알린다', async () => {
    const { api } = await boot()
    const seen: unknown[] = []
    daemon?.events.on('settings', (s) => seen.push(s))
    await api('/api/settings', { method: 'PATCH', body: '{"keepAwake":"working","launchAtLogin":true}' })
    expect(seen).toEqual([{ setupDone: false, keepAwake: 'working', launchAtLogin: true }])
    expect(daemon?.settings()).toMatchObject({ keepAwake: 'working' })
  })

  it('모르는 항목이나 틀린 값은 받지 않는다', async () => {
    const { api } = await boot()
    const unknown = await api('/api/settings', { method: 'PATCH', body: '{"admin":true}' })
    expect(unknown.status).toBe(400)
    const wrong = await api('/api/settings', { method: 'PATCH', body: '{"defaultAgent":"gemini"}' })
    expect(wrong.status).toBe(400)
  })
})

describe('Claude 로그인', () => {
  it('설치돼 있지 않으면 설치부터 안내한다', async () => {
    const { api } = await boot()
    const res = await api('/api/agents/claude/login', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  it('공식 로그인을 띄워 주소를 주고, 코드를 넘기면 끝난다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-test-'))
    let loggedIn = false
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: () => {},
    })
    child.stdin.on('data', () => {
      loggedIn = true
    })
    const rt = Object.assign(new EchoRuntime(), {
      createLogin: async () =>
        new ClaudeLogin({
          bin: 'claude',
          isLoggedIn: async () => loggedIn,
          spawn: () => {
            setTimeout(
              () => child.stdout.write('visit: https://claude.com/cai/oauth/authorize?code=true&x=1\n'),
              5,
            )
            return child
          },
          pollMs: 10,
        }),
    })
    daemon = await startDaemon({
      timeLine: () => undefined,
      dataDir: dir,
      token: 't0ken',
      runtimes: { claude: rt },
    })
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${daemon?.url}${path}`, {
        ...init,
        headers: { authorization: 'Bearer t0ken', 'content-type': 'application/json' },
      })
    const started = (await (await api('/api/agents/claude/login', { method: 'POST' })).json()) as {
      login: { state: string; url?: string }
    }
    expect(started.login).toMatchObject({ state: 'waiting', url: expect.stringContaining('oauth/authorize') })
    const done = await api('/api/agents/claude/login/code', { method: 'POST', body: '{"code":"abc"}' })
    expect(await done.json()).toEqual({ login: { state: 'done' } })
    const empty = await api('/api/agents/claude/login/code', { method: 'POST', body: '{"code":"  "}' })
    expect(empty.status).toBe(400)
  })
})

describe('종량제 계정', () => {
  it('a key its company rejects is not saved, and the screen says why', async () => {
    const { api } = await boot(undefined, { checkKey: async () => 'rejected' })
    const r = await api('/api/agents/opencode/account', {
      method: 'PUT',
      body: JSON.stringify({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-5.5',
        apiKey: 'undefined',
      }),
    })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toContain('OpenRouter')
    expect(await (await api('/api/agents/opencode/account')).json()).toEqual({ account: null })
  })

  it('제공자·모델은 설정에, 키는 비밀값 보관소에 두고, 키는 끝 4자리만 보여 준다', async () => {
    const { api } = await boot(undefined, { checkKey: async () => 'ok' })
    expect(await (await api('/api/agents/opencode/account')).json()).toEqual({ account: null })
    const cat = (await (await api('/api/agents/opencode/catalog')).json()) as { providers: { id: string }[] }
    expect(cat.providers.map((p) => p.id)).toContain('anthropic')

    const saved = await api('/api/agents/opencode/account', {
      method: 'PUT',
      body: JSON.stringify({
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        apiKey: 'sk-ant-secret-9876',
      }),
    })
    const body = await saved.text()
    expect(body).not.toContain('secret')
    expect(JSON.parse(body)).toEqual({
      account: { provider: 'anthropic', model: 'claude-sonnet-5-5', hasKey: true, keyHint: '9876' },
    })
    // 설정에는 키가 없다
    const settings = await (await api('/api/settings')).text()
    expect(settings).not.toContain('sk-ant')

    // 키 없이 모델만 바꾸기
    const changed = await api('/api/agents/opencode/account', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-5-5' }),
    })
    expect(await changed.json()).toMatchObject({ account: { model: 'claude-haiku-5-5', hasKey: true } })

    await api('/api/agents/opencode/account', { method: 'DELETE' })
    expect(await (await api('/api/agents/opencode/account')).json()).toEqual({ account: null })
  })

  it('모르는 제공자나 키 없는 첫 저장은 거절한다', async () => {
    const { api } = await boot()
    const bad = await api('/api/agents/opencode/account', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'nope', model: 'x', apiKey: '12345678' }),
    })
    expect(bad.status).toBe(400)
    const noKey = await api('/api/agents/opencode/account', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'openai', model: 'gpt-5.6' }),
    })
    expect(noKey.status).toBe(400)
  })
})

describe('브라우저', () => {
  it('Chrome 상태를 알려 주고, 이미 있으면 설치하지 않는다', async () => {
    const { api } = await boot()
    expect(await (await api('/api/browser')).json()).toEqual({
      chrome: { installed: true, version: '157.0.8103.79' },
      extension: { connected: false },
    })
    expect(await (await api('/api/browser/install', { method: 'POST' })).json()).toEqual({
      install: { state: 'done' },
    })
  })
})

describe('defaultDataDir', () => {
  it('OS별 표준 위치를 쓴다', () => {
    expect(defaultDataDir({}, 'darwin')).toBe(join(homedir(), 'Library', 'Application Support', 'dool2'))
    expect(defaultDataDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')).toContain('dool2')
    expect(defaultDataDir({ DOOL2_DATA_DIR: '/x' }, 'darwin')).toBe('/x')
  })
})

describe('로그인이 필요해질 때 (connect_ask)', () => {
  type State = { messages: { role: string; text: string }[]; busy: boolean }
  const until = async (f: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await f()) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('기다리다 지쳤어요')
  }
  it('금고에 계정이 있으면 카드 없이 두리가 다시 로그인하고, 없으면 연결 카드를 띄운다', async () => {
    const { api, rt } = await boot()
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"쿠팡에서 휴지 주문해 줘"}' })
    await until(async () => (await state()).messages.length === 2 && !(await state()).busy)
    const toolToken = rt.last?.mcpServers[0]?.env?.DOOL2_TOOL_TOKEN ?? ''
    const ask = async (service: string) =>
      (
        (await (
          await fetch(`${daemon?.url}/api/tools/life/connect_ask`, {
            method: 'POST',
            headers: { authorization: `Bearer ${toolToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ service }),
          })
        ).json()) as { content: { text: string }[] }
      ).content[0]?.text ?? ''
    // 금고에 없으면: 처음 쓰는 서비스라 연결 카드
    expect(await ask('coupang')).toContain('checking whether Chrome is already signed in')
    // 금고에 계정이 있으면: 묻지 않고 두리 본체가 다시 로그인한다 (끝나면 대화 알림으로 이어서)
    await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://www.coupang.com', username: 'duri', password: 'pw-123' }),
    })
    const auto = await ask('coupang')
    expect(auto).toContain('signing in to 쿠팡 again with the account in the vault')
    expect(auto).not.toContain('pw-123')
  })

  it('never signs in to a Google account with a typed password: the person picks it on the card (ADR 0041)', async () => {
    const { api, rt } = await boot()
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"구글로 가입한 곳 연결해 줘"}' })
    await until(async () => (await state()).messages.length === 2 && !(await state()).busy)
    const toolToken = rt.last?.mcpServers[0]?.env?.DOOL2_TOOL_TOKEN ?? ''
    // Even with a Google account in the vault, no automatic password sign-in
    await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://myaccount.google.com', username: 'duri', password: 'pw-123' }),
    })
    const r = (await (
      await fetch(`${daemon?.url}/api/tools/life/connect_ask`, {
        method: 'POST',
        headers: { authorization: `Bearer ${toolToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ service: 'google' }),
      })
    ).json()) as { content: { text: string }[] }
    const text = r.content[0]?.text ?? ''
    // Even with no extension connected that second, it goes to the account question (the look opens Chrome itself)
    expect(text).toContain('asks on the phone which one')
    expect(text).not.toContain('again with the account in the vault')
  })

  it('연결돼 있다고 기억하는데 다시 로그인할 방법이 없으면 연결 표시를 풀어 진짜 연결 카드가 뜨게 한다', async () => {
    const { api, rt } = await boot()
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"요기요로 저녁 시켜 줘"}' })
    await until(async () => (await state()).messages.length === 2 && !(await state()).busy)
    const toolToken = rt.last?.mcpServers[0]?.env?.DOOL2_TOOL_TOKEN ?? ''
    // 11분 전에 연결됐다고 표시만 남은 상태 (방금 연결된 10분 안이면 카드를 띄우지 않으므로)
    await api('/api/connections/coupang', { method: 'PUT' })
    const realNow = Date.now
    Date.now = () => realNow() + 11 * 60_000
    try {
      const r = (await (
        await fetch(`${daemon?.url}/api/tools/life/connect_ask`, {
          method: 'POST',
          headers: { authorization: `Bearer ${toolToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ service: 'coupang' }),
        })
      ).json()) as { content: { text: string }[] }
      expect(r.content[0]?.text).toContain('checking whether Chrome is already signed in')
    } finally {
      Date.now = realNow
    }
    const list = (await (await api('/api/connections')).json()) as {
      services: { card: { id: string }; connectedAt?: string | null }[]
    }
    expect(list.services.find((x) => x.card.id === 'coupang')?.connectedAt ?? undefined).toBeUndefined()
  })

  it('두리 도구로 금고·결제 수단을 볼 수 있다 (가린 값만, 도구 토큰으로만)', async () => {
    const { api, rt } = await boot()
    const state = async () => (await (await api('/api/conversation')).json()) as State
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"쿠팡 비번 저장돼 있어?"}' })
    await until(async () => (await state()).messages.length === 2 && !(await state()).busy)
    const toolToken = rt.last?.mcpServers[0]?.env?.DOOL2_TOOL_TOKEN ?? ''
    const tool = async (name: string, args: unknown = {}, token = toolToken) => {
      const r = await fetch(`${daemon?.url}/api/tools/life/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(args),
      })
      if (r.status !== 200) return `HTTP ${r.status}`
      return ((await r.json()) as { content: { text: string }[] }).content[0]?.text ?? ''
    }
    // 화면용 토큰으로는 부를 수 없다
    expect(await tool('vault_find', {}, 't0ken')).toBe('HTTP 401')
    expect(await tool('pay_method_list')).toContain('No payment methods saved')
    // Which AI Dool2 runs on: the pay-as-you-go key shows only its last 4, never the key
    await api('/api/agents/opencode/account', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'openai', model: 'gpt-5.6', apiKey: 'sk-test-secret-7788' }),
    })
    const ai = await tool('ai_account_view')
    expect(ai).toContain('OpenAI (GPT), model GPT-5.6')
    expect(ai).toContain('ends in 7788')
    expect(ai).not.toContain('secret')
    expect(await tool('vault_find', { site: '쿠팡' })).toContain('No, there is no login for 쿠팡')
    await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://www.coupang.com', username: 'duri1234', password: 'pw-123' }),
    })
    const yes = await tool('vault_find', { site: '쿠팡' })
    expect(yes).toContain('Yes, a login for 쿠팡')
    expect(yes).toContain('du******')
    expect(yes).not.toMatch(/pw-123|duri1234/)
    expect(await tool('vault_find')).toContain('1 site(s) have a login saved')
  })
})

describe('금고 API', () => {
  it('비밀번호는 넣기만 하고 돌려주지 않는다', async () => {
    const { api } = await boot()
    const add = await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://shop.example/login', username: 'duri', password: 'pw-123' }),
    })
    expect(add.status).toBe(200)
    const list = await (await api('/api/vault')).text()
    expect(list).toContain('https://shop.example')
    expect(list).not.toContain('pw-123')
    const bad = await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({ url: 'http://shop.example', username: 'a', password: 'b' }),
    })
    expect(bad.status).toBe(400)
  })

  it('도구 토큰으로는 금고를 볼 수 없다', async () => {
    await boot()
    const res = await fetch(`${daemon?.url}/api/vault`, { headers: { authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
  })
})

describe('승인 API', () => {
  it('없는 승인은 404, 도구 토큰으로는 승인 주소에 닿지 않는다', async () => {
    const { api } = await boot()
    expect((await api('/api/approvals')).status).toBe(200)
    expect((await api('/api/approvals/nope')).status).toBe(404)
    const r = await api('/api/approvals/nope', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(await r.json()).toMatchObject({ ok: false })
    const tool = await fetch(`${daemon?.url}/api/approvals`, { headers: { authorization: 'Bearer wrong' } })
    expect(tool.status).toBe(401)
  })

  it('PC 파일 여러 개 옮기기는 같은 승인 주소로 승인하면 본체가 옮긴다 (임시 폴더)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dool2-home-'))
    const dl = join(home, 'Downloads')
    mkdirSync(dl)
    writeFileSync(join(dl, 'a.pdf'), 'a')
    writeFileSync(join(dl, 'b.pdf'), 'b')
    const rt = new EchoRuntime()
    const { api } = await boot(rt, { fileFolders: { desktop: [], documents: [], downloads: [dl] } })
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"PDF 나눠 줘"}' })
    for (let i = 0; i < 200 && !rt.last; i++) await new Promise((r) => setTimeout(r, 10))
    const toolToken = rt.last?.mcpServers[0]?.env?.DOOL2_TOOL_TOKEN ?? ''
    const r = (await (
      await fetch(`${daemon?.url}/api/tools/file/file_move`, {
        method: 'POST',
        headers: { authorization: `Bearer ${toolToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          moves: [
            { from: join(dl, 'a.pdf'), folder: join(dl, '영수증') },
            { from: join(dl, 'b.pdf'), folder: join(dl, '계약서') },
          ],
        }),
      })
    ).json()) as { content: { text: string }[] }
    expect(r.content[0]?.text).toContain('Approval requested')
    const { approvals } = (await (await api('/api/approvals')).json()) as {
      approvals: { id: string; kind: string; items?: string[] }[]
    }
    const ap = approvals.find((a) => a.kind === 'file')
    expect(ap?.items).toHaveLength(2)
    const done = (await (
      await api(`/api/approvals/${ap?.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) })
    ).json()) as { ok: boolean; message: string }
    expect(done).toMatchObject({ ok: true })
    expect(done.message).toContain('2개를 옮겼어요')
    expect(existsSync(join(dl, '영수증', 'a.pdf'))).toBe(true)
    expect(existsSync(join(dl, '계약서', 'b.pdf'))).toBe(true)
    await rm(home, { recursive: true, force: true })
  })
})

describe('which chat a tool call came from (ADR 0038)', () => {
  it('two chats answering at once: the approval belongs to the chat whose tool server asked', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dool2-home-'))
    const dl = join(home, 'Downloads')
    mkdirSync(dl)
    writeFileSync(join(dl, 'a.pdf'), 'a')
    writeFileSync(join(dl, 'b.pdf'), 'b')
    class Held extends GateRuntime {
      seen: TurnInput[] = []
      override async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
        this.seen.push(input)
        yield* super.runTurn(input)
      }
    }
    const rt = new Held()
    const { api } = await boot(rt, { fileFolders: { desktop: [], documents: [], downloads: [dl] } })
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10))
    }
    const { thread: side } = (await (
      await api('/api/threads', { method: 'POST', body: '{"side":true}' })
    ).json()) as { thread: { id: string } }
    void api(`/api/threads/${side.id}/messages`, { method: 'POST', body: '{"text":"sort my downloads"}' })
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"hello"}' })
    await until(() => rt.seen.length === 2)
    const sideEnv = rt.seen.find((x) => x.mcpServers[0]?.env?.DOOL2_TOOLSET === side.id)?.mcpServers[0]?.env
    expect(sideEnv).toBeDefined()
    const r = (await (
      await fetch(`${daemon?.url}/api/tools/file/file_move`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sideEnv?.DOOL2_TOOL_TOKEN}`,
          'content-type': 'application/json',
          'x-dool2-toolset': side.id,
        },
        body: JSON.stringify({
          moves: [
            { from: join(dl, 'a.pdf'), folder: join(dl, 'x') },
            { from: join(dl, 'b.pdf'), folder: join(dl, 'y') },
          ],
        }),
      })
    ).json()) as { content: { text: string }[] }
    expect(r.content[0]?.text).toContain('Approval requested')
    const list = (await (await api('/api/threads')).json()) as {
      threads: { id: string; approval?: { id: string } }[]
    }
    expect(list.threads.find((t) => t.id === side.id)?.approval).toBeDefined()
    expect(list.threads.filter((t) => t.approval)).toHaveLength(1)
    rt.release()
    await rm(home, { recursive: true, force: true })
  })
})

describe('auto-approve review (gate regression, threat model T25)', () => {
  /** Keeps the turn open (like a real turn that is calling tools) and remembers its input for the tool token */
  class OpenRuntime extends GateRuntime {
    input?: TurnInput
    override async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
      this.input = input
      yield* super.runTurn(input)
    }
  }
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10))
  }

  it('auto-approve on + an instruction planted in a page: nothing moves without a card, a requested move runs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dool2-home-'))
    const dl = join(home, 'Downloads')
    mkdirSync(dl)
    writeFileSync(join(dl, 'a.pdf'), 'a')
    writeFileSync(join(dl, 'b.pdf'), 'b')
    const prompts: string[] = []
    const rt = new OpenRuntime()
    const { api } = await boot(rt, {
      fileFolders: { desktop: [], documents: [], downloads: [dl] },
      // A stand-in for the small reviewer AI: related only when the user asked to move files
      autoReviewer: async (prompt) => {
        prompts.push(prompt)
        return /옮겨/.test(prompt.split('The action')[0] ?? '') ? '{"related": true}' : '{"related": false}'
      },
    })
    await api('/api/settings', { method: 'PATCH', body: '{"autoApprove":true}' })
    const move = async () =>
      (await (
        await fetch(`${daemon?.url}/api/tools/file/file_move`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${rt.input?.mcpServers[0]?.env?.DOOL2_TOOL_TOKEN ?? ''}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            moves: [
              { from: join(dl, 'a.pdf'), folder: join(dl, 'x') },
              { from: join(dl, 'b.pdf'), folder: join(dl, 'y') },
            ],
          }),
        })
      ).json()) as { content: { text: string }[] }
    const approvals = async () =>
      ((await (await api('/api/approvals')).json()) as { approvals: { status: string; held?: string }[] })
        .approvals

    // 1) The user asked for a summary; a page told the AI to move files
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"이 글 요약해 줘"}' })
    await until(() => rt.inputs.length === 1)
    const held = await move()
    expect(held.content[0]?.text).toContain('does not match what the user asked')
    expect(await approvals()).toEqual([expect.objectContaining({ status: 'pending', held: 'unrelated' })])
    expect(existsSync(join(dl, 'a.pdf'))).toBe(true)
    // the reviewer saw the user's words and the facts, not the agent's reasons
    expect(prompts[0]).toContain('이 글 요약해 줘')
    expect(prompts[0]).toContain('moves, restores or downloads files')
    rt.release()

    // 2) The user asks for the move: auto-approve runs it
    await api('/api/conversation/messages', {
      method: 'POST',
      body: '{"text":"다운로드 PDF 폴더별로 옮겨 줘"}',
    })
    await until(() => rt.inputs.length === 2)
    const ran = await move()
    expect(ran.content[0]?.text).toContain('Auto-approve is on')
    expect(existsSync(join(dl, 'x', 'a.pdf'))).toBe(true)
    rt.release()
    await rm(home, { recursive: true, force: true })
  })
})

describe('서비스 연결', () => {
  it('레포의 카드 목록을 주고, 연결 표시를 저장·해제한다', async () => {
    const { api } = await boot()
    const list = (await (await api('/api/connections')).json()) as { services: { card: { id: string } }[] }
    expect(list.services.length).toBeGreaterThan(50)
    expect(list.services.some((s) => s.card.id === 'coupang')).toBe(true)

    const on = (await (await api('/api/connections/coupang', { method: 'PUT' })).json()) as {
      connectedAt: string
    }
    expect(on.connectedAt).toMatch(/^\d{4}-/)
    const after = (await (await api('/api/connections')).json()) as {
      services: { card: { id: string }; connectedAt?: string }[]
    }
    expect(after.services.find((s) => s.card.id === 'coupang')?.connectedAt).toBe(on.connectedAt)

    expect(await (await api('/api/connections/coupang', { method: 'DELETE' })).json()).toEqual({
      connectedAt: null,
    })
    expect((await api('/api/connections/nope', { method: 'PUT' })).status).toBe(404)
  })

  it('확장이 없으면 Chrome에서 열기를 거절한다', async () => {
    const { api } = await boot()
    const r = await api('/api/connections/coupang/open', { method: 'POST' })
    expect(r.status).toBe(409)
  })
})

describe('Opening Chrome when a tool needs the browser (ADR 0006 follow-up)', () => {
  const until = async (f: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await f()) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('waited too long')
  }

  it('a browser tool opens the closed Chrome in the extension profile, and says what is wrong when it does not connect', async () => {
    const launches: { profile?: string; running: boolean }[] = []
    const { api, rt } = await boot(undefined, {
      chrome: {
        detect: async () => ({ installed: true, version: '157.0.8103.79' }),
        running: async () => false,
        profile: async () => ({ dir: 'Profile 1', name: 'Work', hasExtension: true }),
        // A stand-in: no real Chrome starts, and the extension never connects
        launch: async (o) => {
          launches.push(o)
          return true
        },
        waitMs: 30,
      },
    })
    const state = async () =>
      (await (await api('/api/conversation')).json()) as { messages: unknown[]; busy: boolean }
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"hello"}' })
    await until(async () => (await state()).messages.length === 2 && !(await state()).busy)
    const toolToken = rt.last?.mcpServers[0]?.env?.DOOL2_TOOL_TOKEN ?? ''
    const tool = async (name: string, body: unknown) =>
      (await (
        await fetch(`${daemon?.url}/api/tools/browser/${name}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${toolToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as { isError?: boolean; content: { text: string }[] }

    // The setting off: nothing is opened, and the answer says Chrome is closed
    await api('/api/settings', { method: 'PATCH', body: '{"chromeAutoOpen":false}' })
    const off = await tool('open', { url: 'https://example.com' })
    expect(off.isError).toBe(true)
    expect(off.content[0]?.text).toContain('opening Chrome automatically is off')
    expect(launches).toEqual([])

    await api('/api/settings', { method: 'PATCH', body: '{"chromeAutoOpen":true}' })
    const r = await tool('open', { url: 'https://example.com' })
    expect(launches).toEqual([{ profile: 'Profile 1', running: false }])
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('Dool2 opened Chrome (the "Work" profile)')
    expect(r.content[0]?.text).toContain('The service connection itself is fine')
    // Right after: the same answer, Chrome is not opened again
    await tool('read', { tabId: 1 })
    expect(launches).toHaveLength(1)
  })
})
