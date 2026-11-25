// Service connector (skills/<id>/tools.json, ADR 0018).
// Describes what can be done in one service as typed tools. It is data, not code, so the Dool2 core reads it
// and runs it as fixed engine actions (open, wait, press by text, type, extract a list, request same-site data, ask for approval).
// A connector cannot turn the approval gate off or go around it: pressing goes through the core's risk check as is.
import { z } from 'zod'
import { type Tier, TierSchema } from './connect.js'
import {
  AM_KO,
  BANNED_INSTRUCTIONS,
  PM_KO,
  STATUS_PATTERN,
  TODAY_KO,
  TOMORROW_KO,
  WEEKDAYS_KO,
} from './region/kr/connector-data.js'

// ── Input and output shapes (a small subset of JSON schema) ──

const KEY = /^[a-z][a-zA-Z0-9_]{0,30}$/
const Key = z.string().regex(KEY, 'A name starting with a lowercase English letter (e.g. keyword, people)')
const Text = (max: number) => z.string().trim().min(1).max(max)

export const InputPropSchema = z
  .object({
    type: z.enum(['string', 'integer', 'number', 'boolean']),
    /** Field description the AI reads. Give the format and an example: "Date YYYY-MM-DD (e.g. 2026-11-27)" */
    description: Text(200),
    enum: z.array(Text(40)).min(1).max(30).optional(),
    /** Text format: date = YYYY-MM-DD, time = HH:MM (24-hour) */
    format: z.enum(['date', 'time']).optional(),
    pattern: z.string().max(200).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    maxLength: z.number().int().min(1).max(2000).optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict()
export type InputProp = z.infer<typeof InputPropSchema>

export const InputSchema = z
  .object({
    properties: z.record(Key, InputPropSchema),
    /** Fields that must be provided. If the AI does not know them, it asks the user first */
    required: z.array(Key).default([]),
  })
  .strict()
export type ConnectorInput = z.infer<typeof InputSchema>

const Scalar = z.enum(['string', 'integer', 'number', 'boolean'])
export const OutputFieldSchema = z.union([
  z.object({ type: Scalar, description: Text(200).optional() }).strict(),
  z.object({ type: z.literal('strings'), description: Text(200).optional() }).strict(),
  z
    .object({
      /** List of rows: every row has the same fields (search results, order list) */
      type: z.literal('list'),
      description: Text(200).optional(),
      fields: z.record(
        Key,
        z
          .object({ type: z.union([Scalar, z.literal('strings')]), description: Text(200).optional() })
          .strict(),
      ),
    })
    .strict(),
])
export type OutputField = z.infer<typeof OutputFieldSchema>

// ── Run order (engine actions) ──

/** Fields of list extraction (same shape as the extension's pageExtract) */
const ExtractFieldSchema = z
  .object({
    css: z.string().max(300).optional(),
    attr: z.string().max(40).optional(),
    line: z.number().int().min(-20).max(50).optional(),
    match: z.string().max(300).optional(),
    list: z.boolean().optional(),
    /**
     * Photo field: the most plausible photo address from the row (or inside css). It also looks at lazily drawn photos (data-src, srcset, background images),
     * skips icons, logos, badges and very small images, and turns http into https. Used for screen cards (show_cards)
     */
    image: z.boolean().optional(),
  })
  .strict()

const As = { as: Key.optional() }
/** Keep going to the next step even if this one fails (things done only when present, like closing a popup) */
const Optional = { optional: z.boolean().optional() }
/**
 * Whether to do this step: skipped if the filled text is empty. Example: "{{^found.0}}1{{/found.0}}" = only when nothing was found before
 * (used for things like not opening older periods when an earlier period had results)
 */
const If = { if: z.string().max(400).optional() }
/** For a list: appends to the list collected earlier under the same name (several periods or pages as one list) */
const Append = { append: z.boolean().optional() }

export const StepSchema = z.union([
  /** Open an address (with fills like {{keyword|url}}). Only this service's site addresses */
  z.object({ open: Text(500), ...If }).strict(),
  /** Wait until this text appears (or disappears) */
  z
    .object({
      wait: z
        .object({
          text: z.string().max(300).optional(),
          gone: z.string().max(300).optional(),
          items: z.string().max(300).optional(),
          timeoutMs: z.number().int().min(500).max(20_000).optional(),
          // With soft, it does not stop when time runs out and just moves to the next step (even if the site text changed, the AI reads it at handoff)
          soft: z.boolean().optional(),
        })
        .strict(),
      ...Optional,
      ...If,
    })
    .strict(),
  /** Find in the screen text (regex, group 1). The result goes under the as name */
  z.object({ find: z.record(Key, z.string().max(300)), ...As, ...If }).strict(),
  /** Press by screen text (goes through the core's risk check) */
  z.object({ click: z.object({ text: Text(200) }).strict(), ...Optional, ...If }).strict(),
  /** Write into an input field. field = regex of the input's name or hint text */
  z
    .object({
      type: z.object({ field: Text(200), text: Text(500), submit: z.boolean().optional() }).strict(),
      ...If,
    })
    .strict(),
  /** Choose from a dropdown (sort, page size, options). field = regex of the select box's name, option = the item's text exactly */
  z
    .object({
      choose: z.object({ field: Text(200), option: Text(100) }).strict(),
      ...Optional,
      ...If,
    })
    .strict(),
  z.object({ press: z.enum(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown']), ...If }).strict(),
  z.object({ sleep: z.number().int().min(100).max(5_000), ...If }).strict(),
  /** Extract a list */
  z
    .object({
      extract: z
        .object({
          items: Text(300),
          within: z.string().max(300).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          fields: z.record(Key, ExtractFieldSchema),
        })
        .strict(),
      as: Key,
      /** At least how many rows must come out (fewer counts as blocked. With 0, an empty result is fine) */
      min: z.number().int().min(0).max(50).optional(),
      ...If,
    })
    .strict(),
  /**
   * Read data embedded in the page (JSON): for sites where the server sends the result along with the page (script#__NEXT_DATA__ etc.).
   * css = that element, pick = the path to take out
   */
  z
    .object({
      embedded: z
        .object({
          css: Text(300),
          pick: z.string().max(300).optional(),
          /** If it is a JavaScript variable inside a script: reads the first JSON chunk after this text (e.g. "__APOLLO_STATE__") */
          after: z.string().max(60).optional(),
        })
        .strict(),
      as: Key,
      ...Append,
      ...If,
    })
    .strict(),
  /**
   * Read a response (JSON) the page received by itself. Dool2 sends no request: among the data the site receives when a person opens that screen,
   * it reads the last response whose address matches url (regex) and takes out the pick path. The open of this tool turns on listening for responses
   */
  z
    .object({
      capture: z
        .object({
          url: Text(300),
          pick: z.string().max(200).optional(),
          timeoutMs: z.number().int().min(500).max(30_000).optional(),
        })
        .strict(),
      as: Key,
      ...Append,
      ...If,
    })
    .strict(),
  /**
   * Filter a list: only rows of from that match the condition. If value is empty (no input was given), nothing is filtered.
   * Example: { "from": "products", "where": "price", "op": "lte", "value": "{{max_price}}" }
   */
  z
    .object({
      filter: z
        .object({
          from: Text(200),
          where: Text(200),
          op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'has', 'not']),
          value: z.string().max(200).optional(),
        })
        .strict(),
      as: Key,
      ...If,
    })
    .strict(),
  /** Reshape a list: for each row of from (a variable path), fields (new name -> path inside the row) */
  z
    .object({
      map: z
        .object({
          from: Text(200),
          fields: z.record(Key, Text(200)),
          /** Up to how many rows (a number or "{{limit}}") */
          limit: z.union([z.number().int().min(1).max(200), z.string().max(40)]).optional(),
        })
        .strict(),
      as: Key,
      ...If,
    })
    .strict(),
  /** If this text does not appear (even after waiting), stop and report: a result like "that time is closed" (not a block) */
  z
    .object({
      require: Text(300),
      say: Text(300),
      timeoutMs: z.number().int().min(500).max(20_000).optional(),
      ...If,
    })
    .strict(),
  /** If this text appears, stop and report. With login it goes to the connect (sign-in) guide, and blocked means the site blocked this browser
   *  (not a connector problem to fix, so checks count it separately from breakage) */
  z
    .object({
      stop_if: Text(300),
      say: Text(300),
      login: z.boolean().optional(),
      blocked: z.boolean().optional(),
      ...If,
    })
    .strict(),
  /**
   * The page must be the connected account's (ADR 0041). Services that fall back to the browser's first account
   * without a word (Gmail and Calendar with authuser=) are checked here: when the page shows another account, stop
   * with this message as a sign-in stop, so nobody else's mailbox is read
   */
  z.object({ account_check: Text(300), ...If }).strict(),
  /** The last step of a pay or contact tool: asks the user to approve pressing this button (Dool2 presses it only after approval) */
  z
    .object({
      approve: z
        .object({
          text: Text(200),
          what: Text(200),
          where: Text(100),
          amount: z.string().max(100).optional(),
          cancel: z.string().max(200).optional(),
        })
        .strict(),
      ...If,
    })
    .strict(),
  /** For places that are hard to do in a fixed order: hands the tab brought this far to the AI and tells it what to do */
  z.object({ handoff_to_agent: Text(500), ...If }).strict(),
])
export type Step = z.infer<typeof StepSchema>

export const STEP_KINDS = [
  'open',
  'wait',
  'find',
  'click',
  'type',
  'choose',
  'press',
  'sleep',
  'extract',
  'capture',
  'embedded',
  'map',
  'filter',
  'stop_if',
  'require',
  'account_check',
  'approve',
  'handoff_to_agent',
] as const
export type StepKind = (typeof STEP_KINDS)[number]
export function stepKind(s: Step): StepKind {
  return STEP_KINDS.find((k) => k in s) as StepKind
}

// ── Tools ──

/** Tool status: verified(YYYY-MM-DD …) / draft / blocked(reason), written in Korean in tools.json */
const Status = z
  .string()
  .regex(
    STATUS_PATTERN,
    'Status must be 초안 (draft), 검증됨(YYYY-MM-DD) (verified) or 막힘(reason) (blocked)',
  )

export const ConnectorToolSchema = z
  .object({
    /** Name inside the service. The real tool name is "<service>_<name>" (catchtable_search) */
    name: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
    /** Short title: "식당 찾기" ("Find a restaurant") */
    title: Text(30),
    /** Guidance the AI reads: when to use it, what it returns, and what to do next */
    description: Text(600),
    tier: TierSchema,
    /** A tool you can use only after signing in (connecting) */
    login: z.boolean().default(false),
    status: Status,
    input: InputSchema,
    output: z.record(Key, OutputFieldSchema),
    /** Input examples (attached to the AI guidance, and used as the input of real-site tests) */
    examples: z
      .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])))
      .min(1)
      .max(3),
    steps: z.array(StepSchema).min(1).max(40),
    /** Value to return: output field -> fill ("{{shops}}"; with just one, the value as is) */
    result: z.record(Key, z.string().max(500)),
    /** Next-step guidance to attach at the end of the result text (can be filled) */
    next: z.string().max(400).optional(),
    /**
     * Health criteria (ADR 0020): the result list must have at least rows rows (daily checks only), and filled fields must be filled in over 80% of the rows.
     * Falling short counts as a "silent breakage" (the site changed and the fields come out empty)
     */
    expect: z
      .object({
        rows: z.number().int().min(0).max(100).optional(),
        filled: z.array(Key).max(10).optional(),
      })
      .strict()
      .optional(),
    /** Interval (seconds) at which the same input can be called again. Calling again within it returns the last result */
    minIntervalSec: z.number().int().min(0).max(86_400).optional(),
    /**
     * false: do not show as cards instead of a candidate list to pick from (theater lists, showtimes, lyrics, parcel steps, etc.).
     * Lookup lists in shopping, stays, books, tickets and video must have photo (image) and link (link) fields by default
     */
    cards: z.boolean().optional(),
  })
  .strict()
