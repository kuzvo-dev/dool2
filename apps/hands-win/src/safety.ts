/**
 * The safety rules that live in the helper itself, independent of the daemon. The daemon decides which apps may be
 * controlled, which buttons are risky, and when a phone signature is needed (ADR 0047); but these lines are enforced
 * here too, so a daemon mistake cannot cross them:
 *
 *   1. Browsers, password managers and Dool2 itself are never driven by PC screen control (browsers go through the
 *      hidden-Chromium browser tools, ADR 0046; a password manager's window must never be touched by the AI).
 *   2. A password / secure field's value is never read or emitted, and type refuses it (enforced in snapshot.ts and
 *      hands.ts, documented here for one place to read the rules).
 *   3. Destructive key combinations (close/quit the app, system-level shortcuts) are refused.
 *
 * Mirrors @dool2/hands-mac's hardBlocked list and its refusal of secure fields; adds the destructive-combo refusal the
 * Windows helper is asked to enforce.
 */
import { MSG } from './locales/messages.js'

/** Error carrying a user-facing reason (copy in ./locales/messages.ts), matching the helper's error shape. */
export class HandsError extends Error {}

export function fail(message: string): HandsError {
  return new HandsError(message)
}

/**
 * Apps never driven by PC screen control, whatever the daemon asks. Matched case-insensitively against the app id
 * (the process image name on Windows, e.g. `chrome.exe`). The macOS helper blocks the same set of browsers and
 * password managers by bundle id; here they are Windows process names, plus Dool2's own process.
 */
export const HARD_BLOCKED: readonly string[] = [
  // Browsers — driven only through the hidden-Chromium browser tools, never as a native window.
  'chrome.exe',
  'msedge.exe',
  'firefox.exe',
  'brave.exe',
  'opera.exe',
  'whale.exe',
  'iexplore.exe',
  'arc.exe',
  // Password managers — their windows are off-limits to the AI.
  '1password.exe',
  'bitwarden.exe',
  'keepass.exe',
  'keepassxc.exe',
  'dashlane.exe',
  // Dool2 itself.
  'dool2.exe',
]

/** The Dool2 app's own process name prefix, blocked like hands-mac blocks the `com.dool2.` bundle prefix. */
const DOOL2_PREFIX = 'dool2'

/** Throw if this app id must never be driven by PC screen control. */
export function checkAllowed(app: string): void {
  const id = app.trim().toLowerCase()
  if (!id) throw fail(MSG.noApp)
  if (HARD_BLOCKED.includes(id) || id.startsWith(DOOL2_PREFIX)) {
    throw fail(MSG.blockedApp(app))
  }
}

const MOD_ALIASES: Record<string, string> = {
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  windows: 'meta',
  super: 'meta',
  meta: 'meta',
  control: 'ctrl',
  ctrl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
}

/** Normalize a modifier list to the canonical set {meta, ctrl, alt, shift}, sorted, deduped. Throws on an unknown. */
export function normalizeModifiers(mods: readonly string[]): string[] {
  const out = new Set<string>()
  for (const m of mods) {
    const norm = MOD_ALIASES[m.toLowerCase()]
    if (!norm) throw fail(MSG.unknownModifier(m))
    out.add(norm)
  }
  return [...out].sort()
}

/**
 * Whether a key + modifiers is a destructive combo the helper refuses, with the reason (copy in ./locales/messages.ts).
 * Returns null when the combo is fine. Refused:
 *   - Alt+F4: closes / quits the current app (data loss).
 *   - Any combo using the Windows/meta key: system-level shortcuts (lock, show desktop, run), not within-app acting.
 *   - Ctrl+Shift+Esc / Ctrl+Alt+Delete: Task Manager / secure attention sequence.
 * The daemon may still refuse more by context; this is the floor the helper never crosses.
 */
export function destructiveReason(key: string, modifiers: readonly string[]): string | null {
  const mods = new Set(normalizeModifiers(modifiers))
  const kLower = key.trim().toLowerCase()
  if (mods.has('alt') && kLower === 'f4') return MSG.altF4
  if (mods.has('meta')) return MSG.metaKey
  if (mods.has('ctrl') && mods.has('shift') && kLower === 'escape') return MSG.taskManager
  if (mods.has('ctrl') && mods.has('alt') && kLower === 'delete') return MSG.secureAttention
  return null
}
