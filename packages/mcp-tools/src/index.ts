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
import {
  readServiceToolsFile,
  registerServiceTools,
  type ServiceToolSpec,
  type ServiceTools,
  serviceToolsPath,
} from './services.js'
import { type SessionKind, sessionFence, sessionKind } from './sessions.js'
import { registerTaskTools } from './tasks.js'

export { type BrowserClient, daemonClient, registerBrowserTools, type ToolResult } from './browser.js'
export {
  inputShape,
  outputShape,
  readServiceToolsFile,
  registerServiceTools,
  type ServiceToolSpec,
  type ServiceTools,
  serviceToolsPath,
} from './services.js'
export { type SessionKind, sessionKind, toolInSession } from './sessions.js'

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
  /**
   * The segment this server works for (DOOL2_TOOLSET from the engine by default). The daemon keeps its service tool
   * list fixed for the segment (ADR 0032)
   */
  toolset?: string
  /** Service tools known before start (the list the daemon wrote for this segment). Registered right away */
  serviceTools?: ServiceToolSpec[]
  /**
   * Which session this server serves (DOOL2_SESSION from the daemon by default, ADR 0038): the conversation gets no
   * browser, PC app or file tools but the task tools; a task gets everything but the task tools. Missing: as before
   */
  session?: SessionKind
  /** Where task tools run */
  tasks?: BrowserClient
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
  const toolset = ctx.toolset ?? process.env.DOOL2_TOOLSET
  const session = ctx.session ?? sessionKind(process.env.DOOL2_SESSION)
  // Rarely used tools are kept off the visible list and reached through tool_find / tool_call (ADR 0033). Tools this
  // kind of session does not get are not registered at all, so tool_find does not offer them either (ADR 0038)
  const od = onDemand(
    server,
    undefined,
    session === 'conversation'
      ? 'The browser, PC apps and KakaoTalk, PC files, pictures, videos, PDFs, printing and texts work in a task: when your instructions or a result name one of those tools, hand the work over with task_start. Never say Dool2 cannot do these.'
      : undefined,
  )
  const tools = sessionFence(od.server, session)
  registerBrowserTools(tools, ctx.browser ?? daemonClient())
  registerScreenTools(tools, ctx.screen ?? daemonClient(process.env, 'screen'))
  registerLifeTools(tools, ctx.life ?? daemonClient(process.env, 'life'))
  registerFileTools(tools, ctx.files ?? daemonClient(process.env, 'file'))
  registerTaskTools(tools, ctx.tasks ?? daemonClient(process.env, 'task'))
  serviceTools.set(
    server,
    registerServiceTools(server, ctx.services ?? daemonClient(process.env, 'service'), {
      ...(ctx.servicePollMs ? { pollMs: ctx.servicePollMs } : {}),
      ...(toolset ? { toolset } : {}),
      ...(ctx.serviceTools ? { initial: ctx.serviceTools } : {}),
    }),
  )
  od.finish()
  return server
}

/**
 * Server started by the runner. The daemon writes the segment's service tool list before starting the agent
 * (DOOL2_SERVICE_TOOLS folder, one file per DOOL2_TOOLSET), so the server connects at once with those tools. Without
 * that file it asks the daemon first (3 seconds at most): a server that answered the agent late left the turn without
 * Dool2 tools
 */
export async function createReadyServer(ctx: ToolContext = {}, env: NodeJS.ProcessEnv = process.env) {
  const known =
    ctx.serviceTools ??
    readServiceToolsFile(serviceToolsPath(env.DOOL2_SERVICE_TOOLS, ctx.toolset ?? env.DOOL2_TOOLSET))
  const server = createServer(known ? { ...ctx, serviceTools: known } : ctx)
  if (!known)
    await Promise.race([servicesOf(server)?.sync(), new Promise((r) => setTimeout(r, 3000).unref?.())])
  return server
}
