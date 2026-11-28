// v1-compat phone link (legacy-phone.ts): the already-shipped Capacitor phone app pairs and signs approvals against
// the v2 daemon over the SAME relay envelopes (e2e.ts seal/open) and message shapes it uses on origin/main — here fed
// straight into LegacyPhoneLink.handle() so the test is deterministic (the relay transport, LinkClient, is identical
// and already covered by relay-e2e.test.ts). It proves: a v1 phone pairs and the daemon registers its RAW Ed25519
// device key; a `decide` signed with a P-256 secure-chip key over approvalSignText verifies and resumes the real
// gated action; a tampered P-256 signature is rejected; the Ed25519 pairing-key fallback verifies; and the untouched
// Ed25519-over-hash verifyApproval path still works.

import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { envelopeForAction, generateDeviceKeyPair, signApproval, verifyApproval } from '@dool2/approvals'
import type { Brain } from '@dool2/brains'
import type { ApprovalView, DaemonStreamEvent, PcToPhone, PhoneToPc } from '@dool2/protocol'
import {
  type DeviceKeys,
  type Envelope,
  generateDevice,
  LINK_VERSION,
  linkKey,
  open,
  seal,
  signText,
} from '@dool2/protocol/e2e'
import { approvalSignText, approveKeysSignText } from '@dool2/protocol/link'
import { makeFakeBridges, type PageSnapshot } from '@dool2/sandbox'
import { beforeEach, describe, expect, it } from 'vitest'
import { Agentd } from './agentd.js'
import { LegacyPhoneLink } from './legacy-phone.js'

const SECRET = 'pairing-secret-fixture-24bytes!'

/** Fake bridges whose checkout page offers one pay button, so a turn produces a `pay` approval card. */
function payBridges(): ReturnType<typeof makeFakeBridges> {
  const fake = makeFakeBridges()
  fake.page.snapshot = async (): Promise<PageSnapshot> => ({
    url: 'https://shop.example.com/checkout',
    title: 'Checkout',
    nodes: [{ ref: 'e2', role: 'button', name: 'Pay 50,000 won' }],
  })
  return fake
}

/** A one-tool brain: first turn clicks the ref (a `pay`), second turn ends. Mirrors relay-e2e.test.ts. */
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

/** base64url of a public key's SPKI DER — the form the v1 phone sends its secure-chip approval keys in. */
function spkiB64u(pub: KeyObject): string {
  return pub.export({ type: 'spki', format: 'der' }).toString('base64url')
}

/** A v1-shaped phone driven straight against a LegacyPhoneLink over real sealed envelopes. */
class V1Phone {
  keys!: DeviceKeys
  private key!: Awaited<ReturnType<typeof linkKey>>
  private seq = 0
  readonly outbox: Envelope[] = []
  /** The P-256 secure-chip keys (plain signs now; pay signs after the phone lock). */
  readonly plain = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  readonly pay = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

  constructor(
    private readonly link: LegacyPhoneLink,
    private readonly pcId: string,
    private readonly pcBoxPub: string,
  ) {}

  async init(): Promise<void> {
    this.keys = await generateDevice(false)
    this.key = await linkKey(this.keys.boxPriv, this.pcBoxPub, [this.keys.id, this.pcId])
  }

  /** Seal a v1 message and hand it to the daemon-side link, exactly as the relay would deliver it. */
  private async up(kind: PhoneToPc['kind'], body: PhoneToPc, pub?: string): Promise<void> {
    this.seq += 1
    const header = {
      v: LINK_VERSION,
      from: this.keys.id,
      to: this.pcId,
      kind,
      seq: this.seq,
      ...(pub ? { pub } : {}),
    }
    await this.link.handle(await seal(this.key, header, body))
  }

  /** Open every daemon→phone envelope captured so far (the link pushes raw envelopes into outbox synchronously). */
  async received(): Promise<PcToPhone[]> {
    return Promise.all(this.outbox.map((env) => open<PcToPhone>(this.key, env)))
  }

  async pair(secret: string = SECRET): Promise<void> {
    await this.up(
      'pair',
      { kind: 'pair', secret, signPub: this.keys.signPub, name: 'Test iPhone' },
      this.keys.boxPub,
    )
  }

  async hello(): Promise<void> {
    await this.up('hello', { kind: 'hello' })
  }

  /** Send a chat message, as the shipped app does from its composer (apps/phone ask.ts). */
  async ask(text: string): Promise<void> {
    await this.up('ask', { kind: 'ask', text })
  }

  /** Fetch the conversation history, as the app does on connect and resync. */
  async conversation(): Promise<void> {
    await this.up('conversation', { kind: 'conversation' })
  }

