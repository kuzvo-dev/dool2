/**
 * Redaction for captured recordings.
 *
 * A session recording is captured off the live network, so a URL or header may
 * carry a token, cookie or session id. None of that may be written into a
 * SKILL.md: a skill is shared (signed into a pack) and holds site tips only,
 * never a secret. This module strips secret-looking values out of the captured
 * text, and layers the vault's `maskSecretsInText` on top as defence in depth
 * (cards, one-time codes, Korean identifiers). The drafter runs the final
 * markdown through {@link defaultRedactor} so nothing secret survives, and
 * callers may inject their own redactor instead.
 */

import { maskSecretsInText } from '@dool2/vault'

/** A text-in, text-out redactor. Must be idempotent and never throw. */
export type Redactor = (text: string) => string

/**
 * Header names that carry the user's session and must never be resent from a
 * skill (the browser adds them automatically) nor listed as a "required
 * header". Compared case-insensitively.
 */
const SESSION_HEADER_NAMES = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-csrf-token',
  'x-xsrf-token',
  'x-auth-token',
])

/** Query-parameter names whose value is secret-looking and must be masked. */
const SECRET_QUERY_KEYS =
  /\b(token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|authkey|apikey|api[_-]?key|key|secret|sig|signature|session|session[_-]?id|sid|password|passwd|pwd|pw|otp|code|bearer|credential)\b/i

/** True when a header name carries the session and should be dropped. */
export function isSessionHeaderName(name: string): boolean {
  return SESSION_HEADER_NAMES.has(name.trim().toLowerCase())
}

/** Mask secret-looking `?key=value` / `&key=value` query params in a URL or text. */
function maskSecretQueryParams(text: string): string {
  return text.replace(/([?&])([^=&\s]+)=([^&\s#]+)/g, (match, sep, key, _value) => {
    return SECRET_QUERY_KEYS.test(String(key)) ? `${sep}${key}=[redacted]` : match
  })
}

/** Mask `Authorization: Bearer <...>` and `Cookie: <...>` style label=value runs. */
function maskSecretLabels(text: string): string {
  let out = text
  out = out.replace(/\b(authorization|cookie|set-cookie)\b\s*[:=]\s*\S+/gi, '$1: [redacted]')
  out = out.replace(/\bbearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'bearer [redacted]')
  return out
}

/**
 * Mask long opaque token-like runs (JWTs, session ids, signed cookies): 24+
 * chars of the base64url/token alphabet with no spaces. `/` is deliberately NOT
 * in the alphabet so an ordinary API path (`/api/v2/orders/...`) splits into
 * short segments and is left intact; only a single long opaque segment is
 * masked. Conservative on length so plain words are left alone; drafts are
 * reviewed anyway.
 */
function maskLongTokens(text: string): string {
  return text.replace(/\b[A-Za-z0-9\-._~+]{24,}={0,2}\b/g, (match) => {
    // Keep it only if it is clearly not a token: all lowercase letters, no digit
    // and no token punctuation (e.g. a long Latin word). Otherwise redact.
    if (/^[a-z]+$/.test(match)) return match
    return '[redacted:token]'
  })
}

/**
 * The default redactor: query params, auth/cookie labels, long tokens, then the
 * vault's `maskSecretsInText`. Safe to run over any captured text or the final
 * drafted markdown.
 */
export const defaultRedactor: Redactor = (text: string): string => {
  let out = text
  out = maskSecretQueryParams(out)
  out = maskSecretLabels(out)
  out = maskLongTokens(out)
  out = maskSecretsInText(out)
  return out
}

/**
 * Keep only the custom request-header *names* worth resending from a skill:
 * drop session-carrying headers and ordinary transport headers, returning a
 * sorted, de-duplicated list. Values are never returned (they may be secret).
 */
export function safeHeaderNames(headers: Record<string, string> | undefined): string[] {
  if (!headers) return []
  const ordinary = new Set([
    'accept',
    'accept-encoding',
    'accept-language',
    'cache-control',
    'connection',
    'content-length',
    'content-type',
    'host',
    'origin',
    'pragma',
    'referer',
    'user-agent',
  ])
  const names = new Set<string>()
  for (const raw of Object.keys(headers)) {
    const name = raw.trim()
    const lower = name.toLowerCase()
    if (!name || isSessionHeaderName(lower) || ordinary.has(lower)) continue
    names.add(name)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}
