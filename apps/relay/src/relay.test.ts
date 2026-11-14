import { type Envelope, generateDevice, linkKey, open, seal } from '@dool2/protocol/e2e'
import { LinkClient } from '@dool2/protocol/link'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { type Relay, startRelay } from './index.js'

let relay: Relay | undefined
const clients: LinkClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.stop()
  await relay?.close()
  relay = undefined
})

const waitFor = async (check: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !check(); t += 20) await new Promise((r) => setTimeout(r, 20))
  expect(check()).toBe(true)
}

async function client(role: 'pc' | 'phone', room?: string) {
  const keys = await generateDevice(role === 'pc')
  const got: Envelope[] = []
  const c = new LinkClient({
    relay: relay?.url ?? '',
    role,
    keys,
    ...(room ? { room } : {}),
    onEnvelope: (e) => got.push(e),
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
  })
  clients.push(c)
  c.start()
  await waitFor(() => c.ready)
  return { keys, got, c }
}

describe('중계 서버', () => {
  it('폰과 PC 사이에 암호문을 옮기고, 내용은 볼 수 없다', async () => {
    relay = await startRelay()
    const pc = await client('pc')
    const phone = await client('phone', pc.keys.id)
    const k = await linkKey(phone.keys.boxPriv, pc.keys.boxPub, [phone.keys.id, pc.keys.id])
    phone.c.send(
      await seal(k, { v: 1, from: phone.keys.id, to: pc.keys.id, kind: 'ask', seq: 1 }, { text: '안녕' }),
    )
    await waitFor(() => pc.got.length === 1)
    expect(JSON.stringify(pc.got[0])).not.toContain('안녕')
    const kPc = await linkKey(pc.keys.boxPriv, phone.keys.boxPub, [pc.keys.id, phone.keys.id])
    expect(await open(kPc, pc.got[0] as Envelope)).toEqual({ text: '안녕' })

    pc.c.send(await seal(kPc, { v: 1, from: pc.keys.id, to: phone.keys.id, kind: 'reply', seq: 1 }, 'ok'))
    await waitFor(() => phone.got.length === 1)
  })

  it('꺼진 PC로 가는 봉투는 쌓아 두었다가 켜지면 넘긴다', async () => {
    relay = await startRelay()
    const pcKeys = await generateDevice(true)
    const phone = await client('phone', pcKeys.id)
    const k = await linkKey(phone.keys.boxPriv, pcKeys.boxPub, [phone.keys.id, pcKeys.id])
    // 원격 화면 요청은 지금 보는 사람에게만 의미가 있어서 쌓아 두지 않는다
    phone.c.send(await seal(k, { v: 1, from: phone.keys.id, to: pcKeys.id, kind: 'screen', seq: 1 }, 'now'))
    phone.c.send(await seal(k, { v: 1, from: phone.keys.id, to: pcKeys.id, kind: 'ask', seq: 2 }, 'later'))
    await waitFor(() => relay?.queued(pcKeys.id) === 1)

    const got: Envelope[] = []
    const pc = new LinkClient({
      relay: relay.url,
      role: 'pc',
      keys: pcKeys,
      onEnvelope: (e) => got.push(e),
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    })
    clients.push(pc)
    pc.start()
    await waitFor(() => got.length === 1)
    expect(relay.queued(pcKeys.id)).toBe(0)
  })

  it('남을 사칭하거나 서명이 틀리면 끊는다', async () => {
    relay = await startRelay()
    const pc = await client('pc')
    const phone = await client('phone', pc.keys.id)
    // from을 PC로 속인 봉투 → 연결이 끊긴다
    const raw = new WebSocket(`${relay.url.replace('http', 'ws')}/link`)
    await new Promise((r) => raw.once('open', r))
    raw.send(
      JSON.stringify({
        role: 'phone',
        id: phone.keys.id,
        signPub: phone.keys.signPub,
        room: pc.keys.id,
        ts: Date.now(),
        sig: 'AAAA',
      }),
    )
    const code = await new Promise<number>((r) => raw.once('close', (c) => r(c)))
    expect(code).toBe(4003)

    phone.c.send({ v: 1, from: pc.keys.id, to: pc.keys.id, kind: 'x', seq: 1, iv: '', ct: '' })
    await waitFor(() => !phone.c.ready)
    expect(pc.got).toHaveLength(0)
  })

  it('폰은 자기 방의 PC에게만 보낼 수 있다', async () => {
    relay = await startRelay()
    const pc1 = await client('pc')
    const pc2 = await client('pc')
    const phone = await client('phone', pc1.keys.id)
    phone.c.send({ v: 1, from: phone.keys.id, to: pc2.keys.id, kind: 'x', seq: 1, iv: '', ct: '' })
    phone.c.send({ v: 1, from: phone.keys.id, to: pc1.keys.id, kind: 'x', seq: 2, iv: '', ct: '' })
    await waitFor(() => pc1.got.length === 1)
    expect(pc2.got).toHaveLength(0)
    expect(relay.queued(pc2.keys.id)).toBe(0)
  })
})