  async cancel(): Promise<void> {
    await this.up('conversation-cancel', { kind: 'conversation-cancel' })
  }

  /** Register the P-256 secure-chip approval keys, signed with the Ed25519 pairing key (approveKeysSignText). */
  async registerApproveKeys(): Promise<void> {
    const at = Date.now()
    const keys = { plain: spkiB64u(this.plain.publicKey), pay: spkiB64u(this.pay.publicKey) }
    const sig = await signText(this.keys.signPriv, approveKeysSignText(keys, at))
    await this.up('approve-keys', { kind: 'approve-keys', plain: keys.plain, pay: keys.pay, at, sig })
  }

  /** Sign an approval's free-text string with a P-256 chip key (SHA256withECDSA → DER), as the shipped app does. */
  signP256(
    view: ApprovalView,
    decision: 'approve' | 'reject',
    which: 'pay' | 'plain',
    choice?: string,
  ): string {
    const text = approvalSignText(view, decision, choice)
    const der = createSign('SHA256')
      .update(text)
      .sign(which === 'pay' ? this.pay.privateKey : this.plain.privateKey)
    return der.toString('base64url')
  }

  /** Sign an approval with the Ed25519 pairing key (the fallback the daemon accepts only with no chip keys). */
  async signEd25519(view: ApprovalView, decision: 'approve' | 'reject', choice?: string): Promise<string> {
    return signText(this.keys.signPriv, approvalSignText(view, decision, choice))
  }

  async decide(
    view: ApprovalView,
    decision: 'approve' | 'reject',
    sig: string,
    key?: 'pay' | 'plain',
    choice?: string,
  ): Promise<void> {
    await this.up('decide', {
      kind: 'decide',
      id: view.id,
      decision,
      sig,
      ...(choice ? { choice } : {}),
      ...(key ? { key } : {}),
    })
  }
}

interface Harness {
  agentd: Agentd
  bridges: ReturnType<typeof makeFakeBridges>
  link: LegacyPhoneLink
  phone: V1Phone
}

async function setup(brain: Brain = clickBrain('e2')): Promise<Harness> {
  const pc = await generateDevice(true)
  const bridges = payBridges()
  const agentd = new Agentd({ brain, bridges, level: 'ask' })
  const link = new LegacyPhoneLink({
    keys: pc,
    agentd,
    secret: SECRET,
    relayUrl: 'https://relay.example.com',
    pcName: 'Dool2 PC',
    send: (env) => phone.outbox.push(env),
  })
  const phone = new V1Phone(link, pc.id, pc.boxPub)
  await phone.init()
  return { agentd, bridges, link, phone }
}

/** Pair + register approve-keys, then mint a pending `pay` approval and return its view (as the phone received it). */
async function pairedWithPayApproval(h: Harness): Promise<{ view: ApprovalView; hash: string }> {
  await h.phone.pair()
  await h.phone.registerApproveKeys()
  const res = await h.agentd.send('pay for the order')
  const card = res.approvalsNeeded[0]
  if (!card) throw new Error('expected a pending pay approval')
  await h.link.announceApproval(card)
  const msgs = await h.phone.received()
  const announced = msgs.find((m): m is Extract<PcToPhone, { kind: 'approval' }> => m.kind === 'approval')
  if (!announced) throw new Error('expected an announced approval view')
  return { view: announced.approval, hash: card.hash }
}

