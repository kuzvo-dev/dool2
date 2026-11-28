// URL binding: a login is offered only on the site it belongs to, matched against the tab's real URL — never a URL
// the AI claims. This blocks a page from coaxing a fill for another site's credentials (threat T15/T22). Matching
// is host-based with an equivalent-domains table for sites that share one account. http(s) only: a non-http URL
// (javascript:, data:, file:, ...) never matches anything (fail closed).

import { KR_EQUIVALENT_DOMAINS } from './region/kr/domains.js'
import type { LoginItem, VaultItem } from './types.js'

/** Global (non-Korean) equivalent-domain groups. Korean groups live in region/kr/domains.ts. */
export const GLOBAL_EQUIVALENT_DOMAINS: readonly (readonly string[])[] = [
  ['apple.com', 'icloud.com'],
  ['google.com', 'youtube.com'],
  ['microsoft.com', 'live.com', 'office.com', 'outlook.com'],
]

export interface UrlBindingSettings {
  /** Extra equivalent-domain groups the user or a skill adds. */
  equivalentDomains?: readonly (readonly string[])[]
}

/** Lower-case host of an http(s) URL, or undefined for anything else (non-http, or unparseable). */
function httpHost(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return parsed.hostname.toLowerCase()
}

/** Whether two hosts are equal or one is a subdomain of the other (nid.naver.com ~ naver.com). */
function sameOrSubdomain(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

/** Whether both hosts fall inside one equivalent-domains group. */
function inSameGroup(a: string, b: string, groups: readonly (readonly string[])[]): boolean {
  for (const group of groups) {
    const aIn = group.some((g) => sameOrSubdomain(a, g))
    const bIn = group.some((g) => sameOrSubdomain(b, g))
    if (aIn && bIn) return true
  }
  return false
}

/**
 * Whether a saved item's host matches the tab's host, directly or through an equivalent-domains group.
 * Both must be http(s) hosts; a non-http tab or item site never matches.
 */
export function urlMatchesSite(tabUrl: string, itemSite: string, settings: UrlBindingSettings = {}): boolean {
  const tabHost = httpHost(tabUrl)
  if (tabHost === undefined) return false
  // The saved site may be a bare host or a full URL; accept both.
  const itemHost = httpHost(itemSite) ?? httpHost(`https://${itemSite}`)
  if (itemHost === undefined) return false
  if (sameOrSubdomain(tabHost, itemHost)) return true
  const groups = [
    ...KR_EQUIVALENT_DOMAINS,
    ...GLOBAL_EQUIVALENT_DOMAINS,
    ...(settings.equivalentDomains ?? []),
  ]
  return inSameGroup(tabHost, itemHost, groups)
}

/**
 * The login items the vault may offer for a tab: login items whose bound site matches the tab's real URL. Returns
 * nothing for a non-http URL. This does not check the access policy (see canAgentUse) — it only filters by URL.
 */
export function findLoginItemsForUrl(
  url: string,
  items: readonly VaultItem[],
  settings: UrlBindingSettings = {},
): LoginItem[] {
  if (httpHost(url) === undefined) return []
  return items.filter(
    (item): item is LoginItem =>
      item.kind === 'login' && item.site !== undefined && urlMatchesSite(url, item.site, settings),
  )
}
