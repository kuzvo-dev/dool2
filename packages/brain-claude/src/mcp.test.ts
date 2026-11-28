import type { McpBinding, McpConnector, SpawnCli, WhichFn } from '@dool2/brain-cli-util'
import type { RunHandle, ToolCall, ToolHandler, TurnEvent } from '@dool2/core'
import { inMemoryTransportPair, McpClient, serveMcp } from '@dool2/mcp-server'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeBrain } from './brain.js'

const foundWhich: WhichFn = async () => '/usr/local/bin/claude'

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

// The MCP loop with no real CLI: a connector serves the handler over an in-memory transport, and a fake `claude`
// child "calls" the code tool over that same transport (the client end) before streaming its stream-json lines. This
// proves the round-trip: CLI calls code -> MCP server -> handler -> result -> CLI continues, and the adapter yields a
// serviced tool_call and then ends the turn `done` (not `tool`, which would hand control back to the engine).
describe('createClaudeBrain run() with an MCP tool server', () => {
  it('routes the CLI tool call to the handler and yields a serviced tool_call that continues', async () => {
    const pair = inMemoryTransportPair()

    // The engine-supplied handler (here a fake); records the call and returns a result.
    const handler = vi.fn<ToolHandler>(async (call: ToolCall) => ({
      id: call.id,
      content: 'CODE TOOL RAN: snapshot had 2 nodes',
    }))

    // The connector serves whatever handler the brain passes (RunHandle.tools) on the server end of the pair.
    const connector: McpConnector = async (h) => {
      serveMcp(pair.server, h)
      const binding: McpBinding = { command: 'node', args: ['bridge', 'endpoint'], close: () => {} }
      return binding
    }

    // What the code tool returned to the CLI, captured so the test can assert the result reached the CLI side.
    let cliSawResult = ''

    // A fake `claude` child: over the client transport it initializes and calls `code`, then streams the stream-json
    // for a text delta, the tool_use, and the final result — exactly what the real CLI emits when a tool round-trips.
    const spawn: SpawnCli = (command, args, opts) => {
      void command
      void args
      void opts
      async function* emit(): AsyncGenerator<string> {
        const client = new McpClient(pair.client)
        await client.initialize()
        const res = await client.callTool('code', { code: 'await page.snapshot()' })
        cliSawResult = res.content

        yield JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking the page. ' } },
        })
        yield JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'code', input: { code: 'await page.snapshot()' } },
            ],
          },
        })
        yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
      }
      return { lines: emit(), exit: Promise.resolve({ code: 0, stderrTail: '' }), kill() {} }
    }

    const brain = createClaudeBrain({ spawn, which: foundWhich, mcpConnector: connector })
    const handle: RunHandle = { toolResult() {}, steer() {}, abort() {}, tools: handler }
    const ev = await collect(
      brain.run({ system: 's', messages: [{ role: 'user', content: 'look' }] }, handle),
    )

    // The handler ran exactly once, with the code tool and the args the CLI sent.
    expect(handler).toHaveBeenCalledTimes(1)
    const call = handler.mock.calls[0]?.[0]
    expect(call?.name).toBe('code')
    expect(call?.args).toEqual({ code: 'await page.snapshot()' })

    // The handler's result reached the CLI side over MCP.
    expect(cliSawResult).toBe('CODE TOOL RAN: snapshot had 2 nodes')

    // The adapter yielded a serviced tool_call (the engine must not re-run it) and the turn continued to a `done` end.
    const toolCall = ev.find((e) => e.kind === 'tool_call')
    expect(toolCall?.kind === 'tool_call' && toolCall.serviced).toBe(true)
    expect(ev.at(-1)).toEqual({ kind: 'turn_end', stop: 'done' })

    // Order: text before the tool_call, tool_call before the turn end.
    const kinds = ev.map((e) => e.kind)
    expect(kinds.indexOf('text')).toBeLessThan(kinds.indexOf('tool_call'))
    expect(kinds.indexOf('tool_call')).toBeLessThan(kinds.lastIndexOf('turn_end'))
  })

  it('attaches the MCP config flags only when a tool handler is present', async () => {
    const seen: string[][] = []
    const spawn: SpawnCli = (_command, args) => {
      seen.push(args)
      async function* emit(): AsyncGenerator<string> {
        yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hi' })
      }
      return { lines: emit(), exit: Promise.resolve({ code: 0, stderrTail: '' }), kill() {} }
    }
    const connector: McpConnector = async (h) => {
      serveMcp(inMemoryTransportPair().server, h)
      return { command: 'node', args: ['bridge', 'endpoint'], close: () => {} }
    }

    // No handler → no MCP flags.
    const bare = createClaudeBrain({ spawn, which: foundWhich, mcpConnector: connector })
    await collect(bare.run({ system: 's', messages: [] }, { toolResult() {}, steer() {}, abort() {} }))
    expect(seen[0]).not.toContain('--mcp-config')

    // With a handler → MCP flags present, including the namespaced allowed tool.
    const wired = createClaudeBrain({ spawn, which: foundWhich, mcpConnector: connector })
    await collect(
      wired.run(
        { system: 's', messages: [] },
        {
          toolResult() {},
          steer() {},
          abort() {},
          tools: async (c) => ({ id: c.id, content: 'ok' }),
        },
      ),
    )
    expect(seen[1]).toContain('--mcp-config')
    expect(seen[1]).toContain('--strict-mcp-config')
    expect(seen[1]).toContain('mcp__dool2__code')
  })
})
