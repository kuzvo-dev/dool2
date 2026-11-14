// Claude Code 설치 (ADR 0002, 0005).
// 공식 설치 스크립트(claude.ai/install.sh, install.ps1)와 같은 순서를 Node로 그대로 따른다:
//   최신 버전 확인 → 매니페스트에서 체크섬 확인 → 공식 배포 서버에서 내려받기 → SHA-256 확인 → `claude install`
// 셸에 원격 스크립트를 파이프하지 않고, 진행률을 화면에 보여 줄 수 있고, 맥·윈도우가 같은 코드로 돈다.
// 실행 파일은 고치지 않는다. 마지막 설치 단계도 공식 바이너리의 `install` 명령이 한다.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, rm } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import type { InstallPhase, InstallStatus } from '@dool2/protocol'
import { loginEnv } from './login.js'

export const CLAUDE_DOWNLOAD_BASE = 'https://downloads.claude.ai/claude-code-releases'

interface ManifestEntry {
  binary?: string
  checksum?: string
  size?: number
}

/** 공식 배포 서버의 플랫폼 이름. 지원하지 않으면 undefined */
export function claudePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  cpuModel: string = cpus()[0]?.model ?? '',
): string | undefined {
  // 애플 실리콘 맥에서 x64 앱(Rosetta)으로 돌아도 네이티브 arm64를 받는다 (install.sh와 같음)
  const a = arch === 'arm64' || (platform === 'darwin' && /Apple/i.test(cpuModel)) ? 'arm64' : arch
  if (a !== 'arm64' && a !== 'x64') return undefined
  if (platform === 'darwin') return `darwin-${a}`
  if (platform === 'win32') return `win32-${a}`
  if (platform === 'linux') return `linux-${a}`
  return undefined
}

export interface InstallClaudeOptions {
  /** 내려받은 파일을 잠깐 둘 폴더 (설치가 끝나면 지운다) */
  downloadDir: string
  platform?: string
  fetch?: typeof fetch
  /** 내려받은 공식 바이너리로 `install`을 실행한다. 종료 코드를 돌려준다 */
  runInstall?: (bin: string, signal: AbortSignal) => Promise<number>
  onProgress?: (phase: InstallPhase, percent?: number) => void
  signal?: AbortSignal
}

/** 사용자에게 보여 줄 수 있는 설치 실패 */
export class InstallError extends Error {}

const defaultRunInstall = (bin: string, signal: AbortSignal) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(bin, ['install'], {
      env: loginEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      signal,
    })
    // 출력은 쓰지 않지만, 버퍼가 차서 멈추지 않게 읽어 버린다
    child.stdout.resume()
    child.stderr.resume()
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })

/** 공식 배포 서버에서 Claude Code를 받아 설치한다. 성공하면 설치한 버전을 돌려준다 */
export async function installClaudeCode(opts: InstallClaudeOptions): Promise<string> {
  const doFetch = opts.fetch ?? fetch
  const signal = opts.signal ?? new AbortController().signal
  const progress = opts.onProgress ?? (() => {})
  const platform = opts.platform ?? claudePlatform()
  if (!platform) throw new InstallError('이 컴퓨터에서는 Claude Code를 쓸 수 없어요')

  progress('prepare')
  const get = async (url: string) => {
    const res = await doFetch(url, { signal }).catch((err: Error) => {
      if (signal.aborted) throw err
      throw new InstallError('인터넷 연결을 확인해 주세요. Claude 배포 서버에 닿지 않았어요')
    })
    if (!res.ok) throw new InstallError(`Claude 배포 서버가 응답하지 않았어요 (${res.status})`)
    return res
  }
  const version = (await (await get(`${CLAUDE_DOWNLOAD_BASE}/latest`)).text()).trim()
  if (!/^\d+\.\d+\.\d+/.test(version))
    throw new InstallError('최신 버전을 확인하지 못했어요. 이 지역에서 Claude를 쓸 수 없는 경우일 수 있어요')
  const manifest = (await (await get(`${CLAUDE_DOWNLOAD_BASE}/${version}/manifest.json`)).json()) as {
    platforms?: Record<string, ManifestEntry>
  }
  const entry = manifest.platforms?.[platform]
  const checksum = entry?.checksum
  if (!entry || !checksum || !/^[a-f0-9]{64}$/.test(checksum))
    throw new InstallError('이 컴퓨터에 맞는 설치 파일을 찾지 못했어요')
  const name = entry.binary ?? (platform.startsWith('win32') ? 'claude.exe' : 'claude')

  await mkdir(opts.downloadDir, { recursive: true })
  // 지난번에 멈춘 설치가 남긴 파일을 지운다
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
    if (!res.body) throw new InstallError('설치 파일을 받지 못했어요')
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
    if (entry.size && got !== entry.size)
      throw new InstallError('설치 파일이 다 받아지지 않았어요. 다시 해 주세요')
    if (hash.digest('hex') !== checksum)
      throw new InstallError('받은 파일이 공식 파일과 달라요. 안전을 위해 설치를 멈췄어요')
    await chmod(file, 0o755)

    progress('setup')
    const code = await (opts.runInstall ?? defaultRunInstall)(file, signal)
    if (code !== 0) throw new InstallError(`설치를 마무리하지 못했어요 (종료 코드 ${code})`)
    return version
  } finally {
    await rm(file, { force: true })
  }
}

/** 설치 버튼 상태를 들고 있는 세션. 본체가 하나만 만든다 */
export class ClaudeInstall {
  private snapshot: InstallStatus = { state: 'idle' }
  private abort: AbortController | undefined

  constructor(
    private readonly opts: Omit<InstallClaudeOptions, 'onProgress' | 'signal'> & {
      /** 설치가 끝난 뒤 실제로 실행 파일이 보이는지 확인한다 */
      verify?: () => Promise<boolean>
    },
  ) {}

  get status(): InstallStatus {
    return this.snapshot
  }

  /** 설치를 시작한다. 이미 진행 중이면 그대로 둔다. 끝날 때까지 기다리지 않는다 */
  start(): InstallStatus {
    if (this.snapshot.state === 'running') return this.snapshot
    const abort = new AbortController()
    this.abort = abort
    this.snapshot = { state: 'running', phase: 'prepare' }
    void installClaudeCode({
      ...this.opts,
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
            message: '설치했는데 Claude Code를 찾지 못했어요. 컴퓨터를 다시 켠 뒤 확인해 주세요',
          }
          return
        }
        this.snapshot = { state: 'done', version }
      })
      .catch((err: Error) => {
        if (this.abort !== abort) return
        this.snapshot = {
          state: 'failed',
          message: err instanceof InstallError ? err.message : `설치하지 못했어요: ${err.message}`,
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
