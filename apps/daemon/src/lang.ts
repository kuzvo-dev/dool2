// Language for text the daemon writes for people: notifications, feed items, card titles (ADR 0029).
// Text for the AI (prompts, tool descriptions, tool results) is always English.
import { initialLang, type Lang } from '@dool2/i18n'
import type { Settings } from '@dool2/protocol'

export function userLang(settings: Pick<Settings, 'language'>): Lang {
  return initialLang(settings.language, [Intl.DateTimeFormat().resolvedOptions().locale])
}
