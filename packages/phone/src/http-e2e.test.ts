// Cross-process proof over the daemon's REAL local HTTP (loopback, ephemeral port): a phone client in effect a
// separate process — it holds only its own keystore and talks to the daemon purely over HTTP — pairs via POST /pair,
// mints a pay approval at level `ask`, signs the card's hash, POSTs it to /approve, and the daemon verifies + resumes.
// This is the network twin of e2e.test.ts (which runs the same loop in-process); both must stay green.

import { Agentd, type RunningHttpServer, startHttpServer } from '@dool2/agentd'
import type { Brain } from '@dool2/brains'
import { type HostBridges, makeFakeBridges, type PageSnapshot } from '@dool2/sandbox'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonHttpClient } from './http-client.js'
import { InMemoryKeyStore } from './keystore.js'
import { pairDevice } from './pairing.js'
import { signCard } from './sign.js'
import { PhoneSimulator } from './simulator.js'

const TOKEN = 'http-e2e-token-xyz'

/** Fake bridges whose page snapshot shows a pay button at e2, so a click on e2 classifies as a payment. */
function payBridges(): ReturnType<typeof makeFakeBridges> {
  const fake = makeFakeBridges()
  fake.page.snapshot = async (): Promise<PageSnapshot> => ({
    url: 'https://shop.example.com/checkout',
    title: 'Checkout',
    nodes: [{ ref: 'e2', role: 'button', name: 'Pay 50,000 won' }],
  })
  return fake
}

/** A brain that runs one `code` snippet clicking `ref`, then finishes. Re-clicks on a fresh (resume) turn. */
function clickBrain(ref: string): Brain {
  return {
    id: 'pi',
    label: 'click',
    async ready() {
      return true
    },
    async *run(input) {
      const alreadyRan = input.messages.some((m) => m.role === 'tool')
      if (alreadyRan) {
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
  http: RunningHttpServer
  bridges: HostBridges & { calls: string[] }
}

async function serve(): Promise<Harness> {
  const bridges: HostBridges & { calls: string[] } = payBridges()
  const agentd = new Agentd({ brain: clickBrain('e2'), bridges, level: 'ask' })
  const http = await startHttpServer({ agentd, token: TOKEN })
  return { agentd, http, bridges }
}

let running: RunningHttpServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

describe('phone <-> daemon over real HTTP (loopback)', () => {
  it('pairs (public key only), signs over HTTP, and the daemon verifies + resumes the pay', async () => {
    const { http, bridges } = await serve()
    running = http
    const keystore = new InMemoryKeyStore()
    const client = new DaemonHttpClient({ baseUrl: http.url, token: TOKEN, label: 'Test iPhone' })

    // Pair: POST /pair carries the public key, never the private key.
    const pair = await pairDevice(client, keystore, { label: 'Test iPhone', deviceId: 'dev-http-1' })
    expect(pair.response.ok).toBe(true)
    expect(pair.request.publicKeyPem).toBe(await keystore.getPublicKeyPem())
    expect(JSON.stringify(pair.request)).not.toContain('PRIVATE')

    // Turn 1: the gate stops the pay click; GET /pending surfaces the signable card.
    const first = await client.send('pay for the order')
    expect(first.approvalsNeeded).toHaveLength(1)
    const cards = await client.pending()
    const card = cards[0]
    if (!card) throw new Error('expected a pending card')
    expect(card.envelope.tier).toBe('pay')
    expect(card.envelope.amountKrw).toBe(50_000)
    expect(bridges.calls).not.toContain('page.click:e2')

    // The phone signs over HTTP (real signCard -> POST /approve). The daemon runs verifyApproval + matchesApproved.
    const phone = new PhoneSimulator(client, keystore, { approve: ['pay'] })
    const [decision] = await phone.handleAll(cards)
    expect(decision?.approved).toBe(true)
    expect(decision?.result?.ok).toBe(true)

    // Resume over HTTP: the daemon recomputes the same hash, finds it approved, and the click runs once.
    const resumed = await client.send('pay for the order', { approved: [card.hash] })
    expect(resumed.approvalsNeeded).toHaveLength(0)
    expect(bridges.calls).toContain('page.click:e2')
    expect(resumed.gateDecisions.find((g) => g.tier === 'pay')?.decision).toBe('run')
  })

  it('rejects a tampered signature and an unknown hash over HTTP', async () => {
    const { http } = await serve()
    running = http
    const keystore = new InMemoryKeyStore()
    const client = new DaemonHttpClient({ baseUrl: http.url, token: TOKEN })
    await pairDevice(client, keystore)

    await client.send('pay for the order')
    const [card] = await client.pending()
    if (!card) throw new Error('expected a pending card')

    // A tampered signature: sign the real card, flip a byte.
    const good = await signCard(card, keystore)
    const bytes = Buffer.from(good, 'base64')
    bytes[0] = bytes[0] === undefined ? 1 : bytes[0] ^ 0xff
    const tampered = await client.approve(card.hash, bytes.toString('base64'))
    expect(tampered.ok).toBe(false)
    expect(tampered.reason).toBe('bad-signature')

    // An unknown/old hash: a valid-looking 64-hex that the daemon is not waiting on.
    const unknown = await client.approve('0'.repeat(64), good)
    expect(unknown.ok).toBe(false)
    expect(unknown.reason).toBe('unknown-hash')

    // The real pay still has not run (nothing was approved).
    const resumed = await client.send('pay for the order', { approved: [card.hash] })
    expect(resumed.approvalsNeeded).toHaveLength(1)
  })

  it('refuses /pair without the bearer token', async () => {
    const { http } = await serve()
    running = http
    const keystore = new InMemoryKeyStore()
    const res = await fetch(`${http.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'dev-notoken',
        publicKeyPem: await keystore.getPublicKeyPem(),
        pairedAt: Date.now(),
      }),
    })
    expect(res.status).toBe(401)
  })

  it('without pairing the daemon has no device key, so an approval cannot verify', async () => {
    const { http } = await serve()
    running = http
    const keystore = new InMemoryKeyStore()
    const client = new DaemonHttpClient({ baseUrl: http.url, token: TOKEN })

    // No pairDevice call: the daemon never got a device key.
    await client.send('pay for the order')
    const [card] = await client.pending()
    if (!card) throw new Error('expected a pending card')
    const sig = await signCard(card, keystore)
    const result = await client.approve(card.hash, sig)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no-device-key')
  })
})
