// The v2 turn loop: one runnable turn that composes a brain (@dool2/brains), the few tools (@dool2/core), the code
// hand (@dool2/sandbox), the skill resolver (@dool2/skill-sdk), the vault summaries (@dool2/vault, through the
// bridge), and the autonomy gate (@dool2/core `decide`). No real browser or model here — the brain and the host
// bridges are injected, so tests pass fakes and the daemon passes the real wiring later.
//
// Shape of a turn:
//   1. Assemble the system prompt: the small base + the SKILL.md bodies the resolver matched for this tab/message.
//   2. Run the brain for one round. On a `tool_call`:
//        - `code`: run it in a Sandbox whose acting bridge calls pass through the gate. If the gate allows (`run`
//          or `notify`) the action runs; on `notify` a notice is recorded. If it needs a signature or is blocked
//          (`sign`/`review`/`block`), the engine throws inside the bridge so the action never runs, and surfaces a
//          structured approvalNeeded/blocked outcome the daemon turns into a phone card. No phone signing here.
//        - `ask`/`approve`/`task`/`memory`: handled minimally (echo/record); real impls later.
//      Feed the ToolResult back through the RunHandle and continue until the brain ends a round without a tool call.
//   3. Emit a clean transcript of events + the list of gate decisions (for the activity log / dashboard).

import { type ActionEnvelope, envelopeForAction, envelopeHash } from '@dool2/approvals'
import type { Brain } from '@dool2/brains'
import {
  type AutonomyLevel,
  decide,
  type GateDecision,
  type GatedAction,
  type RunHandle,
  type ToolCall,
  type ToolResult,
  type TurnInput,
} from '@dool2/core'
import {
  type HostBridges,
  type PageSnapshot,
  Sandbox,
  type SandboxLimits,
  type SandboxResult,
} from '@dool2/sandbox'
import { type ActionClassifier, defaultClassify } from './classify.js'
import { assembleSystemPrompt, type EngineSkill, type InjectedSkill } from './prompt.js'

/** What the user brought into the turn: a message and (optionally) the URL of the active tab. */
export interface TurnRequest {
  message: string
  url?: string
}

/** Everything the engine needs to run a turn. Dependency-injected so tests pass fakes and the daemon passes reality. */
export interface EngineOptions {
  /** The AI runner for this turn (start with mockBrain; real adapters later). */
  brain: Brain
  /** The host bridges the code hand drives (fakes in tests; the real browser/vault/pc/fs in the daemon). */
  bridges: HostBridges
  /** The skills available to auto-inject by tab URL + message keywords. */
  skills?: EngineSkill[]
  /** The autonomy level the user chose. Default `ask`. */
  level?: AutonomyLevel
  /** How an acting call is refined for the gate. Default inspects the latest snapshot (see defaultClassify). */
  classify?: ActionClassifier
  /** Sandbox limits override, mostly for tests. */
  limits?: Partial<SandboxLimits>
  /** Safety cap on brain rounds in a turn, so a loop cannot spin forever. Default 16. */
  maxRounds?: number
  /**
   * The resume seam (ADR 0047): whether an action the gate wants a phone signature for has already been signed. Given
   * the exact envelope hash the engine computes for a gated `sign` action (via @dool2/approvals envelopeForAction +
   * envelopeHash — the SAME builder agentd mints the approval card from), return true to let that one action run. The
   * engine marks each approved hash consumed so it is single-use within the turn. Omitted → nothing is pre-approved and
   * every `sign` pauses as before.
   */
  isApproved?: (envelopeHash: string) => boolean
}

/** One entry in the turn transcript: the brain's events, the tool results, and gate notices, in order. */
export type TranscriptItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; call: ToolCall }
  | { kind: 'tool_result'; result: ToolResult }
  | { kind: 'notice'; text: string }
  | { kind: 'turn_end'; stop: 'done' | 'tool' | 'error' | 'aborted' }

