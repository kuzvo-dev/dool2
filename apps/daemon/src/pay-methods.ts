// 내 결제 수단 (ADR 0023): PC 본체 설정에 순서 있는 목록으로. 카드 번호·결제 비밀번호는 받지 않는다
import { randomUUID } from 'node:crypto'
import { cleanPayMethod, MAX_PAY_METHODS, PAY_KINDS, type PayMethod } from '@dool2/protocol/pay-methods'

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

// ── AI 도구 pay_method_list: 등록한 결제 수단을 가린 값으로만 ──

/** 숫자 5개 이상(공백·하이픈 무시)이 든 값은 카드 번호일 수 있어 AI에게 보내지 않는다 (저장할 때 막지만 한 번 더) */
function shown(v: string | undefined): string | undefined {
  if (!v) return undefined
  return /\d{5,}/.test(v.replace(/[\s-]/g, '')) ? undefined : v
}

/**
 * 내 결제 수단 보기 (pay_method_list 도구). 종류·카드사·별칭·끝 4자리·간편결제 안의 가린 표시만.
 * 카드 번호·유효기간·CVC는 애초에 저장하지 않는다. 맨 위가 주 결제 수단 (승인 카드가 이 순서로 고른다)
 */
export function payMethodsText(methods: PayMethod[]): string {
  if (!methods.length)
    return [
      '등록된 결제 수단이 없어요. 사용자가 폰 설정 > 내 정보 · 결제 > 결제 수단에서 쓰는 카드·간편결제를 추가할 수 있어요(카드사·끝 4자리만, 카드 번호는 받지 않아요).',
      '다음: 카드 혜택을 따져야 하면 이 길을 한 문장으로 안내하거나, 쓰는 카드사·간편결제만 물어 그 기준으로 비교해요(카드 번호는 묻지 않아요). 혜택을 빼고 본 최저가는 그대로 찾아 보여 줘요.',
    ].join('\n')
  const lines = methods.map((m, i) => {
    const isCard = m.kind === 'card'
    const name = isCard ? (shown(m.issuer) ?? PAY_KINDS.card) : (PAY_KINDS[m.kind] ?? m.kind)
    const parts = [
      `${i + 1}. ${i === 0 ? '[주 결제 수단] ' : ''}${name} (${isCard ? '카드' : '간편결제'})`,
      ...(isCard && shown(m.nickname) ? [`별칭 ${m.nickname}`] : []),
      ...(isCard && m.last4 && /^\d{4}$/.test(m.last4) ? [`끝 ${m.last4}`] : []),
      ...(!isCard && shown(m.inner) ? [`안에서 쓰는 것: ${m.inner}`] : []),
    ]
    return parts.join(' · ')
  })
  return [
    `등록한 결제 수단 ${methods.length}개예요. 맨 위가 주 결제 수단이고, 결제할 때 승인 카드가 위에서부터 그 사이트가 받는 것을 먼저 골라 둬요.`,
    '카드 번호 전체·유효기간·CVC는 두리가 받지도 저장하지도 않아요(카드사·별칭·끝 4자리만).',
    '',
    ...lines,
    '',
    '다음: 카드 혜택·할인 비교는 이 목록에 있는 카드·간편결제만 기준으로 해요(목록에 없는 카드를 쓴다고 짐작하지 않아요). 카드 혜택은 전월 실적·한도·행사 조건이 있어 "예상"으로 말하고, 최종가는 결제 화면에서 확인해요. 목록을 바꾸는 건 사용자가 폰 설정 > 결제 수단에서 해요.',
  ].join('\n')
}
