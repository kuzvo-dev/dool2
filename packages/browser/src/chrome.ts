// Chrome 확인·설치 (ADR 0006: 브라우저는 Chrome 하나로 통일, 없으면 두리가 설치).
// 설치 파일은 Google 공식 주소에서 받고, Google 코드 서명을 확인한 뒤에만 설치한다.
import { createWriteStream } from 'node:fs'
import { access, constants, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { runOnce } from '@dool2/engine'
import type { ChromeStatus, InstallPhase, InstallStatus } from '@dool2/protocol'

/** Google의 애플 개발자 팀 ID (codesign으로 확인) */
export const GOOGLE_TEAM_ID = 'EQHXZ8M8AV'
export const CHROME_MAC_DMG = 'https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg'
export const CHROME_WIN_INSTALLER = 'https://dl.google.com/chrome/install/latest/chrome_installer.exe'

/** 외부 명령 실행. 테스트에서 바꿔 끼운다 */
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

/** Chrome이 설치돼 있는지, 어디에 있는지, 버전은 무엇인지 */
export async function detectChrome(e: ChromeEnv = chromeEnv()): Promise<ChromeStatus> {
  // 실행 중인 컴퓨터가 아니라 확인 대상 OS의 경로 규칙을 쓴다 (테스트가 모든 OS에서 같게 돈다)
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
      // 설치 폴더 안의 버전 폴더(예: 157.0.8103.51) 중 가장 높은 것
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

/** 사용자에게 보여 줄 수 있는 설치 실패 */
export class ChromeInstallError extends Error {}

export interface InstallChromeOptions {
  /** 설치 파일을 잠깐 둘 폴더 */
  downloadDir: string
  env?: ChromeEnv
  fetch?: typeof fetch
  /** 맥: Chrome을 넣을 폴더. 기본은 /Applications, 권한이 없으면 ~/Applications */
  macTargets?: string[]
  onProgress?: (phase: InstallPhase, percent?: number) => void
  signal?: AbortSignal
}

async function download(
  url: string,
  file: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
  progress: (pct: number) => void,
) {
  const res = await doFetch(url, { signal }).catch((err: Error) => {
    if (signal.aborted) throw err
    throw new ChromeInstallError('인터넷 연결을 확인해 주세요. Google 서버에 닿지 않았어요')
  })
  if (!res.ok || !res.body) throw new ChromeInstallError(`Google 서버가 응답하지 않았어요 (${res.status})`)
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
  if (total > 0 && got !== total)
    throw new ChromeInstallError('설치 파일이 다 받아지지 않았어요. 다시 해 주세요')
}

/** Google 공식 설치 파일로 Chrome을 설치한다 */
export async function installChrome(opts: InstallChromeOptions): Promise<void> {
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
      await download(CHROME_MAC_DMG, dmg, doFetch, signal, (p) => progress('download', p))
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
      if (at.code !== 0) throw new ChromeInstallError('설치 파일을 열지 못했어요')
      attached = true
      const app = join(mount, MAC_APP)
      await assertGoogleSignedMac(e, app)
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
      if (!done) throw new ChromeInstallError('Chrome을 응용 프로그램 폴더에 넣지 못했어요')
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
      await download(CHROME_WIN_INSTALLER, exe, doFetch, signal, (p) => progress('download', p))
      progress('verify')
      await assertGoogleSignedWindows(e, exe)
      progress('setup')
      // 관리자 권한이 없으면 Google 설치 프로그램이 사용자 폴더에 설치한다
      const r = await e.exec(exe, ['/silent', '/install'])
      if (r.code !== 0) throw new ChromeInstallError(`Chrome 설치를 마치지 못했어요 (종료 코드 ${r.code})`)
    } finally {
      await rm(exe, { force: true })
    }
    return
  }
  throw new ChromeInstallError('이 운영체제에서는 Chrome을 직접 설치해 주세요')
}

/**
 * 맥: Google 개발자 서명이 온전하고, 애플 공증(Gatekeeper)을 통과한 Google LLC 앱인지 확인한다.
 * `codesign --strict`는 Google 공식 dmg의 도우미 파일 하나에서 늘 실패해서 쓰지 않는다 (실측 2026-11-14).
 */
async function assertGoogleSignedMac(e: ChromeEnv, app: string) {
  const verify = await e.exec('/usr/bin/codesign', ['--verify', '--deep', app])
  const info = await e.exec('/usr/bin/codesign', ['-dv', '--verbose=2', app])
  const team = `${info.stdout}\n${info.stderr}`.match(/TeamIdentifier=(\S+)/)?.[1]
  const gk = await e.exec('/usr/sbin/spctl', ['-a', '-vv', '-t', 'execute', app])
  const gkText = `${gk.stdout}\n${gk.stderr}`
  const notarized =
    gk.code === 0 &&
    /source=Notarized Developer ID/.test(gkText) &&
    gkText.includes(`Google LLC (${GOOGLE_TEAM_ID})`)
  if (verify.code !== 0 || team !== GOOGLE_TEAM_ID || !notarized)
    throw new ChromeInstallError('받은 파일이 Google 공식 Chrome이 아니에요. 안전을 위해 설치를 멈췄어요')
}

/** 윈도우: Google LLC의 유효한 Authenticode 서명인지 확인한다 */
async function assertGoogleSignedWindows(e: ChromeEnv, exe: string) {
  const script =
    `$s = Get-AuthenticodeSignature -LiteralPath '${exe.replace(/'/g, "''")}'; ` +
    `"$($s.Status)|$($s.SignerCertificate.Subject)"`
  const r = await e.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  const [status, subject = ''] = r.stdout.trim().split('|')
  if (status !== 'Valid' || !/O=Google LLC/.test(subject))
    throw new ChromeInstallError('받은 파일이 Google 공식 Chrome이 아니에요. 안전을 위해 설치를 멈췄어요')
}

/** 설치 버튼 상태를 들고 있는 세션 */
export class ChromeInstall {
  private snapshot: InstallStatus = { state: 'idle' }
  private abort: AbortController | undefined

  constructor(private readonly opts: Omit<InstallChromeOptions, 'onProgress' | 'signal'>) {}

  get status(): InstallStatus {
    return this.snapshot
  }

  start(): InstallStatus {
    if (this.snapshot.state === 'running') return this.snapshot
    const abort = new AbortController()
    this.abort = abort
    this.snapshot = { state: 'running', phase: 'prepare' }
    void installChrome({
      ...this.opts,
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
          : { state: 'failed', message: '설치했는데 Chrome을 찾지 못했어요. 다시 확인해 주세요' }
      })
      .catch((err: Error) => {
        if (this.abort !== abort) return
        this.snapshot = {
          state: 'failed',
          message:
            err instanceof ChromeInstallError ? err.message : `Chrome을 설치하지 못했어요: ${err.message}`,
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
