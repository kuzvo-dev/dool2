// 중계 서버 접속기. PC(Node의 기본 WebSocket)와 폰(브라우저)이 같이 쓴다.
// 끊기면 점점 늘어나는 간격(최대 30초)으로 다시 붙는다.
import { type DeviceKeys, type Envelope, signText } from './e2e.js'

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

export function linkUrl(relay: string): string {
  const u = new URL('/link', relay)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
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
    const ws = new WS(linkUrl(this.opts.relay))
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
