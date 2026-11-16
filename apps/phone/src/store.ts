// 폰에 남기는 것: PC 정보와 이 폰의 키. 키는 IndexedDB에 CryptoKey 그대로(꺼낼 수 없는 키) 둔다.
import type { StoredMessage } from '@dool2/protocol'
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
  /** 중계 서버 주소 (초대에 있었으면). 없으면 폰 앱을 연 주소 */
  relay?: string
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

/**
 * 마지막 대화 몇 줄: 앱을 열자마자 PC 연결을 기다리지 않고 보이게 (연결되면 PC 기록으로 바뀐다).
 * 이 폰 앱 저장소에만 두고, 연결을 지우면 같이 지운다
 */
export const loadConv = () =>
  tx<StoredMessage[] | undefined>('readonly', (s) => s.get('conv') as IDBRequest<StoredMessage[] | undefined>)
export const saveConv = (v: StoredMessage[]) => tx('readwrite', (s) => s.put(v, 'conv'))
export const clearConv = () => tx('readwrite', (s) => s.delete('conv'))
