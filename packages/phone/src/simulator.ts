// PhoneSimulator: a headless stand-in for the native app, so the daemon's approval loop can be driven end to end in
// a test or demo without a phone. Given a daemon-like interface and a keystore, it decides per action tier whether to
// approve (sign the card and respond) or deny (respond with nothing / report a denial), using the same real signing
// path the app uses (signCard over the envelope hash). It is the thing that closes the loop in a test:
//
//   agentd.send -> approvalNeeded card -> simulator signs -> agentd.approve verifies -> resume runs the action.
//
// The simulator never sees a secret and never holds a private key beyond the keystore seam; a denial simply does not
// sign, so the daemon's pending approval stays unsigned and the action never runs.

import type { ActionTier } from '@dool2/core'
import type { ApprovalNeeded } from './approval-card.js'
import type { KeyStore } from './keystore.js'
import { type ApprovalTransport, respond, signCard } from './sign.js'

/**
 * Which tiers the simulated phone approves. Any tier not listed in `approve` is denied; `fallback` decides tiers that
 * appear in neither list (default: deny — fail closed, like a user who ignores a card). This mirrors the real choice
 * a person makes per card, just made ahead of time by rule.
 */
export interface SimulatorPolicy {
  /** Tiers to auto-approve (sign). */
  approve?: ActionTier[]
  /** Tiers to explicitly deny (do not sign). */
  deny?: ActionTier[]
  /** What to do with a tier in neither list. Default 'deny'. */
  fallback?: 'approve' | 'deny'
}

/** What the simulator did with one card. */
export interface SimDecision {
  hash: string
  tier: ActionTier
  approved: boolean
  /** The daemon's verify result, present only when the card was approved (signed and sent). */
  result?: { ok: boolean; reason?: string }
  /** The signature sent, present only when approved. */
  signature?: string
}

/**
 * A scripted phone. Construct it with the daemon seam, the device keystore, and a per-tier policy; then feed it the
 * approval cards a turn produced. For each card it either signs and responds (approve) or does nothing (deny).
 */
export class PhoneSimulator {
  readonly #daemon: ApprovalTransport
  readonly #keystore: KeyStore
  readonly #policy: Required<SimulatorPolicy>

  constructor(daemon: ApprovalTransport, keystore: KeyStore, policy: SimulatorPolicy = {}) {
    this.#daemon = daemon
    this.#keystore = keystore
    this.#policy = {
      approve: policy.approve ?? [],
      deny: policy.deny ?? [],
      fallback: policy.fallback ?? 'deny',
    }
  }

  /** Whether the simulated phone would approve this tier, per the policy. */
  wouldApprove(tier: ActionTier): boolean {
    if (this.#policy.deny.includes(tier)) return false
    if (this.#policy.approve.includes(tier)) return true
    return this.#policy.fallback === 'approve'
  }

  /** Handle one card: sign + respond if the policy approves its tier, otherwise record a denial without signing. */
  async handle(card: ApprovalNeeded): Promise<SimDecision> {
    const tier = card.envelope.tier
    if (!this.wouldApprove(tier)) {
      return { hash: card.hash, tier, approved: false }
    }
    const signature = await signCard(card, this.#keystore)
    const result = await respond(this.#daemon, card.hash, signature)
    return { hash: card.hash, tier, approved: true, signature, result }
  }

  /** Handle a batch of cards (e.g. a send() result's approvalsNeeded), in order. */
  async handleAll(cards: ApprovalNeeded[]): Promise<SimDecision[]> {
    const out: SimDecision[] = []
    for (const card of cards) out.push(await this.handle(card))
    return out
  }
}
