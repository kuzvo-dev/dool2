// A simple in-memory vault for the v2 daemon, standing in for @dool2/vault's full secret store until it is wired.
// Its one job is to prove the boundary AND do a real fill: the AI is only ever handed masked summaries
// (toAgentSummary) and acts by opaque id; the daemon holds the full VaultItem (password, card number, TOTP seed, PIN)
// here and types the secret straight into the page through the page bridge's `fill` — a secret never crosses into the
// sandbox or the model's transcript (ADR 0011/0023/0047, threat T15/T22). The fill reuses @dool2/vault's own
// fillLogin/fillTotp/fillPaymentPin, so the secret-handling logic lives in one place.

import type { AutonomyLevel } from '@dool2/core'
import type { PageBridge, PageSnapshot, VaultBridge, VaultItemSummary } from '@dool2/sandbox'
import type { LoginFieldHint, LoginHints, SkillMeta } from '@dool2/skill-sdk'
import { resolveSkills } from '@dool2/skill-sdk'
import {
  type AgentAccessPolicy,
  canAgentUse,
  canFillTotp,
  findLoginItemsForUrl,
  type LoginFieldTargets,
  type PageFiller,
  paymentPinAvailable,
  type SecureKeypad,
  toAgentSummary,
  type UrlBindingSettings,
  urlMatchesSite,
  type VaultItem,
  fillLogin as vaultFillLogin,
  fillPaymentPin as vaultFillPaymentPin,
  fillTotp as vaultFillTotp,
} from '@dool2/vault'

/** A minimal in-memory vault. Holds full items; only ever exposes masked summaries through {@link makeVaultBridge}. */
export class InMemoryVault {
  readonly #items: VaultItem[]
  /** Records the ids actually filled, so a smoke/test can see the fill happened without a secret appearing. */
  readonly fills: { id: string; kind: 'login' | 'totp' | 'payment-pin' }[] = []

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

  /**
   * Every item, daemon-side only. Used for URL binding (which reads the non-secret `site`); these full items never
   * cross into the sandbox or the transcript — the bridge reads them here and types secrets straight into the page.
   */
  all(): readonly VaultItem[] {
    return this.#items
  }

