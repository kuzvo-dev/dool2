// The Anthropic Messages API provider (the maintainer's default). It builds a streaming /v1/messages request,
// declares the core tools as Anthropic tools, and converts the SSE deltas into TurnEvents. This is the plain
// API-key path: it sends only `x-api-key` and the public `anthropic-version`, never a Claude Code client id or a
// claude-cli user agent — it does not impersonate the official CLI.

import type { ToolCall, ToolName, ToolSpec, TurnEvent, TurnInput } from '@dool2/core'
import type { BuildRequestArgs, Provider, ProviderRequest } from '../types.js'

const ANTHROPIC_VERSION = '2023-06-01'

interface WireMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Map our plain transcript to Anthropic's. Tool results ride as user turns; consecutive same-role turns merge. */
function toWireMessages(input: TurnInput): WireMessage[] {
  const out: WireMessage[] = []
  for (const m of input.messages) {
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user'
    const last = out.at(-1)
    if (last && last.role === role) last.content += `\n\n${m.content}`
    else out.push({ role, content: m.content })
  }
  return out
}

function toWireTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { type: 'object', additionalProperties: true },
  }))
}

function buildRequest(args: BuildRequestArgs): ProviderRequest {
  const body = {
    model: args.model,
    max_tokens: args.maxTokens,
    stream: true,
    system: args.input.system,
    messages: toWireMessages(args.input),
    tools: toWireTools(args.tools),
  }
  return {
    url: `${args.baseUrl.replace(/\/$/, '')}/v1/messages`,
    headers: {
      'content-type': 'application/json',
      'x-api-key': args.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  }
}

interface AnthropicEvent {
  type?: string
  content_block?: { type?: string; id?: string; name?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  error?: { message?: string }
}

interface PendingTool {
  id: string
  name: string
  json: string
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
  let pending: PendingTool | undefined
  let toolCalls = 0
  let errored = false

  for await (const raw of events) {
    const e = raw as AnthropicEvent
    switch (e.type) {
      case 'content_block_start': {
        const block = e.content_block
        if (block?.type === 'tool_use') {
          pending = { id: block.id ?? '', name: block.name ?? 'code', json: '' }
        }
        break
      }
      case 'content_block_delta': {
        const d = e.delta
        if (d?.type === 'text_delta' && d.text) yield { kind: 'text', text: d.text }
        else if (d?.type === 'thinking_delta' && d.thinking) yield { kind: 'thinking', text: d.thinking }
        else if (d?.type === 'input_json_delta' && pending) pending.json += d.partial_json ?? ''
        break
      }
      case 'content_block_stop': {
        if (pending) {
          const call: ToolCall = {
            id: pending.id,
            name: pending.name as ToolName,
            args: parseArgs(pending.json),
          }
          toolCalls++
          yield { kind: 'tool_call', call }
          pending = undefined
        }
        break
      }
      case 'error': {
        errored = true
        break
      }
      default:
        break
    }
  }

  if (errored) yield { kind: 'turn_end', stop: 'error' }
  else yield { kind: 'turn_end', stop: toolCalls > 0 ? 'tool' : 'done' }
}

export const anthropicProvider: Provider = {
  name: 'anthropic',
  defaultBaseUrl: 'https://api.anthropic.com',
  buildRequest,
  parseStream,
}
