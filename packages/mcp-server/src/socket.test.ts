import { connect as netConnect } from 'node:net'
import type { ToolCall } from '@dool2/core'
import { describe, expect, it } from 'vitest'
import { McpClient } from './client.js'
import { createMcpSocketServer } from './socket.js'
import { nodeStreamTransport } from './transport.js'

// The production path end to end, minus the CLI: the daemon-side socket server runs the real MCP server over a socket,
// and a client connects over that same socket with the newline-JSON stream transport. Proves the real transport works
// without spawning any CLI. Unix-socket based; skipped on Windows named pipes to keep CI simple.
describe.skipIf(process.platform === 'win32')('createMcpSocketServer', () => {
  it('serves tool calls over a real socket connection', async () => {
    const server = await createMcpSocketServer(async (call: ToolCall) => ({
      id: call.id,
      content: `socket ran ${call.name}`,
    }))

    const sock = netConnect(server.endpoint)
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve())
      sock.once('error', reject)
    })

    const client = new McpClient(nodeStreamTransport(sock, sock))
    await client.initialize()
    const tools = await client.listTools()
    expect(tools.some((t) => t.name === 'code')).toBe(true)

    const res = await client.callTool('code', { code: '1+1' })
    expect(res.content).toBe('socket ran code')

    sock.destroy()
    await server.close()
  })
})
