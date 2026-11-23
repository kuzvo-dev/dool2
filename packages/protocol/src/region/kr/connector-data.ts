// Korean data the connector engine matches or produces for Korean sites (ADR 0029). Keep the Korean exactly.

/** Weekday names in Korean, Sunday first (the dow filter, for Korean booking screens) */
export const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토']

/** AM and PM words Korean booking screens show before the time (the ampm filter) */
export const AM_KO = '오전'
export const PM_KO = '오후'

/** "Today" and "tomorrow" as Korean booking screens label date cells (the kday and daylabel filters) */
export const TODAY_KO = '오늘'
export const TOMORROW_KO = '내일'

/** Tool status written in skills/<id>/tools.json: draft / verified(date) / blocked(reason) */
export const STATUS_PATTERN = /^(초안|검증됨\(\d{4}-\d{2}-\d{2}[^)]*\)|막힘\(.+\))$/

/**
 * Instructions a connector description must not contain: solving captchas or identity checks automatically,
 * and typing passwords or card numbers (they go to a person instead). English and Korean wording.
 */
export const BANNED_INSTRUCTIONS = [
  /(캡차|보안\s*문자|자동입력\s*방지|captcha|본인\s*인증|인증번호)[^\n]{0,20}(풀|우회|입력해|넣어|자동으로)/i,
  /(비밀번호|카드\s*번호|cvc|공동인증서\s*암호)[^\n]{0,15}(입력|넣)(?![^\n]*(사람|사용자|넘긴|하지 않))/i,
  /(captcha|security code|identity verification|verification code)[^\n]{0,20}(solve|bypass|enter|type in|automatically)/i,
  /(password|card number|cvc)[^\n]{0,15}(enter|type)(?![^\n]*(person|user|hand|not\b))/i,
]
