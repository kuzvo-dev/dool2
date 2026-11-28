// The JSON-RPC 2.0 message shapes MCP rides on. MCP over stdio frames each message as one line of JSON-RPC 2.0, so
// this is the whole wire vocabulary: a request (has an id), a notification (no id), a result response, or an error
// response. Kept tiny and dependency-free — the subscription CLIs speak this; we implement it, not a third-party SDK.

export type JsonRpcId = number | string

/** A request or notification (notification = no `id`). */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/** A response: exactly one of `result` / `error`. */
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  result?: unknown
  error?: JsonRpcError
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse

/** Standard JSON-RPC error codes we use. */
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return typeof (msg as JsonRpcRequest).method === 'string'
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return !isRequest(msg) && 'id' in msg
}

export function result(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value }
}

export function error(id: JsonRpcId | null, err: JsonRpcError): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: err }
}
