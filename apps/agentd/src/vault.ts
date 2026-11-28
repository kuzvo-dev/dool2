// A simple in-memory vault for the v2 daemon, standing in for @dool2/vault's real secret store until it is wired.
// Its one job is to prove the boundary: the AI is only ever handed masked summaries (toAgentSummary), never a secret
// value. The daemon holds the full VaultItem (password, card number, TOTP seed) here, but the sandbox's `vault`
// bridge can only list masked summaries and act by opaque id — the secret is filled into the page by the daemon
// (fillLogin/fillTotp), so it never crosses into the sandbox or the model's transcript.

import type { VaultBridge, VaultItemSummary } from '@dool2/sandbox'
import { toAgentSummary, type VaultItem } from '@dool2/vault'

/** A minimal in-memory vault. Holds full items; only ever exposes masked summaries through {@link makeVaultBridge}. */
export class InMemoryVault {
  readonly #items: VaultItem[]
  /** Records the ids the daemon was asked to fill, so a smoke/test can see the fill happened without a secret. */
  readonly fills: { id: string; kind: 'login' | 'totp' }[] = []

  constructor(items: VaultItem[] = defaultVaultItems()) {
    this.#items = items
  }

  /** The masked view the AI may see (via @dool2/vault toAgentSummary). No secret field exists on the result. */
  summaries(): VaultItemSummary[] {
    // toAgentSummary returns the vault's own AgentItemSummary (id/kind/site?/username?/hasTotp/label?); the sandbox
    // bridge's VaultItemSummary is the narrower {id, site, username, hasTotp}. We down-project to it, defaulting the
    // optional site/username to '' — still no secret ever appears.
    return this.#items.map((item) => {
      const s = toAgentSummary(item)
      return { id: s.id, site: s.site ?? '', username: s.username ?? '', hasTotp: s.hasTotp }
    })
  }

  /** Find an item by its opaque id (daemon-side; the secret stays here). */
  find(id: string): VaultItem | undefined {
    return this.#items.find((i) => i.id === id)
  }

  /** The daemon fills the login secret into the page itself. Here we only record that it happened. */
  fillLogin(id: string): void {
    if (!this.find(id)) throw new Error(`No vault item ${id}`)
    this.fills.push({ id, kind: 'login' })
  }

  /** The daemon computes and types the TOTP code itself; the seed never leaves the vault. */
  fillTotp(id: string): void {
    const item = this.find(id)
    if (!item) throw new Error(`No vault item ${id}`)
    this.fills.push({ id, kind: 'totp' })
  }
}

/** A tiny seed so a fresh daemon has something to list. All values here are non-secret except the `secret` payloads. */
export function defaultVaultItems(): VaultItem[] {
  return [
    {
      id: 'vlt_naver',
      kind: 'login',
      site: 'naver.com',
      username: 'user@example.com',
      label: 'Naver',
      secret: { password: 'not-a-real-password', totpSecret: 'JBSWY3DPEHPK3PXP' },
    },
    {
      id: 'vlt_coupang',
      kind: 'login',
      site: 'coupang.com',
      username: 'shopper',
      label: 'Coupang',
      secret: { password: 'not-a-real-password' },
    },
  ]
}

/**
 * Build the sandbox `vault` {@link VaultBridge} over an {@link InMemoryVault}. `listItems` returns masked summaries;
 * `fillLogin`/`fillTotp` act by id and resolve to nothing. By construction there is no method that returns a secret.
 */
export function makeVaultBridge(vault: InMemoryVault): VaultBridge {
  return {
    async listItems(): Promise<VaultItemSummary[]> {
      return vault.summaries()
    },
    async fillLogin(id: string): Promise<void> {
      vault.fillLogin(id)
    },
    async fillTotp(id: string): Promise<void> {
      vault.fillTotp(id)
    },
  }
}
