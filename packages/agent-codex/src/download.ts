// Downloads Codex the first time it is used (it is not bundled, to keep the installer small).
// Gets the per-platform package (@openai/codex@<version>-<platform>) from the official npm registry and unpacks it
// with the OS tar only when it matches the **SHA-512 pinned in code**. The version is pinned too, since the app-server protocol changes.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Lang } from '@dool2/i18n'
import type { InstallPhase, InstallStatus } from '@dool2/protocol'
import { CODEX_VERSION } from './bin.js'
import { CODEX_TEXT } from './locales/codex.js'

/** Integrity values of the per-platform packages (npm registry dist.integrity, checked 2026-11-14) */
export const CODEX_PACKAGES: Record<string, { triple: string; integrity: string }> = {
  'darwin-arm64': {
    triple: 'aarch64-apple-darwin',
    integrity:
      'sha512-5WsWFBbVP78D+6FvNo1MMVxLPZdmcoQlqVJFrF4qx/TmvneLnMQKtLyXkUo54XOTDfoYKpNouTJ/F7gTVA8FnQ==',
  },
  'darwin-x64': {
    triple: 'x86_64-apple-darwin',
    integrity:
      'sha512-K1FKSsSLl9v3z5TeagBQXyQRDBIGB5Jncy5dxsRxwT3aaTqN3AI8VrCfoxBxKMOOU9O2QX1vg7WkBwNVth/s9A==',
  },
  'win32-x64': {
    triple: 'x86_64-pc-windows-msvc',
    integrity:
      'sha512-nC+McFU8xRNL9tk3IhxcKdhcyOElwF/HhPO+gzSQCY7yjh3XdzSajX+MYWcHUVHWRHajfwn3/WgJYJK2wS+XWg==',
  },
  'win32-arm64': {
    triple: 'aarch64-pc-windows-msvc',
    integrity:
      'sha512-nTN9SpkacGohq60+I80R3t0R8Mhbnlt3OVYNahgAv1Gu77KFwhPc0vz9Ou/DAGDtYhKVWA/jiYXJXnlzkwb/JA==',
  },
  'linux-x64': {
    triple: 'x86_64-unknown-linux-musl',
    integrity:
      'sha512-o05NyAOCDygSPRo1yinzxvkRSdmsZyBD9E7mbpmjRanSfM8lypqWtQgEo4XfNkwhuCR2aFu8mlGOsQGFXVbVww==',
  },
  'linux-arm64': {
    triple: 'aarch64-unknown-linux-musl',
    integrity:
      'sha512-NZ/DaQUpcQmxmqee7Z9uC1rzw3GhSbooawcaTe1LN5Yk+WlinUKGdTXJgClRT/9ogQEEM9TWxYzvxPfj5G/xFg==',
  },
}

export const codexTarball = (platformArch: string) =>
  `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-${platformArch}.tgz`

/** Location of the downloaded Codex executable */
export function downloadedCodexBin(dir: string, platform = process.platform, arch = process.arch) {
  const pkg = CODEX_PACKAGES[`${platform}-${arch}`]
  if (!pkg) return undefined
  return join(dir, CODEX_VERSION, pkg.triple, 'bin', platform === 'win32' ? 'codex.exe' : 'codex')
}

export class CodexInstallError extends Error {}

export interface InstallCodexOptions {
  /** Dool2's Codex install folder */
  dir: string
  platformArch?: string
  /** For tests: swaps in package info (integrity value) */
  pkg?: { triple: string; integrity: string }
  /** For tests: download URL */
  url?: string
  fetch?: typeof fetch
  extract?: (archive: string, into: string) => Promise<void>
  onProgress?: (phase: InstallPhase, percent?: number) => void
  signal?: AbortSignal
  /** Language of the error messages people see. Korean when not given */
  lang?: Lang
}

const defaultExtract = (archive: string, into: string, failed: string) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['-xzf', archive, '-C', into], { windowsHide: true, stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new CodexInstallError(failed))))
  })

export async function installCodex(opts: InstallCodexOptions): Promise<string> {
  const t = CODEX_TEXT[opts.lang ?? 'ko']
  const doFetch = opts.fetch ?? fetch
  const signal = opts.signal ?? new AbortController().signal
  const progress = opts.onProgress ?? (() => {})
  const platformArch = opts.platformArch ?? `${process.platform}-${process.arch}`
  const pkg = opts.pkg ?? CODEX_PACKAGES[platformArch]
  if (!pkg) throw new CodexInstallError(t.noPlatform)
  const [algo, b64] = pkg.integrity.split('-', 2) as [string, string]

  progress('prepare')
  await mkdir(opts.dir, { recursive: true })
  const archive = join(opts.dir, `codex-${CODEX_VERSION}.tgz`)
  const staging = join(opts.dir, `${CODEX_VERSION}.tmp`)
  const target = join(opts.dir, CODEX_VERSION)
  try {
    progress('download', 0)
    const res = await doFetch(opts.url ?? codexTarball(platformArch), { signal }).catch((err: Error) => {
      if (signal.aborted) throw err
      throw new CodexInstallError(t.offline)
    })
    if (!res.ok || !res.body) throw new CodexInstallError(t.downloadFailed(res.status))
    const total = Number(res.headers.get('content-length') ?? 0)
    const hash = createHash(algo)
    const out = createWriteStream(archive)
    let got = 0
    let shown = -1
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
    if (hash.digest('base64') !== b64) throw new CodexInstallError(t.checksum)

    progress('setup')
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await (opts.extract ?? ((a, i) => defaultExtract(a, i, t.extractFailed)))(archive, staging)
    // Keep only the package's vendor/<triple> folder (with the helpers and data the executable uses)
    const vendor = join(staging, 'package', 'vendor', pkg.triple)
    if (!existsSync(vendor)) throw new CodexInstallError(t.notInArchive)
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    await rename(vendor, join(target, pkg.triple))
    const win = platformArch.startsWith('win32')
    const binDir = join(target, pkg.triple, 'bin')
    const bin = join(binDir, win ? 'codex.exe' : 'codex')
    if (!existsSync(bin)) throw new CodexInstallError(t.notFoundAfter)
    if (!win) for (const f of await readdir(binDir)) await chmod(join(binDir, f), 0o755)
    return bin
  } finally {
    await rm(archive, { force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

/** Session holding the install button's state */
export class CodexInstall {
  private snapshot: InstallStatus = { state: 'idle' }
  private abort: AbortController | undefined

  constructor(private readonly opts: Omit<InstallCodexOptions, 'onProgress' | 'signal'>) {}

  get status(): InstallStatus {
    return this.snapshot
  }

  start(lang: Lang = this.opts.lang ?? 'ko'): InstallStatus {
    if (this.snapshot.state === 'running') return this.snapshot
    const t = CODEX_TEXT[lang]
    const abort = new AbortController()
    this.abort = abort
    this.snapshot = { state: 'running', phase: 'prepare' }
    void installCodex({
      ...this.opts,
      lang,
      signal: abort.signal,
      onProgress: (phase, percent) => {
        if (this.abort === abort)
          this.snapshot = { state: 'running', phase, ...(percent !== undefined ? { percent } : {}) }
      },
    })
      .then(() => {
        if (this.abort === abort) this.snapshot = { state: 'done', version: CODEX_VERSION }
      })
      .catch((err: Error) => {
        if (this.abort !== abort) return
        this.snapshot = {
          state: 'failed',
          message: err instanceof CodexInstallError ? err.message : t.installFailed(err.message),
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