/** One decision the gate made while the turn ran, for the activity log / dashboard. */
export interface GateDecisionLog {
  /** The human label from the acting call (button text, "Pay 50,000 won"). */
  label: string
  tier: GatedAction['tier']
  decision: GateDecision
  reason: string
  /** Whether the action was allowed to run (true for `run`/`notify`). */
  allowed: boolean
  amountKrw?: number
}

/** A gated action that did not run: it needs a phone signature/review, or it was blocked over a hard cap. */
export interface ApprovalOutcome {
  status: 'approvalNeeded' | 'blocked'
  label: string
  tier: GatedAction['tier']
  decision: GateDecision
  reason: string
  amountKrw?: number
  /**
   * The canonical envelope this action binds to, built by @dool2/approvals envelopeForAction — the single source of
   * truth for the hash. The daemon registers THIS exact envelope as the approval card, so the hash the phone signs
   * equals the hash the engine checks when the action is re-run (see EngineOptions.isApproved).
   */
  envelope: ActionEnvelope
  /** sha256 hex of {@link envelope}. The approval-card hash, the phone-signed value, and the resume lookup key. */
  hash: string
}

/** The result of one turn. */
export interface TurnResult {
  /** The assembled system prompt for the turn (base + matched skill bodies). */
  system: string
  /** The skills injected into the prompt, strongest match first. */
  injectedSkills: InjectedSkill[]
  /** The brain events, tool results, and notices in order. Secrets never appear here. */
  transcript: TranscriptItem[]
  /** Every gate decision, for the activity log. */
  gateDecisions: GateDecisionLog[]
  /** Actions that need a phone signature/review, or were blocked. The daemon turns these into phone cards. */
  approvals: ApprovalOutcome[]
  /** Short human notes for `notify` decisions ("done: ...") the daemon shows the user after the fact. */
  notices: string[]
  /**
   * The hashes of pre-approved actions that actually ran this turn (the resume seam fired). The daemon drops these
   * from its approved set afterwards, so a signature clears exactly one run of the action across the whole session.
   */
  consumedApprovals: string[]
  /** How the turn ended. */
  stop: 'done' | 'error' | 'aborted'
}

const DEFAULT_MAX_ROUNDS = 16

/**
 * The engine: hold the wiring (brain, bridges, skills, level, classifier) and run turns against it. Each turn gets
 * a fresh sandbox session so its code scope does not leak into the next turn.
 */
export class Engine {
  readonly #opts: EngineOptions

  constructor(opts: EngineOptions) {
    this.#opts = opts
  }

