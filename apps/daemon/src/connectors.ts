// Service tool (connector) runner (ADR 0018). Reads skills/<id>/tools.json and runs it as engine steps.
//
// - A connector is data. It can only do the engine steps listed here, and clicks and typing go through
//   BrowserTools, so they get the same risk check (approval gate). Lookup tools cannot press risky buttons at all.
// - The AI sees only the tools of connected services (+ services without login) directly (catalog); the rest go
//   through service_find → service_call.
// - When a step fails, it returns the open tab number with "continue with browser tools", and records the
//   breakage since the site may have changed.
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MIN_CONNECTOR_EXTENSION, versionAtLeast } from '@dool2/protocol'
import { CONNECT_CATEGORIES, type ConnectCard, type ConnectionTool } from '@dool2/protocol/connect'
import {
  type Connector,
  ConnectorSchema,
  type ConnectorTool,
  checkInput,
  connectorToolName,
  fill,
  fillValue,
  healthProblems,
  jsonAfter,
  matches,
  type OutputField,
  onSite,
  onSites,
  pick,
  type Scope,
  type Step,
  stepKind,
  tierAnnotations,
} from '@dool2/protocol/connector'
import {
  type BrowserCaller,
  type BrowserTools,
  GATE_STOP,
  type RiskKind,
  type ToolResult,
} from './browser-tools.js'
import type { ConnectorHealth, Outcome } from './connector-health.js'
import type { Journal } from './journal.js'
import {
  AREA_SUFFIX,
  AREA_WORD,
  EXTENSION_OFFLINE,
  HUMAN_CHECK,
  MY_ADDRESS,
  SNAPSHOT_ROLE,
  TOOL_STATUS,
  YES,
} from './region/kr/connectors.js'

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
/** Gap between back-to-back opens of the same service. Opening many at once gets blocked (Coupang, 2026-11-18) */
const SITE_GAP_MS = 1500
/** Read length when a mark was not found (a normal read is 8,000 chars) */
const LONG_READ = 60_000
/** Extension-offline errors once the browser bridge message is in English (see EXTENSION_OFFLINE) */
const EXTENSION_OFFLINE_EN = /extension.*not connected|not connected.*extension/i

/** One tool shown to the AI (the MCP server registers it as is) */
export interface ServiceToolSpec {
  name: string
  title: string
  description: string
  input: ConnectorTool['input']
  output: ConnectorTool['output']
  annotations: ReturnType<typeof tierAnnotations>
}

interface Loaded {
  card: ConnectCard
  connector?: Connector
  /** The problem, when tools.json exists but has the wrong shape */
  broken?: string
}

/** A breakage record (to see whether a site changed) */
export interface Breakage {
  tool: string
  step: number
  kind: string
  reason: string
  url?: string
  at: string
}

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {}),
})

/** Today's date (Korea time, YYYY-MM-DD) */
function today(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10)
}

/** Store a read value under a name. With append, add to the list collected so far (several periods or pages in one list) */
function keep(scope: Scope, name: string, value: unknown, append?: boolean) {
  const before = scope[name]
  if (!append || before === undefined || before === null) {
    scope[name] = value
    return
  }
  const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
  scope[name] = [...list(before), ...list(value)]
}

/** Step failed: stuck at this step (skipped when optional) */
class StepError extends Error {}
/** Stopped by the risk check (the message is returned as is) */
class GuardStop extends Error {}

export class Connectors {
  private cache?: { at: number; items: Map<string, Loaded> }
  /** One reused tab per service (so tabs do not pile up) */
  private tabs = new Map<string, number>()
  /** Last result for the same input (minIntervalSec) */
  private recent = new Map<string, { at: number; result: ToolResult }>()
  /** One call at a time per service: queue calls so they do not move the same tab at once */
  private lanes = new Map<string, Promise<unknown>>()
  private lastRun = new Map<string, number>()
  readonly breakages: Breakage[] = []

  constructor(
    private readonly opts: {
      dir: string | undefined
      browser: BrowserCaller
      tools: BrowserTools
      /** Connected service id → time */
      connected: () => Record<string, string>
      now?: () => Date
      /** Poll interval (shorter in tests) */
      pollMs?: number
      /** Health record (ADR 0020): tools that keep breaking rest for a while */
      health?: ConnectorHealth
      /** Activity log: each tool call keeps its result, time taken and reason for a few days */
      journal?: Journal
      /** Connected extension version (older extensions have no connector engine) */
      extensionVersion?: () => string | undefined
      /** Gap between back-to-back opens of the same service (shorter in tests) */
      gapMs?: number
      /**
       * Account ID connected to this service (vault). Goes into {{account}} in tool URLs —
       * when another Google account was signed in to Chrome first, /mail/u/0 opened the wrong mailbox (measured)
       */
      accountFor?: (card: ConnectCard) => Promise<string | undefined>
      /**
       * Address from my info (unmasked). The daemon fills a tool's address field when it is empty or "my address" —
       * the AI only saw the masked address, typed just the neighborhood, and that became the delivery address
       * (measured on Yogiyo: "Sinbong-dong 33")
       */
      homeAddress?: () => Promise<string | undefined>
      /**
       * The user's last message (time, text). Used to flag a pay tool (order prep) called before the user picked —
       * the AI ignored the "let them pick from 2–3 cards" guidance and picked alone (measured, grocery 3)
       */
      lastUser?: () => { at: number; text: string } | undefined
    },
  ) {}

  /** The extension version, when it is older than the connector engine (undefined when unknown: try and see) */
  private oldExtension(): string | undefined {
    const v = this.opts.extensionVersion?.()
    return v && !versionAtLeast(v, MIN_CONNECTOR_EXTENSION) ? v : undefined
  }

  /** A tool that is not resting and not marked blocked */
  private live(card: ConnectCard, t: ConnectorTool) {
    return this.usable(t) && !this.opts.health?.resting(connectorToolName(card.id, t.name), toolPrint(t))
  }

  private now() {
    return (this.opts.now ?? (() => new Date()))()
  }

  /** Service tool name → title (for showing work steps, after loading) */
  private titles = new Map<string, string>()
  titleOf(name: string): string | undefined {
    return this.titles.get(name)
  }

  /** Reads cards and connectors (not again within 10 seconds) */
  async load(): Promise<Map<string, Loaded>> {
    if (this.cache && Date.now() - this.cache.at < 10_000) return this.cache.items
    const items = new Map<string, Loaded>()
    const dir = this.opts.dir
    if (dir) {
      const { ConnectCardSchema } = await import('@dool2/protocol/connect')
      for (const n of (await readdir(dir).catch(() => [] as string[])).sort()) {
        if (!NAME.test(n)) continue
        const raw = await readFile(join(dir, n, 'connect.json'), 'utf8').catch(() => undefined)
        if (!raw) continue
        let card: ConnectCard
        try {
          const r = ConnectCardSchema.safeParse(JSON.parse(raw))
          if (!r.success || r.data.id !== n) continue
          card = r.data
        } catch {
          continue
        }
        const loaded: Loaded = { card }
        const tj = await readFile(join(dir, n, 'tools.json'), 'utf8').catch(() => undefined)
        if (tj) {
          try {
            const r = ConnectorSchema.safeParse(JSON.parse(tj))
            if (r.success && r.data.id === n) loaded.connector = r.data
            else
              loaded.broken = r.success
                ? 'id does not match the folder name'
                : (r.error.issues[0]?.message ?? 'invalid format')
          } catch (e) {
            loaded.broken = (e as Error).message
          }
        }
        items.set(n, loaded)
      }
    }
    this.titles = new Map(
      [...items.values()].flatMap(({ card, connector }) =>
        (connector?.tools ?? []).map(
          (t) => [connectorToolName(card.id, t.name), t.title] as [string, string],
        ),
      ),
    )
    this.cache = { at: Date.now(), items }
    return items
  }

