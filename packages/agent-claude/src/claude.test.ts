import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AgentEvent } from '@dool2/protocol'
import { describe, expect, it } from 'vitest'
import { buildClaudeArgs, ClaudeStreamParser } from './index.js'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')
    .split('\n')
    .filter(Boolean)

function parseAll(lines: string[]) {
  const p = new ClaudeStreamParser()
  return lines.flatMap((l) => p.push(l))
}

describe('buildClaudeArgs', () => {
  const args = buildClaudeArgs({
    systemPrompt: '두리 지침',
    mcpServers: [{ name: 'dool2', command: '/app/node', args: ['/app/mcp.js'] }],
  })

  it('내장 도구를 끄고 두리 도구만 허용한다', () => {
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__dool2__*')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
  })

  it('구독 로그인을 읽지 않는 --bare는 쓰지 않는다', () => {
    expect(args).not.toContain('--bare')
  })

  it('MCP 설정에 두리 서버를 넣는다', () => {
    const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1] ?? '{}')
    expect(cfg.mcpServers.dool2).toEqual({ type: 'stdio', command: '/app/node', args: ['/app/mcp.js'] })
  })

  it('이어 하기 id가 있으면 --resume을 붙인다', () => {
    const resumed = buildClaudeArgs({ systemPrompt: '', mcpServers: [], resumeId: 'abc' })
    expect(resumed.slice(-2)).toEqual(['--resume', 'abc'])
    expect(args).not.toContain('--resume')
  })
})

describe('ClaudeStreamParser — 실제 출력', () => {
  const events = parseAll(fixture('hello.jsonl'))

  it('시작·글·사용량·세션 크기·끝 이벤트를 낸다', () => {
    expect(events.map((e) => e.type)).toEqual(['started', 'usage', 'text', 'context', 'done'])
  })

  it('세션 크기는 입력 토큰 + 캐시 읽기 + 캐시 만들기', () => {
    expect(events.find((e) => e.type === 'context')).toEqual({ type: 'context', tokens: 2 + 2102 + 649 })
  })

  it('부분 메시지와 완성 메시지의 글을 두 번 내지 않는다', () => {
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)
    expect(text.join('')).toBe('안녕!')
  })

  it('세션 id를 이어 하기 id로 준다', () => {
    const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>
    expect(done.resumeId).toMatch(/^[0-9a-f-]{36}$/)
    expect(done.text).toBe('안녕!')
  })

  it('사용량을 퍼센트로 바꾼다', () => {
    const usage = events.find((e) => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>
    expect(usage.limits).toEqual([
      { kind: 'five_hour', percent: 78, resetsAt: expect.any(String) },
      { kind: 'seven_day', percent: 13, resetsAt: expect.any(String) },
    ])
  })
})

describe('ClaudeStreamParser — 안전장치', () => {
  it('두리 도구가 아닌 도구가 켜져 있으면 멈추게 한다', () => {
    const events = parseAll([
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        tools: ['Bash', 'mcp__dool2__status'],
      }),
    ])
    expect(events[1]).toMatchObject({ type: 'error', code: 'tools_unsafe' })
    expect((events[1] as { message: string }).message).toContain('Bash')
  })

  it('두리 도구만 있으면 그대로 시작한다', () => {
    const events = parseAll([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', tools: ['mcp__dool2__status'] }),
    ])
    expect(events).toEqual([{ type: 'started', resumeId: 's', tools: ['mcp__dool2__status'] }])
  })

  it('도구 호출과 결과를 이름으로 짝지어 준다', () => {
    const events = parseAll([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__dool2__status', input: {} }] },
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
    ])
    expect(events).toEqual([
      { type: 'tool', name: 'mcp__dool2__status', input: {} },
      { type: 'tool_result', name: 'mcp__dool2__status', ok: true },
    ])
  })

  it('한도가 막히면 limit_reached를 낸다', () => {
    const events = parseAll([
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1794627600 },
      }),
    ])
    expect(events[0]).toMatchObject({ type: 'limit_reached', resetsAt: '2026-11-14T03:40:00.000Z' })
  })

  it('로그인 문제로 실패하면 not_logged_in으로 알려 준다', () => {
    const events = parseAll([
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
      }),
    ])
    expect(events[0]).toMatchObject({ type: 'error', code: 'not_logged_in' })
  })

  it('세션 크기는 마지막 AI 호출 기준이고, 합친 result 사용량은 쓰지 않는다', () => {
    const assistant = (input: number, cacheRead: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: 'assistant',
        ...extra,
        message: {
          content: [{ type: 'text', text: '.' }],
          usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
        },
      })
    const events = parseAll([
      assistant(10, 1000),
      // 브라우저 페이지를 읽은 뒤의 호출: 세션이 커졌다
      assistant(5, 40_000),
      // 다른 세션(하위 작업)의 호출은 세지 않는다
      assistant(1, 999_999, { parent_tool_use_id: 'x' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '.',
        usage: { input_tokens: 15, cache_read_input_tokens: 41_000 },
      }),
    ])
    expect(events.filter((e) => e.type === 'context')).toEqual([{ type: 'context', tokens: 40_005 }])
  })

  it('사용량이 없으면 세션 크기를 내지 않는다', () => {
    const events = parseAll([JSON.stringify({ type: 'result', subtype: 'success', result: '네' })])
    expect(events).toEqual([{ type: 'done', text: '네' }])
  })

  it('JSON이 아닌 줄은 무시한다', () => {
    expect(parseAll(['not json', ''])).toEqual([])
  })
})

describe('모델', () => {
  it('기본은 sonnet, 지정하면 그 모델', () => {
    const base = { systemPrompt: 'x', mcpServers: [] }
    const a = buildClaudeArgs(base)
    expect(a[a.indexOf('--model') + 1]).toBe('sonnet')
    const b = buildClaudeArgs({ ...base, model: 'opus' })
    expect(b[b.indexOf('--model') + 1]).toBe('opus')
  })
})
