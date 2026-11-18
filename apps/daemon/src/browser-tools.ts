// 두리 브라우저 도구의 본체 쪽 실행기. AI(MCP 도구 서버)는 여기로 부탁만 하고, 해도 되는지는 여기서 정한다.
// 확장은 판단하지 않는 손이라서, 위험한 클릭을 막는 것도 여기서 한다 (docs/architecture.md 4.2, 위협 모델 T2·T3).
//
// 돈이 나가거나·연락이 가거나·되돌릴 수 없는 버튼은 AI가 누를 수 없다. AI는 승인을 요청하고(request_approval),
// 사용자가 승인하면 본체가 그 버튼 하나만 누른다(approvals.ts). "항상 직접 누르기"면 사람에게 넘긴다.
import type { BrowserCommand, RemoteForm, RemoteFormValue, RemoteInfo } from '@dool2/protocol'
import { type ApprovalRecord, Approvals } from './approvals.js'
import { LoginRequests } from './logins.js'
import {
  maskValue,
  PROFILE_FIELDS,
  PROFILE_KEYS,
  type ProfileField,
  type ProfileKey,
  type ProfileStore,
  profileValue,
  sourceOf,
} from './profile.js'

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
  /** 서비스 도구(커넥터)의 구조화된 결과 (MCP structuredContent) */
  structuredContent?: Record<string, unknown>
}

