// Spending cap + full-auto consent gate wired into the daemon (ADR 0047). No real browser or model: a scripted brain
// runs a `code` snippet that snapshots a pay page and clicks the pay button, and fake bridges record the click.

import { generateDeviceKeyPair, newConsentEnvelope, signApproval, signConsent } from '@dool2/approvals'
import type { Brain } from '@dool2/brains'
import type { ActionClassifier, TurnEvent } from '@dool2/engine'
import { scriptedBrain } from '@dool2/engine'
import { type HostBridges, makeFakeBridges, type PageSnapshot } from '@dool2/sandbox'
import { describe, expect, it } from 'vitest'
import { Agentd, type FullAutoConsent } from './agentd.js'
import { MerchantMemory } from './merchants.js'

/** Fake bridges whose snapshot shows a pay button at e2 on a given merchant host, so a click on e2 is a payment. */
function payBridges(host = 'shop-a.example.com', amount = '50,000'): HostBridges {
  const fake = makeFakeBridges()
  fake.page.snapshot = async (): Promise<PageSnapshot> => ({
    url: `https://${host}/checkout`,
    title: 'Checkout',
    nodes: [
      { ref: 'e1', role: 'textbox', name: 'Card number' },
      { ref: 'e2', role: 'button', name: `Pay ${amount} won` },
    ],
  })
  return fake
}

const codeRounds = (code: string): TurnEvent[][] => [
  [
    { kind: 'tool_call', call: { id: 'c1', name: 'code', args: { code } } },
    { kind: 'turn_end', stop: 'tool' },
  ],
  [{ kind: 'turn_end', stop: 'done' }],
]

const PAY_CODE = 'await page.snapshot(); await page.click("e2")'
const payBrain = () => scriptedBrain(codeRounds(PAY_CODE))

/** A brain that pays on EVERY turn (snapshot + click), so one Agentd can run several pay turns in a row. */
function repeatingPayBrain(code = PAY_CODE): Brain {
  let n = 0
  return {
    id: 'pi',
    label: 'Scripted',
    async ready() {
      return true
    },
    async *run() {
      const toolRound = n % 2 === 0
      n++
      if (toolRound) {
        yield { kind: 'tool_call', call: { id: `c${n}`, name: 'code', args: { code } } }
        yield { kind: 'turn_end', stop: 'tool' }
      } else {
        yield { kind: 'turn_end', stop: 'done' }
      }
    },
  }
}

function validConsent(device: { privateKeyPem: string }, now = 1000): FullAutoConsent {
  const envelope = newConsentEnvelope(now)
  return { envelope, signature: signConsent(envelope, device.privateKeyPem) }
}

describe('setLevel is gated by a phone-signed full-auto consent', () => {
  it('refuses full without consent and stays at the previous level', () => {
    const device = generateDeviceKeyPair()
    const agentd = new Agentd({
      brain: payBrain(),
      bridges: makeFakeBridges(),
      level: 'auto',
      devicePublicKeyPem: device.publicKeyPem,
      spendingCap: { amountKrw: 100_000, period: 'day' },
    })
    const res = agentd.setLevel('full')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('consent-required')
    expect(agentd.level).toBe('auto')
    expect(agentd.fullAutoActive).toBe(false)
  })

  it('succeeds with a valid phone-signed consent', () => {
    const device = generateDeviceKeyPair()
    const agentd = new Agentd({
      brain: payBrain(),
      bridges: makeFakeBridges(),
      level: 'auto',
      devicePublicKeyPem: device.publicKeyPem,
      spendingCap: { amountKrw: 100_000, period: 'day' },
    })
    const res = agentd.setLevel('full', validConsent(device))
    expect(res.ok).toBe(true)
    expect(agentd.level).toBe('full')
    expect(agentd.fullAutoActive).toBe(true)
  })

  it('refuses a consent signed by an unpaired key (tampered/!paired)', () => {
    const device = generateDeviceKeyPair()
    const attacker = generateDeviceKeyPair()
    const agentd = new Agentd({
      brain: payBrain(),
      bridges: makeFakeBridges(),
      level: 'auto',
      devicePublicKeyPem: device.publicKeyPem,
      spendingCap: { amountKrw: 100_000, period: 'day' },
    })
    const res = agentd.setLevel('full', validConsent(attacker))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('consent-invalid')
    expect(agentd.level).toBe('auto')
  })

  it('refuses full when no spending cap is set', () => {
    const device = generateDeviceKeyPair()
    const agentd = new Agentd({
      brain: payBrain(),
      bridges: makeFakeBridges(),
      level: 'auto',
      devicePublicKeyPem: device.publicKeyPem,
    })
    const res = agentd.setLevel('full', validConsent(device))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('no-cap')
  })

  it('revoke resets full-auto back to ask', () => {
    const device = generateDeviceKeyPair()
    const agentd = new Agentd({
      brain: payBrain(),
      bridges: makeFakeBridges(),
      level: 'auto',
      devicePublicKeyPem: device.publicKeyPem,
      spendingCap: { amountKrw: 100_000, period: 'day' },
    })
    expect(agentd.setLevel('full', validConsent(device)).ok).toBe(true)
    agentd.revokeFullAuto()
    expect(agentd.level).toBe('ask')
    expect(agentd.fullAutoActive).toBe(false)
  })
})

