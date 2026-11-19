// 내 결제 수단 (ADR 0023): "무엇으로 낼지"라는 선호만. 카드 번호·유효기간·CVC·결제 비밀번호는 받지도 두지도 않는다.
// 폰 앱·PC 앱·본체가 같이 쓴다 (의존성 없이).

/** 등록할 수 있는 결제 수단 종류와 보이는 이름 */
export const PAY_KINDS = {
  naverpay: '네이버페이',
  kakaopay: '카카오페이',
  tosspay: '토스페이',
  payco: '페이코',
  samsungpay: '삼성페이',
  applepay: '애플페이',
  smilepay: '스마일페이',
  ssgpay: 'SSG페이',
  lpay: 'L.PAY',
  card: '카드',
} as const

export type PayKind = keyof typeof PAY_KINDS

export interface PayMethod {
  id: string
  kind: PayKind
  /** 간편결제 안에서 쓰는 것 (그 간편결제 화면에서 고른 가린 표시, 예: "신한카드(1234)", "네이버페이 머니") */
  inner?: string
  /** 카드: 카드사 (예: "신한카드") */
  issuer?: string
  /** 카드: 내가 붙인 이름 (예: "생활비") */
  nickname?: string
  /** 카드: 끝 4자리 (선택) */
  last4?: string
  addedAt: string
}

/** 폰이 보내는 것 (id가 없으면 새로 만든다) */
export type PayMethodInput = Omit<PayMethod, 'id' | 'addedAt'> & { id?: string; addedAt?: string }

export const MAX_PAY_METHODS = 10

/** 카드 등록 때 고르는 카드사 (목록에 없으면 직접 적는다) */
export const CARD_ISSUERS = [
  '신한카드',
  'KB국민카드',
  '삼성카드',
  '현대카드',
  '롯데카드',
  '하나카드',
  '우리카드',
  'BC카드',
  'NH농협카드',
  'IBK기업은행',
  '카카오뱅크',
  '토스뱅크',
] as const

// 숫자 5개 이상(공백·하이픈 무시)은 카드 번호일 수 있어 받지 않는다
const LONG_DIGITS = /\d{5,}/

function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : undefined
}

/**
 * 폰이 보낸 결제 수단 하나를 검사해 저장할 모양으로. 받을 수 없으면 사용자에게 보일 이유(문자열)
 */
export function cleanPayMethod(raw: unknown, id: string, now: string): PayMethod | string {
  if (!raw || typeof raw !== 'object') return '결제 수단을 알 수 없어요'
  const r = raw as Record<string, unknown>
  const kind = r.kind
  if (typeof kind !== 'string' || !(kind in PAY_KINDS)) return '결제 수단 종류를 알 수 없어요'
  const inner = clean(r.inner, 40)
  const issuer = clean(r.issuer, 20)
  const nickname = clean(r.nickname, 20)
  const last4 = clean(r.last4, 8)
  for (const v of [inner, issuer, nickname, last4])
    if (v && LONG_DIGITS.test(v.replace(/[\s-]/g, '')))
      return '카드 번호는 저장하지 않아요. 끝 4자리만 적어 주세요'
  if (last4 && !/^\d{4}$/.test(last4)) return '끝 4자리는 숫자 4개로 적어 주세요'
  const base = {
    id: clean(r.id, 40) ?? id,
    kind: kind as PayKind,
    addedAt: clean(r.addedAt, 40) ?? now,
  }
  if (kind === 'card') {
    if (!issuer) return '카드사를 골라 주세요'
    return { ...base, issuer, ...(nickname ? { nickname } : {}), ...(last4 ? { last4 } : {}) }
  }
  return { ...base, ...(inner ? { inner } : {}) }
}

/** 목록 제목: "네이버페이", "신한카드" */
export function payMethodTitle(m: PayMethod): string {
  return m.kind === 'card' ? (m.issuer ?? PAY_KINDS.card) : PAY_KINDS[m.kind]
}

/** 목록 아래 글: "신한카드(1234)", "생활비 · 끝 1234" */
export function payMethodDetail(m: PayMethod): string {
  if (m.kind !== 'card') return m.inner ?? ''
  return [m.nickname, m.last4 ? `끝 ${m.last4}` : ''].filter(Boolean).join(' · ')
}

/** 한 줄: "네이버페이 · 신한카드(1234)" */
export function payMethodLabel(m: PayMethod): string {
  return [payMethodTitle(m), payMethodDetail(m)].filter(Boolean).join(' · ')
}

// 결제 화면 칸 이름이 그 간편결제인지
const KIND_RE: Record<Exclude<PayKind, 'card'>, RegExp> = {
  naverpay: /네이버\s*페이|N\s*pay|naver\s*pay/i,
  kakaopay: /카카오\s*페이|kakao\s*pay/i,
  tosspay: /토스\s*페이|toss\s*pay/i,
  payco: /페이코|payco/i,
  samsungpay: /삼성\s*페이|samsung\s*pay/i,
  applepay: /애플\s*페이|apple\s*pay/i,
  smilepay: /스마일\s*페이|smile\s*pay/i,
  ssgpay: /SSG\s*페이|SSG\s*PAY|쓱\s*페이/i,
  lpay: /L\.?\s*PAY|엘\s*페이/i,
}

/** 결제 화면의 칸 이름이 이 결제 수단인지 ("카카오페이 혜택" ↔ 카카오페이, "신용/체크카드" ↔ 카드) */
export function payMethodMatches(m: PayMethod, option: string): boolean {
  if (m.kind !== 'card') return KIND_RE[m.kind].test(option)
  // 카드: 일반 카드 결제 칸. 'NOL 카드 페이'·'카드 혜택'처럼 간편결제나 안내는 아니다
  if (/페이|pay|머니|포인트/i.test(option)) return false
  const brand = (m.issuer ?? '').replace(/카드$/, '')
  if (brand && option.includes(brand)) return true
  // 야놀자처럼 카드는 '다른 결제 수단' 안에 있는 사이트도 있다
  return /카드|일반\s*결제|다른\s*결제\s*수단/.test(option)
}

/**
 * 결제 화면의 칸들 중 내 결제 수단 순서대로 처음 맞는 것. 없으면 undefined
 * (맨 위가 주 결제 수단: 사이트가 그걸 받으면 그것, 안 받으면 다음 것)
 */
export function pickPayMethod(
  methods: PayMethod[],
  options: string[],
): { option: number; method: PayMethod } | undefined {
  for (const method of methods) {
    const option = options.findIndex((o) => payMethodMatches(method, o))
    if (option >= 0) return { option, method }
  }
  return undefined
}
