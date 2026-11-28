// Pick the AI runner (the "brain") for a session from config/env, and build it.
//
// v2 keeps the brain dependency-injected into Agentd (see agentd.ts), so tests pass a fake and nothing spawns a real
// CLI or calls a model. This module is the one place that turns a plain config — or the env the CLI reads — into a
// concrete Brain, so the daemon can run a REAL AI through the same engine turn loop:
//
//   - 'claude' / 'codex' : the official subscription CLI the user already installed and signed in to. We never touch
//                          its auth; ready() runs the CLI's own cheap status command (offline-safe) to gate it.
//   - 'pi'               : the API-key path (@dool2/brain-pi), which needs the user's own key.
//   - 'demo' (default)   : the scripted, offline demo brain — nothing configured keeps the offline smoke working.
//
// Secrets never widen past here: the API key lives inside the pi adapter and is never logged or placed in a tool
// result; the CLI brains carry no key at all (the official binary owns its token).

import { createClaudeBrain } from '@dool2/brain-claude'
import type { SpawnCli, WhichFn } from '@dool2/brain-cli-util'
import { createCodexBrain } from '@dool2/brain-codex'
import { createPiBrain } from '@dool2/brain-pi'
import type { Brain } from '@dool2/brains'
import type { TurnEvent } from '@dool2/core'
import { scriptedBrain } from '@dool2/engine'

/** Which runner to use. 'demo' is the scripted offline brain and the default when nothing is configured. */
export type BrainChoice = 'claude' | 'codex' | 'pi' | 'demo'

/** Which wire shape the API-key (pi) brain speaks. */
export type BrainProvider = 'anthropic' | 'openai'

/** The resolved brain selection. All optional: an empty config means the scripted demo brain. */
export interface BrainConfig {
  /** The runner. Defaults to 'demo'. */
  brain?: BrainChoice
  /** The user's own API key — only read by the 'pi' brain, never logged. */
  apiKey?: string
  /** Model id passed through unchanged (e.g. 'sonnet' for claude, a model name for pi). */
  model?: string
  /** Override the pi provider base URL (e.g. an OpenAI-compatible gateway). */
  baseUrl?: string
  /** The pi wire shape. Defaults to 'anthropic'. */
  provider?: BrainProvider
}

/** The model the pi brain requests when none is configured. The user overrides it with DOOL2_MODEL. */
export const DEFAULT_PI_MODEL = 'claude-sonnet-4-5'

/** Process/network injection points, so tests build a real-shaped brain without a real CLI, model, or network. */
export interface ChooseBrainDeps {
  /** For the demo brain only: a tab URL to open before the first snapshot (built-in browser). */
  demoUrl?: string
  /** CLI brains: injected process spawner (tests). */
  spawn?: SpawnCli
  /** CLI brains: injected binary finder (tests). */
  which?: WhichFn
  /** CLI brains: injected sign-in probe for ready() (tests). */
  loginProbe?: (binPath: string) => Promise<boolean>
  /** pi brain: injected fetch (tests). */
  fetch?: typeof fetch
}

/** Read the brain selection from the environment (what the CLI uses). */
export function brainConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  return {
    brain: normalizeChoice(env.DOOL2_BRAIN),
    ...(env.DOOL2_API_KEY ? { apiKey: env.DOOL2_API_KEY } : {}),
    ...(env.DOOL2_MODEL ? { model: env.DOOL2_MODEL } : {}),
    ...(env.DOOL2_BRAIN_BASEURL ? { baseUrl: env.DOOL2_BRAIN_BASEURL } : {}),
    ...(normalizeProvider(env.DOOL2_BRAIN_PROVIDER)
      ? { provider: normalizeProvider(env.DOOL2_BRAIN_PROVIDER) }
      : {}),
  }
}

/**
 * Build the Brain the config asks for. The default (undefined/'demo') is the scripted demo brain, so an unconfigured
 * daemon still runs offline. 'claude'/'codex' build the official-CLI adapters (availability is gated by their own
 * ready()); 'pi' builds the API-key adapter and REQUIRES a key — without one this throws a clear, actionable error.
 */
export function chooseBrain(config: BrainConfig = {}, deps: ChooseBrainDeps = {}): Brain {
  const choice: BrainChoice = config.brain ?? 'demo'
  switch (choice) {
    case 'demo':
      return demoBrain(deps.demoUrl)
    case 'claude':
      return createClaudeBrain(cliOptions(config, deps))
    case 'codex':
      return createCodexBrain(cliOptions(config, deps))
    case 'pi': {
      const apiKey = config.apiKey?.trim()
      if (!apiKey) {
        throw new Error(
          'DOOL2_BRAIN=pi needs an API key. Set DOOL2_API_KEY to your own key, or pick an installed CLI with DOOL2_BRAIN=claude or =codex.',
        )
      }
      return createPiBrain({
        apiKey,
        model: config.model || DEFAULT_PI_MODEL,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.provider ? { provider: config.provider } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
    }
    default:
      // Exhaustiveness guard; normalizeChoice already keeps env input in range.
      throw new Error(`Unknown brain: ${String(choice)}`)
  }
}

/** The shared option block for the two CLI brains: pass the model and any injected process wiring. */
function cliOptions(config: BrainConfig, deps: ChooseBrainDeps) {
  return {
    ...(config.model ? { model: config.model } : {}),
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
    ...(deps.which ? { which: deps.which } : {}),
    ...(deps.loginProbe ? { loginProbe: deps.loginProbe } : {}),
  }
}

/**
 * The scripted demo brain: look at the open page with the `code` hand (page.snapshot), read the snapshot back, then
 * finish. Runnable offline — with the built-in browser off the page bridge is a fake. With it on, `url` is opened
 * first. No model, no network: a smoke for the whole engine+gate+approvals spine.
 */
export function demoBrain(url?: string): Brain {
  const code = url
    ? `(async () => { await page.goto(${JSON.stringify(url)}); return JSON.stringify(await page.snapshot()) })()`
    : 'JSON.stringify(await page.snapshot())'
  const rounds: TurnEvent[][] = [
    [
      { kind: 'text', text: 'Let me look at the open page.' },
      { kind: 'tool_call', call: { id: 'c1', name: 'code', args: { code } } },
      { kind: 'turn_end', stop: 'tool' },
    ],
    [
      { kind: 'text', text: 'That is what the page shows right now.' },
      { kind: 'turn_end', stop: 'done' },
    ],
  ]
  const brain = scriptedBrain(rounds)
  // Label it so `agentd say` can report "demo" as the runner it used.
  return { ...brain, label: 'Demo (scripted, offline)' }
}

function normalizeChoice(v: string | undefined): BrainChoice {
  switch ((v ?? '').trim().toLowerCase()) {
    case 'claude':
      return 'claude'
    case 'codex':
      return 'codex'
    case 'pi':
      return 'pi'
    default:
      return 'demo'
  }
}

function normalizeProvider(v: string | undefined): BrainProvider | undefined {
  const p = (v ?? '').trim().toLowerCase()
  return p === 'openai' ? 'openai' : p === 'anthropic' ? 'anthropic' : undefined
}
