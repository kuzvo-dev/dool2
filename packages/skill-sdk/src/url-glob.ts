/**
 * A small URL-glob matcher for skill `autoInject.url` patterns.
 *
 * A pattern matches against the active tab's `host + pathname` (scheme, query
 * and hash are ignored). Supported forms:
 *
 * - host-only:   `coupang.com`, `*.gov.kr`
 * - host + path: `coupang.com/*`, `coupang.com/np/*`, `*.gov.kr/portal/*`
 *
 * Glob rules:
 * - A leading `*.` on the host matches zero or more subdomain labels, so
 *   `*.gov.kr` matches both `gov.kr` and `www.gov.kr`.
 * - `*` elsewhere matches any run of characters except `/`.
 * - A trailing `*` (the pattern's last character) matches the rest of the
 *   string including `/`, so `coupang.com/*` matches any path depth.
 */

/** Escape a literal string for safe embedding in a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build the host portion of the pattern regex, honoring a leading `*.`. */
function hostPatternToRegex(hostPattern: string): string {
  let host = hostPattern.toLowerCase()
  let prefix = ''
  if (host.startsWith('*.')) {
    // Optional subdomain labels; `[^/]+` may itself contain dots (a.b.gov.kr).
    prefix = '(?:[^/]+\\.)?'
    host = host.slice(2)
  }
  const body = host.split('*').map(escapeRegExp).join('[^/]*')
  return prefix + body
}

/** Build a path/segment regex where a trailing `*` matches the rest of the string. */
function segmentPatternToRegex(pattern: string): string {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === '*') out += i === pattern.length - 1 ? '.*' : '[^/]*'
    else out += escapeRegExp(c)
  }
  return out
}

/** Parse a URL into a lowercased `{ host, path }`, or `undefined` when invalid. */
function splitUrl(url: string): { host: string; path: string } | undefined {
  try {
    const parsed = new URL(url)
    return {
      host: parsed.hostname.toLowerCase(),
      path: parsed.pathname || '/',
    }
  } catch {
    return undefined
  }
}

/**
 * Test whether `url` matches a single `autoInject.url` glob `pattern`.
 * Pure and allocation-light; safe to call for every skill on every turn.
 */
export function matchUrlGlob(url: string, pattern: string): boolean {
  const target = splitUrl(url)
  if (!target) return false

  const slash = pattern.indexOf('/')
  if (slash === -1) {
    // Host-only pattern: ignore the path entirely.
    const re = new RegExp(`^${hostPatternToRegex(pattern)}$`)
    return re.test(target.host)
  }

  const hostPattern = pattern.slice(0, slash)
  const pathPattern = pattern.slice(slash) // keeps the leading '/'
  const re = new RegExp(`^${hostPatternToRegex(hostPattern)}${segmentPatternToRegex(pathPattern)}$`)
  return re.test(target.host + target.path)
}

/**
 * Count the literal (non-wildcard) characters in a pattern. Used as a small
 * specificity tiebreaker so a more exact glob outranks a broad one.
 */
export function globSpecificity(pattern: string): number {
  let count = 0
  for (const c of pattern) if (c !== '*') count++
  return count
}
