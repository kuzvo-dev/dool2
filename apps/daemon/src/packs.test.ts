import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { Connectors } from './connectors.js'
import { ConnectorPacks, openPack, type PackBundle, type PackManifest } from './packs.js'

const REPO_SKILLS = fileURLToPath(new URL('../../../skills', import.meta.url))
const ours = generateKeyPairSync('ed25519')
const theirs = generateKeyPairSync('ed25519')
const PUB = ours.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const FEED = 'https://example.test/pack.json'
const URL_ = 'https://example.test/connectors-200.json.gz'

const text = (id: string, file: string) => readFileSync(join(REPO_SKILLS, id, file), 'utf8')

/** A pack with the real coupang card and connector, signed with the given key */
function makePack(
  pack: number,
  opts: {
    key?: typeof ours.privateKey
    minApp?: string
    files?: Record<string, string>
    corrupt?: boolean
  } = {},
) {
  const bundle: PackBundle = {
    pack,
    files: opts.files ?? {
      'coupang/connect.json': text('coupang', 'connect.json'),
      'coupang/tools.json': text('coupang', 'tools.json'),
    },
  }
  const gz = gzipSync(Buffer.from(JSON.stringify(bundle)))
  const manifest: PackManifest = {
    pack,
    minApp: opts.minApp ?? '0.4.0',
    date: '2026-11-25T00:00:00Z',
    url: URL_,
    sha256: createHash('sha256').update(gz).digest('hex'),
    size: gz.length,
  }
  const data = Buffer.from(JSON.stringify(manifest))
  const signed = {
    payload: data.toString('base64'),
    signature: sign(null, data, opts.key ?? ours.privateKey).toString('base64'),
  }
  const body = opts.corrupt ? Buffer.concat([gz.subarray(0, -1), Buffer.from([(gz.at(-1) ?? 0) ^ 0xff])]) : gz
  const fetch = (async (url: string) =>
    url === FEED ? Response.json(signed) : new Response(body)) as unknown as typeof globalThis.fetch
  return { fetch, manifest }
}

function setup(bundledPack = 100) {
  const root = mkdtempSync(join(tmpdir(), 'dool2-packs-'))
  const bundled = join(root, 'app-skills')
  cpSync(join(REPO_SKILLS, 'coupang'), join(bundled, 'coupang'), { recursive: true })
  return { dataDir: join(root, 'data'), bundled, bundledPack }
}

const open = (s: ReturnType<typeof setup>, fetch: typeof globalThis.fetch, appVersion = '0.5.0') =>
  ConnectorPacks.open({
    dataDir: s.dataDir,
    bundledDir: s.bundled,
    bundledPack: s.bundledPack,
    appVersion,
    feed: FEED,
    publicKeys: [PUB],
    fetch,
  })

describe('연결 정보 묶음 (ADR 0039)', () => {
  it('서명이 맞으면 받아서 쓰고, 다음 실행에도 그 묶음을 쓴다', async () => {
    const s = setup()
    const { fetch } = makePack(200)
    const packs = await open(s, fetch)
    expect(packs.dir()).toBe(s.bundled)
    const st = await packs.check()
    expect(st.active).toBe(200)
    expect(packs.dir()).toBe(join(s.dataDir, 'packs', '200', 'skills'))
    expect(readFileSync(join(packs.dir() as string, 'coupang', 'tools.json'), 'utf8')).toBe(
      text('coupang', 'tools.json'),
    )
    expect((await open(s, fetch)).state().active).toBe(200)
  })

  it('다른 키로 서명했거나, 받은 파일이 다르면 받지 않는다', async () => {
    const forged = await open(setup(), makePack(200, { key: theirs.privateKey }).fetch)
    expect((await forged.check()).active).toBe(0)
    expect(forged.state().note).toMatch(/signature/)
    const corrupt = await open(setup(), makePack(200, { corrupt: true }).fetch)
    expect((await corrupt.check()).active).toBe(0)
    expect(corrupt.state().note).toMatch(/checksum/)
    expect(openPack({ payload: 'x', signature: 'y' }, [PUB])).toBeUndefined()
  })

  it('앱에 든 것보다 오래됐거나 이미 받은 것보다 오래된 묶음은 받지 않는다', async () => {
    const s = setup(300)
    expect((await (await open(s, makePack(200).fetch)).check()).active).toBe(0)
    const s2 = setup()
    const packs = await open(s2, makePack(250).fetch)
    await packs.check()
    expect((await (await open(s2, makePack(240).fetch)).check()).active).toBe(250)
  })

  it('더 새 앱이 필요한 묶음은 기다린다', async () => {
    const packs = await open(setup(), makePack(200, { minApp: '0.9.0' }).fetch, '0.5.0')
    const st = await packs.check()
    expect(st.active).toBe(0)
    expect(st.note).toMatch(/0\.9\.0/)
  })

  it('이 앱이 못 읽는 커넥터는 앱에 든 것으로 대신한다', async () => {
    const s = setup()
    const tools = JSON.parse(text('coupang', 'tools.json'))
    tools.tools[0].steps.push({ teleport: 'somewhere' })
    const { fetch } = makePack(200, {
      files: {
        'coupang/connect.json': text('coupang', 'connect.json'),
        'coupang/tools.json': JSON.stringify(tools),
        'newshop/connect.json': '{"id":"newshop"}',
      },
    })
    const packs = await open(s, fetch)
    expect((await packs.check()).active).toBe(200)
    const dir = packs.dir() as string
    expect(readFileSync(join(dir, 'coupang', 'tools.json'), 'utf8')).toBe(text('coupang', 'tools.json'))
    // A card that is not readable and not in the app is left out
    expect(() => readFileSync(join(dir, 'newshop', 'connect.json'))).toThrow()
  })

  it('되돌리면 앱에 든 것으로 돌아가고 그 묶음은 다시 받지 않는다', async () => {
    const s = setup()
    const { fetch } = makePack(200)
    const packs = await open(s, fetch)
    await packs.check()
    const st = await packs.rollback()
    expect(st.active).toBe(0)
    expect(packs.dir()).toBe(s.bundled)
    expect((await packs.check()).active).toBe(0)
    expect((await open(s, fetch)).state().active).toBe(0)
  })

  it('커넥터는 지금 쓰는 폴더에서 읽는다', async () => {
    const s = setup()
    const other = join(s.dataDir, 'other')
    await mkdir(join(other, 'coupang'), { recursive: true })
    const card = JSON.parse(text('coupang', 'connect.json'))
    writeFileSync(join(other, 'coupang', 'connect.json'), JSON.stringify({ ...card, name: '쿠팡 새 카드' }))
    let dir = s.bundled
    const connectors = new Connectors({
      dir: () => dir,
      browser: {} as never,
      tools: {} as never,
      connected: () => ({}),
    })
    expect((await connectors.load()).get('coupang')?.card.name).toBe(card.name)
    dir = other
    await new Promise((r) => setTimeout(r, 0))
    // Read again after the 10-second cache: a fresh Connectors stands in for that here
    const fresh = new Connectors({
      dir: () => dir,
      browser: {} as never,
      tools: {} as never,
      connected: () => ({}),
    })
    expect((await fresh.load()).get('coupang')?.card.name).toBe('쿠팡 새 카드')
  })
})