export interface BrowserCaller {
  call(cmd: BrowserCommand, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export const BROWSER_TOOLS = [
  'open',
  'navigate',
  'read',
  'click',
  'type',
  'press',
  'scroll',
  'screenshot',
  'back',
  'close',
  'handoff',
  'login',
  'request_login',
  'fill_profile',
  'request_profile',
  'request_approval',
  'dialog',
  'steps',
  'hover',
] as const
export type BrowserTool = (typeof BROWSER_TOOLS)[number]

export type RiskKind = 'money' | 'contact' | 'irreversible'
export interface Risk {
  kind: RiskKind
  /** 위험하다고 본 근거 (버튼 글자나 주소) */
  reason: string
}

// 버튼 글자로 보는 위험. 하나라도 걸리면 위험으로 본다 (AI가 "조회예요"라고 해도 바뀌지 않는다)
const RISK_WORDS: [RiskKind, RegExp][] = [
  [
    'money',
    /결제|구매|주문|구독|충전|송금|이체|입금|예약\s*(?:확정|완료|하기)|\S(?:으로|로)\s*예약$|바로\s*예약$|예매\s*하기|후원|기부|계좌\s*등록|\b(?:pay|checkout|purchase|buy\s*now|place\s*order)\b/i,
  ],
  [
    'contact',
    /보내기|전송|발송|게시|올리기|작성\s*완료|등록\s*하기|(?:^|\s)등록$|댓글\s*등록|리뷰\s*등록|문의\s*(?:하기|등록)|신청\s*(?:하기|완료)|\b(?:send|post|publish|submit)\b/i,
  ],
  ['irreversible', /삭제|탈퇴|해지|비우기|초기화|\b(?:delete|remove\s*account|unsubscribe)\b/i],
]

// 결제 단계 페이지 (주소로 보는 위험)
const RISK_URL =
  /\/(?:checkout|payment|payments|pay|order\/?(?:sheet|form|confirm)|orderform|ordersheet)(?:[/?#.]|$)|(?:^|\.)(?:pay\.naver\.com|kakaopay\.com|tosspayments\.com|toss\.im|inicis\.com|nicepay\.co\.kr|kcp\.co\.kr|danal\.co\.kr|payco\.com|paypal\.com)/i

// 결제 화면 (주소는 그대로인 창 안 단계: 캐치테이블은 검색 지도 주소 위에서 결제 방법 고르기까지 간다)
// (실측: 제목이 '결제 방법 선택'일 때도, '결제 방식 선택'일 때도 있다)
const PAY_SCREEN = /결제\s*(?:방법|방식|수단)|최종\s*결제|총\s*결제\s*금액|결제\s*금액|결제\s*동의/
// 그런 화면에서 다음 단계로 넘기는 버튼은 결제·확정일 수 있다
const ADVANCE = /(?:^|\s)(?:다음|확인|완료|진행|계속|예약|신청|제출|동의하고\s*\S+|next|continue|confirm)$/i

/** 화면 글에 결제 단계 표시가 있으면 그 말 (없으면 undefined) */
export function payScreen(text: string): string | undefined {
  return screenMark(text, PAY_SCREEN)
}

/**
 * 화면의 제목·칸 이름에 그 표시가 있으면 그 말. 안내 문장 속 말은 세지 않는다
 * (실측: 호텔 상세 화면의 "이 숙박 시설에서 사용 가능한 결제 수단은 신용카드, 현금입니다." 때문에
 * 객실 목록을 결제 화면으로 잘못 봤다)
 */
function screenMark(text: string, re: RegExp): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[#\s>*-]+/, '').trim()
    if (!line || line.length > 60) continue
    if (/[.。!?]$|(?:니다|어요|아요|해요|세요|예요|이에요)$/.test(line)) continue
    const m = re.exec(line)
    if (m) return m[0]
  }
  return undefined
}

// 결제 화면 표시 묶음. 상품·상세 화면에도 '결제 방법' 안내나 '결제 정보' 접힘 버튼은 흔해서(실측: 11번가·지마켓·
// 무신사·제주항공·트립닷컴), 서로 다른 묶음이 두 가지 이상 함께 보여야 결제 화면으로 본다. 버튼 이름 속 글은 세지 않는다
const CHECKOUT_MARKS: [string, RegExp][] = [
  ['결제 수단', /결제\s*(?:수단|방법|방식)|카드\s*번호|간편\s*결제\s*(?:선택|수단)/],
  [
    '예약자 정보',
    /(?:예약자|주문자|구매자|투숙객|탑승객|예매자|신청자|이용자)\s*정보|체크인\s*고객\s*정보|받는\s*(?:분|사람)\s*정보|배송지\s*(?:정보|입력|선택|변경)/,
  ],
  ['결제 금액', /(?:총|최종)\s*(?:결제\s*)?금액|결제\s*(?:예정\s*)?금액|결제\s*요금/],
  ['약관 동의', /(?:약관|결제\s*진행|구매\s*조건|개인정보\s*(?:제3자\s*)?제공)[^\n]{0,12}동의/],
]

/** 결제 화면(결제 수단·예약자 정보를 넣는 화면)이면 그 표시 말. 주소가 결제 단계여도 결제 화면이다 */
export function checkoutScreen(text: string, url: string): string | undefined {
  try {
    const u = new URL(url)
    if (RISK_URL.test(u.pathname) || RISK_URL.test(u.hostname)) return '결제 단계 주소'
  } catch {}
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    if (/\[e\d+ /.test(raw)) continue // 버튼·칸 이름 속 글은 세지 않는다
    const line = raw.replace(/^[#\s>*-]+/, '').trim()
    if (!line || line.length > 60) continue
    if (/[.。!?]$|(?:니다|어요|아요|해요|세요|예요|이에요)$/.test(line)) continue
    for (const [name, re] of CHECKOUT_MARKS) if (re.test(line)) seen.add(name)
  }
  return seen.size >= 2 ? [...seen].join('·') : undefined
}

// 결제 화면으로 '들어가는' 버튼: 상품·객실·좌석 화면의 [예약하기]·[구매하기]·[주문하기]는 결제 화면을 열 뿐이다.
// 돈이 나가는 건 결제 화면의 마지막 버튼이라, 승인은 거기서 받는다. (버튼 이름 뒤 짧은 덧말은 허용: "예약하기 예약")
// 앞에 붙는 짧은 말도 허용: 화면 읽기가 이름을 겹쳐 읽거나("예약 예약하기", 호텔스닷컴) 대상이 붙는다("상품 예약하기").
// '바로·지금·즉시'처럼 그 자리에서 확정될 수 있는 말은 앞말로 받지 않는다
const CHECKOUT_ENTRY =
  /^(?:(?:예약|구매|주문|예매|상품|객실|숙소|티켓|좌석)\s+)?(?:예약\s*하기|구매\s*하기|주문\s*하기|예매\s*하기|바로\s*구매(?:\s*하기)?|구매\s*진행|주문\s*진행)(?:\s+\S{1,6})?$/

/** 결제 화면으로 들어가는 버튼 이름인지 (역할 이름은 뺀 버튼 글) */
export function isCheckoutEntry(name: string): boolean {
  return CHECKOUT_ENTRY.test(name.replace(/\s+/g, ' ').trim())
}

// 들어가는 버튼이라 믿고 눌렀는데 바로 확정된 화면 (결제 화면 없이 확정하는 사이트를 놓치지 않게)
const CONFIRMED =
  /(?:예약|주문|결제|구매|예매|신청)(?:이|가)?\s*(?:완료|확정)\s*(?:되었|됐|했|하였)|(?:예약|주문|예매)\s*번호\s*[:：]?\s*[A-Z0-9-]{5,}/

/** 결제 확정 화면이면 그 말 */
export function confirmedScreen(text: string): string | undefined {
  return CONFIRMED.exec(text)?.[0]
}

/** 결제 흐름(돈 내기 서비스 도구가 AI에게 넘긴 탭)을 기억하는 시간 */
export const PAY_FLOW_TTL_MS = 60 * 60_000

export function classifyRisk(label: string, url: string, pay?: string): Risk | undefined {
  // 라디오·체크박스는 고르기만 하고 확정하지 않는다 ('예약금 결제' 방식 라디오에 승인을 따로 받던 것)
  if (/^(?:라디오|체크박스|스위치|선택지)\s/.test(label)) return undefined
  for (const [kind, re] of RISK_WORDS) {
    const m = re.exec(label)
    if (m) return { kind, reason: `"${m[0]}"` }
  }
  const name = label.replace(/^(?:버튼|링크|메뉴|항목)\s*/, '').trim()
  if (pay && ADVANCE.test(name)) return { kind: 'money', reason: `'${pay}' 화면의 "${name}"` }
  let host = ''
  let path = ''
  try {
    const u = new URL(url)
    host = u.hostname
    path = u.pathname
  } catch {}
  // 결제 단계 주소에서는 버튼을 넓게 막는다. 다만 결제가 될 수 없는 이름(닫기·이전·자세히 보기 등)은 누른다
  // (실측: 호텔스닷컴 결제 화면의 재촉 창 [close]조차 승인을 받아야 했다)
  if ((RISK_URL.test(path) || RISK_URL.test(host)) && !HARMLESS.test(name))
    return { kind: 'money', reason: '결제 단계 페이지' }
  return undefined
}

// 결제가 될 수 없는 버튼 이름 (결제 단계 주소에서도 승인 없이 누른다)
const HARMLESS =
  /^(?:닫기|창\s*닫기|close|×|✕|x|이전|이전\s*단계|뒤로(?:\s*가기)?|돌아가기|취소|변경|수정|자세히(?:\s*보기)?|더\s*보기|접기|펼치기|전체\s*보기|약관\s*보기|보기|도움말|안내(?:\s*보기)?|알아보기)$/i

// 사이트 확인 창(confirm) 글로 보는 위험: "예약하시겠습니까?", "주문을 진행할까요?", "삭제하시겠습니까?"
const DIALOG_RISK: [RiskKind, RegExp][] = [
  [
    'money',
    /(?:결제|구매|주문|예약|예매|신청|송금|이체|충전|구독|후원|기부)\s*(?:하|할|합|을|를|이|가|\?|$)|\b(?:pay|purchase|order|book)\b/i,
  ],
  [
    'contact',
    /(?:보내|전송|발송|게시|등록|올리)\s*(?:하|할|합|시|을|를|\?|$)|\b(?:send|post|publish|submit)\b/i,
  ],
  ['irreversible', /삭제|탈퇴|해지|취소\s*(?:하|할|합|시)|초기화|비우|\b(?:delete|remove)\b/i],
]

/** 확인 창에서 [확인]을 누르면 위험한 일이 되는지 (창 글과 페이지 주소로 본다) */
export function classifyDialogRisk(message: string, url: string): Risk | undefined {
  for (const [kind, re] of DIALOG_RISK) {
    const m = re.exec(message)
    if (m) return { kind, reason: `확인 창의 "${m[0].trim()}"` }
  }
  return classifyRisk('', url)
}

const RISK_TEXT: Record<RiskKind, string> = {
  money: '돈이 나가는 일',
  contact: '다른 사람에게 무언가 보내거나 올리는 일',
  irreversible: '되돌릴 수 없는 일',
}

interface PageInfo {
  url: string
  refs: Map<string, { role: string; name: string }>
  /** 결제 단계 화면이면 그 표시 말 (예: '결제 방법 선택') */
  pay?: string
  /** 결제 화면(결제 수단·예약자 정보를 넣는 화면)이면 그 표시 말 */
  checkout?: string
  /** 예약·주문이 확정된 화면이면 그 말 */
  confirmed?: string
  /** 지금 골라져 있는 라디오·체크박스 표시 */
  selected?: Set<string>
}

function pageInfo(url: string, text: string): PageInfo {
  const checkout = checkoutScreen(text, url)
  const confirmed = confirmedScreen(text)
  const selected = new Set(
    [...text.matchAll(/\[(e\d+) (?:라디오|체크박스|선택지)[^\]]*선택됨\]/g)].map((m) => m[1] as string),
  )
  return {
    url,
    refs: parseRefs(text),
    pay: payScreen(text),
    ...(checkout ? { checkout } : {}),
    ...(confirmed ? { confirmed } : {}),
    ...(selected.size ? { selected } : {}),
  }
}

/** 한 번에 할 수 있는 동작 수 */
export const MAX_STEPS = 12

/** 확장 명령이 돌려주는 지금 탭 상태 */
interface BrowserState {
  url?: string
  dialog?: SiteDialog
}
interface ActResult {
  note: string
  url?: string
  dialog?: SiteDialog
  newTabId?: number
}
const state = (r: BrowserState | undefined): { url?: string; dialog?: SiteDialog } => ({
  ...(typeof r?.url === 'string' ? { url: r.url } : {}),
  ...(r?.dialog ? { dialog: r.dialog } : {}),
})

/** 사이트 알림창 (확장이 알린 그대로) */
export interface SiteDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  url: string
  defaultPrompt?: string
}

interface Snapshot {
  tabId: number
  url: string
  title: string
  text: string
  truncated: boolean
  captcha: boolean
  /** view로 읽었을 때 화면 위·아래에 남은 글자 수 */
  around?: { above: number; below: number }
  /** from·skip으로 앞에서 건너뛴 글자 수 */
  skipped?: number
  fromMissing?: boolean
  /** 떠 있는 확인 창 (confirm·prompt). 고를 때까지 페이지가 멈춰 있다 */
  dialog?: SiteDialog
  /** 확장이 바로 닫은 알림창 (alert·떠나기 확인) */
  dialogNotes?: SiteDialog[]
}

/** 스냅샷 글에서 [e12 버튼 "검색"] 표시를 모은다 */
export function parseRefs(text: string): Map<string, { role: string; name: string }> {
  const refs = new Map<string, { role: string; name: string }>()
  // 확장은 이름 안의 큰따옴표를 작은따옴표로 바꿔 보낸다
  const roles = '링크|버튼|입력칸|검색칸|비밀번호칸|체크박스|라디오|스위치|탭|메뉴|선택지|선택 상자|항목'
  const re = new RegExp(`\\[(e\\d+) (${roles})(?: "([^"]*)")?[^\\]]*\\]`, 'g')
  for (const m of text.matchAll(re)) {
    refs.set(m[1] as string, { role: (m[2] ?? '').trim(), name: m[3] ?? '' })
  }
  return refs
}

// 쿠키 동의 창의 거부 버튼. 동의 창은 화면을 덮어 누르기를 가로막는다
// (실측 2026-11-18: 호텔스닷컴 쿠키 창의 어두운 막이 [예약하기]를 가려 승인한 클릭이 먹지 않았다)
const COOKIE_REJECT =
  /^(?:모두\s*거부|전체\s*거부|모든\s*쿠키\s*거부|쿠키\s*거부|필수\s*쿠키만\s*(?:허용|사용|동의)?|필수(?:\s*항목)?만\s*(?:허용|사용|동의)|reject\s*all(?:\s*cookies)?|decline\s*all|only\s*necessary(?:\s*cookies)?|necessary\s*(?:cookies\s*)?only|use\s*necessary\s*cookies\s*only)$/i
const COOKIE_WORD = /쿠키|cookie/i

/**
 * 쿠키 동의 창이 떠 있으면 그 창의 거부 버튼 표시(e12).
 * 버튼 바로 앞(600자 안)에 '쿠키' 안내가 있을 때만 — 다른 화면의 '모두 거부'는 누르지 않는다.
 * 거부 버튼이 없는 창(동의만 있는 창)은 건드리지 않는다
 */
export function cookieReject(text: string): string | undefined {
  const re = /\[(e\d+) (?:버튼|링크) "([^"]*)"[^\]]*\]/g
  for (const m of text.matchAll(re)) {
    if (!COOKIE_REJECT.test((m[2] ?? '').replace(/\s+/g, ' ').trim())) continue
    const before = text.slice(Math.max(0, (m.index ?? 0) - 600), m.index)
    if (COOKIE_WORD.test(before)) return m[1]
  }
  return undefined
}

/** 같은 칸 찾기: 표시 번호가 그대로면 그것, 바뀌었으면 같은 역할·같은 글자인 칸이 하나뿐일 때 그것 */
export function sameControl(
  refs: Map<string, { role: string; name: string }>,
  ref: string,
  role: string,
  name: string,
): string | undefined {
  const at = refs.get(ref)
  if (at && at.role === role && at.name === name) return ref
  const same = [...refs].filter(([, v]) => v.role === role && v.name === name)
  return same.length === 1 ? same[0]?.[0] : undefined
}

// 결제 수단에 따라 이름이 바뀌는 마지막 버튼 ("네이버페이로 예약하기" ↔ "카드로 예약하기")
const PAY_METHOD =
  /(?:네이버\s*페이|카카오\s*페이|토스\s*페이|페이코|PAYCO|삼성\s*페이|애플\s*페이|쿠페이|스마일\s*페이|SSG\s*PAY|L\.?\s*PAY|N\s*pay|신용\s*카드|체크\s*카드|카드|휴대폰|계좌\s*이체|무통장(?:\s*입금)?|포인트|머니)\s*(?:으로|로)?\s*/gi

// 결제 수단을 고르는 칸 이름 (라디오·버튼)
const PAY_OPTION =
  /^(?:(?:신용|체크)\s*)?카드(?:\s*결제)?$|네이버\s*페이|카카오\s*페이|토스\s*페이|페이코|PAYCO|삼성\s*페이|애플\s*페이|쿠페이|스마일\s*페이|SSG\s*PAY|N\s*pay|휴대폰\s*결제|계좌\s*이체|무통장(?:\s*입금)?|간편\s*결제|(?:지금|나중에|현장에서|숙박\s*시설에서)\s*결제/i

/** 결제 화면의 결제 수단 고르기 칸들 (AI가 choices를 안 넘겨도 승인 카드에 싣는다) */
export function payOptions(refs: Map<string, { role: string; name: string }>): string[] {
  return [...refs]
    .filter(
      ([, v]) =>
        ['라디오', '선택지'].includes(v.role) && v.name.length <= 30 && PAY_OPTION.test(v.name.trim()),
    )
    .map(([k]) => k)
    .slice(0, 8)
}

/** 결제 수단 이름만 다른 같은 마지막 버튼인지 */
export function sameFinal(a: string, b: string): boolean {
  const strip = (x: string) => x.replace(PAY_METHOD, '').replace(/\s+/g, ' ').trim()
  return a !== b && strip(a) !== '' && strip(a) === strip(b)
}

/** 금고에서 지금 사이트의 로그인 정보를 찾는다 (값은 본체 밖으로 나가지 않는다) */
export interface VaultLookup {
  findForOrigin(origin: string): Promise<{ id: string; username: string; password: string } | undefined>
  markUsed(id: string): Promise<void>
}

/** 사람에게 넘긴 탭을 폰 원격 화면으로 다룰 수 있는 시간 */
export const REMOTE_TTL_MS = 30 * 60_000

export class BrowserTools {
  private pages = new Map<number, PageInfo>()
  /** 사람에게 넘긴 탭 → 넘긴 시각. 이 탭만 폰 원격 화면으로 보고 누를 수 있다 */
  private handedOff = new Map<number, number>()
  /** 탭마다 떠 있는 사이트 확인 창 (마지막으로 읽었을 때) */
  private dialogs = new Map<number, SiteDialog>()
  /** 확인 창 [확인]의 승인 요청 → 그 창의 글 (누르기 직전 같은 창인지 본다) */
  private dialogApprovals = new Map<string, string>()
  /** 결제 흐름 탭 → {돈 내기 도구 이름, 시작 시각}. 돈 내기 서비스 도구가 AI에게 넘긴 탭이다 */
  private payFlows = new Map<number, { tool: string; at: number }>()
  /** 결제 흐름의 서비스 사이트 (AI가 같은 사이트를 새 탭으로 다시 열어도 결제 흐름이다) */
  private paySites = new Map<string, { tool: string; at: number }>()
  /** 돈 내기 서비스 도구가 있는 사이트들: 도구를 거치지 않고 연 탭도 결제 흐름이다 */
  private payServiceSites = new Set<string>()
  setPayServiceSites(sites: string[]) {
    this.payServiceSites = new Set(sites.map((x) => x.toLowerCase()))
  }

  readonly approvals: Approvals
  readonly logins: LoginRequests

  constructor(
    private readonly browser: BrowserCaller,
    private readonly vault?: VaultLookup,
    /** 마지막 버튼을 승인받아 두리가 누를지(approve), 항상 사용자가 누를지(self) */
    private readonly finalStep: () => 'approve' | 'self' = () => 'approve',
    approvals?: Approvals,
    logins?: LoginRequests,
  ) {
    this.approvals = approvals ?? new Approvals()
    this.logins = logins ?? new LoginRequests()
  }

  /** 두리가 마지막으로 다룬 탭 (폰의 "두리 화면 보기"가 실시간으로 본다) */
  private _lastTabId?: number
  get lastTabId(): number | undefined {
    return this._lastTabId
  }
  set lastTabId(id: number | undefined) {
    const changed = id !== this._lastTabId
    this._lastTabId = id
    if (changed && id !== undefined) this.onActiveTab?.(id)
  }
  /** 두리가 다루는 탭이 바뀌었을 때 (폰 대화에 일하는 화면을 띄운다) */
  onActiveTab?: (tabId: number) => void
  /**
   * 서비스 도구가 지금부터 이 탭에서 일한다: 폰이 그 화면을 볼 수 있게 하고 바로 알린다.
   * 같은 탭을 다시 써도 알린다 (서비스마다 탭 하나를 계속 쓰는데, 폰은 일을 시작할 때마다 알아야 화면을 띄운다)
   */
  watchTab(tabId: number) {
    this.allowRemote(tabId)
    this._lastTabId = tabId
    this.onActiveTab?.(tabId)
  }
  /**
   * 금고에 그 주소가 없을 때 한 번 더 물어볼 곳: 연결을 이어받은 탭이면 그 서비스에 넣은 계정
   * (로그인 화면이 login.사이트처럼 같은 사이트의 다른 주소일 때). 같은 사이트인지는 묻는 쪽이 확인한다
   */
  siteLogin?: (
    tabId: number,
    origin: string,
  ) => Promise<{ id: string; username: string; password: string } | undefined>
  /** 내 정보 (예약자·주문자 칸). AI는 가린 값만 본다 */
  profile?: ProfileStore
  /** 내 정보 카드를 띄운다 (폰). 저장되면 본체가 그 대화로 이어서 하라고 알린다 */
  requestProfile?: (fields: ProfileField[], reason: string) => string | undefined
  /** 주소의 사이트에 서비스 도구(커넥터)가 있으면 그 서비스와 도구 이름 (ADR 0018) */
  siteConnector?: (url: string) => Promise<{ id: string; name: string; tools: string[] } | undefined>
  /** 탭마다 요령을 알린 사이트 (같은 사이트 안에서 옮길 때는 다시 알리지 않는다) */
  private guided = new Map<number, string>()
  /** 사이트마다 마지막으로 고른 결제 수단 (다음 승인 카드의 기본값) */
  private lastChoice = new Map<string, string>()
  /** 마지막으로 고른 결제 수단이 바뀌면 (본체가 설정에 남긴다) */
  onChoice?: (host: string, label: string) => void
  /** 설정에서 그 사이트의 결제 수단을 잊었을 때 */
  forgetChoice(host: string) {
    this.lastChoice.delete(host)
  }
  /** 설정에 남겨 둔 사이트별 마지막 결제 수단을 불러온다 */
  loadChoices(map: Record<string, string>) {
    for (const [k, v] of Object.entries(map)) this.lastChoice.set(k, v)
  }
  private rememberChoice(url: string, label: string) {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {}
    if (!host) return
    this.lastChoice.set(host, label)
    this.onChoice?.(host, label)
  }
  /** 쿠키 동의 창을 닫아 본 탭·사이트 (같은 곳에서 되풀이하지 않는다) */
  private cookieTried = new Set<string>()

  async run(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.tabId === 'number') this.allowRemote(args.tabId)
    try {
      const r = await this.dispatch(tool, args)
      // 잘 다룬 탭만 "지금 두리가 보는 탭"으로 (틀린 번호로 부른 도구는 빼야 실시간 화면이 엉뚱한 탭을 찍지 않는다)
      if (!r.isError && typeof args.tabId === 'number') this.lastTabId = args.tabId
      return r
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] }
    }
  }

  private async dispatch(tool: string, a: Record<string, unknown>): Promise<ToolResult> {
    const tabId = Number(a.tabId)
    switch (tool as BrowserTool) {
      case 'open': {
        const r = (await this.browser.call('open', { url: a.url }, 40_000)) as { tabId: number }
        this.lastTabId = r.tabId
        this.allowRemote(r.tabId)
        return this.read(r.tabId, undefined, '새 탭을 열었어요.')
      }
      case 'navigate': {
        await this.browser.call('navigate', { tabId, url: a.url }, 40_000)
        return this.read(tabId, undefined, '주소를 열었어요.')
      }
      case 'read':
        return this.read(tabId, a.maxChars, undefined, {
          ...(a.view === true ? { view: true } : {}),
          ...(typeof a.from === 'string' && a.from.trim() ? { from: a.from.trim() } : {}),
          ...(Number(a.skip) > 0 ? { skip: Math.floor(Number(a.skip)) } : {}),
        })
      case 'click': {
        const r = await this.act(tabId, { ...a, do: 'click' })
        if (r.newTabId) return this.read(r.newTabId, undefined, `${r.note} 새 탭이 열려서 그 탭을 읽었어요.`)
        return this.read(tabId, undefined, r.note)
      }
      case 'type':
        return this.read(tabId, undefined, (await this.act(tabId, { ...a, do: 'type' })).note)
      case 'press':
        return this.read(tabId, undefined, (await this.act(tabId, { ...a, do: 'press' })).note)
      case 'hover':
        return this.read(tabId, undefined, (await this.act(tabId, { ...a, do: 'hover' })).note)
      case 'steps':
        return this.steps(tabId, a)
      case 'scroll': {
        await this.browser.call('scroll', { tabId, direction: a.direction === 'up' ? 'up' : 'down' })
        // 사람이 굴린 뒤 화면을 보듯, 지금 보이는 부분만 읽어 돌려준다 (한 화면이라 짧다)
        return this.read(tabId, undefined, '스크롤했어요.', { view: true })
      }
      case 'screenshot': {
        const r = (await this.browser.call('screenshot', { tabId })) as {
          data: string
          mime: string
          url: string
          title: string
        }
        return {
          content: [
            { type: 'text', text: `[탭 ${tabId}] ${r.title} — ${r.url}` },
            { type: 'image', data: r.data, mimeType: r.mime },
          ],
        }
      }
      case 'back': {
        await this.browser.call('back', { tabId })
        return this.read(tabId, undefined, '뒤로 갔어요.')
      }
      case 'close': {
        await this.browser.call('close', { tabId })
        this.pages.delete(tabId)
        return { content: [{ type: 'text', text: `탭 ${tabId}을(를) 닫았어요.` }] }
      }
      case 'login': {
        // 두리 금고 (ADR 0011): AI는 칸만 알려 주고, 값은 본체가 주소를 확인한 뒤 확장에 직접 넘긴다
        const page = this.pages.get(tabId)
        if (!page) throw new Error('먼저 로그인 페이지를 읽어 주세요')
        const pw = page.refs.get(String(a.passwordRef ?? ''))
        if (pw?.role !== '비밀번호칸') throw new Error('passwordRef는 페이지의 비밀번호칸 표시여야 해요')
        const userRef = a.usernameRef ? String(a.usernameRef) : undefined
        if (userRef && !['입력칸', '검색칸'].includes(page.refs.get(userRef)?.role ?? ''))
          throw new Error('usernameRef는 아이디 입력칸 표시여야 해요')
        let origin: string
        try {
          origin = new URL(page.url).origin
        } catch {
          throw new Error('페이지 주소를 알 수 없어요')
        }
        const entry = (await this.vault?.findForOrigin(origin)) ?? (await this.siteLogin?.(tabId, origin))
        if (!entry)
          throw new Error(
            `이 사이트(${origin})는 두리 금고에 없어요. browser_request_login으로 사용자에게 로그인 카드를 띄우고 이번 답을 끝내세요.`,
          )
        // 확장도 주소를 다시 확인한다 (그 사이 다른 페이지로 넘어갔으면 채우지 않는다)
        if (userRef) await this.browser.call('fill', { tabId, ref: userRef, value: entry.username, origin })
        await this.browser.call('fill', {
          tabId,
          ref: String(a.passwordRef),
          value: entry.password,
          origin,
          password: true,
        })
        await this.vault?.markUsed(entry.id)
        return this.read(tabId, undefined, '두리 금고에서 로그인 정보를 채웠어요. 로그인 버튼을 눌러 주세요.')
      }
      case 'dialog': {
        // 사이트 확인 창(confirm·prompt)에서 고른다. [확인]이 결제·보내기·삭제가 되면 승인을 받는다
        const d = this.dialogs.get(tabId)
        if (!d)
          throw new Error('떠 있는 사이트 확인 창이 없어요. 페이지를 다시 읽어(browser_read) 확인해 주세요')
        const accept = a.accept !== false
        if (accept) {
          const risk = classifyDialogRisk(d.message, d.url)
          if (risk) {
            const next =
              this.finalStep() === 'approve'
                ? 'browser_request_approval에 dialog: true와 무엇을·어디서·얼마인지 적어 사용자 승인을 요청해 주세요. 승인되면 두리가 [확인]을 눌러요.'
                : '여기까지 한 내용을 사용자에게 정리해 알려 주고 browser_handoff로 사용자가 직접 고르게 넘겨 주세요.'
            throw new Error(
              `멈췄어요: ${risk.reason} — ${RISK_TEXT[risk.kind]}이라 승인 없이는 [확인]을 누르지 않아요. ${next}`,
            )
          }
        }
        await this.browser.call('dialog', {
          tabId,
          accept,
          expect: d.message,
          ...(d.type === 'prompt' && typeof a.text === 'string' ? { text: a.text.slice(0, 500) } : {}),
        })
        this.dialogs.delete(tabId)
        return this.read(tabId, undefined, `사이트 확인 창에서 [${accept ? '확인' : '취소'}]을 눌렀어요.`)
      }
      case 'request_approval': {
        if (a.dialog === true)
          return this.askDialogApproval(tabId, {
            what: String(a.what ?? ''),
            where: String(a.where ?? ''),
            ...(a.amount ? { amount: String(a.amount) } : {}),
            ...(a.cancel ? { cancel: String(a.cancel) } : {}),
          })
        const ref = String(a.ref ?? '')
        const choices = Array.isArray(a.choices)
          ? (a.choices as unknown[]).map((c) =>
              typeof c === 'string' ? c : String((c as { ref?: unknown })?.ref ?? ''),
            )
          : []
        return this.askApproval(tabId, ref, {
          what: String(a.what ?? ''),
          where: String(a.where ?? ''),
          ...(a.amount ? { amount: String(a.amount) } : {}),
          ...(a.cancel ? { cancel: String(a.cancel) } : {}),
          ...(choices.length
            ? { choices, choiceTitle: String(a.choiceTitle ?? '결제 수단').slice(0, 20) }
            : {}),
        })
      }
      case 'fill_profile': {
        // 내 정보 (예약자·주문자 칸): AI는 칸과 항목만 말하고, 값은 본체가 주소를 확인해 확장에 직접 넘긴다
        const page = this.pages.get(tabId)
        if (!page) throw new Error('먼저 페이지를 읽어 주세요')
        if (!this.profile) throw new Error('내 정보를 쓸 수 없어요')
        let origin: string
        try {
          origin = new URL(page.url).origin
        } catch {
          throw new Error('페이지 주소를 알 수 없어요')
        }
        const asks = Array.isArray(a.fields) ? (a.fields as { ref?: unknown; key?: unknown }[]) : []
        if (!asks.length) throw new Error('채울 칸(fields: [{ref, key}])을 알려 주세요')
        const p = await this.profile.get()
        const done: string[] = []
        const missing = new Set<ProfileField>()
        for (const x of asks.slice(0, 20)) {
          const ref = String(x.ref ?? '')
          const key = String(x.key ?? '') as ProfileKey
          if (!(PROFILE_KEYS as readonly string[]).includes(key))
            throw new Error(`${key}는 내 정보 항목이 아니에요. 쓸 수 있는 것: ${PROFILE_KEYS.join(', ')}`)
          const role = page.refs.get(ref)?.role ?? ''
          if (!['입력칸', '검색칸'].includes(role)) throw new Error(`${ref}는 글을 넣는 칸이 아니에요`)
          const value = profileValue(p, key)
          if (!value) {
            for (const f of sourceOf(key)) if (!p[f]) missing.add(f)
            continue
          }
          await this.browser.call('fill', { tabId, ref, value, origin })
          const shown = sourceOf(key)
            .map((f) => (p[f] ? maskValue(f, p[f] as string) : ''))
            .join(' ')
          done.push(`${PROFILE_FIELDS[sourceOf(key)[0] as ProfileField].label}(${shown})`)
        }
        const lines = [
          done.length ? `내 정보로 채웠어요: ${done.join(', ')}.` : '',
          missing.size
            ? `내 정보에 ${[...missing].map((f) => PROFILE_FIELDS[f].label).join('·')}이(가) 없어요. 사용자에게 묻지 말고 browser_request_profile로 내 정보 카드를 띄운 뒤 답을 끝내세요.`
            : '',
        ].filter(Boolean)
        return this.read(tabId, undefined, lines.join(' '))
      }
      case 'request_profile': {
        if (!this.profile || !this.requestProfile) throw new Error('내 정보 카드를 띄울 수 없어요')
        const all = Object.keys(PROFILE_FIELDS) as ProfileField[]
        const asked = (Array.isArray(a.fields) ? a.fields : [])
          .map(String)
          .filter((f): f is ProfileField => all.includes(f as ProfileField))
        const { missing } = await this.profile.masked()
        const fields = asked.length ? asked : missing
        if (!fields.length) throw new Error('내 정보가 모두 있어요. browser_fill_profile로 채우세요')
        const id = this.requestProfile(fields, String(a.reason ?? '').slice(0, 120))
        if (!id) throw new Error('내 정보 카드를 띄우지 못했어요')
        return {
          content: [
            {
              type: 'text',
              text:
                `내 정보 카드를 띄웠어요(${fields.map((f) => PROFILE_FIELDS[f].label).join('·')}). 사용자에게 "카드에 한 번만 넣어 주시면 다음부터는 제가 알아서 채워요"처럼 한 문장으로 말하고 이번 답을 끝내세요. ` +
                '넣은 값은 PC 금고에만 저장되고 당신에게는 가린 값만 와요. 저장되면 다음 메시지로 알려 줘요. 그때 browser_fill_profile로 채우세요.',
            },
          ],
        }
      }
      case 'request_login': {
        // 로그인 카드: 사용자가 PC·폰 카드에 넣은 값은 금고에만 들어간다. AI는 값을 보지 않는다
        const page = this.pages.get(tabId)
        if (!page) throw new Error('먼저 로그인 페이지를 읽어 주세요')
        let origin: string
        try {
          origin = new URL(page.url).origin
        } catch {
          throw new Error('페이지 주소를 알 수 없어요')
        }
        const local = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)
        if (!origin.startsWith('https://') && !local)
          throw new Error(
            'https 사이트만 로그인 정보를 저장할 수 있어요. browser_handoff로 사용자에게 넘겨 주세요.',
          )
        if (await this.vault?.findForOrigin(origin))
          return {
            content: [
              { type: 'text', text: '이 사이트는 이미 두리 금고에 있어요. browser_login으로 채우세요.' },
            ],
          }
        const site =
          String(a.site ?? '')
            .trim()
            .slice(0, 60) || new URL(origin).hostname
        const r = this.logins.create({ tabId, origin, site })
        return {
          content: [
            {
              type: 'text',
              text:
                `로그인 카드를 띄웠어요(${r.id.slice(0, 8)}). 사용자에게 카드에 ${site} 아이디와 비밀번호를 넣어 달라고 한두 문장으로 말하고 이번 답을 끝내세요. ` +
                '넣은 값은 두리 금고에만 저장되고 당신에게는 오지 않아요. 저장되면 다음 메시지로 알려 줘요. 그때 페이지를 다시 읽고 browser_login으로 채운 뒤 로그인 버튼을 누르세요.',
            },
          ],
        }
      }
      case 'handoff': {
        // 사람이 해야 하는 일(로그인·캡차·본인인증·마지막 버튼): 두리 탭을 앞으로 띄우고 이번 답을 끝내게 한다.
        // 화면은 이 도구 호출을 보고 [Chrome에서 보기] [다 했어요]를 띄운다
        await this.browser.call('focus', { tabId })
        this.handedOff.set(tabId, Date.now())
        return {
          content: [
            {
              type: 'text',
              text:
                'Chrome의 두리 탭을 사용자 앞에 띄웠어요. 사용자에게 무엇을 해 달라는지 한두 문장으로 말하고 이번 답은 여기서 끝내세요. ' +
                '사용자가 [다 했어요]를 누르면 다음 메시지로 이어서 하라는 부탁이 와요. 그때 페이지를 다시 읽어 확인하고 이어 가세요.',
            },
          ],
        }
      }
    }
    throw new Error(`모르는 브라우저 도구예요: ${tool}`)
  }

  /**
   * 동작 하나 (누르기·입력·키·기다리기·스크롤). 페이지는 읽지 않는다 — 부른 쪽이 마지막에 한 번 읽는다.
   * 위험한 동작을 막는 검사는 도구를 하나씩 부를 때와 똑같다
   */
  private async act(tabId: number, s: Record<string, unknown>): Promise<ActResult> {
    switch (s.do) {
      case 'click': {
        // 표시가 없는 상자(가게 카드 등)는 화면 글자로 찾아 표시를 붙인 뒤 누른다. 승인 게이트는 그 글자로 똑같이 거친다
        let ref = typeof s.ref === 'string' ? s.ref : ''
        if (!ref && typeof s.text === 'string' && s.text.trim())
          ref = (await this.markText(tabId, s.text)).ref
        const page = this.pages.get(tabId)
        const target = page?.refs.get(ref)
        if (!page || !target)
          throw new Error(`${ref}가 무엇인지 몰라요. 먼저 페이지를 읽어(browser_read) 표시를 확인해 주세요`)
        // 결제 흐름에서 결제 화면 전의 [예약하기]·[구매하기]는 결제 화면을 여는 버튼이라 승인 없이 누른다
        const entry = this.entersCheckout(tabId, page, target.name)
        if (!entry) this.guard(`${target.role} ${target.name}`, page.url, true, page.pay)
        const r = (await this.browser.call('click', { tabId, ref }, 30_000)) as BrowserState & {
          newTabId?: number
          coveredBy?: string
        }
        const note = [
          `${target.role} "${target.name}"을(를) 눌렀어요.`,
          entry
            ? '(결제 화면으로 넘어가는 버튼이라 승인 없이 눌렀어요. 결제 화면에서 최종 금액·취소 규정을 읽고, 그 화면의 마지막 버튼을 누르기 전에 승인을 받아요.)'
            : '',
          r.coveredBy ? `(그 자리를 "${r.coveredBy}"이(가) 덮고 있었어요. 팝업이면 먼저 닫아 주세요.)` : '',
        ]
          .filter(Boolean)
          .join(' ')
        return { note, ...state(r), ...(r.newTabId ? { newTabId: r.newTabId } : {}) }
      }
      case 'type': {
        const ref = String(s.ref ?? '')
        const page = this.pages.get(tabId)
        if (!page?.refs.has(ref)) throw new Error(`${ref}가 무엇인지 몰라요. 먼저 페이지를 읽어 주세요`)
        if (s.submit) this.guard('', page.url, false, page.pay)
        const text = String(s.text ?? '')
        const r = (await this.browser.call('type', {
          tabId,
          ref,
          text,
          submit: Boolean(s.submit),
        })) as BrowserState
        const name = page.refs.get(ref)?.name
        const where = name ? `"${name}"에 ` : ''
        return { note: s.submit ? `${where}입력하고 Enter를 눌렀어요.` : `${where}입력했어요.`, ...state(r) }
      }
      case 'press': {
        const key = String(s.key ?? '')
        const page = this.pages.get(tabId)
        if (/^(enter|return|엔터)$/i.test(key) && page) this.guard('', page.url)
        const r = (await this.browser.call('press', { tabId, key })) as BrowserState
        return { note: `${key} 키를 눌렀어요.`, ...state(r) }
      }
      case 'hover': {
        // 올려 두기만 한다 (누르지 않으니 위험 검사는 없다)
        const ref = String(s.ref ?? '')
        const target = this.pages.get(tabId)?.refs.get(ref)
        if (!target) throw new Error(`${ref}가 무엇인지 몰라요. 먼저 페이지를 읽어 주세요`)
        const r = (await this.browser.call('hover', { tabId, ref })) as BrowserState
        return { note: `${target.role} "${target.name}"에 마우스를 올렸어요.`, ...state(r) }
      }
      case 'scroll': {
        const r = (await this.browser.call('scroll', {
          tabId,
          direction: s.direction === 'up' ? 'up' : 'down',
        })) as BrowserState
        return { note: '스크롤했어요.', ...state(r) }
      }
      case 'wait': {
        const ms = Math.min(Math.max(Number(s.ms) || 1000, 100), 5000)
        await new Promise((r) => setTimeout(r, ms))
        return { note: `${(ms / 1000).toFixed(1)}초 기다렸어요.` }
      }
    }
    throw new Error(`모르는 동작이에요: ${String(s.do)} (click·type·press·hover·scroll·wait)`)
  }

  /**
   * 여러 동작을 한 번에: 정해진 동작만 차례로 하고, 마지막에 페이지를 한 번만 읽는다.
   * 동작마다 페이지 전체를 읽어 돌려주면 느리고 글이 많아서(한 번에 최대 8,000자), 폼 채우기처럼 이어지는 동작을 묶는다.
   * 주소가 바뀌거나·새 탭이 열리거나·확인 창이 뜨거나·막히면 거기서 멈춘다 (남은 동작의 표시는 옛 화면의 것이라)
   */
  private async steps(tabId: number, a: Record<string, unknown>): Promise<ToolResult> {
    const list = (Array.isArray(a.steps) ? a.steps : []).filter(
      (x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object',
    )
    if (!list.length) throw new Error('steps에 할 동작을 넣어 주세요')
    if (list.length > MAX_STEPS) throw new Error(`한 번에 ${MAX_STEPS}개까지만 할 수 있어요`)
    if (!this.pages.get(tabId)) throw new Error('먼저 페이지를 읽어(browser_read) 주세요')
    const lines: string[] = []
    let at = tabId
    let url = this.pages.get(tabId)?.url
    for (const [i, s] of list.entries()) {
      const left = list.length - i - 1
      let r: ActResult
      try {
        r = await this.act(at, s)
      } catch (e) {
        lines.push(`${i + 1}. 멈췄어요: ${(e as Error).message}`)
        if (left) lines.push(`(남은 ${left}개 동작은 하지 않았어요)`)
        // 막힌 까닭(승인 필요 등)이 먼저 보이도록 오류로 돌려준다. 지금 화면도 함께
        const page = await this.read(at, a.maxChars).catch(() => undefined)
        return {
          isError: true,
          content: [{ type: 'text', text: lines.join('\n') }, ...(page?.content ?? [])],
        }
      }
      lines.push(`${i + 1}. ${r.note}`)
      const why = r.newTabId
        ? '새 탭이 열려서'
        : r.dialog
          ? '사이트 확인 창이 떠서'
          : r.url !== undefined && url !== undefined && r.url !== url
            ? '다른 화면으로 넘어가서'
            : undefined
      if (r.newTabId) at = r.newTabId
      if (r.url !== undefined) url = r.url
      if (why && left) {
        lines.push(`(${why} 남은 ${left}개 동작은 하지 않았어요. 아래 새 화면을 보고 이어서 해 주세요)`)
        break
      }
    }
    return this.read(at, a.maxChars, lines.join('\n'))
  }

  /**
   * 이 버튼을 누를지 사용자 승인을 받는다 (AI의 request_approval, 커넥터의 approve 단계).
   * kind를 주면(커넥터 등급이 돈 내기·연락하기) 버튼 글자로 위험이 안 보여도 승인을 받는다
   */
  async askApproval(
    tabId: number,
    ref: string,
    d: {
      what: string
      where: string
      amount?: string
      cancel?: string
      /** 승인하며 고를 칸들의 표시 (결제 수단 라디오 등) */
      choices?: string[]
      choiceTitle?: string
    },
    kind?: RiskKind,
  ): Promise<ToolResult> {
    const page = this.pages.get(tabId)
    const target = page?.refs.get(ref)
    if (!page || !target) throw new Error(`${ref}가 무엇인지 몰라요. 먼저 페이지를 읽어 주세요`)
    // 선택지: 결제 화면에 실제로 있는 고르기 칸만. 그 자체가 결제·확정 버튼이면 안 된다
    const picks: { id: string; label: string; ref: string; role: string; name: string }[] = []
    // AI가 선택지를 안 넘겨도, 결제 화면에 결제 수단 고르기 칸이 둘 이상이면 본체가 승인 카드에 싣는다
    // (실측: AI가 도구 설명을 따르지 않고 네이버페이를 스스로 골랐다)
    const auto = !d.choices?.length && page.checkout ? payOptions(page.refs) : []
    const asked = d.choices?.length ? d.choices : auto.length >= 2 ? auto : []
    for (const cref of asked.slice(0, 8)) {
      const c = page.refs.get(cref)
      if (!c) throw new Error(`선택지 ${cref}가 화면에 없어요. 페이지를 다시 읽어 주세요`)
      if (!['라디오', '버튼', '선택지', '체크박스', '탭', '항목', '링크'].includes(c.role))
        throw new Error(`선택지 ${cref}는 고르는 칸이 아니에요`)
      if (cref === ref || (c.role !== '라디오' && classifyRisk(`${c.role} ${c.name}`, page.url)))
        throw new Error(`선택지 ${cref}("${c.name}")는 결제·확정 버튼이라 선택지로 쓸 수 없어요`)
      picks.push({
        id: `c${picks.length + 1}`,
        label: c.name.slice(0, 40),
        ref: cref,
        role: c.role,
        name: c.name,
      })
    }
    // 승인은 결제 화면에서 받는다: 결제 화면을 여는 버튼에 승인을 받으면, 결제 화면의 진짜 금액·조건을 못 본 채 승인하게 된다
    if (this.entersCheckout(tabId, page, target.name))
      throw new Error(
        `"${target.name}"은(는) 결제 화면으로 넘어가는 버튼이라 승인이 필요 없어요. browser_click으로 눌러 결제 화면까지 간 뒤, ` +
          '그 화면에서 최종 금액·취소 규정을 읽고 마지막 버튼(결제하기·예약 완료 등)에 browser_request_approval을 쓰세요.',
      )
    const risk =
      classifyRisk(`${target.role} ${target.name}`, page.url, page.pay) ??
      (kind ? { kind, reason: '서비스 도구 등급' } : undefined)
    if (!risk) throw new Error('이 버튼은 승인 없이 눌러도 돼요. browser_click을 쓰세요.')
    if (this.finalStep() === 'self')
      throw new Error(
        '사용자가 "마지막 버튼은 항상 직접 누르기"로 정해 두었어요. 내용을 정리해 알려 주고 browser_handoff로 넘겨 주세요.',
      )
    // 한 탭에서 누를 마지막 버튼은 하나다: 같은 탭에 기다리는 승인이 있으면 새 것으로 바꾼다
    // (실측: AI가 다시 읽고 같은 버튼에 한 번 더 요청해 카드가 두 장 떴고, 앞 카드는 표시 번호가 바뀌어 누를 수 없었다)
    this.approvals.expireTab(tabId)
    // 승인 카드에 실제 화면을 함께 보여 준다 (AI가 적은 금액이 틀려도 사용자가 알아챌 수 있게)
    const shot = (await this.browser.call('screenshot', { tabId }).catch(() => undefined)) as
      | { data?: string }
      | undefined
    // 기본 선택: 이 사이트에서 마지막으로 고른 것, 없으면 첫째
    let host = ''
    try {
      host = new URL(page.url).hostname
    } catch {}
    const last = this.lastChoice.get(host)
    const preferred =
      picks.find((p) => last && (p.name === last || p.name.includes(last))) ??
      picks.find((p) => page.selected?.has(p.ref)) ??
      picks[0]
    const rec = this.approvals.create({
      tabId,
      ref,
      role: target.role,
      label: target.name,
      url: page.url,
      kind: risk.kind,
      reason: risk.reason,
      what: d.what.slice(0, 200),
      where: d.where.slice(0, 100),
      ...(d.amount ? { amount: d.amount.slice(0, 60) } : {}),
      ...(d.cancel ? { cancel: d.cancel.slice(0, 200) } : {}),
      ...(shot?.data ? { shot: shot.data } : {}),
      ...(picks.length
        ? {
            choices: picks.map(({ id, label }) => ({ id, label })),
            choiceTitle: d.choiceTitle ?? '결제 수단',
            ...(preferred ? { choice: preferred.id } : {}),
            choiceRefs: Object.fromEntries(
              picks.map((p) => [p.id, { ref: p.ref, role: p.role, name: p.name }]),
            ),
          }
        : {}),
    })
    return {
      content: [
        {
          type: 'text',
          text:
            `승인을 요청했어요(${rec.id.slice(0, 8)}). 사용자에게 무엇을 승인해 달라는지 한두 문장으로 말하고 이번 답은 여기서 끝내세요. ` +
            '사용자가 승인하면 두리가 그 버튼을 직접 누르고, 다음 메시지로 결과를 알려 줘요. 그때 페이지를 다시 읽어 확인하세요.',
        },
      ],
    }
  }

  /** 사이트 확인 창의 [확인]을 누를지 승인을 받는다 (창이 떠 있는 동안 페이지가 멈춰 있어 화면 캡처는 없다) */
  private askDialogApproval(
    tabId: number,
    d: { what: string; where: string; amount?: string; cancel?: string },
  ): ToolResult {
    const dlg = this.dialogs.get(tabId)
    if (!dlg) throw new Error('떠 있는 사이트 확인 창이 없어요. 페이지를 다시 읽어 확인해 주세요')
    const risk = classifyDialogRisk(dlg.message, dlg.url)
    if (!risk) throw new Error('이 확인 창은 승인 없이 골라도 돼요. browser_dialog를 쓰세요.')
    if (this.finalStep() === 'self')
      throw new Error(
        '사용자가 "마지막 버튼은 항상 직접 누르기"로 정해 두었어요. 내용을 정리해 알려 주고 browser_handoff로 넘겨 주세요.',
      )
    const rec = this.approvals.create({
      tabId,
      ref: 'dialog',
      role: '확인 창',
      label: `확인 — ${dlg.message.slice(0, 150)}`,
      url: dlg.url,
      kind: risk.kind,
      reason: risk.reason,
      what: d.what.slice(0, 200),
      where: d.where.slice(0, 100),
      ...(d.amount ? { amount: d.amount.slice(0, 60) } : {}),
      ...(d.cancel ? { cancel: d.cancel.slice(0, 200) } : {}),
    })
    this.dialogApprovals.set(rec.id, dlg.message)
    return {
      content: [
        {
          type: 'text',
          text:
            `승인을 요청했어요(${rec.id.slice(0, 8)}). 사용자에게 무엇을 승인해 달라는지 한두 문장으로 말하고 이번 답은 여기서 끝내세요. ` +
            '사용자가 승인하면 두리가 확인 창의 [확인]을 직접 누르고, 다음 메시지로 결과를 알려 줘요. 그때 페이지를 다시 읽어 확인하세요.',
        },
      ],
    }
  }

  /** 화면 글자로 누를 곳에 표시를 붙인다 (먼저 읽은 페이지여야 한다). 붙인 표시와 그 글 */
  async markText(tabId: number, text: string): Promise<{ ref: string; name: string }> {
    const page = this.pages.get(tabId)
    if (!page) throw new Error('먼저 페이지를 읽어(browser_read) 주세요')
    const m = (await this.browser.call('mark-text', { tabId, text }, 15_000)) as { ref: string; name: string }
    page.refs.set(m.ref, { role: '글', name: m.name })
    return m
  }

  /** 마지막으로 읽은 탭의 표시 목록 (커넥터가 입력칸을 찾을 때) */
  refsOf(tabId: number): Map<string, { role: string; name: string }> | undefined {
    return this.pages.get(tabId)?.refs
  }

  /** 이 탭을 지금 폰 원격 화면으로 다뤄도 되는지: 두리가 사람에게 넘긴 지 30분 안 */
  /** 사람이 직접 할 탭으로 표시 (서비스 연결에서 연 탭을 폰 원격 화면으로 로그인할 때) */
  allowRemote(tabId: number) {
    this.handedOff.set(tabId, Date.now())
  }

  remoteAllowed(tabId: number, now = Date.now()): boolean {
    const at = this.handedOff.get(tabId)
    if (at === undefined) return false
    if (now - at > REMOTE_TTL_MS) {
      this.handedOff.delete(tabId)
      return false
    }
    return true
  }

  /** 원격 화면 한 장 (폰으로 보낼 크기로 줄여서) */
  async remoteScreen(tabId: number, fit?: { width: number; height: number }) {
    if (!this.remoteAllowed(tabId))
      throw new Error('이 탭은 원격 화면으로 볼 수 없어요 (두리가 넘긴 탭만, 30분 동안)')
    // 실시간 화면용: 폰 화면에 맞는 크기·화질로 빠르게 (초당 여러 장). 화면의 입력칸·버튼·지금 칸도 같이 (remote).
    // fit을 주면 PC 탭을 폰 화면 크기로 그리게 한다 (폰 너비 그리기는 원격 입력 view로도)
    const args = fit
      ? { tabId, fit, maxWidth: Math.min(fit.width * 2, 1000), quality: 55, remote: true }
      : { tabId, maxWidth: 780, quality: 55, remote: true }
    return (await this.browser.call('screenshot', args)) as {
      url: string
      title: string
      data: string
      viewport: { width: number; height: number }
    } & RemoteInfo
  }

  /** 원격 화면 '필요한 칸만': 사람이 채울 칸·고를 것·버튼 (두리가 넘긴 탭만) */
  async remoteForm(tabId: number): Promise<RemoteForm> {
    if (!this.remoteAllowed(tabId))
      throw new Error('이 탭은 원격 화면으로 볼 수 없어요 (두리가 넘긴 탭만, 30분 동안)')
    return (await this.browser.call('form', { tabId }, 20_000)) as RemoteForm
  }

  /** 칸만 화면에서 채운 값을 넣고 버튼을 누른다. 값은 AI에게 가지 않고 페이지 칸에만 들어간다 */
  async remoteFill(tabId: number, values: RemoteFormValue[], press?: string) {
    if (!this.remoteAllowed(tabId))
      throw new Error('이 탭은 원격으로 다룰 수 없어요 (두리가 넘긴 탭만, 30분 동안)')
    const id = (x: unknown) => String(x ?? '').slice(0, 24)
    const clean = (Array.isArray(values) ? values : []).slice(0, 30).map((v) => ({
      id: id(v.id),
      ...(typeof v.value === 'string' ? { value: v.value.slice(0, 200) } : {}),
      ...(typeof v.checked === 'boolean' ? { checked: v.checked } : {}),
      ...(typeof v.pick === 'string' ? { pick: id(v.pick) } : {}),
    }))
    return this.browser.call(
      'form-fill',
      { tabId, values: clean, ...(press ? { press: id(press) } : {}) },
      30_000,
    )
  }

  /** 원격 화면에서 사람이 한 입력. 좌표는 사진 비율(0~1)로 받아 페이지 좌표로 바꾼다 */
  async remoteInput(
    tabId: number,
    input: {
      action: 'tap' | 'text' | 'key' | 'scroll' | 'view' | 'leave'
      x?: number
      y?: number
      text?: string
      key?: string
      dy?: number
      w?: number
      h?: number
    },
    viewport: { width: number; height: number },
  ) {
    if (!this.remoteAllowed(tabId))
      throw new Error('이 탭은 원격으로 다룰 수 없어요 (두리가 넘긴 탭만, 30분 동안)')
    const args: Record<string, unknown> = { tabId, action: input.action }
    if (input.action === 'tap') {
      const fx = Number(input.x)
      const fy = Number(input.y)
      if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) throw new Error('누른 자리가 화면 밖이에요')
      args.x = fx * viewport.width
      args.y = fy * viewport.height
    }
    if (input.action === 'text') args.text = String(input.text ?? '').slice(0, 500)
    if (input.action === 'key') args.key = String(input.key ?? '')
    if (input.action === 'scroll') {
      const dy = Number(input.dy) || 0
      // ±1은 한 화면씩, 그보다 크면 손가락으로 끈 페이지 픽셀 (끈 자리에서 굴린다)
      args.dy = Math.abs(dy) <= 1 ? (dy < 0 ? -1 : 1) : Math.max(-3000, Math.min(3000, dy))
      const fx = Number(input.x)
      const fy = Number(input.y)
      if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) {
        args.x = fx * viewport.width
        args.y = fy * viewport.height
      }
    }
    if (input.action === 'view') {
      args.w = Number(input.w) || 390
      args.h = Number(input.h) || 700
    }
    return this.browser.call('input', args)
  }

  /** 위험한 동작이면 멈추고 이유를 돌려준다 */
  private guard(label: string, url: string, clickable = false, pay?: string) {
    const risk = classifyRisk(label, url, pay)
    if (!risk) return
    const next =
      clickable && this.finalStep() === 'approve'
        ? 'browser_request_approval로 무엇을·어디서·얼마인지·취소 조건을 적어 사용자 승인을 요청해 주세요. 승인되면 두리가 직접 눌러요.'
        : '여기까지 한 내용(무엇을, 어디서, 얼마인지)을 사용자에게 정리해 알려 주고, browser_handoff로 마지막 버튼은 사용자가 직접 누르게 넘겨 주세요.'
    throw new Error(`멈췄어요: ${risk.reason} — ${RISK_TEXT[risk.kind]}이라 승인 없이는 하지 않아요. ${next}`)
  }

  /**
   * 사용자가 승인한 버튼을 누른다. 누르기 직전 페이지를 다시 읽어, 승인한 버튼 글자와 주소가 그대로일 때만.
   * 화면용 토큰을 가진 쪽(사용자 화면)만 부를 수 있다 (AI의 도구 토큰으로는 못 부른다)
   */
  async approve(id: string, choice?: string): Promise<{ ok: boolean; message: string }> {
    const rec: ApprovalRecord | undefined = this.approvals.take(id)
    if (!rec) return { ok: false, message: '이미 처리했거나 시간이 지난 승인 요청이에요' }
    const dialogText = this.dialogApprovals.get(id)
    if (dialogText !== undefined) {
      this.dialogApprovals.delete(id)
      try {
        // 확장이 지금 떠 있는 창이 승인한 그 창일 때만 누른다
        const r = (await this.browser.call('dialog', {
          tabId: rec.tabId,
          accept: true,
          expect: dialogText,
        })) as {
          url?: string
          title?: string
        }
        this.dialogs.delete(rec.tabId)
        const msg = `확인 창 "${dialogText.slice(0, 80)}"에서 [확인]을 눌렀어요. 지금 화면: ${r.title ?? ''} (${r.url ?? ''})`
        this.approvals.finish(id, true, msg)
        return { ok: true, message: msg }
      } catch (e) {
        const msg = `확인 창의 [확인]을 누르지 못했어요: ${(e as Error).message}`
        this.approvals.finish(id, false, msg)
        return { ok: false, message: msg }
      }
    }
    try {
      const s = (await this.browser.call('snapshot', { tabId: rec.tabId, maxChars: 40_000 })) as Snapshot
      let now = parseRefs(s.text).get(rec.ref)
      this.pages.set(rec.tabId, pageInfo(s.url, s.text))
      // 글자로 찾은 곳(서비스 도구의 마지막 버튼)은 표시 목록에 없다: 같은 글자로 다시 찾아 같은 곳인지 본다
      if (rec.role === '글' && s.url === rec.url) {
        const m = (await this.browser
          .call('mark-text', { tabId: rec.tabId, text: rec.label }, 15_000)
          .catch(() => undefined)) as { ref: string; name: string } | undefined
        if (m?.ref === rec.ref) now = { role: '글', name: m.name }
      }
      if (s.url !== rec.url || !now || now.name !== rec.label || now.role !== rec.role) {
        const msg = `승인한 뒤 화면이 바뀌어서 "${rec.label}" 버튼을 누르지 않았어요. 페이지를 다시 확인해 주세요.`
        this.approvals.finish(id, false, msg)
        return { ok: false, message: msg }
      }
      // 고른 결제 수단(선택지)을 먼저 누른다. 그 뒤 화면을 다시 읽어 마지막 버튼이 같은지 본다
      let base = s
      let finalRef = rec.ref
      let finalName = rec.label
      let chosen: string | undefined
      if (choice && rec.choiceRefs) {
        const c = rec.choiceRefs[choice]
        const fail = (why: string) => {
          const msg = `${why} 결제는 하지 않았어요. 페이지를 다시 읽고 승인을 다시 받아 주세요.`
          this.approvals.finish(id, false, msg)
          return { ok: false, message: msg }
        }
        if (!c) return fail('고른 결제 수단을 찾을 수 없어요.')
        const at = sameControl(parseRefs(s.text), c.ref, c.role, c.name)
        if (!at) return fail(`"${c.name}" 칸이 화면에서 바뀌었어요.`)
        await this.browser.call('click', { tabId: rec.tabId, ref: at }, 30_000)
        base = (await this.browser.call('snapshot', { tabId: rec.tabId, maxChars: 40_000 })) as Snapshot
        this.pages.set(rec.tabId, pageInfo(base.url, base.text))
        if (base.url !== rec.url) return fail(`"${c.name}"을(를) 고르자 다른 화면으로 넘어갔어요.`)
        const refs = parseRefs(base.text)
        const next =
          sameControl(refs, rec.ref, rec.role, rec.label) ??
          [...refs].find(([, v]) => v.role === rec.role && sameFinal(v.name, rec.label))?.[0]
        if (!next) return fail(`"${c.name}"을(를) 고르자 마지막 버튼("${rec.label}")이 바뀌었어요.`)
        finalRef = next
        finalName = refs.get(next)?.name ?? rec.label
        chosen = c.name
      }
      let r = (await this.browser.call('click', { tabId: rec.tabId, ref: finalRef }, 30_000)) as {
        url?: string
        title?: string
        dialog?: SiteDialog
        newTabId?: number
        coveredBy?: string
      }
      // 승인한 버튼을 누르자 사이트가 "정말 하시겠어요?"를 물으면, 사용자가 승인한 그 일이니 [확인]을 누른다
      let also = ''
      if (r.dialog?.type === 'confirm') {
        const asked = r.dialog.message
        r = (await this.browser.call('dialog', { tabId: rec.tabId, accept: true, expect: asked })) as typeof r
        also = ` 사이트가 확인 창("${asked.slice(0, 80)}")을 띄워 [확인]도 눌렀어요.`
      }
      // 눌렀는데 아무 일도 안 일어났으면 '눌렀어요'라고 하지 않는다 (실측: 쿠키 창 막이 덮어 클릭이 먹지 않았는데
      // '눌렀어요'로 알려, AI가 원인을 '로그인'으로 짐작했다). 새 창·확인 창·주소·화면 글 중 하나라도 바뀌면 먹은 것이다
      if (!also && !r.dialog && !r.newTabId && (r.url ?? base.url) === base.url) {
        const after = (await this.browser
          .call('snapshot', { tabId: rec.tabId, maxChars: 40_000 })
          .catch(() => undefined)) as Snapshot | undefined
        if (after && after.url === base.url && after.text === base.text) {
          this.pages.set(rec.tabId, pageInfo(after.url, after.text))
          const msg =
            `"${rec.label}" 버튼을 눌렀는데 화면이 그대로예요` +
            (r.coveredBy ? ` ("${r.coveredBy}"이(가) 그 자리를 덮고 있었어요)` : '') +
            '. 결제 창도 새 화면도 뜨지 않았어요. 페이지를 읽어 무엇이 막는지(덮은 창·빈 필수 칸·안내 문구) 확인하고, 고친 뒤 다시 승인을 받아 주세요.'
          this.approvals.finish(id, false, msg)
          return { ok: false, message: msg }
        }
      }
      if (chosen) this.rememberChoice(rec.url, chosen)
      const msg = `${chosen ? `결제 수단 "${chosen}"을(를) 고르고 ` : ''}"${finalName}" 버튼을 눌렀어요.${also} 지금 화면: ${r.title ?? ''} (${r.url ?? ''})`
      this.approvals.finish(id, true, msg)
      return { ok: true, message: msg }
    } catch (e) {
      const msg = `"${rec.label}" 버튼을 누르지 못했어요: ${(e as Error).message}`
      this.approvals.finish(id, false, msg)
      return { ok: false, message: msg }
    }
  }

  /**
   * 돈 내기 서비스 도구가 이 탭을 AI에게 넘겼다: 여기서부터 결제 흐름이다.
   * 이 탭에서는 결제 화면 전의 [예약하기]·[구매하기]를 승인 없이 누르고, 승인은 결제 화면에서만 받는다
   */
  startPayFlow(tabId: number, tool: string, sites: string[] = [], now = Date.now()) {
    this.payFlows.set(tabId, { tool, at: now })
    for (const site of sites) if (site) this.paySites.set(site.toLowerCase(), { tool, at: now })
  }

  /** 결제 흐름 탭(또는 결제 흐름 사이트를 연 탭)이면 그 도구 이름 (한 시간이 지나면 잊는다) */
  payFlow(tabId: number, now = Date.now()): string | undefined {
    const f = this.payFlows.get(tabId)
    if (f && now - f.at <= PAY_FLOW_TTL_MS) return f.tool
    if (f) this.payFlows.delete(tabId)
    let host = ''
    try {
      host = new URL(this.pages.get(tabId)?.url ?? '').hostname.toLowerCase()
    } catch {}
    if (!host) return undefined
    for (const [site, s] of this.paySites) {
      if (now - s.at > PAY_FLOW_TTL_MS) {
        this.paySites.delete(site)
        continue
      }
      if (host === site || host.endsWith(`.${site}`)) return s.tool
    }
    for (const site of this.payServiceSites)
      if (host === site || host.endsWith(`.${site}`)) return `site:${site}`
    return undefined
  }

  /** 결제 흐름 탭에서, 아직 결제 화면이 아닌 곳의 결제 화면 들어가기 버튼인지 */
  private entersCheckout(tabId: number, page: PageInfo, name: string): boolean {
    return this.payFlow(tabId) !== undefined && !page.checkout && isCheckoutEntry(name)
  }

  /** 탭이 닫혔다 (사용자·탭 정리): 그 탭의 기록을 지우고, 기다리던 승인은 만료시킨다 */
  forgetTab(tabId: number) {
    this.pages.delete(tabId)
    this.guided.delete(tabId)
    this.handedOff.delete(tabId)
    this.dialogs.delete(tabId)
    this.payFlows.delete(tabId)
    for (const k of this.cookieTried) if (k.startsWith(`${tabId}|`)) this.cookieTried.delete(k)
    this.approvals.expireTab(tabId)
    if (this._lastTabId === tabId) this._lastTabId = undefined
  }

  /** 처음 들어온 사이트에 서비스 도구가 있으면 그걸 쓰라고 알린다 (화면을 하나씩 누르기보다 빠르고 정확하다) */
  private async guideFor(tabId: number, url: string): Promise<string | undefined> {
    const svc = await this.siteConnector?.(url).catch(() => undefined)
    if (svc) {
      if (this.guided.get(tabId) === svc.id) return undefined
      this.guided.set(tabId, svc.id)
      return `📘 이 사이트(${svc.name})는 두리 서비스 도구가 있어요: ${svc.tools.join(', ')}. 화면을 하나씩 누르기보다 이 도구를 먼저 쓰세요(바로 보이는 도구 목록에 없으면 service_call). 도구로 안 되는 일만 브라우저로 이어서 해요.`
    }
    return undefined
  }

  private async read(
    tabId: number,
    maxChars?: unknown,
    note?: string,
    scope: { view?: boolean; from?: string; skip?: number } = {},
  ): Promise<ToolResult> {
    const max = Number(maxChars) || 8_000
    const partial = Boolean(scope.view || scope.from || scope.skip)
    let s = (await this.browser.call('snapshot', { tabId, maxChars: max, ...scope })) as Snapshot
    const notes = [...(s.dialogNotes ?? [])]
    // 늦게 그리는 사이트는 막 연 화면이 비어 있다 (캐치테이블: 링크 4개뿐). 한 번 기다렸다 다시 읽는다
    if (!s.dialog && !partial && nearlyEmpty(s.text)) {
      await new Promise((r) => setTimeout(r, 1500))
      s = (await this.browser.call('snapshot', { tabId, maxChars: max })) as Snapshot
      notes.push(...(s.dialogNotes ?? []))
    }
    // 쿠키 동의 창은 거부(없으면 필수만)로 닫고 다시 읽는다. 탭·사이트마다 한 번만, 한 일은 읽기 결과에 적는다
    let cookieNote: string | undefined
    const reject = !s.dialog ? cookieReject(s.text) : undefined
    if (reject) {
      let host = ''
      try {
        host = new URL(s.url).hostname
      } catch {}
      const key = `${tabId}|${host}`
      if (!this.cookieTried.has(key)) {
        this.cookieTried.add(key)
        const name = parseRefs(s.text).get(reject)?.name ?? '거부'
        const ok = await this.browser
          .call('click', { tabId, ref: reject }, 15_000)
          .then(() => true)
          .catch(() => false)
        if (ok) {
          s = (await this.browser.call('snapshot', { tabId, maxChars: max, ...scope })) as Snapshot
          notes.push(...(s.dialogNotes ?? []))
          cookieNote = `🍪 쿠키 동의 창이 화면을 덮고 있어서 [${name}]로 닫았어요.`
        }
      }
    }
    if (s.dialog) {
      // 확인 창이 떠 있는 동안 페이지는 멈춰 있다: 창만 알리고, 전에 읽은 표시는 그대로 둔다
      this.dialogs.set(tabId, s.dialog)
      return {
        content: [
          {
            type: 'text',
            text: [
              ...(note ? [note] : []),
              `[탭 ${tabId}] ${s.title || '(제목 없음)'} — ${s.url}`,
              ...dialogLines(notes),
              ...openDialogLines(s.dialog),
            ].join('\n'),
          },
        ],
      }
    }
    this.dialogs.delete(tabId)
    const info = pageInfo(s.url, s.text)
    this.pages.set(tabId, info)
    const guide = await this.guideFor(tabId, s.url)
    const flow = this.payFlow(tabId)
    const lines = [
      ...(note ? [note] : []),
      `[탭 ${tabId}] ${s.title || '(제목 없음)'} — ${s.url}`,
      ...(cookieNote ? [cookieNote] : []),
      ...(flow && info.confirmed
        ? [
            `⚠ 화면에 "${info.confirmed}"이(가) 보여요. 예약·주문이 이미 확정됐을 수 있어요. 사용자에게 그대로 알리고 내역 화면에서 확인해 주세요.`,
          ]
        : flow && info.checkout
          ? [
              `💳 결제 화면이에요('${info.checkout}'). 최종 금액·취소 규정·예약자 정보를 읽고, 마지막 버튼은 browser_request_approval로 승인받아요. 카드 번호·결제 비밀번호처럼 사람만 넣을 수 있는 칸만 browser_handoff로 넘겨요.`,
            ]
          : []),
      ...(s.captcha
        ? [
            '⚠ 로봇 확인(캡차·자동입력 방지) 화면이 보여요. 풀려고 하지 말고 사용자에게 직접 해 달라고 부탁해 주세요.',
          ]
        : []),
      ...(guide ? [guide] : []),
      ...dialogLines(notes),
      ...scopeLines(s, scope),
      ...(!partial && nearlyEmpty(s.text)
        ? [
            '⚠ 화면에 글이 거의 없어요. 주소가 틀렸을 수 있어요(사이트에 없는 주소는 빈 화면만 나와요). 사이트 홈을 열어 검색칸으로 찾아보세요. 사람에게 넘기기 전에 다른 길을 먼저 해 보세요.',
          ]
        : []),
      '',
      s.text || '(읽을 글이 없어요. 화면이 아직 그려지는 중이면 잠시 뒤 다시 읽어 주세요)',
      ...(s.around?.below
        ? [
            '',
            `↓ 화면 아래에 글이 ${s.around.below.toLocaleString()}자쯤 더 있어요. browser_scroll로 내린 뒤 view로 다시 읽어 주세요.`,
          ]
        : []),
      ...(s.truncated
        ? [
            '',
            `(글이 길어 여기까지 ${max}자만 보여 드렸어요. 이어서 보려면 skip: ${(s.skipped ?? 0) + s.text.length}로 다시 읽고, 찾는 부분이 있으면 from에 그 글자를 넣어 그 줄부터 읽어 주세요)`,
          ]
        : []),
    ]
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }
}

