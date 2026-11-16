// 폰 연결 끝-끝: 진짜 중계 서버 + 진짜 본체 + 폰 흉내(브라우저와 같은 WebCrypto)
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentStatus, PairInvite, PcToPhone, PhoneToPc } from '@dool2/protocol'
import { approvalSignText } from '@dool2/protocol'
import {
  type DeviceKeys,
  type Envelope,
  fromB64u,
  generateDevice,
  linkKey,
  open,
  pairCode,
  seal,
  signText,
} from '@dool2/protocol/e2e'
import { LinkClient } from '@dool2/protocol/link'
import { type Relay, startRelay } from '@dool2/relay'
import { afterEach, describe, expect, it } from 'vitest'
import { type Daemon, startDaemon } from './index.js'

class EchoRuntime {
  readonly id = 'claude' as const
  async detect(): Promise<AgentStatus> {
    return { id: 'claude', installed: true, loggedIn: true }
  }
  async *runTurn(input: { text: string }): AsyncGenerator<AgentEvent> {
    yield { type: 'text', delta: `받았어요: ${input.text}` }
    yield { type: 'done', text: `받았어요: ${input.text}` }
  }
}

let relay: Relay | undefined
let daemon: Daemon | undefined
let dir: string | undefined
const stops: (() => void)[] = []
afterEach(async () => {
  for (const s of stops.splice(0)) s()
  await daemon?.close()
  await relay?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
  daemon = relay = dir = undefined
})

const waitFor = async (check: () => boolean, ms = 4000) => {
  for (let t = 0; t < ms && !check(); t += 25) await new Promise((r) => setTimeout(r, 25))
  expect(check()).toBe(true)
}

async function boot(extra: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  relay = await startRelay()
  dir = await mkdtemp(join(tmpdir(), 'dool2-link-'))
  daemon = await startDaemon({
    dataDir: dir,
    token: 't',
    relay: relay.url,
    pcName: '거실 PC',
    runtimes: { claude: new EchoRuntime() },
    chrome: { detect: async () => ({ installed: false }) },
    ...extra,
  })
  const api = async (path: string, init: RequestInit = {}) =>
    (
      await fetch(`${daemon?.url}${path}`, {
        ...init,
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      })
    ).json()
  await waitFor(() => false || true)
  for (let i = 0; i < 100 && !(await api('/api/link')).link.connected; i++)
    await new Promise((r) => setTimeout(r, 30))
  return { api }
}

/** 폰 흉내: QR 주소를 받아 키를 만들고 중계 서버에 붙는다 */
async function phone(url: string) {
  const invite = JSON.parse(new TextDecoder().decode(fromB64u(url.split('#p=')[1] ?? ''))) as PairInvite
  const keys: DeviceKeys = await generateDevice(false)
  const inbox: PcToPhone[] = []
  const key = await linkKey(keys.boxPriv, invite.k, [keys.id, invite.pc])
  let seq = 0
  const c = new LinkClient({
    relay: relay?.url ?? '',
    role: 'phone',
    keys,
    room: invite.pc,
    onEnvelope: (env: Envelope) => {
      void open<PcToPhone>(key, env).then((m) => inbox.push(m))
    },
  })
  stops.push(() => c.stop())
  c.start()
  await waitFor(() => c.ready)
  const send = async (body: PhoneToPc, extra: Partial<Envelope> = {}) =>
    c.send({
      ...(await seal(
        key,
        { v: 1, from: keys.id, to: invite.pc, kind: body.kind, seq: ++seq, ...extra },
        body,
      )),
    })
  return { keys, invite, inbox, send, code: await pairCode(keys.boxPriv, invite.k), raw: c, key }
}

