// Conversation and task sessions (ADR 0038). With task sessions on, the main conversation talks, remembers, looks
// things up and shows results; work in the browser, in PC apps and on PC files runs in a task session it starts with
// task_start. The daemon tells each tool server which kind it serves (DOOL2_SESSION) and checks the same split on
// every call, so this list is not the only fence.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** conversation: the main conversation with task sessions on. task: a task session. Missing: every tool, as before */
export type SessionKind = 'conversation' | 'task'

export function sessionKind(v: string | undefined): SessionKind | undefined {
  return v === 'conversation' || v === 'task' ? v : undefined
}

/**
 * Tools only a task session has: the browser, PC app control and KakaoTalk, PC files (and the video, picture and PDF
 * tools that work on them), the PC's power, and texting from the phone
 */
export const TASK_ONLY = /^(browser_|screen_|kakao_|file_|video_|image_make$|pc_screen$|phone_sms$)/

/** Tools only the conversation has: a task cannot start or steer tasks */
export const CONVERSATION_ONLY = /^task_/

/**
 * Whether a session of this kind gets the tool. Without a kind (side chats, the feed, older builds) every tool but the
 * task tools, as before task sessions
 */
export function toolInSession(name: string, kind: SessionKind | undefined): boolean {
  return kind === 'conversation' ? !TASK_ONLY.test(name) : !CONVERSATION_ONLY.test(name)
}

/** Wraps the server so tools a session of this kind does not get are never registered (neither listed nor kept for tool_find) */
export function sessionFence(server: McpServer, kind: SessionKind | undefined): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool')
        // biome-ignore lint/suspicious/noExplicitAny: same signature as McpServer.registerTool
        return (name: string, config: any, handler: any) =>
          toolInSession(name, kind) ? target.registerTool(name, config, handler) : undefined
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as McpServer
}
