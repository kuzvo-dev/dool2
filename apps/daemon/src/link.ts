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
  type ConversationState,
  type DaemonStreamEvent,
  type LinkStatus,
  type PairedPhone,
  type PairInvite,
  type PairStatus,
  type PcToPhone,
  type PhoneToPc,
} from '@dool2/protocol'
import type { ConnectionItem } from '@dool2/protocol/connect'
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
import { allowedEndpoint, generateVapid, type PushMessage, sendPush, type VapidKeys } from './webpush.js'

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
  /** 로그인 카드에 넣은 값을 금고에 저장 */
  login(id: string, username: string, password: string): Promise<{ ok: boolean; message: string }>
  /** 원격 화면: 두리가 넘긴 탭의 화면 한 장, 그 탭에 사람이 한 입력 */
  screen(tabId: number): Promise<{ shot: string; url: string; title: string }>
  remote(input: Extract<PhoneToPc, { kind: 'remote' }>): Promise<void>
  /** 서비스 연결 (ADR 0014): 목록, Chrome에서 열기(원격 화면 허용), 연결 표시·해제 */
  connections(): Promise<ConnectionItem[]>
  /** 대화 하나 (ADR 0015) */
  conversation(o: { before?: string; limit?: number }): ConversationState
  cancelConversation(): void
  connect(id: string, action: 'open' | 'mark' | 'unmark'): Promise<{ tabId?: number }>
  /** 연결하기: 금고에 넣고 대신 로그인 */
  connectLogin(
    id: string,
    username: string,
    password: string,
  ): Promise<{ ok: boolean; message: string; human?: boolean; tabId?: number }>
}

const KEYS = 'link.pc'
const PHONES = 'link.phones'
const SEQS = 'link.seqs'
const VAPID = 'link.vapid'

export class PhoneLink {
  private keys?: DeviceKeys
  private vapid?: VapidKeys
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
    private readonly opts: {
      relay?: () => string | undefined
      name?: string
      now?: () => number
      /** 테스트용: 푸시 보내기 */
      push?: typeof sendPush
    } = {},
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
    const vapid = await this.secrets.get(VAPID)
    this.vapid = vapid ? (JSON.parse(vapid) as VapidKeys) : generateVapid()
    if (!vapid) await this.secrets.set(VAPID, JSON.stringify(this.vapid))
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
      phones: this.phones.map(({ id, name, pairedAt, push }) => ({
        id,
        name,
        pairedAt,
        push: Boolean(push),
      })),
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
    await this.send(phone, await this.stateFor(phone))
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
        return this.send(phone, await this.stateFor(phone))
      case 'screen':
      case 'remote': {
        const tabId = Number(msg.tabId)
        try {
          if (msg.kind === 'remote') await this.host.remote({ ...msg, tabId })
          const s = await this.host.screen(tabId)
          return this.send(phone, { kind: 'screen', tabId, ...s })
        } catch (e) {
          return this.send(phone, { kind: 'screen', tabId, error: (e as Error).message })
        }
      }
      case 'push': {
        const sub = msg.sub
        if (sub && (!allowedEndpoint(String(sub.endpoint)) || !sub.keys?.p256dh || !sub.keys?.auth))
          return this.send(phone, { kind: 'error', message: '이 브라우저의 알림 주소는 쓸 수 없어요' })
        await this.savePush(
          phone.id,
          sub
            ? { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }
            : undefined,
        )
        return this.send(phone, await this.stateFor(phone))
      }
      case 'connections':
        return this.send(phone, { kind: 'connections', services: await this.host.connections() })
      case 'conversation': {
        const before = typeof msg.before === 'string' ? msg.before.slice(0, 80) : undefined
        const limit = Math.min(Math.max(Number(msg.limit) || 60, 1), 200)
        return this.send(phone, {
          kind: 'conversation',
          state: this.host.conversation({ limit, ...(before ? { before } : {}) }),
          ...(before ? { before } : {}),
        })
      }
      case 'conversation-cancel':
        return this.host.cancelConversation()
      case 'connect': {
        const action = msg.action
        if (action !== 'open' && action !== 'mark' && action !== 'unmark') return
        try {
          const r = await this.host.connect(String(msg.id), action)
          if (action === 'open' && r.tabId !== undefined)
            return this.send(phone, { kind: 'connect-opened', id: String(msg.id), tabId: r.tabId })
          return this.send(phone, { kind: 'connections', services: await this.host.connections() })
        } catch (e) {
          return this.send(phone, { kind: 'error', message: (e as Error).message })
        }
      }
      case 'connect-login': {
        const id = String(msg.id)
        try {
          const r = await this.host.connectLogin(
            id,
            String(msg.username).slice(0, 200),
            String(msg.password).slice(0, 500),
          )
          await this.send(phone, { kind: 'connect-result', id, ...r })
        } catch (e) {
          await this.send(phone, { kind: 'connect-result', id, ok: false, message: (e as Error).message })
        }
        return this.send(phone, { kind: 'connections', services: await this.host.connections() })
      }
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
      case 'login': {
        const r = await this.host.login(
          String(msg.id),
          String(msg.username ?? '').slice(0, 200),
          String(msg.password ?? '').slice(0, 500),
        )
        // 실패만 이 폰에 알린다 (성공은 본체가 모든 폰에 알린다)
        if (!r.ok) return this.send(phone, { kind: 'login-done', id: String(msg.id), ...r })
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

  private async stateFor(phone: PairedPhone): Promise<PcToPhone> {
    const now = this.phones.find((x) => x.id === phone.id) ?? phone
    return {
      kind: 'state',
      pcName: this.pcName,
      ...(await this.host.state()),
      ...(this.vapid ? { vapid: this.vapid.publicKey } : {}),
      push: Boolean(now.push),
    }
  }

  private async savePush(id: string, push: PairedPhone['push']) {
    this.phones = this.phones.map((x) => {
      if (x.id !== id) return x
      const { push: _old, ...rest } = x
      return push ? { ...rest, push } : rest
    })
    await this.secrets.set(PHONES, JSON.stringify(this.phones))
  }

  /**
   * 앱이 꺼져 있어도 폰에 알림을 띄운다 (웹 푸시). 승인 요청, 직접 해 주세요, 폰에서 맡긴 일이 끝났을 때.
   * 내용은 폰 브라우저만 풀 수 있게 암호화된다. 구독이 없어졌으면(410) 지운다
   */
  async notify(msg: PushMessage) {
    const vapid = this.vapid
    if (!vapid) return
    const send = this.opts.push ?? sendPush
    await Promise.all(
      this.phones
        .filter((p) => p.push)
        .map(async (p) => {
          const r = await send(p.push as NonNullable<PairedPhone['push']>, msg, vapid)
          if (r === 'gone') await this.savePush(p.id, undefined)
        }),
    )
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

  /** 대화 진행을 폰에도 흘려보낸다. 글자 조각은 0.12초씩 모아서 보낸다 (쓰는 대로 보이게, 너무 잘게 쪼개지 않게) */
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
        timer ??= setTimeout(flush, 120)
        return
      }
      flush()
      void this.broadcast({ kind: 'stream', threadId, event: ev })
    }
  }
}
