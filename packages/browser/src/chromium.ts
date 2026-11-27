// Dool2's own browser, part 1: getting the Chromium build (ADR 0046).
// Downloaded on first use into the Dool2 data folder, like the AI runners: the pinned zip from the manifest, checked
// against its size and SHA-256 before anything is unpacked, then moved into place in one step so a half-installed
// browser is never used. On macOS only the folder Dool2 unpacked loses the quarantine attribute.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Lang } from '@dool2/i18n'
import type { InstallPhase, InstallStatus } from '@dool2/protocol'
import { CHROMIUM_MANIFEST } from './chromium-manifest.js'
import { CHROMIUM_TEXT, type ChromiumText } from './locales/chromium.js'

export type ChromiumPlatform = 'mac-arm64' | 'mac-x64' | 'win64' | 'linux64'

export interface ChromiumBuild {
  url: string
  /** Bytes of the zip */
  size: number
  /** SHA-256 of the zip, lowercase hex */
  sha256: string
  /** The program inside the unpacked zip, with forward slashes */
  executable: string
}

export interface ChromiumManifest {
  version: string
  revision: number
  builds: Partial<Record<ChromiumPlatform, ChromiumBuild>>
}

const PLATFORMS: ChromiumPlatform[] = ['mac-arm64', 'mac-x64', 'win64', 'linux64']

/** The build name for this computer; undefined where Dool2 has no build */
export function chromiumPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ChromiumPlatform | undefined {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-x64' : undefined
  if (platform === 'win32') return arch === 'x64' ? 'win64' : undefined
  if (platform === 'linux') return arch === 'x64' ? 'linux64' : undefined
  return undefined
}

/** Checks a manifest's shape; throws on anything Dool2 should not download from */
export function parseChromiumManifest(json: unknown): ChromiumManifest {
  const bad = (why: string): never => {
    throw new Error(`Chromium manifest: ${why}`)
  }
  if (!json || typeof json !== 'object') bad('not an object')
  const m = json as Record<string, unknown>
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(m.version)) bad('version')
  if (!Number.isInteger(m.revision) || (m.revision as number) <= 0) bad('revision')
  if (!m.builds || typeof m.builds !== 'object') bad('builds')
  const builds: ChromiumManifest['builds'] = {}
  for (const [name, raw] of Object.entries(m.builds as Record<string, unknown>)) {
    if (!PLATFORMS.includes(name as ChromiumPlatform)) bad(`unknown platform ${name}`)
    const b = raw as Partial<ChromiumBuild> | undefined
    if (!b || typeof b !== 'object') bad(`${name}: not an object`)
    const build = b as Partial<ChromiumBuild>
    if (typeof build.url !== 'string' || !/^https:\/\/[^/]+\/.+\.zip$/.test(build.url)) bad(`${name}: url`)
    if (!Number.isInteger(build.size) || (build.size as number) <= 0) bad(`${name}: size`)
    if (typeof build.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(build.sha256)) bad(`${name}: sha256`)
    const exe = build.executable
    if (typeof exe !== 'string' || !exe || exe.startsWith('/') || exe.split('/').includes('..'))
      bad(`${name}: executable`)
    builds[name as ChromiumPlatform] = build as ChromiumBuild
  }
  return { version: m.version as string, revision: m.revision as number, builds }
}

