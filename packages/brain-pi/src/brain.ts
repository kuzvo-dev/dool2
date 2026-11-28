// createPiBrain: a real brain that drives an LLM over an API key (the pi fork / API-key path). It maps a TurnInput
// to one provider request, streams the response, and converts the deltas into the shared TurnEvent shape. It keeps
// one turn per run: when the model calls a tool it yields the tool_call and ends with stop 'tool'; the daemon runs
// the tool, appends the result to the transcript, and calls run() again. The key stays in this adapter and is never
// logged. This is NOT the official-CLI path — no claude-cli user agent, no Claude Code client id.

import type { Brain } from '@dool2/brains'
import type { RunHandle, TurnEvent, TurnInput } from '@dool2/core'
import { TOOLS } from '@dool2/core'
import { anthropicProvider } from './providers/anthropic.js'
import { openaiProvider } from './providers/openai.js'
import { fetchWithRetry } from './retry.js'
import { parseSSE } from './sse.js'
import type { PiBrainOptions, Provider } from './types.js'

function pickProvider(name: PiBrainOptions['provider']): Provider {
  return name === 'openai' ? openaiProvider : anthropicProvider
}

export function createPiBrain(opts: PiBrainOptions): Brain {
  const provider = pickProvider(opts.provider)
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const baseUrl = opts.baseUrl ?? provider.defaultBaseUrl
  const tools = opts.tools ?? TOOLS
  const maxTokens = opts.maxTokens ?? 4096

  return {
    id: 'pi',
    label: 'Pi (API key)',

    async ready(): Promise<boolean> {
      // Offline-safe: a present, non-empty key is enough. No network probe, so startup never blocks or spends quota.
      return Boolean(opts.apiKey?.trim())
    },

    async *run(input: TurnInput, _handle: RunHandle): AsyncIterable<TurnEvent> {
      const controller = new AbortController()
      try {
        const req = provider.buildRequest({
          input,
          model: opts.model,
          tools,
          baseUrl,
          apiKey: opts.apiKey,
          maxTokens,
        })
        let res: Response
        try {
          res = await fetchWithRetry(fetchImpl, req, controller.signal, opts.retry)
        } catch {
          // Network error after the retries are spent.
          yield { kind: 'turn_end', stop: 'error' }
          return
        }
        if (!res.ok || !res.body) {
          // Auth/quota (401/403) and other non-retryable statuses land here, as do exhausted retries.
          await res.body?.cancel().catch(() => {})
          yield { kind: 'turn_end', stop: 'error' }
          return
        }
        yield* provider.parseStream(parseSSE(res.body))
      } catch {
        yield { kind: 'turn_end', stop: 'error' }
      } finally {
        // If the consumer stopped early (e.g. the daemon called handle.abort and broke the loop), cancel the fetch.
        controller.abort()
      }
    },
  }
}
