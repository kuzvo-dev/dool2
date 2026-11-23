import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { newer, openRelease, type Release, signRelease, UPDATE_PUBLIC_KEY, Updater } from './update.js'
import { appBundle, installUpdate } from './update-install.js'

const keys = generateKeyPairSync('ed25519')
const PRIV = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const PUB = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const BODY = Buffer.from('new dool2 build')
const sha = createHash('sha256').update(BODY).digest('hex')
const release = (over: Partial<Release> = {}): Release => ({
  version: '0.3.0',
  notes: 'AI 영상 클립',
  files: {
    'darwin-arm64': { url: 'https://example.com/dool2-0.3.0-arm64-mac.zip', sha256: sha, size: BODY.length },
  },
  ...over,
})

function feed(body: unknown, file: Buffer = BODY) {
  return (async (url: string | URL | Request) => {
    const u = String(url)
    if (u.endsWith('version.json')) return new Response(JSON.stringify(body))
    return new Response(file)
  }) as typeof fetch
}

describe('버전 비교', () => {
  it('앞 세 자리 숫자로 본다', () => {
    expect(newer('0.10.0', '0.9.9')).toBe(true)
    expect(newer('0.3.0', '0.3.0')).toBe(false)
    expect(newer('0.2.9', '0.3.0')).toBe(false)
    expect(newer('1.0.0-beta.1', '0.9.0')).toBe(true)
  })
})

describe('버전 안내 서명', () => {
  it('우리 키로 서명한 안내만 연다', () => {
    const s = signRelease(release(), PRIV)
    expect(openRelease(s, PUB)?.version).toBe('0.3.0')
    // 내용을 바꾸면 서명이 맞지 않는다
    const forged = {
      ...s,
      payload: Buffer.from(JSON.stringify(release({ version: '9.9.9' }))).toString('base64'),
    }
    expect(openRelease(forged, PUB)).toBeUndefined()
    // 다른 키(앱에 든 공개키)로는 열리지 않는다
    expect(openRelease(s, UPDATE_PUBLIC_KEY)).toBeUndefined()
    expect(openRelease({ nope: 1 }, PUB)).toBeUndefined()
  })
})

describe('새 버전 찾고 깔기', () => {
  const make = async (body: unknown, opts: { current?: string; file?: Buffer } = {}) => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-up-'))
    const installed: string[] = []
    const u = new Updater({
      current: opts.current ?? '0.2.0',
      platform: 'darwin-arm64',
      publicKey: PUB,
      dir,
      fetch: feed(body, opts.file),
      install: async (f) => {
        installed.push(f)
      },
    })
    return { u, installed }
  }

  it('새 버전이 있으면 알리고, 받아 확인값을 맞춘 뒤 깐다', async () => {
    const { u, installed } = await make(signRelease(release(), PRIV))
    expect((await u.check()).status).toBe('available')
    expect(u.state()).toMatchObject({ latest: '0.3.0', notes: 'AI 영상 클립', required: false })
    const s = await u.install()
    expect(s.status).toBe('installing')
    expect(installed).toHaveLength(1)
    expect(await readFile(installed[0] as string)).toEqual(BODY)
  })

  it('최소 버전보다 낮으면 꼭 업데이트해야 한다고 표시한다', async () => {
    const { u } = await make(signRelease(release({ min: '0.3.0' }), PRIV))
    expect((await u.check()).required).toBe(true)
  })

  it('최신이거나 이 PC용 파일이 없으면 알리지 않는다', async () => {
    expect((await (await make(signRelease(release(), PRIV), { current: '0.3.0' })).u.check()).status).toBe(
      'none',
    )
    const other = release({ files: { 'win32-x64': release().files['darwin-arm64'] as never } })
    expect((await (await make(signRelease(other, PRIV))).u.check()).status).toBe('none')
  })

  it('서명이 틀린 안내는 믿지 않는다', async () => {
    const bad = signRelease(
      release(),
      generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    )
    const s = await (await make(bad)).u.check()
    expect(s.status).toBe('error')
    expect(s.error).toContain('서명')
  })

  it('받은 파일의 확인값이 다르면 깔지 않고 지운다', async () => {
    const { u, installed } = await make(signRelease(release(), PRIV), {
      file: Buffer.from('tampered build!'),
    })
    await u.check()
    const s = await u.install()
    expect(s.status).toBe('error')
    expect(s.error).toContain('확인값')
    expect(installed).toHaveLength(0)
    expect(existsSync(join(dir as string, 'dool2-0.3.0-arm64-mac.zip'))).toBe(false)
  })
})

describe('플랫폼별 설치', () => {
  it('실행 파일에서 앱 묶음을 찾는다', () => {
    expect(appBundle('/Applications/두리.app/Contents/MacOS/Dool2')).toBe('/Applications/두리.app')
    expect(appBundle('/usr/local/bin/electron')).toBeUndefined()
  })

  it('윈도우는 설치 파일을 조용히 돌리고 앱을 끝낸다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-up-'))
    const exe = join(dir, 'dool2-setup.exe')
    await (await import('node:fs/promises')).writeFile(exe, 'x')
    const ran: string[][] = []
    let quit = false
    await installUpdate(exe, {
      exe: 'C:\\두리\\Dool2.exe',
      platform: 'win32',
      relaunch: async () => {},
      quit: async () => {
        quit = true
      },
      spawnDetached: (f, args) => ran.push([f, ...args]),
    })
    expect(ran).toEqual([[exe, '/S', '--force-run']])
    expect(quit).toBe(true)
  })

  it('맥에서 설치된 앱이 아니면(개발 실행) 바꿔 끼우지 않는다', async () => {
    await expect(
      installUpdate('/tmp/x.zip', {
        exe: '/repo/node_modules/electron/dist/Electron',
        platform: 'darwin',
        relaunch: async () => {},
        quit: async () => {},
      }),
    ).rejects.toThrow('설치된 앱')
  })
})

describe('릴리스 버전 안내 만들기 (scripts/release-manifest.mjs)', () => {
  it('플랫폼별 파일의 확인값을 적고 서명해, 앱이 그대로 연다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-rel-'))
    await writeFile(join(dir, 'dool2-0.3.0-mac-arm64.zip'), BODY)
    await writeFile(join(dir, 'dool2-0.3.0-win-x64.exe'), 'win')
    await writeFile(join(dir, 'dool2-0.3.0-mac-arm64.dmg'), 'dmg는 넣지 않는다')
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'release-manifest.mjs')
    execFileSync(
      process.execPath,
      [script, '--dir', dir, '--version', '0.3.0', '--notes', '새 버전', '--min', '0.2.0'],
      {
        env: { ...process.env, DOOL2_UPDATE_KEY: PRIV },
        stdio: 'pipe',
      },
    )
    const r = openRelease(JSON.parse(await readFile(join(dir, 'version.json'), 'utf8')), PUB)
    expect(r).toMatchObject({ version: '0.3.0', min: '0.2.0', notes: '새 버전' })
    expect(Object.keys(r?.files ?? {})).toEqual(['darwin-arm64', 'win32-x64'])
    expect(r?.files['darwin-arm64']).toMatchObject({ sha256: sha, size: BODY.length })
    expect(r?.files['darwin-arm64']?.url).toBe(
      'https://github.com/kuzvo-dev/dool2/releases/download/v0.3.0/dool2-0.3.0-mac-arm64.zip',
    )
  })
})
