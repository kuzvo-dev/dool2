// UI language of the phone app (ADR 0029). Each device has its own; the phone follows the phone.
// Read once at start, before anything renders. Changing it reloads the app.
import { initialLang, type Lang } from '@dool2/i18n'

const KEY = 'dool2.lang'

function saved(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export const lang: Lang = initialLang(saved(), navigator.languages)

/** Saves the user's choice (from the phone's settings) and reloads if it changed. `undefined` = follow the phone. */
export function setLang(choice: Lang | undefined): void {
  try {
    if (choice) localStorage.setItem(KEY, choice)
    else localStorage.removeItem(KEY)
  } catch {}
  if (initialLang(choice, navigator.languages) !== lang) location.reload()
}
