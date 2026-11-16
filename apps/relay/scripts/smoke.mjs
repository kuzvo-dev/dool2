#!/usr/bin/env node
// 중계 서버가 제대로 도는지 밖에서 확인한다: node scripts/smoke.mjs https://relay.dool2.com
// 1) 폰 → PC 암호문 전달  2) 꺼진 PC로 보낸 봉투가 PC가 켜지면 도착  3) 서명이 틀리면 끊김
import { generateDevice, linkKey, open, seal } from '@dool2/protocol/e2e'
import { LinkClient, linkUrl } from '@dool2/protocol/link'

const relay = process.argv[2] ?? 'http://127.0.0.1:8787'
const wait = async (check, ms = 10_000) => {
  for (let t = 0; t < ms; t += 50) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('시간 초과')
}
const clients = []
const connect = async (role, keys, room) => {
  const got = []
  const c = new LinkClient({ relay, role, keys, ...(room ? { room } : {}), onEnvelope: (e) => got.push(e) })
  clients.push(c)
  c.start()
  await wait(() => c.ready)
  return { c, got }
}
const step = async (name, fn) => {
  const t = Date.now()
  await fn()
  console.log(`✓ ${name} (${Date.now() - t}ms)`)
}

try {
  const pcKeys = await generateDevice(true)
  const phoneKeys = await generateDevice(false)
  const kPhone = await linkKey(phoneKeys.boxPriv, pcKeys.boxPub, [phoneKeys.id, pcKeys.id])
  const kPc = await linkKey(pcKeys.boxPriv, phoneKeys.boxPub, [pcKeys.id, phoneKeys.id])

  let phone
  let pc
  await step('꺼진 PC로 보낸 부탁이 쌓였다가 PC가 켜지면 도착', async () => {
    phone = await connect('phone', phoneKeys, pcKeys.id)
    phone.c.send(
      await seal(
        kPhone,
        { v: 1, from: phoneKeys.id, to: pcKeys.id, kind: 'ask', seq: 1 },
        { text: '나중에' },
      ),
    )
    await new Promise((r) => setTimeout(r, 500))
    pc = await connect('pc', pcKeys)
    await wait(() => pc.got.length === 1)
    if ((await open(kPc, pc.got[0])).text !== '나중에') throw new Error('내용이 달라요')
  })
  await step('폰 → PC, PC → 폰 실시간 전달 (내용은 암호문)', async () => {
    phone.c.send(
      await seal(kPhone, { v: 1, from: phoneKeys.id, to: pcKeys.id, kind: 'ask', seq: 2 }, { text: '안녕' }),
    )
    await wait(() => pc.got.length === 2)
    if (JSON.stringify(pc.got[1]).includes('안녕')) throw new Error('평문이 보여요')
    pc.c.send(await seal(kPc, { v: 1, from: pcKeys.id, to: phoneKeys.id, kind: 'reply', seq: 1 }, 'ok'))
    await wait(() => phone.got.length === 1)
  })
  await step('서명이 틀린 접속은 끊긴다', async () => {
    const ws = new WebSocket(linkUrl(relay, pcKeys.id))
    await new Promise((r, j) => {
      ws.onopen = r
      ws.onerror = j
    })
    const code = new Promise((r) => {
      ws.onclose = (e) => r(e.code)
    })
    ws.send(
      JSON.stringify({ role: 'pc', id: pcKeys.id, signPub: pcKeys.signPub, ts: Date.now(), sig: 'AAAA' }),
    )
    if ((await code) !== 4003) throw new Error('끊기지 않았어요')
  })
  console.log(`모두 통과: ${relay}`)
} catch (e) {
  console.error(`✗ ${e.message}`)
  process.exitCode = 1
} finally {
  for (const c of clients) c.stop()
}
