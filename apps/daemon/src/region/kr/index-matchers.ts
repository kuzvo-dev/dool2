// Korean text that index.ts matches in what other parts of the daemon and the extension produce (ADR 0029).

/** The auto-login message that ends with "just tap the app" (only a phone approval is left) */
export const APP_CONFIRM_ONLY_END = /이어서 연결해요$/
export const APP_CONFIRM_ONLY_END_LOOSE = /이어서 연결해요\.?$/

/** Input values in a page snapshot, shown as 값="..." by the extension */
export const SNAPSHOT_VALUE = /값="[^"]*"/g
export const SNAPSHOT_VALUE_MASKED = '값="(가림)"'

/** A field line in a page snapshot: [e12 입력칸 "label"] (text field, search field, password field) */
export const SNAPSHOT_FIELD = /\[(e\d+) (입력칸|검색칸|비밀번호칸) "([^"]*)"\]/g

/** Splits the first sentence out of a Korean auto-login message (spaces after "요" are joined with a dot) */
export const joinKoreanSentences = (s: string): string => s.replace(/요\s+/g, '요·')
