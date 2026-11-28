// The only view of a vault item the AI is ever handed. It is a closed shape with no secret field, so a secret
// cannot leak through it even by accident: there is no key on `AgentItemSummary` to put a password, card number,
// PIN or TOTP seed into. The AI points back at the real item through the opaque `id`; the vault does the fill.

import { hasTotp, type VaultItem, type VaultItemKind } from './types.js'

/** What the AI may see about a vault item. No secret field exists on this type. */
export interface AgentItemSummary {
  /** Opaque reference to the item; carries no secret. */
  id: string
  kind: VaultItemKind
  /** The bound site/host, when known. */
  site?: string
  /** The login name / account handle (not the password). */
  username?: string
  /** Whether a TOTP code can be produced for this item — a yes/no, never the seed. */
  hasTotp: boolean
  /** The user-given label, when set. */
  label?: string
}

/**
 * Project a vault item down to what the AI may see. Returns only id/kind/site/username/hasTotp/label — never the
 * `secret` payload. This is the boundary function: the daemon passes summaries to the model, never `VaultItem`.
 */
export function toAgentSummary(item: VaultItem): AgentItemSummary {
  const summary: AgentItemSummary = {
    id: item.id,
    kind: item.kind,
    hasTotp: hasTotp(item),
  }
  if (item.site !== undefined) summary.site = item.site
  if (item.username !== undefined) summary.username = item.username
  if (item.label !== undefined) summary.label = item.label
  return summary
}

/** Map a whole set of items to summaries for the AI. */
export function toAgentSummaries(items: readonly VaultItem[]): AgentItemSummary[] {
  return items.map(toAgentSummary)
}
