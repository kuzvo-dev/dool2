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

/** Tools that start and steer tasks: only the conversation has them (a task cannot start tasks) */
export const TASK_CONTROL = /^task_/

/**
 * What the conversation owns and a task does not get (harness overhaul round 2): managing memory, goals, the library,
 * the feed and what Dool2 knows, and which AI it runs on. A task that needs a saved value gets it in its spec's known
 * values or with one lookup (know_find, profile_view, vault_find)
 */
export const CONVERSATION_OWNS =
  /^(goal_|memory_|library_|feed_|idea_suggest$|know_save$|know_update$|recipe_forget$|ai_use$)/

/** Tools only the conversation has */
export const CONVERSATION_ONLY = new RegExp(`${TASK_CONTROL.source}|${CONVERSATION_OWNS.source}`)

/**
 * Whether a session of this kind gets the tool. Without a kind (side chats, the feed, the conversation with task
 * sessions off, older builds) every tool but the task tools, as before task sessions
 */
export function toolInSession(name: string, kind: SessionKind | undefined): boolean {
  if (kind === 'conversation') return !TASK_ONLY.test(name)
  if (TASK_CONTROL.test(name)) return false
  return kind !== 'task' || !CONVERSATION_OWNS.test(name)
}

/**
 * Tools each kind keeps aside (tool_find / tool_call, ADR 0033) on top of ON_DEMAND_TOOLS, recounted from the work
 * log per kind of turn (2026-11-19 to 11-25: 1,607 talk-only turns, 1,195 turns with browser, app or file work).
 * Approval, payment, sign-in and hand-off tools of the browser stay listed in tasks
 */
export const ASIDE_BY_KIND: Record<SessionKind, readonly string[]> = {
  // 0 to 12 calls in 1,607 talk-only turns each
  conversation: [
    'status',
    'memory_forget',
    'pay_method_list',
    'library_save',
    'feed_tell',
    'orders_all',
    'know_update',
    'goal_update',
  ],
  // 0 to 22 calls in 1,195 work turns each; the conversation shows most results, the task's answer is its one result
  task: [
    'status',
    'browser_back',
    'browser_route',
    'browser_request_tap',
    'show_cards',
    'show_result',
    'kakao_send',
    'phone_sms',
    'conversation_search',
    'photo_view',
    'pay_method_list',
    'orders_all',
  ],
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
