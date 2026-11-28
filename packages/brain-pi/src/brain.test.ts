import type { RunHandle, TurnEvent } from '@dool2/core'
import { TOOLS } from '@dool2/core'
import { describe, expect, it } from 'vitest'
import { createPiBrain } from './brain.js'
import type { ProviderName } from './types.js'

const noop: RunHandle = { toolResult() {}, steer() {}, abort() {} }

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

/** Turn a list of SSE events into an HTTP Response whose body streams them, like a real provider would. */
function sseResponse(events: string[], status = 200): Response {
  const body = `${events.join('\n\n')}\n\n`
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

/** A fetch stub that returns the queued responses in order and records the request bodies it saw. */
function stubFetch(responses: Response[]): {
  fetch: typeof fetch
  calls: Array<{ url: string; body: unknown }>
} {
  const calls: Array<{ url: string; body: unknown }> = []
  let i = 0
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const res = responses[Math.min(i, responses.length - 1)]
    i++
    return res
  }) as unknown as typeof fetch
  return { fetch, calls }
}

const ANTHROPIC_TEXT_THEN_TOOL = [
  'data: {"type":"message_start"}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"On it. "}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Running code."}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"code"}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"expr\\""}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":\\"1+1\\"}"}}',
  'data: {"type":"content_block_stop","index":1}',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
  'data: {"type":"message_stop"}',
]

const ANTHROPIC_PLAIN_TEXT = [
  'data: {"type":"message_start"}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The answer is 42."}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
  'data: {"type":"message_stop"}',
]

describe('createPiBrain (anthropic)', () => {
  it('emits text, a parsed tool_call, then turn_end tool', async () => {
    const { fetch } = stubFetch([sseResponse(ANTHROPIC_TEXT_THEN_TOOL)])
    const brain = createPiBrain({ apiKey: 'k', model: 'm', fetch })
    const ev = await collect(brain.run({ system: 's', messages: [{ role: 'user', content: 'go' }] }, noop))

    const text = ev
      .filter((e) => e.kind === 'text')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(text).toBe('On it. Running code.')

    const toolCall = ev.find((e) => e.kind === 'tool_call')
    expect(toolCall).toBeDefined()
    if (toolCall?.kind === 'tool_call') {
      expect(toolCall.call.name).toBe('code')
      expect(toolCall.call.id).toBe('toolu_1')
      expect(toolCall.call.args).toEqual({ expr: '1+1' })
    }

    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'tool' })
    // Order: text precedes the tool call, which precedes turn_end.
    const kinds = ev.map((e) => e.kind)
    expect(kinds.indexOf('text')).toBeLessThan(kinds.indexOf('tool_call'))
    expect(kinds.indexOf('tool_call')).toBeLessThan(kinds.indexOf('turn_end'))
  })

  it('ends a plain text answer with turn_end done', async () => {
    const { fetch } = stubFetch([sseResponse(ANTHROPIC_PLAIN_TEXT)])
    const brain = createPiBrain({ apiKey: 'k', model: 'm', fetch })
    const ev = await collect(brain.run({ system: 's', messages: [] }, noop))
    expect(ev.some((e) => e.kind === 'tool_call')).toBe(false)
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'done' })
  })

  it('declares the core TOOLS and the system prompt in the request', async () => {
    const { fetch, calls } = stubFetch([sseResponse(ANTHROPIC_PLAIN_TEXT)])
    const brain = createPiBrain({ apiKey: 'k', model: 'm', fetch })
    await collect(brain.run({ system: 'persona-prompt', messages: [] }, noop))

    const body = calls[0]?.body as { system: string; tools: Array<{ name: string }>; model: string }
    expect(body.model).toBe('m')
    expect(body.system).toBe('persona-prompt')
    const names = body.tools.map((t) => t.name).sort()
    expect(names).toEqual(TOOLS.map((t) => t.name).sort())
    expect(names).toContain('code')
  })

  it('does not send a Claude-CLI user agent or client id', async () => {
    let headers: Record<string, string> = {}
    const fetch = (async (_url: string, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>
      return sseResponse(ANTHROPIC_PLAIN_TEXT)
    }) as unknown as typeof fetch
    const brain = createPiBrain({ apiKey: 'secret-key', model: 'm', fetch })
    await collect(brain.run({ system: 's', messages: [] }, noop))
    const serialized = JSON.stringify(headers).toLowerCase()
    expect(serialized).not.toContain('claude-cli')
    expect(serialized).not.toContain('claude-code')
    expect(headers['x-api-key']).toBe('secret-key')
  })
})

describe('createPiBrain retries', () => {
  it('retries a 429 then succeeds', async () => {
    const { fetch, calls } = stubFetch([
      new Response(null, { status: 429 }),
      sseResponse(ANTHROPIC_PLAIN_TEXT),
    ])
    const brain = createPiBrain({
      apiKey: 'k',
      model: 'm',
      fetch,
      retry: { retries: 2, baseDelayMs: 0, sleep: () => Promise.resolve() },
    })
    const ev = await collect(brain.run({ system: 's', messages: [] }, noop))
    expect(calls.length).toBe(2)
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'done' })
  })

  it('does not retry a 401 and ends with error', async () => {
    const { fetch, calls } = stubFetch([
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
      sseResponse(ANTHROPIC_PLAIN_TEXT),
    ])
    const brain = createPiBrain({
      apiKey: 'bad',
      model: 'm',
      fetch,
      retry: { retries: 2, baseDelayMs: 0, sleep: () => Promise.resolve() },
    })
    const ev = await collect(brain.run({ system: 's', messages: [] }, noop))
    expect(calls.length).toBe(1)
    expect(ev).toEqual([{ kind: 'turn_end', stop: 'error' }])
  })
})

describe('createPiBrain ready()', () => {
  it('is ready with a key and not without', async () => {
    expect(await createPiBrain({ apiKey: 'k', model: 'm' }).ready()).toBe(true)
    expect(await createPiBrain({ apiKey: '  ', model: 'm' }).ready()).toBe(false)
    expect(await createPiBrain({ apiKey: '', model: 'm' }).ready()).toBe(false)
  })
})

describe('createPiBrain (openai)', () => {
  const OPENAI_TEXT_THEN_TOOL = [
    'data: {"choices":[{"delta":{"content":"Let me compute. "}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"code","arguments":"{\\"expr\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"2+2\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  ]

  it('maps an OpenAI-compatible stream to text, tool_call, turn_end tool', async () => {
    const { fetch, calls } = stubFetch([sseResponse(OPENAI_TEXT_THEN_TOOL)])
    const provider: ProviderName = 'openai'
    const brain = createPiBrain({ apiKey: 'k', model: 'm', provider, fetch })
    const ev = await collect(brain.run({ system: 's', messages: [{ role: 'user', content: 'go' }] }, noop))

    const toolCall = ev.find((e) => e.kind === 'tool_call')
    if (toolCall?.kind === 'tool_call') {
      expect(toolCall.call.name).toBe('code')
      expect(toolCall.call.id).toBe('call_1')
      expect(toolCall.call.args).toEqual({ expr: '2+2' })
    }
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'tool' })

    // OpenAI shape: a system message rather than a top-level system field, and function-typed tools.
    const body = calls[0]?.body as {
      messages: Array<{ role: string; content: string }>
      tools: Array<{ type: string; function: { name: string } }>
    }
    expect(body.messages[0]).toEqual({ role: 'system', content: 's' })
    expect(body.tools.every((t) => t.type === 'function')).toBe(true)
    expect(body.tools.map((t) => t.function.name)).toContain('code')
    expect(String(calls[0]?.url)).toContain('/chat/completions')
  })
})
