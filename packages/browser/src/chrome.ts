// Checking and installing Chrome (ADR 0006: Chrome is the one browser, and Dool2 installs it if missing).
// The installer comes from Google's official URL and is installed only after Google's code signature is verified.
import { createWriteStream } from 'node:fs'
import { access, constants, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { runOnce } from '@dool2/engine'
import type { Lang } from '@dool2/i18n'
import type { ChromeStatus, InstallPhase, InstallStatus } from '@dool2/protocol'
import { CHROME_TEXT, type ChromeText } from './locales/chrome.js'

/** Google's Apple developer team ID (checked with codesign) */
export const GOOGLE_TEAM_ID = 'EQHXZ8M8AV'
export const CHROME_MAC_DMG = 'https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg'
export const CHROME_WIN_INSTALLER = 'https://dl.google.com/chrome/install/latest/chrome_installer.exe'

/** Runs external commands. Swapped in tests */
export type Exec = (
  cmd: string,
  args: string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>
const defaultExec: Exec = (cmd, args) => runOnce(cmd, args, { timeoutMs: 10 * 60_000 })

export interface ChromeEnv {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  exists(path: string): Promise<boolean>
  list(dir: string): Promise<string[]>
  exec: Exec
}

const exists = (p: string) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  )

export function chromeEnv(): ChromeEnv {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    exists,
    list: (dir) => readdir(dir).catch(() => []),
    exec: defaultExec,
  }
}

const MAC_APP = 'Google Chrome.app'

/** Whether Chrome is installed, where, and which version */
export async function detectChrome(e: ChromeEnv = chromeEnv()): Promise<ChromeStatus> {
  // Use the path rules of the OS being checked, not the running computer (so tests behave the same on every OS)
  const pj = e.platform === 'win32' ? win32.join : posix.join
  if (e.platform === 'darwin') {
    for (const dir of ['/Applications', pj(e.home, 'Applications')]) {
      const app = pj(dir, MAC_APP)
      const path = pj(app, 'Contents', 'MacOS', 'Google Chrome')
      if (!(await e.exists(path))) continue
      const r = await e
        .exec('/usr/bin/plutil', [
          '-extract',
          'CFBundleShortVersionString',
          'raw',
          pj(app, 'Contents', 'Info.plist'),
        ])
        .catch(() => undefined)
      const version = r?.stdout.trim().match(/^\d+(\.\d+)+$/)?.[0]
      return { installed: true, path, ...(version ? { version } : {}) }
    }
    return { installed: false }
  }
  if (e.platform === 'win32') {
    const roots = [e.env.ProgramFiles, e.env['ProgramFiles(x86)'], e.env.LOCALAPPDATA].filter(
      Boolean,
    ) as string[]
    for (const root of roots) {
      const dir = pj(root, 'Google', 'Chrome', 'Application')
      const path = pj(dir, 'chrome.exe')
      if (!(await e.exists(path))) continue
      // The highest version folder (e.g. 157.0.8103.51) in the install folder
      const versions = (await e.list(dir)).filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n)).sort(compareVersions)
      const version = versions.at(-1)
      return { installed: true, path, ...(version ? { version } : {}) }
    }
    return { installed: false }
  }
  for (const path of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (!(await e.exists(path))) continue
    const r = await e.exec(path, ['--version']).catch(() => undefined)
    const version = r?.stdout.match(/\d+(\.\d+)+/)?.[0]
    return { installed: true, path, ...(version ? { version } : {}) }
  }
  return { installed: false }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** An install failure whose message can be shown to people */
export class ChromeInstallError extends Error {}

export interface InstallChromeOptions {
  /** Folder for the installer while installing */
  downloadDir: string
  env?: ChromeEnv
  fetch?: typeof fetch
  /** macOS: folders to put Chrome in. /Applications by default, ~/Applications without access */
  macTargets?: string[]
  onProgress?: (phase: InstallPhase, percent?: number) => void
  signal?: AbortSignal
  /** Language of the error messages people see. Korean when not given */
  lang?: Lang
}

async function download(
  url: string,
  file: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
  progress: (pct: number) => void,
  t: ChromeText,
) {
  const res = await doFetch(url, { signal }).catch((err: Error) => {
    if (signal.aborted) throw err
    throw new ChromeInstallError(t.offline)
  })
  if (!res.ok || !res.body) throw new ChromeInstallError(t.serverDown(res.status))
  const total = Number(res.headers.get('content-length') ?? 0)
  const out = createWriteStream(file)
  let got = 0
  let shown = -1
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    got += chunk.length
    if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
    const pct = total > 0 ? Math.min(99, Math.floor((got / total) * 100)) : undefined
    if (pct !== undefined && pct !== shown) {
      shown = pct
      progress(pct)
    }
  }
  await new Promise<void>((resolve, reject) =>
    out.end((err?: Error | null) => (err ? reject(err) : resolve())),
  )
  if (total > 0 && got !== total) throw new ChromeInstallError(t.partial)
}

