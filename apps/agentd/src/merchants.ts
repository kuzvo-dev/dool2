// Merchant memory (ADR 0047): a simple record of the merchants the user has paid before, so `merchantKnown` is a
// fact, not a guess. A first-time merchant is unknown, so full-auto still raises one phone-signed approval card even
// under the cap (T35 — a prompt injection cannot pay a brand-new recipient silently). After that first, signed pay to
// a merchant runs, the merchant becomes known and later pays to it run within the cap without a card.
//
// Kept in memory for now; `snapshot()` / the constructor's initial set are the seam to persist and reload it later.

/**
 * Normalize a raw merchant reference to a stable key. A URL (or bare host) reduces to its host without a leading
 * `www.`; anything else is lower-cased and trimmed. So "https://www.Shop.example.com/checkout" and "shop.example.com"
 * are the same merchant.
 */
export function normalizeMerchant(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (!s) return s
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`)
    return u.host.replace(/^www\./, '')
  } catch {
    return s
  }
}

/** The in-memory set of known merchants, keyed by their normalized id. */
export class MerchantMemory {
  readonly #known: Set<string>

  constructor(initial: Iterable<string> = []) {
    this.#known = new Set([...initial].map(normalizeMerchant).filter(Boolean))
  }

  /** Whether this merchant has been paid before. */
  has(raw: string): boolean {
    return this.#known.has(normalizeMerchant(raw))
  }

  /** Record that this merchant has now been paid (called only when a pay to it actually ran). */
  remember(raw: string): void {
    const key = normalizeMerchant(raw)
    if (key) this.#known.add(key)
  }

  /** The known-merchant keys, for persistence or display. */
  snapshot(): string[] {
    return [...this.#known]
  }
}
