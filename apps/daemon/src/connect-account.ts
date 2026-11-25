// Which account a connection is (ADR 0041).
// A connection used to mean "some account is signed in". When Chrome was already signed in to another account, the
// connect flow saw a signed-in page, marked the service connected and never signed in the account the person typed
// (measured 2026-11-25: Gmail was "connected" in 4 seconds, then every mail search met Google's "Temporary Error (404)"
// because the typed account was not in Chrome). This module reads the account a page shows and compares it.
import type { ConnectCard } from '@dool2/protocol/connect'
import { sameAccount } from './auto-login.js'
import { ACCOUNT_SWITCH } from './region/kr/auto-login.js'
import { ROW, SIGNED_OUT, USE_ANOTHER } from './region/kr/connect-account-ui.js'

type Card = Pick<ConnectCard, 'id' | 'site' | 'account'>

export interface AccountBrowser {
  call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

/**
 * What the account page showed:
 * - match: the account asked for (or, when nothing was asked for, whoever is signed in: `who`)
 * - other: another account is signed in (`who`)
 * - none: the account asked for is not signed in to Chrome (its own address shows no account)
 * - unknown: the page showed no account we could read (page changed, not signed in, or no `account` on the card)
 */
export type AccountRead =
  | { state: 'match'; who: string }
  | { state: 'other'; who: string }
  | { state: 'none' }
  | { state: 'unknown' }

const GOOGLE = /(?:^|\.)(?:google\.com|gmail\.com)$/

/**
 * The account as the service writes it. Google needs the full address (with only an ID, /mail/u/ID/ gives a
 * "temporary error"), so a bare Google ID gets @gmail.com
 */
export function accountName(card: Pick<ConnectCard, 'site' | 'alsoSites'>, typed: string): string {
  const t = typed.trim()
  const google = [card.site, ...(card.alsoSites ?? [])].some((s) => s && GOOGLE.test(s))
  return google && t && !t.includes('@') ? `${t}@gmail.com` : t
}

/** The account page address, with {{account}} filled in ('0' = the browser's first account when none is asked for) */
export function accountPage(card: Card, account?: string): string | undefined {
  const url = card.account?.url
  if (!url) return undefined
  return url.replace(/\{\{account\}\}/g, encodeURIComponent(account || '0'))
}

/** Whether the card's account page addresses one account by itself ({{account}} in the address) */
export function perAccount(card: Card): boolean {
  return Boolean(card.account?.url.includes('{{account}}'))
}

/** The account a page shows, only when the page is on the account page's site (a sign-in or chooser page is not) */
export function accountIn(card: Card, page: { url: string; text: string }): string | undefined {
  const spec = card.account
  if (!spec) return undefined
  try {
    const want = new URL(spec.url.replace(/\{\{account\}\}/g, '0')).hostname
    if (new URL(page.url).hostname !== want) return undefined
    const m = new RegExp(spec.pattern).exec(page.text)
    const who = m?.[1]?.trim()
    return who ? who.slice(0, 120) : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the account a page shows is the one typed. Same text, a masked form of it (f***@gmail.com), or the ID part
 * of an email when only the ID was typed
 */
export function sameSignIn(typed: string, shown: string): boolean {
  const a = typed.trim().toLowerCase()
  const b = shown.trim().toLowerCase()
  if (!a || !b) return false
  if (sameAccount(a, b)) return true
  if (!a.includes('@') && b.includes('@')) return b.split('@')[0] === a
  if (a.includes('@') && !b.includes('@')) return a.split('@')[0] === b
  return false
}

/**
 * Opens the card's account page and reads who is signed in. With `expected`, says whether it is that account.
 * Closes the tab it opened
 */
export async function readAccount(
  browser: AccountBrowser,
  card: Card,
  expected?: string,
  opts: { wait?: number } = {},
): Promise<AccountRead> {
  const url = accountPage(card, expected)
  if (!url) return { state: 'unknown' }
  const opened = (await browser.call('open', { url }, 40_000)) as { tabId: number }
  try {
    let who: string | undefined
    // The account label is drawn a moment after the page (Gmail's bar), so look a few times
    for (let i = 0; i < 3 && !who; i++) {
      await new Promise((r) => setTimeout(r, opts.wait ?? 2_000))
      const page = (await browser.call('snapshot', { tabId: opened.tabId, maxChars: 30_000 }, 20_000)) as {
        url: string
        text: string
      }
      who = accountIn(card, page)
    }
    if (!who) return expected && perAccount(card) ? { state: 'none' } : { state: 'unknown' }
    if (!expected || sameSignIn(expected, who)) return { state: 'match', who }
    return { state: 'other', who }
  } finally {
    await browser.call('close', { tabId: opened.tabId }).catch(() => undefined)
  }
}

/** One account on a provider's account chooser (Google), as the snapshot reads it */
export interface ChooserAccount {
  /** Snapshot ref of its row (to press it when the person picks a signed-out account) */
  ref: string
  email: string
  /** Listed but signed out: needs the password again */
  signedOut: boolean
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/

/**
 * The accounts on Google's account chooser (measured: one link row per account with its name and email; a signed-out
 * one also says so). The "switch account" line of a confirm page is not an account
 */
export function chooserAccounts(text: string): ChooserAccount[] {
  const out: ChooserAccount[] = []
  for (const m of text.matchAll(ROW)) {
    const name = m[2] ?? ''
    const email = EMAIL.exec(name)?.[0]
    if (!email || ACCOUNT_SWITCH.test(name) || out.some((a) => a.email === email)) continue
    out.push({ ref: m[1] as string, email, signedOut: SIGNED_OUT.test(name) })
  }
  return out
}

/** The chooser's "Use another account" row (to add an account that is not in Chrome yet) */
export function useAnotherRef(text: string): string | undefined {
  for (const m of text.matchAll(ROW)) if (USE_ANOTHER.test(m[2] ?? '')) return m[1]
  return undefined
}
