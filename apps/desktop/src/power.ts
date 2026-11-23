// Always awake (docs/architecture.md 7.1). Only changes settings the user agreed to.
// - Stay awake while working: only the system stays awake, the display may turn off (no admin rights needed)
// - Start Dool2 when the PC starts: registered as a login item, without a window
// Security settings like screen lock, auto login and disk encryption are never touched.
import type { Settings } from '@dool2/protocol'

export interface PowerApi {
  start(): number
  stop(id: number): void
}

/** Whether the PC should be kept from sleeping now */
export function shouldKeepAwake(settings: Pick<Settings, 'keepAwake'>, busy: boolean): boolean {
  if (settings.keepAwake === 'always') return true
  if (settings.keepAwake === 'working') return busy
  return false
}

/** Turns sleep blocking on and off whenever the settings or the working state change */
export class KeepAwake {
  private id: number | undefined

  constructor(private readonly power: PowerApi) {}

  get active() {
    return this.id !== undefined
  }

  update(settings: Pick<Settings, 'keepAwake'>, busy: boolean) {
    const want = shouldKeepAwake(settings, busy)
    if (want && this.id === undefined) this.id = this.power.start()
    if (!want && this.id !== undefined) {
      this.power.stop(this.id)
      this.id = undefined
    }
  }
}

/** Login item settings. Auto start opens without a window (in the tray) */
export function loginItemSettings(settings: Pick<Settings, 'launchAtLogin'>) {
  return { openAtLogin: settings.launchAtLogin === true, openAsHidden: true, args: ['--hidden'] }
}