  runTurn(request: TurnRequest): Promise<TurnResult> {
    return runTurn(this.#opts, request)
  }
}

/** Run a single turn. See the module header for the shape. */
export async function runTurn(opts: EngineOptions, request: TurnRequest): Promise<TurnResult> {
  const level: AutonomyLevel = opts.level ?? 'ask'
  const classify = opts.classify ?? defaultClassify
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS

  const { system, injected } = assembleSystemPrompt(
    { ...(request.url !== undefined ? { url: request.url } : {}), message: request.message },
    opts.skills ?? [],
  )

  const transcript: TranscriptItem[] = []
  const gateDecisions: GateDecisionLog[] = []
  const approvals: ApprovalOutcome[] = []
  const notices: string[] = []

  // Remember the latest page snapshot so the classifier can read the acted node (pay button, amount, ...).
  let lastSnapshot: PageSnapshot | undefined
  const bridges = wrapBridges(opts.bridges, (s) => {
    lastSnapshot = s
  })

  // Pending approvals for the code call currently running. Reset per `code` tool call; the sandbox's onAction hook
  // (below) pushes into it and throws, so the acting bridge call never runs.
  let pending: ApprovalOutcome[] = []
  // Approved-action hashes that fired this turn, so they are single-use (within the turn, and the daemon drops them
  // from its session set afterwards).
  const consumed = new Set<string>()

  const onAction = async (action: GatedAction): Promise<void> => {
    const refined = classify(action, { ...(lastSnapshot !== undefined ? { snapshot: lastSnapshot } : {}) })
    const ctx = {
      ...(refined.amountKrw !== undefined ? { amountKrw: refined.amountKrw } : {}),
      ...(refined.merchantKnown !== undefined ? { merchantKnown: refined.merchantKnown } : {}),
      ...(refined.underCap !== undefined ? { underCap: refined.underCap } : {}),
    }
    const { decision, reason } = decide(level, refined.tier, ctx)
    const amount = refined.amountKrw !== undefined ? { amountKrw: refined.amountKrw } : {}

    // The envelope + hash for this exact action, from the one shared builder. Used both to recognise a pre-approved
    // action (resume) and to hand the daemon the exact envelope to turn into a phone card.
    const envelope = envelopeForAction({ tier: refined.tier, label: action.label, ...amount })
    const hash = envelopeHash(envelope)

    // Resume seam: a `sign` the user already signed for runs once. The hash the daemon approved is byte-for-byte this
    // hash, because both sides build the envelope with envelopeForAction.
    if (decision === 'sign' && opts.isApproved?.(hash) === true && !consumed.has(hash)) {
      consumed.add(hash)
      gateDecisions.push({
        label: action.label,
        tier: refined.tier,
        decision: 'run',
        reason: 'approved',
        allowed: true,
        ...amount,
      })
      return
    }

    const allowed = decision === 'run' || decision === 'notify'
    gateDecisions.push({ label: action.label, tier: refined.tier, decision, reason, allowed, ...amount })
    if (decision === 'notify') notices.push(`done: ${action.label} (${reason})`)
    if (allowed) return
    const outcome: ApprovalOutcome = {
      status: decision === 'block' ? 'blocked' : 'approvalNeeded',
      label: action.label,
      tier: refined.tier,
      decision,
      reason,
      envelope,
      hash,
      ...amount,
    }
    pending.push(outcome)
    approvals.push(outcome)
    // Throw so the acting bridge call does not run. The code snippet sees a rejection; the engine turns the pending
    // outcome into a readable tool result below (never "stop" — a safety order is the one allowed exception).
    throw new GateStopError(outcome)
  }

  const sandbox = new Sandbox({
    bridges,
    onAction,
    ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
  })

  // The brain may want tool results fed back via the RunHandle (streaming adapters) or may end a round with
  // stop:'tool' and expect a fresh round (the mock). We support both: results go onto `messages` and are delivered
  // through the handle, and a round that ends on a pending tool call re-invokes the brain.
  const messages: TurnInput['messages'] = [{ role: 'user', content: request.message }]
  let stop: TurnResult['stop'] = 'done'

  try {
    for (let round = 0; round < maxRounds; round++) {
      const input: TurnInput = { system, messages }
      let aborted = false
      const handle: RunHandle = {
        toolResult() {
          // Results are also appended to `messages` by the loop below; this is the streaming seam for real adapters.
        },
        steer(text: string) {
          messages.push({ role: 'user', content: text })
        },
        abort() {
          aborted = true
        },
      }

      let calledTool = false
      let roundStop: 'done' | 'tool' | 'error' | 'aborted' = 'done'

      for await (const event of opts.brain.run(input, handle)) {
        if (event.kind === 'text' || event.kind === 'thinking') {
          transcript.push({ kind: event.kind, text: event.text })
          if (event.kind === 'text' && event.text) messages.push({ role: 'assistant', content: event.text })
          continue
        }
        if (event.kind === 'turn_end') {
          roundStop = event.stop
          transcript.push({ kind: 'turn_end', stop: event.stop })
          continue
        }
        // tool_call
        calledTool = true
        transcript.push({ kind: 'tool_call', call: event.call })
        const result = await runTool(event.call, {
          sandbox,
          resetPending: () => (pending = []),
          getPending: () => pending,
        })
        handle.toolResult(result)
        transcript.push({ kind: 'tool_result', result })
        messages.push({ role: 'tool', content: result.content })
      }

      if (aborted || roundStop === 'aborted') {
        stop = 'aborted'
        break
      }
      if (roundStop === 'error') {
        stop = 'error'
        break
      }
      // Continue only if this round called a tool and asked for another round; otherwise the turn is done.
      if (!calledTool || roundStop !== 'tool') {
        stop = 'done'
        break
      }
    }
  } finally {
    sandbox.dispose()
  }

  return {
    system,
    injectedSkills: injected,
    transcript,
    gateDecisions,
    approvals,
    notices,
    consumedApprovals: [...consumed],
    stop,
  }
}

// --- tools ---------------------------------------------------------------------------------------------------------

interface ToolDeps {
  sandbox: Sandbox
  resetPending: () => void
  getPending: () => ApprovalOutcome[]
}

async function runTool(call: ToolCall, deps: ToolDeps): Promise<ToolResult> {
  switch (call.name) {
    case 'code':
      return runCode(call, deps)
    case 'ask':
      return {
        id: call.id,
        content: `Asked the user: ${fieldOf(call.args, 'question') ?? stringify(call.args)}`,
      }
    case 'approve':
      return {
        id: call.id,
        content: `Requested a phone signature for: ${fieldOf(call.args, 'label') ?? stringify(call.args)}`,
      }
    case 'task':
      return { id: call.id, content: `Noted task: ${fieldOf(call.args, 'title') ?? stringify(call.args)}` }
    case 'memory':
      return { id: call.id, content: `Memory op recorded: ${stringify(call.args)}` }
    default:
      return { id: call.id, content: `Unknown tool: ${String(call.name)}`, isError: true }
  }
}

async function runCode(call: ToolCall, deps: ToolDeps): Promise<ToolResult> {
  const source = fieldOf(call.args, 'code')
  if (source === undefined) {
    return { id: call.id, content: 'code tool needs a { code: string } argument.', isError: true }
  }
  deps.resetPending()
  const result = await deps.sandbox.run(source)
  const pending = deps.getPending()
  if (pending.length > 0) {
    return { id: call.id, content: describeApprovals(pending) }
  }
  return { id: call.id, ...formatSandboxResult(result) }
}

function describeApprovals(pending: ApprovalOutcome[]): string {
  return pending
    .map((a) => {
      const amount = a.amountKrw !== undefined ? ` (${a.amountKrw.toLocaleString('en-US')} KRW)` : ''
      if (a.status === 'blocked') {
        return `Blocked: "${a.label}"${amount} is over a hard limit (${a.reason}).`
      }
      return `Needs the user's approval on their phone: "${a.label}"${amount} [${a.reason}]. It did not run; once signed it can proceed.`
    })
    .join('\n')
}

function formatSandboxResult(result: SandboxResult): { content: string; isError?: boolean } {
  if (!result.ok) return { content: `Error: ${result.error ?? 'unknown error'}`, isError: true }
  const parts: string[] = []
  if (result.printed.length > 0) parts.push(result.printed.join('\n'))
  if (result.value !== undefined) {
    parts.push(typeof result.value === 'string' ? result.value : stringify(result.value))
  }
  if (result.images.length > 0) parts.push(`[${result.images.length} image reference(s)]`)
  return { content: parts.length > 0 ? parts.join('\n') : '(no output)' }
}

// --- helpers -------------------------------------------------------------------------------------------------------

/** Wrap the host bridges so the engine can observe page snapshots (for gate refinement) without touching the daemon. */
function wrapBridges(bridges: HostBridges, onSnapshot: (s: PageSnapshot) => void): HostBridges {
  return {
    ...bridges,
    page: {
      ...bridges.page,
      async snapshot(): Promise<PageSnapshot> {
        const snapshot = await bridges.page.snapshot()
        onSnapshot(snapshot)
        return snapshot
      },
    },
  }
}

function fieldOf(args: unknown, key: string): string | undefined {
  if (args && typeof args === 'object' && key in args) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string') return value
    if (value !== undefined) return stringify(value)
  }
  return undefined
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Thrown inside the sandbox onAction hook to stop an action the gate did not clear. Carries the outcome. */
export class GateStopError extends Error {
  readonly outcome: ApprovalOutcome
  constructor(outcome: ApprovalOutcome) {
    super(`gate ${outcome.decision}: ${outcome.label}`)
    this.name = 'GateStopError'
    this.outcome = outcome
  }
}
