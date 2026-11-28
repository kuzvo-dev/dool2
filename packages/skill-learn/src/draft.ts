/**
 * The drafter: turn a {@link SessionRecording} into a SKILL.md draft, and refine
 * an existing skill with a new recording.
 *
 * A draft prefers the DATA PATH: it lists the internal API endpoints Dool2 found
 * (so the next run calls them with the user's session, click-free) and keeps the
 * UI steps as a fallback. The frontmatter it emits round-trips through
 * `@dool2/skill-sdk` (so the resolver can auto-inject the skill by URL and by
 * Korean keywords), and every byte is run through a redactor so no captured
 * token, cookie or secret lands in the file. Drafts carry `needsReview: true`:
 * a user may keep a draft locally for themselves right away, but org/public
 * distribution goes through the maintainer, who signs it into a pack.
 */

import {
  type LoginFieldHint,
  type LoginHints,
  type ParsedSkill,
  parseSkillMarkdown,
  type SkillFrontmatter,
} from '@dool2/skill-sdk'
import * as ko from './locales/ko.js'
import type { CapturedApiCall, RecordedLoginFields, SessionRecording, UiStep } from './recording.js'
import { defaultRedactor, type Redactor, safeHeaderNames } from './redact.js'

/** Options for {@link draftSkill}. */
export interface DraftOptions {
  /** Skill id (directory name); defaults to a slug of the site name. */
  id?: string
  /** Display name; defaults to the base-domain label (e.g. `coupang`). */
  name?: string
  /** One-line description; defaults to a Korean template over the name and host. */
  description?: string
  /** Extra keywords to merge into `autoInject.keywords` (Korean-first). */
  keywords?: string[]
  /** Override the derived regions (e.g. force `['kr']`). */
  regions?: string[]
  /** Redactor for all captured text; defaults to {@link defaultRedactor}. */
  redactor?: Redactor
}

/** A drafted skill: its id, typed frontmatter, body, and the full SKILL.md text. */
export interface DraftedSkill {
  /** Skill id / directory name. */
  id: string
  /** Typed frontmatter (parseable by `@dool2/skill-sdk`). */
  frontmatter: SkillFrontmatter
  /** The Markdown body (site hints), data path first. */
  body: string
  /** The full SKILL.md: serialized frontmatter + body, redacted. */
  markdown: string
  /** Always true: a draft is usable locally but reviewed before it is shared. */
  needsReview: true
}

/** An API endpoint distilled from a captured call: method + path only. */
interface Endpoint {
  method: string
  path: string
}

/**
 * True when text contains any Hangul. Tested by code point (no literal Hangul,
 * no regex escape) so the source stays ASCII per ADR 0029: compatibility Jamo
 * (0x3131-0x318E) and the syllables block (0xAC00-0xD7A3).
 */
function hasHangul(text: string): boolean {
  for (const char of text) {
    const cp = char.codePointAt(0)
    if (cp === undefined) continue
    if ((cp >= 0x3131 && cp <= 0x318e) || (cp >= 0xac00 && cp <= 0xd7a3)) return true
  }
  return false
}
/** Korean second-level domains under `.kr` (so `seoul.go.kr` keeps three labels). */
const KR_SLDS = new Set(['co', 'go', 'or', 'ne', 're', 'pe', 'ac', 'hs', 'ms', 'es', 'kg', 'sc'])

/** Reduce a host to its registrable base, honoring Korean second-level domains. */
export function baseDomain(host: string): string {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '')
  const parts = h.split('.').filter(Boolean)
  if (parts.length <= 2) return h
  const tld = parts[parts.length - 1]
  const sld = parts[parts.length - 2]
  if (tld === 'kr' && sld && KR_SLDS.has(sld)) return parts.slice(-3).join('.')
  return parts.slice(-2).join('.')
}

/** The first label of a base domain, used as the default skill name (`coupang`). */
function nameFromHost(base: string): string {
  return base.split('.')[0] || base
}

/** Slugify a name into a safe skill id. */
function slugId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'site'
}

/** The URL globs that auto-inject this skill: the base host and its subdomains. */
export function hostGlobs(base: string): string[] {
  return [`*.${base}`, `*.${base}/*`]
}

/**
 * Extract `{ method, path }` from one captured call; the query and fragment are
 * dropped entirely (that is where tokens ride) and the path is run through the
 * redactor in case a secret rode in the path itself.
 */
