/**
 * SKILL.md frontmatter: a typed schema plus a tiny dependency-free parser.
 *
 * A site skill is a `SKILL.md` file that opens with a YAML frontmatter block
 * between two `---` fences, followed by a Markdown body. The frontmatter tells
 * Dool2 when the skill is relevant (its site, URL globs and keywords) so the
 * resolver in `resolve.ts` can auto-inject it into a turn. The body holds the
 * site tips the brain reads once the skill is injected.
 *
 * The parser deliberately supports only the small YAML subset SKILL.md needs
 * (scalars, inline and block lists, one or two levels of nested maps) so the
 * core stays dependency-free.
 */

/** The `autoInject` block: how a skill asks to be pulled into a turn automatically. */
export interface AutoInject {
  /** URL globs matched against the active tab URL, e.g. `*.gov.kr`, `coupang.com/np/*`. */
  url?: string[]
  /** Whole-word triggers matched in the user's message. Korean-first (login, pay, ...). */
  keywords?: string[]
}

/**
 * Where one login field lives on a site's page. A hint is matched against the
 * tab's accessibility snapshot by the vault (daemon-side) so it can type the
 * secret into the right field without the AI ever seeing it.
 *
 * Give either a `selector` (a robust CSS selector or a snapshot ref, used
 * as-is) or a role+name hint (`name` is the visible label / accessible name,
 * which may be a Korean site label; `role` is the ARIA role such as
 * `textbox` or `button`). A bare string in the YAML is shorthand for `{ name }`.
 */
export interface LoginFieldHint {
  /** A CSS selector or snapshot ref pointing straight at the field. */
  selector?: string
  /** Visible label / accessible name to match (may be a Korean site label). */
  name?: string
  /** ARIA role to match (`textbox`, `button`, ...). */
  role?: string
}

/**
 * The `login` block: which fields on this site to fill for a login. Only
 * `password` is needed for a fill; the rest are optional. The vault reads these
 * hints for the matched skill, locates the fields on the real page, and types
 * the stored secret in — the hints are data (not secrets) and the values never
 * reach the AI.
 */
export interface LoginHints {
  /** The username / id field (role+name or selector). */
  username?: LoginFieldHint
  /** The password field. Required for a login fill to happen. */
  password?: LoginFieldHint
  /** The submit / login button to click after the fields are filled. */
  submit?: LoginFieldHint
  /** The one-time-code (TOTP / 2FA) field, when the site asks for one. */
  totp?: LoginFieldHint
}

/** The typed, normalized shape of a SKILL.md frontmatter block. */
export interface SkillFrontmatter {
  /** Short stable name of the skill. Required. */
  name: string
  /** One line on what the skill is for. Required. */
  description: string
  /** Domain or domains the skill knows, e.g. `["gov.kr"]`. Always normalized to an array. */
  site?: string[]
  /** How the skill asks to be auto-injected (URL globs and/or message keywords). */
  autoInject?: AutoInject
  /** Regions the skill applies to (ADR 0029), e.g. `["kr"]`. */
  regions?: string[]
  /** When true the skill is parked and the resolver skips it. */
  disabled?: boolean
  /** Field hints that tell the vault which page fields to fill for a login on this site. */
  login?: LoginHints
}

/** A parsed SKILL.md document: its typed frontmatter and the Markdown body after it. */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter
  body: string
}

/**
 * Parse a SKILL.md string into `{ frontmatter, body }`.
 *
 * Throws when the required `name`/`description` fields are missing so a broken
 * skill fails loudly at load time rather than silently never matching.
 */
export function parseSkillMarkdown(markdown: string): ParsedSkill {
  const { data, body } = splitFrontmatter(markdown)
  return { frontmatter: normalizeFrontmatter(data), body }
}

/** Split a document into its raw frontmatter map and the body text that follows. */
function splitFrontmatter(markdown: string): {
  data: Record<string, unknown>
  body: string
} {
  const normalized = markdown.replace(/^﻿/, '')
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized)
  if (!match) return { data: {}, body: normalized }
  const yaml = match[1] ?? ''
  const body = normalized.slice(match[0].length)
  const parsed = parseYaml(yaml)
  const data = isPlainObject(parsed) ? parsed : {}
  return { data, body }
}

/** Validate and normalize a raw frontmatter map into the typed schema. */
function normalizeFrontmatter(data: Record<string, unknown>): SkillFrontmatter {
  const name = asString(data.name)
  if (!name) throw new Error('SKILL.md frontmatter requires a non-empty "name"')
  const description = asString(data.description)
  if (!description) throw new Error(`SKILL.md "${name}" frontmatter requires a non-empty "description"`)

  const fm: SkillFrontmatter = { name, description }

  const site = asStringArray(data.site)
  if (site) fm.site = site

  const autoInject = normalizeAutoInject(data.autoInject)
  if (autoInject) fm.autoInject = autoInject

  const regions = asStringArray(data.regions)
  if (regions) fm.regions = regions

  if (typeof data.disabled === 'boolean') fm.disabled = data.disabled

  const login = normalizeLogin(data.login)
  if (login) fm.login = login

  return fm
}

