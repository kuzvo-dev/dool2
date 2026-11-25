import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ChromeEnv,
  chromeRunning,
  compareVersions,
  detectChrome,
  type Exec,
  findChromeProfile,
  installChrome,
  launchChrome,
} from './chrome.js'

function env(
  over: Partial<ChromeEnv> & { files?: string[]; dirs?: Record<string, string[]> } = {},
): ChromeEnv {
  const files = new Set(over.files ?? [])
  return {
    platform: 'darwin',
    home: '/Users/u',
    env: {},
    exists: async (p) => files.has(p),
    list: async (d) => over.dirs?.[d] ?? [],
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    ...over,
  }
}

const okFetch = (async () => new Response(new Uint8Array(1000).fill(1))) as unknown as typeof fetch

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('Chrome 확인', () => {
  it('맥: 응용 프로그램 폴더의 Chrome과 버전을 찾는다', async () => {
    const s = await detectChrome(
      env({
        files: ['/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
        exec: async () => ({ code: 0, stdout: '157.0.8103.51\n', stderr: '' }),
      }),
    )
    expect(s).toEqual({
      installed: true,
      path: '/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      version: '157.0.8103.51',
    })
  })

  it('윈도우: 사용자 폴더 설치도 찾고, 가장 높은 버전 폴더를 쓴다', async () => {
    const app = win32.join('C:\\Users\\u\\AppData\\Local', 'Google', 'Chrome', 'Application')
    const s = await detectChrome(
      env({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        files: [win32.join(app, 'chrome.exe')],
        dirs: { [app]: ['156.0.1.2', '157.0.8103.51', 'SetupMetrics', '99.0.0.1'] },
      }),
    )
    expect(s).toMatchObject({ installed: true, version: '157.0.8103.51' })
  })

  it('없으면 없다고 한다', async () => {
    expect(await detectChrome(env())).toEqual({ installed: false })
  })

  it('버전을 숫자로 비교한다', () => {
    expect(['10.0.0.1', '9.9.9.9', '157.0.1.0'].sort(compareVersions)).toEqual([
      '9.9.9.9',
      '10.0.0.1',
      '157.0.1.0',
    ])
  })
})

describe('Chrome 설치', () => {
  it('맥: 내려받기 → 열기 → Google 서명 확인 → 복사 → 정리', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-chrome-'))
    const calls: string[] = []
    const exec: Exec = async (cmd, args) => {
      calls.push(`${cmd.split('/').pop()} ${args[0]}`)
      if (cmd.endsWith('codesign') && args[0] === '-dv')
        return {
          code: 0,
          stdout: '',
          stderr: 'Authority=Developer ID Application: Google LLC\nTeamIdentifier=EQHXZ8M8AV\n',
        }
      if (cmd.endsWith('spctl'))
        return {
          code: 0,
          stdout: '',
          stderr:
            'accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Google LLC (EQHXZ8M8AV)\n',
        }
      return { code: 0, stdout: '', stderr: '' }
    }
    const phases: string[] = []
    await installChrome({
      downloadDir: dir,
      env: env({ exec }),
      fetch: okFetch,
      macTargets: ['/Applications'],
      onProgress: (p) => phases.push(p),
    })
    expect(calls.map((c) => c.split(' ')[0])).toEqual([
      'hdiutil',
      'codesign',
      'codesign',
      'spctl',
      'ditto',
      'hdiutil',
    ])
    expect(calls.at(-1)).toBe('hdiutil detach')
    expect([...new Set(phases)]).toEqual(['prepare', 'download', 'verify', 'setup'])
    expect(await readdir(dir)).toEqual([])
  })

  it('맥: Google 서명이 아니면 복사하지 않는다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-chrome-'))
    const calls: string[] = []
    const exec: Exec = async (cmd, args) => {
      calls.push(cmd.split('/').pop() ?? '')
      if (cmd.endsWith('codesign') && args[0] === '-dv')
        return { code: 0, stdout: '', stderr: 'TeamIdentifier=EVIL123' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await expect(installChrome({ downloadDir: dir, env: env({ exec }), fetch: okFetch })).rejects.toThrow(
      'Google 공식 Chrome이 아니에요',
    )
    expect(calls).not.toContain('ditto')
    expect(calls.at(-1)).toBe('hdiutil')
  })

  it('윈도우: Google LLC의 유효한 서명일 때만 조용히 설치한다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-chrome-'))
    const ran: string[][] = []
    const exec: Exec = async (cmd, args) => {
      ran.push([cmd.split(/[\\/]/).pop() ?? '', ...args.slice(0, 2)])
      if (cmd === 'powershell.exe')
        return { code: 0, stdout: 'Valid|CN=Google LLC, O=Google LLC, L=Mountain View\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await installChrome({ downloadDir: dir, env: env({ platform: 'win32', exec }), fetch: okFetch })
    expect(ran[0]?.[0]).toBe('powershell.exe')
    expect(ran[1]).toEqual(['chrome_installer.exe', '/silent', '/install'])

    const bad: Exec = async (cmd) =>
      cmd === 'powershell.exe'
        ? { code: 0, stdout: 'NotSigned|\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' }
    await expect(
      installChrome({ downloadDir: dir, env: env({ platform: 'win32', exec: bad }), fetch: okFetch }),
    ).rejects.toThrow('Google 공식 Chrome이 아니에요')
  })
})

