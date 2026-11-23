// Korean text the service tool runner matches (ADR 0029). Keep the Korean exactly: it is site text, catalog data
// values, or labels other code writes in Korean.

/** A blocked page with these words is a robot check a person can solve (not a plain access block). */
export const HUMAN_CHECK = /보안\s*확인|로봇|캡차|captcha|자동\s*입력|보안\s*문자/i

/** An address field value that means "my address" (filled with the address saved in my info). */
export const MY_ADDRESS = /^\s*(내\s*(정보\s*)?주소|우리\s*집|집|home)\s*$/i

/** Words in a Korean address that end a neighborhood or road name (동, 읍, 면, 로, 길). */
export const AREA_WORD = /(동|읍|면|로|길)$/
/** Same, with an optional number before the suffix (to strip "신봉1로" down to "신봉"). */
export const AREA_SUFFIX = /\d*(동|읍|면|로|길)$/

/** Site text that means "yes" in a boolean output field. */
export const YES = /^(true|1|예|네|있음)$/i

/**
 * Error text from the browser bridge when the Dool2 extension is not connected (packages/browser/src/bridge.ts).
 * A tool that failed for this reason is not broken.
 */
export const EXTENSION_OFFLINE = /확장 프로그램과 연결돼 있지 않|확장과 연결돼 있지 않/

/** Tool status values in skills/<id>/tools.json (packages/protocol/src/connector.ts): draft, verified(date), blocked(reason). */
export const TOOL_STATUS = { draft: '초안', verified: '검증됨', blocked: '막힘' } as const

/** Role labels the extension writes in page snapshots (apps/extension/src/page.ts). */
export const SNAPSHOT_ROLE = {
  text: '글',
  input: '입력칸',
  search: '검색칸',
  select: '선택 상자',
} as const
