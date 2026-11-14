// API 키 같은 비밀값을 OS 키체인(Electron safeStorage)으로 암호화해 파일에 둔다.
// 맥은 Keychain, 윈도우는 DPAPI가 키를 지킨다. 암호화를 쓸 수 없는 환경이면 저장하지 않는다 (평문 저장 금지).
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { SecretStore } from '@dool2/daemon'

export interface Crypter {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export function fileSecrets(path: string, crypter: Crypter): SecretStore {
  const load = async (): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }
  return {
    async get(key) {
      const enc = (await load())[key]
      if (!enc || !crypter.isEncryptionAvailable()) return undefined
      try {
        return crypter.decryptString(Buffer.from(enc, 'base64'))
      } catch {
        return undefined
      }
    },
    async set(key, value) {
      const all = await load()
      if (value === undefined) delete all[key]
      else {
        if (!crypter.isEncryptionAvailable())
          throw new Error('이 컴퓨터에서는 키를 안전하게 저장할 수 없어요 (OS 키체인을 쓸 수 없음)')
        all[key] = crypter.encryptString(value).toString('base64')
      }
      // 쓰다가 꺼져도 파일이 깨지지 않게 임시 파일에 쓰고 바꿔 끼운다
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify(all), { mode: 0o600 })
      await rename(tmp, path)
    },
  }
}
