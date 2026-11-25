// Service connection cards (skills/<id>/connect.json, ADR 0014) and the service map put into the AI instructions.
// The tools that actually work in a service are tools.json in the same folder (connectors, ADR 0018), run by connectors.ts.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Lang, type Region, servesRegion } from '@dool2/i18n'
import {
  CONNECT_CATEGORIES,
  type ConnectCard,
  ConnectCardSchema,
  type ConnectionItem,
  type ConnectionTool,
  localizeCard,
} from '@dool2/protocol/connect'

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/

export class Skills {
  /** The service list read last (the service map for the instructions is synchronous, so it uses this) */
  private last: ConnectionItem[] = []
  constructor(
    /** skills/ folder, or a function giving the folder in use now (connector packs, ADR 0039) */
    private readonly folder: string | undefined | (() => string | undefined),
    /** Connected service id -> time (settings) */
    private readonly connected: () => Record<string, string> = () => ({}),
    /** Summary of the service tools (tools.json) state (ADR 0018) */
    private readonly connector?: (id: string) => Promise<{ status?: string; tools?: ConnectionTool[] }>,
    /** Service id -> how it was last connected (setting connectVia) */
    private readonly via: () => Record<string, string> = () => ({}),
    /** Provider (kakao, naver, google) -> accounts confirmed as mine (setting socialAccounts) */
    private readonly accounts: () => Record<string, string[]> = () => ({}),
    /** The user's language (card text people read) and region (which services come first), ADR 0029 */
    private readonly locale: () => { lang: Lang; region?: Region } = () => ({ lang: 'ko', region: 'KR' }),
    /** Service id -> the account read on its own page when connected (setting connectAccounts, ADR 0041) */
    private readonly signedIn: () => Record<string, string> = () => ({}),
  ) {}

  private get dir(): string | undefined {
    return typeof this.folder === 'function' ? this.folder() : this.folder
  }

  /** Connection card (malformed cards are skipped; repo tests catch them beforehand) */
  async card(name: string): Promise<ConnectCard | undefined> {
    const dir = this.dir
    if (!dir || !NAME.test(name)) return undefined
    const raw = await readFile(join(dir, name, 'connect.json'), 'utf8').catch(() => undefined)
    if (!raw) return undefined
    try {
      const r = ConnectCardSchema.safeParse(JSON.parse(raw))
      return r.success && r.data.id === name ? localizeCard(r.data, this.locale().lang) : undefined
    } catch {
      return undefined
    }
  }

