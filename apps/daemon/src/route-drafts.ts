// Connector drafts from remembered routes (ADR 0034 follow-up, ADR 0018). `pnpm connector routes` reads routes.json,
// keeps the routes that reached their page often and rarely stopped, and writes each site's routes as a draft
// skills/<id>/tools.json for a person to review. Only lookup tools, and nothing is registered: the draft carries a
// `_draft` block the connector schema refuses, so neither the daemon nor `pnpm connector check` accepts the file
// until a person has reviewed it and removed that block.
import { type Connector, type ConnectorTool, checkConnector } from '@dool2/protocol/connector'
import { TOOL_STATUS } from './region/kr/connectors.js'
import { type Route, routeCounts, stepNameOk, TYPE_MARK } from './routes.js'

/** A route becomes a draft once it reached its page this many times (with browser_route or by hand) */
export const DRAFT_MIN_SUCCESSES = 3
/** …and reached it at least this often out of all its walks */
export const DRAFT_MIN_RATE = 0.8
/** Most tools in one connector (ConnectorSchema) */
const MAX_TOOLS = 12

/** The part of a service card the export needs (skills/<id>/connect.json) */
export interface CardSites {
  id: string
  site?: string
  alsoSites?: string[]
  /** Tool names already in skills/<id>/tools.json (so draft names do not clash) */
  tools?: string[]
}

export interface DraftRoute {
  tool: string
  successes: number
  failures: number
  /** What was left out of the draft because it could be personal */
  stripped: string[]
}

export interface Draft {
  /** Service id: an existing card's, or one made from the site address */
  id: string
  /** Whether skills/<id>/connect.json already exists */
  existing: boolean
  /** The card's domains, or for a new card the domain to write in its `site` */
  sites: string[]
  routes: DraftRoute[]
  /** The file to write: a connector plus the `_draft` block */
  file: Connector & { _draft: Record<string, unknown> }
  /** Problems `checkConnector` finds in the draft without its `_draft` block (empty when the shape is right) */
  problems: string[]
}

export interface Skipped {
  route: string
  host: string
  why: string
}

export interface RouteDrafts {
  total: number
  drafts: Draft[]
  skipped: Skipped[]
}

/** Whether a route was walked often enough, and rarely stopped, to be worth a connector */
export function qualifies(r: Route): boolean {
  const { ok, failed } = routeCounts(r)
  return ok >= DRAFT_MIN_SUCCESSES && ok / (ok + failed) >= DRAFT_MIN_RATE
}

/**
 * A path segment that looks like an account, member or order id, a token or an email: the address belongs to one
 * person there, not to the site
 */
function personalSegment(seg: string): boolean {
  let s = seg
  try {
    s = decodeURIComponent(seg)
  } catch {}
  if (/@/.test(s)) return true
  if (/\d{4,}/.test(s)) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true
  // Long mixes of letters and digits (tokens, hashed ids)
  return s.length >= 12 && /\d/.test(s) && /[a-z]/i.test(s) && !/[-_.]/.test(s)
}

/** The start address with anything personal removed, and what was removed */
export function cleanStart(url: string): { open?: string; stripped: string[] } {
  const stripped: string[] = []
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { stripped: ['the start address could not be read'] }
  }
  if (u.protocol !== 'https:') return { stripped: ['the start address is not https'] }
  if (u.username || u.password) stripped.push('sign-in name in the start address')
  if (u.search) stripped.push('query string of the start address')
  if (u.hash) stripped.push('part after # in the start address')
  const segs = u.pathname.split('/')
  const cut = segs.findIndex((s, i) => i > 0 && s !== '' && personalSegment(s))
  let path = u.pathname
  if (cut > 0) {
    path = `${segs.slice(0, cut).join('/')}/`
    stripped.push(`an id-like part of the start address (the draft starts at ${path} instead)`)
  }
  return { open: `https://${u.host}${path}`, stripped }
}

/** Service id for a site with no card: the name part of the domain (www.shop-example.co.kr → shop-example) */
export function idForHost(host: string): string {
  const labels = host
    .toLowerCase()
    .replace(/:\d+$/, '')
    .split('.')
    .filter((l) => l && l !== 'www' && l !== 'm')
  // Two-part endings like co.kr, or.jp, com.tw
  const twoPart = labels.length >= 3 && (labels.at(-2)?.length ?? 0) <= 3 && labels.at(-1)?.length === 2
  const name = labels.at(twoPart ? -3 : -2) ?? labels[0] ?? 'site'
  const id = name.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
  return /^[a-z0-9]/.test(id) ? id.slice(0, 40) : `site-${id}`.slice(0, 40)
}