/** Installs Chrome with Google's official installer */
export async function installChrome(opts: InstallChromeOptions): Promise<void> {
  const t = CHROME_TEXT[opts.lang ?? 'ko']
  const e = opts.env ?? chromeEnv()
  const doFetch = opts.fetch ?? fetch
  const signal = opts.signal ?? new AbortController().signal
  const progress = opts.onProgress ?? (() => {})
  progress('prepare')
  await mkdir(opts.downloadDir, { recursive: true })

  if (e.platform === 'darwin') {
    const dmg = join(opts.downloadDir, 'googlechrome.dmg')
    const mount = await mkdtemp(join(opts.downloadDir, 'mnt-'))
    let attached = false
    try {
      progress('download', 0)
      await download(CHROME_MAC_DMG, dmg, doFetch, signal, (p) => progress('download', p), t)
      progress('verify')
      const at = await e.exec('/usr/bin/hdiutil', [
        'attach',
        dmg,
        '-nobrowse',
        '-readonly',
        '-noautoopen',
        '-mountpoint',
        mount,
      ])
      if (at.code !== 0) throw new ChromeInstallError(t.cantOpen)
      attached = true
      const app = join(mount, MAC_APP)
      await assertGoogleSignedMac(e, app, t)
      progress('setup')
      const targets = opts.macTargets ?? ['/Applications', join(e.home, 'Applications')]
      let done = false
      for (const dir of targets) {
        const r = await e.exec('/usr/bin/ditto', [app, join(dir, MAC_APP)])
        if (r.code === 0) {
          done = true
          break
        }
      }
      if (!done) throw new ChromeInstallError(t.cantCopy)
    } finally {
      if (attached) await e.exec('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => {})
      await rm(mount, { recursive: true, force: true })
      await rm(dmg, { force: true })
    }
    return
  }

  if (e.platform === 'win32') {
    const exe = join(opts.downloadDir, 'chrome_installer.exe')
    try {
      progress('download', 0)
      await download(CHROME_WIN_INSTALLER, exe, doFetch, signal, (p) => progress('download', p), t)
      progress('verify')
      await assertGoogleSignedWindows(e, exe, t)
      progress('setup')
      // Without admin rights, Google's installer installs into the user folder
      const r = await e.exec(exe, ['/silent', '/install'])
      if (r.code !== 0) throw new ChromeInstallError(t.finishFailed(r.code))
    } finally {
      await rm(exe, { force: true })
    }
    return
  }
  throw new ChromeInstallError(t.unsupported)
}

/**
 * macOS: checks that it is a Google LLC app with an intact developer signature that passed Apple notarization (Gatekeeper).
 * `codesign --strict` always fails on one helper file in Google's official dmg, so it isn't used (measured 2026-11-14).
 */
async function assertGoogleSignedMac(e: ChromeEnv, app: string, t: ChromeText) {
  const verify = await e.exec('/usr/bin/codesign', ['--verify', '--deep', app])
  const info = await e.exec('/usr/bin/codesign', ['-dv', '--verbose=2', app])
  const team = `${info.stdout}\n${info.stderr}`.match(/TeamIdentifier=(\S+)/)?.[1]
  const gk = await e.exec('/usr/sbin/spctl', ['-a', '-vv', '-t', 'execute', app])
  const gkText = `${gk.stdout}\n${gk.stderr}`
  const notarized =
    gk.code === 0 &&
    /source=Notarized Developer ID/.test(gkText) &&
    gkText.includes(`Google LLC (${GOOGLE_TEAM_ID})`)
  if (verify.code !== 0 || team !== GOOGLE_TEAM_ID || !notarized) throw new ChromeInstallError(t.notGoogle)
}

/** Windows: checks for a valid Authenticode signature from Google LLC */
async function assertGoogleSignedWindows(e: ChromeEnv, exe: string, t: ChromeText) {
  const script =
    `$s = Get-AuthenticodeSignature -LiteralPath '${exe.replace(/'/g, "''")}'; ` +
    `"$($s.Status)|$($s.SignerCertificate.Subject)"`
  const r = await e.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  const [status, subject = ''] = r.stdout.trim().split('|')
  if (status !== 'Valid' || !/O=Google LLC/.test(subject)) throw new ChromeInstallError(t.notGoogle)
}

/** Session holding the install button's state */
export class ChromeInstall {
  private snapshot: InstallStatus = { state: 'idle' }
  private abort: AbortController | undefined

  constructor(private readonly opts: Omit<InstallChromeOptions, 'onProgress' | 'signal'>) {}

  get status(): InstallStatus {
    return this.snapshot
  }

  start(lang: Lang = this.opts.lang ?? 'ko'): InstallStatus {
    if (this.snapshot.state === 'running') return this.snapshot
    const t = CHROME_TEXT[lang]
    const abort = new AbortController()
    this.abort = abort
    this.snapshot = { state: 'running', phase: 'prepare' }
    void installChrome({
      ...this.opts,
      lang,
      signal: abort.signal,
      onProgress: (phase, percent) => {
        if (this.abort === abort)
          this.snapshot = { state: 'running', phase, ...(percent !== undefined ? { percent } : {}) }
      },
    })
      .then(async () => {
        if (this.abort !== abort) return
        const now = await detectChrome(this.opts.env)
        this.snapshot = now.installed
          ? { state: 'done', ...(now.version ? { version: now.version } : {}) }
          : { state: 'failed', message: t.notFoundAfter }
      })
      .catch((err: Error) => {
        if (this.abort !== abort) return
        this.snapshot = {
          state: 'failed',
          message: err instanceof ChromeInstallError ? err.message : t.installFailed(err.message),
        }
      })
    return this.snapshot
  }

  cancel() {
    this.abort?.abort()
    this.abort = undefined
    this.snapshot = { state: 'idle' }
  }
}
