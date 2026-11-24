import type { AgentEvent } from '@dool2/protocol'
import { describe, expect, it } from 'vitest'
import { buildCodexArgs, CodexEventMapper, JsonRpcClient, resolveBundledCodex } from './index.js'

describe('buildCodexArgs', () => {
  const args = buildCodexArgs([{ name: 'dool2', command: '/app/node', args: ['/app/mcp.js'] }])
  const pairs = args.filter((_, i) => args[i - 1] === '-c')

  it('셸·웹 검색을 끄고 읽기 전용으로 묶는다', () => {
    expect(args[0]).toBe('app-server')
    expect(pairs).toContain('features.shell_tool=false')
    expect(pairs).toContain('web_search="disabled"')
    expect(pairs).toContain('sandbox_mode="read-only"')
  })

  it('두리 MCP 서버를 필수로 등록한다', () => {
    expect(pairs).toContain('mcp_servers.dool2.command="/app/node"')
    expect(pairs).toContain('mcp_servers.dool2.args=["/app/mcp.js"]')
    expect(pairs).toContain('mcp_servers.dool2.required=true')
  })
})

describe('CodexEventMapper', () => {
  const run = (msgs: [string, Record<string, unknown>][]) => {
    const m = new CodexEventMapper('th1')
    return msgs.map(([method, params]) => m.map(method, { threadId: 'th1', ...params }))
  }

  it('글 조각·두리 도구·끝을 공통 이벤트로 바꾼다', () => {
    const results = run([
      ['item/started', { item: { type: 'mcpToolCall', server: 'dool2', tool: 'status', arguments: {} } }],
      [
        'item/completed',
        { item: { type: 'mcpToolCall', server: 'dool2', tool: 'status', status: 'completed' } },
      ],
      ['item/agentMessage/delta', { delta: '지금은 ' }],
      ['item/agentMessage/delta', { delta: '12시예요' }],
      ['item/completed', { item: { type: 'agentMessage', text: '지금은 12시예요' } }],
      ['turn/completed', { turn: { status: 'completed' } }],
    ])
    const events = results.flatMap((r) => r.events)
    expect(events).toEqual<AgentEvent[]>([
      { type: 'tool', name: 'mcp__dool2__status', input: {} },
      { type: 'tool_result', name: 'mcp__dool2__status', ok: true },
      { type: 'text', delta: '지금은 ' },
      { type: 'text', delta: '12시예요' },
      { type: 'done', resumeId: 'th1', text: '지금은 12시예요' },
    ])
    expect(results.at(-1)?.finished).toBe(true)
  })

  it('세션 크기는 마지막 호출의 입력 토큰으로, 차례 끝에 한 번 알린다', () => {
    const usage = (lastInput: number, totalInput: number) => ({
      tokenUsage: {
        last: { inputTokens: lastInput, cachedInputTokens: lastInput - 100, outputTokens: 20 },
        total: { inputTokens: totalInput, cachedInputTokens: 0, outputTokens: 40 },
        modelContextWindow: 258_400,
      },
    })
    const events = run([
      ['thread/tokenUsage/updated', usage(3_000, 3_000)],
      ['thread/tokenUsage/updated', usage(35_000, 38_000)],
      ['turn/completed', { turn: { status: 'completed' } }],
    ]).flatMap((r) => r.events)
    expect(events).toEqual<AgentEvent[]>([
      { type: 'context', tokens: 35_000 },
      { type: 'done', resumeId: 'th1', text: '' },
    ])
  })

  it('셸 실행이 보이면 즉시 멈춘다', () => {
    const [r] = run([['item/started', { item: { type: 'commandExecution', command: 'curl x' } }]])
    expect(r?.abort).toBe(true)
    expect(r?.events[0]).toMatchObject({ type: 'error', code: 'tools_unsafe' })
  })

  it('두리가 아닌 MCP 도구도 멈춘다', () => {
    const [r] = run([['item/started', { item: { type: 'mcpToolCall', server: 'other', tool: 'x' } }]])
    expect(r?.abort).toBe(true)
  })

  it('tool_result carries how many characters of text the tool gave back', () => {
    const events = run([
      [
        'item/completed',
        {
          item: {
            type: 'mcpToolCall',
            server: 'dool2',
            tool: 'browser_read',
            status: 'completed',
            result: { content: [{ type: 'text', text: 'page text' }] },
          },
        },
      ],
      [
        'item/completed',
        {
          item: {
            type: 'mcpToolCall',
            server: 'dool2',
            tool: 'browser_click',
            status: 'failed',
            error: { message: 'No e9 ref' },
          },
        },
      ],
    ]).flatMap((r) => r.events)
    expect(events).toEqual<AgentEvent[]>([
      { type: 'tool_result', name: 'mcp__dool2__browser_read', ok: true, chars: 9 },
      { type: 'tool_result', name: 'mcp__dool2__browser_click', ok: false, chars: 9 },
    ])
  })

  it('사용량 한도와 로그인 문제를 구분한다', () => {
    const [limit, auth, retry] = run([
      ['error', { willRetry: false, error: { message: 'x', codexErrorInfo: 'usageLimitExceeded' } }],
      ['error', { willRetry: false, error: { message: 'x', codexErrorInfo: 'unauthorized' } }],
      ['error', { willRetry: true, error: { message: 'x', codexErrorInfo: 'serverOverloaded' } }],
    ])
    expect(limit?.events[0]?.type).toBe('limit_reached')
    expect(auth?.events[0]).toMatchObject({ type: 'error', code: 'not_logged_in' })
    expect(retry?.events).toEqual([])
  })

  it('401 응답도 로그인 문제로 본다 (실제 Codex 0.169 출력)', () => {
    const [r] = run([
      [
        'error',
        {
          willRetry: false,
          error: { message: 'unexpected status 401 Unauthorized: Missing bearer', codexErrorInfo: null },
        },
      ],
    ])
    expect(r?.events[0]).toMatchObject({ type: 'error', code: 'not_logged_in' })
  })

  it('다른 스레드 알림은 무시한다', () => {
    const m = new CodexEventMapper('th1')
    expect(m.map('item/agentMessage/delta', { threadId: 'other', delta: 'x' }).events).toEqual([])
  })

  it('사용량 창을 퍼센트로 바꾼다', () => {
    const [r] = run([
      [
        'account/rateLimits/updated',
        { rateLimits: { primary: { usedPercent: 41.6, windowDurationMins: 300, resetsAt: 1794627600 } } },
      ],
    ])
    expect(r?.events[0]).toEqual({
      type: 'usage',
      limits: [{ kind: 'five_hour', percent: 42, resetsAt: '2026-11-14T03:40:00.000Z' }],
    })
  })
})

