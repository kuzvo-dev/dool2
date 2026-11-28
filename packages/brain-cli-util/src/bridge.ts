// The shared child-process stream bridge. Both CLI brains drive the exact same lifecycle through a thin per-CLI
// parser: spawn the official binary, write the prompt to stdin, read stdout as framed JSON lines, map each line to
// TurnEvents, and guarantee the turn ends with exactly one turn_end (handling a mid-stream exit or error).
//
// This is the only place that owns the process; the parsers are pure (lines in, TurnEvents out), so they are trivial
// to test with a fake child. No forged identity lives here: the binary and its args are passed straight through.

import type { Brain, BrainId } from '@dool2/brains'
import type { RunHandle, TurnEvent, TurnInput } from '@dool2/core'
import { defaultSpawn, which as defaultWhich } from './spawn.js'
import type { CliBrainBaseOptions, CliStreamParser, SpawnCli } from './types.js'

/** Run one turn against a CLI: spawn, feed stdin, stream stdout lines through `parser`, end with one turn_end. */
export async function* runCli(args: {
  spawn: SpawnCli
  command: string
  argv: string[]
  parser: CliStreamParser
  stdin?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}): AsyncIterable<TurnEvent> {
  const proc = args.spawn(args.command, args.argv, {
    ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
    ...(args.env ? { env: args.env } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  })
  let ended = false
  try {
    for await (const line of proc.lines) {
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        // A non-JSON line (a stray log) is skipped, like the pi brain skips a bad SSE line.
        continue
      }
      for (const ev of args.parser.push(obj)) {
        yield ev
        if (ev.kind === 'turn_end') ended = true
      }
      if (ended) break
    }
    const exit = await proc.exit
    if (!ended) {
      // The stream closed (or the process died) without a terminal event: the parser decides done vs error from the
      // exit code and what it saw. A nonzero exit or spawn error always lands as turn_end 'error'.
      for (const ev of args.parser.end(exit)) yield ev
    }
  } finally {
    // If the consumer broke early (the daemon aborted, or we stopped at a tool call), stop the child.
    proc.kill()
  }
}

function pick(opts: CliBrainBaseOptions) {
  return {
    spawn: opts.spawn ?? defaultSpawn,
    which: opts.which ?? defaultWhich,
  }
}

/** What a specific CLI brain supplies on top of the shared lifecycle. */
export interface CliBrainSpec {
  id: BrainId
  label: string
  /** The official binary name to resolve when no binPath is given, e.g. 'claude' or 'codex'. */
  binaryName: string
  /** Build the argv for one non-interactive, stream-json turn. Pure, so it is pinned by tests. */
  buildArgs(input: TurnInput, opts: CliBrainBaseOptions): string[]
  /** Build the stdin payload (the prompt / transcript) for one turn, or undefined to pass nothing on stdin. */
  buildStdin(input: TurnInput): string | undefined
  /** A fresh per-turn parser from the CLI's stream-json to TurnEvents. */
  makeParser(): CliStreamParser
  /** The official, offline-safe status command used by the default login probe, e.g. ['auth', 'status']. */
  statusArgs: string[]
  /** Decide logged-in from the status command's output. */
  parseStatus(out: string, code: number | null): boolean
}

/**
 * Build a Brain that runs an official CLI unmodified. ready() finds the binary (no paid turn) and runs the CLI's own
 * cheap status command; run() maps TurnInput to the CLI's input and streams its JSON back as TurnEvents.
 */
export function createCliBrain(spec: CliBrainSpec, opts: CliBrainBaseOptions = {}): Brain {
  const { spawn, which } = pick(opts)

  async function resolveBin(): Promise<string | undefined> {
    return opts.binPath ?? (await which(spec.binaryName))
  }

  const defaultLoginProbe = async (binPath: string): Promise<boolean> => {
    // Cheap and offline-safe: the official status command, never a paid turn. Any failure counts as not-ready.
    const proc = spawn(binPath, spec.statusArgs, {})
    let out = ''
    try {
      for await (const line of proc.lines) out += `${line}\n`
    } catch {}
    const { code, stderrTail } = await proc.exit
    return spec.parseStatus(out + stderrTail, code)
  }

  return {
    id: spec.id,
    label: spec.label,

    async ready(): Promise<boolean> {
      const bin = await resolveBin()
      if (!bin) return false
      const probe = opts.loginProbe ?? defaultLoginProbe
      try {
        return await probe(bin)
      } catch {
        return false
      }
    },

    async *run(input: TurnInput, _handle: RunHandle): AsyncIterable<TurnEvent> {
      const bin = await resolveBin()
      if (!bin) {
        yield { kind: 'turn_end', stop: 'error' }
        return
      }
      // A controller the finally aborts: if the daemon stops reading early (it called handle.abort and broke the
      // loop), this cancels the child. The bridge also kills it in its own finally.
      const controller = new AbortController()
      try {
        yield* runCli({
          spawn,
          command: bin,
          argv: spec.buildArgs(input, opts),
          parser: spec.makeParser(),
          ...(spec.buildStdin(input) !== undefined ? { stdin: spec.buildStdin(input) } : {}),
          signal: controller.signal,
        })
      } finally {
        controller.abort()
      }
    },
  }
}
