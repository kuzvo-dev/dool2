// 폰에 남기는 것: PC 정보와 이 폰의 키. 키는 IndexedDB에 CryptoKey 그대로(꺼낼 수 없는 키) 둔다.
import type { DeviceKeys } from '@dool2/protocol/e2e'

export interface Saved {
  pcId: string
  pcBoxPub: string
  pcName: string
  keys: DeviceKeys
  /** 페어링이 PC에서 확인됐는지 */
  paired: boolean
  /** 보낸 봉투 순번 (다시 열어도 줄지 않게) */
  seq: number
}

const DB = 'dool2'
const STORE = 'kv'

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export const load = () =>
  tx<Saved | undefined>('readonly', (s) => s.get('link') as IDBRequest<Saved | undefined>)
export const save = (v: Saved) => tx('readwrite', (s) => s.put(v, 'link'))
export const clear = () => tx('readwrite', (s) => s.delete('link'))
