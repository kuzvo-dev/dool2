// Agentd: the v2 runnable daemon service. It composes, behind one `send()`:
//
//   brain (@dool2/brains, DI)  ->  engine turn loop (@dool2/engine runTurn)  ->  code hand (@dool2/sandbox)
//        -> host bridges: page (@dool2/page-bridge over @dool2/browser), vault (masked), pc/fs
//        -> autonomy gate (@dool2/core decide, run inside the engine for every acting call)
//        -> phone-signed approvals (@dool2/approvals) for the actions the gate says must be signed.
//
// The engine already runs the gate for each acting bridge call and hands back, per turn, the transcript, the gate
// decisions, the notices (for `notify`), and the actions that did not run (`approvalNeeded`/`blocked`). Agentd's extra
// job over the engine is the approvals lifecycle the engine deliberately leaves out: it turns each `approvalNeeded`
// into a real, signable ActionEnvelope (@dool2/approvals), mints a PendingApproval with a hash + expiry, and exposes
// approve(hash, signature) so the phone's secure-chip signature can be verified and consumed.
//
// Secrets never pass through here: the vault bridge exposes only masked summaries, and envelopes carry only the
// public facts of an action (tier, label, amount). Nothing in an event or an envelope is a password/card/PIN.

import {
  type ActionEnvelope,
  ApprovalStore,
  type CapUpdateEnvelope,
  type ConsentEnvelope,
  type ConsumeFailure,
  type ExecutedAction,
  envelopeForAction,
  envelopeHash,
  matchesApproved,
  type PendingApproval,
  pendingApproval,
  verifyCapUpdate,
  verifyConsent,
} from '@dool2/approvals'
import type { Brain } from '@dool2/brains'
import type { ActionTier, AutonomyLevel, SpendingCap } from '@dool2/core'
import {
  type ActionClassifier,
  type ApprovalOutcome,
  defaultClassify,
  type EngineSkill,
  type GateDecisionLog,
  type RefinedAction,
  runTurn,
  type TranscriptItem,
  type TurnResult,
} from '@dool2/engine'
import { clampAutonomy, type OrgPolicy } from '@dool2/org'
import type { HostBridges } from '@dool2/sandbox'
import type { CoverageStats } from '@dool2/skill-learn'
import type { LearnController, LocalDraft } from './learn.js'
import { MerchantMemory, normalizeMerchant } from './merchants.js'
import { effectiveCapKrw, SpendLedger } from './spending.js'

/** One thing that happened during a turn, as streamed to a client (HTTP) or printed (CLI). */
export type AgentdEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; name: string; id: string; args: unknown }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }
  | { type: 'notice'; text: string }
  | {
      type: 'gate'
      label: string
      tier: GateDecisionLog['tier']
      decision: GateDecisionLog['decision']
      reason: string
      allowed: boolean
      amountKrw?: number
    }
  | { type: 'approvalNeeded'; card: ApprovalCard }
  | { type: 'blocked'; label: string; tier: ApprovalOutcome['tier']; reason: string }
  | {
      /**
       * A review-pending site-skill draft was produced from this turn (learn-by-watching, ADR 0046). The desktop shows
       * a "new site-skill draft is ready" banner (copy lives in @dool2/i18n) and offers a review. Never auto-published;
       * it stays local until a maintainer signs it into a pack.
       */
      type: 'draft'
      id: string
      host: string
      needsReview: true
      /** Whether this folded into an existing draft for the host (true) or started a new one (false). */
      merged: boolean
      /** The library KPIs after this draft, for the dashboard. */
      coverage: CoverageStats
    }
  | { type: 'turn_end'; stop: TurnResult['stop'] }

/** What the phone needs to sign an action: the exact envelope and its hash, plus the facts to show the user. */
export interface ApprovalCard {
  /** sha256 hex of the canonical envelope — the value the phone signs and the key approve() looks it up by. */
  hash: string
  envelope: ActionEnvelope
  label: string
  tier: ApprovalOutcome['tier']
  reason: string
  amountKrw?: number
  /** Unix ms after which the approval is dead and must be re-requested. */
  expiresAt: number
}

