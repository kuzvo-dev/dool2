// Checks a pay-as-you-go API key with the AI company it belongs to before it is saved. First-run test (11-26): the word
// "undefined" was saved as an OpenRouter key and the screen said "connected"; the first message would have failed with
// nobody told why. The key goes only to that company's own address, and only a clear "not accepted" stops the save:
// no network, a timeout or another answer lets it through, so a slow line never blocks setup.

/** The company's answer to the key: ok, rejected (401/403), or unknown (could not tell) */
export type KeyCheck = 'ok' | 'rejected' | 'unknown'

type Fetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number }>

/** A cheap read that needs a valid key, per company */
function probe(provider: string, key: string): { url: string; headers: Record<string, string> } | undefined {
  if (provider === 'openrouter')
    return { url: 'https://openrouter.ai/api/v1/key', headers: { authorization: `Bearer ${key}` } }
  if (provider === 'openai')
    return { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${key}` } }
  if (provider === 'anthropic')
    return {
      url: 'https://api.anthropic.com/v1/models?limit=1',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    }
  if (provider === 'google')
    return {
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      headers: { 'x-goog-api-key': key },
    }
  return undefined
}

export async function checkPaygKey(
  provider: string,
  key: string,
  opts: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<KeyCheck> {
  const p = probe(provider, key.trim())
  if (!p) return 'unknown'
  const f = opts.fetch ?? (fetch as unknown as Fetch)
  try {
    const r = await f(p.url, { headers: p.headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) })
    if (r.status >= 200 && r.status < 300) return 'ok'
    // Google answers a bad key with 400 API_KEY_INVALID
    if (r.status === 401 || r.status === 403 || (provider === 'google' && r.status === 400)) return 'rejected'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
