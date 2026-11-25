/**
 * Dool2's own tools that only read and do not work in the browser, on the screen or in apps (readOnlyHint, minus
 * browser_*, screen_*, kakao_*). The before-finishing check (ADR 0027) does not judge a request that took one or two
 * of these and nothing else. tools.test.ts keeps this list in step with the tool annotations
 */
export const LOOKUP_TOOLS: ReadonlySet<string> = new Set([
  'status',
  'goal_list',
  'library_find',
  'know_find',
  'photo_view',
  'profile_view',
  'pay_method_list',
  'vault_find',
  'feed_find',
  'conversation_search',
  'file_find',
  'file_read',
  'service_find',
  'orders_all',
  'tool_find',
  // The conversation's view of its tasks (ADR 0038)
  'task_list',
])