/** The result of one turn: the clean transcript, the gate log, notices, and any approval cards the phone must sign. */
export interface SendResult {
  system: string
  transcript: TranscriptItem[]
  gateDecisions: GateDecisionLog[]
  notices: string[]
  /** Actions that paused for a phone signature. Each is registered; call approve(hash, signature) to clear it. */
  approvalsNeeded: ApprovalCard[]
  /** Actions refused over a hard cap. */
  blocked: { label: string; tier: ApprovalOutcome['tier']; reason: string }[]
  stop: TurnResult['stop']
}

export interface SendOptions {
  /** The URL of the active tab, if any, handed to the engine so skills can match and the gate can read the page. */
  url?: string
  /** Override the session autonomy level for this one turn. */
  level?: AutonomyLevel
  /**
   * Resume after a phone signature (ADR 0047): the envelope hashes already approved via approve(). Each one lets the
   * engine run exactly that `sign` action instead of pausing again. A hash the daemon has not actually recorded as
   * approved is ignored, so a client cannot fake an approval by passing a hash here. Hashes that run are dropped from
   * the approved set afterwards (single-use across the session).
   */
  approved?: string[]
  /** Called for each event as the turn is replayed, so the HTTP layer can stream and the CLI can print live. */
  onEvent?: (event: AgentdEvent) => void
}

export interface AgentdOptions {
  /** The AI runner for this session (mock/scripted in tests; a real adapter later). Dependency-injected. */
  brain: Brain
  /** The host bridges the code hand drives (see buildHostBridges). */
  bridges: HostBridges
  /** The autonomy level the user chose. Default 'ask'. */
  level?: AutonomyLevel
  /** Skills available to auto-inject by tab URL + message keywords. */
  skills?: EngineSkill[]
  /**
   * How an acting call is refined for the gate. The default (engine's defaultClassify) reads the latest page snapshot;
   * the daemon injects a richer one that also knows merchant history and the onboarding spending cap (for full-auto).
   */
  classify?: ActionClassifier
  /** The phone's device public key (SPKI Ed25519 PEM), registered at pairing, used to verify approvals. */
  devicePublicKeyPem?: string
  /** Time-to-live for a pending approval. Defaults to @dool2/approvals DEFAULT_TTL_MS. */
  approvalTtlMs?: number
  /**
   * Learn-by-watching (ADR 0046): records each turn's internal API calls + UI steps + login fields and folds them
   * into a review-pending local site-skill draft. Omitted (or a controller with recording off) -> no drafting.
   */
  learn?: LearnController
  /**
   * The onboarding-set spending cap (ADR 0047). A cap must exist before full-auto can be enabled; without one,
   * setLevel('full') refuses. Change it later with setSpendingCap (onboarding) or updateSpendingCap (phone-signed).
   */
  spendingCap?: SpendingCap
  /**
   * The org policy (@dool2/org), MDM-delivered. It clamps the autonomy level (an org capped at `auto` makes full-auto
   * unreachable even with consent) and contributes a spending ceiling composed as min(userCap, orgCap).
   */
  orgPolicy?: OrgPolicy
  /** Preloaded merchant memory (merchants paid before). Defaults to empty; the daemon grows it as pays run. */
  merchants?: MerchantMemory
  /**
   * The small tool-less reviewer (ADR 0030/0047). At full-auto, an "unrelated" verdict on an auto-run action becomes
   * a notification (recorded + surfaced), not a block. Omitted -> nothing is flagged. ask/auto keep card/block.
   */
  reviewer?: Reviewer
  /** Clock seam (unix ms), for the spend-period window and consent expiry. Defaults to Date.now. */
  now?: () => number
  /** Max age in ms a signed full-auto consent stays valid when verified. Omit for no expiry. */
  consentMaxAgeMs?: number
}

/** The phone-signed one-time consent that unlocks full-auto: the exact envelope the phone signed plus its signature. */
export interface FullAutoConsent {
  envelope: ConsentEnvelope
  signature: string
}

/** A phone-signed change to the spending cap: the signed cap-update envelope plus its signature. */
export interface SignedCapUpdate {
  envelope: CapUpdateEnvelope
  signature: string
}

/** The outcome of setLevel(): ok (and now at `level`), or a machine reason the change was refused (level unchanged). */
export type SetLevelResult =
  | { ok: true; level: AutonomyLevel }
  | {
      ok: false
      reason: 'org-forbids-full' | 'consent-required' | 'consent-invalid' | 'no-device-key' | 'no-cap'
      level: AutonomyLevel
    }