  /**
   * Test PC: run a tool definition (tools.json) that is not installed yet once in this PC's real Chrome.
   * Sites that block the test Chrome (Coupang, 29CM, …) open in the user's Chrome, so fixed definitions are checked here.
   * Ignores status (draft, blocked), resting and the same-input interval. Reports empty result fields (silent breakage)
   */
  async tryDraft(
    raw: unknown,
    toolName: string,
    input: Record<string, unknown>,
    o: { close?: boolean } = {},
  ): Promise<ToolResult> {
    const r = ConnectorSchema.safeParse(raw)
    if (!r.success)
      return text(
        `The tool definition has the wrong shape: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`,
        true,
      )
    const card = (await this.load()).get(r.data.id)?.card
    if (!card) return text(`This PC has no connect card for ${r.data.id}`, true)
    const tool = r.data.tools.find((t) => t.name === toolName)
    if (!tool) return text(`${r.data.id} has no tool named ${toolName}`, true)
    const args: Record<string, unknown> = {}
    for (const [k, p] of Object.entries(tool.input.properties))
      if (p.default !== undefined) args[k] = p.default
    for (const [k, v] of Object.entries(input ?? {})) if (v !== undefined && v !== null) args[k] = v
    await this.fillHome(tool, args)
    const bad = checkInput(tool.input, args)
    if (bad.length) return text(`Fix the input: ${bad.join(', ')}`, true)
    const pick = this.pickGate(card.id, tool)
    // Connected account: only for tools with {{account}} in a URL (none = 0, Chrome's first account)
    if (args.account === undefined && JSON.stringify(tool.steps).includes('{{account'))
      args.account = (await this.opts.accountFor?.(card).catch(() => undefined)) || '0'
    const { outcome, detail, ...ran } = await this.inLane(card.id, () => this.execute(card, tool, args))
    const result = withNote(ran, pick)
    // Do not pile up tabs in the user's Chrome when testing many services in a row (an 8 GB Mac froze once)
    const tab = this.tabs.get(card.id)
    if (o.close && tab !== undefined) {
      await this.opts.browser.call('close', { tabId: tab }).catch(() => undefined)
      this.tabs.delete(card.id)
    }
    const sick =
      outcome === 'ok' && result.structuredContent ? healthProblems(tool, result.structuredContent) : []
    return sick.length
      ? {
          ...result,
          content: [
            ...result.content,
            { type: 'text', text: `(Result fields are empty: ${sick.join(', ')})` },
          ],
        }
      : result
  }

  /** Tests and development: reread right after a file changes */
  invalidate() {
    this.cache = undefined
  }

  /**
   * Fills an empty or "my address" address field with the address from my info. When it names the same
   * neighborhood but has none of my street numbers (the AI guessed just the area), replaces it with my address —
   * sending somewhere else starts with a different neighborhood
   */
  private async fillHome(tool: ConnectorTool, args: Record<string, unknown>) {
    const keys = Object.keys(tool.input.properties).filter((k) => /address|addr/i.test(k))
    if (!keys.length || !this.opts.homeAddress) return
    const home = await this.opts.homeAddress().catch(() => undefined)
    if (!home) return
    for (const k of keys) {
      const v = args[k]
      const ask = v === undefined || v === '' || (typeof v === 'string' && MY_ADDRESS.test(v))
      if (ask) {
        args[k] = home
        continue
      }
      if (typeof v !== 'string') continue
      // Same neighborhood (start of the dong/ro name) but none of my address numbers: a guessed address
      const stems = home
        .split(/\s+/)
        .filter((w) => AREA_WORD.test(w))
        .map((w) => w.replace(AREA_SUFFIX, ''))
        .filter((w) => w.length >= 2)
      const nums = (t: string): string[] => t.match(/\d+/g) ?? []
      const sameArea = stems.some((st) => v.includes(st))
      const hasNum = nums(home).some((n) => nums(v).includes(n))
      if (sameArea && !hasNum) args[k] = home
    }
  }

  /**
   * When order prep (pay) is called right after a lookup with no new user message, adds a line to the result. It
   * does not block: the AI, which sees the chat, judges whether the user already picked ("just order it" etc.)
   * (it used to stop on a regex over the message). No money moves here: the last pay button gets its own approval
   * on the payment card
   */
  private findAt = new Map<string, number>()
  private pickGate(cardId: string, tool: ConnectorTool): string | undefined {
    if (tool.tier === 'lookup') {
      this.findAt.set(cardId, Date.now())
      return undefined
    }
    if (tool.tier !== 'pay') return undefined
    const found = this.findAt.get(cardId)
    const user = this.opts.lastUser?.()
    if (!found || !user || user.at > found) return undefined
    return '(You came to order prep right after a lookup, with no new message from the user. If the user has not picked yet, show 2–3 of the found options with show_cards, let them pick, and end this reply. If they already picked (including asking you to decide for them), go ahead.)'
  }

  private usable(t: ConnectorTool) {
    return !t.status.startsWith(TOOL_STATUS.blocked)
  }

  private isConnected(card: ConnectCard) {
    const on = this.opts.connected()
    return (
      card.how === 'open' ||
      card.how === 'device' ||
      Boolean(on[card.id]) ||
      Boolean(card.sameLoginAs && on[card.sameLoginAs])
    )
  }

  /** Directly visible tools: those of connected services and services without login (open) */
  async catalog(): Promise<ServiceToolSpec[]> {
    const out: ServiceToolSpec[] = []
    if (this.oldExtension()) return out
    for (const { card, connector } of (await this.load()).values()) {
      if (!connector || !this.isConnected(card)) continue
      for (const t of connector.tools) if (this.live(card, t)) out.push(this.spec(card, t))
    }
    return out
  }

  /** Tool guide the AI sees: description + input examples + status */
  spec(card: ConnectCard, t: ConnectorTool): ServiceToolSpec {
    const ex = t.examples.map((e) => JSON.stringify(e)).join(' / ')
    const notes = [
      `[${card.name} · ${t.tier}${t.login ? ' · needs connection' : ''}]`,
      t.description,
      `Input examples: ${ex}`,
      t.status === TOOL_STATUS.draft ? '(This tool is new. Double-check its results)' : '',
    ]
    return {
      name: connectorToolName(card.id, t.name),
      title: `${card.name}: ${t.title}`,
      description: notes.filter(Boolean).join('\n'),
      input: t.input,
      output: t.output,
      annotations: tierAnnotations(t.tier),
    }
  }

