// The MCP tool server: it advertises Dool2's few tools to a client (a subscription CLI, or a test) and, when the
// client calls one, forwards it to the injected handler and returns the handler's ToolResult. This is how Claude Code
// and Codex — which run the official binary and cannot be handed an inline tool list — get to call Dool2's `code`
// tool: the daemon attaches this server over stdio, the model sees `code`, and each call round-trips to the engine's
// handler (sandbox + autonomy gate) and back.
//
// The server is transport-agnostic (see transport.ts) and the handler is injected, so a unit test drives it over an
// in-memory transport with a fake handler, and production drives it over a stream with the engine's real handler.
// Safety and secrets live in the handler, not here: a tool not in the advertised set is rejected, and whatever the
// handler returns (masked values only) is what the client sees.

import {
  TOOLS,
  type ToolCall,
  type ToolHandler,
  type ToolName,
  type ToolResult,
  type ToolSpec,
} from '@dool2/core'
import {
  error,
  isRequest,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  result,
} from './jsonrpc.js'
import { type McpToolDef, mcpToolDefs } from './tools.js'
import type { McpTransport } from './transport.js'

/** Re-exported for convenience: the handler the daemon/engine supplies (sandbox + gate). Defined in @dool2/core. */
export type { ToolHandler }

/** The MCP protocol version we speak. Pinned; a client that asks for another still gets ours in the reply. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

export interface ServeMcpOptions {
  /** The tools to advertise. Defaults to the shared @dool2/core TOOLS. */
  tools?: readonly ToolSpec[]
  /** Server name/version reported in `initialize`. */
  serverInfo?: { name: string; version: string }
}

/** A running server bound to a transport. Close it to stop handling messages. */
export interface McpServer {
  close(): void
}

/**
 * Serve MCP over `transport`, routing each `tools/call` to `handler`. Returns immediately; the server reacts to
 * inbound messages until closed or the peer disconnects.
 */
export function serveMcp(
  transport: McpTransport,
  handler: ToolHandler,
  opts: ServeMcpOptions = {},
): McpServer {
  const tools = opts.tools ?? TOOLS
  const toolNames = new Set<ToolName>(tools.map((t) => t.name))
  const defs: McpToolDef[] = mcpToolDefs(tools)
  const serverInfo = opts.serverInfo ?? { name: 'dool2', version: '0.0.0' }
  let closed = false

  const reply = (msg: JsonRpcMessage): void => {
    if (!closed) transport.send(msg)
  }

  transport.onMessage((msg) => {
    if (closed || !isRequest(msg)) return
    void handle(msg)
  })
  transport.onClose(() => {
    closed = true
  })

  async function handle(req: JsonRpcRequest): Promise<void> {
    const id = req.id
    // A notification (no id) never gets a response; `notifications/initialized` is the common one.
    if (id === undefined) return

    switch (req.method) {
      case 'initialize':
        reply(
          result(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
          }),
        )
        return
      case 'ping':
        reply(result(id, {}))
        return
      case 'tools/list':
        reply(result(id, { tools: defs }))
        return
      case 'tools/call':
        await handleToolCall(id, req.params)
        return
      default:
        reply(error(id, { code: RPC_METHOD_NOT_FOUND, message: `Unknown method: ${req.method}` }))
    }
  }

  async function handleToolCall(id: JsonRpcId, params: unknown): Promise<void> {
    const name = readName(params)
    if (name === undefined) {
      reply(error(id, { code: RPC_INVALID_PARAMS, message: 'tools/call needs a tool name.' }))
      return
    }
    // Reject anything outside the advertised set: the few tools are the whole surface (ADR 0045).
    if (!toolNames.has(name as ToolName)) {
      reply(error(id, { code: RPC_INVALID_PARAMS, message: `Unknown tool: ${name}` }))
      return
    }
    const call: ToolCall = { id: String(id), name: name as ToolName, args: readArgs(params) }
    let toolResult: ToolResult
    try {
      toolResult = await handler(call)
    } catch (err) {
      // A thrown handler becomes an error tool result, not a dead channel: the model reads it and can try another way.
      reply(result(id, toContent(`Tool failed: ${errMessage(err)}`, true)))
      return
    }
    reply(result(id, toContent(toolResult.content, toolResult.isError === true)))
  }

  return {
    close(): void {
      closed = true
      transport.close()
    },
  }
}

/** The MCP `tools/call` result shape: text content plus the error flag. */
function toContent(
  text: string,
  isError: boolean,
): { content: { type: 'text'; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text }], isError }
}

function readName(params: unknown): string | undefined {
  if (params && typeof params === 'object' && 'name' in params) {
    const name = (params as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  return undefined
}

function readArgs(params: unknown): unknown {
  if (params && typeof params === 'object' && 'arguments' in params) {
    return (params as { arguments?: unknown }).arguments ?? {}
  }
  return {}
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