  /** Note that a fill happened (for inspection); the secret is not recorded, only the id and kind. */
  recordFill(id: string, kind: 'login' | 'totp' | 'payment-pin'): void {
    this.fills.push({ id, kind })
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

/** Build a PageFiller that types a value into a field by ref, preferring the secret-safe `fill` over `type`. */
function pageFiller(page: PageBridge): PageFiller {
  return {
    async fillField(ref: string, value: string): Promise<void> {
      if (page.fill) await page.fill(ref, value)
      else await page.type(ref, value)
    },
  }
}

const matches = (node: PageSnapshot['nodes'][number], re: RegExp): boolean =>
  re.test(node.name ?? '') || re.test(node.role)

// These heuristics match field labels in English only (ADR 0029 keeps code English). Site-specific names, including
// Korean ones, are the job of a site skill (skills/<id>), which pins the exact fields; this is the broad-hand fallback
// for a page no skill covered.

/**
 * Find the login fields on a page from its snapshot. Heuristic for v2 — a password field, plus a username/email field
 * that is not the password. A site skill will later pin exact fields; this is the broad-hand fallback.
 */
function findLoginFields(snapshot: PageSnapshot): LoginFieldTargets | undefined {
  const pw = snapshot.nodes.find((n) => matches(n, /pass(word)?|pwd/iu))
  if (!pw) return undefined
  const user = snapshot.nodes.find(
    (n) => n.ref !== pw.ref && matches(n, /e-?mail|user|login|\bid\b|textbox/iu),
  )
  return { passwordSelector: pw.ref, ...(user ? { usernameSelector: user.ref } : {}) }
}

/** Find a one-time-code / TOTP field on a page from its snapshot. */
function findTotpField(snapshot: PageSnapshot): string | undefined {
  return snapshot.nodes.find((n) => matches(n, /otp|totp|one-?time|\bcode\b|2fa|verification/iu))?.ref
}

/** Find the payment PIN / secure-keypad field on a page from its snapshot. */
function findPinField(snapshot: PageSnapshot): string | undefined {
  return snapshot.nodes.find((n) => matches(n, /\bpin\b|keypad/iu))?.ref
}

// --- site-skill field hints --------------------------------------------------
// A site skill (skills/<id>) may carry a `login` block that pins the exact fields for its site, including Korean
// label names that the English heuristic above cannot see. The hints are data, not secrets; the
// vault resolves them to a page ref here and types the secret into that ref. This is the preferred path; the heuristic
// stays as the broad-hand fallback for a page no skill covered (ADR 0045).

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Resolve one field hint to a page ref. A `selector` is used as-is (a snapshot ref, matched exactly when present, else
 * passed straight through as a CSS selector/ref). Otherwise the `name`/`role` hint matches a snapshot node by its
 * accessible name (substring, case-insensitive, Unicode so Korean matches) and/or its role.
 */
function resolveHint(snapshot: PageSnapshot, hint: LoginFieldHint): string | undefined {
  if (hint.selector !== undefined) {
    const byRef = snapshot.nodes.find((n) => n.ref === hint.selector)
    return byRef ? byRef.ref : hint.selector
  }
  const nameRe = hint.name !== undefined ? new RegExp(escapeRegExp(hint.name), 'iu') : undefined
  const roleRe = hint.role !== undefined ? new RegExp(`^${escapeRegExp(hint.role)}$`, 'iu') : undefined
  if (!nameRe && !roleRe) return undefined
  const node = snapshot.nodes.find((n) => {
    const nameOk = nameRe ? nameRe.test(n.name ?? '') : true
    const roleOk = roleRe ? roleRe.test(n.role) : true
    return nameOk && roleOk
  })
  return node?.ref
}

/** Build login field targets from a skill's `login` hints. Needs at least a resolvable password field. */
function loginTargetsFromHints(snapshot: PageSnapshot, login: LoginHints): LoginFieldTargets | undefined {
  if (!login.password) return undefined
  const passwordSelector = resolveHint(snapshot, login.password)
  if (passwordSelector === undefined) return undefined
  const usernameSelector = login.username ? resolveHint(snapshot, login.username) : undefined
  return { passwordSelector, ...(usernameSelector !== undefined ? { usernameSelector } : {}) }
}

/** The `login` hints of the best site skill that matches `url` (by URL glob) and carries a login block, if any. */
function skillLoginForUrl(skills: readonly SkillMeta[], url: string): LoginHints | undefined {
  if (!url) return undefined
  for (const scored of resolveSkills({ url }, skills as SkillMeta[])) {
    if (scored.skill.login) return scored.skill.login
  }
  return undefined
}

export interface VaultBridgeDeps {
  /** The page to fill secrets into (the real hidden browser, or a fake in tests). */
  page: PageBridge
  /** The current autonomy level, read at call time so the payment-PIN guard reflects the live session (ADR 0047). */
  level: () => AutonomyLevel
  /**
   * Site skills with optional `login` field hints. Read at call time so a freshly downloaded pack is seen. The bridge
   * picks the skill whose URL glob matches the tab and that carries a `login` block, and uses its hints to locate the
   * fields (Korean names included). Defaults to none — then the English heuristic is the only field-finder.
   */
  skills?: () => readonly SkillMeta[]
  /**
   * The account's default agent-access policy (ADR 0023/0047). A `never` item is never filled; `while-unlocked` needs
   * the vault unlocked; `always` fills regardless. A per-item policy overrides this. Defaults to 'while-unlocked'.
   */
  accessPolicy?: () => AgentAccessPolicy
  /** Whether the vault is currently unlocked. Defaults to () => true (unlocked). */
  unlocked?: () => boolean
  /** Extra equivalent-domain groups for URL binding; the built-in Korean groups (ADR 0029) always apply. */
  urlBinding?: UrlBindingSettings
}

/**
 * Build the sandbox `vault` {@link VaultBridge} over an {@link InMemoryVault}. `listItems` returns masked summaries;
 * `fillLogin`/`fillTotp`/`fillPaymentPin` act by id and resolve to nothing. By construction there is no method that
 * returns a secret: each fill reads the secret daemon-side and types it into the page through the page bridge, so the
 * value never crosses into the sandbox or the transcript.
 */
export function makeVaultBridge(vault: InMemoryVault, deps: VaultBridgeDeps): VaultBridge {
  const { page } = deps
  const skills = (): readonly SkillMeta[] => deps.skills?.() ?? []
  const accessPolicy = (): AgentAccessPolicy => deps.accessPolicy?.() ?? 'while-unlocked'
  const unlocked = (): boolean => deps.unlocked?.() ?? true
  const urlBinding = deps.urlBinding ?? {}

  /**
   * The two gates every agent-triggered fill must pass, bound to the tab's REAL url (never one the AI claims):
   *  - URL binding: the item's site must match the tab host (http(s) only, equivalent-domains aware) — stops a page
   *    from coaxing out another site's login (threat T15/T22).
   *  - access policy: `never` refuses; `while-unlocked` needs the vault unlocked (ADR 0023/0047).
   * Throws (refuses) when either fails; the message says why. Never returns or logs a secret.
   */
  const assertFillAllowed = (item: VaultItem, tabUrl: string): void => {
    const site = item.site
    if (site === undefined || !urlMatchesSite(tabUrl, site, urlBinding)) {
      throw new Error(
        `Vault item ${item.id} is not bound to ${tabUrl || 'this page'} — a login fills only on its own site, over http(s).`,
      )
    }
    if (!canAgentUse(item, accessPolicy(), { unlocked: unlocked() })) {
      throw new Error(
        `Vault item ${item.id} may not be filled by the agent right now (access policy ${item.accessPolicy ?? accessPolicy()}).`,
      )
    }
  }

  return {
    async listItems(): Promise<VaultItemSummary[]> {
      return vault.summaries()
    },

    async fillLogin(id: string): Promise<void> {
      const item = vault.find(id)
      if (!item || item.kind !== 'login') throw new Error(`No login vault item ${id}`)
      const snapshot = await page.snapshot()
      // URL binding (ADR spec): the item must be among the login items this tab's REAL url allows — http(s) only,
      // equivalent-domains aware — so a page cannot coax out another site's login (threat T15/T22).
      const allowed = findLoginItemsForUrl(snapshot.url, vault.all(), urlBinding)
      if (!allowed.some((i) => i.id === id)) {
        throw new Error(
          `Vault item ${id} is not bound to ${snapshot.url || 'this page'} — a login fills only on its own site, over http(s).`,
        )
      }
      // Access policy: `never` refuses; `while-unlocked` needs the vault unlocked (ADR 0023/0047).
      if (!canAgentUse(item, accessPolicy(), { unlocked: unlocked() })) {
        throw new Error(
          `Vault item ${id} may not be filled by the agent right now (access policy ${item.accessPolicy ?? accessPolicy()}).`,
        )
      }
      // Prefer the matched site skill's field hints (Korean names included); fall back to the English heuristic.
      const login = skillLoginForUrl(skills(), snapshot.url)
      const targets =
        (login ? loginTargetsFromHints(snapshot, login) : undefined) ?? findLoginFields(snapshot)
      if (!targets) throw new Error(`No login fields found on ${snapshot.url} to fill ${id} into`)
      // @dool2/vault types username then password straight into the page; nothing flows back to the caller.
      await vaultFillLogin(item, pageFiller(page), targets)
      // Click the submit button when the skill pins one, so the login actually goes through. This is a sub-step of the
      // already-gated vault.fillLogin, so it is not separately reported to the autonomy gate (same note as page.fill).
      const submitRef = login?.submit ? resolveHint(snapshot, login.submit) : undefined
      if (submitRef !== undefined) await page.click(submitRef)
      vault.recordFill(id, 'login')
    },

    async fillTotp(id: string): Promise<void> {
      const item = vault.find(id)
      if (!item || !canFillTotp(item)) throw new Error(`No TOTP for vault item ${id}`)
      const snapshot = await page.snapshot()
      // A TOTP is a login's second factor: same URL binding + access gate, bound to the real tab URL.
      assertFillAllowed(item, snapshot.url)
      // Prefer the site skill's totp hint; fall back to the English one-time-code heuristic.
      const login = skillLoginForUrl(skills(), snapshot.url)
      const selector =
        (login?.totp ? resolveHint(snapshot, login.totp) : undefined) ?? findTotpField(snapshot)
      if (!selector) throw new Error(`No one-time-code field found on ${snapshot.url} to fill ${id} into`)
      // @dool2/vault computes the code with computeTotp and types it; the AI never sees seed or code.
      await vaultFillTotp(item, pageFiller(page), selector)
      vault.recordFill(id, 'totp')
    },

    async fillPaymentPin(id: string): Promise<void> {
      const item = vault.find(id)
      if (!item || item.kind !== 'payment-pin') throw new Error(`No payment-PIN vault item ${id}`)
      // Guard first (ADR 0047): refuse outside full-auto before even reading the page, so the refusal never depends on
      // a field being present. @dool2/vault fillPaymentPin re-checks this, so the guard is enforced in one place too.
      if (!paymentPinAvailable(item, deps.level())) {
        throw new Error('payment PIN is available only in full-auto (ADR 0047)')
      }
      const snapshot = await page.snapshot()
      const selector = findPinField(snapshot)
      if (!selector) throw new Error(`No secure-keypad field found on ${snapshot.url} to fill ${id} into`)
      const keypad: SecureKeypad = {
        async typePin(pin: string): Promise<void> {
          if (page.fill) await page.fill(selector, pin)
          else await page.type(selector, pin)
        },
      }
      await vaultFillPaymentPin(item, keypad, deps.level())
      vault.recordFill(id, 'payment-pin')
    },
  }
}
