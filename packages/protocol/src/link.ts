// 중계 서버 접속기. PC(Node의 기본 WebSocket)와 폰(브라우저)이 같이 쓴다.
// 끊기면 점점 늘어나는 간격(최대 30초)으로 다시 붙는다.
import { type DeviceKeys, type Envelope, signText } from './e2e.js'

/** 두리 공식 중계 서버 (Cloudflare Workers + Durable Objects, apps/relay/src/worker.ts). 내용은 볼 수 없다 */
export const OFFICIAL_RELAY = 'https://relay.dool2.com'

export interface LinkOptions {
  /** 중계 서버 주소 (http(s)://…) */
  relay: string
  role: 'pc' | 'phone'
  keys: DeviceKeys
  /** 폰: 연결할 PC id */
  room?: string
  onEnvelope(env: Envelope): void
  onState?(state: 'connecting' | 'ready' | 'closed'): void
  /** 테스트용 */
  WebSocketImpl?: typeof WebSocket
}

export function helloText(h: { role: string; id: string; room?: string; ts: number }) {
  return `dool2-relay/v1/${h.role}/${h.id}/${h.room ?? ''}/${h.ts}`
}

/** 접속 주소. 방(PC id)을 주소에 실어서, 공식 서버가 접속을 그 방으로 바로 보낼 수 있게 한다 */
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

  /** 연결이 없으면 모아 두었다가 붙으면 보낸다 */
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

/** 폰이 승인에 서명하는 내용. PC가 같은 방법으로 만들어 서명을 확인한다 */
export function approvalSignText(
  a: { id: string; label: string; url: string; what: string; amount?: string; expiresAt: string },
  decision: 'approve' | 'reject',
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
  }
  return JSON.stringify(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  )
}
