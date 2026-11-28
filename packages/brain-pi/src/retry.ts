// Retry only transient failures: a 429 (rate limit) or a 5xx, and network errors where fetch itself throws. Auth and
// quota problems (401/403) and other 4xx are returned as-is so the caller can end the turn with 'error' at once —
// retrying them only wastes the user's key. Backoff is exponential and the sleep is injectable so tests stay instant.

import type { ProviderRequest, RetryOptions } from './types.js'

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  req: ProviderRequest,
  signal: AbortSignal,
  options: RetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? 2
  const baseDelayMs = options.baseDelayMs ?? 250
  const sleep = options.sleep ?? defaultSleep

  let attempt = 0
  for (;;) {
    try {
      const res = await fetchImpl(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        signal,
      })
      if (res.ok || !isRetryableStatus(res.status) || attempt >= retries) return res
      // Drain the failed body before retrying so the connection can be reused.
      await res.body?.cancel().catch(() => {})
    } catch (err) {
      if (signal.aborted || attempt >= retries) throw err
    }
    await sleep(baseDelayMs * 2 ** attempt)
    attempt++
  }
}
