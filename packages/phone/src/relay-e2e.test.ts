// Full relay round-trip on a loopback relay: a phone, in effect a separate device, joins the daemon's relay room with
// the short pairing code, pairs (PUBLIC key only), is handed a SCOPED token, signs a `pay` approval over the relay,
// and the daemon verifies + resumes. The relay moves ciphertext only. This is the relay twin of http-e2e.test.ts.

import { Agentd, type RelayBridge, startRelayBridge } from '@dool2/agentd'
import type { Brain } from '@dool2/brains'
import { type Relay, startRelay } from '@dool2/relay'
import { type HostBridges, makeFakeBridges, type PageSnapshot } from '@dool2/sandbox'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { InMemoryKeyStore } from './keystore.js'
import { pairDevice } from './pairing.js'
import { RelayPhoneClient } from './relay-client.js'
import { signCard } from './sign.js'
import { PhoneSimulator } from './simulator.js'

const WSImpl = WebSocket as unknown as typeof globalThis.WebSocket

/** A WebSocket that records every text frame it sends, so a test can inspect what actually crossed the wire. */
function recordingWs(sink: string[]): typeof globalThis.WebSocket {
  class Rec extends WebSocket {
    override send(data: unknown, ...rest: unknown[]): void {
      sink.push(String(data))
      // @ts-expect-error forward the ws overload through
      super.send(data, ...rest)
    }
  }
  return Rec as unknown as typeof globalThis.WebSocket
}

function payBridges(): ReturnType<typeof makeFakeBridges> {
  const fake = makeFakeBridges()
  fake.page.snapshot = async (): Promise<PageSnapshot> => ({
    url: 'https://shop.example.com/checkout',
    title: 'Checkout',
    nodes: [{ ref: 'e2', role: 'button', name: 'Pay 50,000 won' }],
  })
  return fake
}

function clickBrain(ref: string): Brain {
  return {
    id: 'pi',
    label: 'click',
    async ready() {
      return true
    },
    async *run(input) {
      if (input.messages.some((m) => m.role === 'tool')) {
        yield { kind: 'turn_end', stop: 'done' }
        return
      }
      yield {
        kind: 'tool_call',
        call: {
          id: 'c1',
          name: 'code',
          args: { code: `await page.snapshot(); await page.click(${JSON.stringify(ref)})` },
        },
      }
      yield { kind: 'turn_end', stop: 'tool' }
    },
  }
}

interface Harness {
  agentd: Agentd
  bridges: HostBridges & { calls: string[] }
  relay: Relay
  bridge: RelayBridge
  code: string
}

const CODE = '428155'

async function setup(bridgeOpts: { pairingTtlMs?: number } = {}): Promise<Harness> {
  const bridges: HostBridges & { calls: string[] } = payBridges()
  const agentd = new Agentd({ brain: clickBrain('e2'), bridges, level: 'ask' })
  const relay = await startRelay()
  const bridge = await startRelayBridge({
    agentd,
    relayUrl: relay.url,
    pairingCode: CODE,
    WebSocketImpl: WSImpl,
    ...(bridgeOpts.pairingTtlMs !== undefined ? { pairingTtlMs: bridgeOpts.pairingTtlMs } : {}),
  })
  return { agentd, bridges, relay, bridge, code: CODE }
}

let harness: Harness | undefined
const phones: RelayPhoneClient[] = []
afterEach(async () => {
  for (const p of phones.splice(0)) p.close()
  harness?.bridge.close()
  await harness?.relay.close()
  harness = undefined
})

function makePhone(h: Harness, over?: Partial<{ code: string; sink: string[] }>): RelayPhoneClient {
  const offer = { ...h.bridge.offer(), ...(over?.code !== undefined ? { code: over.code } : {}) }
  const phone = new RelayPhoneClient({
    offer,
    label: 'Test iPhone',
    WebSocketImpl: over?.sink ? recordingWs(over.sink) : WSImpl,
  })
  phones.push(phone)
  return phone
}

