// Lock the PC screen and sleep (ADR 0024 addendum). Done right after approval. Shutdown is not built (unsaved work could be lost).
// - macOS: lock = turn the screen off (pmset displaysleepnow) + check the "require password when the screen is off" setting (sysadminctl -screenLock status),
//   sleep = pmset sleepnow. Neither needs administrator rights
// - Windows: lock = LockWorkStation, sleep = SetSuspendState (standby)
import type { Lang } from '@dool2/i18n'
import type { Exec } from './file-ops.js'
import { PC_POWER_TEXT } from './locales/pc-power.js'

export type PowerAction = 'lock' | 'sleep'

export const POWER_LABEL: Record<PowerAction, string> = {
  lock: PC_POWER_TEXT.ko.lock,
  sleep: PC_POWER_TEXT.ko.sleep,
}

/** Name of the action for the approval card, in the user's language */
export const powerLabel = (action: PowerAction, lang: Lang = 'ko'): string => PC_POWER_TEXT[lang][action]

/** Mac lock password setting: 'immediate' | seconds | 'off' | undefined (unknown) */
export function parseScreenLock(out: string): 'immediate' | 'off' | number | undefined {
  if (/screenLock delay is immediate/i.test(out)) return 'immediate'
  const n = /screenLock delay is (\d+) seconds?/i.exec(out)?.[1]
  if (n) return Number(n)
  if (/screenLock is off/i.test(out)) return 'off'
  return undefined
}

/** Check before doing it: the reason if it cannot be done, otherwise something to note on the approval card (may be absent) */
export async function powerCheck(
  action: PowerAction,
  platform: NodeJS.Platform,
  exec: Exec,
  lang: Lang = 'ko',
): Promise<{ ok: false; why: string } | { ok: true; note?: string }> {
  if (platform === 'win32') return { ok: true }
  if (platform !== 'darwin')
    return { ok: false, why: 'This PC is not supported yet (macOS and Windows only).' }
  if (action === 'sleep') return { ok: true }
  const r = await exec('sysadminctl', ['-screenLock', 'status'], { timeout: 10_000 })
  const v = parseScreenLock(`${r.stdout}\n${r.stderr}`)
  if (v === 'off')
    return {
      ok: false,
      why: 'This Mac does not ask for a password after the screen turns off, so it cannot be locked. Tell the user to set System Settings > Lock Screen > "Require password after screen saver begins or display is turned off" to "Immediately". Sleep still works.',
    }
  if (typeof v === 'number' && v > 5)
    return {
      ok: true,
      note: PC_POWER_TEXT[lang].slowLock(v),
    }
  return { ok: true }
}

/** Actually do it */
export async function powerDo(
  action: PowerAction,
  platform: NodeJS.Platform,
  exec: Exec,
): Promise<string | undefined> {
  const r =
    platform === 'win32'
      ? action === 'lock'
        ? await exec('rundll32.exe', ['user32.dll,LockWorkStation'])
        : await exec('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)",
          ])
      : await exec('pmset', [action === 'lock' ? 'displaysleepnow' : 'sleepnow'])
  return r.code === 0 ? undefined : r.stderr.split('\n')[0]?.slice(0, 160) || 'Failed'
}

/** Next step to give when asked to shut down */
export const POWER_OFF_TEXT =
  'Doori does not shut the PC down (open documents and unsaved work could be lost). Suggest sleep (action: "sleep") instead: it uses almost no power and everything is as it was when reopened. If it must be turned off, tell the user to save and shut it down themselves.'
