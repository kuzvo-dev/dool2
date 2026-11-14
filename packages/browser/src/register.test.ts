import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BROWSER_HOST_NAME, DEV_EXTENSION_ID } from '@dool2/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { hostTargets, launcherScript, registerNativeHost } from './register.js'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('native messaging 호스트 등록', () => {
  it('OS마다 사용자 위치에만 등록한다', () => {
    expect(hostTargets('darwin', '/Users/u')[0]).toBe(
      '/Users/u/Library/Application Support/Google/Chrome/NativeMessagingHosts',
    )
    expect(hostTargets('linux', '/home/u')[0]).toBe('/home/u/.config/google-chrome/NativeMessagingHosts')
    expect(hostTargets('win32', 'C:\\Users\\u')[0]).toBe(
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BROWSER_HOST_NAME}`,
    )
  })

  it('실행 스크립트에 데이터 폴더와 실행 방법을 담는다', () => {
    const rt = {
      command: '/Apps/Dool2.app/Contents/MacOS/dool2',
      args: ["/a b/host's.mjs"],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
    const sh = launcherScript('darwin', '/Users/u/dool2', rt)
    expect(sh).toContain("export DOOL2_DATA_DIR='/Users/u/dool2'")
    expect(sh).toContain("export ELECTRON_RUN_AS_NODE='1'")
    expect(sh).toContain(`exec '/Apps/Dool2.app/Contents/MacOS/dool2' '/a b/host'\\''s.mjs' "$@"`)

    const bat = launcherScript('win32', 'C:\\dool2', { command: 'C:\\D\\dool2.exe', args: ['C:\\D\\h.mjs'] })
    expect(bat).toBe(
      '@echo off\r\nset "DOOL2_DATA_DIR=C:\\dool2"\r\n"C:\\D\\dool2.exe" "C:\\D\\h.mjs" %*\r\n',
    )
  })

  it('맥: 실행 스크립트·등록 파일을 만들고, 설치된 브라우저에만 복사한다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-reg-'))
    const home = join(dir, 'home')
    // Edge만 설치돼 있다고 치자 (Chrome은 없어도 미리 둔다)
    await mkdir(join(home, 'Library', 'Application Support', 'Microsoft Edge'), { recursive: true })
    const extra = join(dir, 'profile', 'NativeMessagingHosts')
    const reg = await registerNativeHost({
      dataDir: join(dir, 'data'),
      runtime: { command: '/usr/bin/node', args: ['/x/host.js'] },
      platform: 'darwin',
      home,
      extraDirs: [extra],
    })
    // 윈도우에서 돌아도 같은 문자열이 나오게 같은 함수로 만든다
    const t = hostTargets('darwin', home)
    expect(reg.targets).toEqual([t[0], t[3], extra])
    const manifest = JSON.parse(await readFile(join(extra, `${BROWSER_HOST_NAME}.json`), 'utf8'))
    expect(manifest).toMatchObject({
      name: BROWSER_HOST_NAME,
      type: 'stdio',
      path: reg.launcher,
      allowed_origins: [`chrome-extension://${DEV_EXTENSION_ID}/`],
    })
    if (process.platform !== 'win32') expect((await stat(reg.launcher)).mode & 0o111).toBeTruthy()
  })

  it('윈도우: 사용자 레지스트리에 등록 파일 경로를 적는다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-reg-'))
    const calls: string[][] = []
    const reg = await registerNativeHost({
      dataDir: join(dir, 'data'),
      runtime: { command: 'C:\\D\\dool2.exe', args: ['C:\\D\\h.mjs'] },
      platform: 'win32',
      home: 'C:\\Users\\u',
      exec: async (cmd, args) => {
        calls.push([cmd, ...args])
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    expect(reg.launcher.endsWith('dool2-host.bat')).toBe(true)
    expect(calls[0]).toEqual([
      'reg',
      'add',
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BROWSER_HOST_NAME}`,
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      reg.manifest,
      '/f',
    ])
    expect(reg.targets).toHaveLength(3)
  })
})
