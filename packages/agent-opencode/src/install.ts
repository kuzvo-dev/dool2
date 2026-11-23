// OpenCode install (ADR 0010). Not bundled in the installer; downloaded from the official GitHub release on first use.
// Verified against the pinned version's SHA256SUMS, and unpacked with the tar that ships with the OS (macOS bsdtar, Windows 10+ tar.exe).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Lang } from '@dool2/i18n'
import type { InstallPhase, InstallStatus } from '@dool2/protocol'
import { OPENCODE_TEXT } from './locales/opencode.js'

/** OpenCode version tested with Dool2. Pinned because v2 changes often */
export const OPENCODE_VERSION = '2.3.0'
export const OPENCODE_RELEASE = `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}`

/** Release file name for this computer. Undefined when unsupported */
export function openCodeAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined
  if (!a) return undefined
  if (platform === 'darwin') return `opencode-darwin-${a}.zip`
  if (platform === 'win32') return `opencode-windows-${a}.zip`
  if (platform === 'linux') return `opencode-linux-${a}.tar.gz`
  return undefined
}

/** Location of the executable in the install folder */
export function openCodeBin(dir: string, platform: NodeJS.Platform = process.platform) {
  return join(dir, `v${OPENCODE_VERSION}`, platform === 'win32' ? 'opencode.exe' : 'opencode')
}

export class OpenCodeInstallError extends Error {}

export interface InstallOpenCodeOptions {
  /** Dool2's OpenCode install folder */
  dir: string
  asset?: string
  fetch?: typeof fetch
  /** Unpacking (swapped in tests) */
  extract?: (archive: string, into: string) => Promise<void>
  onProgress?: (phase: InstallPhase, percent?: number) => void
  signal?: AbortSignal
  /** Language of the error messages people see. Korean when not given */
  lang?: Lang
}

const defaultExtract = (archive: string, into: string, failed: string) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['-xf', archive, '-C', into], { windowsHide: true, stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new OpenCodeInstallError(failed))))
  })

export async function installOpenCode(opts: InstallOpenCodeOptions): Promise<string> {
  const t = OPENCODE_TEXT[opts.lang ?? 'ko']
  const doFetch = opts.fetch ?? fetch
  const signal = opts.signal ?? new AbortController().signal
  const progress = opts.onProgress ?? (() => {})
  const asset = opts.asset ?? openCodeAsset()
  if (!asset) throw new OpenCodeInstallError(t.noPlatform)
  const get = async (url: string) => {
    const res = await doFetch(url, { signal }).catch((err: Error) => {
      if (signal.aborted) throw err
      throw new OpenCodeInstallError(t.offline)
    })
    if (!res.ok) throw new OpenCodeInstallError(t.downloadFailed(res.status))
    return res
  }

  progress('prepare')
  const sums = await (await get(`${OPENCODE_RELEASE}/SHA256SUMS`)).text()
  const want = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0]
  if (!want || !/^[a-f0-9]{64}$/.test(want)) throw new OpenCodeInstallError(t.noChecksum)

  await mkdir(opts.dir, { recursive: true })
  const archive = join(opts.dir, asset)
  const staging = join(opts.dir, `v${OPENCODE_VERSION}.tmp`)
  const target = join(opts.dir, `v${OPENCODE_VERSION}`)
  try {
    progress('download', 0)
    const res = await get(`${OPENCODE_RELEASE}/${asset}`)
    const total = Number(res.headers.get('content-length') ?? 0)
    const hash = createHash('sha256')
    const out = createWriteStream(archive)
    let got = 0
    let shown = -1
    if (!res.body) throw new OpenCodeInstallError(t.downloadFailed())
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      got += chunk.length
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
      const pct = total > 0 ? Math.min(99, Math.floor((got / total) * 100)) : undefined
      if (pct !== undefined && pct !== shown) {
        shown = pct
        progress('download', pct)
      }
    }
    await new Promise<void>((resolve, reject) =>
      out.end((err?: Error | null) => (err ? reject(err) : resolve())),
    )

    progress('verify')
    if (hash.digest('hex') !== want) throw new OpenCodeInstallError(t.checksum)

    progress('setup')
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await (opts.extract ?? ((a, i) => defaultExtract(a, i, t.extractFailed)))(archive, staging)
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
    const bin = openCodeBin(opts.dir)
    if (!existsSync(bin)) throw new OpenCodeInstallError(t.notFoundAfter)
    if (process.platform !== 'win32') await chmod(bin, 0o755)
    return bin
  } finally {
    await rm(archive, { force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

/** Session holding the install button's state */
export class OpenCodeInstall {
  private snapshot: InstallStatus = { state: 'idle' }
  private abort: AbortController | undefined

  constructor(private readonly opts: Omit<InstallOpenCodeOptions, 'onProgress' | 'signal'>) {}

  get status(): InstallStatus {
    return this.snapshot
  }

  start(lang: Lang = this.opts.lang ?? 'ko'): InstallStatus {
    if (this.snapshot.state === 'running') return this.snapshot
    const t = OPENCODE_TEXT[lang]
    const abort = new AbortController()
    this.abort = abort
    this.snapshot = { state: 'running', phase: 'prepare' }
    void installOpenCode({
      ...this.opts,
      lang,
      signal: abort.signal,
      onProgress: (phase, percent) => {
        if (this.abort === abort)
          this.snapshot = { state: 'running', phase, ...(percent !== undefined ? { percent } : {}) }
      },
    })
      .then(() => {
        if (this.abort === abort) this.snapshot = { state: 'done', version: OPENCODE_VERSION }
      })
      .catch((err: Error) => {
        if (this.abort !== abort) return
        this.snapshot = {
          state: 'failed',
          message: err instanceof OpenCodeInstallError ? err.message : t.installFailed(err.message),
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
