// The phone app's wire contract, proved end to end against a fake daemon fetch (no network). This is the safety loop
// seen from the phone: pairing sends only the public key, a pending card renders, approving SIGNS and POSTs the
// signature, and declining signs nothing.

import type { ActionEnvelope } from '@dool2/approvals'
import { envelopeHash } from '@dool2/approvals'
import type { KeyStore } from '@dool2/phone'
import { InMemoryKeyStore } from '@dool2/phone'
import { describe, expect, it } from 'vitest'
import { cardView, type PendingCard } from './card.js'
import { PhoneController } from './controller.js'

const BASE = 'http://pc.test:53219'

/** A device keystore that counts how many times it is asked to sign, so a test can assert "never signed on reject". */
class SpyKeyStore implements KeyStore {
  signCalls = 0
  readonly #inner: KeyStore
  constructor(inner: KeyStore = new InMemoryKeyStore()) {
    this.#inner = inner
  }
  getPublicKeyPem(): Promise<string> {
    return this.#inner.getPublicKeyPem()
  }
  sign(bytes: Uint8Array): Promise<string> {
    this.signCalls++
    return this.#inner.sign(bytes)
  }
}

interface Call {
  path: string
  method: string
  body: unknown
}

/** A fake `fetch` over a tiny route table that records every request, so a test can read exactly what went on the wire. */
function fakeDaemon(routes: Record<string, (body: unknown) => unknown>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchFn = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname, method: init?.method ?? 'GET', body })
    const handler = routes[url.pathname]
    const result = handler ? handler(body) : {}
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { fetch: fetchFn, calls }
}

function demoEnvelope(): ActionEnvelope {
  return { tier: 'pay', label: 'Train ticket', amountKrw: 59_800, nonce: 'n-1', createdAt: 0 }
}
function pendingPayload(): PendingCard {
  const envelope = demoEnvelope()
  return { hash: envelopeHash(envelope), envelope }
}

describe('PhoneController (phone-side approval loop)', () => {
  it('pairing posts ONLY the public key (never the private key)', async () => {
    const { fetch, calls } = fakeDaemon({ '/pair': () => ({ ok: true }) })
    const controller = new PhoneController({ keystore: new SpyKeyStore(), fetch })

    const ok = await controller.connect({ baseUrl: BASE, token: 'tok', label: 'My iPhone' })

    expect(ok).toBe(true)
    expect(controller.state.connected).toBe(true)
    const pair = calls.find((c) => c.path === '/pair')
    expect(pair?.method).toBe('POST')
    const body = pair?.body as { publicKeyPem?: string }
    expect(body.publicKeyPem).toContain('PUBLIC KEY')
    expect(body.publicKeyPem).not.toContain('PRIVATE')
    // The whole request body carries no private key material.
    expect(JSON.stringify(pair?.body)).not.toContain('PRIVATE')
  })

  it('renders a pending card from a fake /pending payload', async () => {
    const card = pendingPayload()
    const { fetch } = fakeDaemon({
      '/pair': () => ({ ok: true }),
      '/pending': () => ({ pending: [card] }),
    })
    const controller = new PhoneController({ keystore: new SpyKeyStore(), fetch })

    await controller.connect({ baseUrl: BASE, token: 'tok' })
    await controller.refresh()

    expect(controller.state.card?.hash).toBe(card.hash)
    const view = cardView(controller.state.card as PendingCard)
    expect(view.label).toBe('Train ticket')
    expect(view.amountKrw).toBe(59_800)
    expect(view.tier).toBe('pay')
  })

  it('approve SIGNS the card and POSTs { hash, signature } to /approve', async () => {
    const card = pendingPayload()
    const keystore = new SpyKeyStore()
    const { fetch, calls } = fakeDaemon({
      '/pair': () => ({ ok: true }),
      '/pending': () => ({ pending: [card] }),
      '/approve': () => ({ ok: true }),
    })
    const controller = new PhoneController({ keystore, fetch })
    await controller.connect({ baseUrl: BASE, token: 'tok' })
    await controller.refresh()

    const ok = await controller.approve()

    expect(ok).toBe(true)
    expect(keystore.signCalls).toBe(1)
    expect(controller.state.outcome).toBe('approved')
    const approve = calls.find((c) => c.path === '/approve')
    expect(approve?.method).toBe('POST')
    const body = approve?.body as { hash?: string; signature?: string }
    expect(body.hash).toBe(card.hash)
    expect(typeof body.signature).toBe('string')
    expect((body.signature ?? '').length).toBeGreaterThan(0)
  })

  it('reject dismisses WITHOUT signing or posting anything', async () => {
    const card = pendingPayload()
    const keystore = new SpyKeyStore()
    const { fetch, calls } = fakeDaemon({
      '/pair': () => ({ ok: true }),
      '/pending': () => ({ pending: [card] }),
      '/approve': () => ({ ok: true }),
    })
    const controller = new PhoneController({ keystore, fetch })
    await controller.connect({ baseUrl: BASE, token: 'tok' })
    await controller.refresh()

    controller.reject()

    expect(keystore.signCalls).toBe(0)
    expect(controller.state.outcome).toBe('rejected')
    expect(calls.some((c) => c.path === '/approve')).toBe(false)
  })

  it('hand-off dismisses without signing', async () => {
    const card = pendingPayload()
    const keystore = new SpyKeyStore()
    const { fetch } = fakeDaemon({
      '/pair': () => ({ ok: true }),
      '/pending': () => ({ pending: [card] }),
    })
    const controller = new PhoneController({ keystore, fetch })
    await controller.connect({ baseUrl: BASE, token: 'tok' })
    await controller.refresh()

    controller.handOff()

    expect(keystore.signCalls).toBe(0)
    expect(controller.state.outcome).toBe('handed-off')
  })
})
