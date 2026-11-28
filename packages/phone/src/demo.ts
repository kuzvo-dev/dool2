// A runnable, offline, cross-process proof of the phone<->daemon approval loop over the network (ADR 0043/0047).
//
// Run it with:  pnpm --filter @dool2/phone build && node packages/phone/dist/demo.js
//          or:  pnpm --filter @dool2/phone demo        (after a build)
//
// What it does, all over the daemon's REAL local HTTP (loopback), with the phone as a SEPARATE client:
//   1. starts the daemon HTTP on an ephemeral port, with the scripted "click a pay button" brain and a fake page (no
//      real model, no real browser — deterministic and offline),
//   2. runs a phone client (DaemonHttpClient + InMemoryKeyStore + PhoneSimulator) that pairs via POST /pair,
//   3. drives a turn that mints a `pay` approval at level `ask`, polls GET /pending for the card,
//   4. has the phone sign the card's hash with its device key and POST /approve, which the daemon verifies,
//   5. resumes the turn with the approved hash so the daemon runs the pay once.
//
// It prints the round-trip:  paired device <fingerprint> -> approval needed <label> <amount> -> phone signed <hash>
//                            -> verified + resumed.
//
// This is a dev/demo entry point: it imports @dool2/agentd and @dool2/sandbox (dev dependencies of this package) to
// stand up a real daemon. The private key never leaves the InMemoryKeyStore; only the public key, a signature and the
// bearer token cross the wire.

import { createHash, randomBytes } from 'node:crypto'
import { Agentd, startHttpServer } from '@dool2/agentd'
import type { Brain } from '@dool2/brains'
import { type HostBridges, makeFakeBridges, type PageSnapshot } from '@dool2/sandbox'
import { DaemonHttpClient } from './http-client.js'
import { InMemoryKeyStore } from './keystore.js'
import { pairDevice } from './pairing.js'
import { PhoneSimulator } from './simulator.js'

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

/** A short, stable fingerprint of a public key PEM, for a human-readable device id in the log. */
function fingerprint(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16)
}

async function main(): Promise<number> {
  const bridges: HostBridges & { calls: string[] } = payBridges()
  const agentd = new Agentd({ brain: clickBrain('e2'), bridges, level: 'ask' })
  const token = randomBytes(16).toString('hex')
  const http = await startHttpServer({ agentd, token })

  // The phone side: a separate client over the daemon's HTTP, and a device keystore (private key stays here).
  const keystore = new InMemoryKeyStore()
  const client = new DaemonHttpClient({ baseUrl: http.url, token, label: 'Demo iPhone' })

  try {
    console.log(`daemon serving at ${http.url}`)

    // 1. Pair: send only the public key over POST /pair.
    const pub = await keystore.getPublicKeyPem()
    const pair = await pairDevice(client, keystore, { label: 'Demo iPhone' })
    if (!pair.response.ok) throw new Error(`pairing failed: ${pair.response.reason ?? 'unknown'}`)
    console.log(`paired device ${fingerprint(pub)}`)

    // 2. A turn that tries to pay. The gate stops it at level `ask`; it surfaces as a signable card.
    await client.send('pay for the order')
    const cards = await client.pending()
    const card = cards[0]
    if (!card) throw new Error('expected an approval card from the daemon')
    const amount =
      card.envelope.amountKrw !== undefined ? `${card.envelope.amountKrw.toLocaleString()} won` : ''
    console.log(`approval needed: ${card.envelope.label} ${amount}`.trimEnd())

    // 3. The phone signs the card's hash with its device key and POSTs the signature back (real signCard path).
    const phone = new PhoneSimulator(client, keystore, { approve: ['pay'] })
    const [decision] = await phone.handleAll(cards)
    if (!decision?.approved || !decision.result?.ok) {
      throw new Error(`daemon rejected the signature: ${decision?.result?.reason ?? 'unknown'}`)
    }
    console.log(`phone signed ${card.hash.slice(0, 16)}…`)

    // 4. Resume: the daemon recomputes the same hash, finds it approved, and runs the pay once.
    const resumed = await client.send('pay for the order', { approved: [card.hash] })
    const payGate = resumed.gateDecisions.find((g) => g.tier === 'pay')
    if (payGate?.decision !== 'run' || !bridges.calls.includes('page.click:e2')) {
      throw new Error(`expected the pay to run on resume, got gate=${payGate?.decision ?? 'none'}`)
    }
    console.log('verified + resumed')
    return 0
  } finally {
    await http.close()
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  },
)
