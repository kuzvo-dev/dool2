// How Dool2 runs the official `claude` CLI, unmodified, for one non-interactive turn. These are the CLI's own
// documented flags (verified against the installed Claude Code 2.x: `claude --help`), nothing more — no environment
// override, no user agent, no client id. Dool2 never handles Claude Code's sign-in or tokens; the binary owns that.
//
// `-p` (print) runs once and exits. stream-json in/out gives a realtime NDJSON stream both ways; the transcript goes
// in on stdin as one stream-json user message, and the system prompt the daemon assembled rides on the public
// `--append-system-prompt` flag. The daemon exposes the few @dool2/core tools to Claude through its own MCP server
// (its concern, not this adapter's); whatever tool-use events come back are mapped by parse.ts.

import { renderTranscript } from '@dool2/brain-cli-util'
import type { TurnInput } from '@dool2/core'
import type { ClaudeBrainOptions } from './types.js'

/** The binary Dool2 looks for and runs unmodified. */
export const CLAUDE_BINARY = 'claude'

/** Sonnet by default: fast and capable enough. The daemon (or the user's settings) can override it. */
export const CLAUDE_DEFAULT_MODEL = 'sonnet'

/** The fixed, non-interactive stream-json flags. Kept in one place so a CLI change is a one-line edit. */
export const CLAUDE_STREAM_FLAGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
] as const

/** Build the argv for one turn. A pure function, pinned by tests. */
export function buildClaudeArgs(input: TurnInput, opts: ClaudeBrainOptions): string[] {
  const out: string[] = [...CLAUDE_STREAM_FLAGS]
  if (input.system) out.push('--append-system-prompt', input.system)
  out.push('--model', opts.model || CLAUDE_DEFAULT_MODEL)
  return out
}

/** The stdin payload: the transcript as one stream-json user message line (what `--input-format stream-json` reads). */
export function buildClaudeStdin(input: TurnInput): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: renderTranscript(input) },
  })
}
