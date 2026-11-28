// The v2 turn loop: one runnable turn that composes a brain (@dool2/brains), the few tools (@dool2/core), the code
// hand (@dool2/sandbox), the skill resolver (@dool2/skill-sdk), the vault summaries (@dool2/vault, through the
// bridge), and the autonomy gate (@dool2/core `decide`). No real browser or model here — the brain and the host
// bridges are injected, so tests pass fakes and the daemon passes the real wiring later.
//
// Shape of a turn:
//   1. Assemble the system prompt: the small base + the SKILL.md bodies the resolver matched for this tab/message.
//   2. Build one tool runtime (createToolRuntime): a sandbox whose acting calls pass the gate, exposed as a handler.
//      The handler is also offered to the brain as handle.tools, so a brain that services its own tool calls (the
//      subscription CLIs, over their MCP connection) runs them through the SAME sandbox + gate.
//   3. Run the brain for rounds. A `tool_call` the brain already serviced (serviced:true) is only recorded; one it did
//      not is run through the runtime and the result fed back. Continue until the brain ends a round without asking
//      for another tool round.
//   4. Emit a clean transcript of events + the gate decisions / approvals / notices the runtime accumulated.

import type { Brain } from '@dool2/brains'
import type { AutonomyLevel, RunHandle, ToolCall, ToolResult, TurnInput } from '@dool2/core'
import type { HostBridges, SandboxLimits } from '@dool2/sandbox'
import type { ActionClassifier } from './classify.js'
import { assembleSystemPrompt, type EngineSkill, type InjectedSkill } from './prompt.js'
import { type ApprovalOutcome, createToolRuntime, type GateDecisionLog } from './tool-runtime.js'

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
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS

  const { system, injected } = assembleSystemPrompt(
    { ...(request.url !== undefined ? { url: request.url } : {}), message: request.message },
    opts.skills ?? [],
  )

  const transcript: TranscriptItem[] = []

  const runtime = createToolRuntime({
    bridges: opts.bridges,
    ...(opts.level !== undefined ? { level: opts.level } : {}),
    ...(opts.classify !== undefined ? { classify: opts.classify } : {}),
    ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
    ...(opts.isApproved !== undefined ? { isApproved: opts.isApproved } : {}),
  })

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
        // A brain that services its own tool calls (the CLIs, over MCP) runs them through the same sandbox + gate.
        tools: runtime.handle,
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
        transcript.push({ kind: 'tool_call', call: event.call })
        if (event.serviced) {
          // The brain already ran it through handle.tools (the MCP server serviced it). Record only; do not re-run.
          continue
        }
        calledTool = true
        const result = await runtime.handle(event.call)
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
    runtime.dispose()
  }

  return {
    system,
    injectedSkills: injected,
    transcript,
    gateDecisions: runtime.gateDecisions,
    approvals: runtime.approvals,
    notices: runtime.notices,
    consumedApprovals: runtime.consumedApprovals,
    stop,
  }
}