export type ConnectorTool = z.infer<typeof ConnectorToolSchema>

export const ConnectorSchema = z
  .object({
    /** Same as the id of the connect card (connect.json) */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
    tools: z.array(ConnectorToolSchema).min(1).max(12),
  })
  .strict()
export type Connector = z.infer<typeof ConnectorSchema>

/** The real MCP tool name: catchtable_search, cj_logistics_track */
export function connectorToolName(serviceId: string, name: string): string {
  return `${serviceId.replace(/-/g, '_')}_${name}`
}

/** Tier -> MCP tool hint */
export function tierAnnotations(tier: Tier) {
  const read = tier === 'lookup'
  return {
    readOnlyHint: read,
    destructiveHint: tier === 'pay' || tier === 'contact',
    idempotentHint: read,
    openWorldHint: true,
  }
}

// ── Fills: "{{keyword|url}}" ──

export type Scope = Record<string, unknown>

/**
 * Take a value by dotted path: "shops.0.name", "data.list", from the end "events.-1.status",
 * collect a field across a list "slots.*.time" -> ["12:00", "19:30"],
 * only rows of a list whose field equals a value "chargers[powerType=fast|ultrafast][status=available]" (| means any of them, and ".length" at the end gives the count)
 */
export function pick(scope: unknown, path: string): unknown {
  const keys = path.split('.').filter(Boolean)
  let cur: unknown = scope
  for (const [i, k] of keys.entries()) {
    if (cur === null || cur === undefined) return undefined
    const where = /^([^[]*)((?:\[\w+=[^\]]*\])+)$/.exec(k)
    if (where) {
      if (where[1]) cur = (cur as Record<string, unknown>)[where[1]]
      if (!Array.isArray(cur)) return undefined
      for (const [, f = '', v] of (where[2] ?? '').matchAll(/\[(\w+)=([^\]]*)\]/g))
        cur = (cur as unknown[]).filter(
          (x) =>
            x !== null &&
            typeof x === 'object' &&
            (v ?? '').split('|').includes(String((x as Record<string, unknown>)[f] ?? '')),
        )
      continue
    }
    if (k === '*') {
      // If it is a group of fields (like photos per color code), make those values a list
      if (cur && typeof cur === 'object' && !Array.isArray(cur)) cur = Object.values(cur)
      if (!Array.isArray(cur)) return undefined
      const rest = keys.slice(i + 1).join('.')
      const out = cur.map((x) => (rest ? pick(x, rest) : x)).filter((x) => x !== undefined && x !== null)
      // If there is another star (orders.*.group.*.item), flatten into one list
      return rest.split('.').includes('*') ? out.flat() : out
    }
    if (Array.isArray(cur) && /^-\d+$/.test(k)) cur = cur.at(Number(k))
    else cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

const DOW = WEEKDAYS_KO
/** Korean date (YYYY-MM-DD) */
function kstDate(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10)
}

