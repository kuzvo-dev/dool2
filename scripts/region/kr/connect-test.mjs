// Korean data for scripts/connect-test.mjs: the account sheet is written in Korean, and the daemon's tool results
// are Korean text.

/** Column headers of the account sheet (CSV), matched by prefix: service, has account, login method, 2FA, memo */
export const SHEET_COLUMNS = ['서비스', '계정 있음', '쓰는 로그인 방식', '2단계', '메모']

/** Login method names used in the sheet and in --method -> social login provider */
export const PROVIDERS_KO = { 카카오: 'kakao', 네이버: 'naver', 구글: 'google', 애플: 'apple' }

/** Tool result text that means the tool got to the page and handed off to the AI */
export const HANDOFF_RE = /handoff|이어서 해|AI에게/