describe('JsonRpcClient', () => {
  it('요청·응답·알림·서버 요청을 처리한다', async () => {
    const sent: string[] = []
    let feed: (line: string) => void = () => {}
    let end: () => void = () => {}
    const lines = (async function* () {
      const buf: string[] = []
      let done = false
      let wake: (() => void) | undefined
      feed = (l) => {
        buf.push(l)
        wake?.()
      }
      end = () => {
        done = true
        wake?.()
      }
      while (true) {
        while (buf.length) yield buf.shift() as string
        if (done) return
        await new Promise<void>((r) => {
          wake = r
        })
      }
    })()
    const notes: string[] = []
    const rpc = new JsonRpcClient(
      { send: (l) => sent.push(l), lines },
      (method) => notes.push(method),
      (method) => (method === 'item/commandExecution/requestApproval' ? { decision: 'decline' } : {}),
    )
    const pumping = rpc.pump()
    const p = rpc.request<{ ok: boolean }>('initialize', {})
    feed(JSON.stringify({ method: 'turn/started', params: {} }))
    feed(JSON.stringify({ id: 1, result: { ok: true } }))
    await expect(p).resolves.toEqual({ ok: true })
    feed(JSON.stringify({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: {} }))
    await new Promise((r) => setTimeout(r, 10))
    expect(notes).toEqual(['turn/started'])
    expect(JSON.parse(sent.at(-1) ?? '{}')).toEqual({ id: 'srv-1', result: { decision: 'decline' } })
    end()
    await pumping
  })
})

describe('resolveBundledCodex', () => {
  it('함께 설치된 Codex 실행 파일을 찾는다', () => {
    expect(resolveBundledCodex()).toMatch(/codex(\.exe)?$/)
  })
  it('지원하지 않는 플랫폼이면 undefined', () => {
    expect(resolveBundledCodex('aix', 'ppc64')).toBeUndefined()
  })
})

describe('Codex 내려받기', () => {
  it('고정한 SHA-512와 맞을 때만 풀고, vendor 폴더만 남긴다', async () => {
    const { createHash } = await import('node:crypto')
    const { mkdtemp, mkdir, writeFile, readdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { installCodex } = await import('./download.js')
    const dir = await mkdtemp(join(tmpdir(), 'dool2-codex-'))
    try {
      const tgz = new Uint8Array([9, 8, 7])
      const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
      const pkg = { triple: 'aarch64-apple-darwin', integrity }
      const fetchOk = (async () => new Response(tgz)) as unknown as typeof fetch
      const extract = async (_a: string, into: string) => {
        const bin = join(into, 'package', 'vendor', 'aarch64-apple-darwin', 'bin')
        await mkdir(bin, { recursive: true })
        await writeFile(join(bin, 'codex'), 'x')
        await writeFile(join(into, 'package', 'package.json'), '{}')
      }
      const bin = await installCodex({
        dir,
        platformArch: 'darwin-arm64',
        pkg,
        fetch: fetchOk,
        extract,
        url: 'x',
      })
      expect(bin).toBe(join(dir, '0.169.0', 'aarch64-apple-darwin', 'bin', 'codex'))
      expect(await readdir(dir)).toEqual(['0.169.0'])

      const bad = {
        triple: 'aarch64-apple-darwin',
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      }
      await expect(
        installCodex({ dir, platformArch: 'darwin-arm64', pkg: bad, fetch: fetchOk, extract, url: 'x' }),
      ).rejects.toThrow('공식 파일과 달라요')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('모든 지원 플랫폼의 무결성 값이 적혀 있다', async () => {
    const { CODEX_PACKAGES } = await import('./download.js')
    for (const p of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'])
      expect(CODEX_PACKAGES[p]?.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/)
  })
})
