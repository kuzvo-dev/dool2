// Connect screen copy (no zod). Used by screens that must keep their bundle small, like the phone app. ADR 0014
// This file is copied as-is next to the desktop window, so it takes only type imports and keeps its catalogs as plain objects.
import type { Lang } from '@dool2/i18n'
import type { ConnectCard, ConnectionItem, Tier } from './connect.js'

/** Connect screen categories (Korean, the reference copy). The order is the list order */
export const CATEGORY_LABEL = {
  account: '간편 로그인 계정',
  shopping: '쇼핑',
  grocery: '장보기·배달',
  fashion: '패션·뷰티',
  travel: '여행·숙소',
  flight: '항공',
  tickets: '예매·예약',
  media: '영상·음악',
  books: '책',
  social: 'SNS',
  work: '업무',
  mail: '메일·일정',
  telecom: '통신',
  finance: '카드·금융',
  gov: '공공·세금',
  life: '생활',
  device: '휴대폰',
  ai: 'AI 도구',
} as const

/** English category names, same keys as CATEGORY_LABEL */
const CATEGORY_LABEL_EN: Record<keyof typeof CATEGORY_LABEL, string> = {
  account: 'Sign-in accounts',
  shopping: 'Shopping',
  grocery: 'Groceries & delivery',
  fashion: 'Fashion & beauty',
  travel: 'Travel & stays',
  flight: 'Flights',
  tickets: 'Tickets & bookings',
  media: 'Video & music',
  books: 'Books',
  social: 'Social',
  work: 'Work',
  mail: 'Mail & calendar',
  telecom: 'Mobile & internet',
  finance: 'Cards & banking',
  gov: 'Government & tax',
  life: 'Everyday life',
  device: 'Phone',
  ai: 'AI tools',
}

/** A category's name in the given language */
export function categoryLabel(category: keyof typeof CATEGORY_LABEL, lang: Lang = 'ko'): string {
  return lang === 'en' ? CATEGORY_LABEL_EN[category] : CATEGORY_LABEL[category]
}

/** Emoji (3D) for the category chips and headers on the connect screen (packages/ui/emoji/<emo>.webp) */
export const CATEGORY_EMO: Record<keyof typeof CATEGORY_LABEL, string> = {
  account: 'lock',
  shopping: 'shopping',
  grocery: 'grocery',
  fashion: 'beauty',
  travel: 'travel',
  flight: 'plane',
  tickets: 'ticket',
  media: 'media',
  books: 'bookmark',
  social: 'camera',
  work: 'laptop',
  mail: 'mail',
  telecom: 'chat',
  finance: 'card',
  gov: 'document',
  life: 'home',
  device: 'gear',
  ai: 'sparkles',
}

/** Tiers that only run after approval on the phone (docs/architecture.md 4.1) */
export const APPROVAL_TIERS: readonly Tier[] = ['pay', 'contact']

/** Copy for the detail screen's safety lines and the connect-button hints, as plain catalogs (Korean is the reference copy) */
const TEXT = {
  ko: {
    approval: (titles: string) => `${titles} 같은 일은 폰에서 승인한 뒤에만 해요.`,
    approvalButtons: '결제·주문·보내기 같은 마지막 버튼은 폰에서 승인해야만 눌러요.',
    browserVault:
      '아이디·비밀번호는 PC의 두리 금고에만 암호화해 저장하고, 로그인은 두리 본체가 해요. 두리(AI)는 비밀번호를 보지 않아요.',
    browserHuman: (login: string) =>
      `${login ? `${login}처럼 ` : ''}로봇 확인·본인인증이 필요하면 그 화면만 폰에 띄워 직접 하게 해요.`,
    officialChrome: '공식 연동이 준비되기 전까지는 PC Chrome에 로그인해 둔 화면으로 일해요.',
    noPassword: '두리(AI)는 비밀번호를 보지 않아요.',
    open: '로그인 없이 쓰는 서비스예요. 연결하지 않아도 바로 부탁하면 돼요.',
    device: '폰 권한으로 켜는 기능이에요. 켠 뒤에도 폰 설정에서 언제든 끌 수 있어요.',
    recent: '최근 사용',
    usedIn: (n: number) => `${n}곳에서 사용`,
  },
  en: {
    approval: (titles: string) => `Things like ${titles} only happen after you approve them on your phone.`,
    approvalButtons:
      'The last button, like paying, ordering or sending, is only pressed after you approve it on your phone.',
    browserVault:
      "Your ID and password are stored encrypted in Dool2's vault on your PC, and Dool2 itself signs in. The AI never sees your password.",
    browserHuman: (login: string) =>
      `If a robot check or identity verification${login ? ` (like ${login})` : ''} is needed, only that screen is shown on your phone for you to do yourself.`,
    officialChrome:
      'Until the official connection is ready, Dool2 works in the page you are signed in to in Chrome on your PC.',
    noPassword: 'The AI never sees your password.',
    open: 'This service needs no sign-in. You can ask right away without connecting.',
    device:
      'This feature is turned on with a phone permission. You can turn it off any time in your phone settings.',
    recent: 'Recently used',
    usedIn: (n: number) => `Used in ${n} places`,
  },
} as const

