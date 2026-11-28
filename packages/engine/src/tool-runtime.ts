// The tool handler: one object that runs a ToolCall and returns a ToolResult, through a fresh sandbox and the autonomy
// gate. It is the single place a `code` call turns into sandbox execution with every acting bridge call weighed by the
// gate (ADR 0047), and the small tools (ask/approve/task/memory) handled minimally. Both the in-process turn loop
// (engine.ts, for the API-key and scripted brains) and the MCP tool server (the subscription CLIs) call `handle` — so
// a CLI `code` call runs in the SAME sandbox and passes the SAME gate, never bypassing it. Secrets never cross it: a
// ToolResult carries only masked values and gate outcomes, never a password/card/PIN.

import { type ActionEnvelope, envelopeForAction, envelopeHash } from '@dool2/approvals'
import {
  type AutonomyLevel,
  decide,
  type GateDecision,
  type GatedAction,
  type ToolCall,
  type ToolHandler,
  type ToolResult,
} from '@dool2/core'
import {
  type HostBridges,
  type PageSnapshot,
  Sandbox,
  type SandboxLimits,
  type SandboxResult,
} from '@dool2/sandbox'
import { type ActionClassifier, defaultClassify } from './classify.js'

/** One decision the gate made while a tool ran, for the activity log / dashboard. */
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
   * equals the hash the engine checks when the action is re-run.
   */
  envelope: ActionEnvelope
  /** sha256 hex of {@link envelope}. The approval-card hash, the phone-signed value, and the resume lookup key. */
  hash: string
}

export interface ToolRuntimeOptions {
  /** The host bridges the code hand drives (fakes in tests; the real browser/vault/pc/fs in the daemon). */
  bridges: HostBridges
  /** The autonomy level the user chose. Default `ask`. */
  level?: AutonomyLevel
  /** How an acting call is refined for the gate. Default inspects the latest snapshot (see defaultClassify). */
  classify?: ActionClassifier
  /** Sandbox limits override, mostly for tests. */
  limits?: Partial<SandboxLimits>
  /**
   * The resume seam (ADR 0047): given the exact envelope hash the runtime computes for a gated `sign` action, return
   * true to let that one action run. Each approved hash is marked consumed so it is single-use within the runtime.
   */
  isApproved?: (envelopeHash: string) => boolean
}

/**
 * A tool handler bound to one sandbox + gate, plus the gate outcomes it accumulated. Build one per turn; dispose it
 * when the turn ends so its code scope does not leak. `handle` is the @dool2/core ToolHandler — pass it to the MCP
 * server for a CLI brain, or call it directly from the turn loop.
 */
export interface ToolRuntime {
  readonly handle: ToolHandler
  /** Every gate decision so far, in order. */
  readonly gateDecisions: GateDecisionLog[]
  /** Actions that need a phone signature/review, or were blocked, in order. */
  readonly approvals: ApprovalOutcome[]
  /** Short human notes for `notify` decisions. */
  readonly notices: string[]
  /** Hashes of pre-approved actions that actually ran (the resume seam fired). Single-use. */
  readonly consumedApprovals: string[]
  dispose(): void
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

/** Build the per-turn tool runtime: a sandbox whose acting calls pass the gate, exposed as a ToolHandler. */
export function createToolRuntime(opts: ToolRuntimeOptions): ToolRuntime {
  const level: AutonomyLevel = opts.level ?? 'ask'
  const classify = opts.classify ?? defaultClassify

  const gateDecisions: GateDecisionLog[] = []
  const approvals: ApprovalOutcome[] = []
  const notices: string[] = []
  const consumed = new Set<string>()

  // Remember the latest page snapshot so the classifier can read the acted node (pay button, amount, ...).
  let lastSnapshot: PageSnapshot | undefined
  const bridges = wrapBridges(opts.bridges, (s) => {
    lastSnapshot = s
  })

  // Pending approvals for the code call currently running. Reset per `code` tool call; the sandbox's onAction hook
  // pushes into it and throws, so the acting bridge call never runs.
  let pending: ApprovalOutcome[] = []

  const onAction = async (action: GatedAction): Promise<void> => {
    const refined = classify(action, { ...(lastSnapshot !== undefined ? { snapshot: lastSnapshot } : {}) })
    const ctx = {
      ...(refined.amountKrw !== undefined ? { amountKrw: refined.amountKrw } : {}),
      ...(refined.merchantKnown !== undefined ? { merchantKnown: refined.merchantKnown } : {}),
      ...(refined.underCap !== undefined ? { underCap: refined.underCap } : {}),
    }
    const { decision, reason } = decide(level, refined.tier, ctx)
    const amount = refined.amountKrw !== undefined ? { amountKrw: refined.amountKrw } : {}

    const envelope = envelopeForAction({ tier: refined.tier, label: action.label, ...amount })
    const hash = envelopeHash(envelope)

    // Resume seam: a `sign` the user already signed for runs once.
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
    // Throw so the acting bridge call does not run. The code snippet sees a rejection; the handler turns the pending
    // outcome into a readable tool result (never "stop" — a safety order is the one allowed exception).
    throw new GateStopError(outcome)
  }

  const sandbox = new Sandbox({
    bridges,
    onAction,
    ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
  })

  const handle: ToolHandler = async (call) => {
    switch (call.name) {
      case 'code':
        return runCode(call)
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

  async function runCode(call: ToolCall): Promise<ToolResult> {
    const source = fieldOf(call.args, 'code')
    if (source === undefined) {
      return { id: call.id, content: 'code tool needs a { code: string } argument.', isError: true }
    }
    pending = []
    const result = await sandbox.run(source)
    if (pending.length > 0) {
      return { id: call.id, content: describeApprovals(pending) }
    }
    return { id: call.id, ...formatSandboxResult(result) }
  }

  return {
    handle,
    gateDecisions,
    approvals,
    notices,
    get consumedApprovals(): string[] {
      return [...consumed]
    },
    dispose(): void {
      sandbox.dispose()
    },
  }
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

/** Wrap the host bridges so the runtime can observe page snapshots (for gate refinement). */
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
