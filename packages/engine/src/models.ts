import type { AgentId } from '@dool2/protocol'

/**
 * Model profiles and role routing (ADR 0035).
 *
 * One table, keyed by agent and model, holds what differs per model: when a segment is long enough to switch
 * (ADR 0015), which small model side jobs use, and a slot for an instruction variant. Entries are added only once a
 * model is seen to need different values; until then every model reads the defaults.
 */

/** Segment limits that depend on the model (the idle limit does not: it is about the person, not the model) */
export interface SegmentLimits {
  /** Number of user turns */
  turns: number
  /** Stored characters */
  chars: number
  /** Tokens the AI read on its last turn */
  contextTokens: number
}

export interface ModelProfile {
  limits: SegmentLimits
  /**
   * The small model for side jobs that read short text and answer briefly (the before-finishing judge, a quick check's
   * "did the condition change"). undefined: the agent cannot pick a model per call, so side jobs use the task model
   */
  small?: string
  /** Instruction variant for this model (none yet: every model gets the same instructions) */
  instructions?: string
}

/** What a model call is for */
export type ModelRole =
  /** The user's request: always the model the user chose */
  | 'task'
  /** Segment handoff summary. Resumes the session right after a turn, while its cache is warm */
  | 'summary'
  /** The before-finishing check (ADR 0027): reads the request, the answer and a few facts, answers one line of JSON */
  | 'judge'
  /** A quick check found a change and wakes Dool2 to judge it against the user's condition (ADR 0031) */
  | 'watch'

const BASE: ModelProfile = {
  limits: { turns: 40, chars: 60_000, contextTokens: 120_000 },
}

/**
 * Profiles by `agent` or `agent:model` (the more specific key wins, field by field). Only what is known to differ:
 * - Claude Code takes a model per run (`--model`), so side jobs can use its small model.
 * - Codex and OpenCode run the model the user set up in that program or picked with the key; Dool2 does not pass a
 *   model per call to them, so their side jobs stay on that model.
 */
export const MODEL_PROFILES: Partial<Record<string, Partial<ModelProfile>>> = {
  claude: { small: 'haiku' },
}

/** The profile for an agent and model (model undefined: the agent's default model) */
export function modelProfile(agent: AgentId, model?: string): ModelProfile {
  const byAgent = MODEL_PROFILES[agent] ?? {}
  const byModel = (model && MODEL_PROFILES[`${agent}:${model}`]) || {}
  return {
    ...BASE,
    ...byAgent,
    ...byModel,
    limits: { ...BASE.limits, ...byAgent.limits, ...byModel.limits },
  }
}

/**
 * The model to pass for a role. `chosen` is the model the user picked (undefined: the agent's default).
 * - task: the chosen model.
 * - summary: the chosen model too. The summary resumes the session just after a turn, so the provider's cache of the
 *   whole conversation is still warm; a different model has no cache and would read it all again at full price.
 * - judge, watch: the profile's small model, or the chosen model when the agent has none.
 */
export function modelForRole(agent: AgentId, role: ModelRole, chosen?: string): string | undefined {
  if (role === 'task' || role === 'summary') return chosen
  return modelProfile(agent, chosen).small ?? chosen
}
