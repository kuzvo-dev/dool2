#!/usr/bin/env node
// The agentd CLI. Two commands:
//
//   agentd say "<message>" [--url <tabUrl>] [--level ask|auto|full]
//       Start the service in-process, run one turn against a built-in demo brain, print every event, and exit. Runnable
//       from the terminal with no real model or browser — a smoke for the whole engine+gate+approvals spine. The demo
//       brain reads the open page with the `code` hand (page.snapshot); with the built-in browser off (the default) the
//       page bridge is a fake, so this works offline.
//
//   agentd serve [--port <n>]
//       Start the local HTTP API and keep running. Prints the base URL and the bearer token to use.
//
// A real brain (Claude Code / Codex / the pi fork) is selected by config/env (chooseBrain, brain-config.ts): set
// DOOL2_BRAIN=claude|codex|pi (+ DOOL2_API_KEY for pi, or have the CLI signed in). With nothing set it falls back to
// the scripted demo brain, so the offline smoke keeps working. Set DOOL2_BUILTIN_BROWSER=1 to drive Dool2's own
// hidden Chromium instead of the fake page.

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SkillMeta } from '@dool2/skill-sdk'
import { loadBuiltinSkillMetas } from '@dool2/skills'
import { Agentd, type AgentdEvent } from './agentd.js'
import { brainConfigFromEnv, chooseBrain } from './brain-config.js'
import { buildHostBridges } from './bridges.js'
import { startHttpServer } from './http.js'

interface Args {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? ''
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(token)
    }
  }
  return { command, positional, flags }
}

function builtinBrowserOn(): boolean {
  const v = process.env.DOOL2_BUILTIN_BROWSER
  return v === '1' || v === 'true'
}

function dataDir(): string {
  return process.env.DOOL2_DATA_DIR ?? join(homedir(), '.dool2')
}

function makeAgentd(
  level: 'ask' | 'auto' | 'full',
  url?: string,
): { agentd: Agentd; close: () => Promise<void>; brainLabel: string } {
  // Pick the brain from config/env (default: the scripted demo brain). Build it BEFORE the bridges so a bad config
  // (e.g. DOOL2_BRAIN=pi with no key) fails fast without opening a browser. The demo brain opens `url` first only
  // when the built-in browser is on; a real brain decides for itself.
  const config = brainConfigFromEnv()
  const demoUrl = builtinBrowserOn() ? url : undefined
  const brain = chooseBrain(config, { ...(demoUrl !== undefined ? { demoUrl } : {}) })
  // Load the built-in site-skill pack once; the vault reads each skill's `login` hints to find the right login fields
  // (Korean names included) on the matched site. Done once at startup; a getter hands the frozen list to the vault.
  const skills: readonly SkillMeta[] = loadBuiltinSkillMetas()
  const built = buildHostBridges({
    builtinBrowser: builtinBrowserOn(),
    dataDir: dataDir(),
    skills: () => skills,
  })
  const agentd = new Agentd({ brain, bridges: built.bridges, level })
  return { agentd, close: built.close, brainLabel: brain.label }
}

function printEvent(event: AgentdEvent): void {
  switch (event.type) {
    case 'text':
      console.log(`  ${event.text}`)
      break
    case 'thinking':
      console.log(`  (thinking) ${event.text}`)
      break
    case 'tool_call':
      console.log(`  -> ${event.name}(${JSON.stringify(event.args)})`)
      break
    case 'tool_result':
      console.log(`  <- ${event.isError ? '[error] ' : ''}${event.content}`)
      break
    case 'notice':
      console.log(`  [notice] ${event.text}`)
      break
    case 'gate':
      console.log(`  [gate] ${event.decision} ${event.tier} "${event.label}" (${event.reason})`)
      break
    case 'approvalNeeded':
      console.log(
        `  [approval needed] "${event.card.label}" ${event.card.amountKrw ?? ''} hash=${event.card.hash.slice(0, 12)}…`,
      )
      break
    case 'blocked':
      console.log(`  [blocked] "${event.label}" (${event.reason})`)
      break
    case 'turn_end':
      console.log(`  [turn end: ${event.stop}]`)
      break
  }
}

async function cmdSay(args: Args): Promise<number> {
  const message = args.positional.join(' ').trim()
  if (!message) {
    console.error('usage: agentd say "<message>" [--url <tabUrl>] [--level ask|auto|full]')
    return 2
  }
  const level = normalizeLevel(args.flags.level)
  const url = typeof args.flags.url === 'string' ? args.flags.url : undefined

  const { agentd, close, brainLabel } = makeAgentd(level, url)
  console.log(
    `agentd say  brain=${brainLabel}  level=${level}${url ? `  url=${url}` : ''}  browser=${builtinBrowserOn() ? 'built-in' : 'fake'}`,
  )
  console.log(`you: ${message}`)
  console.log('events:')
  try {
    const result = await agentd.send(message, { ...(url !== undefined ? { url } : {}), onEvent: printEvent })
    console.log('---')
    console.log(
      `stop=${result.stop}  gate decisions=${result.gateDecisions.length}  approvals=${result.approvalsNeeded.length}  blocked=${result.blocked.length}`,
    )
    return 0
  } finally {
    await close()
  }
}

async function cmdServe(args: Args): Promise<number> {
  const level = normalizeLevel(args.flags.level)
  const port = typeof args.flags.port === 'string' ? Number(args.flags.port) : 0
  const token = process.env.DOOL2_AGENTD_TOKEN ?? randomBytes(24).toString('hex')

  const { agentd, close, brainLabel } = makeAgentd(level)
  agentd.setLevel(level)
  const http = await startHttpServer({ agentd, token, port, log: (l) => console.log(`[agentd] ${l}`) })
  console.log(`agentd serving at ${http.url}  brain=${brainLabel}`)
  console.log(`token: ${token}`)
  console.log('POST /message  POST /approve  GET /pending  GET /health')

  const stop = async (): Promise<void> => {
    await http.close()
    await close()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
  return new Promise<number>(() => {}) // run until signalled
}

function normalizeLevel(v: string | boolean | undefined): 'ask' | 'auto' | 'full' {
  if (v === 'auto' || v === 'full') return v
  return 'ask'
}

function help(): void {
  console.log(`agentd — the Dool2 v2 daemon

  agentd say "<message>" [--url <tabUrl>] [--level ask|auto|full]
      Run one turn and print the events. Uses the demo brain offline; set DOOL2_BRAIN for a real one.

  agentd serve [--port <n>] [--level ask|auto|full]
      Start the local HTTP API (127.0.0.1, bearer token) and keep running.

Brain: DOOL2_BRAIN=claude|codex|pi (default: demo). pi needs DOOL2_API_KEY; claude/codex use their installed,
       signed-in CLI. DOOL2_MODEL, DOOL2_BRAIN_BASEURL, DOOL2_BRAIN_PROVIDER (anthropic|openai) tune it.
Env:   DOOL2_BUILTIN_BROWSER=1 drives Dool2's own hidden Chromium; DOOL2_DATA_DIR sets the data folder;
       DOOL2_AGENTD_TOKEN pins the serve token.`)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case 'say':
      return cmdSay(args)
    case 'serve':
      return cmdServe(args)
    default:
      help()
      return 0
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  },
)
