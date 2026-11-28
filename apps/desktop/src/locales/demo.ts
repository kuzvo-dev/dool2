// The Korean copy for the offline demo turn (the scripted brain in demo.ts). It lives in a locales/ file so the
// scripted text stays out of code (ADR 0029). It is demo/test data — a made-up Starbucks gift-card balance, no real
// account. When a real brain is wired, this demo goes away.

/** The canned user message the smoke screenshot sends. */
export const DEMO_MESSAGE = '스타벅스 카드 잔액 좀 확인해 줘'

export const DEMO_LINES = {
  /** Round 1: acknowledge and start. */
  start: '네, 스타벅스 잔액 확인해 볼게요. 잠깐만요.',
  /** Round 2: a login is needed, use the vault. */
  login: '로그인이 필요해서 저장해 둔 정보로 로그인할게요.',
  /** Round 3: the answer, result-first (docs/persona.md). */
  answer: '확인했어요. 스타벅스 카드 잔액은 12,300원이에요. ☕',
}
