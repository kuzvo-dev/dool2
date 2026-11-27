// The model list on the API key form: the models the runner can use with the chosen company, with OpenRouter's public
// prices, cheapest first and Dool2's pick on top. People who pay per use came for cheap models, and the fixed list had
// two to three expensive ones per company (first-run test 11-26). OpenRouter's list is public (no key), and the prices
// of other companies' models are read from it under that company's name ("anthropic/claude-haiku-5.5").
import type { PaygModel, PaygProvider } from '@dool2/protocol'

export interface Priced {
  name: string
  inPerM: number
  outPerM: number
  tools: boolean
}

type Fetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>

const PRICES_URL = 'https://openrouter.ai/api/v1/models'
const DAY = 24 * 3600_000

/** Dool2's pick per company: cheap, and good enough at tool use for everyday errands */
export const PAYG_PICKS: Record<string, string> = {
  openrouter: '~z-ai/glm-latest',
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-5.4-mini',
  google: 'gemini-3.8-flash',
}

/** OpenRouter's name for a company's own model id (claude-haiku-5-5 → anthropic/claude-haiku-5.5) */
export function priceKey(provider: string, id: string): string {
  if (provider === 'openrouter') return id
  return `${provider}/${id.replace(/(\d)-(\d)/g, '$1.$2')}`
}

export function readPrices(body: unknown): Map<string, Priced> {
  const out = new Map<string, Priced>()
  const data = (body as { data?: unknown[] } | undefined)?.data
  if (!Array.isArray(data)) return out
  for (const m of data as {
    id?: string
    name?: string
    pricing?: { prompt?: string; completion?: string }
    supported_parameters?: string[]
  }[]) {
    if (typeof m.id !== 'string') continue
    const inPerM = Number(m.pricing?.prompt) * 1e6
    const outPerM = Number(m.pricing?.completion) * 1e6
    if (!Number.isFinite(inPerM) || !Number.isFinite(outPerM) || inPerM < 0 || outPerM < 0) continue
    out.set(m.id, {
      // "Z.ai: GLM Latest" → "GLM Latest"
      name: (m.name ?? m.id).replace(/^[^:]{1,30}:\s*/, ''),
      inPerM,
      outPerM,
      tools: (m.supported_parameters ?? []).includes('tools'),
    })
  }
  return out
}

/**
 * The provider's models: what the runner can use (or the fixed list when it cannot tell), priced where OpenRouter
 * knows the model, without models that cannot use tools (Dool2 works only through tools), Dool2's pick first, then
 * cheapest first. Batch and free variants are left out (slow queues, or the prompt may be logged)
 */
export function pricedModels(
  provider: PaygProvider,
  runnable: string[] | undefined,
  prices: Map<string, Priced>,
  limit = 150,
): PaygModel[] {
  const pick = PAYG_PICKS[provider.id]
  const fixed = new Map(provider.models.map((m) => [m.id, m]))
  const ids = [...new Set([...(runnable ?? []), ...fixed.keys()])].filter((id) => !/:(batch|free)$/.test(id))
  const list: PaygModel[] = []
  for (const id of ids) {
    const p = prices.get(priceKey(provider.id, id))
    if (p && !p.tools) continue
    // A model the runner did not list and OpenRouter does not price is kept only from the fixed list
    if (!p && !fixed.has(id)) continue
    list.push({
      id,
      label: fixed.get(id)?.label ?? p?.name ?? id,
      ...(p ? { inPerM: p.inPerM, outPerM: p.outPerM } : {}),
      ...(id === pick ? { recommended: true } : {}),
    })
  }
  const cost = (m: PaygModel) =>
    m.inPerM === undefined ? Number.POSITIVE_INFINITY : m.inPerM + m.outPerM! * 0.5
  list.sort((a, b) => Number(b.recommended ?? false) - Number(a.recommended ?? false) || cost(a) - cost(b))
  return list.slice(0, limit)
}

/** Keeps OpenRouter's price list for a day; an empty map when it cannot be read (the form still works) */
export function priceBook(fetcher: Fetch = fetch as unknown as Fetch) {
  let cached: { at: number; prices: Map<string, Priced> } | undefined
  return async (): Promise<Map<string, Priced>> => {
    if (cached && Date.now() - cached.at < DAY) return cached.prices
    try {
      const r = await fetcher(PRICES_URL, { signal: AbortSignal.timeout(10_000) })
      if (!r.ok) return cached?.prices ?? new Map()
      cached = { at: Date.now(), prices: readPrices(await r.json()) }
      return cached.prices
    } catch {
      return cached?.prices ?? new Map()
    }
  }
}