/** The outcome of updateSpendingCap(): ok (and now at `cap`), or a machine reason the phone-signed change was refused. */
export type CapUpdateResult =
  | { ok: true; cap: SpendingCap }
  | { ok: false; reason: 'no-device-key' | 'bad-signature' }

/** What the tool-less reviewer is shown: the user's request and the normalized facts of one acting call. */
export interface ReviewInput {
  message: string
  label: string
  tier: ActionTier
}

/** The reviewer's verdict: whether the action matches what the user asked, and (when not) a short reason. */
export interface ReviewVerdict {
  related: boolean
  reason?: string
}

/** The small tool-less reviewer. Pure and quick; it sees only the request and the action's public facts. */
export type Reviewer = (input: ReviewInput) => ReviewVerdict

/** The outcome of approve(): ok (and now consumed + recorded), or a machine reason it was rejected. */
export type ApproveResult =
  | { ok: true; envelope: ActionEnvelope }
  | { ok: false; reason: 'unknown-hash' | 'no-device-key' | 'mismatch' | ConsumeFailure['reason'] }

/**
 * The daemon service. One instance holds a session: the autonomy level, the brain, the host bridges, the device key,
 * and the pending/approved approval state. Construct it, call send() for a turn, approve() to clear a signed action.
 */
export class Agentd {
  #level: AutonomyLevel
  readonly #brain: Brain
  readonly #bridges: HostBridges
  readonly #skills: EngineSkill[]
  readonly #classify: ActionClassifier | undefined
  #devicePublicKeyPem: string | undefined
  readonly #approvalTtlMs: number | undefined
  readonly #learn: LearnController | undefined
  readonly #orgPolicy: OrgPolicy
  readonly #merchants: MerchantMemory
  readonly #reviewer: Reviewer | undefined
  readonly #now: () => number
  readonly #consentMaxAgeMs: number | undefined
  /** The spend ledger, present exactly when a spending cap is set. No ledger -> full-auto is unreachable. */
  #ledger: SpendLedger | undefined
  /** The stored, verified full-auto consent. Present only while full-auto is active via a phone signature. */
  #consent: FullAutoConsent | undefined

  readonly #store: ApprovalStore
  /** hash -> the pending approval awaiting a phone signature. Cleared on approve or when a new turn supersedes it. */
  readonly #pending = new Map<string, PendingApproval>()
  /**
   * hash -> the envelope the phone signed and the daemon consumed. The resume seam: a future send() consults this so
   * the pre-approved action is cleared through the gate instead of pausing again (see approve() for the full note).
   */
  readonly #approved = new Map<string, ActionEnvelope>()

  constructor(opts: AgentdOptions) {
    this.#brain = opts.brain
    this.#bridges = opts.bridges
    this.#level = opts.level ?? 'ask'
    this.#skills = opts.skills ?? []
    this.#classify = opts.classify
    this.#devicePublicKeyPem = opts.devicePublicKeyPem
    this.#approvalTtlMs = opts.approvalTtlMs
    this.#learn = opts.learn
    this.#orgPolicy = opts.orgPolicy ?? {}
    this.#merchants = opts.merchants ?? new MerchantMemory()
    this.#reviewer = opts.reviewer
    this.#now = opts.now ?? Date.now
    this.#consentMaxAgeMs = opts.consentMaxAgeMs
    this.#ledger = opts.spendingCap ? new SpendLedger(opts.spendingCap, this.#now()) : undefined
    // Clamp the initial level to the org maximum, so a `full` start under an `auto` org never bypasses the clamp.
    this.#level = this.#clampToOrg(opts.level ?? 'ask')
    // ApprovalStore's ttl defaults when the argument is undefined, so passing it straight through is fine.
    this.#store = new ApprovalStore(opts.approvalTtlMs)
  }

  get level(): AutonomyLevel {
    return this.#level
  }

  /** Whether full-auto is currently active. */
  get fullAutoActive(): boolean {
    return this.#level === 'full'
  }

