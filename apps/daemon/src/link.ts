// 폰 연결 (M6, ADR 0012). PC 쪽: 중계 서버에 붙어 있다가, 페어링된 폰이 보낸 봉투만 열어 처리한다.
// - 페어링: QR(일회용 비밀, 5분) → 폰의 암호화된 요청 → 확인 코드 6자리 → PC 화면에서 [연결]
// - 페어링 안 된 기기, 순번이 맞지 않는 봉투, 열리지 않는 봉투는 조용히 버린다
// - 승인은 폰의 Ed25519 서명을 PC가 직접 확인한 뒤에만 처리한다
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'
import {
  type AgentId,
  type ApprovalView,
  approvalSignText,
  type DaemonStreamEvent,
  type LinkStatus,
  type PairedPhone,
  type PairInvite,
  type PairStatus,
  type PcToPhone,
  type PhoneToPc,
} from '@dool2/protocol'
import {
  b64u,
  type DeviceKeys,
  deviceId,
  type Envelope,
  exportDevice,
  generateDevice,
  importDevice,
  LINK_VERSION,
  linkKey,
  open,
  pairCode,
  SeqGuard,
  seal,
  verifyText,
} from '@dool2/protocol/e2e'
import { LinkClient } from '@dool2/protocol/link'
import QRCode from 'qrcode'

export const PAIR_TTL_MS = 5 * 60_000

export interface SecretStoreLike {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string | undefined): Promise<void>
}

/** 폰 부탁을 처리할 본체 기능 (index.ts가 채운다) */
export interface LinkHost {
  state(): Promise<Omit<Extract<PcToPhone, { kind: 'state' }>, 'kind' | 'pcName'>>
  thread(id: string): Promise<Extract<PcToPhone, { kind: 'thread' }> | undefined>
  /** 대화를 시작하고 스트림 이벤트를 돌려준다. 이벤트는 broadcastStream으로도 나간다 */
  ask(input: { threadId?: string; agent?: AgentId; text: string }): Promise<string>
  cancel(threadId: string): void
  approval(id: string): (ApprovalView & { shot?: string }) | undefined
  decide(id: string, decision: 'approve' | 'reject'): Promise<{ ok: boolean; message: string }>
}

const KEYS = 'link.pc'
const PHONES = 'link.phones'
const SEQS = 'link.seqs'

export class PhoneLink {
  private keys?: DeviceKeys
  private phones: PairedPhone[] = []
  private client?: LinkClient
  private guard = new SeqGuard()
  private seq = 0
  private keyCache = new Map<string, Awaited<ReturnType<typeof linkKey>>>()
  private pairing?: {
    secret: string
    expiresAt: number
    url: string
    qr: string
    pending?: { phoneId: string; boxPub: string; signPub: string; name: string; code: string }
    done?: string
  }