const FILTERS: Record<string, (v: string) => string> = {
  url: (v) => encodeURIComponent(v),
  digits: (v) => v.replace(/\D/g, ''),
  trim: (v) => v.trim(),
  /** Insert as is inside a regex */
  re: (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  /** Subtract 1 from a number: 2026 -> 2025 (last year's address: {{today|yyyy|dec}}). Empty text if not a number */
  dec: (v) => (/^-?\d+$/.test(v.trim()) ? String(Number(v) - 1) : ''),
  /** 2026-11-27 → 261127 */
  yymmdd: (v) => v.replace(/\D/g, '').slice(2, 8),
  /** 2026-11-27 → 11.27 */
  mmdd: (v) => {
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(v)
    return m ? `${m[1]}.${m[2]}` : v
  },
  /** 19:30 -> 오후 7:30 (7:30 PM) */
  ampm: (v) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(v)
    if (!m) return v
    const h = Number(m[1])
    return `${h < 12 ? AM_KO : PM_KO} ${h % 12 === 0 ? 12 : h % 12}:${m[2]}`
  },
  json: (v) => JSON.stringify(v),
  /** Milliseconds (1794493572000) -> Korean date 2026-11-12. A date text stays as is */
  date: (v) => (/^\d{12,13}$/.test(v.trim()) ? kstDate(Number(v)) : v),
  /** 2026-11-28 -> milliseconds of midnight Korean time that day (1795791600000) */
  ms: (v) => {
    const t = Date.parse(`${v.slice(0, 10)}T00:00:00+09:00`)
    return Number.isNaN(t) ? '' : String(t)
  },
  /** 2026-11-27 → 2026 */
  yyyy: (v) => /^(\d{4})-/.exec(v)?.[1] ?? '',
  /** 2026-03-07 → 03 */
  mm: (v) => /^\d{4}-(\d{2})/.exec(v)?.[1] ?? '',
  /** 2026-03-07 → 3 */
  m: (v) => String(Number(/^\d{4}-(\d{2})/.exec(v)?.[1] ?? '') || ''),
  /** 2026-03-07 → 07 */
  dd: (v) => /^\d{4}-\d{2}-(\d{2})/.exec(v)?.[1] ?? '',
  /** 2026-03-07 → 7 */
  d: (v) => String(Number(/^\d{4}-\d{2}-(\d{2})/.exec(v)?.[1] ?? '') || ''),
  /** 2026-11-27 -> 금 (Fri) */
  dow: (v) => {
    const t = Date.parse(`${v.slice(0, 10)}T00:00:00Z`)
    return Number.isNaN(t) ? '' : (DOW[new Date(t).getUTCDay()] ?? '')
  },
  /** "오늘" (today) or "내일" (tomorrow) if it is, otherwise 11.27 (the date cell of booking apps) */
  kday: (v) => {
    const now = Date.now()
    if (v.startsWith(kstDate(now))) return TODAY_KO
    if (v.startsWith(kstDate(now + 86_400_000))) return TOMORROW_KO
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(v)
    return m ? `${m[1]}.${m[2]}` : v
  },
  /** Date row name: "오늘" (today) if today, otherwise the weekday (booking screens that show today as "오늘 19") */
  daylabel: (v) => {
    if (v.startsWith(kstDate(Date.now()))) return TODAY_KO
    return FILTERS.dow?.(v) ?? v
  },
  /** The day of a date row: two digits, and "M.1" (12.1) on the 1st of the month */
  dd1: (v) => {
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(v)
    if (!m) return ''
    return m[2] === '01' ? `${Number(m[1])}.1` : (m[2] ?? '')
  },
}
/** Names always present when running: today = today's date (Korean time, YYYY-MM-DD) */
/** Names the core fills: today (today's date), account (the account id connected to that service, 0 if none) */
export const BUILTIN_NAMES = ['today', 'account']
export const TEMPLATE_FILTERS = Object.keys(FILTERS)

