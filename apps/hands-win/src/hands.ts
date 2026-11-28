/**
 * The command handlers. Each mirrors a @dool2/hands-mac command and returns the same result shape, so the daemon drives
 * either helper with one adapter. Decisions about which apps may be controlled and which buttons are risky are the
 * daemon's (ADR 0047); this layer only enforces the floor safety rules (safety.ts) and never lets a password value out.
 *
 * App identity on the wire: commands take the app under `bundleId` exactly like hands-mac (also accepted as `app`). On
 * Windows the value is the process image name / AUMID — an opaque id to the daemon, so the command shapes are identical
 * across platforms.
 */
import type { UiaApp, UiaBackend } from './backend.js'
import { MSG } from './locales/messages.js'
import { checkAllowed, destructiveReason, fail } from './safety.js'
import { buildSnapshot, type RefInfo } from './snapshot.js'

export interface CommandArgs {
  [key: string]: unknown
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** Read the app id from either `bundleId` (hands-mac's key) or `app`. */
function appId(args: CommandArgs): string {
  const id = str(args.bundleId) ?? str(args.app)
  if (!id) throw fail(MSG.noAppArg)
  return id
}

export class Hands {
  private refs = new Map<string, RefInfo>()
  private refsApp = ''

  constructor(private readonly backend: UiaBackend) {}

  /** The command names this helper answers, mirroring @dool2/hands-mac (read/screen_read are aliases of snapshot). */
  static readonly COMMANDS = [
    'status',
    'request',
    'apps',
    'installed',
    'open',
    'snapshot',
    'read',
    'screen_read',
    'click',
    'type',
    'key',
    'screenshot',
  ] as const

  async run(cmd: string, args: CommandArgs): Promise<unknown> {
    switch (cmd) {
      case 'status':
        return this.status()
      case 'request':
        return this.request()
      case 'apps':
        return this.apps()
      case 'installed':
        return this.installed()
      case 'open':
        return this.open(args)
      case 'snapshot':
      case 'read':
      case 'screen_read':
        return this.snapshot(args)
      case 'click':
        return this.click(args)
      case 'type':
        return this.type(args)
      case 'key':
        return this.key(args)
      case 'screenshot':
        return this.screenshot(args)
      default:
        throw fail(MSG.unknownCommand(cmd))
    }
  }

  private async status(): Promise<Record<string, unknown>> {
    const s = await this.backend.status()
    // Shape mirrors hands-mac: accessibility=UIA availability; screenRecording=window capture (available on Windows).
    return { accessibility: s.uiAutomation, screenRecording: true, locked: s.locked, platform: 'win' }
  }

  /**
   * Opens the UIA/consent prompt if the host has one. On Windows UIA needs no per-app grant the way macOS does, so this
   * returns the current status. First-time per-app approval (the owner/consent model) is the DAEMON's job, not the
   * helper's — this command is the seam the daemon drives when it wants to surface a consent step.
   */
  private async request(): Promise<Record<string, unknown>> {
    return this.status()
  }

  private async apps(): Promise<Array<Record<string, unknown>>> {
    const apps = await this.backend.apps()
    return apps.map((a) => ({ bundleId: a.app, name: a.name, pid: a.pid, active: a.active }))
  }

  private async installed(): Promise<Array<Record<string, unknown>>> {
    const apps = await this.backend.installed()
    return apps.map((a) => ({
      bundleId: a.app,
      name: a.name,
      ...(a.installing ? { installing: true } : {}),
    }))
  }

  private async open(args: CommandArgs): Promise<Record<string, unknown>> {
    const id = appId(args)
    checkAllowed(id)
    await this.backend.launch(id)
    return { bundleId: id, opened: true }
  }

  private async displayName(id: string): Promise<string> {
    const apps = await this.backend.apps().catch((): UiaApp[] => [])
    return apps.find((a) => a.app === id)?.name ?? id
  }

  private async snapshot(args: CommandArgs): Promise<Record<string, unknown>> {
    const id = appId(args)
    checkAllowed(id)
    const maxChars = num(args.maxChars) ?? 12000
    const windows = await this.backend.tree(id)
    if (windows.length === 0) throw fail(MSG.noWindow)
    const snap = buildSnapshot(windows, maxChars)
    this.refs = snap.refs
    this.refsApp = id
    return {
      app: await this.displayName(id),
      bundleId: id,
      window: snap.window,
      text: snap.text,
      truncated: snap.truncated,
    }
  }

  private ref(id: string, ref: string): RefInfo {
    const info = this.refsApp === id ? this.refs.get(ref) : undefined
    if (!info) throw fail(MSG.refNotFound(ref))
    return info
  }

  private async click(args: CommandArgs): Promise<Record<string, unknown>> {
    const id = appId(args)
    checkAllowed(id)
    const ref = str(args.ref)
    if (ref) {
      const info = this.ref(id, ref)
      await this.backend.clickElement(info.handle)
      return { via: 'element' }
    }
    const x = num(args.x)
    const y = num(args.y)
    if (x === undefined || y === undefined) throw fail(MSG.noClickTarget)
    await this.backend.clickPoint(id, x, y)
    return { via: 'point' }
  }

  private async type(args: CommandArgs): Promise<Record<string, unknown>> {
    const id = appId(args)
    checkAllowed(id)
    const text = str(args.text)
    if (!text) throw fail(MSG.noText)
    const clipped = text.slice(0, 4000)
    const ref = str(args.ref)
    if (ref) {
      const info = this.ref(id, ref)
      if (info.isPassword) throw fail(MSG.passwordRefused)
      await this.backend.focus(info.handle)
      await this.backend.setValue(info.handle, clipped)
    } else {
      await this.backend.typeText(id, clipped)
    }
    return { typed: clipped.length }
  }

  private async key(args: CommandArgs): Promise<Record<string, unknown>> {
    const id = appId(args)
    checkAllowed(id)
    const key = str(args.key)
    if (!key) throw fail(MSG.noKey)
    const modifiers = Array.isArray(args.modifiers) ? (args.modifiers as unknown[]).map(String) : []
    const reason = destructiveReason(key, modifiers)
    if (reason) throw fail(reason)
    await this.backend.sendKey(id, key, modifiers)
    return { pressed: key }
  }

  private async screenshot(args: CommandArgs): Promise<Record<string, unknown>> {
    const id = appId(args)
    checkAllowed(id)
    const maxWidth = Math.min(Math.max(num(args.maxWidth) ?? 1280, 320), 1600)
    const shot = await this.backend.screenshot(id, maxWidth)
    return {
      mime: shot.mime,
      data: shot.data,
      window: shot.window,
      width: shot.width,
      height: shot.height,
    }
  }
}
