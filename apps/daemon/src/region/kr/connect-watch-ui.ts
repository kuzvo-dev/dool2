// Korean snapshot text the login watcher matches (the browser snapshot labels and Korean sites are Korean)
/** Button or link with a name + 님 ("주*돈 님", "홍길동님"): Korean sites (Kurly etc.) that hide Logout in a hover menu
 *  show only this at the top. Generic forms of address like "고객님" and "회원님" are excluded */
export const NAME_BUTTON =
  /\[e\d+ (?:버튼|링크) "(?![^"]*(?:고객|회원|손님|사장)님)(?!고객|회원|손님)[^"\]\n]{1,20}?\s?님"\]/

/** Account menu button like "○○ 님의 계정 메뉴" (measured on Booking.com: "지니어스 레벨 일, myeongdon joo 님의 계정 메뉴") */
export const ACCOUNT_MENU = /\[e\d+ (?:버튼|링크) "[^"\]\n]{1,60}님의\s?(계정|프로필|마이)[^"\]\n]{0,20}"\]/

/** Account button ("Google 계정: name (mail)"): Google services hide Logout inside the account menu */
export const ACCOUNT_BUTTON = /\[e\d+ (?:버튼|링크) "(?:Google 계정|Google Account): [^"]+"/

/** ID + "내정보 보기" link (top row of Naver: "wwd 내정보 보기"): Logout is hidden inside that menu */
export const MY_INFO = /\[e\d+ (?:버튼|링크) "[^"\]\n]{1,30}\s내\s?정보\s?보기"\]/

/**
 * Login entry: a short link or button telling people to sign in or sign up ("로그인", "로그인/회원가입", "카카오 로그인", "Sign in"),
 * or a password box. It disappears once signed in
 */
export const LOGIN_ENTRY =
  /\[e\d+ (?:링크|버튼) "[^"\]\n]{0,10}(?:로그인|log\s?in|sign\s?in|sign\s?up|회원\s?가입|가입하기|계정\s?만들기|create (?:an )?account)[^"\]\n]{0,10}"\]|\[e\d+ (?:링크|버튼) "[^"\]\n]{1,20}(?:으로|로)\s?계속하기[^"\]\n]{0,12}"\]|\[e\d+ (?:링크|버튼) "Continue with [^"\]\n]{1,20}"\]|\[e\d+ 비밀번호칸/i

/** Password box marker in the snapshot text (Korean snapshot label or an html attribute) */
export const PASSWORD_BOX = /비밀번호칸|type="?password/
/** Signup, extra info, identity check and terms screens right after a simple login are not done yet */
export const SIGNUP_STEP =
  /약관|본인\s?인증|추가\s?정보|정보\s?입력|회원\s?가입|가입\s?(하기|완료|정보)|인증\s?번호|필수/
/** Link refs in the snapshot (removed to read only the prose) */
export const ANY_LINK = /\[e\d+ 링크 "[^"]*"\]/g
/** Words most sites show at the top once signed in when the card has no signedIn */
export const DEFAULT_SIGNED_IN = ['로그아웃', 'Logout', 'Log out', 'Sign out']