const EXPR = /\{\{\s*([a-zA-Z_][\w.]*)((?:\s*\|\s*[a-z0-9]+)*)\s*\}\}/g

/** Fills {{name|filter}} in text. A missing value becomes blank */
/** {{#name}}…{{/name}}: fill the inside only when there is a value, {{^name}}…{{/name}}: only when there is none (with an empty input, drop a field like &fromPrice=) */
const SECTION = /\{\{([#^])\s*([a-zA-Z_][\w.]*)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g
const present = (v: unknown) =>
  v !== undefined && v !== null && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0)

/** Group markers (to count groups nested inside others, for checking) */
const SECTION_OPEN = /\{\{[#^]\s*([a-zA-Z_][\w.]*)\s*\}\}/g

export function fill(template: string, scope: Scope): string {
  // A group inside a group ({{#item}}{{^year}}…{{/year}}{{/item}}) is unwrapped from the outside, one layer at a time.
  // Fills happen after all groups are unwrapped, so a {{…}} in input text is not read as a group
  let t = template
  for (let i = 0; i < 8; i++) {
    const next = t.replace(SECTION, (_m, kind: string, path: string, inner: string) =>
      present(pick(scope, path)) === (kind === '#') ? inner : '',
    )
    if (next === t) break
    t = next
  }
  return t.replace(EXPR, (_m, path: string, filters: string) => {
    const raw = pick(scope, path)
    let v = raw === undefined || raw === null ? '' : typeof raw === 'string' ? raw : String(raw)
    for (const f of filters
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean)) {
      // json puts the original value (number, list) in as JSON
      if (f === 'json') v = JSON.stringify(raw ?? null)
      else v = FILTERS[f]?.(v) ?? v
    }
    return v
  })
}

/** If there is only one fill like "{{shops}}", the value as is (list, number); otherwise text */
export function fillValue(template: string, scope: Scope): unknown {
  const one = /^\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}$/.exec(template.trim())
  if (one?.[1]) return pick(scope, one[1])
  return fill(template, scope)
}

/** Names used in fills (for checking): "keyword", "shops.0.name" -> the first segment */
export function templateNames(template: string): { names: string[]; filters: string[] } {
  const names: string[] = []
  const filters: string[] = []
  for (const m of template.matchAll(SECTION_OPEN)) names.push((m[1] ?? '').split('.')[0] ?? '')
  for (const m of template.matchAll(EXPR)) {
    names.push((m[1] ?? '').split('.')[0] ?? '')
    for (const f of (m[2] ?? '')
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean))
      filters.push(f)
  }
  return { names, filters }
}

// ── Checks (when the repo tests and the core load it) ──

/** Whether it is a site address: the host of the address (fills removed) is site or under it */
/** If any of several domains matches (the connect card's site + alsoSites) */
export function onSites(url: string, sites: string | string[]): boolean {
  return (Array.isArray(sites) ? sites : [sites]).some((x) => onSite(url, x))
}

export function onSite(url: string, site: string): boolean {
  try {
    const u = new URL(url.replace(EXPR, 'x'))
    const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(site)
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return false
    const host = local ? u.host : u.hostname
    const base = site.replace(/:\d+$/, '')
    return local ? host === site : host === base || host.endsWith(`.${base}`)
  } catch {
    return false
  }
}

const BANNED = BANNED_INSTRUCTIONS

/** Connector problems as a list people can read. site = the connect card's domain */
/** Fields where candidates to pick are shown as photo cards (the connect card's category) */
export const CARD_CATEGORIES = ['shopping', 'grocery', 'fashion', 'travel', 'tickets', 'media', 'books']

export function checkConnector(
  dir: string,
  raw: unknown,
  site?: string | string[],
  category?: string,
): string[] {
  const r = ConnectorSchema.safeParse(raw)
  if (!r.success) return r.error.issues.map((i) => `${i.path.join('.') || '(whole tool)'}: ${i.message}`)
  const c = r.data
  const problems: string[] = []
  if (c.id !== dir) problems.push(`id (${c.id}) does not match the folder name (${dir})`)
  const seen = new Set<string>()
  for (const t of c.tools) {
    const at = `${t.name}:`
    const full = connectorToolName(c.id, t.name)
    // The MCP tool name gets "mcp__dool2__" added by the runner, and must stay within 64 characters
    if (full.length > 50) problems.push(`${at} tool name is too long (${full})`)
    if (seen.has(t.name)) problems.push(`${at} another tool has the same name`)
    seen.add(t.name)
    const inputs = Object.keys(t.input.properties)
    for (const k of t.input.required)
      if (!inputs.includes(k)) problems.push(`${at} ${k} in required is not an input field`)
    // Names you can use: input fields + names made by earlier steps
    const known = new Set<string>([...inputs, ...BUILTIN_NAMES])
    const useAll = (tpl: string, where: string) => {
      const { names, filters } = templateNames(tpl)
      for (const n of names) if (!known.has(n)) problems.push(`${at} ${where}: {{${n}}} is not defined`)
      for (const f of filters)
        if (!TEMPLATE_FILTERS.includes(f)) problems.push(`${at} ${where}: unknown filter |${f}`)
    }
    // Photo cards (show_cards): lookup lists in these fields need photo and link fields to show as cards (for tools made later too)
    const lists = Object.values(t.output).filter((o) => o.type === 'list')
    if (
      category &&
      CARD_CATEGORIES.includes(category) &&
      t.tier === 'lookup' &&
      t.cards !== false &&
      lists.length
    ) {
      const has = (k: string) => lists.some((o) => o.type === 'list' && k in o.fields)
      if (!has('image') || !has('link'))
        problems.push(
          `${at} for a list of candidates to pick from, add photo (image) and link (link) fields (they show as photo cards in the answer). The photo is {"image": true} in extract or a photo path in the data. If cards do not fit the list, set "cards": false`,
        )
    }
    const kinds = t.steps.map(stepKind)
    t.steps.forEach((s, i) => {
      const where = `step ${i + 1}`
      if (s.if !== undefined) useAll(s.if, `${where} if`)
      if ('open' in s) {
        useAll(s.open, where)
        if (site && !onSites(s.open, site))
          problems.push(`${at} ${where}: only ${site} addresses can be opened (${s.open})`)
      }
      if ('click' in s) useAll(s.click.text, where)
      if ('type' in s) {
        useAll(s.type.text, where)
        useAll(s.type.field, where)
      }
      if ('choose' in s) {
        useAll(s.choose.field, where)
        useAll(s.choose.option, where)
      }
      if ('wait' in s) for (const v of [s.wait.text, s.wait.gone]) if (v) useAll(v, where)
      if ('find' in s) for (const v of Object.values(s.find)) useAll(v, where)
      if ('stop_if' in s) {
        useAll(s.stop_if, where)
        useAll(s.say, where)
      }
      if ('require' in s) {
        useAll(s.require, where)
        useAll(s.say, where)
      }
      if ('account_check' in s) useAll(s.account_check, where)
      if ('capture' in s) {
        useAll(s.capture.url, where)
        try {
          new RegExp(s.capture.url.replace(/\{\{[^}]*\}\}/g, 'x'))
        } catch {
          problems.push(`${at} ${where}: the capture address pattern (regex) is wrong`)
        }
      }
      if ('filter' in s) {
        useAll(`{{${s.filter.from}}}`, where)
        if (s.filter.value) useAll(s.filter.value, where)
      }
      if ('map' in s) {
        useAll(`{{${s.map.from}}}`, where)
        if (typeof s.map.limit === 'string') useAll(s.map.limit, where)
      }
      if ('approve' in s) {
        for (const v of Object.values(s.approve)) if (v) useAll(v, where)
        if (t.tier !== 'pay' && t.tier !== 'contact')
          problems.push(`${at} approval request (approve) can only be put in pay or contact tools`)
        if (i !== t.steps.length - 1) problems.push(`${at} approval request (approve) must be the last step`)
      }
      if ('handoff_to_agent' in s) {
        useAll(s.handoff_to_agent, where)
        if (i !== t.steps.length - 1) problems.push(`${at} handing over to the AI must be the last step`)
      }
      if ('as' in s && s.as) known.add(s.as)
    })
    if (!kinds.includes('open')) problems.push(`${at} a step that opens an address first (open) is needed`)
    else if (kinds[0] !== 'open') problems.push(`${at} the first step must be opening an address (open)`)
    const last = kinds.at(-1)
    if ((t.tier === 'pay' || t.tier === 'contact') && last !== 'approve' && last !== 'handoff_to_agent')
      problems.push(
        `${at} pay and contact tools must end with an approval request (approve) or handing over to the AI`,
      )
    for (const [k, tpl] of Object.entries(t.result)) {
      if (!(k in t.output)) problems.push(`${at} ${k} in result is not in output`)
      useAll(tpl, `result.${k}`)
    }
    if (t.next) useAll(t.next, 'next')
    for (const k of t.expect?.filled ?? []) {
      const ok = Object.values(t.output).some((o) => o.type === 'list' && k in o.fields) || k in t.output
      if (!ok) problems.push(`${at} ${k} in expect.filled is not in output`)
    }
    for (const [i, ex] of t.examples.entries()) {
      for (const k of t.input.required)
        if (!(k in ex)) problems.push(`${at} example ${i + 1} is missing ${k}`)
      for (const k of Object.keys(ex))
        if (!inputs.includes(k)) problems.push(`${at} ${k} in example ${i + 1} is not an input field`)
    }
    const words = [t.description, ...Object.values(t.input.properties).map((p) => p.description)].join('\n')
    for (const re of BANNED) {
      const m = re.exec(words)
      if (m)
        problems.push(
          `${at} a forbidden instruction is present: "${m[0]}" - write it as handing over to a person`,
        )
    }
  }
  return problems
}

/** Input check (before running). A list of problems */
export function checkInput(input: ConnectorInput, args: Record<string, unknown>): string[] {
  const problems: string[] = []
  for (const k of input.required)
    if (args[k] === undefined || args[k] === null || args[k] === '') problems.push(`${k} is required`)
  for (const [k, v] of Object.entries(args)) {
    const p = input.properties[k]
    if (!p) {
      problems.push(`${k} is not a field`)
      continue
    }
    if (v === undefined || v === null) continue
    if (p.type === 'string' && typeof v !== 'string') problems.push(`${k} must be text`)
    if ((p.type === 'integer' || p.type === 'number') && typeof v !== 'number')
      problems.push(`${k} must be a number`)
    if (p.type === 'integer' && typeof v === 'number' && !Number.isInteger(v))
      problems.push(`${k} must be an integer`)
    if (p.type === 'boolean' && typeof v !== 'boolean') problems.push(`${k} must be true or false`)
    if (typeof v === 'string') {
      if (p.enum && !p.enum.includes(v)) problems.push(`${k} must be one of ${p.enum.join(', ')}`)
      if (p.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v))
        problems.push(`${k} must be written as YYYY-MM-DD`)
      if (p.format === 'time' && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v))
        problems.push(`${k} must be written as HH:MM`)
      // Attach the field description so the fix is clear (e.g. "'CGV'는 빼고 (예: 강남)" = leave out 'CGV' (e.g. Gangnam))
      if (p.pattern && !new RegExp(p.pattern).test(v))
        problems.push(
          `${k} has the wrong format (${JSON.stringify(v)})${p.description ? `: ${p.description}` : ''}`,
        )
      if (p.maxLength && v.length > p.maxLength) problems.push(`${k} is too long`)
    }
    if (typeof v === 'number') {
      if (p.minimum !== undefined && v < p.minimum) problems.push(`${k} must be ${p.minimum} or more`)
      if (p.maximum !== undefined && v > p.maximum) problems.push(`${k} must be ${p.maximum} or less`)
    }
  }
  return problems
}

