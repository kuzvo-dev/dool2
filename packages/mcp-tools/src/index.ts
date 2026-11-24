// Dool2 MCP tools. Claude Code, Codex and the pay-as-you-go runner start this as a child process.
// The actual work is handed to the Dool2 daemon (dool2d). Browser state and the approval gate live only in the daemon
// (docs/architecture.md section 2).
import { arch, platform } from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type BrowserClient, daemonClient, registerBrowserTools } from './browser.js'
import { registerFileTools } from './files.js'
import { registerLifeTools } from './life.js'
import { onDemand } from './on-demand.js'
import { registerScreenTools } from './screen.js'
import { registerServiceTools, type ServiceTools } from './services.js'

export { type BrowserClient, daemonClient, registerBrowserTools, type ToolResult } from './browser.js'
export {
  inputShape,
  outputShape,
  registerServiceTools,
  type ServiceToolSpec,
  type ServiceTools,
} from './services.js'

export const SERVER_NAME = 'dool2'

export interface ToolContext {
  now?: () => Date
  /** Where browser tools run (default: the Dool2 daemon from environment variables) */
  browser?: BrowserClient
  /** Where PC screen control tools run */
  screen?: BrowserClient
  /** Where goal, library, memory and feed tools run */
  life?: BrowserClient
  /** Where service tools (connectors) run */
  services?: BrowserClient
  /** Where PC file tools run */
  files?: BrowserClient
  /** How often to re-fetch the service tool list (default 30 seconds) */
  servicePollMs?: number
}

const serviceTools = new WeakMap<McpServer, ServiceTools>()
/** This server's service tools (list sync and names) */
export function servicesOf(server: McpServer): ServiceTools | undefined {
  return serviceTools.get(server)
}

export function statusText(ctx: ToolContext = {}) {
  const now = (ctx.now ?? (() => new Date()))()
  const os = platform() === 'darwin' ? 'macOS' : platform() === 'win32' ? 'Windows' : platform()
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now)
  return `Dool2 connected · ${os} (${arch()}) · now ${time} (Korea time, Asia/Seoul)`
}

export function createServer(ctx: ToolContext = {}) {
  const server = new McpServer({ name: SERVER_NAME, version: '0.0.0' })
  server.registerTool(
    'status',
    {
      title: 'Dool2 status',
      description:
        'Reports the connection status of Dool2 and this PC and the current time in Korea. Use it when you need the time or the connection status.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: 'text', text: statusText(ctx) }] }),
  )
  // Rarely used tools are kept off the visible list and reached through tool_find / tool_call (ADR 0033)
  const od = onDemand(server)
  registerBrowserTools(od.server, ctx.browser ?? daemonClient())
  registerScreenTools(od.server, ctx.screen ?? daemonClient(process.env, 'screen'))
  registerLifeTools(od.server, ctx.life ?? daemonClient(process.env, 'life'))
  registerFileTools(od.server, ctx.files ?? daemonClient(process.env, 'file'))
  serviceTools.set(
    server,
    registerServiceTools(server, ctx.services ?? daemonClient(process.env, 'service'), {
      ...(ctx.servicePollMs ? { pollMs: ctx.servicePollMs } : {}),
    }),
  )
  od.finish()
  return server
}

/** Server started by the runner: fetches the connected services' tools first (3 seconds at most), then connects */
export async function createReadyServer(ctx: ToolContext = {}) {
  const server = createServer(ctx)
  await Promise.race([servicesOf(server)?.sync(), new Promise((r) => setTimeout(r, 3000).unref?.())])
  return server
}