describe('v1-compat phone link', () => {
  let h: Harness
  beforeEach(async () => {
    h = await setup()
  })

  it('pairs a v1 phone and registers its RAW Ed25519 device key', async () => {
    expect(h.link.paired()).toBe(false)
    expect(h.agentd.hasDevice()).toBe(false)
    await h.phone.pair()
    expect(h.link.paired()).toBe(true)
    // registerDevice accepted the raw Ed25519 signPub (converted to SPKI PEM), not only a PEM.
    expect(h.agentd.hasDevice()).toBe(true)
    const msgs = await h.phone.received()
    expect(msgs.map((m) => m.kind)).toContain('paired')
    expect(msgs.map((m) => m.kind)).toContain('state')
  })

  it('rejects a wrong pairing secret (no device registered)', async () => {
    // The phone echoes a secret that does not match the invite's.
    await h.phone.pair('a-wrong-secret')
    expect(h.link.paired()).toBe(false)
    expect(h.agentd.hasDevice()).toBe(false)
  })

  it('verifies a P-256 pay-key approval over approvalSignText and resumes the gated action', async () => {
    const { view, hash } = await pairedWithPayApproval(h)
    expect(view.kind).toBe('money')
    expect(h.bridges.calls).not.toContain('page.click:e2')

    const sig = h.phone.signP256(view, 'approve', 'pay')
    await h.phone.decide(view, 'approve', sig, 'pay')

    const msgs = await h.phone.received()
    const decided = msgs.filter((m): m is Extract<PcToPhone, { kind: 'decided' }> => m.kind === 'decided')
    expect(decided.at(-1)?.ok).toBe(true)
    expect(h.agentd.isApproved(hash)).toBe(true)

    // The approval resumes the real `pay`: the engine re-runs exactly that action.
    const resumed = await h.agentd.send('pay for the order', { approved: [hash] })
    expect(resumed.approvalsNeeded).toHaveLength(0)
    expect(h.bridges.calls).toContain('page.click:e2')
    expect(resumed.gateDecisions.find((g) => g.tier === 'pay')?.decision).toBe('run')
  })

  it('rejects a tampered P-256 signature (nonce not spent, action not approved)', async () => {
    const { view, hash } = await pairedWithPayApproval(h)
    const good = Buffer.from(h.phone.signP256(view, 'approve', 'pay'), 'base64url')
    good[0] = (good[0] ?? 0) ^ 0xff
    await h.phone.decide(view, 'approve', good.toString('base64url'), 'pay')

    const msgs = await h.phone.received()
    const decided = msgs.filter((m): m is Extract<PcToPhone, { kind: 'decided' }> => m.kind === 'decided')
    expect(decided.at(-1)?.ok).toBe(false)
    expect(h.agentd.isApproved(hash)).toBe(false)

    // The nonce was not spent, so the genuine signature still resumes afterwards.
    await h.phone.decide(view, 'approve', h.phone.signP256(view, 'approve', 'pay'), 'pay')
    expect(h.agentd.isApproved(hash)).toBe(true)
  })

  it('verifies the Ed25519 pairing-key fallback when no chip keys are registered', async () => {
    await h.phone.pair() // no registerApproveKeys → the pairing key is the only approval key
    const res = await h.agentd.send('pay for the order')
    const card = res.approvalsNeeded[0]
    if (!card) throw new Error('expected a pending pay approval')
    await h.link.announceApproval(card)
    const announced = (await h.phone.received()).find(
      (m): m is Extract<PcToPhone, { kind: 'approval' }> => m.kind === 'approval',
    )
    if (!announced) throw new Error('expected an announced approval view')
    const view = announced.approval
    // key omitted → the daemon verifies the Ed25519 pairing-key text signature.
    await h.phone.decide(view, 'approve', await h.phone.signEd25519(view, 'approve'))
    expect(h.agentd.isApproved(card.hash)).toBe(true)
  })
})

/** A brain that just says one line and ends — the shape the demo brain uses for a plain chat answer. */
function textBrain(text: string): Brain {
  return {
    id: 'pi',
    label: 'text',
    async ready() {
      return true
    },
    async *run() {
      yield { kind: 'text', text }
      yield { kind: 'turn_end', stop: 'done' }
    },
  }
}

/** A brain that says a line, then blocks on `gate` before ending — lets a test cancel while a turn is in flight. */
function gatedBrain(text: string, gate: Promise<void>): Brain {
  return {
    id: 'pi',
    label: 'gated',
    async ready() {
      return true
    },
    async *run() {
      yield { kind: 'text', text }
      await gate
      yield { kind: 'turn_end', stop: 'done' }
    },
  }
}

/** Every `stream` event the phone received, in order. */
function streams(msgs: PcToPhone[]): DaemonStreamEvent[] {
  return msgs
    .filter((m): m is Extract<PcToPhone, { kind: 'stream' }> => m.kind === 'stream')
    .map((m) => m.event)
}

/** The streamed assistant text (concatenated text deltas). */
function streamedText(msgs: PcToPhone[]): string {
  return streams(msgs)
    .filter((e) => e.type === 'agent' && e.event.type === 'text')
    .map((e) => (e.type === 'agent' && e.event.type === 'text' ? e.event.delta : ''))
    .join('')
}

