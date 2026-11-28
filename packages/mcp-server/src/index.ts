// @dool2/mcp-server
//
// A small, dependency-free MCP (Model Context Protocol) stdio server that advertises Dool2's few tools (@dool2/core
// TOOLS) and forwards every tool call to an injected handler — the engine's handler, which runs `code` in the sandbox
// through the autonomy gate. This is how the subscription CLI brains (Claude Code, Codex), which run the official
// binary and cannot take an inline tool list, get to call Dool2's tools: the daemon attaches this server and each
// call round-trips to the engine and back. Transport and handler are injected, so tests mock both.

export { type CallToolResult, McpClient } from './client.js'
export {
  error,
  isRequest,
  isResponse,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  result,
} from './jsonrpc.js'
export {
  MCP_PROTOCOL_VERSION,
  type McpServer,
  type ServeMcpOptions,
  serveMcp,
  type ToolHandler,
} from './server.js'
export {
  createMcpSocketServer,
  type McpSocketServer,
  runStdioBridge,
  stdioBridgePath,
} from './socket.js'
export { type JsonSchema, type McpToolDef, mcpToolDefs } from './tools.js'
export {
  inMemoryTransportPair,
  type McpTransport,
  nodeStreamTransport,
  type TransportPair,
} from './transport.js'
