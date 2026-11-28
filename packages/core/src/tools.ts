// The few tools the brain drives (v2: few tools, big hands). A code-execution tool does the broad work (page, vault,
// PC apps, files); the rest are the small deliberate ones. Each tool call passes through the autonomy gate before it
// runs. This file is the shared vocabulary between the core, the brains, and the daemon.

import type { ActionTier } from './autonomy.js'

/** The small, fixed tool set. New site abilities arrive as skills, not as new tools. */
export type ToolName = 'code' | 'ask' | 'approve' | 'task' | 'memory'

export interface ToolSpec {
  name: ToolName
  /** One line the brain sees: when to use it. */
  description: string
}

export interface ToolCall {
  id: string
  name: ToolName
  /** JSON arguments as the brain produced them. */
  args: unknown
}

export interface ToolResult {
  id: string
  /** Plain text or structured data the brain reads back. Secrets are never placed here. */
  content: string
  isError?: boolean
}

/** A single step the gate must weigh (produced while a `code` tool runs and wants to act on a page). */
export interface GatedAction {
  tier: ActionTier
  /** Human label for the approval card / log, e.g. the button text or "송금 50,000원". */
  label: string
  amountKrw?: number
  merchantKnown?: boolean
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'code',
    description:
      'Run code to read and act on the open page, the vault, PC apps, and files. The broad hand: prefer the data path (the site API with the user session) before clicking.',
  },
  { name: 'ask', description: 'Ask the user a question only when nothing else can resolve it.' },
  { name: 'approve', description: 'Request a phone signature for a pay/contact/delete action.' },
  { name: 'task', description: 'Start or hand off a background task, or spawn a subagent.' },
  { name: 'memory', description: 'Search or write the user memory.' },
]