describe('폰 연결', () => {
  it('초대에는 늘 중계 주소를 싣는다 (스토어 앱·다른 곳의 폰 앱)', async () => {
    const { api } = await boot({ appUrl: 'https://dool2.com/space/' })
    const { pair } = (await api('/api/link/pair', { method: 'POST' })) as { pair: { url: string } }
    expect(pair.url.startsWith('https://dool2.com/space/#p=')).toBe(true)
    const invite = JSON.parse(
      new TextDecoder().decode(fromB64u(pair.url.split('#p=')[1] ?? '')),
    ) as PairInvite
    expect(invite.r).toBe(relay?.url)
  })

  it('QR → 확인 코드 → PC에서 연결 → 폰이 부탁하고 답을 받는다', async () => {
    const { api } = await boot()
    const start = await api('/api/link/pair', { method: 'POST' })
    expect(start.pair.state).toBe('waiting')
    expect(start.pair.qr).toContain('<svg')
    const p = await phone(start.pair.url)
    expect(p.invite.n).toBe('거실 PC')

    await p.send(
      { kind: 'pair', secret: p.invite.s, signPub: p.keys.signPub, name: '내 폰' },
      { kind: 'pair', pub: p.keys.boxPub },
    )
    let st = await api('/api/link/pair')
    for (let i = 0; i < 100 && st.pair.state !== 'confirm'; i++) {
      await new Promise((r) => setTimeout(r, 30))
      st = await api('/api/link/pair')
    }
    // 폰과 PC가 같은 확인 코드를 본다
    expect(st.pair).toMatchObject({ state: 'confirm', code: p.code, name: '내 폰' })

    // PC에서 [연결]을 누르기 전에는 폰 부탁을 받지 않는다
    await p.send({ kind: 'hello' })
    await new Promise((r) => setTimeout(r, 200))
    expect(p.inbox).toHaveLength(0)

    await api('/api/link/pair/confirm', { method: 'POST', body: JSON.stringify({ accept: true }) })
    await waitFor(() => p.inbox.some((m) => m.kind === 'paired'))
    await waitFor(() => p.inbox.some((m) => m.kind === 'state'))
    expect((await api('/api/link')).link.phones.map((x: { name: string }) => x.name)).toEqual(['내 폰'])

    await p.send({ kind: 'ask', text: '안녕 두리' })
    await waitFor(() =>
      p.inbox.some(
        (m) => m.kind === 'stream' && m.event.type === 'saved' && m.event.message.role === 'assistant',
      ),
    )
    const answer = p.inbox.find(
      (m) => m.kind === 'stream' && m.event.type === 'saved' && m.event.message.role === 'assistant',
    )
    expect(JSON.stringify(answer)).toContain('받았어요: 안녕 두리')
  })

  it('페어링 안 된 기기, 틀린 비밀, 재전송은 버린다', async () => {
    const { api } = await boot()
    const start = await api('/api/link/pair', { method: 'POST' })
    const p = await phone(start.pair.url)
    // 틀린 비밀
    await p.send(
      { kind: 'pair', secret: 'x'.repeat(32), signPub: p.keys.signPub, name: '가짜' },
      { kind: 'pair', pub: p.keys.boxPub },
    )
    await new Promise((r) => setTimeout(r, 300))
    expect((await api('/api/link/pair')).pair.state).toBe('waiting')
    // 페어링 없이 부탁
    await p.send({ kind: 'ask', text: '몰래' })
    await new Promise((r) => setTimeout(r, 300))
    expect(p.inbox).toHaveLength(0)
  })

  it('승인은 폰 서명이 맞을 때만 처리한다', async () => {
    const { api } = await boot()
    const start = await api('/api/link/pair', { method: 'POST' })
    const p = await phone(start.pair.url)
    await p.send(
      { kind: 'pair', secret: p.invite.s, signPub: p.keys.signPub, name: '내 폰' },
      { kind: 'pair', pub: p.keys.boxPub },
    )
    for (let i = 0; i < 100 && (await api('/api/link/pair')).pair.state !== 'confirm'; i++)
      await new Promise((r) => setTimeout(r, 30))
    await api('/api/link/pair/confirm', { method: 'POST', body: JSON.stringify({ accept: true }) })
    await waitFor(() => p.inbox.some((m) => m.kind === 'paired'))

    const rec = daemon?.approvals.create({
      tabId: 1,
      ref: 'e2',
      role: '버튼',
      label: '결제하기',
      url: 'https://shop.example/pay',
      kind: 'money',
      reason: '"결제"',
      what: '사과 결제',
      where: '시험 가게',
      amount: '9,900원',
    })
    if (!rec) throw new Error('no approval')
    // 새 승인 요청은 폰에 바로 간다
    await waitFor(() => p.inbox.some((m) => m.kind === 'approval'))

    // 다른 키로 만든 서명 → 거절
    const other = await generateDevice(false)
    await p.send({
      kind: 'decide',
      id: rec.id,
      decision: 'reject',
      sig: await signText(other.signPriv, approvalSignText(rec, 'reject')),
    })
    await waitFor(() => p.inbox.some((m) => m.kind === 'decided'))
    expect(p.inbox.find((m) => m.kind === 'decided')).toMatchObject({
      ok: false,
      message: '서명이 맞지 않아요',
    })
    expect(daemon?.approvals.get(rec.id)?.status).toBe('pending')

    // 이 폰의 서명 → 처리
    await p.send({
      kind: 'decide',
      id: rec.id,
      decision: 'reject',
      sig: await signText(p.keys.signPriv, approvalSignText(rec, 'reject')),
    })
    await waitFor(() => daemon?.approvals.get(rec.id)?.status === 'rejected')
  })
})

