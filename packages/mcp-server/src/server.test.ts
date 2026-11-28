import { TOOLS, type ToolCall, type ToolResult } from '@dool2/core'
import { describe, expect, it, vi } from 'vitest'
import { McpClient } from './client.js'
import { serveMcp, type ToolHandler } from './server.js'
import { inMemoryTransportPair } from './transport.js'

/** Wire a client and a server over one in-memory pair, serving `handler`. Returns both, initialized. */
async function connect(handler: ToolHandler): Promise<{ client: McpClient; close: () => void }> {
  const { client, server } = inMemoryTransportPair()
  const srv = serveMcp(server, handler)
  const mcp = new McpClient(client)
  await mcp.initialize()
  return { client: mcp, close: () => srv.close() }
}

describe('serveMcp tools/list', () => {
  it('advertises exactly the shared TOOLS with argument schemas', async () => {
    const { client, close } = await connect(async (c) => ({ id: c.id, content: 'ok' }))
    const tools = await client.listTools()

    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].map((t) => t.name).sort())
    const code = tools.find((t) => t.name === 'code')
    expect(code?.inputSchema.type).toBe('object')
    expect(code?.inputSchema.properties).toHaveProperty('code')
    expect(code?.inputSchema.required).toContain('code')
    // The description the model reads is carried through from @dool2/core.
    expect(code?.description).toMatch(/run code/i)
    close()
  })
})

describe('serveMcp tools/call', () => {
  it('routes a call to the handler and returns its ToolResult', async () => {
    const handler = vi.fn<ToolHandler>(async (call: ToolCall) => ({
      id: call.id,
      content: `ran ${call.name}: ${JSON.stringify(call.args)}`,
    }))
    const { client, close } = await connect(handler)

    const res = await client.callTool('code', { code: 'await page.snapshot()' })
    expect(res.isError).toBe(false)
    expect(res.content).toContain('ran code')
    expect(res.content).toContain('page.snapshot')

    // The handler saw a well-formed @dool2/core ToolCall built from the MCP params.
    expect(handler).toHaveBeenCalledTimes(1)
    const call = handler.mock.calls[0]?.[0]
    expect(call?.name).toBe('code')
    expect(call?.args).toEqual({ code: 'await page.snapshot()' })
    expect(typeof call?.id).toBe('string')
    close()
  })

  it('surfaces an error ToolResult with isError true', async () => {
    const { client, close } = await connect(async (c) => ({
      id: c.id,
      content: 'Needs the user approval on their phone: it did not run.',
      isError: true,
    }))
    const res = await client.callTool('code', { code: 'await page.click("pay1")' })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('did not run')
    close()
  })

  it('turns a thrown handler into an error result, not a dead channel', async () => {
    const { client, close } = await connect(async () => {
      throw new Error('sandbox boom')
    })
    const res = await client.callTool('code', { code: 'x' })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('sandbox boom')
    close()
  })

  it('rejects a tool that is not one of the few TOOLS', async () => {
    const handler = vi.fn<ToolHandler>(async (c) => ({ id: c.id, content: 'ok' }))
    const { client, close } = await connect(handler)
    await expect(client.callTool('shell', { cmd: 'rm -rf /' })).rejects.toThrow(/unknown tool/i)
    expect(handler).not.toHaveBeenCalled()
    close()
  })
})
