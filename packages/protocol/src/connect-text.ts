// 연결 화면 문구 (zod 없이). 폰 앱처럼 번들을 작게 해야 하는 화면이 쓴다. ADR 0014
import type { ConnectCard, ConnectionItem, Tier } from './connect.js'

/** 연결 화면의 분류. 순서가 곧 목록 순서다 */
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

/** 연결 화면 분류 칩·머리에 쓰는 입체 이모지 (packages/ui/emoji/<emo>.webp) */
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

/** 폰 승인이 있어야만 하는 등급 (docs/architecture.md 4.1) */
export const APPROVAL_TIERS: readonly Tier[] = ['pay', 'contact']

/**
 * 상세 화면의 안전 문장. 카드에 따로 적지 않고 등급에서 만든다 (적은 말과 실제 동작이 어긋나지 않게)
 * 예: "주문, 반품 같은 일은 폰에서 승인한 뒤에만 해요."
 */
export function approvalLine(card: Pick<ConnectCard, 'abilities'>): string | undefined {
  const risky = card.abilities.filter((a) => APPROVAL_TIERS.includes(a.tier)).map((a) => a.title)
  if (!risky.length) return undefined
  return `${risky.slice(0, 3).join(', ')} 같은 일은 폰에서 승인한 뒤에만 해요.`
}

/** 상세 화면의 "안전하게 지키는 방법" (연결 방식마다) */
export function safetyLines(card: Pick<ConnectCard, 'how' | 'login' | 'abilities'>): string[] {
  const approval = card.abilities.some((a) => APPROVAL_TIERS.includes(a.tier))
    ? ['결제·주문·보내기 같은 마지막 버튼은 폰에서 승인해야만 눌러요.']
    : []
  switch (card.how) {
    case 'browser':
      return [
        '아이디·비밀번호는 PC의 두리 금고에만 암호화해 저장하고, 로그인은 두리 본체가 해요. 두리(AI)는 비밀번호를 보지 않아요.',
        `${card.login && card.login !== '아이디·비밀번호' ? `${card.login}처럼 ` : ''}로봇 확인·본인인증이 필요하면 그 화면만 폰에 띄워 직접 하게 해요.`,
        ...approval,
      ]
    case 'official':
      return [
        '공식 연동이 준비되기 전까지는 PC Chrome에 로그인해 둔 화면으로 일해요.',
        '두리(AI)는 비밀번호를 보지 않아요.',
        ...approval,
      ]
    case 'open':
      return ['로그인 없이 쓰는 서비스예요. 연결하지 않아도 바로 부탁하면 돼요.', ...approval]
    case 'device':
      return ['폰 권한으로 켜는 기능이에요. 켠 뒤에도 폰 설정에서 언제든 끌 수 있어요.', ...approval]
  }
}

/** 찾기 칸: 이름·도메인·분류·소개·할 수 있는 일 중 하나에 들어 있으면 */
/** 카드 id나 서비스 이름으로 카드를 찾는다 ("쿠팡", "coupang", "야놀자", "KT M모바일") */
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

export function matchesCard(card: ConnectCard, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [
    card.name,
    card.id,
    card.site ?? '',
    CATEGORY_LABEL[card.category],
    card.summary,
    ...card.abilities.map((a) => a.title),
  ]
    .join(' ')
    .toLowerCase()
    .includes(q)
}

/**
 * 간편 로그인 버튼 순서와 짧은 표시. 폰·PC 연결 화면이 같이 쓴다.
 * 1) 이 서비스에 전에 쓴 것("최근 사용") 2) 다른 서비스에 많이 쓴 것("N곳에서 사용", 맨 위 하나만) 3) 카드 순서.
 * 같은 계정으로 이어 쓰면 새 계정이 안 생기고, 공급자 쪽이 이미 로그인돼 있을 가능성도 크다
 */
export function socialOrder(
  card: Pick<ConnectCard, 'id' | 'social'>,
  services: readonly Pick<ConnectionItem, 'card' | 'via' | 'account'>[] = [],
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
    const why = provider === mine ? '최근 사용' : provider === top && n > 0 && !mine ? `${n}곳에서 사용` : ''
    const who = accountOf(provider) ?? ''
    const hint = [why, who].filter(Boolean).join(' · ')
    return hint ? { provider, hint } : { provider }
  })
}
