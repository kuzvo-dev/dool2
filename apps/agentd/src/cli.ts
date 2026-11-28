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
// A real brain (Claude Code / Codex / the pi fork) is not wired yet; `say` uses a scripted demo brain so the daemon is
// runnable today. Set DOOL2_BUILTIN_BROWSER=1 to drive Dool2's own hidden Chromium instead of the fake page.

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Brain } from '@dool2/brains'
import type { TurnEvent } from '@dool2/core'
import { scriptedBrain } from '@dool2/engine'
import { Agentd, type AgentdEvent } from './agentd.js'
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

/** A scripted demo brain: look at the page with the code hand, read the snapshot back, then finish. */
function demoBrain(url?: string): Brain {
  // With the built-in browser, nothing is open yet, so open the page first; with the fake page, snapshot works as is.
  const code = url
    ? `(async () => { await page.goto(${JSON.stringify(url)}); return JSON.stringify(await page.snapshot()) })()`
    : 'JSON.stringify(await page.snapshot())'
  const rounds: TurnEvent[][] = [
    [
      { kind: 'text', text: 'Let me look at the open page.' },
      {
        kind: 'tool_call',
        call: { id: 'c1', name: 'code', args: { code } },
      },
      { kind: 'turn_end', stop: 'tool' },
    ],
    [
      { kind: 'text', text: 'That is what the page shows right now.' },
      { kind: 'turn_end', stop: 'done' },
    ],
  ]
  return scriptedBrain(rounds)
}

function makeAgentd(
  level: 'ask' | 'auto' | 'full',
  url?: string,
): { agentd: Agentd; close: () => Promise<void> } {
  const built = buildHostBridges({ builtinBrowser: builtinBrowserOn(), dataDir: dataDir() })
  const agentd = new Agentd({
    brain: demoBrain(builtinBrowserOn() ? url : undefined),
    bridges: built.bridges,
    level,
  })
  return { agentd, close: built.close }
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

  const { agentd, close } = makeAgentd(level, url)
  console.log(
    `agentd say  level=${level}${url ? `  url=${url}` : ''}  browser=${builtinBrowserOn() ? 'built-in' : 'fake'}`,
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

  const { agentd, close } = makeAgentd(level)
  // The demo brain only reads; a real brain is injected here once the adapters are wired.
  agentd.setLevel(level)
  const http = await startHttpServer({ agentd, token, port, log: (l) => console.log(`[agentd] ${l}`) })
  console.log(`agentd serving at ${http.url}`)
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
      Run one turn against a built-in demo brain and print the events (offline smoke).

  agentd serve [--port <n>] [--level ask|auto|full]
      Start the local HTTP API (127.0.0.1, bearer token) and keep running.

Env: DOOL2_BUILTIN_BROWSER=1 drives Dool2's own hidden Chromium; DOOL2_DATA_DIR sets the data folder;
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
