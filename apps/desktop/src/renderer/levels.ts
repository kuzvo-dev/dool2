// The autonomy-level selector (ADR 0047: ask / auto / full-auto). The <select> carries the AutonomyLevel value
// itself ('ask' | 'auto' | 'full'); this module labels those three and guards a value coming back from the DOM so a
// bad string can never reach agentd.setLevel. Korean labels live in the locale file (locales/app.ts).

import type { AutonomyLevel } from '@dool2/core'

/** The three levels in the order they are shown, least to most autonomous. */
export const LEVELS: readonly AutonomyLevel[] = ['ask', 'auto', 'full']

/** Narrow an untrusted string (a DOM value) to an AutonomyLevel, defaulting to the safest level. */
export function toLevel(value: string): AutonomyLevel {
  return (LEVELS as readonly string[]).includes(value) ? (value as AutonomyLevel) : 'ask'
}
