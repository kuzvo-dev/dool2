import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundledChromiumManifest,
  ChromiumInstall,
  ChromiumInstallError,
  type ChromiumManifest,
  chromiumExecutable,
  chromiumPlatform,
  installChromium,
  parseChromiumManifest,
  pickChromiumBuild,
} from './chromium.js'
import { CHROMIUM_MANIFEST } from './chromium-manifest.js'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'dool2-chromium-'))
  dirs.push(d)
  return d
}

const ZIP = Buffer.from('pretend this is a zip of Chromium')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const manifest = (over: Partial<ChromiumManifest['builds']['mac-arm64']> = {}): ChromiumManifest => ({
  version: '160.0.8187.0',
  revision: 42,
  builds: {
    'mac-arm64': {
      url: 'https://example.test/Mac_Arm/42/chrome-mac.zip',
      size: ZIP.length,
      sha256: sha(ZIP),
      executable: 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ...over,
    },
  },
})
/** Unpacks the pretend zip as the program file */
const fakeExtract = async (_zip: string, into: string) => {
  const dir = join(into, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'Chromium'), '#!/bin/sh\n')
}

describe('Chromium manifest', () => {
  it('the bundled manifest is complete: every platform, real checksums, https', () => {
    const m = parseChromiumManifest(CHROMIUM_MANIFEST)
    expect(Object.keys(m.builds).sort()).toEqual(['linux64', 'mac-arm64', 'mac-x64', 'win64'])
    for (const b of Object.values(m.builds)) {
      expect(b.url).toMatch(/^https:\/\/commondatastorage\.googleapis\.com\/chromium-browser-snapshots\//)
      expect(b.url).toContain(`/${m.revision}/`)
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('picks the build for each computer', () => {
    const m = bundledChromiumManifest()
    expect(chromiumPlatform('darwin', 'arm64')).toBe('mac-arm64')
    expect(chromiumPlatform('darwin', 'x64')).toBe('mac-x64')
    expect(chromiumPlatform('win32', 'x64')).toBe('win64')
    expect(chromiumPlatform('linux', 'x64')).toBe('linux64')
    expect(chromiumPlatform('win32', 'arm64')).toBeUndefined()
    expect(chromiumPlatform('freebsd', 'x64')).toBeUndefined()
    expect(pickChromiumBuild(m, 'darwin', 'arm64')?.url).toContain('/Mac_Arm/')
    expect(pickChromiumBuild(m, 'darwin', 'x64')?.url).toContain('/Mac/')
    expect(pickChromiumBuild(m, 'win32', 'x64')?.executable).toBe('chrome-win/chrome.exe')
    expect(pickChromiumBuild(m, 'win32', 'ia32')).toBeUndefined()
    expect(chromiumExecutable('/data', m, 'darwin', 'arm64')).toBe(
      join(
        '/data',
        'chromium',
        String(m.revision),
        'chrome-mac',
        'Chromium.app',
        'Contents',
        'MacOS',
        'Chromium',
      ),
    )
  })

  it('refuses manifests Dool2 should not download from', () => {
    const good = manifest()
    const build = good.builds['mac-arm64']
    const bad = (b: unknown) => () => parseChromiumManifest({ ...good, builds: { 'mac-arm64': b } })
    expect(() => parseChromiumManifest({ ...good, version: '160' })).toThrow(/version/)
    expect(bad({ ...build, url: 'http://example.test/a.zip' })).toThrow(/url/)
    expect(bad({ ...build, sha256: 'abc' })).toThrow(/sha256/)
    expect(bad({ ...build, sha256: 'SHA_PLACEHOLDER'.padEnd(64, '0') })).toThrow(/sha256/)
    expect(bad({ ...build, size: 0 })).toThrow(/size/)
    expect(bad({ ...build, executable: '../../bin/sh' })).toThrow(/executable/)
    expect(() => parseChromiumManifest({ ...good, builds: { 'mac-ppc': build } })).toThrow(/platform/)
    expect(parseChromiumManifest(good)).toEqual(good)
  })
})

describe('installChromium', () => {
  it('downloads, checks, unpacks and clears quarantine only on its own folder', async () => {
    const dataDir = await tmp()
    const calls: string[][] = []
    const phases: string[] = []
    const bin = await installChromium({
      dataDir,
      manifest: manifest(),
      platform: 'darwin',
      arch: 'arm64',
      fetch: (async () => new Response(ZIP)) as typeof fetch,
      extract: fakeExtract,
      exec: async (cmd, args) => {
        calls.push([cmd, ...args])
        return 0
      },
      onProgress: (p) => phases.push(p),
    })
    expect(bin).toBe(
      join(dataDir, 'chromium', '42', 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    )
    expect(existsSync(bin)).toBe(true)
    expect([...new Set(phases)]).toEqual(['prepare', 'download', 'verify', 'setup'])
    expect(calls).toEqual([
      ['/usr/bin/xattr', '-dr', 'com.apple.quarantine', join(dataDir, 'chromium', '42.tmp')],
    ])
    // Nothing else left behind
    expect((await readdir(join(dataDir, 'chromium'))).sort()).toEqual(['42'])
    // A second call finds it
    const again = await installChromium({
      dataDir,
      manifest: manifest(),
      platform: 'darwin',
      arch: 'arm64',
      fetch: (async () => {
        throw new Error('should not download')
      }) as typeof fetch,
    })
    expect(again).toBe(bin)
  })

  it('stops on a checksum mismatch and leaves nothing unpacked', async () => {
    const dataDir = await tmp()
    let extracted = false
    const err = await installChromium({
      dataDir,
      manifest: manifest({ sha256: 'f'.repeat(64) }),
      platform: 'darwin',
      arch: 'arm64',
      fetch: (async () => new Response(ZIP)) as typeof fetch,
      extract: async () => {
        extracted = true
      },
      exec: async () => 0,
      lang: 'en',
    }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(ChromiumInstallError)
    expect((err as Error).message).toMatch(/don't match/)
    expect(extracted).toBe(false)
    expect(await readdir(join(dataDir, 'chromium'))).toEqual([])
  })

  it('stops when the server sends more than the pinned size', async () => {
    const dataDir = await tmp()
    const err = await installChromium({
      dataDir,
      manifest: manifest({ size: ZIP.length - 5 }),
      platform: 'darwin',
      arch: 'arm64',
      fetch: (async () => new Response(ZIP)) as typeof fetch,
      extract: fakeExtract,
      exec: async () => 0,
      lang: 'en',
    }).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/don't match/)
  })

  it('tries again on network trouble, not on a wrong file', async () => {
    const dataDir = await tmp()
    let n = 0
    const bin = await installChromium({
      dataDir,
      manifest: manifest(),
      platform: 'darwin',
      arch: 'arm64',
      fetch: (async () => {
        n++
        if (n === 1) throw new TypeError('fetch failed')
        if (n === 2) return new Response('', { status: 503 })
        return new Response(ZIP)
      }) as typeof fetch,
      extract: fakeExtract,
      exec: async () => 0,
      backoffMs: () => 1,
    })
    expect(n).toBe(3)
    expect(existsSync(bin)).toBe(true)

    let m = 0
    const err = await installChromium({
      dataDir: await tmp(),
      manifest: manifest(),
      platform: 'darwin',
      arch: 'arm64',
      fetch: (async () => {
        m++
        return new Response('', { status: 404 })
      }) as typeof fetch,
      backoffMs: () => 1,
      lang: 'en',
    }).catch((e: Error) => e)
    expect(m).toBe(1)
    expect((err as Error).message).toMatch(/404/)
  })

  it('says so on a computer without a build', async () => {
    const err = await installChromium({
      dataDir: await tmp(),
      platform: 'win32',
      arch: 'arm64',
      lang: 'en',
    }).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/isn't available/)
  })

  it('removes builds of earlier Dool2 versions after a good install', async () => {
    const dataDir = await tmp()
    await mkdir(join(dataDir, 'chromium', '41', 'chrome-mac'), { recursive: true })
    await installChromium({
      dataDir,
      manifest: manifest(),
      platform: 'darwin',
      arch: 'arm64',
      fetch: (async () => new Response(ZIP)) as typeof fetch,
      extract: fakeExtract,
      exec: async () => 0,
    })
    expect(await readdir(join(dataDir, 'chromium'))).toEqual(['42'])
  })

  it('the session reports progress like the other installs and shares one download', async () => {
    const dataDir = await tmp()
    let fetches = 0
    const s = new ChromiumInstall({
      dataDir,
      manifest: manifest(),
      platform: 'darwin',
      arch: 'arm64',
      fetch: (async () => {
        fetches++
        return new Response(ZIP)
      }) as typeof fetch,
      extract: fakeExtract,
      exec: async () => 0,
    })
    expect(s.status).toEqual({ state: 'idle' })
    const a = s.ensure()
    const b = s.ensure()
    expect(s.status.state).toBe('running')
    expect(await a).toBe(await b)
    expect(fetches).toBe(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(s.status).toEqual({ state: 'done', version: '160.0.8187.0' })
    const st = await stat(await a)
    expect(st.isFile()).toBe(true)
  })
})
