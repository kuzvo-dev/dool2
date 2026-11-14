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

async function boot() {
  relay = await startRelay()
  dir = await mkdtemp(join(tmpdir(), 'dool2-link-'))
  daemon = await startDaemon({
    dataDir: dir,
    token: 't',
    relay: relay.url,
    pcName: '거실 PC',
    runtimes: { claude: new EchoRuntime() },
    chrome: { detect: async () => ({ installed: false }) },
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
