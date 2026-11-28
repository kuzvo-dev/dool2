/**
 * The skill resolver: pick which site skills to auto-inject into a turn.
 *
 * Two signals, both pure and fast:
 *  - URL glob match on the active tab URL (`autoInject.url`).
 *  - Whole-word keyword match in the user's message (`autoInject.keywords`),
 *    Korean-first.
 *
 * Why not a plain substring match? Korean has no spaces inside a phrase and
 * glues particles/endings onto a word (the stem "login" + the ending "-haejwo"
 * becomes one token; the stem "coupang" + the particle "-eseo" becomes one
 * token). A naive `includes` would also fire inside unrelated tokens. So we
 * tokenize on non-letter/digit boundaries (Hangul-aware) and accept a keyword
 * when it is a whole token, or when it is the start of a token whose next
 * character is Hangul (a Korean particle or verb ending). That matches the
 * stem "pay" when a Korean ending is fused onto it, without matching Latin
 * "pay" inside "payment". See the tests for the Hangul examples.
 */

import type { AutoInject, LoginHints } from './frontmatter.js'
import { globSpecificity, matchUrlGlob } from './url-glob.js'

/** The minimum a skill needs to expose to take part in resolution. */
export interface SkillMeta {
  /** Stable identifier, usually the skill directory name. */
  id: string
  /** Display name, if known. */
  name?: string
  /** Domains the skill knows (metadata; not used for scoring). */
  site?: string[]
  /** URL globs and/or keywords that ask for auto-injection. */
  autoInject?: AutoInject
  /** Regions the skill applies to, e.g. `["kr"]`. */
  regions?: string[]
  /** When true the skill is skipped. */
  disabled?: boolean
  /** Login field hints for this site, consulted by the vault when it fills a login. */
  login?: LoginHints
}

/** Why a skill matched: a tab-URL glob or a message keyword. */
export type MatchReason = { kind: 'url'; pattern: string } | { kind: 'keyword'; keyword: string }

/** A skill with its resolution score and the reasons it matched. */
export interface ScoredSkill {
  skill: SkillMeta
  score: number
  reasons: MatchReason[]
}

/** Input context the resolver scores skills against. */
export interface ResolveInput {
  /** The active tab URL, if any. */
  url?: string
  /** The user's message, if any. */
  message?: string
}

/** Options for {@link resolveSkills}. */
export interface ResolveOptions {
  /** Keep only the top N matches (after sorting). */
  limit?: number
}

/** A URL match is the strongest signal; a keyword is a lighter one. */
const URL_WEIGHT = 10
const KEYWORD_WEIGHT = 4

/**
 * Score a tab URL against a skill's `autoInject.url` globs.
 *
 * Returns the best single match (patterns do not stack) plus a small
 * specificity bonus so an exact glob outranks a broad one, and the list of
 * every pattern that matched as reasons.
 */
export function urlMatchScore(
  url: string | undefined,
  patterns: string[] | undefined,
): { score: number; reasons: MatchReason[] } {
  if (!url || !patterns || patterns.length === 0) return { score: 0, reasons: [] }
  const reasons: MatchReason[] = []
  let best = 0
  for (const pattern of patterns) {
    if (!matchUrlGlob(url, pattern)) continue
    reasons.push({ kind: 'url', pattern })
    best = Math.max(best, URL_WEIGHT + globSpecificity(pattern) / 100)
  }
  return { score: best, reasons }
}

/**
 * Score a message against a skill's `autoInject.keywords`.
 *
 * Each distinct keyword that matches as a whole word adds {@link KEYWORD_WEIGHT}.
 */
export function keywordMatchScore(
  message: string | undefined,
  keywords: string[] | undefined,
): { score: number; reasons: MatchReason[] } {
  if (!message || !keywords || keywords.length === 0) return { score: 0, reasons: [] }
  const tokens = tokenize(message)
  if (tokens.length === 0) return { score: 0, reasons: [] }
  const reasons: MatchReason[] = []
  const seen = new Set<string>()
  for (const keyword of keywords) {
    const normalized = keyword.toLowerCase().trim()
    if (!normalized || seen.has(normalized)) continue
    if (matchesKeyword(tokens, normalized)) {
      reasons.push({ kind: 'keyword', keyword })
      seen.add(normalized)
    }
  }
  return { score: reasons.length * KEYWORD_WEIGHT, reasons }
}

/**
 * Resolve the skills to auto-inject for `input`, highest score first.
 *
 * Disabled skills and skills that score zero are dropped. Ties break on skill
 * id so the ordering is deterministic. Pass `options.limit` to cap the list.
 */
export function resolveSkills(
  input: ResolveInput,
  skills: SkillMeta[],
  options: ResolveOptions = {},
): ScoredSkill[] {
  const scored: ScoredSkill[] = []
  for (const skill of skills) {
    if (skill.disabled) continue
    const url = urlMatchScore(input.url, skill.autoInject?.url)
    const keyword = keywordMatchScore(input.message, skill.autoInject?.keywords)
    const score = url.score + keyword.score
    if (score <= 0) continue
    scored.push({ skill, score, reasons: [...url.reasons, ...keyword.reasons] })
  }
  scored.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
  if (options.limit !== undefined && options.limit >= 0) return scored.slice(0, options.limit)
  return scored
}

// --- keyword tokenization ----------------------------------------------------

/**
 * True when a character is a Hangul jamo or syllable. Written with numeric code
 * points (no literal Hangul) so the source stays ASCII per ADR 0029: Hangul
 * Jamo (0x1100-0x11FF), compatibility Jamo (0x3130-0x318F), extended Jamo-A
 * (0xA960-0xA97F) and the syllables block (0xAC00-0xD7FF).
 */
function isHangul(char: string | undefined): boolean {
  if (!char) return false
  const cp = char.codePointAt(0)
  if (cp === undefined) return false
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7ff)
  )
}

/**
 * Split text into lowercased word tokens on any non-letter/digit boundary.
 * Unicode-aware, so Hangul syllables stay inside a token and punctuation,
 * spaces and slashes break tokens apart.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
}

/**
 * Whether a normalized keyword matches any token.
 *
 * - Exact token match (works for every script).
 * - Token that starts with the keyword and continues with a Hangul character,
 *   which captures Korean particles/endings fused onto the word (a stem keyword
 *   followed by a Korean ending still matches) without matching Latin prefixes
 *   (pay -> payment stays unmatched). See the tests for the Hangul examples.
 */
function matchesKeyword(tokens: string[], keyword: string): boolean {
  for (const token of tokens) {
    if (token === keyword) return true
    if (token.length > keyword.length && token.startsWith(keyword) && isHangul(token[keyword.length])) {
      return true
    }
  }
  return false
}
