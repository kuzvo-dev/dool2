// Screen words for reading Google's account chooser (connect-account.ts, ADR 0041). Korean and English pages.

/** A link or button line of a page snapshot: ref and its name */
export const ROW = /\[(e\d+) (?:링크|버튼|link|button) "([^"]*)"\]/g
/** A chooser row of an account that is listed but signed out (needs the password again) */
export const SIGNED_OUT = /로그아웃됨|로그아웃 됨|Signed out/i
