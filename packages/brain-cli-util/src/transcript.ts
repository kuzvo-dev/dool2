// Map the shared TurnInput transcript to a plain-text prompt the CLI reads. The daemon assembles the system prompt and
// the running transcript (user turns, the assistant's own turns, and tool results it fed back); this renders the
// messages into one block. The system prompt is passed separately by each adapter through the CLI's own system flag.
//
// The adapters are stateless per run, like @dool2/brain-pi: each run() sends the whole transcript, and when the CLI
// asks for a tool the adapter ends the turn so the daemon can run the tool and call run() again with the result
// appended. Secrets never appear here — the daemon only ever puts masked values in a tool result.

import type { TurnInput } from '@dool2/core'

const ROLE_LABEL: Record<TurnInput['messages'][number]['role'], string> = {
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool result',
}

/** Render the transcript messages into one prompt string. Returns '' when there are no messages. */
export function renderTranscript(input: TurnInput): string {
  return input.messages.map((m) => `${ROLE_LABEL[m.role]}: ${m.content}`).join('\n\n')
}