/** Normalize the `login` block, dropping it when it names no fillable field. */
function normalizeLogin(value: unknown): LoginHints | undefined {
  if (!isPlainObject(value)) return undefined
  const result: LoginHints = {}
  const username = normalizeFieldHint(value.username)
  if (username) result.username = username
  const password = normalizeFieldHint(value.password)
  if (password) result.password = password
  const submit = normalizeFieldHint(value.submit)
  if (submit) result.submit = submit
  const totp = normalizeFieldHint(value.totp)
  if (totp) result.totp = totp
  if (!result.username && !result.password && !result.submit && !result.totp) return undefined
  return result
}

/**
 * Normalize one field hint. A bare string is shorthand for `{ name }` (the
 * common Korean-label case); a map may carry `selector`, `name` and/or `role`.
 */
function normalizeFieldHint(value: unknown): LoginFieldHint | undefined {
  const shorthand = asString(value)
  if (shorthand) return { name: shorthand }
  if (!isPlainObject(value)) return undefined
  const hint: LoginFieldHint = {}
  const selector = asString(value.selector)
  if (selector) hint.selector = selector
  const name = asString(value.name)
  if (name) hint.name = name
  const role = asString(value.role)
  if (role) hint.role = role
  if (!hint.selector && !hint.name && !hint.role) return undefined
  return hint
}

/** Normalize the `autoInject` block, dropping it entirely when it carries no triggers. */
function normalizeAutoInject(value: unknown): AutoInject | undefined {
  if (!isPlainObject(value)) return undefined
  const result: AutoInject = {}
  const url = asStringArray(value.url)
  if (url) result.url = url
  const keywords = asStringArray(value.keywords)
  if (keywords) result.keywords = keywords
  if (!result.url && !result.keywords) return undefined
  return result
}

/** Coerce a YAML scalar to a trimmed non-empty string, or `undefined`. */
function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Coerce a scalar or list into a string array of non-empty values, or `undefined`. */
function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const raw = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of raw) {
    const s = asString(item)
    if (s) out.push(s)
  }
  return out.length > 0 ? out : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// --- tiny YAML subset parser -------------------------------------------------

interface Line {
  indent: number
  content: string
}

/** Parse the YAML subset used by SKILL.md frontmatter into a plain value. */
export function parseYaml(source: string): unknown {
  const lines = tokenize(source)
  if (lines.length === 0) return {}
  const [value] = parseNode(lines, 0, lines[0]?.indent ?? 0)
  return value
}

/** Drop blank and comment lines and record each remaining line's indent. */
function tokenize(source: string): Line[] {
  const out: Line[] = []
  for (const raw of source.split('\n')) {
    const line = stripComment(raw.replace(/\r$/, ''))
    if (line.trim().length === 0) continue
    out.push({ indent: line.length - line.trimStart().length, content: line.trim() })
  }
  return out
}

/** Remove a full-line or trailing ` #...` comment, respecting quoted strings. */
function stripComment(line: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle) inDouble = !inDouble
    else if (c === '#' && !inSingle && !inDouble) {
      const prev = line[i - 1]
      if (i === 0 || prev === ' ' || prev === '\t') return line.slice(0, i)
    }
  }
  return line
}

/** Parse a map or a block list starting at `start`, whose items sit at `indent`. */
function parseNode(lines: Line[], start: number, indent: number): [unknown, number] {
  const first = lines[start]
  if (first?.content.startsWith('- ')) return parseList(lines, start, indent)
  return parseMap(lines, start, indent)
}

function parseList(lines: Line[], start: number, indent: number): [unknown[], number] {
  const arr: unknown[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (!line || line.indent !== indent || !line.content.startsWith('- ')) break
    arr.push(parseInline(line.content.slice(2).trim()))
    i++
  }
  return [arr, i]
}

function parseMap(lines: Line[], start: number, indent: number): [Record<string, unknown>, number] {
  const obj: Record<string, unknown> = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (!line || line.indent !== indent) break
    const colon = line.content.indexOf(':')
    if (colon === -1) break
    const key = line.content.slice(0, colon).trim()
    const rest = line.content.slice(colon + 1).trim()
    if (rest === '') {
      const next = lines[i + 1]
      if (next && next.indent > indent) {
        const [value, consumed] = parseNode(lines, i + 1, next.indent)
        obj[key] = value
        i = consumed
      } else {
        obj[key] = null
        i++
      }
    } else {
      obj[key] = parseInline(rest)
      i++
    }
  }
  return [obj, i]
}

/** Parse an inline value: a `[a, b]` list or a single scalar. */
function parseInline(text: string): unknown {
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    if (inner.length === 0) return []
    return splitTopLevel(inner).map((part) => parseScalar(part.trim()))
  }
  return parseScalar(text)
}

/** Split a `[...]` body on top-level commas, keeping quoted commas intact. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inSingle = false
  let inDouble = false
  let current = ''
  for (const c of text) {
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle) inDouble = !inDouble
    if (!inSingle && !inDouble) {
      if (c === '[') depth++
      else if (c === ']') depth--
      else if (c === ',' && depth === 0) {
        parts.push(current)
        current = ''
        continue
      }
    }
    current += c
  }
  if (current.trim().length > 0) parts.push(current)
  return parts
}

/** Coerce a bare YAML scalar into a string, boolean, number or null. */
function parseScalar(text: string): unknown {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}