  /** Connections screen list: every service that has a card (category order, folder order within a category) */
  async connections(): Promise<ConnectionItem[]> {
    const dir = this.dir
    if (!dir) return []
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => NAME.test(n)).sort()
    const connected = this.connected()
    const via = this.via()
    const accounts = this.accounts()
    const signedIn = this.signedIn()
    const order = Object.keys(CONNECT_CATEGORIES)
    const { region } = this.locale()
    const out: ConnectionItem[] = []
    for (const n of names) {
      const card = await this.card(n)
      if (!card) continue
      const c = (await this.connector?.(n).catch(() => undefined)) ?? {}
      const skill = c.status
      // A service that signs in with the same account (Naver Mail -> Naver) counts as connected when that account is connected
      const at = connected[n] ?? (card.sameLoginAs ? connected[card.sameLoginAs] : undefined)
      const who = signedIn[n] ?? (card.sameLoginAs ? signedIn[card.sameLoginAs] : undefined)
      out.push({
        card,
        ...(skill ? { skill } : {}),
        ...(c.tools?.length ? { tools: c.tools } : {}),
        ...(at ? { connectedAt: at } : {}),
        ...(at && who ? { signedInAs: maskAccount(who) } : {}),
        ...(via[n] ? { via: via[n] } : {}),
        ...(accounts[n]?.length ? { account: maskAccount(accounts[n].at(-1) as string) } : {}),
        local: servesRegion(card.regions, region),
      })
    }
    const sorted = out.sort((x, y) => order.indexOf(x.card.category) - order.indexOf(y.card.category))
    this.last = sorted
    return sorted
  }

  /**
   * The service map for the AI instructions: lets it pick the right service even for requests without a service name ("find a restaurant for our anniversary").
   * One line per service in each category: "name(id)✓: what it can do". ✓ = connected (logged in, so booking and ordering work)
   */
  /**
   * The service list of the conversation of task sessions (ADR 0038): one line per service it can look things up in
   * right now (connected, or lookups that need no login), with those lookup tools. The rest is one service_find away,
   * and booking, ordering or signing in happens in a task
   */
  lookupMap(): string {
    const lines: string[] = []
    for (const it of this.last) {
      if (it.card.how === 'device') continue
      const c = it.card
      const on = Boolean(it.connectedAt)
      const prefix = `${c.id.replace(/-/g, '_')}_`
      const tools = (it.tools ?? [])
        .filter((t) => t.tier === 'lookup' && (on || !t.login))
        .map((t) => (t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name))
      if (!tools.length) continue
      lines.push(`- ${c.name}(${c.id})${on ? '✓' : ''} — ${c.summary} [${tools.join(', ')}]`)
    }
    if (!lines.length) return ''
    return [
      '## Services you can look things up in now (✓ connected; tools named <id>_<tool> with - as _, run with service_call)',
      '- Pick by the purpose of the request even when no service is named. service_find shows any other service; booking, ordering and signing in go to a task.',
      ...lines,
    ].join('\n')
  }

  serviceMap(): string {
    const by = new Map<string, string[]>()
    /** Category → services shown by name only */
    const later = new Map<string, string[]>()
    for (const it of this.last) {
      if (it.card.how === 'device') continue
      const c = it.card
      const on = Boolean(it.connectedAt)
      const can = c.abilities.map((a) => a.title).join('·')
      // What the service is (summary) and what it can do: the AI picks the service that fits the request
      // Even before connecting, list the tools that work without login (so it does not ask to connect first)
      // Tool names without the service part (catchtable_search → search): the header says how names are made
      const prefix = `${c.id.replace(/-/g, '_')}_`
      const free = !on
        ? (it.tools ?? [])
            .filter((t) => !t.login)
            .map((t) => (t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name))
        : []
      const k = CONNECT_CATEGORIES[c.category]
      const tools = it.tools?.length ? '⚡' : ''
      // This list goes into every session's instructions, so it stays short. In full only the services Dool2 can use
      // right away (connected, no login at all, or tools that work without login); the rest are names in their
      // category, since without a connection there is nothing to do there but suggest one (service_find has the card)
      if (!on && c.how !== 'open' && !free.length) {
        later.set(k, [...(later.get(k) ?? []), `${c.name}(${c.id})${tools}`])
        continue
      }
      // The one-line summary only for services Dool2 can use with nothing more (connected, or no login at all), or
      // when there are no abilities to go by
      const summary = on || c.how === 'open' || !c.abilities.length ? ` — ${c.summary}` : ''
      const line = `${c.name}(${c.id})${on ? '✓' : ''}${tools}${summary} [${can}]${free.length ? ` (no login: ${free.join(', ')})` : ''}`
      by.set(k, [...(by.get(k) ?? []), line])
    }
    if (!by.size && !later.size) return ''
    const cats = [...new Set([...by.keys(), ...later.keys()])]
    return [
      '## Services (✓ connected, ⚡ Dool2 tools, [ ] abilities, no login: tools that work without connecting, named <id>_<tool> with - as _, e.g. catchtable_search)',
      '- Even if a request names no service, pick the one below that can see it through (find → choose → book or order), judged by the purpose of the request. service_find shows any service in full (what it does, tools, inputs).',
      '- Connected ones (✓) first: they are logged in, so availability, booking and ordering work.',
      '- Tools marked no login run right away with service_call. If the best fit is not connected, do what works without login there first (search, compare, availability) and show candidates; show its connect card (connect_ask) only when the user has picked and reaches a step that needs login (booking, ordering, history). Ask to connect first only where nothing works without login.',
      '- Service tools (⚡) are faster and more accurate than clicking through screens: call one directly if it is in your tool list, otherwise look at its input with service_find and call it with service_call. Use general search (portal, maps) only when no service fits or to add reviews, and say how the places found can be booked or ordered through a service.',
      '- If you only searched with a service that is not connected and connecting would let you do more, suggest it once, briefly, at the end of the reply; not again in the same conversation, nor after the user declined.',
      ...cats.map((k) => {
        const lines = (by.get(k) ?? []).map((l) => `- ${l}`)
        const rest = later.get(k)
        if (rest?.length) lines.push(`- Needs connecting to use: ${rest.join(', ')}`)
        return `### ${k}\n${lines.join('\n')}`
      }),
    ].join('\n')
  }
}

/** Account as shown on screen: only the first letter of an email ("felix@gmail.com" -> "f***@gmail.com"), IDs as they are */
export function maskAccount(a: string): string {
  const m = /^([^@\s])[^@\s]*@(.+)$/.exec(a.trim())
  return m ? `${m[1]}***@${m[2]}` : a.trim().slice(0, 30)
}
