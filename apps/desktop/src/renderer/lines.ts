// Turn a daemon event (@dool2/agentd AgentdEvent) into one line the chat shows — or nothing. This is the seam that
// keeps raw tool JSON away from the user (AGENTS.md §6: show a friendly "read the page" line, not the tool payload).
// It is pure and
// framework-free so it can be unit-tested in node; the renderer paints whatever it returns.
//
// The rules:
//   - text           -> a message bubble from Dool2 (the brain's own words).
//   - tool_call(code) -> a compact "work" step, classified from the code into one WorkKey. The code string and its
//                        args are NEVER returned — only the WorkKey the renderer renders in the user's language.
//   - tool_result     -> null. Results feed the brain, not the user; showing them would dump JSON.
//   - notice          -> a small note (an after-the-fact "done: …" from the engine).
//   - approvalNeeded  -> an approval card (label + optional amount); the phone signs it, not this screen.
//   - blocked         -> a note that a hard-capped action did not run.
//   - thinking/gate/turn_end -> null (internal; the activity log, not the chat).

import type { AgentdEvent } from '@dool2/agentd'
import type { WorkKey } from './locales/app.js'

/** One thing to draw in the transcript, already stripped of anything secret or raw. */
export type UiLine =
  | { role: 'dool2'; text: string }
  | { role: 'work'; key: WorkKey }
  | { role: 'note'; text: string }
  | { role: 'approval'; label: string; amountKrw?: number }
  | { role: 'blocked'; label: string }

/** Classify a `code` tool call into a friendly step. Looks only at method names in the code, never echoes the code. */
export function classifyCode(code: string): WorkKey {
  const c = code.toLowerCase()
  // Order matters: a login/fill or a pdf is more specific than a bare navigate/read, so test those first.
  if (/\bvault\.(filllogin|filltotp)\b/.test(c)) return 'login'
  if (/\bvault\.fillpaymentpin\b|\bpage\.fill\b/.test(c)) return 'fill'
  if (/\bpage\.pdf\b/.test(c)) return 'pdf'
  if (/\bpage\.(click|press)\b/.test(c)) return 'click'
  if (/\bpage\.type\b/.test(c)) return 'fill'
  if (/\bpage\.(goto|navigate)\b/.test(c)) return 'open'
  if (/\bpage\.(snapshot|read|fetch)\b/.test(c)) return 'read'
  return 'run'
}

/** Map one daemon event to a line, or null when it is internal / must not be shown to the user. */
export function lineFor(event: AgentdEvent): UiLine | null {
  switch (event.type) {
    case 'text': {
      const text = event.text.trim()
      return text ? { role: 'dool2', text } : null
    }
    case 'tool_call': {
      if (event.name !== 'code') return { role: 'work', key: 'run' }
      const code =
        typeof (event.args as { code?: unknown })?.code === 'string'
          ? (event.args as { code: string }).code
          : ''
      return { role: 'work', key: classifyCode(code) }
    }
    case 'notice': {
      const text = event.text.trim()
      return text ? { role: 'note', text } : null
    }
    case 'approvalNeeded':
      return {
        role: 'approval',
        label: event.card.label,
        ...(event.card.amountKrw !== undefined ? { amountKrw: event.card.amountKrw } : {}),
      }
    case 'blocked':
      return { role: 'blocked', label: event.label }
    default:
      // thinking, tool_result, gate, turn_end — nothing the user should read as a chat line.
      return null
  }
}
