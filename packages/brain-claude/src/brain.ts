// createClaudeBrain: a Brain that runs the OFFICIAL `claude` CLI unmodified and bridges its stream into the shared
// TurnEvent shape. Dool2 spawns the binary the user installed, talks to it over its documented stream-json interface,
// and never touches its sign-in or tokens — there is no forged user agent and no client id. ready() finds the binary
// and runs the CLI's own cheap `auth status` (offline-safe, no paid turn); run() maps a TurnInput to one turn.

import { claudeMcpArgs, createCliBrain } from '@dool2/brain-cli-util'
import type { Brain } from '@dool2/brains'
import { buildClaudeArgs, buildClaudeStdin, CLAUDE_BINARY } from './args.js'
import { makeClaudeParser } from './parse.js'
import type { ClaudeBrainOptions } from './types.js'

/** Read `claude auth status` output (JSON) to decide logged-in. Any unparseable/empty output counts as not logged in. */
export function claudeLoggedIn(out: string, code: number | null): boolean {
  if (code !== 0 && code !== null) return false
  try {
    const auth = JSON.parse(out.trim() || '{}') as { loggedIn?: boolean; authMethod?: string }
    return auth.loggedIn === true && auth.authMethod !== 'none'
  } catch {
    // Older CLIs print plain text; treat an explicit "not logged in" as false, anything else as logged in.
    return !/not logged in|logged out|please run .*login/i.test(out)
  }
}

export function createClaudeBrain(opts: ClaudeBrainOptions = {}): Brain {
  return createCliBrain(
    {
      id: 'claude',
      label: 'Claude Code',
      binaryName: CLAUDE_BINARY,
      buildArgs: buildClaudeArgs,
      buildStdin: buildClaudeStdin,
      makeParser: makeClaudeParser,
      mcpArgs: claudeMcpArgs,
      statusArgs: ['auth', 'status'],
      parseStatus: claudeLoggedIn,
    },
    opts,
  )
}
