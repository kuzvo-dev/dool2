// Locale copy for the 완전 자동 (full-auto) one-time consent and its phone-signed changes (ADR 0047, 0029). Korean is
// the reference copy AND the exact text the phone signs and the daemon verifies; English is the display translation.
// User-facing copy lives in this locales/ file, never inline in logic. Changing the Korean wording changes the bytes
// the signature covers, so it must stay in lock-step with any already-signed consents.

export type ConsentLang = 'ko' | 'en'

/**
 * The full-auto consent wording, by language. `ko` is canonical: the ConsentEnvelope the phone signs carries exactly
 * this string, and the daemon refuses any consent whose text is not byte-for-byte this (see verifyConsent).
 */
export const fullAutoConsent: Record<ConsentLang, string> = {
  ko: '결과를 보장할 수 없고 모든 책임은 사용자에게 있습니다',
  en: 'We cannot guarantee the outcome and all responsibility rests with the user',
}