  /** Look up by tool name */
  private async resolve(name: string): Promise<{ card: ConnectCard; tool: ConnectorTool } | undefined> {
    for (const { card, connector } of (await this.load()).values()) {
      for (const t of connector?.tools ?? [])
        if (connectorToolName(card.id, t.name) === name) return { card, tool: t }
    }
    return undefined
  }

  /** The connector for a URL's site, if any (to suggest its tools when the site is opened in the browser) */
  async forUrl(url: string): Promise<{ id: string; name: string; tools: string[] } | undefined> {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return undefined
    }
    for (const { card, connector } of (await this.load()).values()) {
      const sites = [card.site, ...(card.alsoSites ?? [])]
        .filter(Boolean)
        .map((x) => (x as string).replace(/:\d+$/, ''))
      if (!connector || !sites.some((site) => host === site || host.endsWith(`.${site}`))) continue
      const tools = connector.tools
        .filter((t) => this.live(card, t))
        .map((t) => connectorToolName(card.id, t.name))
      if (tools.length) return { id: card.id, name: card.name, tools }
    }
    return undefined
  }

  /**
   * Sites of services that have a pay tool. Tabs on these sites are a payment flow even when opened without a tool
   * (measured: the AI went straight to a hotel tab from an earlier chat and asked approval again for the [Book]
   * button that only opens checkout)
   */
  async paySites(): Promise<string[]> {
    const out: string[] = []
    for (const { card, connector } of (await this.load()).values()) {
      if (!connector?.tools.some((t) => t.tier === 'pay' && this.usable(t))) continue
      for (const site of [card.site, ...(card.alsoSites ?? [])])
        if (site) out.push(site.replace(/:\d+$/, '').replace(/^www\./, ''))
    }
    return out
  }

  /**
   * Connector status summary and tool names for the connect screen. The status is a catalog data value
   * (TOOL_STATUS: verified(date) / draft / blocked), the same words as tools.json
   */
  async summary(id: string): Promise<{ status?: string; tools?: ConnectionTool[] }> {
    const c = (await this.load()).get(id)?.connector
    if (!c) return {}
    const ok = c.tools.filter((t) => t.status.startsWith(TOOL_STATUS.verified))
    const status = ok.length
      ? `${TOOL_STATUS.verified}(${ok
          .map((t) => /\d{4}-\d{2}-\d{2}/.exec(t.status)?.[0] ?? '')
          .sort()
          .at(-1)})`
      : c.tools.some((t) => this.usable(t))
        ? TOOL_STATUS.draft
        : TOOL_STATUS.blocked
    const tools = c.tools
      .filter((t) => this.usable(t))
      .map((t) => ({
        name: connectorToolName(id, t.name),
        title: t.title,
        tier: t.tier,
        login: t.login,
        verified: t.status.startsWith(TOOL_STATUS.verified),
      }))
    return { status, tools }
  }

  forgetTab(tabId: number) {
    for (const [k, v] of this.tabs) if (v === tabId) this.tabs.delete(k)
  }

  // ── Find a service (service_find) ──

  async find(query: string): Promise<ToolResult> {
    const items = [...(await this.load()).values()].filter((x) => x.card.how !== 'device')
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const score = ({ card, connector }: Loaded) => {
      const head = [card.id, card.name, card.site ?? ''].join(' ').toLowerCase()
      const body = [
        card.summary,
        CONNECT_CATEGORIES[card.category],
        ...card.abilities.flatMap((a) => [a.title, a.say]),
        ...(connector?.tools.flatMap((t) => [t.title, t.description]) ?? []),
      ]
        .join(' ')
        .toLowerCase()
      const n = words.reduce((sum, w) => sum + (head.includes(w) ? 3 : body.includes(w) ? 1 : 0), 0)
      return n > 0 ? n + (connector ? 2 : 0) + (this.isConnected(card) && card.how !== 'open' ? 3 : 0) : 0
    }
    const hit = (
      words.length
        ? items
            .map((it) => ({ it, n: score(it) }))
            .filter((x) => x.n > 0)
            .sort((a, b) => b.n - a.n)
            .map((x) => x.it)
        : items
    ).slice(0, 5)
    if (!hit.length)
      return text(
        `No matching service. Try a web search or the browser tools. (Services: ${items.map((x) => x.card.id).join(', ')})`,
      )
    // A service that is not connected yet may not be the one the user uses: for "my ..." tasks, ask before deciding
    // (measured 11-22: the catalog had a single carrier, so the AI assumed the user was on it and showed someone
    // else's plans and a connect card)
    const unsure = hit.some((it) => !this.isConnected(it.card) && it.card.how !== 'open')
    const caution = unsure
      ? '\n\n⚠️ A "not connected" service may not be the one the user actually uses (it could be another company of the same kind). For tasks that need the user\'s account, like my plan, my coverage or my history, first ask which one they use with quick reply buttons, before settling on this service or showing a connect card. Remember the answer with know_save.'
      : ''
    return text(hit.map((it) => this.describe(it)).join('\n\n') + caution)
  }

  /** One service as text for the AI: connection state, tools (tier, input), connection guide */
  private describe({ card, connector }: Loaded): string {
    const connected = this.isConnected(card)
    const state = card.how === 'open' ? 'no login needed' : connected ? 'connected' : 'not connected'
    const lines = [`## ${card.name} (${card.id}) — ${state}`, card.summary]
    const tools = connector?.tools.filter((t) => this.usable(t)) ?? []
    if (!tools.length) {
      lines.push(
        'No Dool2 service tools yet. Use the browser tools' + (card.site ? ` (https://${card.site}/).` : '.'),
        ...(card.hints ?? []).map((h) => `- Tip: ${h}`),
      )
      if (!connected && (card.how === 'browser' || card.how === 'official'))
        lines.push(`When a step needs login, show the connect card with connect_ask('${card.id}').`)
      return lines.join('\n')
    }
    for (const t of tools) {
      const need = this.opts.health?.resting(connectorToolName(card.id, t.name), toolPrint(t))
        ? 'resting after recent failures — use browser tools'
        : t.login && !connected
          ? 'needs connection'
          : t.login
            ? 'connected'
            : 'no login'
      const args = Object.entries(t.input.properties)
        .map(
          ([k, p]) =>
            `${k}${t.input.required.includes(k) && !/address|addr/i.test(k) ? '*' : ''}(${p.description.split(/[.(]/)[0]?.trim()}${/address|addr/i.test(k) ? ' — leave empty or "my address" to use the address in my info' : ''})`,
        )
        .join(', ')
      lines.push(
        `- ${connectorToolName(card.id, t.name)} [${t.tier} · ${need}] ${t.title} — input: ${args || 'none'}`,
      )
    }
    // Site tips are shown even when there are tools (so the AI knows where to do things outside the tools,
    // e.g. checking unclaimed refunds on Gov24)
    lines.push(...(card.hints ?? []).map((h) => `- Tip: ${h}`))
    const locked = tools.filter((t) => t.login && !connected)
    if (locked.length)
      lines.push(
        `After connecting: ${locked.map((t) => t.title).join(', ')}. When you reach that step, show the connect card with connect_ask('${card.id}') and end the reply. Looking things up first with tools that need no login is fine.`,
      )
    lines.push(
      connected
        ? 'If it is in the directly visible tool list, call it as is; otherwise call it with service_call.'
        : "Call it with service_call({ tool: '<tool name>', input: { … } }).",
    )
    return lines.join('\n')
  }

  // ── All my orders (orders_all) ──
  // When it is unclear which shop ("where's my package", "it arrived dented, claim", "return what I bought last
  // week"), runs the order lookup of every connected shop at once.
  // (measured 11-21: the AI checked only Coupang, skipped the connected Naver Pay and Gmarket, and asked
  // "where did you buy it?")
  async ordersAll(): Promise<ToolResult> {
    const picks: { card: ConnectCard; name: string }[] = []
    for (const { card, connector } of (await this.load()).values()) {
      if (!connector || !this.isConnected(card)) continue
      const t = connector.tools.find((x) => x.name === 'orders')
      if (t && this.live(card, t)) picks.push({ card, name: connectorToolName(card.id, t.name) })
    }
    if (!picks.length)
      return text(
        'No shop is connected for viewing orders. When you ask where they bought it, also show connect cards for common shops (Coupang, Naver) with connect_ask.',
      )
    const results = await Promise.all(
      picks.map(async (p) => {
        const r = await this.call(p.name, {}).catch((e: Error) => text(e.message, true))
        const body = r.content
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('\n')
          .trim()
        return `## ${p.card.name}${r.isError ? ' (could not check)' : ''}\n${body.slice(0, 6000)}`
      }),
    )
    return text(
      [
        `Recent orders from ${picks.length} connected shops (${picks.map((p) => p.card.name).join(', ')}).`,
        ...results,
        'If the user needs to pick one (which package, which order), merge the shops into one show_list pick one. Each row: product (title), shop and order date (sub), delivery status (state). For tracking numbers in email (other shops, gifts), search the mail too.',
      ].join('\n\n'),
    )
  }

  // ── Run (service_call, directly visible tools) ──

  async call(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const found = await this.resolve(name)
    if (!found) return text(`No such service tool: ${name}. Check the name with service_find.`, true)
    const { card, tool } = found
    if (!this.usable(tool))
      return text(
        `${card.name}'s '${tool.title}' tool is blocked right now (${tool.status}). Use the browser tools.`,
        true,
      )
    // Fill defaults → check input
    const args: Record<string, unknown> = {}
    for (const [k, p] of Object.entries(tool.input.properties))
      if (p.default !== undefined) args[k] = p.default
    for (const [k, v] of Object.entries(input ?? {})) if (v !== undefined && v !== null) args[k] = v
    await this.fillHome(tool, args)
    const bad = checkInput(tool.input, args)
    if (bad.length) return text(`Fix the input: ${bad.join(', ')}`, true)
    const pick = this.pickGate(card.id, tool)
    // Connected account: only for tools with {{account}} in a URL (none = 0, Chrome's first account)
    if (args.account === undefined && JSON.stringify(tool.steps).includes('{{account'))
      args.account = (await this.opts.accountFor?.(card).catch(() => undefined)) || '0'
    if (tool.login && !this.isConnected(card))
      return text(
        `${card.name} needs to be connected ('${tool.title}' needs login). Show the connect card with connect_ask('${card.id}'), briefly ask the user to connect on the card, and end the reply. An app notification comes when it is connected. Then call this tool again.`,
        true,
      )
    const key = `${name} ${JSON.stringify(args)}`
    const last = this.recent.get(key)
    if (tool.minIntervalSec && last && Date.now() - last.at < tool.minIntervalSec * 1000) {
      const min = Math.max(1, Math.round((Date.now() - last.at) / 60_000))
      return {
        ...last.result,
        content: [
          ...last.result.content,
          {
            type: 'text',
            text: `(Now ${checkedAt()}. The result above is from ${min} min ago (${checkedAt(last.at)}). Not checked again, to avoid asking the site too often)`,
          },
        ],
      }
    }
    const old = this.oldExtension()
    if (old) this.opts.journal?.write('tool', { tool: name, outcome: 'old-extension', detail: old })
    if (old)
      return text(
        `The Dool2 extension in Chrome is an old version (${old}), so service tools cannot run. Do the same task with the browser tools. They work again once the extension is updated to ${MIN_CONNECTOR_EXTENSION} or later.`,
        true,
      )
    const rest = this.opts.health?.resting(name, toolPrint(tool))
    if (rest)
      return text(
        `${card.name}'s '${tool.title}' tool is resting because the site changed recently (${rest.reason}). Do the same task with the browser tools.`,
        true,
      )
    const startedAt = Date.now()
    const { outcome, detail, ...ran } = await this.inLane(card.id, () => this.execute(card, tool, args))
    const result = withNote(ran, pick)
    // A result came back but a field that should be filled is empty: silent breakage (ADR 0020)
    let final: ToolResult = result
    let seen = outcome
    let why = detail
    if (outcome === 'ok' && result.structuredContent) {
      const sick = healthProblems(tool, result.structuredContent)
      if (sick.length) {
        seen = 'empty'
        why = sick.join(', ')
        final = {
          ...result,
          content: [
            ...result.content,
            {
              type: 'text',
              text: `(Result fields are empty: ${why}. The site may have changed, so check the screen with the browser tools)`,
            },
          ],
        }
      }
    }
    // When the extension was disconnected (app restart, Chrome closed), the tool is not broken: counting it would
    // rest a working tool for 6 hours
    const offline = EXTENSION_OFFLINE.test(why ?? '') || EXTENSION_OFFLINE_EN.test(why ?? '')
    if (seen && !offline) this.opts.health?.record(name, seen, why, toolPrint(tool))
    // Input values (search words, addresses, …) are not logged: only tool name, outcome, reason and time taken
    this.opts.journal?.write('tool', {
      tool: name,
      outcome: seen ?? (final.isError ? 'error' : 'ok'),
      ...(why ? { detail: why } : {}),
      ms: Date.now() - startedAt,
    })
    if (!final.isError && seen === 'ok' && tool.minIntervalSec)
      this.recent.set(key, { at: Date.now(), result: final })
    return final
  }

  /** Calls to the same service run after the previous one ends, plus a gap (other services run in parallel) */
  private inLane<T>(id: string, run: () => Promise<T>): Promise<T> {
    const gap = this.opts.gapMs ?? SITE_GAP_MS
    const prev = this.lanes.get(id) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const wait = (this.lastRun.get(id) ?? 0) + gap - Date.now()
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        try {
          return await run()
        } finally {
          this.lastRun.set(id, Date.now())
        }
      })
    const tail = next.catch(() => undefined)
    this.lanes.set(id, tail)
    void tail.then(() => {
      if (this.lanes.get(id) === tail) this.lanes.delete(id)
    })
    return next
  }

  private async execute(
    card: ConnectCard,
    tool: ConnectorTool,
    args: Record<string, unknown>,
  ): Promise<ToolResult & { outcome?: Outcome; detail?: string }> {
    const b = this.opts.browser
    const scope: Scope = { ...args, today: today(this.now()) }
    let tabId: number | undefined = this.tabs.get(card.id)
    // Do not use a tab that is mid-payment; use a new tab (measured 11-20: an order history tool moved the paying
    // tab and the payment broke)
    if (tabId !== undefined && this.opts.tools.isPaying(tabId)) {
      this.tabs.delete(card.id)
      tabId = undefined
    }
    const need = () => {
      if (tabId === undefined) throw new StepError('Open a URL first')
      return tabId
    }
    const site = card.site ?? ''
    // A tool that reads the page's own responses turns on listening when the URL opens
    const capture = tool.steps.some((x) => 'capture' in x)
    const pollMs = this.opts.pollMs ?? 300
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    // long: read further to get marks for panels at the end of long pages (store stock panels, …)
    const read = async (long = false) => {
      const r = await this.opts.tools.run('read', { tabId: need(), ...(long ? { maxChars: LONG_READ } : {}) })
      if (r.isError) throw new StepError(firstText(r))
      return firstText(r)
    }
    for (const [i, step] of tool.steps.entries()) {
      // if: skip this step when the filled text is empty (e.g. do not open older periods once found in an earlier one)
      if (step.if !== undefined && !fill(step.if, scope).trim()) continue
      const kind = stepKind(step)
      try {
        const done = await this.step(step, {
          scope,
          tier: tool.tier,
          tool: `${card.id}.${tool.name}`,
          sites: [site, ...(card.alsoSites ?? [])],
          site,
          pollMs,
          sleep,
          read,
          need,
          captcha: (t) => this.captchaStop(card, tool, t),
          open: async (url) => {
            if (!onSites(url, [site, ...(card.alsoSites ?? [])]))
              throw new StepError(`Will not open a URL outside ${site}: ${url}`)
            // Reuse this service's tab if there is one (open a new one if it is gone)
            if (tabId !== undefined) {
              const ok = await b
                .call('navigate', { tabId, url, ...(capture ? { capture } : {}) }, 40_000)
                .then(
                  () => true,
                  () => false,
                )
              if (ok) {
                this.opts.tools.watchTab(tabId)
                return
              }
            }
            const r = (await b.call('open', { url, ...(capture ? { capture } : {}) }, 40_000)) as {
              tabId: number
            }
            tabId = r.tabId
            this.tabs.set(card.id, r.tabId)
            // Show this screen in the phone chat while working (telling it only at the end leaves it blank meanwhile)
            this.opts.tools.watchTab(r.tabId)
          },
        })
        if (done) {
          const r = this.finish(done, tabId)
          // Asking approval or handing off to the AI is success; stops like sold out or login needed are normal stops
          const sc = r.structuredContent as { stopped?: unknown; blocked?: unknown } | undefined
          const stopped = r.isError || Boolean(sc?.stopped)
          return { ...r, outcome: sc?.blocked ? 'blocked' : stopped ? 'stopped' : 'ok' }
        }
      } catch (e) {
        const optional = 'optional' in step && step.optional
        if (e instanceof GuardStop)
          return {
            ...text(`${e.message}${tabId !== undefined ? ` [Tab ${tabId}]` : ''}`, true),
            outcome: 'stopped',
          }
        if (optional && e instanceof StepError) continue
        // A step broken by a robot check does not mean the site changed: solve it on a phone card and call again
        // (not counted as a breakage)
        if (tabId !== undefined && (await this.captchaOn(tabId))) {
          this.opts.tools.lastTabId = tabId
          return { ...this.captchaStop(card, tool, tabId), outcome: 'blocked' }
        }
        return {
          ...this.broke(card, tool, i, kind, (e as Error).message, tabId),
          outcome: 'broke',
          detail: `step ${i + 1} (${kind}): ${(e as Error).message}`,
        }
      }
    }
    // Values to return
    const out: Record<string, unknown> = {}
    for (const [k, tpl] of Object.entries(tool.result)) {
      const field = tool.output[k]
      out[k] = field ? coerce(fillValue(tpl, scope), field) : fillValue(tpl, scope)
    }
    const lines = [render(tool, out)]
    // Check time: so "now" in a reply does not reuse a time from earlier in the chat (measured: an 8-minute-old
    // time was called "now")
    lines.push('', `Checked at: ${checkedAt()} (${card.name}, just now)`)
    if (tool.next) lines.push('', fill(tool.next, scope))
    // One line asking for cards when the options have photos and links (so each tool's next need not say it)
    const rows = Object.values(out).filter(Array.isArray).flat() as Record<string, unknown>[]
    const pics = rows.some((r) => r && typeof r === 'object' && r.image)
    if (
      rows.some((r) => r && typeof r === 'object' && (r.image || r.link)) &&
      pics &&
      // When the tool asks for another result block (list rows, route, single result), follow it to avoid a clash
      !/show_(cards|list|route|result)/.test(tool.next ?? '')
    )
      lines.push(
        '',
        'When showing options, attach show_cards with the photo (image), price and link exactly as given, and in text say only briefly why you picked them.',
      )
    // Lists without photos (orders, history, schedules, showtimes, open seats) go in list rows, not a text list.
    // Also tools with many rows in one field, like showtimes (cards: false + a list field): when the tool's next
    // only says "show 2–4 showtimes", the AI lists them as text
    const listy =
      tool.cards === false &&
      Object.values(tool.output).some((f) => f.type === 'list' || f.type === 'strings')
    if (
      !(pics && !/show_cards/.test(tool.next ?? '')) &&
      (rows.length >= 3 || (listy && rows.length > 0)) &&
      !/show_(cards|list|route|result)/.test(tool.next ?? '')
    )
      lines.push(
        '',
        'When showing options or lists to the user, do not lay them out as text or a table; attach rows with show_list. To let them pick one, use pick one (showtime, time or name in title; screen, seats left or conditions in sub; price in value; sold out in state). Keep the text to the key points.',
      )
    // When the list came back empty, do not keep hitting the same site with reworded queries (measured: opening
    // Coupang orders back to back got Access Denied)
    const lists = Object.entries(tool.output).filter(([, f]) => f.type === 'list')
    if (lists.length && lists.every(([k]) => Array.isArray(out[k]) && !(out[k] as unknown[]).length))
      lines.push(
        '',
        'The result is empty. Do not call this tool again many times with reworded input (the site may block you). Broaden it once (fewer words, longer period), or look elsewhere (another shop, payment history, mail).',
      )
    if (tool.status === TOOL_STATUS.draft)
      lines.push('', '(This tool is new. If something looks off, check the screen with the browser tools)')
    if (tabId !== undefined) lines.push(`[Tab ${tabId}]`)
    this.opts.tools.lastTabId = tabId
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: out, outcome: 'ok' }
  }

  /** Result of a final step (approval request, hand-off to the AI, stop) */
  private finish(done: ToolResult, tabId: number | undefined): ToolResult {
    if (tabId !== undefined) this.opts.tools.lastTabId = tabId
    return done.isError ? done : { ...done, structuredContent: done.structuredContent ?? {} }
  }

  /**
   * Finds a mark matching the condition on the page just read. If none, reads once more at full length:
   * panels at the very end of long pages (stock per store, …) are past the normal read length (ABC Mart, 2026-11-21)
   */
  private async refOn(
    tabId: number,
    read: (long?: boolean) => Promise<string>,
    ok: (v: { role: string; name: string }) => boolean,
  ): Promise<string | undefined> {
    const look = () => [...(this.opts.tools.refsOf(tabId) ?? [])].find(([, v]) => ok(v))?.[0]
    const ref = look()
    if (ref) return ref
    await read(true)
    return look()
  }

  /** Whether the tab shows a robot check (CAPTCHA, security check) a person must solve (as seen by the extension) */
  private async captchaOn(tabId: number): Promise<boolean> {
    const s = (await this.opts.browser
      .call('snapshot', { tabId, maxChars: 2000 }, 10_000)
      .catch(() => undefined)) as { captcha?: unknown } | undefined
    return Boolean(s?.captcha)
  }

  /**
   * Stuck on a robot check: do not end at a dead end. Have the person solve it on a phone card for the open tab,
   * then call the same tool again. The AI looks at the screen to pick the kind of check (type text, tap a picture,
   * one checkbox)
   */
  private captchaStop(card: ConnectCard, tool: ConnectorTool, tabId: number): ToolResult {
    const name = connectorToolName(card.id, tool.name)
    const say = `A robot check (security check) appeared on the ${card.name} page. Once the user solves it on the phone, you can continue.`
    return {
      content: [
        {
          type: 'text',
          text: [
            `${say} [Tab ${tabId}] is left open.`,
            `1) Read the screen with browser_read(tabId: ${tabId}) to see which check it is.`,
            '2) If the check asks to type letters or numbers or to answer a question (security code, receipt question, …), call browser_request_code(kind: "captcha") on that input field (calling it first without pick returns image candidates; do not read and type the answer yourself).',
            '   If it is solved by tapping pictures (pick tiles, tap a map), look with browser_screenshot, then send a picture card to the phone with browser_request_tap(box: where the puzzle image is, say: the puzzle text on screen). If it is a single "I\'m not a robot" checkbox, click it yourself.',
            '3) After sending the card, in the same reply first find and show what other services can find, then say in one sentence that you will continue once they solve the robot check on the phone, and end the reply.',
            `4) When the solved notification comes, press [OK] or [Submit] on the screen to move on, then call ${name} again with the same input.`,
            'Do not end with "it was blocked so I could not check", and do not tell the user to do it on the PC themselves.',
          ].join('\n'),
        },
      ],
      structuredContent: { stopped: say, blocked: true, captcha: true, tabId },
    }
  }

  private broke(
    card: ConnectCard,
    tool: ConnectorTool,
    i: number,
    kind: string,
    reason: string,
    tabId: number | undefined,
  ): ToolResult {
    this.breakages.push({
      tool: connectorToolName(card.id, tool.name),
      step: i + 1,
      kind,
      reason,
      at: this.now().toISOString(),
    })
    if (this.breakages.length > 200) this.breakages.shift()
    console.warn(
      `[connector] ${connectorToolName(card.id, tool.name)} step ${i + 1} (${kind}) failed: ${reason}`,
    )
    return text(
      `${card.name} '${tool.title}' tool got stuck at step ${i + 1} (${kind}): ${reason}. ` +
        (tabId !== undefined
          ? `The site may have changed. [Tab ${tabId}] is open: read it with browser_read and continue with the browser tools.`
          : 'Use the browser tools.'),
      true,
    )
  }

  /** One step. A final step returns the result to give back */
  private async step(
    s: Step,
    c: {
      scope: Scope
      tier: ConnectorTool['tier']
      /** service.tool name (for the payment flow record) */
      tool: string
      /** This service's sites (to remember the payment flow per site) */
      sites: string[]
      site: string
      pollMs: number
      sleep: (ms: number) => Promise<unknown>
      read: (long?: boolean) => Promise<string>
      need: () => number
      /** Result to return when stuck on a robot check (solve on a phone card, then call again) */
      captcha: (tabId: number) => ToolResult
      open: (url: string) => Promise<void>
    },
  ): Promise<ToolResult | undefined> {
    const b = this.opts.browser
    const f = (t: string) => fill(t, c.scope)
    if ('open' in s) {
      await c.open(f(s.open))
      return
    }
    if ('sleep' in s) {
      await c.sleep(s.sleep)
      return
    }
    if ('wait' in s) {
      const until = Date.now() + (s.wait.timeoutMs ?? 8000)
      const patterns: Record<string, string> = {}
      if (s.wait.text) patterns.text = f(s.wait.text)
      if (s.wait.gone) patterns.gone = f(s.wait.gone)
      for (;;) {
        let ok = true
        if (Object.keys(patterns).length) {
          const r = (await b.call('find', { tabId: c.need(), patterns })) as {
            found: Record<string, string | null>
          }
          if (patterns.text && !r.found.text) ok = false
          if (patterns.gone && r.found.gone) ok = false
        }
        if (ok && s.wait.items) {
          const r = (await b.call('extract', {
            tabId: c.need(),
            spec: { items: f(s.wait.items), fields: {}, limit: 1 },
          })) as {
            rows: unknown[]
          }
          if (!r.rows.length) ok = false
        }
        if (ok) return
        if (Date.now() > until) {
          // soft: move on without stopping (the AI reads the real screen at the next handoff)
          if (s.wait.soft) return
          throw new StepError(
            s.wait.text || s.wait.items
              ? `What it waited for did not appear on screen (${s.wait.text ?? s.wait.items})`
              : `"${s.wait.gone}" did not go away`,
          )
        }
        await c.sleep(c.pollMs)
      }
    }
    if ('find' in s) {
      const patterns = Object.fromEntries(Object.entries(s.find).map(([k, v]) => [k, f(v)]))
      const r = (await b.call('find', { tabId: c.need(), patterns })) as {
        found: Record<string, string | null>
      }
      c.scope[s.as ?? 'found'] = r.found
      return
    }
    if ('stop_if' in s) {
      const r = (await b.call('find', { tabId: c.need(), patterns: { hit: f(s.stop_if) } })) as {
        found: Record<string, string | null>
      }
      if (!r.found.hit) return
      const say = f(s.say)
      if (s.login)
        return text(
          `${say} This page needs login. Call connect_ask. If it was connected before (vault account or social login), the Dool2 daemon logs in again by itself; if it is the first time, a connect card appears. [Tab ${c.need()}]`,
          true,
        )
      // A blocking page that is a robot check a person can solve is not a dead end: solve it on a phone card and
      // call the same tool again
      if (s.blocked && (HUMAN_CHECK.test(r.found.hit) || (await this.captchaOn(c.need()))))
        return c.captcha(c.need())
      if (s.blocked)
        return {
          content: [
            {
              type: 'text',
              text: `${say} (Opening the same site again right away keeps it blocked longer. Do not call it again right away; in the same reply, get the result another way, with another service that does the same thing or another route such as a web search in the browser)`,
            },
          ],
          structuredContent: { stopped: say, blocked: true },
        }
      return { content: [{ type: 'text', text: say }], structuredContent: { stopped: say } }
    }
    if ('require' in s) {
      const until = Date.now() + (s.timeoutMs ?? 6000)
      for (;;) {
        const r = (await b.call('find', { tabId: c.need(), patterns: { hit: f(s.require) } })) as {
          found: Record<string, string | null>
        }
        if (r.found.hit) return
        if (Date.now() > until) {
          // A robot check instead of the expected text is not "nothing found": solve it on a phone card and call again
          if (await this.captchaOn(c.need())) return c.captcha(c.need())
          const say = f(s.say)
          return { content: [{ type: 'text', text: say }], structuredContent: { stopped: say } }
        }
        await c.sleep(c.pollMs)
      }
    }
    if ('click' in s) {
      await c.read()
      const tabId = c.need()
      const want = f(s.click.text)
      // When the page read has a button, radio or link with this exact name, use its mark (so the same words on a
      // page underneath are not clicked)
      const norm = (x: string) => x.replace(/\s+/g, ' ').trim()
      const ref = await this.refOn(
        tabId,
        c.read,
        (v) => v.role !== SNAPSHOT_ROLE.text && norm(v.name) === norm(want),
      )
      const r = await this.opts.tools.run('click', ref ? { tabId, ref } : { tabId, text: want })
      if (r.isError) {
        const msg = firstText(r)
        // A connector cannot get past the risk check: pass it to the AI as is
        if (msg.startsWith(GATE_STOP)) throw new GuardStop(msg)
        throw new StepError(msg)
      }
      return
    }
    if ('type' in s) {
      await c.read()
      const tabId = c.need()
      const want = new RegExp(f(s.type.field))
      const ref = await this.refOn(
        tabId,
        c.read,
        (v) => (v.role === SNAPSHOT_ROLE.input || v.role === SNAPSHOT_ROLE.search) && want.test(v.name),
      )
      if (!ref) throw new StepError(`Could not find the input field (${s.type.field})`)
      const r = await this.opts.tools.run('type', {
        tabId,
        ref,
        text: f(s.type.text),
        submit: Boolean(s.type.submit),
      })
      if (r.isError) {
        const msg = firstText(r)
        if (msg.startsWith(GATE_STOP)) throw new GuardStop(msg)
        throw new StepError(msg)
      }
      return
    }
    if ('choose' in s) {
      // Dropdown (sort, page size, …): pick the option in the select box with a matching name (the site reloads
      // the list)
      await c.read()
      const tabId = c.need()
      const want = new RegExp(f(s.choose.field))
      const ref = await this.refOn(tabId, c.read, (v) => v.role === SNAPSHOT_ROLE.select && want.test(v.name))
      if (!ref) throw new StepError(`Could not find the select box (${s.choose.field})`)
      const r = await this.opts.tools.run('select', { tabId, ref, choose: f(s.choose.option) })
      if (r.isError) throw new StepError(firstText(r))
      return
    }
    if ('press' in s) {
      await c.read()
      const r = await this.opts.tools.run('press', { tabId: c.need(), key: s.press })
      if (r.isError) {
        const msg = firstText(r)
        if (msg.startsWith(GATE_STOP)) throw new GuardStop(msg)
        throw new StepError(msg)
      }
      return
    }
    if ('extract' in s) {
      const fields = Object.fromEntries(
        Object.entries(s.extract.fields).map(([k, v]) => [
          k,
          { ...v, ...(v.css ? { css: f(v.css) } : {}), ...(v.match ? { match: f(v.match) } : {}) },
        ]),
      )
      const spec = {
        items: f(s.extract.items),
        ...(s.extract.within ? { within: f(s.extract.within) } : {}),
        ...(s.extract.limit ? { limit: s.extract.limit } : {}),
        fields,
      }
      const min = s.min ?? 1
      const until = Date.now() + 6000
      for (;;) {
        const r = (await b.call('extract', { tabId: c.need(), spec })) as { rows: Record<string, unknown>[] }
        if (r.rows.length >= min || Date.now() > until) {
          if (r.rows.length < min)
            throw new StepError(
              `The list (${spec.items}) should have at least ${min} rows but has ${r.rows.length}`,
            )
          c.scope[s.as] = r.rows
          return
        }
        await c.sleep(c.pollMs)
      }
    }
    if ('embedded' in s) {
      const until = Date.now() + 6000
      for (;;) {
        const after = s.embedded.after
        const r = (await b.call('extract', {
          tabId: c.need(),
          // Data inside a variable (after): there are several scripts, so pick the one containing that text
          spec: {
            items: f(s.embedded.css),
            hidden: true,
            limit: after ? 60 : 1,
            fields: { t: { raw: true } },
          },
        })) as { rows: { t: string | null }[] }
        const text = after
          ? r.rows.map((x) => (x.t ? jsonAfter(x.t, after) : undefined)).find(Boolean)
          : r.rows[0]?.t
        if (text) {
          let data: unknown
          try {
            data = JSON.parse(text)
          } catch {
            throw new StepError(`The text inside ${s.embedded.css} is not JSON`)
          }
          keep(c.scope, s.as, s.embedded.pick ? pick(data, s.embedded.pick) : data, s.append)
          return
        }
        if (Date.now() > until) throw new StepError(`No ${s.embedded.css} data on the page`)
        await c.sleep(c.pollMs)
      }
    }
    if ('capture' in s) {
      // Reads responses the page received on its own (Dool2 sends no requests)
      const r = (await b
        .call(
          'capture',
          {
            tabId: c.need(),
            url: f(s.capture.url),
            pick: s.capture.pick ?? '',
            timeoutMs: s.capture.timeoutMs ?? 10_000,
            // A read-only list page, so reloading once is fine if nothing was heard (the extension reloads only when told)
            reloadIfSilent: true,
          },
          40_000,
        )
        .catch((e: Error) => {
          throw new StepError(e.message)
        })) as { json: unknown }
      keep(c.scope, s.as, r.json, s.append)
      return
    }
    if ('filter' in s) {
      const from = pick(c.scope, s.filter.from)
      if (!Array.isArray(from)) throw new StepError(`${s.filter.from} is not a list`)
      const want = s.filter.value !== undefined ? f(s.filter.value).trim() : ''
      c.scope[s.as] = from.filter((row) => matches(pick(row, s.filter.where), s.filter.op, want))
      return
    }
    if ('map' in s) {
      const raw = pick(c.scope, s.map.from)
      if (!Array.isArray(raw)) throw new StepError(`${s.map.from} is not a list`)
      // A list split into groups ("groups.*.items") is flattened into one
      const from: unknown[] = raw.length && raw.every(Array.isArray) ? raw.flat() : raw
      c.scope[s.as] = from
        .slice(0, Number(typeof s.map.limit === 'string' ? f(s.map.limit) : s.map.limit) || 50)
        .map((row) =>
          Object.fromEntries(
            Object.entries(s.map.fields).map(([k, p]) => [
              k,
              // With "{{…}}": text filled from the row (else from input and earlier steps); otherwise a path
              (p.includes('{{')
                ? fill(p, { ...c.scope, ...(row as Scope) }).trim()
                : firstImage(k, pick(row, p))) ?? null,
            ]),
          ),
        )
      return
    }
    if ('approve' in s) {
      await c.read()
      const tabId = c.need()
      const m = await this.opts.tools.markText(tabId, f(s.approve.text)).catch((e: Error) => {
        throw new StepError(e.message)
      })
      const kind: RiskKind = c.tier === 'contact' ? 'contact' : 'money'
      const r = await this.opts.tools
        .askApproval(
          tabId,
          m.ref,
          {
            what: f(s.approve.what),
            where: f(s.approve.where),
            ...(s.approve.amount ? { amount: f(s.approve.amount) } : {}),
            ...(s.approve.cancel ? { cancel: f(s.approve.cancel) } : {}),
          },
          kind,
        )
        .catch((e: Error) => text(`${e.message} [Tab ${tabId}]`, true))
      return r
    }
    if ('handoff_to_agent' in s) {
      // A tab handed over by a pay tool is a payment flow: hold the tab and add the checkout guide. Approval happens
      // once, at the last pay button (browser-tools)
      const pay = c.tier === 'pay'
      if (pay) this.opts.tools.startPayFlow(c.need(), c.tool, c.sites)
      // Slow-drawing pages (Gmail, Google Calendar, …) are still empty after the fixed wait: read a bit more until
      // drawn (measured: given an empty page, the AI answered "the results are empty, it seems not connected")
      let page = await c.read()
      for (let i = 0; i < 8 && thinPage(page); i++) {
        await c.sleep(1000)
        page = await c.read()
      }
      return text(
        `${f(s.handoff_to_agent)}\n${pay ? `${PAY_ORDER}\n` : ''}From here, continue with the browser tools.\n\n${page}`,
      )
    }
    return
  }
}

