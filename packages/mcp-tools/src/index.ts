// 두리 MCP 도구. Claude Code·Codex가 자식 프로세스로 띄운다.
// M0: 연결 확인용 도구만 있다. M1부터 브라우저·허락 도구가 붙고, 실제 실행은 dool2d에 IPC로 넘긴다
// (docs/architecture.md 2장 — 브라우저 상태와 승인 게이트는 dool2d 한 곳에만 둔다).
import { arch, platform } from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export const SERVER_NAME = 'dool2'

export interface ToolContext {
  now?: () => Date
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
  return server
}