/**
 * The safety sentence on the detail screen. It is built from the tiers instead of being written on each card (so the text never drifts from what really happens)
 * Example: "Things like ordering, returning only happen after you approve them on your phone."
 */
export function approvalLine(card: Pick<ConnectCard, 'abilities'>, lang: Lang = 'ko'): string | undefined {
  const risky = card.abilities.filter((a) => APPROVAL_TIERS.includes(a.tier)).map((a) => a.title)
  if (!risky.length) return undefined
  return TEXT[lang].approval(risky.slice(0, 3).join(', '))
}

/** "How we keep it safe" on the detail screen (per connection method) */
export function safetyLines(
  card: Pick<ConnectCard, 'how' | 'login' | 'abilities'>,
  lang: Lang = 'ko',
): string[] {
  const t = TEXT[lang]
  const approval = card.abilities.some((a) => APPROVAL_TIERS.includes(a.tier)) ? [t.approvalButtons] : []
  switch (card.how) {
    case 'browser':
      return [
        t.browserVault,
        t.browserHuman(card.login && card.login !== '아이디·비밀번호' ? card.login : ''),
        ...approval,
      ]
    case 'official':
      return [t.officialChrome, t.noPassword, ...approval]
    case 'open':
      return [t.open, ...approval]
    case 'device':
      return [t.device, ...approval]
  }
}

/** Find a card by card id or service name ("쿠팡", "coupang", "야놀자", "KT M모바일") */
export function findCard<T extends Pick<ConnectCard, 'id' | 'name'>>(
  cards: readonly T[],
  query: string,
): T | undefined {
  const norm = (s: string) =>
    s
      .replace(/\s*\(.*?\)\s*/g, '')
      .replace(/\s+/g, '')
      .toLowerCase()
  const q = query.trim().toLowerCase()
  if (!q) return undefined
  const nq = norm(q)
  return (
    cards.find((c) => c.id === q) ??
    cards.find((c) => norm(c.name) === nq || c.name.toLowerCase() === q) ??
    cards.find((c) => c.name.toLowerCase().includes(q)) ??
    [...cards]
      .sort((a, b) => norm(b.name).length - norm(a.name).length)
      .find((c) => nq.includes(norm(c.name)))
  )
}

/** Search box: matches if the name, domain, category, summary or any ability contains the query (category in both languages) */
export function matchesCard(card: ConnectCard, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [
    card.name,
    card.id,
    card.site ?? '',
    CATEGORY_LABEL[card.category],
    CATEGORY_LABEL_EN[card.category],
    card.summary,
    ...card.abilities.map((a) => a.title),
  ]
    .join(' ')
    .toLowerCase()
    .includes(q)
}

/**
 * Order and short hints for the one-tap sign-in buttons. Shared by the phone and PC connect screens.
 * 1) the one used before on this service ("Recently used") 2) the one used most on other services ("Used in N places", top one only) 3) card order.
 * Reusing the same account avoids creating a new one, and the provider is likely already signed in
 */
export function socialOrder(
  card: Pick<ConnectCard, 'id' | 'social'>,
  services: readonly Pick<ConnectionItem, 'card' | 'via' | 'account'>[] = [],
  lang: Lang = 'ko',
): { provider: NonNullable<ConnectCard['social']>[number]; hint?: string }[] {
  const accountOf = (p: string) => services.find((s) => s.card.id === p)?.account
  const list = card.social ?? []
  const used = new Map<string, number>()
  let mine: string | undefined
  for (const s of services) {
    const p = s.via?.startsWith('social:') ? s.via.slice(7) : undefined
    if (!p) continue
    if (s.card.id === card.id) mine = p
    else used.set(p, (used.get(p) ?? 0) + 1)
  }
  const score = (p: string) => (p === mine ? 1000 : 0) + (used.get(p) ?? 0)
  const sorted = [...list].sort((a, b) => score(b) - score(a))
  const top = sorted[0]
  return sorted.map((provider) => {
    const n = used.get(provider) ?? 0
    const t = TEXT[lang]
    const why = provider === mine ? t.recent : provider === top && n > 0 && !mine ? t.usedIn(n) : ''
    const who = accountOf(provider) ?? ''
    const hint = [why, who].filter(Boolean).join(' · ')
    return hint ? { provider, hint } : { provider }
  })
}
