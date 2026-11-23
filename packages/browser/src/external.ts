// External extension registration: puts the Dool2 extension in Chrome and Edge as "pending install". The next time
// the browser starts it shows "New extension added · [Enable]", and the user presses it once.
//   macOS:   ~/Library/Application Support/<browser>/External Extensions/<id>.json
//            (inside the browser data folder, which fits a normal Chrome using the default data folder.
//             Checked 2026-11-17 on macOS Chrome 157: fetched from the Web Store and installed as "pending enable")
//            {"external_update_url": "<Web Store update URL>"}
//   Windows: <root>\Software\<browser>\Extensions\<id>  value update_url = <Web Store update URL>
// - On macOS and Windows only extensions published on the Web Store install this way (not a local crx).
// - Browsers read this only at start. If already running, it shows the next time.
// - If the user removes the extension, it isn't reinstalled (the browser blocks it). Never force it back.
// - The official docs list only HKLM on Windows. Dool2 installs without admin rights, so it writes HKCU.
//   Chromium reads HKCU too, but it isn't documented, so check on real Windows (fallback: [Add] on the Web Store page).
// https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions
// https://learn.microsoft.com/microsoft-edge/extensions/developer-guide/alternate-distribution-options
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { runOnce } from '@dool2/engine'
import { CHROME_STORE_UPDATE_URL } from '@dool2/protocol'
import type { Exec } from './chrome.js'

export type ExternalTarget =
  | { kind: 'file'; browser: string; dir: string; file: string; body: string }
  | { kind: 'reg'; browser: string; key: string; value: string }

/** External extension registration location per browser. Edge also accepts the Chrome Web Store URL */
export function externalTargets(
  platform: NodeJS.Platform,
  home: string,
  id: string,
  updateUrl = CHROME_STORE_UPDATE_URL,
): ExternalTarget[] {
  if (!/^[a-p]{32}$/.test(id)) throw new Error(`Not an extension id: ${id}`)
  if (platform === 'win32')
    return [
      { browser: 'Chrome', path: 'Google\\Chrome' },
      { browser: 'Edge', path: 'Microsoft\\Edge' },
    ].map(({ browser, path }) => ({
      kind: 'reg',
      browser,
      key: `HKCU\\Software\\${path}\\Extensions\\${id}`,
      value: updateUrl,
    }))
  if (platform === 'darwin') {
    const base = posix.join(home, 'Library', 'Application Support')
    const body = `${JSON.stringify({ external_update_url: updateUrl })}\n`
    return [
      { browser: 'Chrome', dir: 'Google/Chrome' },
      { browser: 'Edge', dir: 'Microsoft Edge' },
    ].map(({ browser, dir }) => {
      const d = posix.join(base, dir, 'External Extensions')
      return { kind: 'file', browser, dir: d, file: posix.join(d, `${id}.json`), body }
    })
  }
  // Linux is not a release target (if needed: /opt/google/chrome/extensions, with admin rights)
  return []
}

export interface ExternalOptions {
  id: string
  platform?: NodeJS.Platform
  home?: string
  exec?: Exec
}

/** Registers the external extension. Idempotent. Returns where it was written (browser names) */
export async function registerExternalExtension(opts: ExternalOptions): Promise<string[]> {
  const platform = opts.platform ?? process.platform
  const exec = opts.exec ?? ((cmd, args) => runOnce(cmd, args, { timeoutMs: 15_000 }))
  const done: string[] = []
  for (const t of externalTargets(platform, opts.home ?? homedir(), opts.id)) {
    try {
      if (t.kind === 'reg') {
        const r = await exec('reg', ['add', t.key, '/v', 'update_url', '/t', 'REG_SZ', '/d', t.value, '/f'])
        if (r.code !== 0) continue
      } else {
        await mkdir(t.dir, { recursive: true })
        await writeFile(t.file, t.body)
      }
      done.push(t.browser)
    } catch {
      // Keep going with the others even if one browser fails
    }
  }
  return done
}

/** Removes the registration (when Dool2 is uninstalled). Browsers keep an already installed extension */
export async function unregisterExternalExtension(opts: ExternalOptions): Promise<void> {
  const platform = opts.platform ?? process.platform
  const exec = opts.exec ?? ((cmd, args) => runOnce(cmd, args, { timeoutMs: 15_000 }))
  for (const t of externalTargets(platform, opts.home ?? homedir(), opts.id)) {
    if (t.kind === 'reg') await exec('reg', ['delete', t.key, '/f']).catch(() => undefined)
    else await rm(t.file, { force: true })
  }
}