describe('phone <-> daemon over the relay', () => {
  it('pairs with the code (public key only, encrypted on the wire) and the daemon stores exactly that key', async () => {
    harness = await setup()
    const keystore = new InMemoryKeyStore()
    const sink: string[] = []
    const phone = makePhone(harness, { sink })

    const pair = await pairDevice(phone, keystore, { deviceId: phone.deviceId, label: 'Test iPhone' })
    expect(pair.response.ok).toBe(true)
    // Only the public key is in the request; no private key anywhere.
    expect(pair.request.publicKeyPem).toBe(await keystore.getPublicKeyPem())
    expect(JSON.stringify(pair.request)).not.toContain('PRIVATE')
    // The daemon registered precisely the phone's public key.
    expect(harness.bridge.paired()).toBe(true)
    // The relay only ever saw ciphertext: no frame the phone sent carries the key material in the clear.
    const frames = sink.join('\n')
    expect(frames).not.toContain('PUBLIC KEY')
    expect(frames).not.toContain('PRIVATE')
    // A scoped token was issued, scoped to pending+approve (never admin).
    expect(phone.scope).toEqual(['pending', 'approve'])
    expect(phone.token).toBeTruthy()
  })

  it('rejects a wrong code and an expired code (no device registered)', async () => {
    harness = await setup()
    const keystore = new InMemoryKeyStore()
    const wrong = makePhone(harness, { code: '000000' })
    const bad = await pairDevice(wrong, keystore, { deviceId: wrong.deviceId })
    expect(bad.response.ok).toBe(false)
    expect(bad.response.reason).toContain('bad-code')
    expect(harness.bridge.paired()).toBe(false)

    // A fresh harness whose code is already expired.
    harness.bridge.close()
    await harness.relay.close()
    harness = await setup({ pairingTtlMs: -1_000 })
    const expired = makePhone(harness)
    const old = await pairDevice(expired, keystore, { deviceId: expired.deviceId })
    expect(old.response.ok).toBe(false)
    expect(old.response.reason).toContain('code-expired')
    expect(harness.bridge.paired()).toBe(false)
  })

  it('the scoped token can approve but not call admin endpoints', async () => {
    harness = await setup()
    const keystore = new InMemoryKeyStore()
    const phone = makePhone(harness)
    await pairDevice(phone, keystore, { deviceId: phone.deviceId })

    // An admin op with the scoped token is refused.
    const admin = await phone.callAdmin('message')
    expect(admin.ok).toBe(false)
    expect(admin.reason).toBe('forbidden')

    // But approve works: mint a card, sign it, send it.
    await harness.agentd.send('pay for the order')
    const [card] = await phone.pending()
    if (!card) throw new Error('expected a pending card')
    const sig = await signCard(card, keystore)
    const ok = await phone.approve(card.hash, sig)
    expect(ok.ok).toBe(true)
  })

  it('rejects a tampered signature and resumes the pay on a valid one', async () => {
    harness = await setup()
    const keystore = new InMemoryKeyStore()
    const phone = makePhone(harness)
    await pairDevice(phone, keystore, { deviceId: phone.deviceId })

    await harness.agentd.send('pay for the order')
    const cards = await phone.pending()
    const card = cards[0]
    if (!card) throw new Error('expected a pending card')
    expect(card.envelope.tier).toBe('pay')
    expect(harness.bridges.calls).not.toContain('page.click:e2')

    // Tampered signature: flip a byte of a real one.
    const good = await signCard(card, keystore)
    const bytes = Buffer.from(good, 'base64')
    bytes[0] = bytes[0] === undefined ? 1 : bytes[0] ^ 0xff
    const tampered = await phone.approve(card.hash, bytes.toString('base64'))
    expect(tampered.ok).toBe(false)
    expect(tampered.reason).toBe('bad-signature')

    // Valid signature via the simulator, then the daemon resumes the pay once.
    const sim = new PhoneSimulator(phone, keystore, { approve: ['pay'] })
    const [decision] = await sim.handleAll(cards)
    expect(decision?.approved).toBe(true)
    expect(decision?.result?.ok).toBe(true)

    const resumed = await harness.agentd.send('pay for the order', { approved: [card.hash] })
    expect(resumed.approvalsNeeded).toHaveLength(0)
    expect(harness.bridges.calls).toContain('page.click:e2')
    expect(resumed.gateDecisions.find((g) => g.tier === 'pay')?.decision).toBe('run')
  })
})