/** The build for this computer from the manifest; undefined where there is none */
export function pickChromiumBuild(
  manifest: ChromiumManifest,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ChromiumBuild | undefined {
  const name = chromiumPlatform(platform, arch)
  return name ? manifest.builds[name] : undefined
}

/** The manifest that ships with this Dool2 */
export function bundledChromiumManifest(): ChromiumManifest {
  return parseChromiumManifest(CHROMIUM_MANIFEST)
}

/** Where the built-in browser lives in the Dool2 data folder */
export function chromiumPaths(dataDir: string) {
  return {
    /** Downloaded builds, one folder per trunk position */
    root: join(dataDir, 'chromium'),
    /** Dool2's own browser profile (cookies and logins of the sites Dool2 uses); owner-only */
    profile: join(dataDir, 'browser-profile'),
  }
}

/** The program of the pinned build in the data folder (whether or not it is downloaded yet) */
export function chromiumExecutable(
  dataDir: string,
  manifest: ChromiumManifest = bundledChromiumManifest(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const build = pickChromiumBuild(manifest, platform, arch)
  if (!build) return undefined
  return join(chromiumPaths(dataDir).root, String(manifest.revision), ...build.executable.split('/'))
}

/** An install failure whose message can be shown to people */
export class ChromiumInstallError extends Error {
  constructor(
    message: string,
    /** Worth trying again by itself (network trouble), as opposed to a file that is not the pinned one */
    readonly retry = false,
  ) {
    super(message)
  }
}

export interface InstallChromiumOptions {
  /** Dool2 data folder */
  dataDir: string
  manifest?: ChromiumManifest
  platform?: NodeJS.Platform
  arch?: string
  fetch?: typeof fetch
  /** Unpacks the zip into a folder (swapped in tests) */
  extract?: (zip: string, into: string) => Promise<void>
  /** Runs a command (macOS quarantine removal; swapped in tests) */
  exec?: (cmd: string, args: string[]) => Promise<number | null>
  onProgress?: (phase: InstallPhase, percent?: number) => void
  signal?: AbortSignal
  /** Download attempts on network trouble (default 3) */
  attempts?: number
  /** Wait before attempt n+1, in ms (default 2 s, 4 s, …) */
  backoffMs?: (attempt: number) => number
  lang?: Lang
}

const run = (cmd: string, args: string[]) =>
  new Promise<number | null>((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' })
    p.on('error', () => resolve(-1))
    p.on('exit', (code) => resolve(code))
  })

/** The OS's own unzip: ditto keeps the macOS app bundle's links and signature, Windows 10+ ships bsdtar */
function defaultExtract(platform: NodeJS.Platform, exec: NonNullable<InstallChromiumOptions['exec']>) {
  return async (zip: string, into: string) => {
    const code =
      platform === 'darwin'
        ? await exec('/usr/bin/ditto', ['-x', '-k', zip, into])
        : platform === 'win32'
          ? await exec('tar', ['-xf', zip, '-C', into])
          : await exec('unzip', ['-q', zip, '-d', into])
    if (code !== 0) throw new Error(`unzip exit ${code}`)
  }
}

async function downloadOnce(
  build: ChromiumBuild,
  file: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
  progress: (pct: number) => void,
  t: ChromiumText,
) {
  const res = await doFetch(build.url, { signal }).catch((err: Error) => {
    if (signal.aborted) throw err
    throw new ChromiumInstallError(t.offline, true)
  })
  if (!res.ok || !res.body) throw new ChromiumInstallError(t.serverDown(res.status), res.status >= 500)
  const hash = createHash('sha256')
  const out = createWriteStream(file)
  let got = 0
  let shown = -1
  try {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      got += chunk.length
      if (got > build.size) throw new ChromiumInstallError(t.checksum)
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
      const pct = Math.min(99, Math.floor((got / build.size) * 100))
      if (pct !== shown) {
        shown = pct
        progress(pct)
      }
    }
  } catch (err) {
    out.destroy()
    if (err instanceof ChromiumInstallError || signal.aborted) throw err
    // The connection broke in the middle
    throw new ChromiumInstallError(t.partial, true)
  }
  await new Promise<void>((resolve, reject) =>
    out.end((err?: Error | null) => (err ? reject(err) : resolve())),
  )
  if (got < build.size) throw new ChromiumInstallError(t.partial, true)
  return hash.digest('hex')
}

/**
 * Downloads, checks and unpacks the pinned Chromium build into <dataDir>/chromium/<revision>. Returns the program's
 * path. Already there: returns at once. Older builds Dool2 downloaded before are removed after a good install
 */
export async function installChromium(opts: InstallChromiumOptions): Promise<string> {
  const t = CHROMIUM_TEXT[opts.lang ?? 'ko']
  const manifest = opts.manifest ?? bundledChromiumManifest()
  const platform = opts.platform ?? process.platform
  const build = pickChromiumBuild(manifest, platform, opts.arch ?? process.arch)
  if (!build) throw new ChromiumInstallError(t.noPlatform)
  const doFetch = opts.fetch ?? fetch
  const exec = opts.exec ?? run
  const signal = opts.signal ?? new AbortController().signal
  const progress = opts.onProgress ?? (() => {})
  const { root } = chromiumPaths(opts.dataDir)
  const target = join(root, String(manifest.revision))
  const bin = join(target, ...build.executable.split('/'))
  if (existsSync(bin)) return bin

  progress('prepare')
  await mkdir(root, { recursive: true })
  const zip = join(root, `${manifest.revision}.zip`)
  const staging = join(root, `${manifest.revision}.tmp`)
  try {
    const attempts = Math.max(1, opts.attempts ?? 3)
    let sum = ''
    for (let i = 1; ; i++) {
      progress('download', 0)
      try {
        sum = await downloadOnce(build, zip, doFetch, signal, (p) => progress('download', p), t)
        break
      } catch (err) {
        await rm(zip, { force: true })
        if (!(err instanceof ChromiumInstallError) || !err.retry || i >= attempts || signal.aborted) throw err
        const wait = opts.backoffMs?.(i) ?? 2000 * i
        await new Promise((r) => setTimeout(r, wait))
      }
    }

    progress('verify')
    if (sum !== build.sha256) throw new ChromiumInstallError(t.checksum)

    progress('setup')
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await (opts.extract ?? defaultExtract(platform, exec))(zip, staging).catch((err: Error) => {
      if (signal.aborted) throw err
      throw new ChromiumInstallError(t.extractFailed)
    })
    if (!existsSync(join(staging, ...build.executable.split('/'))))
      throw new ChromiumInstallError(t.notFoundAfter)
    // Only the folder Dool2 just unpacked; ditto does not add the attribute, this covers a zip that carried it
    if (platform === 'darwin') await exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staging])
    if (platform !== 'win32') await chmod(join(staging, ...build.executable.split('/')), 0o755)
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
    // Builds of earlier Dool2 versions are not needed any more
    for (const name of await readdir(root).catch(() => [])) {
      if (name !== String(manifest.revision) && /^\d+(\.tmp|\.zip)?$/.test(name))
        await rm(join(root, name), { recursive: true, force: true })
    }
    return bin
  } finally {
    await rm(zip, { force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

/** Session holding the install state for the setup screen, the same shape as the AI runners' installs */
export class ChromiumInstall {
  private snapshot: InstallStatus = { state: 'idle' }
  private abort: AbortController | undefined
  private running: Promise<string> | undefined

  constructor(private readonly opts: Omit<InstallChromiumOptions, 'onProgress' | 'signal'>) {}

  get status(): InstallStatus {
    return this.snapshot
  }

  /** The program's path, downloading it first when needed. Calls at the same time share one download */
  ensure(lang: Lang = this.opts.lang ?? 'ko'): Promise<string> {
    if (this.running) return this.running
    const t = CHROMIUM_TEXT[lang]
    const abort = new AbortController()
    this.abort = abort
    this.snapshot = { state: 'running', phase: 'prepare' }
    const manifest = this.opts.manifest ?? bundledChromiumManifest()
    const job = installChromium({
      ...this.opts,
      manifest,
      lang,
      signal: abort.signal,
      onProgress: (phase, percent) => {
        if (this.abort === abort)
          this.snapshot = { state: 'running', phase, ...(percent !== undefined ? { percent } : {}) }
      },
    })
    this.running = job
    job
      .then(() => {
        if (this.abort === abort) this.snapshot = { state: 'done', version: manifest.version }
      })
      .catch((err: Error) => {
        if (this.abort !== abort) return
        this.snapshot = {
          state: 'failed',
          message: err instanceof ChromiumInstallError ? err.message : t.installFailed(err.message),
        }
      })
      .finally(() => {
        if (this.running === job) this.running = undefined
      })
    return job
  }

  /** Starts the download in the background (the setup screen's button) */
  start(lang?: Lang): InstallStatus {
    this.ensure(lang).catch(() => {})
    return this.snapshot
  }

  cancel() {
    this.abort?.abort()
    this.abort = undefined
    this.running = undefined
    this.snapshot = { state: 'idle' }
  }
}
