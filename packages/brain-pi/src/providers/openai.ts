// The OpenAI-compatible provider, so the same adapter works against any Chat Completions endpoint (a gateway or a
// self-hosted model) with the user's own key. It builds a streaming /chat/completions request, declares the core
// tools as functions, and converts the chunk deltas into TurnEvents. Function-call arguments arrive split across
// chunks, so they are accumulated by index and emitted once the stream ends.

import type { ToolCall, ToolName, ToolSpec, TurnEvent, TurnInput } from '@dool2/core'
import type { BuildRequestArgs, Provider, ProviderRequest } from '../types.js'

interface WireMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function toWireMessages(input: TurnInput): WireMessage[] {
  const out: WireMessage[] = []
  if (input.system) out.push({ role: 'system', content: input.system })
  for (const m of input.messages) {
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user'
    out.push({ role, content: m.content })
  }
  return out
}

function toWireTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
  }))
}

function buildRequest(args: BuildRequestArgs): ProviderRequest {
  const body = {
    model: args.model,
    max_tokens: args.maxTokens,
    stream: true,
    messages: toWireMessages(args.input),
    tools: toWireTools(args.tools),
  }
  return {
    url: `${args.baseUrl.replace(/\/$/, '')}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify(body),
  }
}

interface OpenAIChunk {
  error?: { message?: string }
  choices?: Array<{
    finish_reason?: string | null
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
}

interface PendingTool {
  id: string
  name: string
  args: string
}

function parseArgs(json: string): unknown {
  const text = json.trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

async function* parseStream(events: AsyncIterable<unknown>): AsyncGenerator<TurnEvent> {
  const pending = new Map<number, PendingTool>()
  let errored = false

  for await (const raw of events) {
    const chunk = raw as OpenAIChunk
    if (chunk.error) {
      errored = true
      continue
    }
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (!delta) continue

    if (delta.content) yield { kind: 'text', text: delta.content }
    if (delta.reasoning_content) yield { kind: 'thinking', text: delta.reasoning_content }

    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0
      const slot = pending.get(idx) ?? { id: '', name: '', args: '' }
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name = tc.function.name
      if (tc.function?.arguments) slot.args += tc.function.arguments
      pending.set(idx, slot)
    }
  }

  const calls = [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
  for (const p of calls) {
    const call: ToolCall = { id: p.id, name: (p.name || 'code') as ToolName, args: parseArgs(p.args) }
    yield { kind: 'tool_call', call }
  }

  if (errored) yield { kind: 'turn_end', stop: 'error' }
  else yield { kind: 'turn_end', stop: calls.length > 0 ? 'tool' : 'done' }
}

export const openaiProvider: Provider = {
  name: 'openai',
  defaultBaseUrl: 'https://api.openai.com/v1',
  buildRequest,
  parseStream,
}
