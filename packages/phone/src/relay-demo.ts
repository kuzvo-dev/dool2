// A runnable, offline, two-process-style proof of the phone<->daemon approval loop OVER A RELAY (ADR 0012, 0043, 0047).
//
// Run it with:  pnpm --filter @dool2/phone build && pnpm --filter @dool2/phone demo:relay
//
// Unlike demo.ts (which talks to the daemon's loopback HTTP), this proves the path a REAL phone on another network
// takes: nothing is loopback-only. It stands up, in one process but as genuinely separate parties:
//   1. a local relay (@dool2/relay) that moves ciphertext only,
//   2. the daemon joining that relay OUTWARD as the "pc" party of its own room (startRelayBridge) — no inbound port,
//   3. a phone client (RelayPhoneClient + InMemoryKeyStore + PhoneSimulator) that joins the SAME room using the short
//      pairing code from the (simulated) QR, pairs (PUBLIC key only), and is handed a SCOPED token,
//   4. a turn that mints a `pay` approval; the phone reads it over the relay, signs the envelope hash with its device
//      key, and sends the signature back; the daemon verifies and resumes the pay once.
//
// It prints the round-trip:
//   relay up → pc joined room <id> → phone paired with code <code> → scoped token issued → approval needed →
//   phone signed → verified + resumed
//
// Deterministic and offline: a scripted "click a pay button" brain and a fake page, no real model or browser. The
// private key never leaves the keystore; the relay sees only ciphertext envelopes + an opaque scoped token.

import { Agentd, startRelayBridge } from '@dool2/agentd'
import type { Brain } from '@dool2/brains'
import { startRelay } from '@dool2/relay'
import { type HostBridges, makeFakeBridges, type PageSnapshot } from '@dool2/sandbox'
import { WebSocket } from 'ws'
import { InMemoryKeyStore } from './keystore.js'
import { pairDevice } from './pairing.js'
import { RelayPhoneClient } from './relay-client.js'
import { PhoneSimulator } from './simulator.js'

const WSImpl = WebSocket as unknown as typeof globalThis.WebSocket

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
    label: 'demo-click',
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

async function main(): Promise<number> {
  const bridges: HostBridges & { calls: string[] } = payBridges()
  const agentd = new Agentd({ brain: clickBrain('e2'), bridges, level: 'ask' })

  const relay = await startRelay()
  console.log(`relay up → ${relay.url}`)

  const code = '428155'
  const bridge = await startRelayBridge({
    agentd,
    relayUrl: relay.url,
    pairingCode: code,
    WebSocketImpl: WSImpl,
  })
  console.log(`pc joined room ${bridge.room.slice(0, 8)}…`)

  const keystore = new InMemoryKeyStore()
  const phone = new RelayPhoneClient({ offer: bridge.offer(), label: 'Demo iPhone', WebSocketImpl: WSImpl })

  try {
    // 1. Pair over the relay with the code (PUBLIC key only). The daemon returns a scoped token.
    const pair = await pairDevice(phone, keystore, { deviceId: phone.deviceId, label: 'Demo iPhone' })
    if (!pair.response.ok) throw new Error(`pairing failed: ${pair.response.reason ?? 'unknown'}`)
    console.log(`phone paired with code ${code}`)
    console.log(`scoped token issued → scope=[${phone.scope.join(', ')}] (admin token never leaves the PC)`)

    // 2. A turn that tries to pay (driven on the daemon side, in-process — admin stays off the relay). The gate stops
    //    it at level `ask`, so it surfaces as a signable card the phone reads over the relay.
    await agentd.send('pay for the order')
    const cards = await phone.pending()
    const card = cards[0]
    if (!card) throw new Error('expected an approval card over the relay')
    const amount =
      card.envelope.amountKrw !== undefined ? `${card.envelope.amountKrw.toLocaleString()} won` : ''
    console.log(`approval needed → ${card.envelope.label} ${amount}`.trimEnd())

    // 3. The phone signs the card's hash with its device key and sends the signature back over the relay.
    const sim = new PhoneSimulator(phone, keystore, { approve: ['pay'] })
    const [decision] = await sim.handleAll(cards)
    if (!decision?.approved || !decision.result?.ok) {
      throw new Error(`daemon rejected the signature: ${decision?.result?.reason ?? 'unknown'}`)
    }
    console.log(`phone signed → ${card.hash.slice(0, 16)}…`)

    // 4. Resume: the daemon recomputes the same hash, finds it approved, and runs the pay once.
    const resumed = await agentd.send('pay for the order', { approved: [card.hash] })
    const payGate = resumed.gateDecisions.find((g) => g.tier === 'pay')
    if (payGate?.decision !== 'run' || !bridges.calls.includes('page.click:e2')) {
      throw new Error(`expected the pay to run on resume, got gate=${payGate?.decision ?? 'none'}`)
    }
    console.log('verified + resumed')
    return 0
  } finally {
    phone.close()
    bridge.close()
    await relay.close()
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  },
)
