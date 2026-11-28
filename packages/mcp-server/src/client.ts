// A minimal MCP client: enough to initialize, list the tools, and call one, correlating each reply by its JSON-RPC
// id. The real subscription CLIs are the production clients; this stands in for them in tests (the "fake CLI calls
// the code tool") and is handy for in-process callers. Transport-agnostic, like the server.

import { isResponse, type JsonRpcId, type JsonRpcMessage, type JsonRpcResponse } from './jsonrpc.js'
import type { McpToolDef } from './tools.js'
import type { McpTransport } from './transport.js'

/** What a `tools/call` returns to the caller: the joined text content and whether it was an error. */
export interface CallToolResult {
  content: string
  isError: boolean
}

export class McpClient {
  readonly #transport: McpTransport
  #nextId = 1
  readonly #pending = new Map<JsonRpcId, (res: JsonRpcResponse) => void>()

  constructor(transport: McpTransport) {
    this.#transport = transport
    transport.onMessage((msg: JsonRpcMessage) => {
      if (!isResponse(msg) || msg.id === null) return
      const resolve = this.#pending.get(msg.id)
      if (resolve) {
        this.#pending.delete(msg.id)
        resolve(msg)
      }
    })
  }

  #request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.#nextId++
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.#pending.set(id, resolve)
      try {
        this.#transport.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
      } catch (err) {
        this.#pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** The MCP handshake. Returns the server's reported info. */
  async initialize(): Promise<unknown> {
    const res = await this.#request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dool2-client', version: '0.0.0' },
    })
    // The initialized notification has no id and gets no reply.
    this.#transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return res.result
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = await this.#request('tools/list')
    const tools = (res.result as { tools?: McpToolDef[] } | undefined)?.tools
    return tools ?? []
  }

  /** Call a tool by name. Throws on a JSON-RPC error (e.g. an unknown tool rejected by the server). */
  async callTool(name: string, args: unknown): Promise<CallToolResult> {
    const res = await this.#request('tools/call', { name, arguments: args })
    if (res.error) throw new Error(res.error.message)
    const r = res.result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined
    const content = (r?.content ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('')
    return { content, isError: r?.isError === true }
  }

  close(): void {
    this.#transport.close()
  }
}
