import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_DOWNLOAD_BASE, ClaudeInstall, claudePlatform, installClaudeCode } from './install.js'

const BIN = new Uint8Array(200_000).fill(7)
const SUM = createHash('sha256').update(BIN).digest('hex')

function fakeFetch(opts: { latest?: string; checksum?: string; body?: Uint8Array } = {}) {
  const seen: string[] = []
  const fn = (async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url.replace(CLAUDE_DOWNLOAD_BASE, ''))
    if (url.endsWith('/latest')) return new Response(opts.latest ?? '2.1.325\n')
    if (url.endsWith('/manifest.json'))
      return Response.json({
        platforms: { 'darwin-arm64': { binary: 'claude', checksum: opts.checksum ?? SUM, size: BIN.length } },
      })
    if (url.endsWith('/darwin-arm64/claude')) return new Response(opts.body ?? BIN)
    return new Response('nope', { status: 404 })
  }) as typeof fetch
  return { fn, seen }
}

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('Claude Code 설치', () => {
  it('플랫폼 이름을 공식 배포 서버 형식으로 바꾼다', () => {
    expect(claudePlatform('darwin', 'arm64')).toBe('darwin-arm64')
    expect(claudePlatform('darwin', 'x64', 'Apple M2')).toBe('darwin-arm64')
    expect(claudePlatform('darwin', 'x64', 'Intel(R) Core(TM) i7')).toBe('darwin-x64')
    expect(claudePlatform('win32', 'x64')).toBe('win32-x64')
    expect(claudePlatform('win32', 'ia32')).toBeUndefined()
  })

  it('최신 버전 → 매니페스트 → 내려받기 → 체크섬 → 공식 install 순서로 설치하고 파일을 지운다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-install-'))
    const { fn, seen } = fakeFetch()
    const phases: string[] = []
    let ran = ''
    const version = await installClaudeCode({
      downloadDir: dir,
      platform: 'darwin-arm64',
      fetch: fn,
      runInstall: async (bin) => {
        ran = bin
        return 0
      },
      onProgress: (p, pct) => phases.push(pct === undefined ? p : `${p}:${pct}`),
    })
    expect(version).toBe('2.1.325')
    expect(seen).toEqual(['/latest', '/2.1.325/manifest.json', '/2.1.325/darwin-arm64/claude'])
    expect(ran).toContain('claude-2.1.325-darwin-arm64')
    expect(phases[0]).toBe('prepare')
    expect(phases).toContain('download:0')
    expect(phases.slice(-2)).toEqual(['verify', 'setup'])
    expect(await readdir(dir)).toEqual([])
  })

  it('체크섬이 다르면 설치하지 않는다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-install-'))
    let ran = false
    const run = installClaudeCode({
      downloadDir: dir,
      platform: 'darwin-arm64',
      fetch: fakeFetch({ body: new Uint8Array(BIN.length).fill(9) }).fn,
      runInstall: async () => {
        ran = true
        return 0
      },
    })
    await expect(run).rejects.toThrow('공식 파일과 달라요')
    expect(ran).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it('버전 대신 다른 내용이 오면 지역 제한일 수 있다고 알려 준다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-install-'))
    const run = installClaudeCode({
      downloadDir: dir,
      platform: 'darwin-arm64',
      fetch: fakeFetch({ latest: '<html>blocked</html>' }).fn,
    })
    await expect(run).rejects.toThrow('이 지역에서')
  })

  it('설치 버튼 상태: 진행 → 완료, 실패하면 이유를 남긴다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-install-'))
    const ok = new ClaudeInstall({
      downloadDir: dir,
      platform: 'darwin-arm64',
      fetch: fakeFetch().fn,
      runInstall: async () => 0,
      verify: async () => true,
    })
    expect(ok.start()).toMatchObject({ state: 'running' })
    await expect.poll(() => ok.status.state).toBe('done')
    expect(ok.status).toEqual({ state: 'done', version: '2.1.325' })

    const bad = new ClaudeInstall({
      downloadDir: dir,
      platform: 'darwin-arm64',
      fetch: fakeFetch().fn,
      runInstall: async () => 3,
    })
    bad.start()
    await expect.poll(() => bad.status.state).toBe('failed')
    expect(bad.status).toMatchObject({ message: expect.stringContaining('종료 코드 3') })
  })
})