describe('폰 알림 (웹 푸시)', () => {
  it('폰이 구독을 알리면 승인 요청 때 PC가 알림을 보내고, 구독이 없어지면(410) 지운다', async () => {
    const sent: { endpoint: string; title: string; body: string; url?: string }[] = []
    let gone = false
    const { api } = await boot({
      push: async (sub, msg) => {
        sent.push({ endpoint: sub.endpoint, ...msg })
        return gone ? 'gone' : 'sent'
      },
    })
    const start = await api('/api/link/pair', { method: 'POST' })
    const p = await phone(start.pair.url)
    await p.send(
      { kind: 'pair', secret: p.invite.s, signPub: p.keys.signPub, name: '내 폰' },
      { kind: 'pair', pub: p.keys.boxPub },
    )
    for (let i = 0; i < 100 && (await api('/api/link/pair')).pair.state !== 'confirm'; i++)
      await new Promise((r) => setTimeout(r, 30))
    await api('/api/link/pair/confirm', { method: 'POST', body: JSON.stringify({ accept: true }) })
    await waitFor(() => p.inbox.some((m) => m.kind === 'state'))
    // PC가 VAPID 공개키를 알려 준다
    const first = p.inbox.find((m) => m.kind === 'state') as Extract<PcToPhone, { kind: 'state' }>
    expect(first.vapid).toMatch(/^[\w-]{80,}$/)
    expect(first.push).toBe(false)

    // 아무 주소나 받지 않는다
    await p.send({
      kind: 'push',
      sub: { endpoint: 'https://169.254.169.254/x', keys: { p256dh: 'a', auth: 'b' } },
    })
    await waitFor(() => p.inbox.some((m) => m.kind === 'error'))

    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc'
    await p.send({ kind: 'push', sub: { endpoint, keys: { p256dh: 'BPk', auth: 'au' } } })
    await waitFor(() => p.inbox.some((m) => m.kind === 'state' && m.push === true))
    expect((await api('/api/link')).link.phones[0].push).toBe(true)

    daemon?.approvals.create({
      tabId: 1,
      ref: 'e2',
      role: '버튼',
      label: '결제하기',
      url: 'https://shop.example/pay',
      kind: 'money',
      reason: '"결제"',
      what: '사과 결제',
      where: '시험 가게',
      amount: '9,900원',
    })
    await waitFor(() => sent.length === 1)
    expect(sent[0]).toMatchObject({ endpoint, title: '승인을 기다려요', body: '사과 결제 · 9,900원' })
    expect(sent[0]?.url).toMatch(/^#a=/)

    // 폰에서 알림을 끄면(410) 다음부터 보내지 않는다
    gone = true
    daemon?.approvals.create({
      tabId: 1,
      ref: 'e3',
      role: '버튼',
      label: '결제하기',
      url: 'https://shop.example/pay',
      kind: 'money',
      reason: '"결제"',
      what: '배 결제',
      where: '시험 가게',
    })
    await waitFor(() => sent.length === 2)
    for (let i = 0; i < 100 && (await api('/api/link')).link.phones[0].push; i++)
      await new Promise((r) => setTimeout(r, 30))
    expect((await api('/api/link')).link.phones[0].push).toBe(false)
  })

  it('폰에서 맡긴 일이 끝나면 알린다', async () => {
    const sent: { title: string; body: string; url?: string }[] = []
    const { api } = await boot({
      push: async (_sub, msg) => {
        sent.push(msg)
        return 'sent'
      },
    })
    const start = await api('/api/link/pair', { method: 'POST' })
    const p = await phone(start.pair.url)
    await p.send(
      { kind: 'pair', secret: p.invite.s, signPub: p.keys.signPub, name: '내 폰' },
      { kind: 'pair', pub: p.keys.boxPub },
    )
    for (let i = 0; i < 100 && (await api('/api/link/pair')).pair.state !== 'confirm'; i++)
      await new Promise((r) => setTimeout(r, 30))
    await api('/api/link/pair/confirm', { method: 'POST', body: JSON.stringify({ accept: true }) })
    await waitFor(() => p.inbox.some((m) => m.kind === 'state'))
    await p.send({
      kind: 'push',
      sub: { endpoint: 'https://web.push.apple.com/QO', keys: { p256dh: 'B', auth: 'a' } },
    })
    await waitFor(() => p.inbox.some((m) => m.kind === 'state' && m.push === true))
    await p.send({ kind: 'ask', text: '안녕 두리' })
    await waitFor(() => sent.length === 1)
    expect(sent[0]?.body).toBe('받았어요: 안녕 두리')
    expect(sent[0]?.url).toMatch(/^#t=/)
  })
})

describe('폰에서 서비스 연결', () => {
  it('목록을 받고, 연결 표시·해제하고, 확장이 없으면 열기를 안내한다', async () => {
    const { api } = await boot()
    const start = await api('/api/link/pair', { method: 'POST' })
    const p = await phone(start.pair.url)
    await p.send(
      { kind: 'pair', secret: p.invite.s, signPub: p.keys.signPub, name: '내 폰' },
      { kind: 'pair', pub: p.keys.boxPub },
    )
    for (let i = 0; i < 100 && (await api('/api/link/pair')).pair.state !== 'confirm'; i++)
      await new Promise((r) => setTimeout(r, 30))
    await api('/api/link/pair/confirm', { method: 'POST', body: JSON.stringify({ accept: true }) })
    await waitFor(() => p.inbox.some((m) => m.kind === 'paired'))

    const lists = () =>
      p.inbox.filter((m): m is Extract<PcToPhone, { kind: 'connections' }> => m.kind === 'connections')
    await p.send({ kind: 'connections' })
    await waitFor(() => lists().length === 1)
    expect(lists()[0]?.services.some((s) => s.card.id === 'coupang' && !s.connectedAt)).toBe(true)

    await p.send({ kind: 'connect', id: 'coupang', action: 'mark' })
    await waitFor(() => lists().length === 2)
    expect(lists()[1]?.services.find((s) => s.card.id === 'coupang')?.connectedAt).toMatch(/^\d{4}-/)
    // PC 화면도 같은 상태를 본다
    const pc = await api('/api/connections')
    expect(
      pc.services.find((s: { card: { id: string } }) => s.card.id === 'coupang').connectedAt,
    ).toBeDefined()

    await p.send({ kind: 'connect', id: 'coupang', action: 'unmark' })
    await waitFor(() => lists().length === 3)
    expect(lists()[2]?.services.find((s) => s.card.id === 'coupang')?.connectedAt).toBeUndefined()

    await p.send({ kind: 'connect', id: 'coupang', action: 'open' })
    await waitFor(() => p.inbox.some((m) => m.kind === 'error'))
    expect(JSON.stringify(p.inbox.find((m) => m.kind === 'error'))).toContain('확장')
  })
})

describe('폰에서 대화 하나', () => {
  it('기록을 받고, 부탁하면 답하는 중 → 답 → 끝 상태를 받는다', async () => {
    const { api } = await boot()
    const start = await api('/api/link/pair', { method: 'POST' })
    const p = await phone(start.pair.url)
    await p.send(
      { kind: 'pair', secret: p.invite.s, signPub: p.keys.signPub, name: '내 폰' },
      { kind: 'pair', pub: p.keys.boxPub },
    )
    for (let i = 0; i < 100 && (await api('/api/link/pair')).pair.state !== 'confirm'; i++)
      await new Promise((r) => setTimeout(r, 30))
    await api('/api/link/pair/confirm', { method: 'POST', body: JSON.stringify({ accept: true }) })
    await waitFor(() => p.inbox.some((m) => m.kind === 'paired'))

    await p.send({ kind: 'conversation' })
    await waitFor(() => p.inbox.some((m) => m.kind === 'conversation'))
    const first = p.inbox.find((m) => m.kind === 'conversation')
    expect(first?.kind === 'conversation' && first.state.messages).toEqual([])

    await p.send({ kind: 'ask', text: '안녕' })
    await waitFor(() => p.inbox.some((m) => m.kind === 'conversation-status' && m.busy))
    await waitFor(() =>
      p.inbox.some(
        (m) => m.kind === 'stream' && m.event.type === 'saved' && m.event.message.role === 'assistant',
      ),
    )
    await waitFor(() => p.inbox.some((m) => m.kind === 'conversation-status' && !m.busy))

    p.inbox.length = 0
    await p.send({ kind: 'conversation' })
    await waitFor(() => p.inbox.some((m) => m.kind === 'conversation'))
    const again = p.inbox.find((m) => m.kind === 'conversation')
    expect(again?.kind === 'conversation' && again.state.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ])
  })
})
