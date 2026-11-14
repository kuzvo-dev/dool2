// OpenCode 설치 (ADR 0010). 설치 파일에 넣지 않고, 처음 쓸 때 공식 GitHub 릴리스에서 받는다.
// 고정 버전의 SHA256SUMS로 확인하고, 압축은 OS에 들어 있는 tar(맥 bsdtar, 윈도우 10+ tar.exe)로 푼다.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstallPhase, InstallStatus } from '@dool2/protocol'

/** 두리와 함께 시험한 OpenCode 버전. v2는 자주 바뀌어서 고정한다 */
export const OPENCODE_VERSION = '2.3.0'
export const OPENCODE_RELEASE = `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}`

/** 이 컴퓨터용 릴리스 파일 이름. 지원하지 않으면 undefined */
export function openCodeAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined
  if (!a) return undefined
  if (platform === 'darwin') return `opencode-darwin-${a}.zip`
  if (platform === 'win32') return `opencode-windows-${a}.zip`
  if (platform === 'linux') return `opencode-linux-${a}.tar.gz`
  return undefined
}

/** 설치 폴더 안의 실행 파일 위치 */
export function openCodeBin(dir: string, platform: NodeJS.Platform = process.platform) {
  return join(dir, `v${OPENCODE_VERSION}`, platform === 'win32' ? 'opencode.exe' : 'opencode')
}

export class OpenCodeInstallError extends Error {}

export interface InstallOpenCodeOptions {
  /** 두리의 OpenCode 설치 폴더 */
  dir: string
  asset?: string
  fetch?: typeof fetch
  /** 압축 풀기 (테스트에서 바꿔 끼운다) */
  extract?: (archive: string, into: string) => Promise<void>
  onProgress?: (phase: InstallPhase, percent?: number) => void
  signal?: AbortSignal
}

const defaultExtract = (archive: string, into: string) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['-xf', archive, '-C', into], { windowsHide: true, stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (code) =>
      code === 0 ? resolve() : reject(new OpenCodeInstallError('압축을 풀지 못했어요')),
    )
  })

export async function installOpenCode(opts: InstallOpenCodeOptions): Promise<string> {
  const doFetch = opts.fetch ?? fetch
  const signal = opts.signal ?? new AbortController().signal
  const progress = opts.onProgress ?? (() => {})
  const asset = opts.asset ?? openCodeAsset()
  if (!asset) throw new OpenCodeInstallError('이 컴퓨터에서는 종량제 모드를 쓸 수 없어요')
  const get = async (url: string) => {
    const res = await doFetch(url, { signal }).catch((err: Error) => {
      if (signal.aborted) throw err
      throw new OpenCodeInstallError('인터넷 연결을 확인해 주세요')
    })
    if (!res.ok) throw new OpenCodeInstallError(`내려받지 못했어요 (${res.status})`)
    return res
  }

  progress('prepare')
  const sums = await (await get(`${OPENCODE_RELEASE}/SHA256SUMS`)).text()
  const want = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0]
  if (!want || !/^[a-f0-9]{64}$/.test(want))
    throw new OpenCodeInstallError('설치 파일의 확인값을 찾지 못했어요')

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
    if (!res.body) throw new OpenCodeInstallError('내려받지 못했어요')
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
    if (hash.digest('hex') !== want)
      throw new OpenCodeInstallError('받은 파일이 공식 파일과 달라요. 안전을 위해 설치를 멈췄어요')

    progress('setup')
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await (opts.extract ?? defaultExtract)(archive, staging)
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
    const bin = openCodeBin(opts.dir)
    if (!existsSync(bin)) throw new OpenCodeInstallError('설치했는데 실행 파일을 찾지 못했어요')
    if (process.platform !== 'win32') await chmod(bin, 0o755)
    return bin
  } finally {
    await rm(archive, { force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

/** 설치 버튼 상태를 들고 있는 세션 */
export class OpenCodeInstall {
  private snapshot: InstallStatus = { state: 'idle' }
  private abort: AbortController | undefined

  constructor(private readonly opts: Omit<InstallOpenCodeOptions, 'onProgress' | 'signal'>) {}

  get status(): InstallStatus {
    return this.snapshot
  }

  start(): InstallStatus {
    if (this.snapshot.state === 'running') return this.snapshot
    const abort = new AbortController()
    this.abort = abort
    this.snapshot = { state: 'running', phase: 'prepare' }
    void installOpenCode({
      ...this.opts,
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
          message: err instanceof OpenCodeInstallError ? err.message : `설치하지 못했어요: ${err.message}`,
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