/** Filter condition (one filter step). If want is empty it is always true */
export function matches(v: unknown, op: string, want: string): boolean {
  if (op === 'has') return v !== undefined && v !== null && v !== '' && v !== false
  if (op === 'not') return v === undefined || v === null || v === '' || v === false
  if (want === '') return true
  const num = (x: unknown) => (typeof x === 'number' ? x : Number(String(x).replace(/[^\d.-]/g, '')))
  if (op === 'contains')
    return Array.isArray(v) ? v.some((x) => String(x).includes(want)) : String(v ?? '').includes(want)
  if (op === 'eq') return String(v ?? '') === want
  if (op === 'ne') return String(v ?? '') !== want
  const a = num(v)
  const b = num(want)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b
}

/**
 * Whether the result is healthy (ADR 0020). A list of problems (healthy if none).
 * With canary, it also looks at the number of list rows (expect.rows, default 1). In real use 0 rows can be normal, so it only looks at fields being filled
 */
export function healthProblems(tool: ConnectorTool, out: Record<string, unknown>, canary = false): string[] {
  const problems: string[] = []
  const lists = Object.entries(tool.output).filter(([, o]) => o.type === 'list')
  const filled = tool.expect?.filled ?? []
  for (const [k] of lists) {
    const rows = Array.isArray(out[k]) ? (out[k] as Record<string, unknown>[]) : []
    const min = tool.expect?.rows ?? 1
    if (canary && rows.length < min) problems.push(`${k} has ${rows.length} rows (at least ${min})`)
    if (!rows.length) continue
    for (const f of filled) {
      if (!(f in ((tool.output[k] as { fields?: Record<string, unknown> }).fields ?? {}))) continue
      const n = rows.filter((r) => {
        const v = r?.[f]
        return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)
      }).length
      if (n / rows.length < 0.8) problems.push(`${k}.${f} is filled in only ${n} of ${rows.length} rows`)
    }
  }
  for (const f of filled) {
    if (!(f in tool.output) || tool.output[f]?.type === 'list') continue
    const v = out[f]
    if (v === null || v === undefined || v === '') problems.push(`${f} is empty`)
  }
  return problems
}

/** Take the first JSON chunk ({…} or […]) after the marker out of text. Parentheses inside quotes are not counted */
export function jsonAfter(text: string, marker: string): string | undefined {
  const at = text.indexOf(marker)
  if (at < 0) return undefined
  let i = at + marker.length
  while (i < text.length && text[i] !== '{' && text[i] !== '[') i++
  const start = i
  let depth = 0
  let quote = ''
  for (; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}