describe('Opening the user Chrome', () => {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const recorder = () => {
    const calls: [string, string[]][] = []
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, args])
      return { code: 0, stdout: '', stderr: '' }
    }
    const detach = async (cmd: string, args: string[]) => {
      calls.push([cmd, args])
      return true
    }
    return { calls, exec, detach }
  }

  it('macOS: opens the app behind the current window, into the profile with the extension', async () => {
    const r = recorder()
    const ok = await launchChrome(env(r), { installed: true, path: macChrome }, { profile: 'Profile 1' })
    expect(ok).toBe(true)
    expect(r.calls).toEqual([
      [
        '/usr/bin/open',
        ['-g', '-a', '/Applications/Google Chrome.app', '--args', '--profile-directory=Profile 1'],
      ],
    ])
  })

  it('macOS: with no profile known, opens it with no flags', async () => {
    const r = recorder()
    await launchChrome(env(r), { installed: true, path: macChrome })
    expect(r.calls).toEqual([['/usr/bin/open', ['-g', '-a', '/Applications/Google Chrome.app']]])
  })

  it('macOS while Chrome runs (profile picker): hands the profile to the running Chrome', async () => {
    const r = recorder()
    await launchChrome(env(r), { installed: true, path: macChrome }, { profile: 'Default', running: true })
    expect(r.calls).toEqual([[macChrome, ['--profile-directory=Default']]])
  })

  it('never passes a profile name that is not a plain folder name', async () => {
    const r = recorder()
    await launchChrome(
      env(r),
      { installed: true, path: macChrome },
      { profile: '../x --remote-debugging-port=1' },
    )
    expect(r.calls).toEqual([['/usr/bin/open', ['-g', '-a', '/Applications/Google Chrome.app']]])
  })

  it('Windows: starts the found chrome.exe minimized, in that profile', async () => {
    const r = recorder()
    const path = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    const ok = await launchChrome(
      env({ ...r, platform: 'win32' }),
      { installed: true, path },
      { profile: 'Profile 2' },
    )
    expect(ok).toBe(true)
    expect(r.calls[0]?.[0]).toBe('powershell.exe')
    expect(r.calls[0]?.[1].at(-1)).toBe(
      `Start-Process -FilePath '${path}' -ArgumentList '--profile-directory="Profile 2"' -WindowStyle Minimized`,
    )
  })

  it('Linux: starts it detached', async () => {
    const r = recorder()
    const ok = await launchChrome(env({ ...r, platform: 'linux' }), {
      installed: true,
      path: '/usr/bin/google-chrome',
    })
    expect(ok).toBe(true)
    expect(r.calls).toEqual([['/usr/bin/google-chrome', []]])
  })

  it('does nothing when Chrome is not installed', async () => {
    expect(await launchChrome(env(), { installed: false })).toBe(false)
  })

  it('tells whether Chrome runs, and says running when it cannot tell', async () => {
    const code = (c: number | null) => env({ exec: async () => ({ code: c, stdout: '', stderr: '' }) })
    expect(await chromeRunning(code(0))).toBe(true)
    expect(await chromeRunning(code(1))).toBe(false)
    expect(await chromeRunning(code(2))).toBe(true)
    const win = (stdout: string) =>
      env({ platform: 'win32', exec: async () => ({ code: 0, stdout, stderr: '' }) })
    expect(await chromeRunning(win('"chrome.exe","1234","Console","1","120,000 K"\r\n'))).toBe(true)
    expect(
      await chromeRunning(win('INFO: No tasks are running which match the specified criteria.\r\n')),
    ).toBe(false)
  })
})