  /** Clamp a requested level down to the org's maximum (ask < auto < full); no org cap means no clamp. */
  #clampToOrg(level: AutonomyLevel): AutonomyLevel {
    return this.#orgPolicy.maxAutonomyLevel ? clampAutonomy(level, this.#orgPolicy.maxAutonomyLevel) : level
  }

  /**
   * Change the autonomy level, enforced in code (ADR 0047). ask/auto need no consent and are clamped down to any org
   * maximum. Raising to `full` (full-auto) is the gated step: it REQUIRES a spending cap, a registered device key,
   * and a valid phone-signed one-time consent, and it is refused outright when the org caps autonomy below full.
   * On any refusal the level is left unchanged.
   */
  setLevel(level: AutonomyLevel, consent?: FullAutoConsent): SetLevelResult {
    if (level !== 'full') {
      // Leaving full-auto drops the stored consent; the stored payment PIN (vault) is cleared by the level dropping.
      this.#level = this.#clampToOrg(level)
      this.#consent = undefined
      return { ok: true, level: this.#level }
    }
    const refuse = (reason: Extract<SetLevelResult, { ok: false }>['reason']): SetLevelResult => ({
      ok: false,
      reason,
      level: this.#level,
    })
    if (this.#clampToOrg('full') !== 'full') return refuse('org-forbids-full')
    if (!this.#ledger) return refuse('no-cap')
    if (!consent) return refuse('consent-required')
    if (!this.#devicePublicKeyPem) return refuse('no-device-key')
    const verified = verifyConsent(
      consent.envelope,
      consent.signature,
      this.#devicePublicKeyPem,
      this.#consentMaxAgeMs !== undefined ? { now: this.#now(), maxAgeMs: this.#consentMaxAgeMs } : {},
    )
    if (!verified.ok) return refuse('consent-invalid')
    this.#level = 'full'
    this.#consent = consent
    return { ok: true, level: 'full' }
  }

  /** Turn full-auto off (a revoke or a device lock): the level drops to `ask` and the stored consent is cleared. */
  revokeFullAuto(): void {
    this.#level = 'ask'
    this.#consent = undefined
  }

  /** Alias for revokeFullAuto(): a device lock resets full-auto the same way. */
  lock(): void {
    this.revokeFullAuto()
  }

  /** Set the spending cap at onboarding (local, unsigned). Creates the ledger if there is none yet. */
  setSpendingCap(cap: SpendingCap): void {
    if (this.#ledger) this.#ledger.setCap(cap, this.#now())
    else this.#ledger = new SpendLedger(cap, this.#now())
  }

  /** Change the spending cap with a phone-signed update (ADR 0047). Refused without a device key or a valid signature. */
  updateSpendingCap(signed: SignedCapUpdate): CapUpdateResult {
    if (!this.#devicePublicKeyPem) return { ok: false, reason: 'no-device-key' }
    if (!verifyCapUpdate(signed.envelope, signed.signature, this.#devicePublicKeyPem)) {
      return { ok: false, reason: 'bad-signature' }
    }
    const cap: SpendingCap = { amountKrw: signed.envelope.amountKrw, period: signed.envelope.period }
    this.setSpendingCap(cap)
    return { ok: true, cap }
  }

  /** The current spend state: won spent this period, the user cap, and the effective cap = min(user, org). */
  spending(): { spentThisPeriod: number; cap?: SpendingCap; effectiveCapKrw?: number } {
    const spent = this.#ledger?.spent(this.#now()) ?? 0
    const eff = effectiveCapKrw(this.#ledger?.cap.amountKrw, this.#orgPolicy.spendingCapKrw)
    const out: { spentThisPeriod: number; cap?: SpendingCap; effectiveCapKrw?: number } = {
      spentThisPeriod: spent,
    }
    if (this.#ledger) out.cap = this.#ledger.cap
    if (eff !== undefined) out.effectiveCapKrw = eff
    return out
  }

  /** Register (or replace) the phone's device public key — done at pairing. Approvals cannot be verified without it. */
  registerDevice(publicKeyPem: string): void {
    this.#devicePublicKeyPem = publicKeyPem
  }

  /** The approval cards still awaiting a phone signature, in registration order. */
  pending(): ApprovalCard[] {
    return [...this.#pending.values()].map(toCardFromPending)
  }

  /** Whether an action with this envelope hash has been signed and consumed (the resume seam reads this). */
  isApproved(hash: string): boolean {
    return this.#approved.has(hash)
  }

  /** The review-pending site-skill drafts learned so far (empty when recording is off). The desktop reviews these. */
  drafts(): LocalDraft[] {
    return this.#learn?.store.list() ?? []
  }

  /** The self-growing library KPIs (coverage of visited sites, click-free ratio), or undefined when recording is off. */
  coverage(): CoverageStats | undefined {
    return this.#learn?.store.coverage()
  }

  /**
   * Run one turn. The engine drives the brain, the code hand, and the gate; Agentd then turns each `approvalNeeded`
   * into a signable ActionEnvelope + PendingApproval and streams every event through `onEvent`.
   */
  async send(message: string, opts: SendOptions = {}): Promise<SendResult> {
    const emit = opts.onEvent ?? (() => {})
    const level = opts.level ?? this.#level

    // The resume set for this turn: only hashes the daemon has actually verified + recorded as approved count, so a
    // client cannot pre-approve an action by passing an arbitrary hash. The engine computes the same hash for the
    // action (single source: @dool2/approvals envelopeForAction), and lets exactly those run.
    const approvedForTurn = new Set((opts.approved ?? []).filter((h) => this.#approved.has(h)))

    // The classifier that refines each acting call for the gate. A caller/constructor override wins; otherwise the
    // daemon's own classifier fills `merchantKnown` (from merchant memory) and `underCap` (from the spend ledger and
    // the effective cap) that only the daemon knows. It also stashes, per pay action, the merchant + amount keyed by
    // the exact hash the engine computes, so a pay that actually runs can be recorded against the cap afterwards.
    const payStash = new Map<string, { merchant: string; amountKrw?: number }>()
    const classify = this.#classify ?? this.#daemonClassify(opts.url, payStash)

    // Learn-by-watching (ADR 0046): start a recorder for this turn (when on). It captures the internal API calls off
    // CDP, while the acting page/vault bridges report the UI steps + login fields through the LearnController sink.
    const recorder = this.#learn ? await this.#learn.begin(message, opts.url) : undefined

    let result: TurnResult
    try {
      result = await runTurn(
        {
          brain: this.#brain,
          bridges: this.#bridges,
          skills: this.#skills,
          level,
          classify,
          ...(approvedForTurn.size > 0 ? { isApproved: (h: string) => approvedForTurn.has(h) } : {}),
        },
        { message, ...(opts.url !== undefined ? { url: opts.url } : {}) },
      )
    } catch (err) {
      // Stop the recorder on failure too, so it never leaks a subscription; a partial turn is not drafted.
      this.#learn?.end(recorder)
      throw err
    }

    // Single-use across the session: an approved action that actually ran this turn is spent.
    for (const hash of result.consumedApprovals) this.#approved.delete(hash)

    // Replay the transcript in order, so a streaming client sees text/tool calls/results as the engine recorded them.
    for (const item of result.transcript) {
      emit(toTranscriptEvent(item))
    }
    // The gate decisions (for the activity log / dashboard) and the after-the-fact notices for `notify` actions.
    for (const g of result.gateDecisions) {
      emit({
        type: 'gate',
        label: g.label,
        tier: g.tier,
        decision: g.decision,
        reason: g.reason,
        allowed: g.allowed,
        ...(g.amountKrw !== undefined ? { amountKrw: g.amountKrw } : {}),
      })
    }
    for (const text of result.notices) emit({ type: 'notice', text })

    // Record spend + grow merchant memory for pay actions that ACTUALLY ran this turn (ADR 0047): a `notify` pay at
    // full-auto, or a `sign` pay that was resumed after a phone signature (decision run, reason approved). Spend
    // counts against the cap only in full-auto; a merchant is remembered whenever a pay to it ran, at any level, so a
    // merchant paid once (even via a card) is known next time.
    const notices = [...result.notices]
    for (const g of result.gateDecisions) {
      if (g.tier !== 'pay' || !g.allowed) continue
      const ran = g.decision === 'notify' || (g.decision === 'run' && g.reason === 'approved')
      if (!ran) continue
      const env = envelopeForAction({
        tier: 'pay',
        label: g.label,
        ...(g.amountKrw !== undefined ? { amountKrw: g.amountKrw } : {}),
      })
      const stashed = payStash.get(envelopeHash(env))
      if (this.#ledger && level === 'full' && g.amountKrw !== undefined)
        this.#ledger.record(g.amountKrw, this.#now())
      if (stashed?.merchant) this.#merchants.remember(stashed.merchant)
    }

    // Reviewer-as-notification at full-auto (ADR 0047): the small reviewer judges each auto-run contact/delete/pay; an
    // "unrelated" verdict becomes a recorded notification rather than a block (ask/auto keep the card/block behavior,
    // which the gate already produces as a `review`/`sign` outcome below). The action already ran — we only notify.
    if (level === 'full' && this.#reviewer) {
      for (const g of result.gateDecisions) {
        if (!g.allowed || g.tier === 'read' || g.tier === 'act') continue
        const ran = g.decision === 'notify' || (g.decision === 'run' && g.reason === 'approved')
        if (!ran) continue
        const verdict = this.#reviewer({ message, label: g.label, tier: g.tier })
        if (verdict.related) continue
        const text = `Reviewer flagged "${g.label}" as possibly unrelated to your request${
          verdict.reason ? ` (${verdict.reason})` : ''
        }; it ran under full-auto and you are being notified.`
        notices.push(text)
        emit({ type: 'notice', text })
      }
    }

    // Turn each gated-but-not-run action into either a signable approval card or a blocked notice.
    const approvalsNeeded: ApprovalCard[] = []
    const blocked: SendResult['blocked'] = []
    for (const outcome of result.approvals) {
      if (outcome.status === 'blocked') {
        blocked.push({ label: outcome.label, tier: outcome.tier, reason: outcome.reason })
        emit({ type: 'blocked', label: outcome.label, tier: outcome.tier, reason: outcome.reason })
        continue
      }
      const card = this.#registerApproval(outcome)
      approvalsNeeded.push(card)
      emit({ type: 'approvalNeeded', card })
    }

    // Fold the turn's recording into a review-pending local draft and tell the client a draft appeared.
    const learned = this.#learn?.end(recorder)
    if (learned) {
      emit({
        type: 'draft',
        id: learned.draft.id,
        host: learned.draft.host,
        needsReview: true,
        merged: learned.merged,
        coverage: this.#learn?.store.coverage() ?? { covered: 0, total: 0, clickFreeRatio: 0 },
      })
    }

    return {
      system: result.system,
      transcript: result.transcript,
      gateDecisions: result.gateDecisions,
      notices,
      approvalsNeeded,
      blocked,
      stop: result.stop,
    }
  }

  /**
   * The daemon's own action classifier: it starts from the engine's defaultClassify (tier + amount from the page) and,
   * for a pay, adds the two facts only the daemon holds — `merchantKnown` from merchant memory and `underCap` from the
   * spend ledger against the effective cap (min of the user cap and any org ceiling). It also stashes each pay's
   * merchant + amount keyed by the exact hash the engine computes, so a pay that runs can be recorded afterwards.
   */
  #daemonClassify(
    turnUrl: string | undefined,
    payStash: Map<string, { merchant: string; amountKrw?: number }>,
  ): ActionClassifier {
    const ledger = this.#ledger
    const merchants = this.#merchants
    const orgCap = this.#orgPolicy.spendingCapKrw
    const now = this.#now
    return (action, ctx) => {
      const base = defaultClassify(action, ctx)
      if (base.tier !== 'pay') return base
      const merchant = normalizeMerchant(ctx.snapshot?.url ?? turnUrl ?? '')
      const refined: RefinedAction = { ...base }
      if (merchant) refined.merchantKnown = merchants.has(merchant)
      if (ledger && base.amountKrw !== undefined) {
        const eff = effectiveCapKrw(ledger.cap.amountKrw, orgCap)
        if (eff !== undefined) refined.underCap = !ledger.wouldExceed(base.amountKrw, eff, now())
      }
      const env = envelopeForAction({
        tier: 'pay',
        label: action.label,
        ...(base.amountKrw !== undefined ? { amountKrw: base.amountKrw } : {}),
      })
      payStash.set(envelopeHash(env), {
        merchant,
        ...(base.amountKrw !== undefined ? { amountKrw: base.amountKrw } : {}),
      })
      return refined
    }
  }

  /**
   * Verify a phone signature over a pending approval and, on success, consume it and record it as approved.
   *
   * Steps (all must hold): the hash is one we are waiting on; a device key is registered; the signature verifies for
   * this exact envelope and the envelope is unexpired and its nonce unspent (ApprovalStore.verifyAndConsume); and the
   * action the approval is for still matches the envelope (matchesApproved — here trivially, since we reconstruct the
   * executed action from the envelope's own public facts; a real resume reads them off the page about to be acted on).
   *
   * Resume seam (now wired): the engine throws inside the sandbox so a `sign` action never runs, and the turn
   * finishes with the action surfaced here. approve() verifies the signature, consumes the nonce, and records the
   * envelope in #approved by its hash. The phone→daemon→resume sequence that actually presses the button is:
   *   1. send(message)            → the gate stops a `sign` action; the turn ends with an approvalNeeded card (hash H).
   *   2. phone signs H            → approve(H, signature) verifies + consumes, and records H in #approved.
   *   3. send(message, { approved: [H] })  → the engine recomputes the same hash H for that action (single source:
   *      @dool2/approvals envelopeForAction) and, finding it approved, lets it run once. The action is then dropped
   *      from #approved (result.consumedApprovals), so the one signature clears exactly one run.
   */
  approve(hash: string, signature: string, now: number = Date.now()): ApproveResult {
    const pending = this.#pending.get(hash)
    if (!pending) return { ok: false, reason: 'unknown-hash' }
    if (!this.#devicePublicKeyPem) return { ok: false, reason: 'no-device-key' }

    // Expiry rides on the pending record's real mint time, not the envelope's canonical (zeroed) createdAt (the
    // timestamp is kept out of the hash so the engine can reproduce it on resume — see @dool2/approvals action.ts).
    const consumed = this.#store.verifyAndConsume(
      pending.envelope,
      signature,
      this.#devicePublicKeyPem,
      now,
      pending.createdAt,
    )
    if (!consumed.ok) return { ok: false, reason: consumed.reason }

    const executed: ExecutedAction = {
      tier: pending.envelope.tier,
      label: pending.envelope.label,
      ...(pending.envelope.amountKrw !== undefined ? { amountKrw: pending.envelope.amountKrw } : {}),
      ...(pending.envelope.merchant !== undefined ? { merchant: pending.envelope.merchant } : {}),
      ...(pending.envelope.recipient !== undefined ? { recipient: pending.envelope.recipient } : {}),
      ...(pending.envelope.site !== undefined ? { site: pending.envelope.site } : {}),
    }
    const match = matchesApproved(executed, pending.envelope)
    if (!match.ok) return { ok: false, reason: 'mismatch' }

    this.#pending.delete(hash)
    this.#approved.set(hash, pending.envelope)
    return { ok: true, envelope: pending.envelope }
  }

  // --- internals ----------------------------------------------------------------------------------------------------

  /**
   * Register an `approvalNeeded` outcome as a pending, signable approval. The envelope + hash come straight from the
   * engine (built with @dool2/approvals envelopeForAction), so the hash the phone signs and the hash the engine checks
   * on resume are one and the same. Freshness is minted here on the real clock; the envelope's own createdAt is the
   * canonical constant that keeps the timestamp out of the hash.
   */
  #registerApproval(outcome: ApprovalOutcome): ApprovalCard {
    const pending = pendingApproval(outcome.envelope, this.#approvalTtlMs, Date.now())
    this.#pending.set(pending.hash, pending)
    return { ...toCardFromPending(pending), reason: outcome.reason }
  }
}

function toCardFromPending(pending: PendingApproval): ApprovalCard {
  const { envelope } = pending
  return {
    hash: pending.hash,
    envelope,
    label: envelope.label,
    tier: envelope.tier,
    reason: '',
    ...(envelope.amountKrw !== undefined ? { amountKrw: envelope.amountKrw } : {}),
    expiresAt: pending.expiresAt,
  }
}

function toTranscriptEvent(item: TranscriptItem): AgentdEvent {
  switch (item.kind) {
    case 'text':
      return { type: 'text', text: item.text }
    case 'thinking':
      return { type: 'thinking', text: item.text }
    case 'tool_call':
      return { type: 'tool_call', name: item.call.name, id: item.call.id, args: item.call.args }
    case 'tool_result':
      return {
        type: 'tool_result',
        id: item.result.id,
        content: item.result.content,
        ...(item.result.isError !== undefined ? { isError: item.result.isError } : {}),
      }
    case 'notice':
      return { type: 'notice', text: item.text }
    case 'turn_end':
      return { type: 'turn_end', stop: item.stop === 'tool' ? 'done' : item.stop }
  }
}

/** Re-export the hash helper so a client can confirm the hash it signs matches the card. */
export { envelopeHash }