describe('org autonomy clamp', () => {
  it("an org capped at 'auto' makes setLevel('full') refuse even with a valid consent", () => {
    const device = generateDeviceKeyPair()
    const agentd = new Agentd({
      brain: payBrain(),
      bridges: makeFakeBridges(),
      level: 'auto',
      devicePublicKeyPem: device.publicKeyPem,
      spendingCap: { amountKrw: 100_000, period: 'day' },
      orgPolicy: { maxAutonomyLevel: 'auto' },
    })
    const res = agentd.setLevel('full', validConsent(device))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('org-forbids-full')
    expect(agentd.level).toBe('auto')
  })
})

describe('code-enforced spending cap at full-auto', () => {
  const known = (host: string) => new MerchantMemory([host])

  it('a known-merchant pay under the remaining cap -> notify + spend recorded', async () => {
    const agentd = new Agentd({
      brain: payBrain(),
      bridges: payBridges('shop-a.example.com', '50,000'),
      level: 'full',
      spendingCap: { amountKrw: 100_000, period: 'day' },
      merchants: known('shop-a.example.com'),
    })
    const result = await agentd.send('pay for the order', { url: 'https://shop-a.example.com/checkout' })
    expect(result.approvalsNeeded).toHaveLength(0)
    expect(result.blocked).toHaveLength(0)
    expect(result.gateDecisions.find((g) => g.tier === 'pay')?.decision).toBe('notify')
    expect(agentd.spending().spentThisPeriod).toBe(50_000)
  })

  it('a pay that would exceed the cap -> block, no spend recorded', async () => {
    const agentd = new Agentd({
      brain: payBrain(),
      bridges: payBridges('shop-a.example.com', '50,000'),
      level: 'full',
      spendingCap: { amountKrw: 30_000, period: 'day' },
      merchants: known('shop-a.example.com'),
    })
    const result = await agentd.send('pay for the order', { url: 'https://shop-a.example.com/checkout' })
    expect(result.blocked).toHaveLength(1)
    expect(result.gateDecisions.find((g) => g.tier === 'pay')?.decision).toBe('block')
    expect(agentd.spending().spentThisPeriod).toBe(0)
  })

  it('effective cap = min(user, org): a 50,000 pay under a 100,000 user cap but a 30,000 org ceiling is blocked', async () => {
    const agentd = new Agentd({
      brain: payBrain(),
      bridges: payBridges('shop-a.example.com', '50,000'),
      level: 'full',
      spendingCap: { amountKrw: 100_000, period: 'day' },
      orgPolicy: { spendingCapKrw: 30_000 },
      merchants: known('shop-a.example.com'),
    })
    const result = await agentd.send('pay for the order', { url: 'https://shop-a.example.com/checkout' })
    expect(result.gateDecisions.find((g) => g.tier === 'pay')?.decision).toBe('block')
    expect(agentd.spending().effectiveCapKrw).toBe(30_000)
  })

  it('period rollover (fake clock) resets the spent total', async () => {
    let clock = new Date(2026, 0, 1, 9, 0, 0).getTime() // Jan 1, 09:00 local
    const agentd = new Agentd({
      brain: payBrain(),
      bridges: payBridges('shop-a.example.com', '50,000'),
      level: 'full',
      spendingCap: { amountKrw: 100_000, period: 'day' },
      merchants: known('shop-a.example.com'),
      now: () => clock,
    })
    await agentd.send('pay', { url: 'https://shop-a.example.com/checkout' })
    expect(agentd.spending().spentThisPeriod).toBe(50_000)
    clock = new Date(2026, 0, 2, 9, 0, 0).getTime() // next day
    expect(agentd.spending().spentThisPeriod).toBe(0)
  })
})

