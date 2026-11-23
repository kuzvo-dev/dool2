// Stores secrets like API keys in a file, encrypted with the OS keychain (Electron safeStorage).
// Keychain guards the key on Mac, DPAPI on Windows. Without encryption nothing is stored (never plain text).
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { SecretStore } from '@dool2/daemon'
import type { Lang } from '@dool2/i18n'
import { mainText } from './locales/main.js'

export interface Crypter {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** `lang`: language of the error shown when the key cannot be stored (default Korean) */
export function fileSecrets(path: string, crypter: Crypter, lang: () => Lang = () => 'ko'): SecretStore {
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
        if (!crypter.isEncryptionAvailable()) throw new Error(mainText(lang()).secretsUnavailable)
        all[key] = crypter.encryptString(value).toString('base64')
      }
      // Write to a temp file and swap it in, so a crash mid-write never breaks the file
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify(all), { mode: 0o600 })
      await rename(tmp, path)
    },
  }
}
