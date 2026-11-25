// Phone link (M6, ADR 0012). PC side: stays connected to the relay and opens only envelopes from paired phones.
// - Pairing: QR (one-time secret, 5 minutes) → the phone's encrypted request → 6-digit confirm code → [Connect] on the PC screen
// - Envelopes from unpaired devices, with a wrong sequence number, or that fail to open are dropped silently
// - Approvals are handled only after the PC itself verifies the phone's Ed25519 signature
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'
import type { Lang } from '@dool2/i18n'
import {
  type AgentId,
  type ApprovalView,
  approvalSignText,
  type ConversationState,
  type DaemonStreamEvent,
  type FeedItem,
  type LibraryItem,
  type LibraryTab,
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
import { autoApproveSignText, LinkClient, resetSignText } from '@dool2/protocol/link'
import type { Page } from '@dool2/protocol/paging'
import QRCode from 'qrcode'
import { linkCopy } from './locales/link.js'
import { allowedEndpoint, generateVapid, type PushMessage, sendPush, type VapidKeys } from './webpush.js'

export const PAIR_TTL_MS = 5 * 60_000
/**
 * Size of one envelope the relay accepts (apps/relay MAX_MESSAGE = 512KB). Above that the relay drops the PC
 * connection, so it is blocked before sending (with a little margin)
 */
export const SEND_MAX = 500 * 1024
const FEED_KINDS = new Set<FeedItem['kind']>([
  'done',
  'routine',
  'saved',
  'goal',
  'connected',
  'suggest',
  'post',
])

export interface SecretStoreLike {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string | undefined): Promise<void>
}

