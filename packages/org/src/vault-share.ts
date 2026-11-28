// Shared vault policy: a light seam for org-shared vaults, deciding which groups may use which items. This is the
// policy layer only — the keys, encryption and fill path stay in `@dool2/vault`, and the hard boundary (secrets never
// reach the AI) is unchanged. This check answers one question: given a member's groups, may they use this shared
// item? The real key hierarchy (org → team → vault → item) is built on top of this later (master plan workstream H).

import type { Member } from './identity.js'

/** A rule governing one shared vault: which groups may use it, optionally narrowed to specific items. */
export interface VaultShareRule {
  /** The shared vault this rule governs. */
  vaultId: string
  /** Group names allowed to use items in this vault. A member needs at least one of these. */
  allowedGroups: string[]
  /** When present and non-empty, restrict the rule to these item ids; otherwise it covers every item in the vault. */
  itemIds?: string[]
}

/** A reference to a shared vault item — the public identity only, never the secret value. */
export interface SharedVaultItem {
  itemId: string
  vaultId: string
}

/**
 * Decide whether `member` may use `item` under `rule`. Pure.
 *
 * Allowed only when: the item belongs to the rule's vault; the rule either covers all items or lists this item; and
 * the member is in at least one of the rule's allowed groups.
 */
export function canGroupUse(item: SharedVaultItem, rule: VaultShareRule, member: Member): boolean {
  if (item.vaultId !== rule.vaultId) return false
  if (rule.itemIds && rule.itemIds.length > 0 && !rule.itemIds.includes(item.itemId)) return false
  return member.groups.some((group) => rule.allowedGroups.includes(group))
}