describe('v1-compat phone chat', () => {
  it('hello is answered with state and health so the app shows connected', async () => {
    const h = await setup(textBrain('Hi.'))
    await h.phone.pair()
    await h.phone.hello()
    const msgs = await h.phone.received()
    expect(msgs.map((m) => m.kind)).toContain('state')
    expect(msgs.map((m) => m.kind)).toContain('health')
  })

  it('an ask runs a turn and streams the assistant answer, then a final idle state', async () => {
    const h = await setup(textBrain('Here is your answer.'))
    await h.phone.pair()
    await h.phone.ask('what is up?')
    const msgs = await h.phone.received()

    // The user message was saved (so the app's optimistic bubble resolves).
    const saved = streams(msgs).filter((e) => e.type === 'saved')
    const savedUser = saved.find((e) => e.type === 'saved' && e.message.role === 'user')
    expect(savedUser && savedUser.type === 'saved' ? savedUser.message.text : '').toBe('what is up?')

    // The assistant answer streamed as text and was saved as the final message.
    expect(streamedText(msgs)).toBe('Here is your answer.')
    const savedAssistant = saved.find((e) => e.type === 'saved' && e.message.role === 'assistant')
    expect(savedAssistant && savedAssistant.type === 'saved' ? savedAssistant.message.text : '').toBe(
      'Here is your answer.',
    )
    // The stream closed and the conversation ended idle.
    expect(streams(msgs).some((e) => e.type === 'end')).toBe(true)
    const status = msgs.filter(
      (m): m is Extract<PcToPhone, { kind: 'conversation-status' }> => m.kind === 'conversation-status',
    )
    expect(status.at(-1)?.busy).toBe(false)
  })

  it('a reconnecting app restores the conversation with a conversation request', async () => {
    const h = await setup(textBrain('Done.'))
    await h.phone.pair()
    await h.phone.ask('remember this')
    h.phone.outbox.length = 0 // a fresh reconnect: only look at what the resync fetch returns
    await h.phone.conversation()
    const conv = (await h.phone.received()).find(
      (m): m is Extract<PcToPhone, { kind: 'conversation' }> => m.kind === 'conversation',
    )
    expect(conv).toBeDefined()
    const roles = conv?.state.messages.map((m) => `${m.role}:${m.text}`) ?? []
    expect(roles).toEqual(['user:remember this', 'assistant:Done.'])
    expect(conv?.state.busy).toBe(false)
  })

  it('cancel stops a running turn: busy clears and the answer is dropped', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const h = await setup(gatedBrain('working…', gate))
    await h.phone.pair()

    const running = h.phone.ask('do the thing') // blocks inside the turn on the gate
    await new Promise((r) => setTimeout(r, 0)) // let the user-save + busy status flush
    await h.phone.cancel()
    release()
    await running

    const msgs = await h.phone.received()
    // The suppressed turn never streamed its text nor saved an assistant answer.
    expect(streamedText(msgs)).toBe('')
    expect(streams(msgs).some((e) => e.type === 'saved' && e.message.role === 'assistant')).toBe(false)
    // The conversation ended idle (busy false) and the stream was closed.
    const status = msgs.filter(
      (m): m is Extract<PcToPhone, { kind: 'conversation-status' }> => m.kind === 'conversation-status',
    )
    expect(status.at(-1)?.busy).toBe(false)
    expect(streams(msgs).some((e) => e.type === 'end')).toBe(true)
  })

  it('still surfaces a pay approval as a card and resumes it via decide, during chat', async () => {
    const h = await setup() // the pay-clicking brain
    await h.phone.pair()
    await h.phone.registerApproveKeys()
    // The app sends the message through `ask`; the pay action pauses for a signature.
    await h.phone.ask('pay for the order')
    const announced = (await h.phone.received()).find(
      (m): m is Extract<PcToPhone, { kind: 'approval' }> => m.kind === 'approval',
    )
    if (!announced) throw new Error('expected an announced approval view')
    const view = announced.approval
    expect(view.kind).toBe('money')

    await h.phone.decide(view, 'approve', h.phone.signP256(view, 'approve', 'pay'), 'pay')
    expect(h.agentd.isApproved(view.id)).toBe(true)
    const resumed = await h.agentd.send('pay for the order', { approved: [view.id] })
    expect(resumed.gateDecisions.find((g) => g.tier === 'pay')?.decision).toBe('run')
  })
})

describe('the v2 Ed25519-over-hash approval path is untouched', () => {
  it('verifyApproval still accepts a hash-signature and rejects a tampered one', () => {
    const { privateKeyPem, publicKeyPem } = generateDeviceKeyPair()
    const envelope = envelopeForAction({ tier: 'pay', label: 'Pay 50,000 won', amountKrw: 50_000 })
    const sig = signApproval(envelope, privateKeyPem)
    expect(verifyApproval(envelope, sig, publicKeyPem)).toBe(true)
    const bytes = Buffer.from(sig, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 0xff
    expect(verifyApproval(envelope, bytes.toString('base64'), publicKeyPem)).toBe(false)
  })
})