/** Daemon features that handle phone requests (index.ts fills them in) */
export interface LinkHost {
  state(): Promise<Omit<Extract<PcToPhone, { kind: 'state' }>, 'kind' | 'pcName'>>
  thread(id: string): Promise<Extract<PcToPhone, { kind: 'thread' }> | undefined>
  /** Starts a conversation and returns stream events. Events also go out through broadcastStream */
  ask(input: { threadId?: string; agent?: AgentId; text: string; image?: string }): Promise<string>
  cancel(threadId: string): void
  approval(id: string): (ApprovalView & { shot?: string }) | undefined
  decide(
    id: string,
    decision: 'approve' | 'reject',
    choice?: string,
  ): Promise<{ ok: boolean; message: string }>
  /** Saves the values entered on a login card to the vault */
  login(id: string, username: string, password: string): Promise<{ ok: boolean; message: string }>
  /** The phone's answer to what the screen asked during login (verification code and so on) */
  infoAnswer(id: string, value: string | undefined): void
  /** The user tapped "I'm new · sign me up" on the card (site: site address, loginId: login card to close) */
  signup?(site: string, loginId: string | undefined): void
  /** The user doesn't know the account (Dool2 finds the ID or resets the password) */
  forgot?(site: string, loginId: string | undefined): void
  /** Capabilities the phone announced (hello). Text sending uses this to see if the phone app is new enough */
  caps?(phone: string, caps: string[]): void
  /** Result of a text the phone sent itself (arrives before the approval signature) */
  smsResult?(id: string, r: { ok: boolean; message: string }): void
  /** Report a problem: saves the phone app's recent trail to the activity log */
  report?(phone: string, r: { note?: string; trail: { at: number; what: string }[]; app?: string }): void
  /** Settings > My info and payment methods (values are returned masked only) */
  profile?(
    action:
      | { kind: 'get' }
      | { kind: 'set'; values: Record<string, string> }
      | { kind: 'clear' }
      | { kind: 'forget-pay'; host: string }
      | { kind: 'pay-methods'; methods: unknown[] },
  ): Promise<Omit<Extract<PcToPhone, { kind: 'profile' }>, 'kind'>>
  /** Settings > Vault (ADR 0026): list, view one, edit, delete. View comes only after the user passes the phone lock check */
  vault?(
    action:
      | { kind: 'get' }
      | { kind: 'reveal'; id: string }
      | { kind: 'set'; id: string; username?: string; password?: string }
      | { kind: 'delete'; id: string },
  ): Promise<
    | Omit<Extract<PcToPhone, { kind: 'vault' }>, 'kind'>
    | Omit<Extract<PcToPhone, { kind: 'vault-secret' }>, 'kind'>
  >
  /** Fetches a card image as a data: URL (undefined if it can't) */
  thumb?(url: string): Promise<string | undefined>
  /** Start over (test PCs only, refused otherwise). With services, also clears connected service marks */
  reset?(phone: string, o: { services: boolean }): Promise<{ ok: boolean; message: string }>
  /** Auto-approve on or off, from a phone whose signature checked out (ADR 0030) */
  setAutoApprove?(on: boolean, phone: string): void
  /** Remote screen: one frame of the tab Dool2 handed off, and the person's input on that tab */
  screen(tabId: number, fit?: ScreenFit): Promise<{ shot: string; url: string; title: string } & RemoteInfo>
  /** Remote screen 'needed fields only' */
  form(tabId: number): Promise<RemoteForm>
  /** Enter values filled on the fields-only screen and press a button */
  fill(tabId: number, values: RemoteFormValue[], press?: string): Promise<void>
  remote(input: Extract<PhoneToPc, { kind: 'remote' }>): Promise<void>
  /** Service connections (ADR 0014): list, open in Chrome (allows the remote screen), mark and unmark connected */
  connections(): Promise<ConnectionItem[]>
  /** One conversation (ADR 0015) */
  conversation(o: { before?: string; limit?: number }): ConversationState
  cancelConversation(): void
  /** Take the draft as the result (ADR 0027) */
  acceptConversation(): void
  /** Continue what the before-finishing check left */
  continueConversation(): void
  connect(id: string, action: 'open' | 'mark' | 'unmark' | 'chat' | 'verify'): Promise<{ tabId?: number }>
  /** Side conversations: create and delete */
  sideNew(): Promise<Extract<PcToPhone, { kind: 'thread' }>>
  sideDelete(id: string): Promise<boolean>
  /** Goals, library, memory, feed */
  life(): Promise<LifeState>
  lifeAction(a: LifeAction): Promise<LifeState>
  /** Long lists in pages: feed (pick kinds), library (per tab, text truncated) */
  feedPage(q: { before?: string; limit?: number; kinds?: FeedItem['kind'][] }): Promise<Page<FeedItem>>
  libraryPage(q: { before?: string; limit?: number; tab?: LibraryTab }): Promise<Page<LibraryItem>>
  /** One library item (full text) */
  libraryItem(id: string): Promise<LibraryItem | undefined>
  /** One chunk of a library file's original (to save or share on the phone) */
  fileChunk?(
    id: string,
    offset: number,
    /** File link in a reply: a PC path instead of a library id (the daemon checks it's inside the user's folders) */
    path?: string,
  ): Promise<{ size: number; name: string; mime: string; data: string } | { error: string }>
  /** Connect: save to the vault and log in for the user */
  connectLogin(
    id: string,
    username: string,
    password: string,
  ): Promise<{ ok: boolean; message: string; human?: boolean; tabId?: number }>
  /** Connect with social login */
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
      /** Phone app address (for example https://dool2.com/space/). Defaults to the relay's /app/ */
      appUrl?: () => string | undefined
      /** This PC's name as shown on the phone (a function because it can change in settings) */
      name?: () => string | undefined
      /** The PC was renamed from the phone: save it to settings */
      rename?: (name: string) => void
      now?: () => number
      /** For tests: sending push */
      push?: typeof sendPush
      /** Language for messages people read on the phone and the pairing screen (default Korean) */
      lang?: () => Lang
    } = {},
  ) {}

  private get m() {
    return linkCopy(this.opts.lang?.() ?? 'ko')
  }

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
    this.seq = Date.now() // Start from the clock so the sequence never goes down after a restart
    this.connect()
  }

  /** Reconnects when the relay address changes */
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

  // ── Pairing ──

  async startPairing(): Promise<PairStatus> {
    const relay = this.opts.relay?.()
    if (!relay || !this.keys) throw new Error(this.m.noRelay)
    const secret = b64u(randomBytes(24))
    const app = this.opts.appUrl?.() || new URL('/app/', relay).href
    // Always put the relay address in the invite: the store app connects to the relay in the invite, not the address it scanned
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

  /** [Connect] or [Cancel] on the PC screen after checking the confirm code */
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

  // ── Receiving ──

  private async keyFor(id: string, boxPub: string) {
    const cached = this.keyCache.get(id)
    if (cached) return cached
    if (!this.keys) throw new Error('No device keys')
    const k = await linkKey(this.keys.boxPriv, boxPub, [this.keys.id, id])
    this.keyCache.set(id, k)
    return k
  }

  async receive(env: Envelope) {
    if (!this.keys || env.to !== this.keys.id || env.v !== LINK_VERSION) return
    if (env.kind === 'pair') return this.receivePair(env)
    const phone = this.phones.find((x) => x.id === env.from)
    if (!phone) return // Unpaired device
    // Open envelopes one at a time in arrival order: opening in parallel finished out of order, and the sequence check
    // (drops lower numbers) dropped earlier messages (opening the app right after the daemon started lost the service
    // list request and got stuck at "Loading…")
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
    // Handle in parallel without waiting (so a long request doesn't block the next message)
    await this.handle(phone, msg).catch((e: Error) => this.send(phone, { kind: 'error', message: e.message }))
  }
  /** Queue that opens received envelopes one at a time */
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
      name: String(msg.name ?? this.m.phone).slice(0, 40),
      code: await pairCode(this.keys.boxPriv, env.pub),
    }
  }

  private async handle(phone: PairedPhone, msg: PhoneToPc) {
    switch (msg.kind) {
      case 'hello':
        this.host.caps?.(
          phone.id,
          (Array.isArray(msg.caps) ? (msg.caps as unknown[]) : [])
            .filter((c): c is string => typeof c === 'string')
            .slice(0, 20),
        )
        return this.send(phone, await this.stateFor(phone))
      case 'sms-result':
        if (typeof msg.id !== 'string') return
        this.host.smsResult?.(msg.id, {
          ok: msg.ok === true,
          message: String(msg.message ?? '').slice(0, 300),
        })
        return
      case 'rename-pc': {
        const name = String(msg.name ?? '')
          .trim()
          .slice(0, 40)
        if (!name || !this.opts.rename) return
        this.opts.rename(name)
        // So every connected phone sees the new name
        for (const p of this.phones) await this.send(p, await this.stateFor(p)).catch(() => {})
        return
      }
      case 'screen':
      case 'remote': {
        const tabId = Number(msg.tabId)
        try {
          if (msg.kind === 'remote') await this.host.remote({ ...msg, tabId })
          if (msg.kind === 'remote' && msg.action === 'done') return
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
            // A press may have changed the screen, so send a new frame too
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
          return this.send(phone, { kind: 'error', message: this.m.badPushAddress })
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
      case 'conversation-accept':
        return this.host.acceptConversation()
      case 'conversation-continue':
        return this.host.continueConversation()
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
          // Messages and cards left in the chat already went out through the stream
          if (action === 'chat' || action === 'verify') return
          return this.send(phone, { kind: 'connections', services: await this.host.connections() })
        } catch (e) {
          return this.send(phone, { kind: 'error', message: (e as Error).message })
        }
      }
      case 'side-new': {
        try {
          await this.send(phone, await this.host.sideNew())
        } catch (e) {
          // Not created when there are too many (the phone shows a notice and goes back to the menu)
          return this.send(phone, { kind: 'error', message: (e as Error).message })
        }
        return this.send(phone, await this.stateFor(phone))
      }
      case 'side-delete': {
        await this.host.sideDelete(String(msg.id))
        return this.send(phone, await this.stateFor(phone))
      }
      case 'life':
        return this.send(phone, { kind: 'life', state: await this.host.life() })
      case 'life-page': {
        const before = typeof msg.before === 'string' ? msg.before.slice(0, 120) : undefined
        const limit = Math.min(Math.max(Number(msg.limit) || 30, 1), 100)
        const at = before ? { before } : {}
        if (msg.list === 'library') {
          const tab: LibraryTab = msg.tab === 'files' ? 'files' : 'made'
          const p = await this.host.libraryPage({ ...at, limit, tab })
          return this.send(phone, { kind: 'life-page', list: 'library', tab, ...at, ...p })
        }
        const kinds = (Array.isArray(msg.kinds) ? msg.kinds : []).filter((k) => FEED_KINDS.has(k)).slice(0, 7)
        const p = await this.host.feedPage({ ...at, limit, ...(kinds.length ? { kinds } : {}) })
        return this.send(phone, {
          kind: 'life-page',
          list: 'feed',
          ...at,
          ...(kinds.length ? { kinds } : {}),
          ...p,
        })
      }
      case 'life-item': {
        const id = String(msg.id).slice(0, 80)
        const item = await this.host.libraryItem(id)
        return this.send(phone, { kind: 'life-item', id, ...(item ? { item } : {}) })
      }
      case 'file-chunk': {
        const id = String(msg.id).slice(0, 80)
        const offset = Math.max(0, Math.floor(Number(msg.offset) || 0))
        const path = typeof msg.path === 'string' && msg.path ? msg.path.slice(0, 1000) : undefined
        const r = this.host.fileChunk
          ? await this.host.fileChunk(id, offset, path).catch((e: Error) => ({ error: e.message }))
          : { error: this.m.noFileSend }
        return this.send(phone, { kind: 'file-chunk', id, offset, ...r })
      }
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
        // Don't wait: the daemon logs in in the background, and the result (connect-result, connection list) goes to every phone separately
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
            message: this.m.badSocial,
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
        // Only failures go to this phone (the daemon tells every phone about success)
        if (!r.ok) return this.send(phone, { kind: 'login-done', id: String(msg.id), ...r })
        return
      }
      case 'signup':
        if (typeof msg.site !== 'string' || !msg.site) return
        return this.host.signup?.(
          msg.site.slice(0, 200),
          typeof msg.loginId === 'string' ? msg.loginId : undefined,
        )
      case 'forgot':
        if (typeof msg.site !== 'string' || !msg.site) return
        return this.host.forgot?.(
          msg.site.slice(0, 200),
          typeof msg.loginId === 'string' ? msg.loginId : undefined,
        )
      case 'info-answer':
        return this.host.infoAnswer(String(msg.id), typeof msg.value === 'string' ? msg.value : undefined)
      case 'report': {
        // Don't trust what the phone sent as is: cap counts and lengths
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
      case 'vault-get':
      case 'vault-reveal':
      case 'vault-set':
      case 'vault-delete': {
        if (!this.host.vault) return
        const id = String((msg as { id?: unknown }).id ?? '').slice(0, 60)
        const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 200) : undefined)
        const r = await this.host.vault(
          msg.kind === 'vault-reveal'
            ? { kind: 'reveal', id }
            : msg.kind === 'vault-set'
              ? {
                  kind: 'set',
                  id,
                  ...(str(msg.username) ? { username: str(msg.username) } : {}),
                  ...(str(msg.password) ? { password: str(msg.password) } : {}),
                }
              : msg.kind === 'vault-delete'
                ? { kind: 'delete', id }
                : { kind: 'get' },
        )
        return 'password' in r
          ? this.send(phone, { kind: 'vault-secret', ...r })
          : this.send(phone, { kind: 'vault', ...r })
      }
      case 'profile-get':
      case 'profile-set':
      case 'profile-clear':
      case 'pay-choice-forget':
      case 'pay-methods-set': {
        if (!this.host.profile) return
        // Don't trust what the phone sent as is: cap field counts and lengths
        const values: Record<string, string> = {}
        if (msg.kind === 'profile-set' && msg.values && typeof msg.values === 'object')
          for (const [k, v] of Object.entries(msg.values).slice(0, 20))
            if (typeof v === 'string') values[k.slice(0, 40)] = v.slice(0, 200)
        const r = await this.host.profile(
          msg.kind === 'profile-set'
            ? { kind: 'set', values }
            : msg.kind === 'profile-clear'
              ? { kind: 'clear' }
              : msg.kind === 'pay-choice-forget'
                ? { kind: 'forget-pay', host: String(msg.host ?? '').slice(0, 200) }
                : msg.kind === 'pay-methods-set'
                  ? {
                      kind: 'pay-methods',
                      methods: Array.isArray(msg.methods) ? msg.methods.slice(0, 20) : [],
                    }
                  : { kind: 'get' },
        )
        return this.send(phone, { kind: 'profile', ...r })
      }
      case 'thumb': {
        const url = typeof msg.url === 'string' ? msg.url.slice(0, 800) : ''
        const data = url ? await this.host.thumb?.(url).catch(() => undefined) : undefined
        return this.send(phone, { kind: 'thumb', url, ...(data ? { data } : {}) })
      }
      case 'reset': {
        const no = (message: string) => this.send(phone, { kind: 'reset-done', ok: false, message })
        if (!this.host.reset) return no(this.m.noReset)
        const at = Number(msg.at)
        const services = msg.services === true
        // The PC verifies the phone's signature itself, so the relay or another device can't wipe PC data. Old signatures can't be reused
        if (!Number.isFinite(at) || Math.abs(Date.now() - at) > 120_000) return no(this.m.staleRequest)
        if (
          typeof msg.sig !== 'string' ||
          !(await verifyText(phone.signPub, resetSignText(at, services), msg.sig))
        )
          return no(this.m.badSignature)
        const r = await this.host.reset(phone.name, { services })
        await this.send(phone, { kind: 'reset-done', ...r })
        if (r.ok) for (const p of this.phones) await this.send(p, await this.stateFor(p)).catch(() => {})
        return
      }
      case 'auto-approve': {
        // Signed by the phone key and checked here, so the relay or another device cannot turn the gate off.
        // An old signature cannot be replayed (2 minutes)
        const at = Number(msg.at)
        const on = msg.on === true
        if (
          this.host.setAutoApprove &&
          Number.isFinite(at) &&
          Math.abs(Date.now() - at) <= 120_000 &&
          typeof msg.sig === 'string' &&
          (await verifyText(phone.signPub, autoApproveSignText(on, at), msg.sig))
        )
          this.host.setAutoApprove(on, phone.name)
        // Every phone gets the current state (the switch shows what the PC really has)
        for (const p of this.phones) await this.send(p, await this.stateFor(p)).catch(() => {})
        return
      }
      case 'decide': {
        const a = this.host.approval(msg.id)
        if (!a)
          return this.send(phone, {
            kind: 'decided',
            id: msg.id,
            ok: false,
            message: this.m.noApproval,
          })
        // The PC verifies the phone's signature itself. The relay or other devices can't create approvals
        // The chosen payment method is bound to the signature too (it can't be swapped in between)
        const choice = typeof msg.choice === 'string' && msg.choice ? msg.choice : undefined
        if (!(await verifyText(phone.signPub, approvalSignText(a, msg.decision, choice), msg.sig)))
          return this.send(phone, { kind: 'decided', id: msg.id, ok: false, message: this.m.badSignature })
        const r = await this.host.decide(msg.id, msg.decision, choice)
        return this.broadcast({ kind: 'decided', id: msg.id, ...r })
      }
    }
  }

  /** Sends the current state to every paired phone (a setting the phones show changed on the PC) */
  async resync() {
    for (const p of this.phones) await this.send(p, await this.stateFor(p)).catch(() => {})
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
   * Shows a notification on the phone even when the app is closed (web push): approval requests, "please do this
   * yourself", and when a task from the phone finishes. Encrypted so only the phone browser can open it. Removed when
   * the subscription is gone (410)
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

  // ── Sending ──

  /** Last life state sent to each phone (not sent again when nothing changed) */
  private lastLife = new Map<string, string>()
  /** How many times something was too large to send (for checks) */
  tooBig = 0

  private async sendTo(id: string, boxPub: string, body: PcToPhone): Promise<void> {
    if (!this.keys || !this.client) return
    const k = await this.keyFor(id, boxPub)
    const env = await seal(
      k,
      { v: LINK_VERSION, from: this.keys.id, to: id, kind: body.kind, seq: ++this.seq },
      body,
    )
    // Don't send above the relay limit: the relay would drop the connection, and the phone asking again would loop
    if (JSON.stringify(env).length > SEND_MAX) {
      this.tooBig++
      if (body.kind === 'error') return
      return this.sendTo(id, boxPub, {
        kind: 'error',
        message: this.m.tooBig,
      })
    }
    this.client.send(env)
  }

  private send(phone: PairedPhone, body: PcToPhone) {
    if (body.kind === 'life') this.lastLife.set(phone.id, JSON.stringify(body.state))
    return this.sendTo(phone.id, phone.boxPub, body)
  }

  /** When each phone was last heard from */
  private lastSeen = new Map<string, number>()

  /**
   * Sends to every phone (new approval requests, connect results and so on).
   * With live, only to phones with the app open (heard from in the last 3 minutes): streamed replies and live screens
   * don't need to pile up on closed phones, and many old paired phones would exceed the relay limit and drop the link
   */
  async broadcast(body: PcToPhone, o: { live?: boolean } = {}) {
    const now = this.now()
    // Don't resend life state identical to the last one sent to that phone (it already went as the reply to the action)
    const life = body.kind === 'life' ? JSON.stringify(body.state) : undefined
    for (const p of this.phones) {
      if (o.live && now - (this.lastSeen.get(p.id) ?? 0) > 180_000) continue
      if (life !== undefined && this.lastLife.get(p.id) === life) continue
      await this.send(p, body).catch(() => {})
    }
  }

  /** Streams conversation progress to phones too. Text pieces are batched every 0.12 s (appears as it's written, not too finely split) */
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
      // Send only what the screen uses (text and tool steps). Internal signals like usage and size are not sent
      if (ev.type === 'agent' && ev.event.type !== 'tool') return
      flush()
      void this.broadcast({ kind: 'stream', threadId, event: ev }, { live: ev.type === 'agent' })
    }
  }
}
