// Service connection cards (skills/<id>/connect.json, ADR 0014) and the service map put into the AI instructions.
// The tools that actually work in a service are tools.json in the same folder (connectors, ADR 0018), run by connectors.ts.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONNECT_CATEGORIES,
  type ConnectCard,
  ConnectCardSchema,
  type ConnectionItem,
  type ConnectionTool,
} from '@dool2/protocol/connect'

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/

export class Skills {
  /** The service list read last (the service map for the instructions is synchronous, so it uses this) */
  private last: ConnectionItem[] = []
  constructor(
    private readonly dir: string | undefined,
    /** Connected service id -> time (settings) */
    private readonly connected: () => Record<string, string> = () => ({}),
    /** Summary of the service tools (tools.json) state (ADR 0018) */
    private readonly connector?: (id: string) => Promise<{ status?: string; tools?: ConnectionTool[] }>,
    /** Service id -> how it was last connected (setting connectVia) */
    private readonly via: () => Record<string, string> = () => ({}),
    /** Provider (kakao, naver, google) -> accounts confirmed as mine (setting socialAccounts) */
    private readonly accounts: () => Record<string, string[]> = () => ({}),
  ) {}

  /** Connection card (malformed cards are skipped; repo tests catch them beforehand) */
  async card(name: string): Promise<ConnectCard | undefined> {
    if (!this.dir || !NAME.test(name)) return undefined
    const raw = await readFile(join(this.dir, name, 'connect.json'), 'utf8').catch(() => undefined)
    if (!raw) return undefined
    try {
      const r = ConnectCardSchema.safeParse(JSON.parse(raw))
      return r.success && r.data.id === name ? r.data : undefined
    } catch {
      return undefined
    }
  }

  /** Connections screen list: every service that has a card (category order, folder order within a category) */
  async connections(): Promise<ConnectionItem[]> {
    if (!this.dir) return []
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => NAME.test(n)).sort()
    const connected = this.connected()
    const via = this.via()
    const accounts = this.accounts()
    const order = Object.keys(CONNECT_CATEGORIES)
    const out: ConnectionItem[] = []
    for (const n of names) {
      const card = await this.card(n)
      if (!card) continue
      const c = (await this.connector?.(n).catch(() => undefined)) ?? {}
      const skill = c.status
      // A service that signs in with the same account (Naver Mail -> Naver) counts as connected when that account is connected
      const at = connected[n] ?? (card.sameLoginAs ? connected[card.sameLoginAs] : undefined)
      out.push({
        card,
        ...(skill ? { skill } : {}),
        ...(c.tools?.length ? { tools: c.tools } : {}),
        ...(at ? { connectedAt: at } : {}),
        ...(via[n] ? { via: via[n] } : {}),
        ...(accounts[n]?.length ? { account: maskAccount(accounts[n].at(-1) as string) } : {}),
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
  serviceMap(): string {
    const by = new Map<string, string[]>()
    for (const it of this.last) {
      if (it.card.how === 'device') continue
      const c = it.card
      const on = Boolean(it.connectedAt)
      const can = c.abilities.map((a) => a.title).join('·')
      // What the service is (summary) and what it can do: the AI picks the service that fits the request
      // Even before connecting, list the tools that work without login (so it does not ask to connect first)
      const free = !on ? (it.tools ?? []).filter((t) => !t.login).map((t) => t.name) : []
      const line = `${c.name}(${c.id})${on ? '✓' : ''}${it.tools?.length ? '⚡' : ''} — ${c.summary} [${can}]${free.length ? ` (no login: ${free.join(', ')})` : ''}`
      const k = CONNECT_CATEGORIES[c.category]
      by.set(k, [...(by.get(k) ?? []), line])
    }
    if (!by.size) return ''
    return [
      '## Services (✓ connected, ⚡ Doori tools, [ ] abilities)',
      'Even if a request names no service, pick the best one below yourself.',
      ...[...by].map(([k, lines]) => `### ${k}\n${lines.map((l) => `- ${l}`).join('\n')}`),
    ].join('\n')
  }
}

/** Account as shown on screen: only the first letter of an email ("felix@gmail.com" -> "f***@gmail.com"), IDs as they are */
export function maskAccount(a: string): string {
  const m = /^([^@\s])[^@\s]*@(.+)$/.exec(a.trim())
  return m ? `${m[1]}***@${m[2]}` : a.trim().slice(0, 30)
}
