// Takes what a screen asks for during login (verification code, phone number, etc.) through the phone's input screen.
// Faster and easier than finding the PC field over a remote screen. The value is not kept in the AI or the conversation log; it goes only into that field.
import { randomUUID } from 'node:crypto'
import type { InfoRequestView } from '@dool2/protocol'

export const INFO_TTL_MS = 5 * 60_000

export class InfoRequests {
  private items = new Map<string, { view: InfoRequestView; done: (v: string | undefined) => void }>()
  /** New request (send to the phone) */
  onCreate?: (r: InfoRequestView) => void
  /** Finished (close the phone's input screen) */
  onDone?: (id: string) => void

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttl = INFO_TTL_MS,
  ) {}

  /** Asks and waits for the answer. undefined on cancel or timeout */
  ask(n: Omit<InfoRequestView, 'id' | 'status' | 'expiresAt'>, ttl = this.ttl): Promise<string | undefined> {
    const id = randomUUID()
    const view: InfoRequestView = {
      ...n,
      id,
      status: 'pending',
      expiresAt: new Date(this.now() + ttl).toISOString(),
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(id, 'expired'), ttl)
      this.items.set(id, {
        view,
        done: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
      })
      this.onCreate?.(view)
    })
  }

  answer(id: string, value: string | undefined): boolean {
    const v = value?.trim()
    // A multi-field card (form) arrives as one line of JSON, so it is longer
    const max = this.items.get(id)?.view.field === 'form' ? 4000 : 200
    return this.finish(id, v ? 'answered' : 'cancelled', v ? v.slice(0, max) : undefined)
  }

  /** Closes the card when no more asking is needed (e.g. verification finished by itself) */
  cancel(id: string): boolean {
    return this.finish(id, 'cancelled')
  }

  pending(): InfoRequestView[] {
    return [...this.items.values()].map((x) => x.view).filter((v) => v.status === 'pending')
  }

  private finish(id: string, status: InfoRequestView['status'], value?: string): boolean {
    const it = this.items.get(id)
    if (!it || it.view.status !== 'pending') return false
    it.view.status = status
    this.items.delete(id)
    it.done(value)
    this.onDone?.(id)
    return true
  }
}
