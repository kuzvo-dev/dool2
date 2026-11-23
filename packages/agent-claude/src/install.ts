// Claude Code install (ADR 0002, 0005).
// Follows the same steps as the official install scripts (claude.ai/install.sh, install.ps1), in Node:
//   check the latest version → checksum from the manifest → download from the official server → verify SHA-256 → `claude install`
// No remote script is piped into a shell, progress can be shown on screen, and macOS and Windows run the same code.
// The executable is never modified. The last install step is the official binary's own `install` command.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, rm } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import type { Lang } from '@dool2/i18n'
import type { InstallPhase, InstallStatus } from '@dool2/protocol'
import { CLAUDE_TEXT } from './locales/claude.js'
import { loginEnv } from './login.js'

export const CLAUDE_DOWNLOAD_BASE = 'https://downloads.claude.ai/claude-code-releases'

interface ManifestEntry {
  binary?: string
  checksum?: string
  size?: number
}

/** Platform name on the official download server. Undefined when unsupported */
export function claudePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  cpuModel: string = cpus()[0]?.model ?? '',
): string | undefined {
  // On Apple silicon, get native arm64 even when running as an x64 app under Rosetta (same as install.sh)
  const a = arch === 'arm64' || (platform === 'darwin' && /Apple/i.test(cpuModel)) ? 'arm64' : arch
  if (a !== 'arm64' && a !== 'x64') return undefined
  if (platform === 'darwin') return `darwin-${a}`
  if (platform === 'win32') return `win32-${a}`
  if (platform === 'linux') return `linux-${a}`
  return undefined
}

export interface InstallClaudeOptions {
  /** Folder for the download while installing (removed when done) */
  downloadDir: string
  platform?: string
  fetch?: typeof fetch
  /** Runs `install` with the downloaded official binary. Returns the exit code */
  runInstall?: (bin: string, signal: AbortSignal) => Promise<number>
  onProgress?: (phase: InstallPhase, percent?: number) => void
  signal?: AbortSignal
  /** Language of the error messages people see. Korean when not given */
  lang?: Lang
}

/** An install failure whose message can be shown to people */
export class InstallError extends Error {}

const defaultRunInstall = (bin: string, signal: AbortSignal) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(bin, ['install'], {
      env: loginEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      signal,
    })
    // The output isn't used, but it is drained so a full buffer doesn't stall the process
    child.stdout.resume()
    child.stderr.resume()
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })

/** Downloads Claude Code from the official server and installs it. Returns the installed version */
export async function installClaudeCode(opts: InstallClaudeOptions): Promise<string> {
  const t = CLAUDE_TEXT[opts.lang ?? 'ko']
  const doFetch = opts.fetch ?? fetch
  const signal = opts.signal ?? new AbortController().signal
  const progress = opts.onProgress ?? (() => {})
  const platform = opts.platform ?? claudePlatform()
  if (!platform) throw new InstallError(t.noPlatform)

  progress('prepare')
  const get = async (url: string) => {
    const res = await doFetch(url, { signal }).catch((err: Error) => {
      if (signal.aborted) throw err
      throw new InstallError(t.offline)
    })
    if (!res.ok) throw new InstallError(t.serverDown(res.status))
    return res
  }
  const version = (await (await get(`${CLAUDE_DOWNLOAD_BASE}/latest`)).text()).trim()
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new InstallError(t.noVersion)
  const manifest = (await (await get(`${CLAUDE_DOWNLOAD_BASE}/${version}/manifest.json`)).json()) as {
    platforms?: Record<string, ManifestEntry>
  }
  const entry = manifest.platforms?.[platform]
  const checksum = entry?.checksum
  if (!entry || !checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new InstallError(t.noFile)
  const name = entry.binary ?? (platform.startsWith('win32') ? 'claude.exe' : 'claude')

  await mkdir(opts.downloadDir, { recursive: true })
  // Remove files left by an install that stopped last time
  for (const f of await readdir(opts.downloadDir))
    if (f.startsWith('claude-')) await rm(join(opts.downloadDir, f), { force: true })
  const file = join(opts.downloadDir, `claude-${version}-${platform}${name.endsWith('.exe') ? '.exe' : ''}`)
  try {
    progress('download', 0)
    const res = await get(`${CLAUDE_DOWNLOAD_BASE}/${version}/${platform}/${name}`)
    const total = entry.size ?? Number(res.headers.get('content-length') ?? 0)
    const hash = createHash('sha256')
    const out = createWriteStream(file)
    let got = 0
    let shown = -1
    if (!res.body) throw new InstallError(t.noDownload)
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
    if (entry.size && got !== entry.size) throw new InstallError(t.partial)
    if (hash.digest('hex') !== checksum) throw new InstallError(t.checksum)
    await chmod(file, 0o755)

    progress('setup')
    const code = await (opts.runInstall ?? defaultRunInstall)(file, signal)
    if (code !== 0) throw new InstallError(t.finishFailed(code))
    return version
  } finally {
    await rm(file, { force: true })
  }
}

/** Session holding the install button's state. The daemon makes only one */
export class ClaudeInstall {
  private snapshot: InstallStatus = { state: 'idle' }
  private abort: AbortController | undefined

  constructor(
    private readonly opts: Omit<InstallClaudeOptions, 'onProgress' | 'signal'> & {
      /** Checks after installing that the executable can really be found */
      verify?: () => Promise<boolean>
    },
  ) {}

  get status(): InstallStatus {
    return this.snapshot
  }

  /** Starts installing. Leaves a running install alone. Doesn't wait for it to finish */
  start(lang: Lang = this.opts.lang ?? 'ko'): InstallStatus {
    const t = CLAUDE_TEXT[lang]
    if (this.snapshot.state === 'running') return this.snapshot
    const abort = new AbortController()
    this.abort = abort
    this.snapshot = { state: 'running', phase: 'prepare' }
    void installClaudeCode({
      ...this.opts,
      lang,
      signal: abort.signal,
      onProgress: (phase, percent) => {
        if (this.abort === abort)
          this.snapshot = { state: 'running', phase, ...(percent !== undefined ? { percent } : {}) }
      },
    })
      .then(async (version) => {
        if (this.abort !== abort) return
        if (this.opts.verify && !(await this.opts.verify())) {
          this.snapshot = {
            state: 'failed',
            message: t.notFoundAfter,
          }
          return
        }
        this.snapshot = { state: 'done', version }
      })
      .catch((err: Error) => {
        if (this.abort !== abort) return
        this.snapshot = {
          state: 'failed',
          message: err instanceof InstallError ? err.message : t.installFailed(err.message),
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
