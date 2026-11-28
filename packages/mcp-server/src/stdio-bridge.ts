#!/usr/bin/env node
// The command a subscription CLI launches as its stdio MCP server. It does one thing: connect to the daemon's socket
// (its endpoint is argv[2]) and pump bytes between this process's stdio and that socket, so the CLI talks MCP to the
// daemon's real tool server. No logic, no secrets — just a pipe. See socket.ts for the daemon side.

import { runStdioBridge } from './socket.js'

const endpoint = process.argv[2]
if (!endpoint) {
  process.stderr.write('dool2-mcp-stdio-bridge: missing socket endpoint argument\n')
  process.exit(2)
}

runStdioBridge(endpoint).then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`dool2-mcp-stdio-bridge: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  },
)
