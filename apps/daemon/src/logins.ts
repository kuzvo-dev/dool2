// In-conversation login card (ADR 0011 addendum). When Doori needs an ID and password for a site not in the vault, the request is made here.
// Values the user types into the card on the PC or phone bypass the AI and go only into the vault (OS keychain). The AI learns only "saved" and fills the form with browser_login.
import { randomUUID } from 'node:crypto'
import type { LoginRequestView } from '@dool2/protocol'

export const LOGIN_TTL_MS = 30 * 60_000

export class LoginRequests {
  private items = new Map<string, LoginRequestView>()
  /** When a new request appears (notify the phone) */
  onCreate?: (r: LoginRequestView) => void

  constructor(private readonly now: () => number = Date.now) {}

  create(n: { tabId: number; origin: string; site: string; connect?: boolean }): LoginRequestView {
    // If a request for the same site is already waiting, replace it with the new one
    for (const r of this.items.values())
      if (r.status === 'pending' && r.origin === n.origin) r.status = 'expired'
    const t = this.now()
    const r: LoginRequestView = {
      ...n,
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + LOGIN_TTL_MS).toISOString(),
    }
    this.items.set(r.id, r)
    this.onCreate?.(r)
    return r
  }

  get(id: string): LoginRequestView | undefined {
    const r = this.items.get(id)
    if (r?.status === 'pending' && Date.parse(r.expiresAt) <= this.now()) r.status = 'expired'
    return r
  }

  list(): LoginRequestView[] {
    return [...this.items.keys()].map((id) => this.get(id) as LoginRequestView)
  }

  finish(id: string, status: 'saved' | 'cancelled', username?: string) {
    const r = this.get(id)
    if (!r || r.status !== 'pending') return false
    r.status = status
    if (username) r.username = username
    return true
  }
}
