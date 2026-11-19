// 내 결제 수단 (ADR 0023): PC 본체 설정에 순서 있는 목록으로. 카드 번호·결제 비밀번호는 받지 않는다
import { randomUUID } from 'node:crypto'
import { cleanPayMethod, MAX_PAY_METHODS, type PayMethod } from '@dool2/protocol/pay-methods'

interface SettingStore {
  getSetting(key: string): unknown
  setSetting(key: string, value: unknown): void
}

const KEY = 'payMethods'

export function loadPayMethods(store: SettingStore): PayMethod[] {
  const v = store.getSetting(KEY)
  return Array.isArray(v) ? (v as PayMethod[]) : []
}

/**
 * 폰이 보낸 목록으로 통째로 바꾼다 (추가·지우기·순서). 하나라도 받을 수 없으면 바꾸지 않고 그 이유를 돌려준다
 */
export function savePayMethods(
  store: SettingStore,
  raw: unknown[],
  now = new Date().toISOString(),
): { ok: true; methods: PayMethod[] } | { ok: false; error: string } {
  if (raw.length > MAX_PAY_METHODS)
    return { ok: false, error: `결제 수단은 ${MAX_PAY_METHODS}개까지 등록할 수 있어요` }
  const out: PayMethod[] = []
  for (const r of raw) {
    const m = cleanPayMethod(r, randomUUID(), now)
    if (typeof m === 'string') return { ok: false, error: m }
    // 같은 id가 두 번 오면 새 id로 (지우기·순서 바꾸기가 꼬이지 않게)
    out.push(out.some((x) => x.id === m.id) ? { ...m, id: randomUUID() } : m)
  }
  store.setSetting(KEY, out)
  return { ok: true, methods: out }
}
