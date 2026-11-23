// My payment methods (ADR 0023): only the preference "what to pay with". Card numbers, expiry dates, CVC and payment passwords are never received or stored.
// Shared by the phone app, PC app and core (no runtime dependencies, only types are imported).

import type { Lang } from '@dool2/i18n'

/** The kinds of payment method you can register, with their display names (Korean, the reference copy) */
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

/** The same names in English */
const PAY_KINDS_EN: Record<PayKind, string> = {
  naverpay: 'Naver Pay',
  kakaopay: 'Kakao Pay',
  tosspay: 'Toss Pay',
  payco: 'PAYCO',
  samsungpay: 'Samsung Pay',
  applepay: 'Apple Pay',
  smilepay: 'Smile Pay',
  ssgpay: 'SSG Pay',
  lpay: 'L.PAY',
  card: 'Card',
}

/** The display name of a payment method kind */
export function payKindName(kind: PayKind, lang: Lang = 'ko'): string {
  return lang === 'en' ? PAY_KINDS_EN[kind] : PAY_KINDS[kind]
}

/** Text shown to the user (Korean is the reference copy) */
const TEXT = {
  ko: {
    unknown: '결제 수단을 알 수 없어요',
    unknownKind: '결제 수단 종류를 알 수 없어요',
    noCardNumber: '카드 번호는 저장하지 않아요. 끝 4자리만 적어 주세요',
    last4Digits: '끝 4자리는 숫자 4개로 적어 주세요',
    pickIssuer: '카드사를 골라 주세요',
    ending: (last4: string) => `끝 ${last4}`,
  },
  en: {
    unknown: "I don't recognize this payment method",
    unknownKind: "I don't recognize this kind of payment method",
    noCardNumber: "Card numbers aren't saved. Please enter only the last 4 digits",
    last4Digits: 'Please enter the last 4 digits as 4 numbers',
    pickIssuer: 'Please choose the card company',
    ending: (last4: string) => `ending ${last4}`,
  },
} as const

export interface PayMethod {
  id: string
  kind: PayKind
  /** Used inside a mobile wallet (a masked label picked on that wallet's screen, e.g. "신한카드(1234)", "네이버페이 머니") */
  inner?: string
  /** Card: the card company (e.g. "신한카드") */
  issuer?: string
  /** Card: a name I gave it (e.g. "Living costs") */
  nickname?: string
  /** Card: last 4 digits (optional) */
  last4?: string
  addedAt: string
}

/** What the phone sends (a new id is made when there is none) */
export type PayMethodInput = Omit<PayMethod, 'id' | 'addedAt'> & { id?: string; addedAt?: string }

export const MAX_PAY_METHODS = 10

/** Card companies to choose from when registering a card (type it in if it is not in the list) */
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

// Five or more digits (ignoring spaces and hyphens) could be a card number, so they are not accepted
const LONG_DIGITS = /\d{5,}/

function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : undefined
}

/**
 * Checks one payment method sent by the phone and turns it into the shape to store. If it cannot be accepted, returns the reason (a string) to show the user
 */
export function cleanPayMethod(raw: unknown, id: string, now: string, lang: Lang = 'ko'): PayMethod | string {
  const t = TEXT[lang]
  if (!raw || typeof raw !== 'object') return t.unknown
  const r = raw as Record<string, unknown>
  const kind = r.kind
  if (typeof kind !== 'string' || !(kind in PAY_KINDS)) return t.unknownKind
  const inner = clean(r.inner, 40)
  const issuer = clean(r.issuer, 20)
  const nickname = clean(r.nickname, 20)
  const last4 = clean(r.last4, 8)
  for (const v of [inner, issuer, nickname, last4])
    if (v && LONG_DIGITS.test(v.replace(/[\s-]/g, ''))) return t.noCardNumber
  if (last4 && !/^\d{4}$/.test(last4)) return t.last4Digits
  const base = {
    id: clean(r.id, 40) ?? id,
    kind: kind as PayKind,
    addedAt: clean(r.addedAt, 40) ?? now,
  }
  if (kind === 'card') {
    if (!issuer) return t.pickIssuer
    return { ...base, issuer, ...(nickname ? { nickname } : {}), ...(last4 ? { last4 } : {}) }
  }
  return { ...base, ...(inner ? { inner } : {}) }
}

/** List title: "네이버페이", "신한카드" ("Naver Pay") */
export function payMethodTitle(m: PayMethod, lang: Lang = 'ko'): string {
  return m.kind === 'card' ? (m.issuer ?? payKindName('card', lang)) : payKindName(m.kind, lang)
}

/** Text under the list item: "신한카드(1234)", "Living costs · ending 1234" */
export function payMethodDetail(m: PayMethod, lang: Lang = 'ko'): string {
  const t = TEXT[lang]
  if (m.kind !== 'card') return m.inner ?? ''
  return [m.nickname, m.last4 ? t.ending(m.last4) : ''].filter(Boolean).join(' · ')
}

/** One line: "네이버페이 · 신한카드(1234)" */
export function payMethodLabel(m: PayMethod, lang: Lang = 'ko'): string {
  return [payMethodTitle(m, lang), payMethodDetail(m, lang)].filter(Boolean).join(' · ')
}

// Whether a payment-screen option name is that mobile wallet
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

/** Whether a payment-screen option name is this payment method ("카카오페이 혜택" matches Kakao Pay, "신용/체크카드" matches card) */
export function payMethodMatches(m: PayMethod, option: string): boolean {
  if (m.kind !== 'card') return KIND_RE[m.kind].test(option)
  // Card: the ordinary card payment option. Wallets and notices like 'NOL 카드 페이'·'카드 혜택' are not it
  if (/페이|pay|머니|포인트/i.test(option)) return false
  const brand = (m.issuer ?? '').replace(/카드$/, '')
  if (brand && option.includes(brand)) return true
  // Some sites, like Yanolja, keep cards inside 'Other payment methods'
  return /카드|일반\s*결제|다른\s*결제\s*수단/.test(option)
}

/**
 * Among the options on the payment screen, the first one that matches my payment methods in order. undefined if none
 * (the top one is the main method: if the site accepts it, that one, otherwise the next)
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
