// Codex's model catalog with only Dool2 tools in it (ADR 0003 amendment).
//
// Which built-in tools Codex 0.169.0 offers the model is decided per model in its catalog, not by a switch: the newer
// models run in "code mode" (a JavaScript tool, `exec`, that calls every other tool from inside a script, with Dool2's
// tools reachable only that way) and carry "multi-agent" tools that start other AI agents on their own threads. A
// sub-agent's work never reaches Dool2's work log (its lines carry another thread id), and a script's calls are not
// shown as one step. Codex reads the catalog from `model_catalog_json` when it is set, so Dool2 writes its own copy of
// the pinned program's catalog (`codex debug models`, about 40 ms) with those fields changed:
//   tool_mode direct             tools are offered one by one, no JavaScript tool
//   multi_agent_version removed  no sub-agent tools
//   supports_search_tool false   Dool2's tools are offered up front, as on Claude, not behind a search tool
//   node_repl_disabled, apply_patch_tool_type null   no script runner, no file-patch tool
// Checked against the pinned app-server with a local stand-in for the model: fixtures/app-server-tools-0.169.0.json.

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runOnce } from '@dool2/engine'

/** File name of Dool2's catalog, inside Dool2's CODEX_HOME */
export const CATALOG_FILE = 'dool2-model-catalog.json'

type Json = Record<string, unknown>

/** The catalog with every model set to offer only plain tools (no JavaScript tool, no sub-agents, no tool search) */
export function onlyDool2Catalog(raw: unknown): { models: Json[] } {
  const models = (raw as { models?: unknown } | undefined)?.models
  if (!Array.isArray(models) || !models.length) throw new Error('Codex model catalog has no models')
  return {
    ...(raw as Json),
    models: models.map((m) => {
      const { multi_agent_version: _v, multi_agent_reasoning_effort: _e, ...rest } = m as Json
      return {
        ...rest,
        tool_mode: 'direct',
        supports_search_tool: false,
        node_repl_disabled: true,
        apply_patch_tool_type: null,
      }
    }),
  }
}

/**
 * Writes Dool2's catalog from the pinned program's own and returns its path. If the program cannot print it, a copy
 * written earlier is used; with none, this fails, and the caller does not start Codex (fail closed)
 */
export async function writeOnlyDool2Catalog(
  bin: string,
  codexHome: string,
  env: NodeJS.ProcessEnv,
  run: typeof runOnce = runOnce,
): Promise<string> {
  const path = join(codexHome, CATALOG_FILE)
  try {
    const r = await run(bin, ['debug', 'models'], { env, timeoutMs: 15_000 })
    if (r.code !== 0) throw new Error(r.stderr.trim().slice(-200) || `exit ${r.code}`)
    await writeFile(path, JSON.stringify(onlyDool2Catalog(JSON.parse(r.stdout))))
    return path
  } catch (err) {
    if (existsSync(path)) return path
    throw err
  }
}
