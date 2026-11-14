// Codex를 처음 쓸 때 내려받는다 (설치 파일을 줄이려고 앱에 넣지 않는다).
// npm 공식 레지스트리의 플랫폼별 패키지(@openai/codex@<버전>-<플랫폼>)를 받아,
// **코드에 고정한 SHA-512**와 맞을 때만 OS의 tar로 푼다. app-server 규약이 버전마다 달라서 버전도 고정한다.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstallPhase, InstallStatus } from '@dool2/protocol'
import { CODEX_VERSION } from './bin.js'

/** 플랫폼별 패키지의 무결성 값 (npm 레지스트리 dist.integrity, 2026-11-14 확인) */
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

/** 내려받은 Codex 실행 파일 위치 */
export function downloadedCodexBin(dir: string, platform = process.platform, arch = process.arch) {
  const pkg = CODEX_PACKAGES[`${platform}-${arch}`]
  if (!pkg) return undefined
  return join(dir, CODEX_VERSION, pkg.triple, 'bin', platform === 'win32' ? 'codex.exe' : 'codex')
}

export class CodexInstallError extends Error {}

export interface InstallCodexOptions {
  /** 두리의 Codex 설치 폴더 */
  dir: string
  platformArch?: string
  /** 테스트용: 패키지 정보(무결성 값)를 바꿔 끼운다 */
  pkg?: { triple: string; integrity: string }
  /** 테스트용: 받을 주소 */
  url?: string
  fetch?: typeof fetch
  extract?: (archive: string, into: string) => Promise<void>
  onProgress?: (phase: InstallPhase, percent?: number) => void
  signal?: AbortSignal
}

const defaultExtract = (archive: string, into: string) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['-xzf', archive, '-C', into], { windowsHide: true, stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new CodexInstallError('압축을 풀지 못했어요'))))
  })

export async function installCodex(opts: InstallCodexOptions): Promise<string> {
  const doFetch = opts.fetch ?? fetch
  const signal = opts.signal ?? new AbortController().signal
  const progress = opts.onProgress ?? (() => {})
  const platformArch = opts.platformArch ?? `${process.platform}-${process.arch}`
  const pkg = opts.pkg ?? CODEX_PACKAGES[platformArch]
  if (!pkg) throw new CodexInstallError('이 컴퓨터에서는 Codex를 쓸 수 없어요')
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
      throw new CodexInstallError('인터넷 연결을 확인해 주세요')
    })
    if (!res.ok || !res.body) throw new CodexInstallError(`Codex를 내려받지 못했어요 (${res.status})`)
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
    if (hash.digest('base64') !== b64)
      throw new CodexInstallError('받은 파일이 공식 파일과 달라요. 안전을 위해 설치를 멈췄어요')

    progress('setup')
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await (opts.extract ?? defaultExtract)(archive, staging)
    // 패키지 안의 vendor/<triple> 폴더만 남긴다 (실행 파일과 함께 쓰는 도우미·자료 포함)
    const vendor = join(staging, 'package', 'vendor', pkg.triple)
    if (!existsSync(vendor)) throw new CodexInstallError('받은 파일에서 Codex를 찾지 못했어요')
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    await rename(vendor, join(target, pkg.triple))
    const win = platformArch.startsWith('win32')
    const binDir = join(target, pkg.triple, 'bin')
    const bin = join(binDir, win ? 'codex.exe' : 'codex')
    if (!existsSync(bin)) throw new CodexInstallError('설치했는데 Codex를 찾지 못했어요')
    if (!win) for (const f of await readdir(binDir)) await chmod(join(binDir, f), 0o755)
    return bin
  } finally {
    await rm(archive, { force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

/** 설치 버튼 상태를 들고 있는 세션 */
export class CodexInstall {
  private snapshot: InstallStatus = { state: 'idle' }
  private abort: AbortController | undefined

  constructor(private readonly opts: Omit<InstallCodexOptions, 'onProgress' | 'signal'>) {}

  get status(): InstallStatus {
    return this.snapshot
  }

  start(): InstallStatus {
    if (this.snapshot.state === 'running') return this.snapshot
    const abort = new AbortController()
    this.abort = abort
    this.snapshot = { state: 'running', phase: 'prepare' }
    void installCodex({
      ...this.opts,
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
          message:
            err instanceof CodexInstallError ? err.message : `Codex를 설치하지 못했어요: ${err.message}`,
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
