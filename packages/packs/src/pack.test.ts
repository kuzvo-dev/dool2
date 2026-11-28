import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { installablePack } from './build.js'
import { planInstall } from './install.js'
import { buildPackFromFiles, compareVersions, unpackToFiles, verifyPack } from './pack.js'

/** Fresh ed25519 keypair as PEM strings; no key is ever embedded in the repo. */
function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

const enc = (s: string) => new TextEncoder().encode(s)

describe('buildPack / verifyPack', () => {
  const { privateKey, publicKey } = keypair()
  const files = {
    'gov24/SKILL.md': enc('---\nname: gov24\n---\nhi'),
    'coupang/SKILL.md': enc('---\nname: coupang\n---\nbye'),
  }

  it('round-trips: build then verify succeeds, and unpacks to the same bytes', () => {
    const pack = buildPackFromFiles(files, privateKey, { name: 'skills', pack: 100 })
    const result = verifyPack(pack, publicKey)
    expect(result.ok).toBe(true)
    expect(pack.manifest.files.map((f) => f.path)).toEqual(['coupang/SKILL.md', 'gov24/SKILL.md'])

    const out = unpackToFiles(pack)
    expect(new TextDecoder().decode(out['gov24/SKILL.md'])).toBe('---\nname: gov24\n---\nhi')
  })

  it('fails sha256 when a blob is tampered with', () => {
    const pack = buildPackFromFiles(files, privateKey)
    // Swap the blob content but leave the manifest (its sha256) untouched.
    pack.blobs['gov24/SKILL.md'] = Buffer.from(enc('tampered')).toString('base64')
    const result = verifyPack(pack, publicKey)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.why).toMatch(/sha256|size/)
  })

  it('fails the signature with the wrong public key', () => {
    const pack = buildPackFromFiles(files, privateKey)
    const other = keypair()
    const result = verifyPack(pack, other.publicKey)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.why).toMatch(/signature/)
  })

  it('fails when the manifest is edited after signing', () => {
    const pack = buildPackFromFiles(files, privateKey)
    pack.manifest.pack = 999
    const result = verifyPack(pack, publicKey)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.why).toMatch(/signature/)
  })

  it('rejects a blob that is not listed in the manifest', () => {
    const pack = buildPackFromFiles(files, privateKey)
    pack.blobs['extra/evil.md'] = Buffer.from(enc('x')).toString('base64')
    const result = verifyPack(pack, publicKey)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.why).toMatch(/not in manifest/)
  })

  it('gates on app version with minApp/maxApp', () => {
    const pack = buildPackFromFiles(files, privateKey, { minApp: '0.6.0', maxApp: '1.0.0' })
    expect(verifyPack(pack, publicKey, { appVersion: '0.7.0' }).ok).toBe(true)
    expect(verifyPack(pack, publicKey, { appVersion: '0.6.0' }).ok).toBe(true)
    expect(verifyPack(pack, publicKey, { appVersion: '1.0.0' }).ok).toBe(true)

    const tooOld = verifyPack(pack, publicKey, { appVersion: '0.5.9' })
    expect(tooOld.ok).toBe(false)
    expect(tooOld.ok ? '' : tooOld.why).toMatch(/older than minApp/)

    const tooNew = verifyPack(pack, publicKey, { appVersion: '1.1.0' })
    expect(tooNew.ok).toBe(false)
    expect(tooNew.ok ? '' : tooNew.why).toMatch(/newer than maxApp/)

    // No gate when the caller does not pass an app version.
    expect(verifyPack(pack, publicKey).ok).toBe(true)
  })

  it('rejects an unsupported algorithm or format', () => {
    const pack = buildPackFromFiles(files, privateKey)
    expect(verifyPack({ ...pack, alg: 'rsa' }, publicKey).ok).toBe(false)
    expect(verifyPack({ ...pack, manifest: { ...pack.manifest, format: 2 } }, publicKey).ok).toBe(false)
  })
})

describe('installablePack + planInstall from a directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dool2-pack-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('packs a skills directory and plans the install files', () => {
    mkdirSync(join(dir, 'gov24'), { recursive: true })
    mkdirSync(join(dir, 'naver'), { recursive: true })
    writeFileSync(join(dir, 'gov24', 'SKILL.md'), '---\nname: gov24\n---\nhi')
    writeFileSync(join(dir, 'naver', 'SKILL.md'), '---\nname: naver\n---\nyo')

    const { privateKey, publicKey } = keypair()
    const pack = installablePack(dir, privateKey, { pack: 42 })
    expect(pack.manifest.name).toBe('skills')
    expect(pack.manifest.files.map((f) => f.path)).toEqual(['gov24/SKILL.md', 'naver/SKILL.md'])

    const result = verifyPack(pack, publicKey)
    expect(result.ok).toBe(true)

    const planned = planInstall(pack)
    expect(planned.map((p) => p.path)).toEqual(['gov24/SKILL.md', 'naver/SKILL.md'])
    expect(new TextDecoder().decode(planned[0]?.bytes)).toContain('name: gov24')
  })
})

describe('compareVersions', () => {
  it('compares dotted numeric versions, padding missing parts with 0', () => {
    expect(compareVersions('0.6.0', '0.6')).toBe(0)
    expect(compareVersions('0.7.0', '0.6.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
  })
})
