// Dool2 vault (ADR 0011). Login details live only in the secret store (the desktop app encrypts it with the OS keychain).
// The AI never gets the values: the browser_login tool only asks "fill this field", and the daemon checks the URL and
// hands the values straight to the extension.
import { randomUUID } from 'node:crypto'
import type { Lang } from '@dool2/i18n'
import type { VaultEntry } from '@dool2/protocol'
import { findCard } from '@dool2/protocol/connect-text'
import { vaultCopy } from './locales/vault.js'

export interface SecretStoreLike {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string | undefined): Promise<void>
}

interface Stored extends VaultEntry {
  password: string
}

const KEY = 'vault.entries'

/** Site address to save. https only (http too for test addresses on this PC). Errors are shown to people in `lang` */
export function vaultOrigin(raw: string, lang: Lang = 'ko'): string {
  let s = raw.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error(vaultCopy(lang).badUrl)
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:'))
    throw new Error(vaultCopy(lang).httpsOnly)
  return u.origin
}

export class Vault {
  constructor(
    private readonly secrets: SecretStoreLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Language for errors people read (bad site address). index.ts can set it from userLang(settings) */
  userLang: () => Lang = () => 'ko'

  private async load(): Promise<Stored[]> {
    const raw = await this.secrets.get(KEY)
    if (!raw) return []
    try {
      const v = JSON.parse(raw)
      return Array.isArray(v) ? (v as Stored[]) : []
    } catch {
      return []
    }
  }

  private async save(list: Stored[]) {
    await this.secrets.set(KEY, list.length ? JSON.stringify(list) : undefined)
  }

  /** The list without passwords */
  async list(): Promise<VaultEntry[]> {
    return (await this.load()).map(({ password: _p, ...e }) => e)
  }

  /** Same site and same ID: replaces the password */
  async add(input: { url: string; username: string; password: string }): Promise<VaultEntry> {
    const origin = vaultOrigin(input.url, this.userLang())
    const list = await this.load()
    const old = list.find((e) => e.origin === origin && e.username === input.username)
    const entry: Stored = old
      ? { ...old, password: input.password }
      : {
          id: randomUUID(),
          origin,
          username: input.username,
          password: input.password,
          createdAt: this.now().toISOString(),
        }
    await this.save([...list.filter((e) => e !== old), entry])
    const { password: _p, ...view } = entry
    return view
  }

  async remove(id: string): Promise<boolean> {
    const list = await this.load()
    const next = list.filter((e) => e.id !== id)
    if (next.length === list.length) return false
    await this.save(next)
    return true
  }

  /**
   * Used only inside the daemon: the entry whose origin exactly matches the current page.
   * If a site has several, the most recently added one (add puts new or changed entries last).
   * Returning the first one would keep trying the old wrong account even after the user fixed a mistyped ID
   */
  async findForOrigin(
    origin: string,
  ): Promise<{ id: string; username: string; password: string } | undefined> {
    const e = (await this.load()).findLast((x) => x.origin === origin)
    return e ? { id: e.id, username: e.username, password: e.password } : undefined
  }

  /**
   * Only when the user views it on a screen (phone or PC): one password (ADR 0026). Never goes to AI tools or logs.
   * The phone asks after a device lock check, and the daemon logs only the site in the activity log
   */
  async reveal(id: string): Promise<{ origin: string; username: string; password: string } | undefined> {
    const e = (await this.load()).find((x) => x.id === id)
    return e ? { origin: e.origin, username: e.username, password: e.password } : undefined
  }

  /** The user edits the ID and password (empty values are left unchanged) */
  async update(id: string, patch: { username?: string; password?: string }): Promise<VaultEntry | undefined> {
    const list = await this.load()
    const e = list.find((x) => x.id === id)
    if (!e) return undefined
    const username = patch.username?.trim()
    if (username) e.username = username.slice(0, 200)
    if (patch.password) e.password = patch.password.slice(0, 200)
    // Move the edited entry last: if a site has several, findForOrigin uses this one
    await this.save([...list.filter((x) => x !== e), e])
    const { password: _p, ...view } = e
    return view
  }

  /** Saves a new password Dool2 made (sign-up, password change). origin is already in origin form */
  async savePassword(origin: string, username: string, password: string) {
    await this.add({ url: origin, username, password })
  }

  async markUsed(id: string) {
    const list = await this.load()
    const e = list.find((x) => x.id === id)
    if (!e) return
    e.lastUsedAt = this.now().toISOString()
    await this.save(list)
  }
}

// ── AI tool vault_find: only which sites have a login in the vault. Never passwords, IDs masked ──

/** Connect cards used to name vault entries and to find them by name */
export interface VaultSiteCard {
  id: string
  name: string
  site?: string
  /** Whether it is connected */
  connected?: boolean
  /** If connected with social login, the provider name (for example "Kakao") */
  social?: string
}

/**
 * ID as shown to the AI: first letter for emails, first two letters otherwise
 * ("felix990810@gmail.com" → "f***@gmail.com", "duri1234" → "du******", "ab" → "a***")
 */
export function maskUsername(u: string): string {
  const s = u.trim()
  const m = /^([^@\s])[^@\s]*@(.+)$/.exec(s)
  if (m) return `${m[1]}***@${m[2]}`
  if (s.length <= 2) return `${s.slice(0, 1)}***`
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(Math.max(s.length - 2, 3), 6))}`
}

/** Site name to show: "https://www.coupang.com" → "coupang.com" */
function siteOf(origin: string): string {
  try {
    return new URL(origin).host.replace(/^www\./, '')
  } catch {
    return origin
  }
}

/** Whether it's the same site (subdomains included: login.coupang.com ↔ coupang.com) */
function sameSite(host: string, site: string): boolean {
  const s = site.replace(/^www\./, '')
  return host === s || host.endsWith(`.${s}`) || s.endsWith(`.${host}`)
}

/** YYYY-MM-DD in Korea time */
function day(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 'unknown date' : new Date(t + 9 * 3600_000).toISOString().slice(0, 10)
}

const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/**
 * Vault view (vault_find tool). Without query, every saved site; with query, yes or no for that site.
 * The entries come without passwords (Vault.list), and IDs are masked here too
 */
export function vaultSitesText(
  entries: VaultEntry[],
  opts: { query?: string; cards?: VaultSiteCard[] } = {},
): string {
  const cards = opts.cards ?? []
  const rows = entries
    .map((e) => {
      const host = siteOf(e.origin)
      return { e, host, card: cards.find((c) => c.site && sameSite(host, c.site)) }
    })
    .sort((x, y) => (y.e.lastUsedAt ?? y.e.createdAt).localeCompare(x.e.lastUsedAt ?? x.e.createdAt))
  const line = (r: (typeof rows)[number], i: number) =>
    [
      `${i + 1}. ${r.card ? `${r.card.name} · ` : ''}${r.host}`,
      `ID ${maskUsername(r.e.username)}`,
      r.e.lastUsedAt ? `last used ${day(r.e.lastUsedAt)}` : 'not used by Dool2 yet',
      `saved ${day(r.e.createdAt)}`,
    ].join(' · ')
  const safe =
    'Passwords are hidden even from Dool2 (the AI), and IDs are masked. Never ask for or tell a password in the chat.'
  const use =
    "When a login is needed, browser_login fills the vault values directly on that site's login screen (the values never come to Dool2). For services with a connect card, connect_ask logs in again with this account."

  const q = (opts.query ?? '').replace(/\s+/g, ' ').trim()
  if (!q) {
    if (!rows.length)
      return [
        'No logins saved in the vault.',
        'Next: if the service needs a login, show a connect card with connect_ask. The ID and password the user enters on the card are stored encrypted only in the vault on the PC. Never ask for a password in the chat.',
      ].join('\n')
    const shown = rows.slice(0, 30)
    return [
      `${rows.length} site(s) have a login saved in the vault${rows.length > shown.length ? ` (only the latest ${shown.length})` : ''}. ${safe}`,
      '',
      ...shown.map(line),
      '',
      `Next: ${use} The user saves and deletes logins in the Dool2 vault in the desktop app settings.`,
    ].join('\n')
  }

  // Find: pick the site by connect card name (e.g. Coupang) or address ("coupang.com"), otherwise by word
  let card = findCard(cards, q)
  let target = card?.site
  if (!target && /\.[a-z]{2,}/i.test(q)) {
    try {
      target = siteOf(vaultOrigin(q))
      card ??= cards.find((c) => c.site && target && sameSite(target, c.site))
    } catch {
      // Not an address: search by word
    }
  }
  const hit = rows.filter((r) =>
    target
      ? sameSite(r.host, target)
      : squash(r.host).includes(squash(q)) || (r.card ? squash(r.card.name).includes(squash(q)) : false),
  )
  const label = card ? `${card.name}(${card.site ?? card.id})` : `'${q}'`
  if (hit.length)
    return [
      `Yes, a login for ${label} is saved in the vault${hit.length > 1 ? ` (${hit.length} of them; Dool2 uses the most recently added one)` : ''}. ${safe}`,
      '',
      ...hit.map(line),
      '',
      `Next: ${use}`,
    ].join('\n')

  const others = rows.length
    ? `Sites saved in the vault (${rows.length}): ${rows
        .slice(0, 10)
        .map((r) => (r.card ? `${r.card.name}(${r.host})` : r.host))
        .join(', ')}${rows.length > 10 ? ' and more' : ''}.`
    : 'The vault is empty.'
  const conn = card?.connected
    ? card.social
      ? `But ${card.name} is connected with ${card.social} social login, so Dool2 logs in without the vault.`
      : `${card.name} is connected (logged in on Chrome on the PC). If the login expires, show the connect card then.`
    : ''
  const next = card?.social
    ? `Next: if the login expires, connect_ask("${card.id}") logs in again with ${card.social} social login. Never ask for a password in the chat.`
    : card
      ? `Next: when a login is needed, show the connect card with connect_ask("${card.id}"). The ID and password the user enters on the card are stored only in the vault on the PC. Never ask for a password in the chat.`
      : 'Next: for a site without a connect card, use browser_login on its login screen, and if it says the vault has nothing, show a login card with browser_request_login. If it is a service name, look for a connect card with connect_ask. Never ask for a password in the chat.'
  return [`No, there is no login for ${label} in the vault.${conn ? ` ${conn}` : ''}`, others, next].join(
    '\n',
  )
}
