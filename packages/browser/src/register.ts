// native messaging 호스트 등록. Chrome은 정해진 위치의 등록 파일(JSON)을 보고 호스트를 띄운다.
//   맥:     ~/Library/Application Support/<브라우저>/NativeMessagingHosts/<이름>.json
//   리눅스: ~/.config/<브라우저>/NativeMessagingHosts/<이름>.json
//   윈도우: HKCU\Software\<브라우저>\NativeMessagingHosts\<이름> (기본값 = 등록 파일 경로)
// 사용자 폴더·사용자 레지스트리에만 쓴다 (관리자 권한 없음).
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-location
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { runOnce } from '@dool2/engine'
import { BROWSER_HOST_NAME, EXTENSION_IDS } from '@dool2/protocol'
import type { Exec } from './chrome.js'

/** 호스트를 띄울 프로그램. 배포 앱은 Electron을 Node처럼(ELECTRON_RUN_AS_NODE) 쓴다 */
export interface HostRuntime {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface RegisterOptions {
  dataDir: string
  runtime: HostRuntime
  platform?: NodeJS.Platform
  home?: string
  extensionIds?: string[]
  /** 등록 파일을 더 둘 폴더 (테스트용 Chrome의 --user-data-dir/NativeMessagingHosts 등) */
  extraDirs?: string[]
  /** false면 브라우저 기본 위치에는 등록하지 않고 extraDirs에만 둔다 (점검·시험용) */
  defaultTargets?: boolean
  exec?: Exec
}

export interface Registration {
  launcher: string
  manifest: string
  /** 등록 파일을 복사한 폴더 또는 레지스트리 키 */
  targets: string[]
}

/** 브라우저별 사용자 등록 위치. Chrome이 기본이고 나머지는 같은 확장이 도는 Chromium 계열이다 */
export function hostTargets(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32')
    return [
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BROWSER_HOST_NAME}`,
      `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${BROWSER_HOST_NAME}`,
      `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${BROWSER_HOST_NAME}`,
    ]
  if (platform === 'darwin') {
    const base = posix.join(home, 'Library', 'Application Support')
    return ['Google/Chrome', 'Google/Chrome for Testing', 'Chromium', 'Microsoft Edge'].map((b) =>
      posix.join(base, b, 'NativeMessagingHosts'),
    )
  }
  const base = posix.join(home, '.config')
  return ['google-chrome', 'chromium', 'microsoft-edge'].map((b) =>
    posix.join(base, b, 'NativeMessagingHosts'),
  )
}

/** Chrome이 실행할 스크립트. Chrome은 실행 파일 경로만 받으므로 인자·환경을 여기에 담는다 */
export function launcherScript(platform: NodeJS.Platform, dataDir: string, rt: HostRuntime): string {
  const env = { ...rt.env, DOOL2_DATA_DIR: dataDir }
  if (platform === 'win32') {
    const sets = Object.entries(env).map(([k, v]) => `set "${k}=${v}"`)
    const cmd = [rt.command, ...rt.args].map((a) => `"${a}"`).join(' ')
    return ['@echo off', ...sets, `${cmd} %*`, ''].join('\r\n')
  }
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const sets = Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`)
  return ['#!/bin/sh', ...sets, `exec ${[rt.command, ...rt.args].map(q).join(' ')} "$@"`, ''].join('\n')
}

export function hostManifest(launcher: string, extensionIds: string[]) {
  return {
    name: BROWSER_HOST_NAME,
    description: '두리 — 내 컴퓨터에 사는 AI 비서',
    path: launcher,
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  }
}

/** 실행 스크립트와 등록 파일을 만들고 브라우저 등록 위치에 둔다. 몇 번 불러도 같다 */
export async function registerNativeHost(opts: RegisterOptions): Promise<Registration> {
  const platform = opts.platform ?? process.platform
  // 파일은 이 컴퓨터에 쓰므로 경로는 실행 중인 OS 규칙을 따른다 (platform은 스크립트 형식·등록 방법만 정한다)
  const dir = join(opts.dataDir, 'native-host')
  await mkdir(dir, { recursive: true })

  const launcher = join(dir, platform === 'win32' ? 'dool2-host.bat' : 'dool2-host.sh')
  await writeFile(launcher, launcherScript(platform, opts.dataDir, opts.runtime), { mode: 0o755 })
  if (platform !== 'win32') await chmod(launcher, 0o755)

  const body = `${JSON.stringify(hostManifest(launcher, opts.extensionIds ?? EXTENSION_IDS), null, 2)}\n`
  const manifest = join(dir, `${BROWSER_HOST_NAME}.json`)
  await writeFile(manifest, body)

  const builtIn = opts.defaultTargets === false ? [] : hostTargets(platform, opts.home ?? homedir())
  const targets = [...builtIn, ...(opts.extraDirs ?? [])]
  const done: string[] = []
  const exec = opts.exec ?? ((cmd, args) => runOnce(cmd, args, { timeoutMs: 15_000 }))
  for (const [i, target] of targets.entries()) {
    try {
      if (target.startsWith('HKCU\\')) {
        const r = await exec('reg', ['add', target, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f'])
        if (r.code !== 0) continue
      } else {
        // Chrome(첫 번째)은 아직 없어도 미리 둔다(두리가 곧 설치할 수 있다). 나머지는 설치된 브라우저에만
        if (i > 0 && i < builtIn.length && !(await exists(join(target, '..')))) continue
        await mkdir(target, { recursive: true })
        await writeFile(join(target, `${BROWSER_HOST_NAME}.json`), body)
      }
      done.push(target)
    } catch {
      // 한 브라우저에 못 써도 나머지는 계속한다
    }
  }
  return { launcher, manifest, targets: done }
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )
