// Korean text that auto-login matches on screens (ADR 0029): words on Korean login, consent, join and identity
// check pages, plus the role words of the extension's page reading ("[e12 버튼 \"로그인\"]"), which is Korean.
// Keep the Korean exactly: these patterns were tuned against real sites.

// ── Page reading roles (from the extension's snapshot text) ──

/** Role names in the page reading */
export const ROLE = {
  input: '입력칸',
  search: '검색칸',
  password: '비밀번호칸',
  button: '버튼',
  link: '링크',
  checkbox: '체크박스',
} as const
/** A text field or password field is on the page */
export const FIELD_REF = /\[e\d+ (입력칸|비밀번호칸)/
/** A password field is on the page */
export const PASSWORD_REF = /\[e\d+ 비밀번호칸/
/** Link marks, removed to keep only what the page says to people */
export const LINK_REF = /\[e\d+ 링크 "[^"]*"\]/g
/** Value mark on a field that already has a value ('값="…"') */
export const VALUE_MARK = /값="/
/** "Checked" mark after a checkbox name */
export const SELECTED = /선택됨/
/** Checked checkboxes: skips ']' inside the name ("[필수]") and looks for the mark after the quote */
export const CHECKED_RE = /\[(e\d+) 체크박스 "(?:[^"\\]|\\.)*"[^\]"]*선택됨\]/g
/** Heading the page reading puts before text from frames inside the page */
export const FRAME_HEADING = '## 화면 안 액자'
/** A button or link without a name, followed by a short label ("[e25 버튼] 네이버") */
export const BARE_ICON_RE = /\[(e\d+) (버튼|링크)\]\s*([^[\n]{1,14})/g
/** Selected radio option on an "existing account" page (its label is the account) */
export const RADIO_ACCOUNT = /\[e\d+ 라디오 "([^"]{2,40})"/

// ── Provider accounts ──

/** Kakao account page: "felix…@gmail.com 계정 정보로 이동" */
export const KAKAO_ACCOUNT = /"([^"\s]+@[^"\s]+) 계정 정보로 이동"/
/** Naver home: "wwd님" */
export const NAVER_ACCOUNT = /\[e\d+ (?:링크|버튼) "([^"\s]{2,30})님"\]/
/** Google: "Google 계정: name (mail)" */
export const GOOGLE_ACCOUNT = /(?:Google 계정|Google Account): [^"(]*\(([^)\s]+@[^)\s]+)\)/
/** Account shown on a provider consent page (Kakao: "로그인된 계정 f***@gmail.com") */
export const SIGNED_IN_ACCOUNT = /로그인된\s?계정\s*([^\s[\]"]+@[^\s[\]"]+)/
/** "Keep me signed in" checkbox on a login page */
export const KEEP_SIGNED_IN =
  /\[(e\d+) 체크박스 "(?:로그인\s?상태\s?유지|자동\s?로그인|Keep me (?:signed|logged) in|Stay signed in)[^"]*"([^\]]*)\]/i

// ── Codes and phone numbers the page asks for ──

/** Verification code field */
export const CODE_FIELD =
  /인증\s?번호|인증\s?코드|보안\s?코드|확인\s?코드|승인\s?번호|OTP|verification|one[-\s]?time|\bcode\b/i
/** Phone number field */
export const TEL_FIELD = /휴대폰\s?번호|휴대전화|전화\s?번호|phone/i
/** Button that submits an entered code */
export const ANSWER_SUBMIT =
  /^(확인|인증|인증하기|확인하기|인증\s?완료|다음|계속|계속하기|로그인|제출|완료|submit|verify|continue|next|confirm|done)$/i
/** A line of page guidance about the code ("카카오톡으로 보낸 6자리를 넣어 주세요") */
export const CODE_HINT = /인증|번호|보냈|문자|입력/

// ── Login page ──

/** Login button text */
export const LOGIN_WORD = /^(로그인|로그인하기|login|log in|sign in|signin)$/i
/** Any login word */
export const LOGIN_LINK = /로그인|log ?in|sign ?in/i
/** User ID field names */
export const USER_FIELD = /아이디|이메일|email|e-mail|\bid\b|휴대폰|전화|phone|계정|사용자/i
/** Page asks for an email or ID */
export const ASKS_ID = /이메일|아이디|email/i
/** CAPTCHA on a login page: a person must solve it */
export const CAPTCHA =
  /보안\s?문자|자동\s?입력\s?방지|로봇이 아닙니다|I'm not a robot|문자를 입력해|아래\s?문제에\s?답해|DKAPTCHA|지도에서\s?.{0,8}눌러/i
/** Extra check after pressing login (narrow, so "아이디 찾기(본인인증)" on the login page does not match) */
export const STEP2 =
  /인증\s?번호를?\s?(입력|받|보내)|(확인|로그인|보안)\s?코드를?\s?(입력|받|보냈|보내)|새로운\s?(기기|환경|브라우저)에서|2단계\s?인증|추가\s?인증이\s?필요|본인\s?확인이\s?필요|본인인증을\s?진행|OTP\s?(번호|입력)/i
/** Page asks to approve the sign-in in a phone app (KakaoTalk, Naver app, Google, Toss push) */
export const APP_CONFIRM =
  /(카카오톡|네이버\s?앱|토스\s?앱|앱|휴대\s?전화|휴대폰|기기)(에서|으로|로)\s?.{0,14}(확인|승인|인증|허용|눌러|탭)|알림을\s?(보냈|확인|탭|눌러)|푸시\s?(알림|인증)|check your phone|tap yes|approve (the |this )?sign.?in|로그인\s?(요청|확인)을?\s?(보냈|확인해)/i
/** "Don't use 2-step on this browser" / "Remember this device" checkboxes */
export const REMEMBER_BROWSER =
  /(이\s?(브라우저|기기|PC|컴퓨터)에서|이\s?(기기|브라우저)를?\s?기억).{0,16}(사용\s?안\s?함|묻지\s?않|기억|건너뛰)|다시\s?묻지\s?않|don'?t ask again|remember (this )?(device|browser)/i
/** Which app to approve in, guessed from the page */
export const CONFIRM_APP = {
  kakaoTalk: /카카오톡|kakaotalk/i,
  naverApp: /네이버\s?앱|naver app/i,
  toss: /토스/i,
  phone: /google|구글|휴대\s?전화를\s?확인|check your phone/i,
} as const
/** Wrong ID or password */
export const WRONG =
  /(비밀번호|아이디|계정).{0,20}(잘못|틀|일치하지|확인해|올바르지|맞지 않)|등록되지 않은|incorrect|invalid (password|username|email)|wrong password/i
/** Social login entry button ("카카오로 시작"): a page with only these has finished drawing */
export const SOCIAL_ENTRY =
  /\[e\d+ (버튼|링크) "[^"]*(카카오|네이버|구글|애플|apple|google|kakao|naver|휴대폰\s?번호)[^"]*(로그인|시작|계속|login|sign|continue)/i
/** Buttons that close an ad or notice popup */
export const POPUP_CLOSE =
  /^(닫기|팝업\s?닫기|close|오늘은?\s?그만\s?보기|오늘\s?하루\s?(동안\s?)?(보지|열지)\s?않기|다시\s?보지\s?않기|일주일간\s?보지\s?않기)$/i
/** "Don't show today / again / this week" (preferred, so the popup stays closed) */
export const POPUP_DONT_SHOW = /오늘|다시|일주일/
/** Social, passkey or QR login (not ID and password) */
export const SOCIAL =
  /패스키|QR|간편|휴대폰|카카오|네이버|애플|구글|페이코|SNS|kakao|naver|apple|google|facebook|페이스북/i
/** Join or guest links */
export const JOIN_WORD = /가입|비회원/
/** Business, partner and seller logins (not user accounts) */
export const BUSINESS_LOGIN = /파트너|사업자|판매자|셀러|기업\s?회원|partner|seller|business/i
/** "Log in with ID or email" on a login method page */
export const ID_LOGIN =
  /^((이메일|아이디|ID|e-?mail|휴대폰\s?번호|통합\s?(아이디|계정)).{0,12}(로그인|계속하기|시작하기)|(이?메일|아이디)로\s?(로그인|시작하기|계속하기)|이메일|이메일\s?주소|메일|아이디|email|e-?mail\s?address)$/i
/** Find or reset ID / password links (not the login page) */
export const FIND_RESET = /찾기|잊으셨|재설정|forgot|reset/i
/** "아이디로 로그인", "무신사 통합계정 … 로그인" */
export const ID_LOGIN_LOOSE = /(아이디|이메일|ID|통합\s?계정).{0,12}로그인/i
/** Unified account with a name in front ("서울시통합 계정으로 시작하기") */
export const UNIFIED_ACCOUNT = /통합\s?(계정|아이디|회원).{0,12}(시작|로그인|계속)/
/** "로그인/회원가입" */
export const LOGIN_OR_JOIN = /^로그인\s?[/·|]\s?회원\s?가입$/
/** Telecom and portal IDs on a login method page (U+ID, T아이디, KT ID…) */
export const OWN_ID = /^(U\+\s?ID|MYLGID|T\s?아이디|KT\s?ID|통합\s?아이디|아이디)$/i
/** "More options", "Another way" (email login is inside) */
export const MORE_OPTIONS = /^(더\s?많은\s?(옵션|방법)|다른\s?방법)/
/** Icon-only sites: My page leads to login */
export const MY_PAGE =
  /^(마이\s?페이지|마이|MY|내\s?정보|my\s?page|account|계정|sign in|signin)($|\s?[ㆍ·/|])/i
/** "Continue" after entering the ID in a two-step login */
export const NEXT =
  /^(계속|다음|계속하기|진행|진행하기|이메일로 계속|continue|next|이메일로 계속하기|로그인 계속|이메일로 로그인|continue with email)$|^비밀번호로\s?로그인|^(이메일|아이디)\s?(계정)?으?로\s?계속(하기)?$/i
/** Login page heading */
export const LOGIN_HEADING =
  /^#{1,3}\s?(로그인|간편\s?로그인|SNS\s?로그인|로그인\s?(또는|및)\s?회원\s?가입|Log ?in|Sign ?in)/im

// ── Identity verification ──

/** Toss identity check */
export const CERT_TOSS = /토스로\s?인증|auth\.cert\.toss|토스\s?앱에서/
/** PASS (telecom) identity check */
export const CERT_PASS = /\bPASS\b|패스\s?앱|통신사\s?인증/
/** Name, phone number and birth date fields of an identity check */
export const CERT_FIELDS =
  /(이름|성명).{0,30}(휴대폰|휴대전화|전화)\s?번호.{0,30}(생년월일|주민)|본인\s?확인을?\s?위해.{0,20}(휴대폰|번호)/
/** Identity check words */
export const CERT_WORD = /본인\s?인증|본인\s?확인|휴대폰\s?인증|휴대전화\s?인증|간편\s?인증/
/** Identity check action */
export const CERT_ACTION = /인증\s?(하기|요청|받기)/
/** Words of a CAPTCHA (for the reason shown) */
export const HUMAN_CAPTCHA = /보안\s?문자|자동\s?입력\s?방지|로봇|captcha|문제에\s?답해|지도에서/i
/** Words of an identity check or code (for the reason shown) */
export const HUMAN_CERT = /본인\s?인증|휴대폰\s?인증|인증\s?번호|2단계|추가\s?인증|OTP/i
/** The site asks for an identity check after a social login */
export const CERT_REQUIRED =
  /본인\s?인증을?\s?(진행|해)\s?(해\s?)?주세요|본인\s?확인을?\s?(진행|해)\s?(해\s?)?주세요/

// ── Social login ──

/** Social login button text per provider */
export const SOCIAL_BUTTON = {
  kakao: /카카오|kakao/i,
  naver: /네이버|naver/i,
  google: /구글|google/i,
  apple: /애플|apple/i,
  facebook: /페이스북|facebook/i,
  payco: /페이코|payco/i,
  toss: /토스|toss/i,
} as const
/** Consent buttons on a provider page (Facebook adds the user's name: "○○님으로 계속") */
export const CONSENT =
  /^((동의|확인)하고\s?(계속하기|계속|시작하기|진행(하기)?)|전체\s?동의하고\s?계속하기|계속하기|계속|확인|허용|허용하기|동의|동의하기|로그인|Continue|Allow|Agree|Agree and continue|Confirm|.{1,30}(?:님)?(?:으로|로)\s?계속(?:하기)?|Continue as .{1,30})$/i
/** App store, channel and blog links that carry a provider name */
export const PROVIDER_NOISE =
  /스토어|store|채널|channel|play|플레이|앱\s?다운|블로그|blog|youtube|유튜브|클립|clip|카페|포스트|naver\s?tv|네이버\s?tv/i
/** The company's own social page links */
export const COMPANY_SNS = /^(facebook|페이스북|instagram|인스타그램)$/i
/** Login words on a provider button */
export const PROVIDER_LOGIN_WORD = /로그인|시작|계속|login|sign|continue/i
/** Screen-reader suffix "opens in a new window" */
export const NEW_WINDOW =
  /\(?\s*(새\s?창(으로)?\s?(열림|열기)?|새\s?탭|new\s?window|opens?\s?in\s?(a\s?)?new\s?(window|tab))\s*\)?/gi
/** Google account chooser */
export const ACCOUNT_CHOOSER = /accountchooser|gsi\/select|계정을?\s?선택|choose an account/i
/** "Switch account" line on the page after choosing */
/** A visible "log out" link or button (signing out first when the person switches to another account) */
export const LOGOUT_LINK = /\[(e\d+) (?:링크|버튼) "(?:로그아웃|Logout|Log out|Sign out)"\]/i
export const ACCOUNT_SWITCH = /계정\s?전환|switch account|선택되었습니다/i
/** "Change account" / "Another account" */
export const CHANGE_ACCOUNT = /계정\s?변경|다른\s?계정/
/** Required consent checkbox */
export const REQUIRED_CHECK = /\(필수\)|\[필수\]|필수\s/
/** Required word */
export const REQUIRED_WORD = /필수/
/** Required or "agree to all" */
export const REQUIRED_OR_ALL = /필수|전체\s?동의/

// ── Join and dormant account pages ──

/** No member linked to this provider account */
export const NOT_MEMBER =
  /계정을\s?만드세요|연동된\s?회원\s?정보를\s?찾을\s?수\s?없|SNS\s?계정\s?미연동|가입된\s?(회원|정보|계정)이?\s?없|등록된\s?회원이\s?없|연결된\s?(회원|계정)이\s?없|회원\s?정보가\s?없|create (an|your) account/i
/** "Already a member? / Not yet a member?" join page */
export const JOIN_PAGE =
  /(이미|기존)\s?.{0,12}회원이신가요|아직\s?.{0,12}회원이\s?아니|회원가입을\s?하시겠|SNS\s?(로그인\s?)?연동|계정\s?연동|간편\s?회원\s?가입/
/** Identity check needed to join */
export const JOIN_HUMAN = /본인\s?인증|휴대폰\s?인증|휴대전화\s?인증|아이핀|i-?PIN|인증번호/
/** Notes that only mention identity checks elsewhere ("본인인증이 필요한 서비스") */
export const JOIN_HUMAN_NOTE = /본인인증이 필요한 서비스|본인인증 이후 이용/
/** "Already joined" (the existing account can be linked by logging in) */
export const ALREADY_JOINED =
  /이미\s?가입된\s?(정보|계정|회원|아이디)|기존\s?계정\s?안내|이미\s?가입하신|가입한\s?아이디는/
/** "아이디는 mdj****10입니다" */
export const ID_IS = /아이디(?:는|[:\s])\s*([A-Za-z0-9_.@*-]{3,40}?)(?:입니다|\s|$)/
/** Join submit button */
export const JOIN_SUBMIT = /^(간편\s?)?(회원\s?가입|가입하기|가입\s?완료|동의하고\s?가입(하기)?)$/
/** Dormant (long unused) account page */
export const DORMANT = /휴면|장기\s?미사용/
/** Identity fields on a dormant account page */
export const DORMANT_CERT_FIELD = /휴대폰|전화|이름|생년월일|인증/
/** What a dormant account needs when no specific word was found */
export const DORMANT_DEFAULT_WHY = '본인인증'
/** Button that wakes a dormant account */
export const DORMANT_SUBMIT =
  /^(로그인\s?완료|휴면\s?(계정\s?)?해제(하기)?|해제하기|동의하고\s?(로그인|계속|해제)(하기)?|확인|다음|완료)$/