function toEndpoint(call: CapturedApiCall, redactor: Redactor): Endpoint | undefined {
  const method = (call.method || 'GET').trim().toUpperCase()
  let path = ''
  try {
    path = new URL(call.url).pathname || '/'
  } catch {
    // Not an absolute URL: take the part before any query/fragment.
    path = call.url.split(/[?#]/)[0] || call.url
  }
  path = redactor(path)
  if (!path) return undefined
  return { method, path }
}

/** De-duplicate endpoints by `METHOD path`, keeping first-seen order. */
function dedupeEndpoints(calls: CapturedApiCall[] | undefined, redactor: Redactor): Endpoint[] {
  const out: Endpoint[] = []
  const seen = new Set<string>()
  for (const call of calls ?? []) {
    const ep = toEndpoint(call, redactor)
    if (!ep) continue
    const key = `${ep.method} ${ep.path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ep)
  }
  return out
}

/** The markdown bullet for one endpoint; also the shape {@link mergeIntoSkill} scans for. */
function endpointLine(ep: Endpoint): string {
  return `- \`${ep.method} ${ep.path}\``
}

/** Matches an endpoint bullet in a body, capturing method and path. */
const ENDPOINT_RE = /^\s*-\s+`([A-Z]+)\s+([^`]+)`/

/** Collect the endpoints already listed in a (possibly curated) body. */
function existingEndpoints(body: string): Set<string> {
  const keys = new Set<string>()
  for (const line of body.split('\n')) {
    const m = ENDPOINT_RE.exec(line)
    if (m) keys.add(`${m[1]} ${m[2]}`.trim())
  }
  return keys
}

/** Order keywords Korean-first, de-duplicated case-insensitively, first-seen order within each group. */
function deriveKeywords(
  recording: SessionRecording,
  extra: string[] | undefined,
  name: string,
  redactor: Redactor,
): string[] {
  const raw = [...(recording.keywordsSeen ?? []), ...(extra ?? []), name]
  const korean: string[] = []
  const latin: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const k = redactor(item.trim()).trim()
    if (!k) continue
    const key = k.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    ;(hasHangul(k) ? korean : latin).push(k)
  }
  return [...korean, ...latin]
}

/** Decide the regions: `kr` for a `.kr` host or when any keyword is Korean. */
function deriveRegions(
  base: string,
  keywords: string[],
  override: string[] | undefined,
): string[] | undefined {
  if (override) return override.length > 0 ? override : undefined
  if (base.endsWith('.kr') || keywords.some((k) => hasHangul(k))) return ['kr']
  return undefined
}

/** Map one recorded login field (label or selector) to a frontmatter hint. */
function toFieldHint(value: string | undefined): LoginFieldHint | undefined {
  const v = value?.trim()
  if (!v) return undefined
  // A CSS selector or snapshot ref is used as-is; anything else is a visible label.
  if (/^[#.[]/.test(v) || v.includes('>') || v.includes('=') || v.startsWith('ref')) {
    return { selector: v }
  }
  return { name: v }
}

/** Build the `login` frontmatter block from recorded fields, or `undefined`. */
function toLoginHints(fields: RecordedLoginFields | undefined): LoginHints | undefined {
  if (!fields) return undefined
  const login: LoginHints = {}
  const username = toFieldHint(fields.username)
  if (username) login.username = username
  const password = toFieldHint(fields.password)
  if (password) login.password = password
  const submit = toFieldHint(fields.submit)
  if (submit) login.submit = submit
  const totp = toFieldHint(fields.totp)
  if (totp) login.totp = totp
  if (!login.username && !login.password && !login.submit && !login.totp) return undefined
  return login
}

/** Render one UI step as a numbered-list fragment (target: ref > selector > label). */
function uiStepText(step: UiStep, redactor: Redactor): string {
  const target = redactor(step.label || step.selector || step.ref || '')
  const label = ko.uiActionLabel(step.action)
  return target ? `${label}: ${target}` : label
}

/** The data-path section: the lead, the endpoint bullets (or the empty note), and any header names. */
function dataPathSection(endpoints: Endpoint[], headerNames: string[]): string {
  const lines = [ko.DATA_PATH_HEADING, '']
  if (endpoints.length === 0) {
    lines.push(ko.DATA_PATH_EMPTY)
  } else {
    lines.push(ko.DATA_PATH_LEAD)
    for (const ep of endpoints) lines.push(endpointLine(ep))
    if (headerNames.length > 0) lines.push(ko.headersNote(headerNames))
  }
  return lines.join('\n')
}

/** The UI-fallback section: the lead and a numbered list of steps (or the empty note). */
function uiSection(steps: UiStep[] | undefined, redactor: Redactor): string {
  const lines = [ko.UI_FALLBACK_HEADING, '']
  if (!steps || steps.length === 0) {
    lines.push(ko.UI_FALLBACK_EMPTY)
  } else {
    lines.push(ko.UI_FALLBACK_LEAD)
    steps.forEach((step, i) => {
      lines.push(`${i + 1}. ${uiStepText(step, redactor)}`)
    })
  }
  return lines.join('\n')
}

/** Assemble the full body from the recording's sections. */
function buildBody(
  name: string,
  host: string,
  endpoints: Endpoint[],
  headerNames: string[],
  recording: SessionRecording,
  hasLogin: boolean,
  redactor: Redactor,
): string {
  const sections = [
    ko.bodyIntro(name, host),
    dataPathSection(endpoints, headerNames),
    uiSection(recording.uiSteps, redactor),
  ]
  if (hasLogin) sections.push(`${ko.LOGIN_HEADING}\n\n${ko.LOGIN_NOTE}`)
  sections.push(`${ko.SAFETY_HEADING}\n\n${ko.SAFETY_LINES.join('\n')}`)
  return `${sections.join('\n\n')}\n`
}

/**
 * Draft a SKILL.md from a session recording.
 *
 * The result's `markdown` is `frontmatter + body`, run through the redactor as a
 * final net. `frontmatter` is the same typed shape `@dool2/skill-sdk` parses, so
 * `parseSkillMarkdown(result.markdown)` round-trips to it.
 */
export function draftSkill(recording: SessionRecording, opts: DraftOptions = {}): DraftedSkill {
  const redactor = opts.redactor ?? defaultRedactor
  const base = baseDomain(recording.host)
  const name = opts.name?.trim() || nameFromHost(base)
  const id = slugId(opts.id || name)

  const endpoints = dedupeEndpoints(recording.apiCalls, redactor)
  const headerNames = mergeHeaderNames(recording.apiCalls)
  const keywords = deriveKeywords(recording, opts.keywords, name, redactor)
  const login = toLoginHints(recording.loginFields)

  const frontmatter: SkillFrontmatter = {
    name,
    description: opts.description?.trim() || ko.descriptionLine(name, base),
    site: [base],
    autoInject: { url: hostGlobs(base), keywords },
  }
  const regions = deriveRegions(base, keywords, opts.regions)
  if (regions) frontmatter.regions = regions
  if (login) frontmatter.login = login

  const body = buildBody(name, base, endpoints, headerNames, recording, Boolean(login), redactor)
  // The redactor already cleaned every captured value that flows into the body
  // and keywords; the frontmatter structure and the Korean template copy are
  // trusted, so no blanket pass runs over them (it would mangle Korean labels).
  const markdown = `${serializeFrontmatter(frontmatter)}\n${body}`
  return { id, frontmatter, body, markdown, needsReview: true }
}

/** Union the safe custom-header names across every captured call. */
function mergeHeaderNames(calls: CapturedApiCall[] | undefined): string[] {
  const set = new Set<string>()
  for (const call of calls ?? []) for (const n of safeHeaderNames(call.headers)) set.add(n)
  return [...set].sort((a, b) => a.localeCompare(b))
}

/**
 * Refine an existing skill with a new recording.
 *
 * Keeps the curated body verbatim and only adds endpoints the body did not
 * already list (so the same site gets faster over time without losing
 * hand-written tips). Frontmatter is unioned: curated `name`/`description` are
 * kept, while `site`, `autoInject.url`, `autoInject.keywords`, `regions` and any
 * missing `login` field grow from the recording.
 */
export function mergeIntoSkill(
  existing: string | ParsedSkill,
  recording: SessionRecording,
  opts: DraftOptions = {},
): DraftedSkill {
  const redactor = opts.redactor ?? defaultRedactor
  const parsed = typeof existing === 'string' ? parseSkillMarkdown(existing) : existing
  const base = baseDomain(recording.host)

  const already = existingEndpoints(parsed.body)
  const fresh = dedupeEndpoints(recording.apiCalls, redactor).filter(
    (ep) => !already.has(`${ep.method} ${ep.path}`),
  )
  const headerNames = mergeHeaderNames(recording.apiCalls)
  const body = insertEndpoints(parsed.body, fresh, headerNames)

  const frontmatter = mergeFrontmatter(parsed.frontmatter, recording, base, opts, redactor)
  const id = slugId(opts.id || parsed.frontmatter.name || nameFromHost(base))
  const markdown = `${serializeFrontmatter(frontmatter)}\n${body}`
  return { id, frontmatter, body, markdown, needsReview: true }
}

/** Union new endpoints into the body's data-path section, preserving all other text. */
function insertEndpoints(body: string, fresh: Endpoint[], headerNames: string[]): string {
  if (fresh.length === 0) return body
  const bullets = fresh.map(endpointLine)
  const lines = body.split('\n')

  // Insert right after the last existing endpoint bullet, if any.
  let lastEndpoint = -1
  for (let i = 0; i < lines.length; i++) if (ENDPOINT_RE.test(lines[i] ?? '')) lastEndpoint = i
  if (lastEndpoint !== -1) {
    lines.splice(lastEndpoint + 1, 0, ...bullets)
    return lines.join('\n')
  }

  // No endpoints yet but a data-path heading exists: add the list under it.
  const headingIdx = lines.findIndex((l) => l.trim() === ko.DATA_PATH_HEADING)
  if (headingIdx !== -1) {
    lines.splice(headingIdx + 1, 0, '', ko.DATA_PATH_LEAD, ...bullets)
    return lines.join('\n')
  }

  // No data-path section at all: prepend a fresh one.
  const section = dataPathSection(fresh, headerNames)
  return `${section}\n\n${body}`
}

/** Merge recording-derived frontmatter into existing frontmatter (curated text wins). */
function mergeFrontmatter(
  existing: SkillFrontmatter,
  recording: SessionRecording,
  base: string,
  opts: DraftOptions,
  redactor: Redactor,
): SkillFrontmatter {
  const keywords = deriveKeywords(
    recording,
    [...(existing.autoInject?.keywords ?? []), ...(opts.keywords ?? [])],
    existing.name,
    redactor,
  )
  const fm: SkillFrontmatter = {
    name: existing.name,
    description: existing.description,
    site: unionStrings(existing.site, [base]),
  }
  const url = unionStrings(existing.autoInject?.url, hostGlobs(base))
  fm.autoInject = { url: url ?? hostGlobs(base), keywords }

  const regions =
    opts.regions ?? unionStrings(existing.regions, deriveRegions(base, keywords, undefined) ?? [])
  if (regions && regions.length > 0) fm.regions = regions

  const login = mergeLogin(existing.login, toLoginHints(recording.loginFields))
  if (login) fm.login = login
  if (existing.disabled !== undefined) fm.disabled = existing.disabled
  return fm
}

/** Keep existing login hints; fill only the fields the recording newly found. */
function mergeLogin(existing: LoginHints | undefined, fresh: LoginHints | undefined): LoginHints | undefined {
  if (!existing && !fresh) return undefined
  const out: LoginHints = { ...(existing ?? {}) }
  for (const key of ['username', 'password', 'submit', 'totp'] as const) {
    if (!out[key] && fresh?.[key]) out[key] = fresh[key]
  }
  if (!out.username && !out.password && !out.submit && !out.totp) return undefined
  return out
}

/** Union two string lists into a de-duplicated, order-preserving list (or `undefined` if empty). */
function unionStrings(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of [...(a ?? []), ...(b ?? [])]) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out.length > 0 ? out : undefined
}

// --- frontmatter serialization ----------------------------------------------

/** Serialize typed frontmatter into a `---` YAML block the skill-sdk parser reads back. */
export function serializeFrontmatter(fm: SkillFrontmatter): string {
  const lines: string[] = ['---']
  lines.push(`name: ${yamlScalar(fm.name)}`)
  lines.push(`description: ${yamlScalar(fm.description)}`)
  if (fm.site) lines.push(`site: ${yamlInlineArray(fm.site)}`)
  if (fm.autoInject) {
    lines.push('autoInject:')
    if (fm.autoInject.url) lines.push(`  url: ${yamlInlineArray(fm.autoInject.url)}`)
    if (fm.autoInject.keywords) lines.push(`  keywords: ${yamlInlineArray(fm.autoInject.keywords)}`)
  }
  if (fm.regions) lines.push(`regions: ${yamlInlineArray(fm.regions)}`)
  if (fm.login) {
    lines.push('login:')
    for (const key of ['username', 'password', 'submit', 'totp'] as const) {
      const hint = fm.login[key]
      if (!hint) continue
      lines.push(`  ${key}:`)
      if (hint.selector) lines.push(`    selector: ${yamlScalar(hint.selector)}`)
      if (hint.name) lines.push(`    name: ${yamlScalar(hint.name)}`)
      if (hint.role) lines.push(`    role: ${yamlScalar(hint.role)}`)
    }
  }
  if (fm.disabled !== undefined) lines.push(`disabled: ${fm.disabled}`)
  lines.push('---')
  return lines.join('\n')
}

/** An inline `[a, b]` YAML array with each item scalar-quoted as needed. */
function yamlInlineArray(items: string[]): string {
  return `[${items.map(yamlScalar).join(', ')}]`
}

/** Characters that force a string to be quoted in the YAML subset we emit. */
function needsQuote(s: string): boolean {
  if (s === '') return true
  if (s !== s.trim()) return true
  if (/^[\s>|*&!%@`#"'[\]{}?,:-]/.test(s)) return true
  if (
    s.includes(': ') ||
    s.includes(' #') ||
    s.includes(',') ||
    s.includes('"') ||
    s.includes('[') ||
    s.includes(']')
  ) {
    return true
  }
  return false
}

/** Quote and escape a scalar when needed; otherwise emit it bare. */
function yamlScalar(value: string): string {
  if (!needsQuote(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
