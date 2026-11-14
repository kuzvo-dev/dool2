import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type ChromeEnv, compareVersions, detectChrome, type Exec, installChrome } from './chrome.js'

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
    const app = join('C:\\Users\\u\\AppData\\Local', 'Google', 'Chrome', 'Application')
    const s = await detectChrome(
      env({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        files: [join(app, 'chrome.exe')],
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
