import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Crypter, fileSecrets } from './secrets.js'

// 진짜 키체인 대신 뒤집기로 흉내 낸다
const fake = (available = true): Crypter => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from([...s].reverse().join(''), 'utf8'),
  decryptString: (b) => [...b.toString('utf8')].reverse().join(''),
})

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('비밀값 보관소', () => {
  it('암호화해서 저장하고, 파일에는 원래 값이 남지 않는다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-sec-'))
    const path = join(dir, 'secrets.json')
    const s = fileSecrets(path, fake())
    await s.set('payg.apiKey', 'sk-ant-abc123')
    expect(await s.get('payg.apiKey')).toBe('sk-ant-abc123')
    expect(await readFile(path, 'utf8')).not.toContain('sk-ant-abc123')
    await s.set('payg.apiKey', undefined)
    expect(await s.get('payg.apiKey')).toBeUndefined()
  })

  it('OS 키체인을 쓸 수 없으면 평문으로 저장하지 않고 거절한다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-sec-'))
    const s = fileSecrets(join(dir, 'secrets.json'), fake(false))
    await expect(s.set('k', 'v')).rejects.toThrow('안전하게 저장할 수 없어요')
  })
})
