// UI language of the desktop window (ADR 0029).
// Starts from the last language used (saved in localStorage) and is settled from settings before the first screen
// renders, so the window never flashes the wrong language. Changing it later in Settings reloads the window.
import { deviceRegion, initialLang, type Lang, type Region } from './i18n.js'

const KEY = 'dool2.lang'

function saved(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export let lang: Lang = initialLang(saved(), navigator.languages, deviceRegion(navigator.languages))

/** Settles the language from settings. Returns true if it changed. Call before rendering. */
export function syncLang(setting: Lang | undefined, region?: Region): boolean {
  const want = initialLang(setting, navigator.languages, region ?? deviceRegion(navigator.languages))
  if (want === lang) return false
  lang = want
  try {
    localStorage.setItem(KEY, want)
  } catch {}
  return true
}

/** After the user picks a language in Settings: save it and redraw everything. */
export function switchLang(setting: Lang | undefined, region?: Region): void {
  if (syncLang(setting, region)) location.reload()
}
