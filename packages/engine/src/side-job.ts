import type { AgentRuntime } from './runtime.js'

export interface SideJobInput {
  /** The question */
  text: string
  /** Instructions for the side job (they replace the agent's own where it allows) */
  systemPrompt: string
  /** A folder the agent may start in (nothing is read or written there) */
  cwd: string
  /** The small model for the role (ADR 0037). The agent's default when missing */
  model?: string
  signal?: AbortSignal
}

/**
 * One tool-less side job on any agent (the before-finishing judge, the auto-approve reviewer): asks once and returns
 * the answer text. undefined when the agent failed, hit its limit or answered nothing, so callers fail closed
 */
export async function askSideJob(rt: AgentRuntime, input: SideJobInput): Promise<string | undefined> {
  let text = ''
  try {
    for await (const ev of rt.runTurn({
      text: input.text,
      systemPrompt: input.systemPrompt,
      mcpServers: [],
      cwd: input.cwd,
      sideJob: true,
      ...(input.model ? { model: input.model } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    })) {
      if (ev.type === 'text') text += ev.delta
      if (ev.type === 'done' && !text.trim() && ev.text) text = ev.text
      if (ev.type === 'error' || ev.type === 'limit_reached') return undefined
    }
  } catch {
    return undefined
  }
  return text.trim() ? text : undefined
}
