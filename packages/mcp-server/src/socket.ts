// The production bridge between the daemon (where the tool handler and its sandbox + gate live) and a subscription CLI
// (which spawns its MCP servers as stdio child processes). The daemon cannot hand a CLI-spawned child an in-process
// closure, so: the daemon listens on a local socket here and runs the real MCP server over each connection; the CLI
// spawns the tiny stdio bridge (stdio-bridge.ts) which just pumps bytes between its own stdio and this socket. The
// handler never leaves the daemon, and no secret crosses the socket — only tool calls and their masked results.
//
// The socket is a unix domain socket under the OS temp dir (a Windows named pipe on win32): local-only, not a TCP
// port. Tests exercise the server over a direct socket connection, so this real path is proven without any CLI.

import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ServeMcpOptions, serveMcp, type ToolHandler } from './server.js'
import { nodeStreamTransport } from './transport.js'

/** The absolute path to the compiled stdio-bridge script — the command a CLI launches as its stdio MCP server. */
export function stdioBridgePath(): string {
  return fileURLToPath(new URL('./stdio-bridge.js', import.meta.url))
}

/** A listening socket server. `endpoint` is what the stdio bridge connects to; `close()` stops it. */
export interface McpSocketServer {
  endpoint: string
  close(): Promise<void>
}

/** A unique local socket path: a named pipe on Windows, else a unix socket under the temp dir. */
function freshEndpoint(): string {
  const id = `dool2-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`)
}

/**
 * Start a local socket server that runs the MCP tool server over each connection, all bound to one `handler`. Returns
 * once it is listening. One daemon turn opens one of these, points the CLI's MCP config at its `endpoint`, and closes
 * it when the turn ends.
 */
export function createMcpSocketServer(
  handler: ToolHandler,
  opts: ServeMcpOptions = {},
): Promise<McpSocketServer> {
  const endpoint = freshEndpoint()
  const sockets = new Set<Socket>()
  const server: Server = createServer((sock: Socket) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => sockets.delete(sock))
    serveMcp(nodeStreamTransport(sock, sock), handler, opts)
  })

  return new Promise<McpSocketServer>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, () => {
      server.removeListener('error', reject)
      resolve({
        endpoint,
        close(): Promise<void> {
          for (const sock of sockets) sock.destroy()
          sockets.clear()
          return new Promise<void>((res) => server.close(() => res()))
        },
      })
    })
  })
}

/**
 * The stdio-side byte pump: connect to `endpoint` and shuttle bytes both ways between the CLI (this process's stdio)
 * and the daemon's socket. No JSON parsing here — framing is the transport's job at both real ends. Resolves when the
 * connection ends. This is what the CLI launches as its stdio MCP server command.
 */
export function runStdioBridge(
  endpoint: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sock = connect(endpoint)
    sock.on('connect', () => {
      input.pipe(sock)
      sock.pipe(output)
    })
    sock.on('close', () => resolve())
    sock.on('error', (err: Error) => reject(err))
  })
}
