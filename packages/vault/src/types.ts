// The vault's data model. The one rule that shapes every type here: secrets never reach the AI (ADR 0011, 0023,
// 0047, threat T15/T22). A VaultItem keeps its secret payload in one `secret` field; everything else on the item is
// non-secret metadata the AI may see through `toAgentSummary`. The vault fills the secret into the page or the
// secure keypad itself (see fill.ts / payment.ts); it is never returned to the model.

/** The kinds of secret the vault holds. */
export type VaultItemKind = 'login' | 'card' | 'identity' | 'totp' | 'payment-pin'

/**
 * How much the agent may use an item without a person in the loop.
 * - always: the vault may fill it even while the vault is locked (rare; convenience logins)
 * - while-unlocked: the vault may fill it only while the user has the vault unlocked (the default)
 * - never: the agent may never trigger a fill; a person must do it
 *
 * Set as a per-account default and overridable per item.
 */
export type AgentAccessPolicy = 'always' | 'while-unlocked' | 'never'

/** Non-secret metadata shared by every item. None of these fields is a secret. */
export interface VaultItemMeta {
  /** Opaque, stable reference the AI uses to point at an item ("fill item vlt_7f3"). */
  id: string
  /** The site or app the item is bound to (origin or host). Used by URL binding. Not a secret. */
  site?: string
  /** The login name / account handle. Shown to the AI as a label; not a secret (the password is). */
  username?: string
  /** A user-given name for the item ("personal card"). Not a secret. */
  label?: string
  /** Per-item override of the account's default access policy. */
  accessPolicy?: AgentAccessPolicy
}

/** A website login. The password (and optional TOTP seed) are secret. */
export interface LoginItem extends VaultItemMeta {
  kind: 'login'
  secret: {
    password: string
    /** Base32 TOTP seed, when the login has 2FA. Secret; the vault computes the code, the AI never sees the seed. */
    totpSecret?: string
  }
}

/** A payment card. Every field of the secret is sensitive. */
export interface CardItem extends VaultItemMeta {
  kind: 'card'
  secret: {
    number: string
    expiry: string
    cvc: string
    holder?: string
  }
}

/** A stored identity value (for example a Korean resident registration number). */
export interface IdentityItem extends VaultItemMeta {
  kind: 'identity'
  secret: {
    value: string
  }
}

/** A standalone TOTP authenticator. Secret is the base32 seed. */
export interface TotpItem extends VaultItemMeta {
  kind: 'totp'
  secret: {
    totpSecret: string
  }
}

/**
 * The payment PIN typed into a site's secure keypad. Stored only in full-auto (ADR 0047); the vault types it into
 * the keypad, the AI never sees it. Removed when the user leaves full-auto.
 */
export interface PaymentPinItem extends VaultItemMeta {
  kind: 'payment-pin'
  secret: {
    pin: string
  }
}

export type VaultItem = LoginItem | CardItem | IdentityItem | TotpItem | PaymentPinItem

/** Whether an item carries a TOTP seed (login with 2FA, or a standalone authenticator). Non-secret: a yes/no only. */
export function hasTotp(item: VaultItem): boolean {
  if (item.kind === 'totp') return true
  if (item.kind === 'login') return item.secret.totpSecret !== undefined
  return false
}
