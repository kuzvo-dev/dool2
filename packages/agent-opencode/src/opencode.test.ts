import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@dool2/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildOpenCodeConfig,
  buildOpenCodeEnv,
  installOpenCode,
  OPENCODE_RELEASE,
  type OpenCodeEvent,
  OpenCodeEventMapper,
  openCodeAsset,
  openCodeBin,
  readSse,
} from './index.js'

const fixture = (name: string): OpenCodeEvent[] =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as OpenCodeEvent)

function run(events: OpenCodeEvent[], session = 'ses_TEST') {
  const m = new OpenCodeEventMapper(session)
  const out: AgentEvent[] = []
  let finished = false
  let abort = false
  for (const e of events) {
    const r = m.map(e)
    out.push(...r.events)
    if (r.abort) abort = true
    if (r.finished) {
      finished = true
      break
    }
  }
  return { out, finished, abort }
}

const mcp = [{ name: 'dool2', command: '/x/node', args: ['/x/server.js'], env: { A: '1' } }]

describe('OpenCode 설정', () => {
  it('모든 도구를 막고 두리 도구만 연다 (마지막 규칙이 이김)', () => {
    const c = buildOpenCodeConfig({ mcpServers: mcp, systemPrompt: '두리' })
    expect(c.permissions).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'dool2_*', resource: '*', effect: 'allow' },
    ])
    expect(c.agents.dool2.permissions).toEqual(c.permissions)
    expect(c.default_agent).toBe('dool2')
  })

  it('기본 에이전트·무료 제공자·웹 검색·다른 MCP를 끈다', () => {
    const c = buildOpenCodeConfig({ mcpServers: mcp, systemPrompt: '두리' })
    for (const a of ['build', 'plan', 'general', 'explore'] as const)
      expect(c.agents[a]).toEqual({ disabled: true })
    expect(c.policies).toContainEqual({ action: 'provider.use', resource: 'opencode', effect: 'deny' })
    expect(c.policies).toContainEqual({ action: 'websearch.use', resource: '*', effect: 'deny' })
    expect(c.policies.slice(-2)).toEqual([
      { action: 'mcp.use', resource: '*', effect: 'deny' },
      { action: 'mcp.use', resource: 'dool2', effect: 'allow' },
    ])
  })

  it('MCP 도구를 코드 실행으로 감싸지 않는다', () => {
    const c = buildOpenCodeConfig({ mcpServers: mcp, systemPrompt: '두리' })
    expect(c.mcp.servers.dool2).toEqual({
      type: 'local',
      command: ['/x/node', '/x/server.js'],
      environment: { A: '1' },
      codemode: false,
    })
  })

  it('두리 전용 폴더만 쓰고, 고른 제공자 키만 넘긴다', () => {
    const env = buildOpenCodeEnv({
      home: '/d/oc',
      password: 'pw',
      config: {},
      provider: 'openrouter',
      apiKey: 'sk-or-1',
      base: {
        PATH: '/bin',
        HOME: '/Users/me',
        ANTHROPIC_API_KEY: 'other',
        OPENCODE_CONFIG: '/Users/me/x.json',
      },
    })
    expect(env.HOME).toBe('/d/oc')
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-1')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENCODE_CONFIG).toBeUndefined()
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
    expect(() =>
      buildOpenCodeEnv({ home: '/d', password: 'p', config: {}, provider: 'nope', apiKey: 'k' }),
    ).toThrow()
  })
})

