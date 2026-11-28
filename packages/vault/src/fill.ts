// The fill path: how a secret leaves the vault. It goes straight into the page, through an interface the daemon
// implements against Dool2's hidden Chromium (ADR 0046). The secret value is passed from the vault to the filler
// and never returned to the caller or the AI. These functions return void — there is no shape here that could
// carry a secret back up to the model.

import { computeTotp } from './totp.js'
import type { LoginItem, TotpItem, VaultItem } from './types.js'

/**
 * The surface the daemon implements to put a value into the page. Implementations type into the real DOM field of
 * Dool2's own Chromium; the value never passes through the model. The vault calls these; it does not read back.
 */
export interface PageFiller {
  /** Type a value into the field matched by `selector`. */
  fillField(selector: string, value: string): Promise<void>
}

/** Where on the page a login's fields are. The selectors are not secret; the values filled into them are. */
export interface LoginFieldTargets {
  usernameSelector?: string
  passwordSelector: string
}

/**
 * Fill a login's username and password straight into the page. The password is read from the item and handed to
 * the filler; it is never returned. Callers gate this with canAgentUse + findLoginItemsForUrl first.
 */
export async function fillLogin(
  item: LoginItem,
  filler: PageFiller,
  targets: LoginFieldTargets,
): Promise<void> {
  if (item.username !== undefined && targets.usernameSelector !== undefined) {
    await filler.fillField(targets.usernameSelector, item.username)
  }
  await filler.fillField(targets.passwordSelector, item.secret.password)
}

/**
 * Compute the current TOTP code for an item and type it into the page. The vault computes the code from the seed it
 * holds; the AI never sees the seed and never sees the code — the vault types it directly.
 */
export async function fillTotp(
  item: LoginItem | TotpItem,
  filler: PageFiller,
  selector: string,
  atMs: number = Date.now(),
): Promise<void> {
  const seed = item.kind === 'totp' ? item.secret.totpSecret : item.secret.totpSecret
  if (seed === undefined) throw new Error('item has no TOTP seed')
  await filler.fillField(selector, computeTotp(seed, atMs))
}

/** Narrow a vault item to one that can produce a TOTP code (used before fillTotp). */
export function canFillTotp(item: VaultItem): item is LoginItem | TotpItem {
  if (item.kind === 'totp') return true
  return item.kind === 'login' && item.secret.totpSecret !== undefined
}
