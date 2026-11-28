// Shared option and provider shapes for the pi brain (the API-key path). A provider knows how to turn a TurnInput
// into one HTTP request and how to convert that request's streamed response into the shared TurnEvent shape.

import type { ToolSpec, TurnEvent, TurnInput } from '@dool2/core'

export type ProviderName = 'anthropic' | 'openai'

/** How long to wait between transient-error retries, and how many times. Injectable sleep keeps tests offline. */
export interface RetryOptions {
  retries?: number
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface PiBrainOptions {
  /** The user's own API key. Stays in this adapter; never logged, never placed in a tool result. */
  apiKey: string
  /** Provider model id, e.g. an Anthropic or OpenAI-compatible model name. */
  model: string
  /** Override the provider base URL (e.g. an OpenAI-compatible gateway). Defaults to the provider's own. */
  baseUrl?: string
  /** Which request/stream shape to speak. Defaults to 'anthropic' (the maintainer uses Claude). */
  provider?: ProviderName
  /** Injected fetch for testing; defaults to the global fetch. */
  fetch?: typeof fetch
  /** The tool set to declare to the model. Defaults to the core TOOLS. */
  tools?: ToolSpec[]
  /** Max output tokens to request. Defaults to 4096. */
  maxTokens?: number
  /** Transient-error retry behaviour. */
  retry?: RetryOptions
}

export interface ProviderRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export interface BuildRequestArgs {
  input: TurnInput
  model: string
  tools: ToolSpec[]
  baseUrl: string
  apiKey: string
  maxTokens: number
}

/** A pluggable provider: one HTTP shape in, a stream of TurnEvents out. */
export interface Provider {
  readonly name: ProviderName
  readonly defaultBaseUrl: string
  buildRequest(args: BuildRequestArgs): ProviderRequest
  /** Convert already-parsed stream events into TurnEvents, ending with exactly one turn_end. */
  parseStream(events: AsyncIterable<unknown>): AsyncGenerator<TurnEvent>
}
