// Korean text that main.ts matches against (site text, Korean words in labels, thread titles).

/** Digit count in a label or hint, "4자리" (4 digits) */
export const DIGITS_RE = /(\d)\s*자리/

/** A secret field whose label says payment or password */
export const PAY_SECRET_RE = /결제|비밀번호/

/** Login labels that mean an ID/password/email login exists */
export const ID_PASSWORD_LOGIN_RE = /아이디|비밀번호|이메일/

/** Title of the feed thread on the PC (not listed among separate chats) */
export const FEED_THREAD_TITLE = '두리 피드'

/** Option on a verification card meaning "I approved in the auth app" */
export const AUTH_DONE_OPTION = '인증 완료했어요'
