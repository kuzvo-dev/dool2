// How a subscription CLI is given Dool2's tools: over an MCP server. The CLI runs the official binary and has no way
// to take an inline tool list (unlike the API-key path), but both Claude Code and Codex can attach an MCP stdio
// server by config. So the daemon stands up an MCP server bound to the engine's tool handler (sandbox + gate) and
// points the CLI at it; the model then sees `code` and its calls round-trip to the engine and back.
//
// A connector turns a handler into a running server plus the exact CLI config to reach it. The default connector uses
// a local socket (the daemon side) + a tiny stdio bridge the CLI spawns (see @dool2/mcp-server socket.ts), so the
// handler never leaves the daemon process. Tests inject their own connector over an in-memory transport. The exact
// flags each CLI needs live here, in one place, so a CLI change is a one-line edit.

import { TOOLS, type ToolHandler } from '@dool2/core'
import { createMcpSocketServer, stdioBridgePath } from '@dool2/mcp-server'

/** The MCP server name Dool2 registers with each CLI. Tools appear to the model namespaced as `mcp__dool2__<tool>`. */
export const DOOL2_MCP_SERVER_NAME = 'dool2'

/** The namespaced tool names to allow, so the CLI may call the few Dool2 tools without an interactive prompt. */
export function mcpAllowedToolNames(): string[] {
  return TOOLS.map((t) => `mcp__${DOOL2_MCP_SERVER_NAME}__${t.name}`)
}

/**
 * A running MCP server for one CLI turn, plus the command the CLI spawns as its stdio MCP server to reach it. The
 * per-CLI arg builders (claudeMcpArgs / codexMcpArgs) turn this into the CLI's own flags.
 */
export interface McpBinding {
  /** The executable the CLI launches as its stdio MCP server (the byte-pump bridge). */
  command: string
  /** The arguments to that command (the bridge script + the daemon socket endpoint). */
  args: string[]
  /** Stop the server and release the socket. Called when the turn ends. */
  close(): Promise<void> | void
}

/** Turn a tool handler into a running MCP server + the CLI command to reach it. Injected so tests mock the transport. */
export type McpConnector = (handler: ToolHandler) => Promise<McpBinding>

/**
 * The production connector: open a local socket MCP server bound to `handler`, and hand back the stdio-bridge command
 * the CLI will spawn to connect. The handler (and its sandbox + gate) stays in the daemon; the bridge only pumps bytes.
 */
export const defaultMcpConnector: McpConnector = async (handler) => {
  const server = await createMcpSocketServer(handler)
  return {
    command: process.execPath,
    args: [stdioBridgePath(), server.endpoint],
    close: () => server.close(),
  }
}

/** The inline MCP config JSON for a stdio server, as Claude Code's `--mcp-config` accepts it. */
function mcpConfigJson(binding: McpBinding): string {
  return JSON.stringify({
    mcpServers: {
      [DOOL2_MCP_SERVER_NAME]: { type: 'stdio', command: binding.command, args: binding.args },
    },
  })
}

/**
 * Claude Code flags to attach the MCP server (verified against Claude Code 2.x `claude --help`): load our server from
 * inline JSON, ignore any other MCP config, and allow exactly the few Dool2 tools so no per-call prompt appears.
 */
export function claudeMcpArgs(binding: McpBinding): string[] {
  return [
    '--mcp-config',
    mcpConfigJson(binding),
    '--strict-mcp-config',
    '--allowedTools',
    ...mcpAllowedToolNames(),
  ]
}

/**
 * Codex flags to attach the MCP server via its `-c key=value` config overrides (TOML paths under `mcp_servers.<name>`).
 * Kept here as the single source so a Codex change is a one-line edit; verified against the pinned Codex build.
 */
export function codexMcpArgs(binding: McpBinding): string[] {
  const base = `mcp_servers.${DOOL2_MCP_SERVER_NAME}`
  return [
    '-c',
    `${base}.command=${JSON.stringify(binding.command)}`,
    '-c',
    `${base}.args=${JSON.stringify(binding.args)}`,
  ]
}