  constructor(
    private readonly secrets: SecretStoreLike,
    private readonly host: LinkHost,
    private readonly opts: { relay?: () => string | undefined; name?: string; now?: () => number } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)()
  }
  private get pcName() {
    return this.opts.name ?? hostname().replace(/\.local$/, '')
  }

  async start() {
    const saved = await this.secrets.get(KEYS)
    this.keys = saved ? await importDevice(JSON.parse(saved)) : await generateDevice(true)
    if (!saved) await this.secrets.set(KEYS, JSON.stringify(await exportDevice(this.keys)))
    this.phones = JSON.parse((await this.secrets.get(PHONES)) ?? '[]') as PairedPhone[]
    this.guard = new SeqGuard(JSON.parse((await this.secrets.get(SEQS)) ?? '{}'))
    this.seq = Date.now() // 다시 켜도 순번이 줄지 않게 시각에서 시작한다
    this.connect()
  }

  /** 중계 서버 주소가 바뀌면 다시 붙는다 */
  connect() {
    this.client?.stop()
    this.client = undefined
    const relay = this.opts.relay?.()
    if (!relay || !this.keys) return
    this.client = new LinkClient({
      relay,
      role: 'pc',
      keys: this.keys,
      onEnvelope: (env) => {
        void this.receive(env).catch(() => {})
      },
    })
    this.client.start()
  }

  stop() {
    this.client?.stop()
  }

  status(): LinkStatus {
    const relay = this.opts.relay?.()
    return {
      ...(relay ? { relay } : {}),
      connected: Boolean(this.client?.ready),
      ...(this.keys ? { pcId: this.keys.id } : {}),
      phones: this.phones.map(({ id, name, pairedAt }) => ({ id, name, pairedAt })),
    }
  }

  // ── 페어링 ──

  async startPairing(): Promise<PairStatus> {
    const relay = this.opts.relay?.()
    if (!relay || !this.keys) throw new Error('중계 서버 주소가 정해지지 않았어요')
    const secret = b64u(randomBytes(24))
    const invite: PairInvite = { pc: this.keys.id, k: this.keys.boxPub, s: secret, n: this.pcName }
    const url = `${new URL('/app/', relay).href}#p=${b64u(new TextEncoder().encode(JSON.stringify(invite)))}`
    const qr = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })
    this.pairing = { secret, expiresAt: this.now() + PAIR_TTL_MS, url, qr }
    return this.pairStatus()
  }

  pairStatus(): PairStatus {
    const p = this.pairing
    if (!p) return { state: 'idle' }
    if (p.done) return { state: 'done', name: p.done }
    if (this.now() > p.expiresAt) return { state: 'expired' }
    const base = { url: p.url, qr: p.qr, expiresAt: new Date(p.expiresAt).toISOString() }
    if (p.pending) return { state: 'confirm', code: p.pending.code, name: p.pending.name, ...base }
    return { state: 'waiting', ...base }
  }

  /** PC 화면에서 확인 코드를 보고 [연결] 또는 [취소] */
  async confirmPairing(accept: boolean): Promise<PairStatus> {
    const p = this.pairing
    const pend = p?.pending
    if (!p || !pend || this.now() > p.expiresAt) return this.pairStatus()
    if (!accept) {
      await this.sendTo(pend.phoneId, pend.boxPub, { kind: 'pair-rejected' })
      this.pairing = undefined
      return { state: 'idle' }
    }
    const phone: PairedPhone = {
      id: pend.phoneId,
      name: pend.name,
      boxPub: pend.boxPub,
      signPub: pend.signPub,
      pairedAt: new Date(this.now()).toISOString(),
    }
    this.phones = [...this.phones.filter((x) => x.id !== phone.id), phone]
    await this.secrets.set(PHONES, JSON.stringify(this.phones))
    p.done = phone.name
    await this.send(phone, { kind: 'paired', pcName: this.pcName })
    await this.send(phone, { kind: 'state', pcName: this.pcName, ...(await this.host.state()) })
    return this.pairStatus()
  }

  cancelPairing() {
    this.pairing = undefined
  }

  async removePhone(id: string): Promise<boolean> {
    const before = this.phones.length
    this.phones = this.phones.filter((x) => x.id !== id)
    this.keyCache.delete(id)
    await this.secrets.set(PHONES, JSON.stringify(this.phones))
    return this.phones.length < before
  }

  // ── 받기 ──

  private async keyFor(id: string, boxPub: string) {
    const cached = this.keyCache.get(id)
    if (cached) return cached
    if (!this.keys) throw new Error('키가 없어요')
    const k = await linkKey(this.keys.boxPriv, boxPub, [this.keys.id, id])
    this.keyCache.set(id, k)
    return k
  }

  async receive(env: Envelope) {
    if (!this.keys || env.to !== this.keys.id || env.v !== LINK_VERSION) return
    if (env.kind === 'pair') return this.receivePair(env)
    const phone = this.phones.find((x) => x.id === env.from)
    if (!phone) return // 페어링 안 된 기기
    let msg: PhoneToPc
    try {
      msg = await open<PhoneToPc>(await this.keyFor(phone.id, phone.boxPub), env)
    } catch {
      return
    }
    if (msg.kind !== env.kind) return
    if (!this.guard.accept(phone.id, env.seq)) return
    await this.secrets.set(SEQS, JSON.stringify(this.guard.snapshot()))
    await this.handle(phone, msg).catch((e: Error) => this.send(phone, { kind: 'error', message: e.message }))
  }

  private async receivePair(env: Envelope) {
    const p = this.pairing
    if (!p || p.pending || p.done || this.now() > p.expiresAt || !env.pub || !this.keys) return
    let msg: Extract<PhoneToPc, { kind: 'pair' }>
    try {
      msg = await open(await linkKey(this.keys.boxPriv, env.pub, [this.keys.id, env.from]), env)
    } catch {
      return
    }
    const a = Buffer.from(String(msg.secret))
    const b = Buffer.from(p.secret)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return
    if ((await deviceId(msg.signPub)) !== env.from) return
    p.pending = {
      phoneId: env.from,
      boxPub: env.pub,
      signPub: msg.signPub,
      name: String(msg.name ?? '폰').slice(0, 40),
      code: await pairCode(this.keys.boxPriv, env.pub),
    }
  }

  private async handle(phone: PairedPhone, msg: PhoneToPc) {
    switch (msg.kind) {
      case 'hello':
        return this.send(phone, { kind: 'state', pcName: this.pcName, ...(await this.host.state()) })
      case 'thread': {
        const t = await this.host.thread(msg.id)
        if (t) await this.send(phone, t)
        return
      }
      case 'ask': {
        await this.host.ask({
          ...(msg.threadId ? { threadId: msg.threadId } : {}),
          ...(msg.agent ? { agent: msg.agent } : {}),
          text: String(msg.text).slice(0, 4000),
        })
        return
      }
      case 'cancel':
        return this.host.cancel(msg.threadId)
      case 'approval': {
        const a = this.host.approval(msg.id)
        if (a) await this.send(phone, { kind: 'approval', approval: a })
        return
      }
      case 'decide': {
        const a = this.host.approval(msg.id)
        if (!a)
          return this.send(phone, {
            kind: 'decided',
            id: msg.id,
            ok: false,
            message: '승인 요청을 찾을 수 없어요',
          })
        // 폰 서명을 PC가 직접 확인한다. 중계 서버나 다른 기기는 승인을 만들 수 없다
        if (!(await verifyText(phone.signPub, approvalSignText(a, msg.decision), msg.sig)))
          return this.send(phone, { kind: 'decided', id: msg.id, ok: false, message: '서명이 맞지 않아요' })
        const r = await this.host.decide(msg.id, msg.decision)
        return this.broadcast({ kind: 'decided', id: msg.id, ...r })
      }
    }
  }

  // ── 보내기 ──

  private async sendTo(id: string, boxPub: string, body: PcToPhone) {
    if (!this.keys || !this.client) return
    const k = await this.keyFor(id, boxPub)
    this.client.send(
      await seal(k, { v: LINK_VERSION, from: this.keys.id, to: id, kind: body.kind, seq: ++this.seq }, body),
    )
  }

  private send(phone: PairedPhone, body: PcToPhone) {
    return this.sendTo(phone.id, phone.boxPub, body)
  }

  /** 모든 폰에 보낸다 (대화 진행, 새 승인 요청) */
  async broadcast(body: PcToPhone) {
    for (const p of this.phones) await this.send(p, body).catch(() => {})
  }

  /** 대화 진행을 폰에도 흘려보낸다. 글자 조각은 모아서 보낸다 */
  streamer(threadId: string) {
    let buf = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      timer = undefined
      if (!buf) return
      const delta = buf
      buf = ''
      void this.broadcast({
        kind: 'stream',
        threadId,
        event: { type: 'agent', event: { type: 'text', delta } },
      })
    }
    return (ev: DaemonStreamEvent) => {
      if (!this.phones.length) return
      if (ev.type === 'agent' && ev.event.type === 'text') {
        buf += ev.event.delta
        timer ??= setTimeout(flush, 400)
        return
      }
      flush()
      void this.broadcast({ kind: 'stream', threadId, event: ev })
    }
  }
}
