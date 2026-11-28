// User-facing copy the v1-compat phone link (legacy-phone.ts) sends the shipped app in the `message` fields of its
// connect-result / login-done / vault replies (ADR 0029: user-facing copy lives in a locale file, not inline in
// code). Korean is the reference copy and English is complete. Default Korean, matching the Korean-first phone app
// and the Dool2 persona. This mirrors apps/daemon's locales/link.ts for the v2 daemon.

import type { Lang } from '@dool2/i18n'

export interface PhoneCopy {
  /** Social (one-tap) connect is not wired yet; ask the user to connect with an id/password instead. */
  socialNotReady: string
  /** A connect `start` on a card that has no site to bind a login to. */
  connectCantStart: string
  /** A connect-login with no vault or an unknown service. */
  connectUnavailable: string
  /** A service was connected. */
  connected: string
  /** The login sheet's request has expired (no pending request matched). */
  loginExpired: string
  /** A login was stored in the vault. */
  loginSaved: string
  /** The vault is not available in this session (no real vault wired). */
  vaultUnavailable: string
  /** A vault item was deleted. */
  vaultDeleted: string
  /** No vault item matched the id. */
  vaultNoItem: string
  /** A vault item was saved. */
  vaultSaved: string
  /** A reveal was asked while the vault is locked. */
  vaultLocked: string
}

const ko: PhoneCopy = {
  socialNotReady: '간편 로그인 연결은 아직 준비 중이에요. 아이디·비밀번호로 연결해 주세요.',
  connectCantStart: '이 서비스는 아직 연결을 시작할 수 없어요.',
  connectUnavailable: '지금은 이 서비스를 연결할 수 없어요.',
  connected: '연결했어요.',
  loginExpired: '로그인 요청이 만료됐어요.',
  loginSaved: '저장했어요.',
  vaultUnavailable: '금고를 쓸 수 없어요.',
  vaultDeleted: '지웠어요.',
  vaultNoItem: '해당 항목이 없어요.',
  vaultSaved: '저장했어요.',
  vaultLocked: '금고를 먼저 잠금 해제해 주세요.',
}

const en: PhoneCopy = {
  socialNotReady: 'One-tap sign-in is not ready yet. Please connect with an ID and password.',
  connectCantStart: "This service can't be connected yet.",
  connectUnavailable: "This service can't be connected right now.",
  connected: 'Connected.',
  loginExpired: 'That sign-in request expired.',
  loginSaved: 'Saved.',
  vaultUnavailable: 'The vault is not available.',
  vaultDeleted: 'Deleted.',
  vaultNoItem: 'No such item.',
  vaultSaved: 'Saved.',
  vaultLocked: 'Please unlock the vault first.',
}

/** The phone-link copy for a language (default Korean, the reference copy). */
export function phoneCopy(lang: Lang = 'ko'): PhoneCopy {
  return lang === 'en' ? en : ko
}