/**
 * Goal and tool map for the pay flow (added after the hand-off text of every pay tool).
 * The AI decides the order by looking at the screen. The person's part happens only on phone cards
 */
export const PAY_ORDER = [
  '[Payment] Goal: reach the completion page and the order (booking) number. Decide the order by looking at the screen.',
  '- [Order], [Buy], [Book] buttons that only move on to the checkout page: browser_click(opens_checkout: true)',
  '- Booker, orderer and shipping address fields: browser_fill_profile (browser_request_profile only for missing items)',
  '- Payment approval: browser_checkout (payment card) once, at the last pay button. Pick the payment method with choices. Do not stop on the checkout page to ask',
  '- Payment windows after approval: it is the same payment, so finish it. Payment password keypad: browser_request_code(kind: pin); verification codes: browser_request_code; app approval: browser_wait_auth; robot checks: browser_request_tap',
  '- End: read the order (booking) number on the completion page and call browser_order_done',
  '- Requests where no money moves (cancel, return, plan change, termination): browser_request_approval at the last button',
  "- Login required: that service's connect_ask (if it was connected before, Dool2 logs in again by itself); for sites without a connect card, browser_request_login",
  '- browser_handoff(emergency: true) only when there is no saved card and a new card number must be entered for the first time',
  'If the screen stays the same after a click, use browser_read to see what blocks it (an overlay, a cookie consent window, an empty required field) and handle that first. If stuck, try another payment method or another screen.',
].join('\n')

