// 두리 MCP 도구. Claude Code·Codex·종량제 실행기가 자식 프로세스로 띄운다.
// 실제 실행은 두리 본체(dool2d)에 넘긴다. 브라우저 상태와 승인 게이트는 본체 한 곳에만 둔다
// (docs/architecture.md 2장).
import { arch, platform } from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type BrowserClient, daemonClient, registerBrowserTools, registerSkillTools } from './browser.js'
import { registerLifeTools } from './life.js'
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
  /** 브라우저 도구를 실행할 곳 (기본: 환경 변수의 두리 본체) */
  browser?: BrowserClient
  /** 스킬 도구를 실행할 곳 */
  skills?: BrowserClient
  /** PC 화면 제어 도구를 실행할 곳 */
  screen?: BrowserClient
  /** 목표·보관함·기억·피드 도구를 실행할 곳 */
  life?: BrowserClient
  /** 서비스 도구(커넥터)를 실행할 곳 */
  services?: BrowserClient
  /** 서비스 도구 목록을 다시 묻는 간격 (기본 30초) */
  servicePollMs?: number
}

const serviceTools = new WeakMap<McpServer, ServiceTools>()
/** 이 서버의 서비스 도구 (목록 맞추기·이름) */
export function servicesOf(server: McpServer): ServiceTools | undefined {
  return serviceTools.get(server)
}

export function statusText(ctx: ToolContext = {}) {
  const now = (ctx.now ?? (() => new Date()))()
  const os = platform() === 'darwin' ? '맥' : platform() === 'win32' ? '윈도우' : platform()
  const time = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now)
  return `두리 연결됨 · ${os}(${arch()}) · 지금 ${time} (한국 시간)`
}

export function createServer(ctx: ToolContext = {}) {
  const server = new McpServer({ name: SERVER_NAME, version: '0.0.0' })
  server.registerTool(
    'status',
    {
      title: '두리 상태',
      description:
        '두리와 이 PC의 연결 상태와 지금 한국 시각을 알려 준다. 시각이나 연결 상태가 필요할 때 쓴다.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: 'text', text: statusText(ctx) }] }),
  )
  registerSkillTools(server, ctx.skills ?? daemonClient(process.env, 'skill'))
  registerBrowserTools(server, ctx.browser ?? daemonClient())
  registerScreenTools(server, ctx.screen ?? daemonClient(process.env, 'screen'))
  registerLifeTools(server, ctx.life ?? daemonClient(process.env, 'life'))
  serviceTools.set(
    server,
    registerServiceTools(server, ctx.services ?? daemonClient(process.env, 'service'), {
      ...(ctx.servicePollMs ? { pollMs: ctx.servicePollMs } : {}),
    }),
  )
  return server
}

/** 실행기가 띄우는 서버: 연결한 서비스의 도구를 먼저 받아 둔 뒤 (늦어도 3초) 연결한다 */
export async function createReadyServer(ctx: ToolContext = {}) {
  const server = createServer(ctx)
  await Promise.race([servicesOf(server)?.sync(), new Promise((r) => setTimeout(r, 3000).unref?.())])
  return server
}
