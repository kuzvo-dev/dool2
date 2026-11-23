#!/usr/bin/env node
// Checks from outside that the relay works: node scripts/smoke.mjs https://relay.dool2.com
// 1) phone -> PC ciphertext delivery  2) an envelope sent to an offline PC arrives when it comes online  3) a bad signature is disconnected
import { generateDevice, linkKey, open, seal } from '@dool2/protocol/e2e'
import { LinkClient, linkUrl } from '@dool2/protocol/link'

const relay = process.argv[2] ?? 'http://127.0.0.1:8787'
const wait = async (check, ms = 10_000) => {
  for (let t = 0; t < ms; t += 50) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('timed out')
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
  await step('request sent to an offline PC is queued and arrives when the PC comes online', async () => {
    phone = await connect('phone', phoneKeys, pcKeys.id)
    phone.c.send(
      await seal(kPhone, { v: 1, from: phoneKeys.id, to: pcKeys.id, kind: 'ask', seq: 1 }, { text: 'later' }),
    )
    await new Promise((r) => setTimeout(r, 500))
    pc = await connect('pc', pcKeys)
    await wait(() => pc.got.length === 1)
    if ((await open(kPc, pc.got[0])).text !== 'later') throw new Error('content differs')
  })
  await step('live phone -> PC and PC -> phone delivery (content is ciphertext)', async () => {
    phone.c.send(
      await seal(kPhone, { v: 1, from: phoneKeys.id, to: pcKeys.id, kind: 'ask', seq: 2 }, { text: 'hello' }),
    )
    await wait(() => pc.got.length === 2)
    if (JSON.stringify(pc.got[1]).includes('hello')) throw new Error('plaintext is visible')
    pc.c.send(await seal(kPc, { v: 1, from: pcKeys.id, to: phoneKeys.id, kind: 'reply', seq: 1 }, 'ok'))
    await wait(() => phone.got.length === 1)
  })
  await step('connection with a bad signature is closed', async () => {
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
    if ((await code) !== 4003) throw new Error('not disconnected')
  })
  console.log(`all passed: ${relay}`)
} catch (e) {
  console.error(`✗ ${e.message}`)
  process.exitCode = 1
} finally {
  for (const c of clients) c.stop()
}
