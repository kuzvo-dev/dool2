// Korean site text and Korean words the browser tools match (ADR 0029). Keep the Korean exactly: these patterns
// recognize buttons, checkout screens and dialogs on Korean sites, and the role words the extension writes in page
// snapshots ([e12 버튼 "검색"]).

// ── Page snapshot role words (written by the extension) ──

/** Role words in snapshot refs, as a regex alternation */
export const SNAP_ROLES =
  '링크|버튼|입력칸|검색칸|비밀번호칸|체크박스|라디오|스위치|탭|메뉴|선택지|선택 상자|항목'

/** Single role words compared with `role ===` */
export const ROLE = {
  link: '링크',
  button: '버튼',
  input: '입력칸',
  searchBox: '검색칸',
  password: '비밀번호칸',
  checkbox: '체크박스',
  radio: '라디오',
  switch: '스위치',
  tab: '탭',
  menu: '메뉴',
  option: '선택지',
  select: '선택 상자',
  item: '항목',
  /** Role given to a spot marked by its text (mark-text), not written by the extension */
  text: '글',
} as const

/** A label that starts with a choice role (radio, checkbox, switch, option) */
export const CHOICE_ROLE_PREFIX = /^(?:라디오|체크박스|스위치|선택지)\s/

/** Unnamed button or radio refs, to find the text next to them */
export const NEAR_LABEL_REF = /\[(e\d+) (?:버튼|라디오)(?: [^"\]]*)?\]/g

/** Selected radio, checkbox or option refs */
export const SELECTED_REF = /\[(e\d+) (?:라디오|체크박스|선택지)[^\]]*선택됨\]/g

/** Expanded button refs */
export const EXPANDED_REF = /\[(e\d+) 버튼[^\]]*펼침\]/g

// ── Risky button labels ──

/** Labels that spend money */
export const RISK_MONEY_WORDS =
  /결제|구매|주문|구독|충전|송금|이체|입금|예약\s*(?:확정|완료|하기)|\S(?:으로|로)\s*예약$|바로\s*예약$|예매\s*하기|후원|기부|계좌\s*등록|\b(?:pay|checkout|purchase|buy\s*now|place\s*order)\b/i

/** Labels that send to people or submit personal data */
export const RISK_CONTACT_WORDS =
  /보내기|전송|발송|문의\s*(?:하기|등록)|신청\s*(?:하기|완료)|(?:^|\s)(?:답변\s*)?제출(?:\s*하기|\s*완료)?$|응모\s*(?:하기|완료)|(?:^|\s)응모$|\b(?:send|submit)\b/i

/** Labels that cannot be undone */
export const RISK_IRREVERSIBLE_WORDS =
  /삭제|탈퇴|해지|비우기|초기화|\b(?:delete|remove\s*account|unsubscribe)\b/i

// ── Checkout and confirmation screens ──

/** Checkout mark: payment method */
export const CHECKOUT_PAY_METHOD = /결제\s*(?:수단|방법|방식)|카드\s*번호|간편\s*결제\s*(?:선택|수단)/

/** Checkout mark: booker, buyer or recipient details */
export const CHECKOUT_BOOKER =
  /(?:예약자|주문자|구매자|투숙객|탑승객|예매자|신청자|이용자)\s*정보|체크인\s*고객\s*정보|받는\s*(?:분|사람)\s*정보|배송지\s*(?:정보|입력|선택|변경)/

/** Checkout mark: payment amount */
export const CHECKOUT_AMOUNT = /(?:총|최종)\s*(?:결제\s*)?금액|결제\s*(?:예정\s*)?금액|결제\s*요금/

/** Checkout mark: terms consent */
export const CHECKOUT_TERMS = /(?:약관|결제\s*진행|구매\s*조건|개인정보\s*(?:제3자\s*)?제공)[^\n]{0,12}동의/

/** A line that reads as a sentence (guidance, not a section label) */
export const SENTENCE_END = /[.。!?]$|(?:니다|어요|아요|해요|세요|예요|이에요)$/

/** Words of a confirmed booking or order */
export const ORDER_CONFIRMED =
  /(?:예약|주문|결제|구매|예매|신청)(?:이|가)?\s*(?:완료|확정)\s*(?:되었|됐|했|하였)|(?:예약|주문|예매)\s*번호\s*[:：]?\s*[A-Z0-9-]{5,}/

/** Button names that spend money right now */
export const PAY_NOW_WORDS =
  /결제\s*하기|(?:^|\s)결제$|(?:바로|간편|최종)\s*결제|\S(?:으로|로)\s*결제|결제\s*(?:완료|진행|요청)|구매\s*확정|주문\s*(?:완료|확정)|예약\s*(?:확정|완료)|송금|이체|\b(?:pay\s*now|place\s*(?:my\s*)?order|complete\s*(?:purchase|order|booking)|confirm\s*(?:and\s*)?pay)\b/i

/** Words for viewing past orders, payments and bookings */
export const LOOKUP_WORDS =
  /(?:주문|구매|결제|예약|예매|구독|충전|송금|이체|입금|후원|기부)\s*(?:상세(?:\s*정보)?|내역|목록|조회|이력|정보|번호|일자|일시|현황|관리|상태)|(?:주문|구매|결제|예약)한\s*(?:상품|내역)/g

/** Adding to a cart or order sheet */
export const CART_ADD_WORDS =
  /(?:주문표|장바구니|카트|쇼핑백|담은\s*목록)\s*(?:에|으로)?\s*(?:추가|담기|넣기|담아)|(?:^|\s)담기(?:\s|$)/g

// ── Site confirm dialogs ──

/** Dialog text about spending money */
export const DIALOG_MONEY_WORDS =
  /(?:결제|구매|주문|예약|예매|신청|송금|이체|충전|구독|후원|기부)\s*(?:하|할|합|을|를|이|가|\?|$)|\b(?:pay|purchase|order|book)\b/i

/** Dialog text about sending or posting */
export const DIALOG_CONTACT_WORDS =
  /(?:보내|전송|발송|게시|등록|올리)\s*(?:하|할|합|시|을|를|\?|$)|\b(?:send|post|publish|submit)\b/i

/** Dialog text about something that cannot be undone */
export const DIALOG_IRREVERSIBLE_WORDS =
  /삭제|탈퇴|해지|취소\s*(?:하|할|합|시)|초기화|비우|\b(?:delete|remove)\b/i

// ── Covering windows (cookie banners, promo popups) ──

/** Button or link refs with a name */
export const BUTTON_OR_LINK_REF = /\[(e\d+) (?:버튼|링크) "([^"]*)"[^\]]*\]/g

