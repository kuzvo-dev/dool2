// How Dool2 runs the official `codex` CLI, unmodified, for one non-interactive turn. These are the CLI's own
// documented flags for its JSON event mode; nothing here forges identity (no env override, no user agent, no client
// id). Dool2 never handles Codex's sign-in or tokens — the binary owns that (sign in with `codex login`).
//
// `codex exec --json` runs one task non-interactively and prints its event stream as JSONL, then exits. The prompt is
// read from stdin (`-`), which is where Dool2 writes the system prompt plus the transcript. The daemon pins the Codex
// version and exposes the few @dool2/core tools through its own MCP server; the tool-call events that come back are
// mapped by parse.ts. The exact flag/event names are verified against that pinned build.

import { renderTranscript } from '@dool2/brain-cli-util'
import type { TurnInput } from '@dool2/core'
import type { CodexBrainOptions } from './types.js'

/** The binary Dool2 looks for and runs unmodified. */
export const CODEX_BINARY = 'codex'

/** The fixed, non-interactive JSON-stream flags. `--skip-git-repo-check` lets it run outside a git repo. */
export const CODEX_EXEC_FLAGS = ['exec', '--json', '--skip-git-repo-check'] as const

/** Build the argv for one turn. A pure function, pinned by tests. The trailing '-' reads the prompt from stdin. */
export function buildCodexArgs(_input: TurnInput, opts: CodexBrainOptions): string[] {
  const out: string[] = [...CODEX_EXEC_FLAGS]
  if (opts.model) out.push('--model', opts.model)
  out.push('-')
  return out
}

/** The stdin payload: the system prompt (Codex exec has no separate system flag) followed by the transcript. */
export function buildCodexStdin(input: TurnInput): string {
  const transcript = renderTranscript(input)
  return input.system ? `${input.system}\n\n${transcript}` : transcript
}