describe('new-merchant first pay still signs, then becomes known', () => {
  it('a new merchant under the cap -> sign (not auto-run); after approve + resume it is known -> notify', async () => {
    const device = generateDeviceKeyPair()
    const agentd = new Agentd({
      brain: repeatingPayBrain(),
      bridges: payBridges('new-shop.example.com', '20,000'),
      level: 'full',
      devicePublicKeyPem: device.publicKeyPem,
      spendingCap: { amountKrw: 100_000, period: 'day' },
      // merchants empty: new-shop is unknown
    })

    // First pay to a brand-new merchant: under the cap, but unknown -> a signable approval card, it did not run.
    const first = await agentd.send('pay', { url: 'https://new-shop.example.com/checkout' })
    expect(first.approvalsNeeded).toHaveLength(1)
    const card = first.approvalsNeeded[0]
    if (!card) throw new Error('expected a card')
    expect(first.gateDecisions.find((g) => g.tier === 'pay')?.decision).toBe('sign')
    expect(agentd.spending().spentThisPeriod).toBe(0)

    // The phone signs the action envelope; approve + resume runs the pay once.
    const approved = agentd.approve(card.hash, signApproval(card.envelope, device.privateKeyPem))
    expect(approved.ok).toBe(true)
    const resume = await agentd.send('pay', {
      url: 'https://new-shop.example.com/checkout',
      approved: [card.hash],
    })
    expect(resume.gateDecisions.find((g) => g.tier === 'pay')?.reason).toBe('approved')
    // the pay ran: spend recorded and the merchant is now known
    expect(agentd.spending().spentThisPeriod).toBe(20_000)

    // Next time the same merchant is known and under the cap -> notify, no card.
    const again = await agentd.send('pay again', { url: 'https://new-shop.example.com/checkout' })
    expect(again.approvalsNeeded).toHaveLength(0)
    expect(again.gateDecisions.find((g) => g.tier === 'pay')?.decision).toBe('notify')
    expect(agentd.spending().spentThisPeriod).toBe(40_000)
  })
})

describe('reviewer flag: notification at full, card at auto', () => {
  // Force the acted click to classify as a `contact` action so the reviewer path is exercised.
  const asContact: ActionClassifier = () => ({ tier: 'contact' })
  const contactBrain = () => scriptedBrain(codeRounds('await page.snapshot(); await page.click("e2")'))

  it('at full, an "unrelated" reviewer verdict becomes a notification, not a block', async () => {
    const agentd = new Agentd({
      brain: contactBrain(),
      bridges: payBridges(),
      level: 'full',
      classify: asContact,
      spendingCap: { amountKrw: 100_000, period: 'day' },
      reviewer: () => ({ related: false, reason: 'off-topic' }),
    })
    const notices: string[] = []
    const result = await agentd.send('book a table', {
      onEvent: (e) => e.type === 'notice' && notices.push(e.text),
    })
    expect(result.approvalsNeeded).toHaveLength(0)
    expect(result.blocked).toHaveLength(0)
    expect(result.gateDecisions.find((g) => g.tier === 'contact')?.decision).toBe('notify')
    expect(notices.some((n) => n.includes('unrelated'))).toBe(true)
    expect(result.notices.some((n) => n.includes('unrelated'))).toBe(true)
  })

  it('at auto, the same action is still held as a card (review), reviewer or not', async () => {
    const agentd = new Agentd({
      brain: contactBrain(),
      bridges: payBridges(),
      level: 'auto',
      classify: asContact,
      reviewer: () => ({ related: false, reason: 'off-topic' }),
    })
    const result = await agentd.send('book a table')
    expect(result.approvalsNeeded).toHaveLength(1)
    expect(result.gateDecisions.find((g) => g.tier === 'contact')?.decision).toBe('review')
  })
})