function cardFor(host: string, cards: CardSites[]): CardSites | undefined {
  const h = host.toLowerCase().replace(/:\d+$/, '')
  return cards.find((c) =>
    [c.site, ...(c.alsoSites ?? [])].some((s) => s && (h === s || h.endsWith(`.${s}`))),
  )
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function draftTool(name: string, open: string, steps: string[], successes: number): ConnectorTool {
  const path = new URL(open).pathname
  const walk = steps.map((s) => `'${s}'`).join(' → ')
  return {
    name,
    title: (steps.at(-1) ?? name).slice(0, 30),
    description:
      `DRAFT from remembered routes: rewrite before use. Opens ${path} and presses ${walk} (reached the page ${successes} times), then hands that page to the AI. Say when to use it, what it returns and what to do next.`.slice(
        0,
        600,
      ),
    tier: 'lookup',
    login: false,
    status: TOOL_STATUS.draft,
    input: { properties: {}, required: [] },
    output: {},
    examples: [{}],
    steps: [
      { open },
      ...steps.flatMap((text) => [
        // soft: a button named only by its label (an icon) is not in the page text; the click then decides
        { wait: { text: escapeRe(text), timeoutMs: 10_000, soft: true } },
        { click: { text } },
        { sleep: 800 },
      ]),
      {
        handoff_to_agent:
          `DRAFT: this is the page after ${walk}. Read what the user asked for here. Replace this step with extract, embedded or capture once the page is known.`.slice(
            0,
            500,
          ),
      },
    ],
    result: {},
  }
}

/**
 * Drafts from remembered routes: one per service, only lookup tools, only routes that qualify, with personal parts
 * of the address removed and page titles left out. `today` is written in the draft block
 */
export function routeDrafts(routes: Route[], cards: CardSites[], today: string): RouteDrafts {
  const skipped: Skipped[] = []
  const byId = new Map<string, Draft>()
  const sorted = [...routes].sort((a, b) => routeCounts(b).ok - routeCounts(a).ok)
  for (const r of sorted) {
    const host = String(r.host ?? '')
    const label = `[${r.id}] ${(r.steps ?? []).length} clicks`
    const { ok, failed } = routeCounts(r)
    if (!qualifies(r)) {
      skipped.push({
        route: label,
        host,
        why: `reached its page ${ok} times, stopped ${failed} times (needs ${DRAFT_MIN_SUCCESSES}+ and ${Math.round(DRAFT_MIN_RATE * 100)}%+)`,
      })
      continue
    }
    const steps = (r.steps ?? []).map((s) => String(s).trim())
    // Routes that type are not drafted yet (a connector step would need the input as a parameter)
    if (steps.some((s) => s.startsWith(TYPE_MARK))) {
      skipped.push({ route: label, host, why: 'it types into a field (not drafted yet)' })
      continue
    }
    if (!steps.length || !steps.every((s) => stepNameOk(s) && !/[{}]/.test(s))) {
      skipped.push({ route: label, host, why: 'a click name looks like a number, address or email' })
      continue
    }
    const { open, stripped } = cleanStart(r.start)
    if (!open) {
      skipped.push({ route: label, host, why: stripped.join(', ') })
      continue
    }
    const site = new URL(open).hostname
    const card = cardFor(site, cards)
    const id = card?.id ?? idForHost(site)
    let d = byId.get(id)
    if (!d) {
      d = {
        id,
        existing: Boolean(card),
        sites: card
          ? [card.site, ...(card.alsoSites ?? [])].filter((x): x is string => Boolean(x))
          : [site.replace(/^(www|m)\./, '')],
        routes: [],
        file: { _draft: {}, id, tools: [] },
        problems: [],
      }
      byId.set(id, d)
    }
    if (d.file.tools.length >= MAX_TOOLS) {
      skipped.push({ route: label, host, why: `the draft for ${id} already has ${MAX_TOOLS} tools` })
      continue
    }
    const taken = new Set([...(card?.tools ?? []), ...d.file.tools.map((t) => t.name)])
    let n = d.file.tools.length + 1
    while (taken.has(`route_${n}`)) n++
    const name = `route_${n}`
    if (r.title) stripped.push('page title (it can hold a name)')
    d.file.tools.push(draftTool(name, open, steps, ok))
    d.routes.push({ tool: name, successes: ok, failures: failed, stripped })
  }
  const drafts = [...byId.values()]
  for (const d of drafts) {
    d.file._draft = {
      note: 'Made from remembered routes by `pnpm connector routes`. Not usable until a person reviews it: rewrite each tool, then delete this _draft block (the daemon and `pnpm connector check` refuse the file while it is here).',
      made: today,
      minSuccesses: DRAFT_MIN_SUCCESSES,
      minRate: DRAFT_MIN_RATE,
      routes: d.routes,
    }
    const { _draft, ...connector } = d.file
    d.problems = checkConnector(d.id, connector, d.sites)
    // Keep the block first in the file so it is the first thing a reader sees
    d.file = { _draft, ...connector }
  }
  return { total: routes.length, drafts, skipped }
}
