// Native messaging host registration. Chrome reads a manifest (JSON) in a fixed location and starts the host.
//   macOS:   ~/Library/Application Support/<browser>/NativeMessagingHosts/<name>.json
//   Linux:   ~/.config/<browser>/NativeMessagingHosts/<name>.json
//   Windows: HKCU\Software\<browser>\NativeMessagingHosts\<name> (default value = manifest path)
// Writes only to the user folder and user registry (no admin rights).
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-location
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { runOnce } from '@dool2/engine'
import { BROWSER_HOST_NAME, EXTENSION_IDS } from '@dool2/protocol'
import type { Exec } from './chrome.js'

/** Program that starts the host. The packaged app runs Electron as Node (ELECTRON_RUN_AS_NODE) */
export interface HostRuntime {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface RegisterOptions {
  dataDir: string
  runtime: HostRuntime
  platform?: NodeJS.Platform
  home?: string
  extensionIds?: string[]
  /** Extra folders for the manifest (e.g. --user-data-dir/NativeMessagingHosts of a test Chrome) */
  extraDirs?: string[]
  /** When false, skip the browsers' default locations and use only extraDirs (for checks and tests) */
  defaultTargets?: boolean
  exec?: Exec
}

export interface Registration {
  launcher: string
  manifest: string
  /** Folders the manifest was copied to, or registry keys */
  targets: string[]
}

/** Per-browser user registration locations. Chrome is the default; the rest are Chromium browsers that run the same extension */
export function hostTargets(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32')
    return [
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BROWSER_HOST_NAME}`,
      `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${BROWSER_HOST_NAME}`,
      `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${BROWSER_HOST_NAME}`,
    ]
  if (platform === 'darwin') {
    const base = posix.join(home, 'Library', 'Application Support')
    return ['Google/Chrome', 'Google/Chrome for Testing', 'Chromium', 'Microsoft Edge'].map((b) =>
      posix.join(base, b, 'NativeMessagingHosts'),
    )
  }
  const base = posix.join(home, '.config')
  return ['google-chrome', 'chromium', 'microsoft-edge'].map((b) =>
    posix.join(base, b, 'NativeMessagingHosts'),
  )
}

/** Script Chrome runs. Chrome only takes an executable path, so arguments and environment go here */
export function launcherScript(platform: NodeJS.Platform, dataDir: string, rt: HostRuntime): string {
  const env = { ...rt.env, DOOL2_DATA_DIR: dataDir }
  if (platform === 'win32') {
    const sets = Object.entries(env).map(([k, v]) => `set "${k}=${v}"`)
    const cmd = [rt.command, ...rt.args].map((a) => `"${a}"`).join(' ')
    return ['@echo off', ...sets, `${cmd} %*`, ''].join('\r\n')
  }
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const sets = Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`)
  return ['#!/bin/sh', ...sets, `exec ${[rt.command, ...rt.args].map(q).join(' ')} "$@"`, ''].join('\n')
}

export function hostManifest(launcher: string, extensionIds: string[]) {
  return {
    name: BROWSER_HOST_NAME,
    description: 'Dool2 — the AI assistant that lives in your computer',
    path: launcher,
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  }
}

/** Makes the launch script and manifest and puts them in the browsers' locations. Idempotent */
export async function registerNativeHost(opts: RegisterOptions): Promise<Registration> {
  const platform = opts.platform ?? process.platform
  // Files are written on this computer, so paths follow the running OS (platform only decides the script format and registration method)
  const dir = join(opts.dataDir, 'native-host')
  await mkdir(dir, { recursive: true })

  const launcher = join(dir, platform === 'win32' ? 'dool2-host.bat' : 'dool2-host.sh')
  await writeFile(launcher, launcherScript(platform, opts.dataDir, opts.runtime), { mode: 0o755 })
  if (platform !== 'win32') await chmod(launcher, 0o755)

  const body = `${JSON.stringify(hostManifest(launcher, opts.extensionIds ?? EXTENSION_IDS), null, 2)}\n`
  const manifest = join(dir, `${BROWSER_HOST_NAME}.json`)
  await writeFile(manifest, body)

  const builtIn = opts.defaultTargets === false ? [] : hostTargets(platform, opts.home ?? homedir())
  const targets = [...builtIn, ...(opts.extraDirs ?? [])]
  const done: string[] = []
  const exec = opts.exec ?? ((cmd, args) => runOnce(cmd, args, { timeoutMs: 15_000 }))
  for (const [i, target] of targets.entries()) {
    try {
      if (target.startsWith('HKCU\\')) {
        const r = await exec('reg', ['add', target, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f'])
        if (r.code !== 0) continue
      } else {
        // Chrome (first) gets it even if not installed yet (Dool2 may install it soon). The rest only if installed
        if (i > 0 && i < builtIn.length && !(await exists(join(target, '..')))) continue
        await mkdir(target, { recursive: true })
        await writeFile(join(target, `${BROWSER_HOST_NAME}.json`), body)
      }
      done.push(target)
    } catch {
      // Keep going with the others even if one browser fails
    }
  }
  return { launcher, manifest, targets: done }
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )
