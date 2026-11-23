// Language for text the daemon writes for people: notifications, feed items, card titles (ADR 0029).
// Text for the AI (prompts, tool descriptions, tool results) is always English.
import { deviceRegion, initialLang, type Lang } from '@dool2/i18n'
import type { Settings } from '@dool2/protocol'

export function userLang(settings: Pick<Settings, 'language' | 'region'>): Lang {
  const locale = [Intl.DateTimeFormat().resolvedOptions().locale]
  return initialLang(settings.language, locale, settings.region ?? deviceRegion(locale))
}
