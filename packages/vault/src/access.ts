// The access gate: may the agent trigger a fill of this item right now? Pure and total, like the autonomy gate in
// @dool2/core. It answers a yes/no about whether a fill may happen; it never returns the secret. `never` always
// wins, and a per-item policy overrides the account default.

import type { AgentAccessPolicy, VaultItem } from './types.js'

export interface AccessState {
  /** Whether the user currently has the vault unlocked. */
  unlocked: boolean
}

/** Resolve the effective policy: the per-item override if set, otherwise the account default. */
export function effectivePolicy(item: VaultItem, accountDefault: AgentAccessPolicy): AgentAccessPolicy {
  return item.accessPolicy ?? accountDefault
}

/**
 * Whether the agent may use (fill) this item.
 * - never: never
 * - always: yes
 * - while-unlocked: only while the vault is unlocked
 *
 * `accountDefault` is the account's default policy; the item may override it.
 */
export function canAgentUse(item: VaultItem, accountDefault: AgentAccessPolicy, state: AccessState): boolean {
  switch (effectivePolicy(item, accountDefault)) {
    case 'never':
      return false
    case 'always':
      return true
    case 'while-unlocked':
      return state.unlocked
  }
}
