import { EventEmitter } from 'node:events'
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

async function boot() {
  dir = await mkdtemp(join(tmpdir(), 'dool2-test-'))
  const rt = new EchoRuntime()
  daemon = await startDaemon({ dataDir: dir, token: 't0ken', runtimes: { claude: rt } })
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
    expect(rt.last?.mcpServers[0]?.name).toBe('dool2')
    expect(rt.last?.cwd).toBe(join(dir as string, 'workspace'))
  })

  it('지원하지 않는 AI로는 대화를 만들지 않는다', async () => {
    const { api } = await boot()
    const res = await api('/api/threads', { method: 'POST', body: '{"agent":"codex"}' })
    expect(res.status).toBe(400)
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
    daemon = await startDaemon({ dataDir: keep, token: 't0ken', runtimes: { claude: new EchoRuntime() } })
    dir = keep
    const again = await fetch(`${daemon.url}/api/settings`, { headers: { authorization: 'Bearer t0ken' } })
    expect(await again.json()).toEqual({
      settings: { setupDone: true, aiChoice: 'both', defaultAgent: 'codex' },
    })
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
    daemon = await startDaemon({ dataDir: dir, token: 't0ken', runtimes: { claude: rt } })
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

describe('defaultDataDir', () => {
  it('OS별 표준 위치를 쓴다', () => {
    expect(defaultDataDir({}, 'darwin')).toBe(join(homedir(), 'Library', 'Application Support', 'dool2'))
    expect(defaultDataDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')).toContain('dool2')
    expect(defaultDataDir({ DOOL2_DATA_DIR: '/x' }, 'darwin')).toBe('/x')
  })
})
