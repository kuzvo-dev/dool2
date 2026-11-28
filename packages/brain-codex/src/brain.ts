// createCodexBrain: a Brain that runs the OFFICIAL `codex` CLI unmodified and bridges its stream into the shared
// TurnEvent shape. Dool2 spawns the binary the user installed, talks to it over its documented `exec --json`
// interface, and never touches its sign-in or tokens — there is no forged user agent and no client id. ready() finds
// the binary and runs the CLI's own cheap `login status` (offline-safe, no paid turn); run() maps a TurnInput to one
// turn. Same shared lifecycle as @dool2/brain-claude (see @dool2/brain-cli-util).

import { codexMcpArgs, createCliBrain } from '@dool2/brain-cli-util'
import type { Brain } from '@dool2/brains'
import { buildCodexArgs, buildCodexStdin, CODEX_BINARY } from './args.js'
import { makeCodexParser } from './parse.js'
import type { CodexBrainOptions } from './types.js'

/** Read `codex login status` output to decide logged-in: a clean exit with no "not logged in" line. */
export function codexLoggedIn(out: string, code: number | null): boolean {
  if (code !== 0 && code !== null) return false
  return !/not logged in|logged out|please run .*login/i.test(out)
}

export function createCodexBrain(opts: CodexBrainOptions = {}): Brain {
  return createCliBrain(
    {
      id: 'codex',
      label: 'Codex',
      binaryName: CODEX_BINARY,
      buildArgs: buildCodexArgs,
      buildStdin: buildCodexStdin,
      makeParser: makeCodexParser,
      mcpArgs: codexMcpArgs,
      statusArgs: ['login', 'status'],
      parseStatus: codexLoggedIn,
    },
    opts,
  )
}