/** 어디를 읽었는지 알리는 줄 (view·from·skip) */
export function scopeLines(
  s: { around?: { above: number; below: number }; skipped?: number; fromMissing?: boolean },
  scope: { view?: boolean; from?: string; skip?: number },
): string[] {
  const out: string[] = []
  if (scope.view)
    out.push(
      `(지금 화면에 보이는 부분만 읽었어요${s.around?.above ? `. ↑ 위에 글 ${s.around.above.toLocaleString()}자쯤` : ''})`,
    )
  if (scope.from && s.fromMissing) out.push(`("${scope.from}"을(를) 페이지에서 찾지 못해 처음부터 읽었어요)`)
  else if (s.skipped) out.push(`(앞 ${s.skipped.toLocaleString()}자는 건너뛰고 읽었어요)`)
  return out
}

/** 두리가 바로 닫은 알림창을 AI에게 알리는 줄 (사이트가 알림창으로만 알려 주는 말: "비밀번호가 틀렸어요" 등) */
export function dialogLines(notes: SiteDialog[]): string[] {
  return notes.map((d) =>
    d.type === 'beforeunload'
      ? '💬 페이지를 떠날지 묻는 창이 떠서 [떠나기]를 눌렀어요.'
      : `💬 사이트 알림창: "${d.message.slice(0, 300)}" ([확인]을 눌러 닫았어요)`,
  )
}

/** 떠 있는 확인 창을 AI에게 알리는 줄 */
export function openDialogLines(d: SiteDialog): string[] {
  const ask =
    d.type === 'prompt'
      ? `browser_dialog로 넣을 글(text)과 함께 [확인](accept: true)하거나 [취소](accept: false)해 주세요.${d.defaultPrompt ? ` (미리 적힌 글: "${d.defaultPrompt.slice(0, 100)}")` : ''}`
      : 'browser_dialog로 [확인](accept: true)이나 [취소](accept: false)를 골라 주세요.'
  return [
    '',
    `⚠ 사이트 확인 창이 떠 있어요: "${d.message.slice(0, 500)}"`,
    `고를 때까지 페이지가 멈춰 있어서 읽거나 누를 수 없어요. ${ask} 사용자의 부탁과 맞지 않는 쪽이면 [취소]하세요.`,
  ]
}

/** 표시(e12)를 빼고 글이 거의 없는 화면 (늦게 그리는 중이거나 없는 주소) */
export function nearlyEmpty(text: string): boolean {
  const words = text.replace(/\[e\d+ [^\]]*\]/g, '').replace(/\s+/g, '')
  return words.length < 8
}
