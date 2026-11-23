// Relay server connector. Shared by the PC (Node's built-in WebSocket) and the phone (browser).
// When the connection drops it reconnects with a growing delay (up to 30 seconds).
import { type DeviceKeys, type Envelope, signText } from './e2e.js'

/** The official Dool2 relay server (Cloudflare Workers + Durable Objects, apps/relay/src/worker.ts). It cannot read the content */
export const OFFICIAL_RELAY = 'https://relay.dool2.com'

export interface LinkOptions {
  /** Relay server address (http(s)://…) */
  relay: string
  role: 'pc' | 'phone'
  keys: DeviceKeys
  /** Phone: the PC id to connect to */
  room?: string
  onEnvelope(env: Envelope): void
  onState?(state: 'connecting' | 'ready' | 'closed'): void
  /** For tests */
  WebSocketImpl?: typeof WebSocket
}

export function helloText(h: { role: string; id: string; room?: string; ts: number }) {
  return `dool2-relay/v1/${h.role}/${h.id}/${h.room ?? ''}/${h.ts}`
}

/** Connection URL. The room (PC id) goes in the URL so the official server can route the connection straight to that room */
export function linkUrl(relay: string, room?: string): string {
  const u = new URL('/link', relay)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  if (room) u.searchParams.set('room', room)
  return u.href
}

export class LinkClient {
  private ws?: WebSocket
  private stopped = false
  private delay = 1_000
  private timer?: ReturnType<typeof setTimeout>
  private outbox: string[] = []
  ready = false

  constructor(private readonly opts: LinkOptions) {}

  start() {
    this.stopped = false
    this.open()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.ws?.close()
    this.ready = false
  }

  /** Queued while there is no connection, and sent once it connects */
  send(env: Envelope) {
    const data = JSON.stringify(env)
    if (this.ready && this.ws?.readyState === 1) this.ws.send(data)
    else this.outbox.push(data)
  }

  private open() {
    const WS = this.opts.WebSocketImpl ?? globalThis.WebSocket
    this.opts.onState?.('connecting')
    const ws = new WS(linkUrl(this.opts.relay, this.opts.role === 'pc' ? this.opts.keys.id : this.opts.room))
    this.ws = ws
    ws.onopen = async () => {
      const { role, keys, room } = this.opts
      const ts = Date.now()
      const sig = await signText(
        keys.signPriv,
        helloText({ role, id: keys.id, ...(room ? { room } : {}), ts }),
      )
      ws.send(
        JSON.stringify({ role, id: keys.id, signPub: keys.signPub, ...(room ? { room } : {}), ts, sig }),
      )
    }
    ws.onmessage = (ev) => {
      let msg: unknown
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if ((msg as { relay?: string }).relay === 'ready') {
        this.ready = true
        this.delay = 1_000
        this.opts.onState?.('ready')
        for (const d of this.outbox.splice(0)) ws.send(d)
        return
      }
      this.opts.onEnvelope(msg as Envelope)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ready = false
      this.opts.onState?.('closed')
      if (this.stopped) return
      this.timer = setTimeout(() => this.open(), this.delay)
      this.delay = Math.min(this.delay * 2, 30_000)
    }
    ws.onerror = () => {}
  }
}

/** What the phone signs when approving. The PC builds the same text and verifies the signature */
export function approvalSignText(
  a: { id: string; label: string; url: string; what: string; amount?: string; expiresAt: string },
  decision: 'approve' | 'reject',
  /** The chosen payment method, etc. (only included in the signature when present: an approval without a choice is the same text as with older phones) */
  choice?: string,
): string {
  const o: Record<string, unknown> = {
    t: 'dool2-approval/v1',
    id: a.id,
    decision,
    label: a.label,
    url: a.url,
    what: a.what,
    amount: a.amount ?? '',
    expiresAt: a.expiresAt,
    ...(choice ? { choice } : {}),
  }
  return JSON.stringify(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  )
}

/** What the phone signs to turn auto-approve on or off (ADR 0030). `at` keeps an old signature from being replayed */
export function autoApproveSignText(on: boolean, at: number): string {
  return JSON.stringify([
    ['at', at],
    ['on', on],
    ['t', 'dool2-auto-approve/v1'],
  ])
}

/** What the phone signs for "start over" (only accepted within 2 minutes) */
export function resetSignText(at: number, services: boolean): string {
  return JSON.stringify([
    ['at', at],
    ['services', services],
    ['t', 'dool2-reset/v1'],
  ])
}
