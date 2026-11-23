// Installs a downloaded update (per platform). Updater only passes files whose signature and checksum match.
// - Mac: unzip next to the current app, swap the app bundle and restart. Files the app downloads itself get no
//   "downloaded from the internet" flag, so the first-install "Open anyway" does not come back. The same certificate
//   keeps macOS permissions and the vault (ADR 0028)
// - Windows: run the installer silently (/S), have it restart the app when done (--force-run), then quit
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Lang } from '@dool2/i18n'
import { updateText } from './locales/update.js'

const run = (bin: string, args: string[]) =>
  new Promise<void>((res, rej) =>
    execFile(bin, args, { timeout: 5 * 60_000 }, (e, _o, err) =>
      e ? rej(new Error(`${basename(bin)}: ${String(err || e.message).slice(0, 300)}`)) : res(),
    ),
  )

/** App bundle from the executable path (…/Dool2.app/Contents/MacOS/Dool2 → …/Dool2.app) */
export function appBundle(exe: string): string | undefined {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)
  return m?.[1]
}

export interface InstallDeps {
  exe: string
  /** Closes the daemon and restarts (Mac) */
  relaunch: () => Promise<void>
  /** Closes the daemon and quits (Windows: the installer restarts the app) */
  quit: () => Promise<void>
  platform?: NodeJS.Platform
  run?: typeof run
  spawnDetached?: (file: string, args: string[]) => void
  /** Language of errors shown in the update notice (default Korean) */
  lang?: Lang
}

export async function installUpdate(file: string, d: InstallDeps): Promise<void> {
  const platform = d.platform ?? process.platform
  const exec = d.run ?? run
  const m = updateText(d.lang ?? 'ko')
  if (platform === 'darwin') {
    const bundle = appBundle(d.exe)
    if (!bundle) throw new Error(m.notInstalled)
    const parent = dirname(bundle)
    // Unzip in the same folder (same disk) so the swap is a single rename
    const tmp = join(parent, `.dool2-update-${Date.now()}`)
    try {
      await exec('/usr/bin/ditto', ['-x', '-k', file, tmp])
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      const msg = (e as Error).message
      throw new Error(/Permission denied|Operation not permitted/i.test(msg) ? m.noWriteAccess(parent) : msg)
    }
    const fresh = (await readdir(tmp)).find((n) => n.endsWith('.app'))
    if (!fresh) {
      await rm(tmp, { recursive: true, force: true })
      throw new Error(m.noAppInZip)
    }
    // Check the new app is properly signed (never swap in a broken bundle)
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(tmp, fresh)])
    const old = `${bundle}.old-${Date.now()}`
    await rename(bundle, old)
    try {
      await rename(join(tmp, fresh), bundle)
    } catch (e) {
      await rename(old, bundle).catch(() => undefined)
      throw e
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    await rm(old, { recursive: true, force: true }).catch(() => undefined)
    await rm(file, { force: true }).catch(() => undefined)
    await d.relaunch()
    return
  }
  if (platform === 'win32') {
    if (!existsSync(file)) throw new Error(m.noFile)
    const start =
      d.spawnDetached ??
      ((f: string, args: string[]) => spawn(f, args, { detached: true, stdio: 'ignore' }).unref())
    start(file, ['/S', '--force-run'])
    await d.quit()
    return
  }
  throw new Error(m.unsupportedOs)
}
