// 폰 연결 끝-끝: 진짜 중계 서버 + 진짜 본체 + 폰 흉내(브라우저와 같은 WebCrypto)
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { encodeFrame, runHost } from '@dool2/browser'
import type { AgentEvent, AgentStatus, PairInvite, PcToPhone, PhoneToPc } from '@dool2/protocol'
import { approvalSignText, FILE_CHUNK } from '@dool2/protocol'
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
import {
  approveKeysSignText,
  autoApproveSignText,
  LinkClient,
  payConfirmSignText,
  resetSignText,
} from '@dool2/protocol/link'
import { type Relay, startRelay } from '@dool2/relay'
import { afterEach, describe, expect, it } from 'vitest'
import { type Daemon, startDaemon } from './index.js'
import { pairLink } from './link.js'

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
    timeLine: () => undefined,
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

describe('the pairing link', () => {
  it('opens the app on the official relay, which serves no phone app (a web address there was "page not found")', () => {
    expect(pairLink('https://relay.dool2.com', 'abc')).toBe('dool2://pair#p=abc')
    expect(pairLink('https://relay.dool2.com/', 'abc')).toBe('dool2://pair#p=abc')
    // A self-hosted relay serves the phone app at /app/
    expect(pairLink('http://127.0.0.1:8787', 'abc')).toBe('http://127.0.0.1:8787/app/#p=abc')
    // An app address set for the PC wins
    expect(pairLink('https://relay.dool2.com', 'abc', 'https://dool2.com/space/')).toBe(
      'https://dool2.com/space/#p=abc',
    )
    // The phone's scanner and its app-link handler read the invite out of any of them
    for (const url of ['dool2://pair#p=abc', 'http://127.0.0.1:8787/app/#p=abc'])
      expect(/#p=([\w-]+)/.exec(url)?.[1]).toBe('abc')
  })
})

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

    // 폰에서 PC 이름을 바꾸면 PC 설정에 남고, 폰에 새 이름이 온다
    await p.send({ kind: 'rename-pc', name: '  집 맥북  ' })
    await waitFor(() => p.inbox.some((m) => m.kind === 'state' && m.pcName === '집 맥북'))
    expect((await api('/api/settings')).settings.pcName).toBe('집 맥북')

    // Picking an AI that is not connected on this PC is refused with a reason; the connected one is taken
    await p.send({ kind: 'use-agent', agent: 'codex' })
    await waitFor(() => p.inbox.some((m) => m.kind === 'error' && m.message.includes('연결')))
    expect((await api('/api/settings')).settings.defaultAgent).toBeUndefined()
    await p.send({ kind: 'use-agent', agent: 'claude' })
    await waitFor(() => p.inbox.some((m) => m.kind === 'state' && m.defaultAgent === 'claude'))
    expect((await api('/api/settings')).settings.defaultAgent).toBe('claude')
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

describe('보안칩 승인 키 (ADR 0043)', () => {
  /** Android Keystore 흉내: P-256, 공개키 SPKI DER, 서명 DER */
  const chipKey = () => {
    const k = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    return {
      spki: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      sign: (text: string) => nodeSign('sha256', Buffer.from(text), k.privateKey).toString('base64url'),
    }
  }

  it('키를 등록하면 짝 맺기 키 서명은 더 안 받고, 결제는 결제용 키(폰 잠금)만, 끄는 것도 결제용 키로만', async () => {
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
    const lastState = () =>
      p.inbox.filter((m): m is Extract<PcToPhone, { kind: 'state' }> => m.kind === 'state').at(-1)

    const plain = chipKey()
    const pay = chipKey()
    // 짝 맺기 키가 아닌 서명으로는 등록 안 됨
    const at = Date.now()
    const other = await generateDevice(false)
    await p.send({
      kind: 'approve-keys',
      plain: plain.spki,
      pay: pay.spki,
      at,
      sig: await signText(other.signPriv, approveKeysSignText({ plain: plain.spki, pay: pay.spki }, at)),
    })
    await waitFor(() => lastState()?.approveKeys === false)
    await p.send({
      kind: 'approve-keys',
      plain: plain.spki,
      pay: pay.spki,
      at,
      sig: await signText(p.keys.signPriv, approveKeysSignText({ plain: plain.spki, pay: pay.spki }, at)),
    })
    await waitFor(() => lastState()?.approveKeys === true)
    expect(lastState()).toMatchObject({ payKey: true, payConfirm: true })

    const money = () =>
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
    const decided = (id: string) =>
      p.inbox.filter((m): m is Extract<PcToPhone, { kind: 'decided' }> => m.kind === 'decided' && m.id === id)
    const rec = money()
    if (!rec) throw new Error('no approval')
    const text = approvalSignText(rec, 'approve')
    // 짝 맺기 키(Ed25519)는 이제 안 됨
    await p.send({
      kind: 'decide',
      id: rec.id,
      decision: 'approve',
      sig: await signText(p.keys.signPriv, text),
    })
    await waitFor(() => decided(rec.id).length === 1)
    expect(decided(rec.id)[0]).toMatchObject({ ok: false, message: '서명이 맞지 않아요' })
    // 일반 키로는 결제 승인 안 됨
    await p.send({ kind: 'decide', id: rec.id, decision: 'approve', sig: plain.sign(text), key: 'plain' })
    await waitFor(() => decided(rec.id).length === 2)
    expect(decided(rec.id)[1]).toMatchObject({ ok: false })
    expect(daemon?.approvals.get(rec.id)?.status).toBe('pending')
    // 거절은 일반 키로도 됨
    await p.send({
      kind: 'decide',
      id: rec.id,
      decision: 'reject',
      sig: plain.sign(approvalSignText(rec, 'reject')),
      key: 'plain',
    })
    await waitFor(() => daemon?.approvals.get(rec.id)?.status === 'rejected')

    // 결제용 키 서명 → 처리
    const rec2 = money()
    if (!rec2) throw new Error('no approval')
    await p.send({
      kind: 'decide',
      id: rec2.id,
      decision: 'approve',
      sig: pay.sign(approvalSignText(rec2, 'approve')),
      key: 'pay',
    })
    await waitFor(() => daemon?.approvals.get(rec2.id)?.status !== 'pending')

    // 일반 키로는 끌 수 없음
    let t = Date.now()
    await p.send({
      kind: 'pay-confirm',
      on: false,
      at: t,
      sig: plain.sign(payConfirmSignText(false, t)),
      key: 'plain',
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(lastState()?.payConfirm).toBe(true)
    // 결제용 키로 끄면 결제도 일반 키로 됨
    t = Date.now()
    await p.send({
      kind: 'pay-confirm',
      on: false,
      at: t,
      sig: pay.sign(payConfirmSignText(false, t)),
      key: 'pay',
    })
    await waitFor(() => lastState()?.payConfirm === false)
    const rec3 = money()
    if (!rec3) throw new Error('no approval')
    await p.send({
      kind: 'decide',
      id: rec3.id,
      decision: 'approve',
      sig: plain.sign(approvalSignText(rec3, 'approve')),
      key: 'plain',
    })
    await waitFor(() => daemon?.approvals.get(rec3.id)?.status !== 'pending')
    // 다시 켜는 건 일반 키로도 됨
    t = Date.now()
    await p.send({
      kind: 'pay-confirm',
      on: true,
      at: t,
      sig: plain.sign(payConfirmSignText(true, t)),
      key: 'plain',
    })
    await waitFor(() => lastState()?.payConfirm === true)

    // 한 번 등록한 키는 바꿀 수 없음 (결제용 키 덧붙이기만 됨: 아래 시험)
    const evil = chipKey()
    t = Date.now()
    await p.send({
      kind: 'approve-keys',
      plain: evil.spki,
      at: t,
      sig: await signText(p.keys.signPriv, approveKeysSignText({ plain: evil.spki }, t)),
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(lastState()?.payKey).toBe(true)
  })

  it('화면 잠금이 없던 폰은 일반 키만 등록하고 결제도 일반 키로, 나중에 결제용 키만 덧붙인다', async () => {
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
    const lastState = () =>
      p.inbox.filter((m): m is Extract<PcToPhone, { kind: 'state' }> => m.kind === 'state').at(-1)
    const plain = chipKey()
    let at = Date.now()
    await p.send({
      kind: 'approve-keys',
      plain: plain.spki,
      at,
      sig: await signText(p.keys.signPriv, approveKeysSignText({ plain: plain.spki }, at)),
    })
    await waitFor(() => lastState()?.approveKeys === true)
    expect(lastState()).toMatchObject({ payKey: false, payConfirm: false })
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
    })
    if (!rec) throw new Error('no approval')
    await p.send({
      kind: 'decide',
      id: rec.id,
      decision: 'approve',
      sig: plain.sign(approvalSignText(rec, 'approve')),
      key: 'plain',
    })
    await waitFor(() => daemon?.approvals.get(rec.id)?.status !== 'pending')

    const pay = chipKey()
    at = Date.now()
    await p.send({
      kind: 'approve-keys',
      plain: plain.spki,
      pay: pay.spki,
      at,
      sig: await signText(p.keys.signPriv, approveKeysSignText({ plain: plain.spki, pay: pay.spki }, at)),
    })
    await waitFor(() => lastState()?.payKey === true)
    expect(lastState()?.payConfirm).toBe(true)
  })
})

describe('처음부터 다시 (시험용 PC)', () => {
  async function paired(devReset: boolean) {
    const { api } = await boot({ devReset })
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
    return { api, p }
  }
  const done = (p: Awaited<ReturnType<typeof phone>>) =>
    p.inbox.filter((m): m is Extract<PcToPhone, { kind: 'reset-done' }> => m.kind === 'reset-done')

  it('Chrome going on or off reaches the phones (a connected service says Chrome is closed meanwhile)', async () => {
    const { p } = await paired(false)
    const lastExtension = () =>
      p.inbox.filter((m): m is Extract<PcToPhone, { kind: 'state' }> => m.kind === 'state').at(-1)?.extension
    await waitFor(() => lastExtension() === false)
    // The extension connects through its native host, as Chrome would start it
    const toHost = new PassThrough()
    const done = runHost({ dataDir: dir ?? '', stdin: toHost, stdout: new PassThrough(), waitMs: 2_000 })
    toHost.write(encodeFrame({ event: 'hello', version: '0.3.2', browser: 'Chrome 158' }))
    await waitFor(() => lastExtension() === true)
    // Chrome closes
    toHost.end()
    await done
    await waitFor(() => lastExtension() === false)
  })

  it('시험용 PC에서만, 이 폰의 새 서명일 때만 대화·기억을 지운다 (연결은 고를 때만)', async () => {
    const { api, p } = await paired(true)
    await waitFor(() => p.inbox.some((m) => m.kind === 'state' && m.dev === true))
    await api('/api/life/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'memory-add', text: '서울 성수동에 살아요' }),
    })
    await api('/api/conversation/messages', { method: 'POST', body: JSON.stringify({ text: '안녕' }) })
    for (let i = 0; i < 100 && (await api('/api/conversation?limit=10')).messages.length < 2; i++)
      await new Promise((r) => setTimeout(r, 30))
    expect((await api('/api/conversation?limit=10')).messages.length).toBeGreaterThanOrEqual(2)

    // 다른 키의 서명 → 거절, 아무것도 지우지 않는다
    const other = await generateDevice(false)
    let at = Date.now()
    await p.send({
      kind: 'reset',
      at,
      services: false,
      sig: await signText(other.signPriv, resetSignText(at, false)),
    })
    await waitFor(() => done(p).length === 1)
    expect(done(p)[0]).toMatchObject({ ok: false, message: '서명이 맞지 않아요' })
    // 오래된 서명(3분 전) → 거절
    at = Date.now() - 180_000
    await p.send({
      kind: 'reset',
      at,
      services: false,
      sig: await signText(p.keys.signPriv, resetSignText(at, false)),
    })
    await waitFor(() => done(p).length === 2)
    expect(done(p)[1]?.ok).toBe(false)
    expect((await api('/api/life')).memory.length).toBe(1)

    // 이 폰의 서명 → 지운다
    at = Date.now()
    await p.send({
      kind: 'reset',
      at,
      services: false,
      sig: await signText(p.keys.signPriv, resetSignText(at, false)),
    })
    await waitFor(() => done(p).length === 3)
    expect(done(p)[2]?.ok).toBe(true)
    expect((await api('/api/life')).memory.length).toBe(0)
    expect((await api('/api/conversation?limit=10')).messages.length).toBe(0)
  })

  it('자동 승인은 이 폰의 새 서명일 때만 켜지고, 폰들에 상태가 간다 (ADR 0030)', async () => {
    const { api, p } = await paired(false)
    // 기본은 켜짐(11-26): 끈 상태에서 시작
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ autoApprove: false }) })
    const autoState = () =>
      p.inbox.filter((m): m is Extract<PcToPhone, { kind: 'state' }> => m.kind === 'state').at(-1)
        ?.autoApprove
    const other = await generateDevice(false)
    let at = Date.now()
    // 다른 키의 서명 → 그대로
    await p.send({
      kind: 'auto-approve',
      on: true,
      at,
      sig: await signText(other.signPriv, autoApproveSignText(true, at)),
    })
    await new Promise((r) => setTimeout(r, 200))
    expect((await api('/api/settings')).settings.autoApprove).not.toBe(true)
    // 오래된 서명 → 그대로
    at = Date.now() - 180_000
    await p.send({
      kind: 'auto-approve',
      on: true,
      at,
      sig: await signText(p.keys.signPriv, autoApproveSignText(true, at)),
    })
    await new Promise((r) => setTimeout(r, 200))
    expect((await api('/api/settings')).settings.autoApprove).not.toBe(true)
    // 이 폰의 서명 → 켜지고 폰 상태에 실린다
    at = Date.now()
    await p.send({
      kind: 'auto-approve',
      on: true,
      at,
      sig: await signText(p.keys.signPriv, autoApproveSignText(true, at)),
    })
    await waitFor(() => autoState() === true)
    expect((await api('/api/settings')).settings.autoApprove).toBe(true)
  })

  it('a normal PC does not announce dev, but resets with a fresh signature from this phone', async () => {
    const { api, p } = await paired(false)
    await waitFor(() => p.inbox.some((m) => m.kind === 'state'))
    expect(p.inbox.find((m) => m.kind === 'state')).not.toHaveProperty('dev')
    await api('/api/life/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'memory-add', text: 'one memory' }),
    })
    const at = Date.now()
    await p.send({
      kind: 'reset',
      at,
      services: false,
      sig: await signText(p.keys.signPriv, resetSignText(at, false)),
    })
    await waitFor(() => done(p).length === 1)
    expect(done(p)[0]?.ok).toBe(true)
    expect((await api('/api/life')).memory.length).toBe(0)
  })

  it('the PC settings reset with the screen token, keeping the phone link', async () => {
    const { api } = await paired(false)
    await api('/api/life/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'memory-add', text: 'one memory' }),
    })
    const r = await api('/api/reset', { method: 'POST', body: JSON.stringify({ services: false }) })
    expect(r.ok).toBe(true)
    expect((await api('/api/life')).memory.length).toBe(0)
    expect((await api('/api/link')).link.phones).toHaveLength(1)
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

describe('폰 알림 (스토어 앱, ADR 0042)', () => {
  it('앱이 FCM 토큰과 알림 키를 알리면 그쪽으로 보내고, 토큰이 없어지면(410) 지운다', async () => {
    const sent: { token: string; title: string; body: string; url?: string }[] = []
    const web: string[] = []
    let gone = false
    const { api } = await boot({
      push: async (sub) => {
        web.push(sub.endpoint)
        return 'sent'
      },
      appPush: async (reg, msg) => {
        sent.push({ token: reg.token, ...msg })
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
    const first = p.inbox.find((m) => m.kind === 'state') as Extract<PcToPhone, { kind: 'state' }>
    expect(first.appPush).toBe(false)

    // 키가 32바이트가 아니면 받지 않는다
    await p.send({ kind: 'app-push', reg: { token: 'x'.repeat(40), key: 'short' } })
    await waitFor(() => p.inbox.some((m) => m.kind === 'error'))

    const token = `fcm:${'t'.repeat(150)}`
    const key = Buffer.alloc(32, 7).toString('base64url')
    await p.send({ kind: 'app-push', reg: { token, key } })
    await waitFor(() => p.inbox.some((m) => m.kind === 'state' && m.appPush === true))
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
    expect(sent[0]).toMatchObject({ token, title: '승인을 기다려요', body: '사과 결제 · 9,900원' })
    expect(web).toHaveLength(0)

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

describe('폰이 한꺼번에 보낸 요청', () => {
  it('본체를 막 다시 켠 뒤 앱을 열 때처럼 연달아 보내도 하나도 버리지 않는다', async () => {
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
    // 다시 켠 본체처럼 열쇠를 아직 안 만든 상태에서 (앱을 열면 폰이 보내는 것과 같은 순서)
    ;(daemon as unknown as { link: { keyCache: Map<string, unknown> } }).link?.keyCache?.clear()
    // 진짜 폰처럼 순서대로, 답을 기다리지 않고 연달아 보낸다
    for (const kind of ['hello', 'conversation', 'connections', 'life'] as const) await p.send({ kind })
    await waitFor(
      () => ['conversation', 'connections', 'life'].every((k) => p.inbox.some((m) => m.kind === k)),
      10_000,
    )
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

describe('보관함 파일을 폰으로 받기', () => {
  it('두리가 만든 파일 원본을 조각(file-chunk)으로 나눠 보내고, 이어 붙이면 원본과 같다', async () => {
    const docs = await mkdtemp(join(tmpdir(), 'dool2-docs-'))
    const { api } = await boot({
      fileFolders: { desktop: [], documents: [docs], downloads: [] },
      toolToken: 'tt',
    })
    const text = '가나다라마바사 '.repeat(10_000)
    const made = await (
      await fetch(`${daemon?.url}/api/tools/file/file_write`, {
        method: 'POST',
        headers: { authorization: 'Bearer tt', 'content-type': 'application/json' },
        body: JSON.stringify({ name: '긴 글', kind: 'txt', text }),
      })
    ).json()
    expect(made.isError).toBeUndefined()
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
    let item: { id: string } | undefined
    for (let i = 0; i < 100 && !item; i++) {
      item = (await api('/api/life/library?tab=files')).items?.[0]
      if (!item) await new Promise((r) => setTimeout(r, 30))
    }
    if (!item) throw new Error('보관함에 안 올라왔어요')
    const parts: string[] = []
    let size = 0
    for (let offset = 0; offset === 0 || offset < size; offset += FILE_CHUNK) {
      p.inbox.length = 0
      await p.send({ kind: 'file-chunk', id: item.id, offset })
      await waitFor(() => p.inbox.some((m) => m.kind === 'file-chunk'))
      const m = p.inbox.find((x) => x.kind === 'file-chunk')
      if (m?.kind !== 'file-chunk' || !m.data) throw new Error(`조각 없음 ${JSON.stringify(m)}`)
      size = m.size ?? 0
      expect(m.name).toBe('긴 글.txt')
      parts.push(m.data)
    }
    expect(parts.length).toBeGreaterThan(1)
    // PC에 있는 파일과 바이트까지 같다
    const onPc = await readFile(join(docs, '두리', '긴 글.txt'))
    expect(Buffer.from(parts.join(''), 'base64').equals(onPc)).toBe(true)
    expect(size).toBe(onPc.length)
    await rm(docs, { recursive: true, force: true })
  }, 30_000)

  it('PC 파일이 없는 보관함 항목은 이유를 돌려준다', async () => {
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
    await p.send({ kind: 'file-chunk', id: 'nope', offset: 0 })
    await waitFor(() => p.inbox.some((m) => m.kind === 'file-chunk'))
    const m = p.inbox.find((x) => x.kind === 'file-chunk')
    expect(m?.kind === 'file-chunk' && m.error).toBeTruthy()
  })

  it('답 속 파일 링크(path)도 받는다: 사용자 폴더 안만, 밖·민감한 파일은 이유를 돌려준다', async () => {
    const docs = await mkdtemp(join(tmpdir(), 'dool2-docs-'))
    const outside = await mkdtemp(join(tmpdir(), 'dool2-out-'))
    await writeFile(join(docs, '초대장.png'), Buffer.from('그림'))
    await writeFile(join(docs, 'key.pem'), 'secret')
    await writeFile(join(outside, '남의.txt'), 'x')
    const { api } = await boot({ fileFolders: { desktop: [], documents: [docs], downloads: [] } })
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
    const ask = async (path: string) => {
      p.inbox.length = 0
      await p.send({ kind: 'file-chunk', id: `p:${path}`, offset: 0, path })
      await waitFor(() => p.inbox.some((m) => m.kind === 'file-chunk'))
      const m = p.inbox.find((x) => x.kind === 'file-chunk')
      if (m?.kind !== 'file-chunk') throw new Error('답 없음')
      return m
    }
    const ok = await ask(join(docs, '초대장.png'))
    expect(ok.name).toBe('초대장.png')
    expect(Buffer.from(ok.data ?? '', 'base64').toString()).toBe('그림')
    expect((await ask(join(outside, '남의.txt'))).error).toBeTruthy()
    expect((await ask(join(docs, 'key.pem'))).error).toBeTruthy()
    expect((await ask(join(docs, '..', 'x.txt'))).error).toBeTruthy()
    await rm(docs, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }, 30_000)
})

describe('폰에서 긴 목록 나눠 받기', () => {
  it('첫 화면은 피드 30개, life-page로 다음 페이지·끝, 보관함은 앞부분만 → life-item으로 전체', async () => {
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
    // 보관함에 남기면 피드에도 하나씩 올라간다: 35개
    for (let i = 0; i < 35; i++)
      await api('/api/life/action', {
        method: 'POST',
        body: JSON.stringify({
          action: 'library-save',
          title: `메모 ${i}`,
          body: i === 34 ? '긴 글 '.repeat(300) : '짧은 글',
        }),
      })
    p.inbox.length = 0
    await p.send({ kind: 'life' })
    await waitFor(() => p.inbox.some((m) => m.kind === 'life'))
    const life = p.inbox.find((m) => m.kind === 'life')
    if (life?.kind !== 'life') throw new Error('life')
    expect(life.state.feed).toHaveLength(30)
    expect(life.state.libraryCount).toEqual({ made: 35, files: 0 })
    const before = life.state.feedNext ?? ''
    expect(before).toBeTruthy()
    await p.send({ kind: 'life-page', list: 'feed', before })
    await waitFor(() => p.inbox.some((m) => m.kind === 'life-page'))
    const page = p.inbox.find((m) => m.kind === 'life-page')
    if (page?.kind !== 'life-page') throw new Error('page')
    expect(page).toMatchObject({ list: 'feed', before })
    expect(page.items).toHaveLength(5)
    expect(page.next).toBeUndefined()
    // 같은 http 화면 길도 같은 페이지
    const http = await api(`/api/life/feed?before=${encodeURIComponent(before)}`)
    expect(http.items.map((f: { id: string }) => f.id)).toEqual(page.items.map((f) => f.id))

    const cut = life.state.library.find((x) => x.cut)
    expect(cut?.body.length).toBe(400)
    await p.send({ kind: 'life-item', id: cut?.id ?? '' })
    await waitFor(() => p.inbox.some((m) => m.kind === 'life-item'))
    const item = p.inbox.find((m) => m.kind === 'life-item')
    if (item?.kind !== 'life-item') throw new Error('item')
    expect(item.item?.body.length).toBe(1200)
    expect(item.item?.cut).toBeUndefined()
    expect((await api(`/api/life/library/${cut?.id}`)).item.body.length).toBe(1200)
  })
})