describe('OpenCode 사건 → 두리 사건', () => {
  it('글·도구·비용·끝을 공통 사건으로 바꾼다', () => {
    const { out, finished } = run(fixture('success.jsonl'))
    expect(finished).toBe(true)
    expect(out).toEqual([
      { type: 'started', resumeId: 'ses_TEST', tools: [] },
      { type: 'tool', name: 'dool2_status', input: {} },
      { type: 'tool_result', name: 'dool2_status', ok: true },
      { type: 'cost', usd: 0.0021, inputTokens: 1830, outputTokens: 42 },
      { type: 'text', delta: '지금은 ' },
      { type: 'text', delta: '오후 4시예요.' },
      { type: 'cost', usd: 0.0013, inputTokens: 1900, outputTokens: 18 },
      { type: 'context', tokens: 1900 },
      { type: 'done', resumeId: 'ses_TEST', text: '지금은 오후 4시예요.' },
    ])
  })

  it('세션 크기는 마지막 단계의 입력 + 캐시 읽기·쓰기', () => {
    const m = new OpenCodeEventMapper('s')
    const step = (input: number, read: number, write: number) =>
      m.map({
        type: 'session.step.ended',
        data: { sessionID: 's', cost: 0, tokens: { input, output: 5, cache: { read, write } } },
      })
    step(500, 2_000, 100)
    step(300, 30_000, 4_000)
    const end = m.map({ type: 'session.execution.succeeded', data: { sessionID: 's' } })
    expect(end.events[0]).toEqual({ type: 'context', tokens: 34_300 })
  })

  it('틀린 API 키면 한 번만 "키를 다시 넣어 주세요"라고 알린다 (실제 v2.3.0 출력)', () => {
    const { out, finished } = run(fixture('auth-fail.jsonl'))
    expect(finished).toBe(true)
    const errors = out.filter((e) => e.type === 'error')
    expect(errors).toEqual([
      { type: 'error', code: 'not_logged_in', message: expect.stringContaining('API 키') },
    ])
  })

  it('두리 도구가 아닌 도구를 쓰려 하면 바로 멈춘다', () => {
    const { out, abort } = run([
      { type: 'session.tool.input.started', data: { sessionID: 'ses_TEST', id: 'c1', name: 'bash' } },
      {
        type: 'session.tool.called',
        data: { sessionID: 'ses_TEST', id: 'c1', input: { command: 'rm -rf /' } },
      },
    ])
    expect(abort).toBe(true)
    expect(out).toEqual([{ type: 'error', code: 'tools_unsafe', message: expect.stringContaining('bash') }])
  })

  it('다른 대화의 사건은 무시하고, 요청이 많으면 한도로 알린다', () => {
    const { out } = run([
      { type: 'session.text.delta', data: { sessionID: 'ses_OTHER', delta: '남의 글' } },
      {
        type: 'session.execution.failed',
        data: {
          sessionID: 'ses_TEST',
          error: { type: 'provider.rate-limit', status: 429, retryAfterMs: 60000 },
        },
      },
    ])
    expect(out).toEqual([
      { type: 'limit_reached', message: expect.any(String), resetsAt: expect.any(String) },
    ])
  })

  it('SSE 본문을 사건으로 나눈다', async () => {
    const enc = new TextEncoder()
    async function* body() {
      yield enc.encode('event: m\ndata: {"type":"a","da')
      yield enc.encode('ta":{}}\n\n: ping\n\ndata: {"type":"b"}\n\n')
    }
    const got: string[] = []
    for await (const e of readSse(body())) got.push(e.type)
    expect(got).toEqual(['a', 'b'])
  })
})

describe('OpenCode 설치', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('플랫폼별 릴리스 파일 이름', () => {
    expect(openCodeAsset('darwin', 'arm64')).toBe('opencode-darwin-arm64.zip')
    expect(openCodeAsset('win32', 'x64')).toBe('opencode-windows-x64.zip')
    expect(openCodeAsset('win32', 'ia32')).toBeUndefined()
  })

  it('SHA256SUMS로 확인한 뒤 풀고, 받은 압축 파일은 지운다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-oc-'))
    const zip = new Uint8Array([1, 2, 3, 4])
    const sum = createHash('sha256').update(zip).digest('hex')
    const fakeFetch = (async (u: string | URL | Request) => {
      const url = String(u)
      if (url === `${OPENCODE_RELEASE}/SHA256SUMS`)
        return new Response(`${'0'.repeat(64)}  other.zip\n${sum}  test.zip\n`)
      if (url === `${OPENCODE_RELEASE}/test.zip`) return new Response(zip)
      return new Response('', { status: 404 })
    }) as typeof fetch
    const bin = await installOpenCode({
      dir,
      asset: 'test.zip',
      fetch: fakeFetch,
      extract: async (_a, into) => {
        await mkdir(into, { recursive: true })
        await writeFile(join(into, process.platform === 'win32' ? 'opencode.exe' : 'opencode'), 'bin')
      },
    })
    expect(bin).toBe(openCodeBin(dir))
    expect((await readdir(dir)).sort()).toEqual(['v2.3.0'])

    const bad = (async (u: string | URL | Request) =>
      String(u).endsWith('SHA256SUMS')
        ? new Response(`${'f'.repeat(64)}  test.zip\n`)
        : new Response(zip)) as typeof fetch
    await expect(
      installOpenCode({ dir, asset: 'test.zip', fetch: bad, extract: async () => {} }),
    ).rejects.toThrow('공식 파일과 달라요')
  })
})
