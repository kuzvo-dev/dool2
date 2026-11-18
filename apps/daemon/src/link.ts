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
  type LifeAction,
  type LifeState,
  type LinkStatus,
  type PairedPhone,
  type PairInvite,
  type PairStatus,
  type PcToPhone,
  type PhoneToPc,
  type RemoteForm,
  type RemoteFormValue,
  type RemoteInfo,
  type ScreenFit,
} from '@dool2/protocol'
import { type ConnectionItem, type SocialProvider, SocialProviderSchema } from '@dool2/protocol/connect'
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
  ask(input: { threadId?: string; agent?: AgentId; text: string; image?: string }): Promise<string>
  cancel(threadId: string): void
  approval(id: string): (ApprovalView & { shot?: string }) | undefined
  decide(id: string, decision: 'approve' | 'reject'): Promise<{ ok: boolean; message: string }>
  /** 로그인 카드에 넣은 값을 금고에 저장 */
  login(id: string, username: string, password: string): Promise<{ ok: boolean; message: string }>
  /** 로그인 중 화면이 물은 것에 대한 폰의 답 (인증번호 등) */
  infoAnswer(id: string, value: string | undefined): void
  /** 문제 알리기: 폰 앱의 방금 기록을 일한 기록에 남긴다 */
  report?(phone: string, r: { note?: string; trail: { at: number; what: string }[]; app?: string }): void
  /** 원격 화면: 두리가 넘긴 탭의 화면 한 장, 그 탭에 사람이 한 입력 */
  screen(tabId: number, fit?: ScreenFit): Promise<{ shot: string; url: string; title: string } & RemoteInfo>
  /** 원격 화면 '필요한 칸만' */
  form(tabId: number): Promise<RemoteForm>
  /** 칸만 화면에서 채운 값 넣기·버튼 누르기 */
  fill(tabId: number, values: RemoteFormValue[], press?: string): Promise<void>
  remote(input: Extract<PhoneToPc, { kind: 'remote' }>): Promise<void>
  /** 서비스 연결 (ADR 0014): 목록, Chrome에서 열기(원격 화면 허용), 연결 표시·해제 */
  connections(): Promise<ConnectionItem[]>
  /** 대화 하나 (ADR 0015) */
  conversation(o: { before?: string; limit?: number }): ConversationState
  cancelConversation(): void
  connect(id: string, action: 'open' | 'mark' | 'unmark' | 'chat' | 'verify'): Promise<{ tabId?: number }>
  /** 따로 하는 대화: 새로 만들기·지우기 */
  sideNew(): Promise<Extract<PcToPhone, { kind: 'thread' }>>
  sideDelete(id: string): Promise<boolean>
  /** 목표·보관함·기억·피드 */
  life(): Promise<LifeState>
  lifeAction(a: LifeAction): Promise<LifeState>
  /** 연결하기: 금고에 넣고 대신 로그인 */
  connectLogin(
    id: string,
    username: string,
    password: string,
  ): Promise<{ ok: boolean; message: string; human?: boolean; tabId?: number }>
  /** 간편 로그인으로 연결하기 */
  connectSocial(
    id: string,
    provider: SocialProvider,
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
      /** 폰 앱 주소 (예: https://dool2.com/space/). 없으면 중계 서버의 /app/ */
      appUrl?: () => string | undefined
      /** 폰에 보일 이 PC 이름 (설정에서 바꿀 수 있어서 함수) */
      name?: () => string | undefined
      /** 폰에서 PC 이름을 바꿨다: 설정에 저장한다 */
      rename?: (name: string) => void
      now?: () => number
      /** 테스트용: 푸시 보내기 */
      push?: typeof sendPush
    } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)()
  }
  private get pcName() {
    return this.opts.name?.() || hostname().replace(/\.local$/, '')
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
    const app = this.opts.appUrl?.() || new URL('/app/', relay).href
    // 중계 주소는 늘 초대에 싣는다: 스토어 앱은 QR을 찍은 주소가 아니라 초대에 적힌 중계 서버로 붙는다
    const invite: PairInvite = {
      pc: this.keys.id,
      k: this.keys.boxPub,
      s: secret,
      n: this.pcName,
      r: relay,
    }
    const url = `${app}#p=${b64u(new TextEncoder().encode(JSON.stringify(invite)))}`
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
    // 푸는 일은 받은 순서대로 하나씩: 동시에 풀면 끝나는 순서가 뒤섞여, 순번 검사(작은 순번은 버림)가
    // 앞선 메시지를 버렸다 (본체를 막 켠 뒤 앱을 열면 서비스 목록 요청이 사라져 "받는 중…"에서 멈춤)
    const opened = this.inbox.then(async () => {
      let m: PhoneToPc
      try {
        m = await open<PhoneToPc>(await this.keyFor(phone.id, phone.boxPub), env)
      } catch {
        return undefined
      }
      if (m.kind !== env.kind) return undefined
      if (!this.guard.accept(phone.id, env.seq)) return undefined
      this.lastSeen.set(phone.id, this.now())
      if (m.kind !== 'ping') await this.secrets.set(SEQS, JSON.stringify(this.guard.snapshot()))
      return m
    })
    this.inbox = opened.catch(() => undefined)
    const msg = await opened
    if (!msg || msg.kind === 'ping') return
    // 처리는 기다리지 않고 나란히 (오래 걸리는 부탁이 다음 메시지를 막지 않게)
    await this.handle(phone, msg).catch((e: Error) => this.send(phone, { kind: 'error', message: e.message }))
  }
  /** 받은 봉투를 하나씩 푸는 줄 */
  private inbox: Promise<unknown> = Promise.resolve()

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
      case 'rename-pc': {
        const name = String(msg.name ?? '')
          .trim()
          .slice(0, 40)
        if (!name || !this.opts.rename) return
        this.opts.rename(name)
        // 연결된 폰 모두에 새 이름이 보이게
        for (const p of this.phones) await this.send(p, await this.stateFor(p)).catch(() => {})
        return
      }
      case 'screen':
      case 'remote': {
        const tabId = Number(msg.tabId)
        try {
          if (msg.kind === 'remote') await this.host.remote({ ...msg, tabId })
          const f = msg.fit
          const fit =
            f && Number(f.width) >= 200 && Number(f.height) >= 200
              ? { width: Math.round(Number(f.width)), height: Math.round(Number(f.height)) }
              : undefined
          const s = await this.host.screen(tabId, fit)
          return this.send(phone, { kind: 'screen', tabId, ...s })
        } catch (e) {
          return this.send(phone, { kind: 'screen', tabId, error: (e as Error).message })
        }
      }
      case 'form':
      case 'form-fill': {
        const tabId = Number(msg.tabId)
        try {
          if (msg.kind === 'form-fill') {
            await this.host.fill(tabId, msg.values, msg.press)
            // 눌렀으면 화면이 바뀌었을 수 있어 그림도 새로
            const s = await this.host.screen(tabId).catch(() => undefined)
            if (s) await this.send(phone, { kind: 'screen', tabId, ...s })
          }
          return this.send(phone, { kind: 'form', tabId, form: await this.host.form(tabId) })
        } catch (e) {
          return this.send(phone, { kind: 'form', tabId, error: (e as Error).message })
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
        if (
          action !== 'open' &&
          action !== 'mark' &&
          action !== 'unmark' &&
          action !== 'chat' &&
          action !== 'verify'
        )
          return
        try {
          const r = await this.host.connect(String(msg.id), action)
          if (action === 'open' && r.tabId !== undefined)
            return this.send(phone, { kind: 'connect-opened', id: String(msg.id), tabId: r.tabId })
          // 대화에 남긴 말·카드는 대화 흐름(stream)으로 이미 갔다
          if (action === 'chat' || action === 'verify') return
          return this.send(phone, { kind: 'connections', services: await this.host.connections() })
        } catch (e) {
          return this.send(phone, { kind: 'error', message: (e as Error).message })
        }
      }
      case 'side-new': {
        await this.send(phone, await this.host.sideNew())
        return this.send(phone, await this.stateFor(phone))
      }
      case 'side-delete': {
        await this.host.sideDelete(String(msg.id))
        return this.send(phone, await this.stateFor(phone))
      }
      case 'life':
        return this.send(phone, { kind: 'life', state: await this.host.life() })
      case 'life-action': {
        const { kind: _k, ...a } = msg
        try {
          return this.send(phone, { kind: 'life', state: await this.host.lifeAction(a as LifeAction) })
        } catch (e) {
          return this.send(phone, { kind: 'error', message: (e as Error).message })
        }
      }
      case 'connect-login': {
        const id = String(msg.id)
        // 기다리지 않는다: 로그인은 본체가 뒤에서 하고, 결과(connect-result·연결 목록)는 모든 폰에 따로 간다
        void this.host
          .connectLogin(id, String(msg.username).slice(0, 200), String(msg.password).slice(0, 500))
          .catch((e: Error) =>
            this.send(phone, { kind: 'connect-result', id, ok: false, message: e.message }),
          )
        return
      }
      case 'connect-social': {
        const id = String(msg.id)
        const provider = SocialProviderSchema.safeParse(msg.provider)
        if (!provider.success)
          return this.send(phone, {
            kind: 'connect-result',
            id,
            ok: false,
            message: '간편 로그인 종류가 이상해요',
          })
        void this.host
          .connectSocial(id, provider.data)
          .catch((e: Error) =>
            this.send(phone, { kind: 'connect-result', id, ok: false, message: e.message }),
          )
        return
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
          ...(typeof msg.image === 'string' && msg.image.length < 420_000 ? { image: msg.image } : {}),
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
      case 'info-answer':
        return this.host.infoAnswer(String(msg.id), typeof msg.value === 'string' ? msg.value : undefined)
      case 'report': {
        // 폰이 보낸 것을 그대로 믿지 않는다: 개수·길이를 자른다
        const trail = (Array.isArray(msg.trail) ? msg.trail : [])
          .slice(-300)
          .filter((t) => t && typeof t.at === 'number' && typeof t.what === 'string')
          .map((t) => ({ at: t.at, what: t.what.slice(0, 200) }))
        this.host.report?.(phone.name, {
          trail,
          ...(typeof msg.note === 'string' && msg.note.trim() ? { note: msg.note.trim().slice(0, 500) } : {}),
          ...(typeof msg.app === 'string' ? { app: msg.app.slice(0, 200) } : {}),
        })
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

  /** 폰마다 마지막으로 소식을 받은 때 */
  private lastSeen = new Map<string, number>()

  /**
   * 모든 폰에 보낸다 (새 승인 요청, 연결 결과 등).
   * live면 지금 앱을 켜 둔 폰(3분 안에 소식이 온 폰)에만: 흘려 쓰는 답·실시간 화면은 꺼진 폰에 쌓아 둘 필요가 없고,
   * 예전에 연결했던 폰이 많으면 중계 한도를 넘어 연결이 끊긴다
   */
  async broadcast(body: PcToPhone, o: { live?: boolean } = {}) {
    const now = this.now()
    for (const p of this.phones) {
      if (o.live && now - (this.lastSeen.get(p.id) ?? 0) > 180_000) continue
      await this.send(p, body).catch(() => {})
    }
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
      void this.broadcast(
        {
          kind: 'stream',
          threadId,
          event: { type: 'agent', event: { type: 'text', delta } },
        },
        { live: true },
      )
    }
    return (ev: DaemonStreamEvent) => {
      if (!this.phones.length) return
      if (ev.type === 'agent' && ev.event.type === 'text') {
        buf += ev.event.delta
        timer ??= setTimeout(flush, 120)
        return
      }
      // 화면이 쓰는 것만 보낸다 (글자·도구 단계). 사용량·크기 같은 안쪽 신호는 보내지 않는다
      if (ev.type === 'agent' && ev.event.type !== 'tool') return
      flush()
      void this.broadcast({ kind: 'stream', threadId, event: ev }, { live: ev.type === 'agent' })
    }
  }
}
