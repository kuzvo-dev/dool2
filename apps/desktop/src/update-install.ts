// 받은 업데이트를 까는 일 (플랫폼마다). Updater가 서명·확인값을 맞춘 파일만 넘긴다.
// - 맥: zip을 지금 앱 옆에 풀고 앱 묶음을 바꿔 끼운 뒤 다시 켠다. 앱이 직접 받은 파일에는 '인터넷에서 받음' 표시가
//   붙지 않아 처음 설치 때의 '그래도 열기'가 다시 뜨지 않는다. 같은 인증서로 서명해 권한·금고가 이어진다 (ADR 0028)
// - 윈도우: 받은 설치 파일을 조용히(/S) 돌리고 끝나면 다시 켜게(--force-run) 한 뒤 앱을 끝낸다
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const run = (bin: string, args: string[]) =>
  new Promise<void>((res, rej) =>
    execFile(bin, args, { timeout: 5 * 60_000 }, (e, _o, err) =>
      e ? rej(new Error(`${basename(bin)}: ${String(err || e.message).slice(0, 300)}`)) : res(),
    ),
  )

/** 실행 파일 경로에서 앱 묶음 (…/두리.app/Contents/MacOS/Dool2 → …/두리.app) */
export function appBundle(exe: string): string | undefined {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)
  return m?.[1]
}

export interface InstallDeps {
  exe: string
  /** 본체를 정리하고 다시 켠다 (맥) */
  relaunch: () => Promise<void>
  /** 본체를 정리하고 끝낸다 (윈도우: 설치 파일이 다시 켠다) */
  quit: () => Promise<void>
  platform?: NodeJS.Platform
  run?: typeof run
  spawnDetached?: (file: string, args: string[]) => void
}

export async function installUpdate(file: string, d: InstallDeps): Promise<void> {
  const platform = d.platform ?? process.platform
  const exec = d.run ?? run
  if (platform === 'darwin') {
    const bundle = appBundle(d.exe)
    if (!bundle) throw new Error('설치된 앱에서만 업데이트할 수 있어요')
    const parent = dirname(bundle)
    // 같은 폴더(같은 디스크)에 풀어야 바꿔 끼우기가 한 번에 된다
    const tmp = join(parent, `.dool2-update-${Date.now()}`)
    try {
      await exec('/usr/bin/ditto', ['-x', '-k', file, tmp])
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      const msg = (e as Error).message
      throw new Error(
        /Permission denied|Operation not permitted/i.test(msg)
          ? `${parent} 폴더에 쓸 권한이 없어요. 다운로드 페이지에서 새 버전을 받아 바꿔 주세요`
          : msg,
      )
    }
    const fresh = (await readdir(tmp)).find((n) => n.endsWith('.app'))
    if (!fresh) {
      await rm(tmp, { recursive: true, force: true })
      throw new Error('업데이트 파일 안에 앱이 없어요')
    }
    // 새 앱이 제대로 서명돼 있는지 (부서진 묶음을 끼우지 않게)
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(tmp, fresh)])
    const old = `${bundle}.old-${Date.now()}`
    await rename(bundle, old)
    try {
      await rename(join(tmp, fresh), bundle)
    } catch (e) {
      await rename(old, bundle).catch(() => undefined)
      throw e
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    await rm(old, { recursive: true, force: true }).catch(() => undefined)
    await rm(file, { force: true }).catch(() => undefined)
    await d.relaunch()
    return
  }
  if (platform === 'win32') {
    if (!existsSync(file)) throw new Error('업데이트 파일이 없어요')
    const start =
      d.spawnDetached ??
      ((f: string, args: string[]) => spawn(f, args, { detached: true, stdio: 'ignore' }).unref())
    start(file, ['/S', '--force-run'])
    await d.quit()
    return
  }
  throw new Error('이 운영체제에서는 앱 안 업데이트를 아직 못 해요')
}