describe('Finding the profile with the Dool2 extension', () => {
  const root = '/Users/u/Library/Application Support/Google/Chrome'
  const ID = 'a'.repeat(32)
  const state = (profile: Record<string, unknown>) => JSON.stringify({ profile })
  const pc = (files: Record<string, string>, dirs: string[] = []) =>
    env({ files: dirs, read: async (p) => files[p] })

  it('prefers the last used profile when the extension is in it', async () => {
    const e = pc(
      {
        [`${root}/Local State`]: state({
          last_used: 'Profile 1',
          info_cache: { Default: { name: 'Home' }, 'Profile 1': { name: 'Work' } },
        }),
      },
      [`${root}/Default/Extensions/${ID}`, `${root}/Profile 1/Extensions/${ID}`],
    )
    expect(await findChromeProfile(e, [ID])).toEqual({ dir: 'Profile 1', name: 'Work', hasExtension: true })
  })

  it('finds the extension in another profile (store folder or loaded from a folder)', async () => {
    const files = {
      [`${root}/Local State`]: state({
        last_used: 'Default',
        info_cache: { Default: { name: 'Home' }, 'Profile 3': { name: 'Shop' } },
      }),
    }
    expect(await findChromeProfile(pc(files, [`${root}/Profile 3/Extensions/${ID}`]), [ID])).toEqual({
      dir: 'Profile 3',
      name: 'Shop',
      hasExtension: true,
    })
    const loaded = {
      ...files,
      [`${root}/Profile 3/Secure Preferences`]: `{"extensions":{"settings":{"${ID}":{}}}}`,
    }
    expect((await findChromeProfile(pc(loaded), [ID]))?.dir).toBe('Profile 3')
  })

  it('no profile has it: the last used one; no Local State: nothing', async () => {
    const files = {
      [`${root}/Local State`]: state({ last_used: 'Profile 1', info_cache: { 'Profile 1': {} } }),
    }
    expect(await findChromeProfile(pc(files), [ID])).toEqual({ dir: 'Profile 1', hasExtension: false })
    expect(await findChromeProfile(pc({}), [ID])).toBeUndefined()
    expect(await findChromeProfile(pc({ [`${root}/Local State`]: 'not json' }), [ID])).toBeUndefined()
  })

  it('Windows: reads the User Data folder under LOCALAPPDATA', async () => {
    const local = 'C:\\Users\\u\\AppData\\Local'
    const file = `${local}\\Google\\Chrome\\User Data\\Local State`
    const e = env({
      platform: 'win32',
      env: { LOCALAPPDATA: local },
      read: async (p) =>
        p === file ? state({ last_used: 'Default', info_cache: { Default: { name: 'Me' } } }) : undefined,
    })
    expect(await findChromeProfile(e, [ID])).toEqual({ dir: 'Default', name: 'Me', hasExtension: false })
  })
})