/** Adds one guide line at the end of a tool result (unchanged when none) */
function withNote<T extends ToolResult>(r: T, note: string | undefined): T {
  return note ? { ...r, content: [...r.content, { type: 'text', text: note }] } : r
}

/** A page not fully drawn yet: almost no text after the header line and almost nothing to press */
export function thinPage(page: string): boolean {
  const body = page.split('\n').slice(1).join('\n')
  const refs = body.match(/\[e\d+ /g)?.length ?? 0
  return body.replace(/\s+/g, '').length < 150 || refs < 3
}

function firstText(r: ToolResult): string {
  const c = r.content.find((x) => x.type === 'text')
  return c && c.type === 'text' ? c.text : ''
}

/** The first photo when the image field caught several (photos per color, …) */
function firstImage(key: string, v: unknown): unknown {
  return key === 'image' && Array.isArray(v) ? v.find((x) => typeof x === 'string' && x) : v
}

/** Fits a value to the output field's shape ('4.5' → 4.5, empty → null) */
export function coerce(v: unknown, field: OutputField): unknown {
  const one = (x: unknown, type: string): unknown => {
    if (x === undefined || x === null || x === '') return null
    if (type === 'strings') return Array.isArray(x) ? x.map(String) : [String(x)]
    if (type === 'number' || type === 'integer') {
      // First number in the text: "4.5 (120)" → 4.5, "12,900 KRW" → 12900
      const m = typeof x === 'number' ? undefined : /-?\d[\d,]*(?:\.\d+)?/.exec(String(x))
      const n = typeof x === 'number' ? x : m ? Number(m[0].replace(/,/g, '')) : Number.NaN
      return Number.isFinite(n) ? (type === 'integer' ? Math.round(n) : n) : null
    }
    if (type === 'boolean') return typeof x === 'boolean' ? x : YES.test(String(x))
    return typeof x === 'string' ? x : Array.isArray(x) ? x.join(', ') : String(x)
  }
  if (field.type === 'list') {
    if (!Array.isArray(v)) return []
    return v.map((row) =>
      Object.fromEntries(
        Object.entries(field.fields).map(([k, f]) => [k, one((row as Record<string, unknown>)?.[k], f.type)]),
      ),
    )
  }
  return one(v, field.type)
}

/** The result as short text for the AI: lists as numbered lines, the rest as "name: value" */
export function render(tool: ConnectorTool, out: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(out)) {
    const field = tool.output[k]
    if (field?.type === 'list' && Array.isArray(v)) {
      lines.push(`${field.description ?? k} (${v.length})`)
      v.slice(0, 30).forEach((row, i) => {
        const cells = Object.entries(row as Record<string, unknown>)
          .filter(([, x]) => x !== null && x !== '' && !(Array.isArray(x) && !x.length))
          .map(([kk, x]) => `${kk}: ${Array.isArray(x) ? x.join(', ') : x}`)
        lines.push(`${i + 1}. ${cells.join(' · ')}`)
      })
      if (v.length > 30) lines.push(`… ${v.length - 30} more`)
    } else if (v !== null && v !== undefined && v !== '') {
      lines.push(`${field?.description ?? k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    }
  }
  return lines.join('\n') || '(nothing to return)'
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Korea time, "11/19 (Thu) 16:49" */
function checkedAt(now = Date.now()): string {
  const d = new Date(now + 9 * 3600_000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} (${WEEKDAYS[d.getUTCDay()]}) ${hh}:${mm}`
}

/** Tool definition fingerprint (for the health record): a fixed definition does not rest for old breakages */
const prints = new WeakMap<object, string>()
function toolPrint(t: ConnectorTool): string {
  let v = prints.get(t)
  if (!v) {
    v = createHash('sha1').update(JSON.stringify(t)).digest('hex').slice(0, 10)
    prints.set(t, v)
  }
  return v
}