/** Reject buttons of cookie consent banners */
export const COOKIE_REJECT_NAMES =
  /^(?:모두\s*거부|전체\s*거부|모든\s*쿠키\s*거부|쿠키\s*거부|필수\s*쿠키만\s*(?:허용|사용|동의)?|필수(?:\s*항목)?만\s*(?:허용|사용|동의)|reject\s*all(?:\s*cookies)?|decline\s*all|only\s*necessary(?:\s*cookies)?|necessary\s*(?:cookies\s*)?only|use\s*necessary\s*cookies\s*only)$/i

/** Cookie wording */
export const COOKIE_WORDS = /쿠키|cookie/i

/** Close buttons of ad, app install and urgency popups */
export const PROMO_CLOSE_NAMES =
  /^(?:닫기|창\s*닫기|close|×|✕|✖|x|나중에(?:\s*(?:하기|보기|할게요))?|다음에(?:\s*할게요)?|괜찮아요|아니(?:요|오)?\s*괜찮아요|건너뛰(?:기|고)|skip|skip\s*for\s*now|maybe\s*later|no\s*thanks|나중에\s*받을게요|오늘\s*(?:하루\s*)?(?:그만|안)\s*보기|do\s*n'?t\s*show\s*again)$/i

/** Ad, app install, subscription and urgency wording */
export const PROMO_WORDS =
  /앱(?:에서|으로|\s*설치|\s*다운|\s*열기)|어플|app\s*(?:store|download|install)|구독|뉴스레터|newsletter|알림\s*받|푸시\s*(?:받|허용)|첫\s*(?:구매|주문)\s*할인|회원\s*가입(?:하고|하면)|지금\s*가입|쿠폰\s*(?:받|드려)|이벤트\s*응모|마감\s*임박|서두르세요|얼마\s*(?:안|남지)\s*(?:남|않)|곧\s*(?:마감|종료|품절)|놓치지\s*마|한정\s*(?:수량|특가)|리뷰\s*(?:작성|남기)|평점\s*(?:남기|부탁)|설문|의견을?\s*들려/i

/** Real-step wording (payment, login, identity verification, consent): such windows are never treated as ads */
export const PROMO_KEEP_WORDS =
  /결제|주문서|예약자|로그인|본인\s*인증|인증번호|비밀번호|약관\s*동의|필수\s*동의|주소\s*입력|배송지|카드\s*번호|결제\s*수단/i

// ── Payment methods ──

/** Payment method names inside a final button name ("네이버페이로 예약하기") */
export const PAY_METHOD_WORDS =
  /(?:네이버\s*페이|카카오\s*페이|토스\s*페이|페이코|PAYCO|삼성\s*페이|애플\s*페이|쿠페이|스마일\s*페이|SSG\s*PAY|L\.?\s*PAY|N\s*pay|신용\s*카드|체크\s*카드|카드|휴대폰|계좌\s*이체|무통장(?:\s*입금)?|포인트|머니)\s*(?:으로|로)?\s*/gi

/** Names of radios and options that choose a payment method */
export const PAY_OPTION_NAMES =
  /^(?:(?:신용|체크)\s*)?카드(?:\s*결제)?$|^신용\s*\/\s*체크\s*카드|일반\s*결제|다른\s*결제\s*수단|^[A-Z]{2,}\s*(?:머니|페이|카드\s*페이)|네이버\s*페이|카카오\s*페이|토스\s*페이|페이코|PAYCO|삼성\s*페이|애플\s*페이|쿠페이|스마일\s*페이|SSG\s*PAY|N\s*pay|휴대폰\s*결제|계좌\s*이체|무통장(?:\s*입금)?|간편\s*결제|(?:지금|나중에|현장에서|숙박\s*시설에서)\s*결제/i

/** Button names that are a payment method as a whole (optionally with a benefit note) */
export const PAY_BUTTON_NAMES =
  /^(?:신용\s*\/\s*체크\s*카드|(?:신용|체크)?\s*카드|네이버\s*페이|카카오\s*페이|토스\s*페이|페이코|PAYCO|삼성\s*페이|애플\s*페이|쿠페이(?:\s*머니)?|스마일\s*페이|SSG\s*PAY|N\s*pay|휴대폰|계좌\s*이체|무통장(?:\s*입금)?|간편|일반|다른\s*결제\s*수단|[A-Z]{2,}\s*(?:머니|페이|카드\s*페이))(?:\s*결제)?(?:\s*혜택|\s*[\d.]+\s*%\s*(?:포인트\s*)?(?:적립|할인))?$/i

/** Trailing benefit note on a payment method name */
export const BENEFIT_SUFFIX = /\s*혜택$/

/** Whether an approval card's choice title means "payment method" */
export function payMethodTitle(title: string): boolean {
  return title === '결제 수단' || /^payment methods?$/i.test(title)
}

/** Detailed payment choices in a checkout dropdown (saved cards, installment months, banks) */
export const SUB_OPTION_WORDS = /일시불|할부|\d+\s*개월|카드|\*{3,}|은행|뱅크/

/** Installment choices */
export const INSTALLMENT_WORDS = /일시불|할부|\d+\s*개월/

/** Saved card choices */
export const CARD_OPTION_WORDS = /카드|\*{3,}/

// ── Secure keypads ──

/** Symbol names on secure keypads (screen reader labels: Shinhan Card etc.) */
export const KEYPAD_SPECIAL_NAMES: Record<string, string[]> = {
  '!': ['느낌표'],
  '@': ['골뱅이'],
  '#': ['우물표시', '샵'],
  $: ['달러표시'],
  '%': ['퍼센트'],
  '^': ['윗꺽쇠'],
  '&': ['앰퍼센드'],
  '*': ['별표'],
}

/** Keypad label prefix for a lowercase letter ("소문자 a") */
export const KEYPAD_LOWER = '소문자'
/** Keypad label prefix for an uppercase letter ("대문자 A") */
export const KEYPAD_UPPER = '대문자'
/** A letter key with its case label */
export const KEYPAD_CASE_KEY = /^(소|대)문자 [a-zA-Z]$/
/** Keys that switch back to the letter row */
export const KEYPAD_TO_LETTERS = ['소문자', '영문', '알파벳']
/** Keys that switch to the symbol row */
export const KEYPAD_TO_SYMBOLS = ['알파벳/특수문자', '특수문자', '특수키']
/** Keys that switch from the symbol row to letters */
export const KEYPAD_SYMBOLS_TO_LETTERS = ['소문자', '알파벳/특수문자', '영문']
/** Keys that finish keypad input */
export const KEYPAD_DONE = ['확인', '입력완료', '완료']

// ── Product options ──

/** Sold-out marks after an option name */
export const SOLD_OUT_MARK = /\s*[([]?\s*(품절|일시품절|재입고\s*알림)\s*[)\]]?\s*/g

/** Price after an option name ("89,000 원") */
export const PRICE_SUFFIX = /\s*[+-]?[\d,]+\s*원\s*$/

/** Characters that make up a word (for whole-word option matching) */
export const WORD_CHARS = 'a-z0-9가-힣'

/** Signal that a product option must be chosen first (site dialogs, guidance text) */
export const NEED_OPTION_WORDS =
  /옵션.{0,8}(선택|골라)|(사이즈|색상|컬러|옵션)(을|를)\s*(먼저\s*)?선택|선택.{0,6}옵션/

/** Button and input names that open product options */
export const OPTION_FIELD_NAME =
  /^(옵션|사이즈|색상|컬러|용량|수량 선택|선택|선택해 ?주세요\.?|.{0,6}(옵션|사이즈|색상) ?(열기|선택)|선택 목록 열기)$/

// ── Signup and password change ──

/** Screen text after a finished signup or password change */
export const ACCOUNT_DONE_WORDS =
  /(회원\s*)?가입(이|을)?\s*(완료|축하|환영)|가입(이|을)?\s*(되었|됐|마쳤|끝났)|비밀번호(가|를)?\s*(변경|재설정)(이|을)?\s*(완료|되었|됐|했)|welcome to|registration (is )?complete|account (has been |was )?created/i

/** Screen text saying the account already exists */
export const ACCOUNT_EXISTS_WORDS =
  /이미\s*(가입|사용\s*중|등록|존재)(된|인|하는|한|되어\s*있는|돼\s*있는)?\s*(이메일|아이디|계정|회원|ID|e-?mail)|already (registered|exists|in use|taken)/i

/** User words asking to reset or change a password */
export const ASKED_RESET = /(비밀번호|비번)\s*(을|를|도)?\s*(찾|바꿔|바꾸|재설정|변경|새로)/

/** User words asking to sign up */
export const ASKED_SIGNUP = /(회원\s*)?가입|계정\s*(을|도)?\s*(만들|새로|생성|하나)/

// ── Addresses ──

/** Neighborhood words in a Korean address (신봉동, 신봉1로, ...) */
export const TOWN_WORD = /[가-힣]+\d*(?:동|로|길|가|리)(?=\s|\d|$)/g

/** Suffix removed to get the neighborhood name (신봉1로 → 신봉, 신봉동 → 신봉) */
export const TOWN_SUFFIX = /\d*(?:동|로|길|가|리)$/

/** Sold-out or restock wording in an option label */
export const SOLD_OUT_WORDS = /품절|재입고/

// ── Markers other code parses ──

/** First words of a result stopped by the approval gate (connectors.ts and the extension e2e script match it) */
export const APPROVAL_NEEDED = '승인이 필요해요'

/** Tab marker in tool results ("[탭 12]"). mcp-tools descriptions, connectors and the extension e2e scripts use this form */
export const tabTag = (tabId: number | string): string => `[탭 ${tabId}]`

/** Password-looking input names */
export const PASSWORD_FIELD_NAME = /비밀번호|password|passwd|\bpw\b|암호/i

/** Words of a verification code guidance line ("휴대폰으로 보낸 6자리를 넣어 주세요") */
export const CODE_HINT_WORDS = /인증|번호|보냈|문자|발송/

/** Named button or link refs (exact form, no trailing state words) */
export const BUTTON_OR_LINK_NAMED_REF = /\[(e\d+) (?:버튼|링크) "([^"]*)"\]/g

/** Consent button wording */
export const CONSENT_WORD = /동의/

/** "카드" at the end of a card issuer name (KB국민카드 → KB국민) */
export const CARD_SUFFIX = /카드$/

/** "Page not found" wording */
export const NOT_FOUND_WORDS =
  /404|페이지를 찾을 수 없|존재하지 않는 페이지|없는 페이지|요청하신 페이지|Page Not Found|not found/i

/** Page text asking to choose an option first */
export const OPTION_FIRST_WORDS = /옵션\s*선택\s*후에|옵션을\s*(먼저\s*)?선택해\s*주세요/
