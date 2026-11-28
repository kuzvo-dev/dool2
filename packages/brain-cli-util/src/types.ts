// Shared shapes for the subscription-CLI brains (@dool2/brain-claude, @dool2/brain-codex). Both adapters spawn the
// official CLI as a child process and talk to it over its own documented stream-json interface. Nothing here forges
// identity: there is no user-agent override and no client id — the official binary runs unmodified and owns its auth.

import type { TurnEvent } from '@dool2/core'
import type { McpConnector } from './mcp.js'

/** A spawned CLI child, reduced to what the bridge needs: its stdout lines and its exit. Injected in tests. */
export interface CliProcess {
  /** stdout read as NDJSON: one trimmed, non-empty line at a time. One reader for the whole run. */
  lines: AsyncIterable<string>
  /** Resolves when the child ends, with the exit code and the tail of stderr (never the prompt or any token). */
  exit: Promise<CliExit>
  /** Stop the child (called when the consumer breaks early, e.g. the daemon aborted the run). */
  kill(): void
}

export interface CliExit {
  code: number | null
  stderrTail: string
}

/** How to start the CLI. The default (spawn.ts) uses node:child_process; tests pass a fake that scripts the stream. */
export type SpawnCli = (
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; stdin?: string; signal?: AbortSignal },
) => CliProcess

/** Finds a binary on disk without running it (offline-safe). The default (spawn.ts) searches PATH + install dirs. */
export type WhichFn = (name: string) => Promise<string | undefined>

/**
 * A per-CLI translator from the child's stream-json lines to the shared TurnEvent shape. Each adapter implements one.
 * `push` maps one already-parsed JSON line to zero or more events; `end` closes the stream with exactly one turn_end
 * when `push` did not already emit one (e.g. the child exited or errored mid-stream).
 */
export interface CliStreamParser {
  push(line: unknown): TurnEvent[]
  end(exit: CliExit): TurnEvent[]
}

/** Options for a fresh parser. */
export interface MakeParserOptions {
  /**
   * The CLI is driving its own tool calls over an attached MCP server. When true, a tool-use event is emitted as a
   * `tool_call` marked `serviced` (the MCP server already ran it) and does NOT end the turn — the CLI continues in the
   * same run and the turn ends at its own terminal event. When false (no MCP), a tool-use ends the turn so the engine
   * can run the tool and re-invoke (the legacy path).
   */
  toolsViaMcp?: boolean
}

/** Options common to both CLI brains. `spawn`/`which` are injected so tests never touch a real CLI. */
export interface CliBrainBaseOptions {
  /** Absolute path or bare name of the official binary. Defaults to the brain's binary name (resolved via `which`). */
  binPath?: string
  /** Model id passed through to the CLI unchanged (e.g. 'sonnet'). The daemon decides it. */
  model?: string
  /** Injected process spawner; defaults to the real one. */
  spawn?: SpawnCli
  /** Injected binary finder; defaults to the real one. */
  which?: WhichFn
  /**
   * Cheap, offline-safe sign-in probe used by ready(). Receives the resolved binary path and returns whether the CLI
   * is logged in. Defaults to the brain's own official status command (no paid turn). Tests inject a stub.
   */
  loginProbe?: (binPath: string) => Promise<boolean>
  /**
   * How to attach the MCP tool server so the CLI can call Dool2's tools. Used only when the run is given a tool
   * handler (RunHandle.tools, set by the engine). Defaults to the real socket-backed connector; tests inject one over
   * an in-memory transport. Set to `false` to disable MCP even when a handler is present (the legacy end-turn path).
   */
  mcpConnector?: McpConnector | false
}
