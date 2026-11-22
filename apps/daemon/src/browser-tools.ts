// 두리 브라우저 도구의 본체 쪽 실행기. AI(MCP 도구 서버)는 여기로 부탁만 하고, 해도 되는지는 여기서 정한다.
// 확장은 판단하지 않는 손이라서, 위험한 클릭을 막는 것도 여기서 한다 (docs/architecture.md 4.2, 위협 모델 T2·T3).
//
// 판단은 AI가 하고, 여기 규칙은 안전장치만 둔다 (11-20 사용자 결정):
// ① 실제로 돈이 나가는(보내는·지우는) 마지막 버튼은 매번 한 번 승인 — AI가 마지막이라고 선언한 버튼(browser_checkout·
//    request_approval·click의 final)과 버튼 글자에 돈·보내기·지우기 말이 있는 버튼만 막고, 결제 카드·승인 카드로 돌린다.
//    사용자가 승인하면 본체가 그 버튼 하나만 누른다(approvals.ts). 승인 한 번 = 버튼 한 번.
// ② 한 사이트 계정을 다른 사이트에 넣지 않는다 ③ 금고 값은 AI에게 가지 않는다.
// 결제 버튼을 누른 뒤에는 결제 묶음(결제 회사 창·새 탭)으로 주문 완료(browser_order_done)까지 이어 간다.

import { randomInt } from 'node:crypto'
import type {
  ApprovalView,
  BrowserCommand,
  CheckoutGood,
  RemoteForm,
  RemoteFormValue,
  RemoteInfo,
} from '@dool2/protocol'
import {
  PAY_KINDS,
  type PayMethod,
  payMethodLabel,
  payMethodMatches,
  pickPayMethod,
} from '@dool2/protocol/pay-methods'
import { APPROVAL_TTL_MS, type ApprovalRecord, Approvals, MONEY_APPROVAL_TTL_MS } from './approvals.js'
import type { UploadFile } from './files.js'
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
import { notAccepted, sendFiles, sizeText, type UploadReply } from './upload.js'

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
/** 결제 키패드 숫자 하나: 누를 버튼 표시(ref) 또는 화면 자리(그림 키패드) */
export type PinKey = string | { x: number; y: number }
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
  'request_code',
  'request_tap',
  'wait_auth',
  'new_password',
  'select',
  'request_approval',
  'checkout',
  'dialog',
  'steps',
  'hover',
  'order_done',
  'wait',
  'tabs',
  'upload',
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
    // 사람에게 보내기·개인정보를 넘기는 신청·제출만 승인 (11-20 사용자: 리뷰·글 올리기처럼 맡긴 일은 승인 없이)
    'contact',
    /보내기|전송|발송|문의\s*(?:하기|등록)|신청\s*(?:하기|완료)|(?:^|\s)(?:답변\s*)?제출(?:\s*하기|\s*완료)?$|응모\s*(?:하기|완료)|(?:^|\s)응모$|\b(?:send|submit)\b/i,
  ],
  ['irreversible', /삭제|탈퇴|해지|비우기|초기화|\b(?:delete|remove\s*account|unsubscribe)\b/i],
]

// 결제 단계 주소 (판단 힌트로만 쓴다: 결제 카드에 결제 수단을 싣거나 안내 한 줄을 붙일 때. 버튼을 막지 않는다)
// (실측 11-20 G마켓: 주소로 버튼을 넓게 막자 주문서의 배송지 추가·주소 찾기 Enter·결제 회사 창의 [다음]까지 막혀 여섯 번 멈췄다)
const PAY_URL =
  /\/(?:checkout|payment|payments|pay|order\/?(?:sheet|form|confirm)|orderform|ordersheet)(?:[/?#.]|$)|(?:^|\.)(?:pay\.naver\.com|kakaopay\.com|tosspayments\.com|toss\.im|inicis\.com|nicepay\.co\.kr|kcp\.co\.kr|danal\.co\.kr|payco\.com|paypal\.com)/i

// 결제 화면 표시 묶음. 상품·상세 화면에도 '결제 방법' 안내나 '결제 정보' 접힘 버튼은 흔해서(실측: 11번가·지마켓·
// 무신사·제주항공·트립닷컴), 서로 다른 묶음이 두 가지 이상 함께 보여야 결제 화면으로 본다. 버튼 이름 속 글은 세지 않는다.
// 이것도 힌트일 뿐이다: 결제 카드를 띄울지·버튼을 누를지는 AI가 화면을 보고 정한다
const CHECKOUT_MARKS: [string, RegExp][] = [
  ['결제 수단', /결제\s*(?:수단|방법|방식)|카드\s*번호|간편\s*결제\s*(?:선택|수단)/],
  [
    '예약자 정보',
    /(?:예약자|주문자|구매자|투숙객|탑승객|예매자|신청자|이용자)\s*정보|체크인\s*고객\s*정보|받는\s*(?:분|사람)\s*정보|배송지\s*(?:정보|입력|선택|변경)/,
  ],
  ['결제 금액', /(?:총|최종)\s*(?:결제\s*)?금액|결제\s*(?:예정\s*)?금액|결제\s*요금/],
  ['약관 동의', /(?:약관|결제\s*진행|구매\s*조건|개인정보\s*(?:제3자\s*)?제공)[^\n]{0,12}동의/],
]

/** 결제 화면(결제 수단·예약자 정보를 넣는 화면)으로 보이면 그 표시 말 (힌트). 주소가 결제 단계여도 결제 화면이다 */
export function checkoutScreen(text: string, url: string): string | undefined {
  try {
    const u = new URL(url)
    if (PAY_URL.test(u.pathname) || PAY_URL.test(u.hostname)) return '결제 단계 주소'
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

// 예약·주문이 확정된 화면으로 보이는 말 (힌트: 결제 중이면 주문번호를 읽어 browser_order_done으로 끝내라고 알린다)
const CONFIRMED =
  /(?:예약|주문|결제|구매|예매|신청)(?:이|가)?\s*(?:완료|확정)\s*(?:되었|됐|했|하였)|(?:예약|주문|예매)\s*번호\s*[:：]?\s*[A-Z0-9-]{5,}/

/** 결제 확정 화면이면 그 말 */
export function confirmedScreen(text: string): string | undefined {
  return CONFIRMED.exec(text)?.[0]
}

/** 결제 흐름(돈 내기 서비스 도구가 AI에게 넘긴 탭)을 기억하는 시간 */
export const PAY_FLOW_TTL_MS = 60 * 60_000

/**
 * 결제 묶음(승인한 결제 버튼을 누른 뒤 주문 완료까지)을 기억하는 시간: 결제 승인 카드와 같게 1시간.
 * 탭 잡아 두기·배송지 바꾼 뒤 한 번 누르기도 같은 시간 (예전엔 승인 60분·결제 중 15분·탭 10분으로 제각각이라 중간에 풀렸다)
 */
export const PAY_SESSION_TTL_MS = MONEY_APPROVAL_TTL_MS

/**
 * 버튼 글자로 보는 위험 (돈·연락·되돌릴 수 없음). 규칙은 이것 하나뿐이다: 주소·화면으로 넓게 막지 않는다.
 * 그 밖의 마지막 버튼은 AI가 선언한다(browser_checkout·browser_request_approval·click의 final)
 */
export function classifyRisk(label: string): Risk | undefined {
  // 라디오·체크박스는 고르기만 하고 확정하지 않는다 ('예약금 결제' 방식 라디오에 승인을 따로 받던 것)
  if (/^(?:라디오|체크박스|스위치|선택지)\s/.test(label)) return undefined
  // 지난 일을 보는 말(주문 상세·결제 내역·예약 조회)은 빼고 남은 글자로 본다 ("주문내역에서 다시 주문하기"는 그대로 막힌다)
  const acting = label.replace(LOOKUP, ' ').replace(CART_ADD, ' ')
  for (const [kind, re] of RISK_WORDS) {
    const m = re.exec(acting)
    if (m) return { kind, reason: `"${m[0]}"` }
  }
  return undefined
}

// 그 자체로 지금 돈이 나가는 버튼 이름: 결제 화면으로 '넘어가기만' 하는 버튼(opens_checkout)일 수 없다 (안전장치)
const PAY_NOW =
  /결제\s*하기|(?:^|\s)결제$|(?:바로|간편|최종)\s*결제|\S(?:으로|로)\s*결제|결제\s*(?:완료|진행|요청)|구매\s*확정|주문\s*(?:완료|확정)|예약\s*(?:확정|완료)|송금|이체|\b(?:pay\s*now|place\s*(?:my\s*)?order|complete\s*(?:purchase|order|booking)|confirm\s*(?:and\s*)?pay)\b/i

/** 지금 돈이 나가는 이름인지 (opens_checkout으로 넘길 수 없는 버튼) */
export function payNow(name: string): boolean {
  return PAY_NOW.test(name.replace(/\s+/g, ' ').trim())
}

// 지난 주문·결제·예약을 보는 말: 돈이 나가거나 보내지 않는다
const LOOKUP =
  /(?:주문|구매|결제|예약|예매|구독|충전|송금|이체|입금|후원|기부)\s*(?:상세(?:\s*정보)?|내역|목록|조회|이력|정보|번호|일자|일시|현황|관리|상태)|(?:주문|구매|결제|예약)한\s*(?:상품|내역)/g

// 장바구니·주문표에 담기: 돈이 나가지 않는다 (실측 요기요 '주문표에 추가'를 결제로 보고 승인을 받았다)
const CART_ADD =
  /(?:주문표|장바구니|카트|쇼핑백|담은\s*목록)\s*(?:에|으로)?\s*(?:추가|담기|넣기|담아)|(?:^|\s)담기(?:\s|$)/g

/** 화면 안 액자(결제 회사 창 등)의 표시인지: 확장이 액자 속 칸에 큰 번호(e10001~)나 액자 id(f3:e12)를 붙인다 */
export function frameRef(ref: string): boolean {
  return /^e\d{5,}$/.test(ref) || /^f\d+:/.test(ref)
}

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

/** 확인 창에서 [확인]을 누르면 위험한 일이 되는지 (창 글로만 본다. 주소로 넓게 막지 않는다) */
export function classifyDialogRisk(message: string): Risk | undefined {
  for (const [kind, re] of DIALOG_RISK) {
    const m = re.exec(message)
    if (m) return { kind, reason: `확인 창의 "${m[0].trim()}"` }
  }
  return undefined
}

/** 승인 게이트에 걸린 결과의 첫말 (서비스 도구가 이 말로 "커넥터가 넘을 수 없는 멈춤"을 알아본다) */
export const GATE_STOP = '승인이 필요해요'

const RISK_TEXT: Record<RiskKind, string> = {
  money: '돈이 나가는 일',
  contact: '다른 사람에게 무언가 보내거나 올리는 일',
  irreversible: '되돌릴 수 없는 일',
}

interface PageInfo {
  url: string
  refs: Map<string, { role: string; name: string }>
  /** 결제 화면(결제 수단·예약자 정보를 넣는 화면)이면 그 표시 말 */
  checkout?: string
  /** 예약·주문이 확정된 화면이면 그 말 */
  confirmed?: string
  /** 지금 골라져 있는 라디오·체크박스 표시 */
  selected?: Set<string>
  /** 펼쳐진 버튼 표시 (야놀자: 골라진 결제 수단 줄만 '카카오페이 혜택 [펼침]'으로 혜택이 펼쳐져 있다) */
  expanded?: Set<string>
  /** 이름 없는 버튼·라디오 → 바로 뒤 글 (쿠팡 결제 화면: [e8 버튼] 다음 줄 '쿠페이 머니: 0원') */
  near?: Map<string, string>
  /** 표시가 화면 글에서 나오는 순서 (결제 수단 아래 딸린 목록을 찾을 때) */
  pos?: Map<string, number>
}

/** 결제 묶음: 승인한 결제 버튼을 누른 뒤 주문 완료(browser_order_done)까지 한 결제로 보는 탭들 */
export interface PaySession {
  /** 이 결제의 승인 id (주문 완료 때 주문번호와 함께 끝낸다) */
  approvalId: string
  /** 결제 버튼을 누른 탭 (가게 주문서) */
  tabId: number
  /** 이 결제의 탭들: 누른 탭 + 그 탭이 연 결제 창·새 탭 */
  tabs: Set<number>
  /** 가게 사이트 묶음 (siteKey). 누른 탭이 다른 사이트(결제 회사)로 넘어가면 결제 회사 창으로 본다 */
  site: string
  /** 누른 버튼 글자 */
  label: string
  startedAt: number
}

/** 확장의 탭 목록 명령 (탭마다 여는 탭·주소). 확장에 따로 들어온다: 모르는 확장이면 오류 → 빈 목록 */
const TABS_CMD = 'tabs' as BrowserCommand

/** 이름 없는 버튼·라디오에 붙은 글: 같은 줄 뒤, 없으면 다음 줄 (':' 앞까지, 다른 표시 줄은 아님) */
export function nearLabels(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of text.matchAll(/\[(e\d+) (?:버튼|라디오)(?: [^"\]]*)?\]/g)) {
    const rest = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 200).split('\n')
    const line = (rest[0] ?? '').trim() || (rest[1] ?? '').trim()
    if (!line || line.startsWith('[')) continue
    const label = (line.split(/[:：]/)[0] ?? '').trim().slice(0, 30)
    if (label) out.set(m[1] as string, label)
  }
  return out
}

function pageInfo(url: string, text: string): PageInfo {
  const checkout = checkoutScreen(text, url)
  const confirmed = confirmedScreen(text)
  const selected = new Set(
    [...text.matchAll(/\[(e\d+) (?:라디오|체크박스|선택지)[^\]]*선택됨\]/g)].map((m) => m[1] as string),
  )
  const expanded = new Set([...text.matchAll(/\[(e\d+) 버튼[^\]]*펼침\]/g)].map((m) => m[1] as string))
  const near = nearLabels(text)
  const pos = new Map([...text.matchAll(/\[(e\d+) /g)].map((m) => [m[1] as string, m.index ?? 0]))
  return {
    ...(pos.size ? { pos } : {}),
    url,
    refs: parseRefs(text),
    ...(near.size ? { near } : {}),
    ...(checkout ? { checkout } : {}),
    ...(confirmed ? { confirmed } : {}),
    ...(selected.size ? { selected } : {}),
    ...(expanded.size ? { expanded } : {}),
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
  /** 본문 글 길이 (text에는 액자 글·두리 알림도 붙어 있다. 이어 읽기 skip은 이것만큼) */
  mainLength?: number
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
// (실측 2026-11-18: 호텔스닷컴 쿠키 창의 어두운 막이 [예약하기]를 가려 승인한 클릭이 먹지 않았다).
// 누르지는 않는다: 읽기 결과에 '덮은 창' 한 줄로 알려 AI가 닫는다 (coverLine)
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

// 광고·앱 설치·뉴스레터·재촉 팝업을 닫는 버튼 (화면을 덮어 할 일을 가린다)
// (실측 2026-11-18: 호텔 예약 중 '예약 완료까지 얼마 안 남았어요' 같은 재촉 창이 버튼을 가렸다)
const PROMO_CLOSE =
  /^(?:닫기|창\s*닫기|close|×|✕|✖|x|나중에(?:\s*(?:하기|보기|할게요))?|다음에(?:\s*할게요)?|괜찮아요|아니(?:요|오)?\s*괜찮아요|건너뛰(?:기|고)|skip|skip\s*for\s*now|maybe\s*later|no\s*thanks|나중에\s*받을게요|오늘\s*(?:하루\s*)?(?:그만|안)\s*보기|do\s*n'?t\s*show\s*again)$/i
// 그 창이 광고·앱 설치·구독·재촉일 때만 (진짜 할 일 창은 건드리지 않는다)
const PROMO_WORD =
  /앱(?:에서|으로|\s*설치|\s*다운|\s*열기)|어플|app\s*(?:store|download|install)|구독|뉴스레터|newsletter|알림\s*받|푸시\s*(?:받|허용)|첫\s*(?:구매|주문)\s*할인|회원\s*가입(?:하고|하면)|지금\s*가입|쿠폰\s*(?:받|드려)|이벤트\s*응모|마감\s*임박|서두르세요|얼마\s*(?:안|남지)\s*(?:남|않)|곧\s*(?:마감|종료|품절)|놓치지\s*마|한정\s*(?:수량|특가)|리뷰\s*(?:작성|남기)|평점\s*(?:남기|부탁)|설문|의견을?\s*들려/i
// 광고 창이라도 이런 말이 같이 있으면 건드리지 않는다 (결제·로그인·본인인증·동의 같은 진짜 단계)
const PROMO_KEEP =
  /결제|주문서|예약자|로그인|본인\s*인증|인증번호|비밀번호|약관\s*동의|필수\s*동의|주소\s*입력|배송지|카드\s*번호|결제\s*수단/i

/**
 * 광고·앱 설치·재촉 팝업의 닫기 버튼 표시(e12). 이것도 누르지 않고 알리기만 한다 (coverLine).
 * 닫기 버튼 가까이(앞 500자) 광고·재촉 말이 있고, 결제·로그인 같은 진짜 단계 말은 없을 때만.
 * 쿠키 창은 cookieReject가 따로 본다
 */
export function promoClose(text: string): string | undefined {
  const re = /\[(e\d+) (?:버튼|링크) "([^"]*)"[^\]]*\]/g
  for (const m of text.matchAll(re)) {
    const name = (m[2] ?? '').replace(/\s+/g, ' ').trim()
    if (!PROMO_CLOSE.test(name)) continue
    const near = text.slice(Math.max(0, (m.index ?? 0) - 500), (m.index ?? 0) + 60)
    if (PROMO_KEEP.test(near)) continue
    if (PROMO_WORD.test(near) && !COOKIE_WORD.test(near)) return m[1]
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
  /^(?:(?:신용|체크)\s*)?카드(?:\s*결제)?$|^신용\s*\/\s*체크\s*카드|일반\s*결제|다른\s*결제\s*수단|^[A-Z]{2,}\s*(?:머니|페이|카드\s*페이)|네이버\s*페이|카카오\s*페이|토스\s*페이|페이코|PAYCO|삼성\s*페이|애플\s*페이|쿠페이|스마일\s*페이|SSG\s*PAY|N\s*pay|휴대폰\s*결제|계좌\s*이체|무통장(?:\s*입금)?|간편\s*결제|(?:지금|나중에|현장에서|숙박\s*시설에서)\s*결제/i

// 결제 수단을 고르는 버튼: 이름 전체가 결제 수단일 때만 ('카카오페이로 결제'처럼 결제하는 버튼은 아니다).
// 뒤에 혜택 안내만 붙은 것도 결제 수단이다 (실측 야놀자: "카카오페이 혜택", "NOL 머니 2% 포인트 적립", "다른 결제 수단 혜택")
const PAY_BUTTON =
  /^(?:신용\s*\/\s*체크\s*카드|(?:신용|체크)?\s*카드|네이버\s*페이|카카오\s*페이|토스\s*페이|페이코|PAYCO|삼성\s*페이|애플\s*페이|쿠페이(?:\s*머니)?|스마일\s*페이|SSG\s*PAY|N\s*pay|휴대폰|계좌\s*이체|무통장(?:\s*입금)?|간편|일반|다른\s*결제\s*수단|[A-Z]{2,}\s*(?:머니|페이|카드\s*페이))(?:\s*결제)?(?:\s*혜택|\s*[\d.]+\s*%\s*(?:포인트\s*)?(?:적립|할인))?$/i

/** 승인 카드에 보일 결제 수단 이름: 뒤에 붙은 혜택 안내는 뗀다 ("카카오페이 혜택" → "카카오페이") */
export function payOptionName(label: string): string {
  return label.replace(/\s*혜택$/, '').trim() || label
}

/** 결제 수단 고르기 칸 이름 (이름 없는 칸은 바로 뒤 글) */
export function optionLabel(info: Pick<PageInfo, 'refs' | 'near'>, ref: string): string {
  const v = info.refs.get(ref)
  return (v?.name || info.near?.get(ref) || '').trim()
}

/** 결제 수단을 고르는 칸인지: 라디오·선택지는 결제 수단 이름이 들어 있으면, 버튼은 이름 전체가 결제 수단일 때 */
export function isPayOption(role: string, label: string): boolean {
  if (!label || label.length > 30) return false
  if (role === '라디오' || role === '선택지') return PAY_OPTION.test(label)
  return role === '버튼' && PAY_BUTTON.test(label)
}

/** 같은 결제 수단인지 볼 때 쓰는 이름 (띄어쓰기·뒤 혜택 안내 무시: "스마일페이간편결제" = "스마일페이 간편결제") */
function payKey(label: string): string {
  return payOptionName(label).replace(/\s+/g, '')
}

/**
 * 결제 화면의 결제 수단 고르기 칸들 (AI가 choices를 안 넘겨도 승인 카드에 싣는다).
 * 같은 결제 수단이 라디오와 그 옆 버튼으로 두 번 나오면 하나만 싣는다 — 고르는 칸(라디오)을 남긴다
 * (실측 11-20 G마켓: "일반 결제 혜택" 라디오·버튼이 카드에 "일반 결제"로 두 번 떠 헷갈렸다)
 */
export function payOptions(info: Pick<PageInfo, 'refs' | 'near'>): string[] {
  const byName = new Map<string, string>()
  for (const [k, v] of info.refs) {
    const label = optionLabel(info, k)
    if (!isPayOption(v.role, label)) continue
    const key = payKey(label)
    const had = byName.get(key)
    if (had === undefined) byName.set(key, k)
    else if (info.refs.get(had)?.role !== '라디오' && v.role === '라디오') byName.set(key, k)
  }
  return [...byName.values()].slice(0, 8)
}

/**
 * 승인 카드에 실을 결제 수단: AI가 넘긴 것 + 결제 화면에 있는 결제 수단 모두 (AI가 넘긴 순서가 먼저).
 * AI가 몇 개만 골라 넘겨도 화면에 있는 다른 수단이 빠지지 않게 (실측 야놀자: '다른 결제 수단'이 빠져
 * 일반 결제·다른 페이를 고를 수 없었다). 결제 시점처럼 결제 수단이 아닌 선택지면 AI가 넘긴 것만
 */
export function approvalChoices(
  info: Pick<PageInfo, 'refs' | 'near' | 'checkout'>,
  asked: string[] | undefined,
  title: string | undefined,
): string[] {
  const auto = info.checkout && (!title || title === '결제 수단') ? payOptions(info) : []
  if (!asked?.length) return auto.length >= 2 ? auto : []
  const out = [...asked]
  const name = (r: string) => payKey(optionLabel(info, r))
  const names = new Set(out.map(name))
  for (const r of auto)
    if (!out.includes(r) && !names.has(name(r))) {
      out.push(r)
      names.add(name(r))
    }
  return out.slice(0, 8)
}

// 결제 화면 펼침 목록 중 세부 결제 선택 (등록 카드·할부 개월·은행)
const SUB_OPTION = /일시불|할부|\d+\s*개월|카드|\*{3,}|은행|뱅크/

/** 펼침 목록의 고를 것들로 묶음 이름을 정한다. 결제와 상관없는 목록(배송 메모 등)이면 undefined */
export function subChoiceTitle(options: string[]): string | undefined {
  if (options.length < 2 || !options.some((o) => SUB_OPTION.test(o))) return undefined
  if (options.some((o) => /일시불|할부|\d+\s*개월/.test(o))) return '할부'
  if (options.some((o) => /카드|\*{3,}/.test(o))) return '카드'
  return '은행'
}

/** 같은 고르기 칸 찾기: 이름 있는 칸은 sameControl, 이름 없는 칸은 바로 뒤 글이 같은 칸 */
export function sameChoice(
  info: Pick<PageInfo, 'refs' | 'near'>,
  c: { ref: string; role: string; name: string; near?: string },
): string | undefined {
  if (c.name || !c.near) return sameControl(info.refs, c.ref, c.role, c.name)
  const at = info.refs.get(c.ref)
  if (at && at.role === c.role && !at.name && info.near?.get(c.ref) === c.near) return c.ref
  const same = [...info.refs].filter(([k, v]) => v.role === c.role && !v.name && info.near?.get(k) === c.near)
  return same.length === 1 ? same[0]?.[0] : undefined
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
  /** 로그인 카드로 받은 값이 틀려 로그인이 안 됐을 때 지운다 */
  remove?(id: string): Promise<boolean>
  /** 새 비밀번호를 금고에 저장한다 (가입·비번 변경). AI는 값을 받지 않는다 */
  savePassword?(origin: string, username: string, password: string): Promise<void>
}

/**
 * 가입·비번 변경에 쓸 강한 비밀번호 (대·소문자·숫자·특수문자 각 1개 이상). AI에게 주지 않는다.
 * 특수문자는 국내 사이트가 거의 다 받는 것만 ('&'·따옴표는 막는 곳이 있다)
 */
export function makePassword(length = 16): string {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const L = 'abcdefghijkmnpqrstuvwxyz'
  const D = '23456789'
  const S = '!@#$%^*'
  const all = U + L + D + S
  const pick = (set: string) => set[randomInt(set.length)] as string
  const chars = [pick(U), pick(L), pick(D), pick(S)]
  while (chars.length < Math.max(8, length)) chars.push(pick(all))
  // 자리를 섞는다 (앞 네 자리가 늘 종류별로 오지 않게)
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j] as string, chars[i] as string]
  }
  return chars.join('')
}

/** 보안 키패드 특수문자 이름 (스크린리더용 이름표: 신한카드 등) */
export const KEYPAD_SPECIAL: Record<string, string[]> = {
  '!': ['느낌표'],
  '@': ['골뱅이'],
  '#': ['우물표시', '샵'],
  $: ['달러표시'],
  '%': ['퍼센트'],
  '^': ['윗꺽쇠'],
  '&': ['앰퍼센드'],
  '*': ['별표'],
}

/** 보안 키패드로 넣을 비밀번호: 소문자·숫자 + 특수문자 하나 (대문자는 쉬프트가 필요해 뺀다) */
export function makeKeypadPassword(length = 12): string {
  const L = 'abcdefghijkmnpqrstuvwxyz'
  const D = '23456789'
  const S = '!@'
  const pick = (set: string) => set[randomInt(set.length)] as string
  const chars = [pick(L), pick(L), pick(D), pick(D), pick(S)]
  while (chars.length < Math.max(8, length)) chars.push(pick(L + D))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j] as string, chars[i] as string]
  }
  return chars.join('')
}

/** 키패드에서 그 글자의 버튼 이름 후보 */
export function keypadLabels(ch: string): string[] {
  if (/^\d$/.test(ch)) return [ch]
  if (/^[a-z]$/.test(ch)) return [`소문자 ${ch}`, ch]
  if (/^[A-Z]$/.test(ch)) return [`대문자 ${ch}`, ch]
  return [...(KEYPAD_SPECIAL[ch] ?? []), ch]
}

export async function keypadType(
  browser: BrowserCaller,
  tabId: number,
  fieldRef: string,
  pw: string,
): Promise<boolean> {
  const snap = async () => {
    const r = (await browser.call('snapshot', { tabId, maxChars: 60_000 }, 20_000)) as {
      text?: string
    }
    return [...parseRefs(r?.text ?? '')].filter(([, v]) => v.role === '버튼')
  }
  const press = (ref: string) =>
    browser.call('click', { tabId, ref, once: true, force: true, quick: true }, 15_000).then(
      () => true,
      () => false,
    )
  // 칸을 눌러 키패드를 연다
  await press(fieldRef)
  await new Promise((r) => setTimeout(r, 400))
  let keys = await snap()
  const find = (names: string[]) => keys.find(([, v]) => names.includes(v.name))?.[0]
  const isKeypad = () =>
    keys.filter(([, v]) => /^\d$/.test(v.name)).length >= 10 &&
    keys.some(([, v]) => /^(소|대)문자 [a-zA-Z]$/.test(v.name))
  // 특수문자 줄이 열려 있으면 글자 줄로 돌려놓고 시작한다
  if (!isKeypad()) {
    const back = find(['소문자', '영문', '알파벳'])
    if (!back || !(await press(back))) return false
    await new Promise((r) => setTimeout(r, 250))
    keys = await snap()
    if (!isKeypad()) return false
  }
  let layer: 'letters' | 'special' = 'letters'
  for (const ch of pw) {
    const need = /[a-z0-9]/i.test(ch) ? 'letters' : 'special'
    if (need !== layer) {
      const toggle =
        need === 'special'
          ? find(['알파벳/특수문자', '특수문자', '특수키'])
          : find(['소문자', '알파벳/특수문자', '영문'])
      if (!toggle || !(await press(toggle))) return false
      await new Promise((r) => setTimeout(r, 250))
      keys = await snap()
      layer = need
    }
    const ref = find(keypadLabels(ch))
    if (!ref || !(await press(ref))) return false
    await new Promise((r) => setTimeout(r, 120))
  }
  const done = find(['확인', '입력완료', '완료'])
  if (done) await press(done)
  return true
}

/**
 * 비밀번호 칸에 금고 값을 넣는다. 한 번에 넣은 글이 잘리면(보안 키패드 칸) 화면 키패드 버튼을 눌러 넣는다.
 * 넣은 방법을 돌려준다 ('fill' | 'keypad' | 'short': 둘 다 안 됨)
 */
export async function fillPassword(
  browser: BrowserCaller,
  a: { tabId: number; ref: string; value: string; origin: string },
): Promise<'fill' | 'keypad' | 'short'> {
  const put = (await browser.call('fill', { ...a, password: true })) as { length?: number } | undefined
  if (typeof put?.length !== 'number' || put.length === a.value.length) return 'fill'
  return (await keypadType(browser, a.tabId, a.ref, a.value)) ? 'keypad' : 'short'
}

/** 목록에서 사용자가 말한 옵션 찾기: 글이 같은 것, 없으면 그 글로 시작·그 글을 담은 것이 하나뿐일 때 */
export function matchOption(options: string[], want: string): string | undefined {
  const n = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase()
  const w = n(want)
  if (!w) return undefined
  const exact = options.find((o) => n(o) === w)
  if (exact) return exact
  // 품절 표시·가격은 떼고 본다 ("M (품절)", "옵션01 89,000 원")
  const core = (o: string) =>
    n(o)
      .replace(/\s*[([]?\s*(품절|일시품절|재입고\s*알림)\s*[)\]]?\s*/g, '')
      .replace(/\s*[+-]?[\d,]+\s*원\s*$/, '')
  const same = options.filter((o) => core(o) === w)
  if (same.length === 1) return same[0]
  // 숫자 사이즈(260·95·32)는 정확히 같을 때만 ("26"이 "260"이 되면 안 된다)
  if (/^\d+(\.\d+)?$/.test(w)) return undefined
  const starts = options.filter((o) => core(o).startsWith(w))
  if (starts.length === 1) return starts[0]
  const has = options.filter((o) =>
    new RegExp(`(^|[^a-z0-9가-힣])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9가-힣])`).test(
      core(o),
    ),
  )
  return has.length === 1 ? has[0] : undefined
}

/** 상품 옵션을 먼저 골라야 한다는 신호 (사이트 알림창·안내 글) */
export const NEED_OPTION =
  /옵션.{0,8}(선택|골라)|(사이즈|색상|컬러|옵션)(을|를)\s*(먼저\s*)?선택|선택.{0,6}옵션/

/** 화면에서 옵션 칸으로 보이는 것 (선택 상자, "옵션 열기"·"사이즈"·"선택해 주세요" 같은 버튼·입력칸) */
export function optionFields(refs: Map<string, { role: string; name: string }>): string[] {
  const out: string[] = []
  for (const [ref, c] of refs) {
    const name = c.name.trim()
    if (
      c.role === '선택 상자' ||
      ((c.role === '버튼' || c.role === '입력칸') &&
        /^(옵션|사이즈|색상|컬러|용량|수량 선택|선택|선택해 ?주세요\.?|.{0,6}(옵션|사이즈|색상) ?(열기|선택)|선택 목록 열기)$/.test(
          name,
        ))
    )
      out.push(`[${ref} ${c.role} "${name.slice(0, 30)}"]`)
    if (out.length >= 6) break
  }
  return out
}

/** 사이트 묶음 (member.ssg.com·www.ssg.com → ssg.com, www.aladin.co.kr → aladin.co.kr) */
export function siteKey(hostOrUrl: string): string {
  let host = hostOrUrl.trim().toLowerCase()
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname
  } catch {}
  host = host.replace(/^\.+|\.+$/g, '')
  if (/^[\d.]+$/.test(host) || host === 'localhost') return host
  const parts = host.split('.')
  const second = parts.slice(-2).join('.')
  const n = /^(co|or|go|ne|ac|re|pe|com|net|org)\.[a-z]{2}$/.test(second) ? 3 : 2
  return parts.slice(-n).join('.')
}

const DONE_RE =
  /(회원\s*)?가입(이|을)?\s*(완료|축하|환영)|가입(이|을)?\s*(되었|됐|마쳤|끝났)|비밀번호(가|를)?\s*(변경|재설정)(이|을)?\s*(완료|되었|됐|했)|welcome to|registration (is )?complete|account (has been |was )?created/i
const EXISTS_RE =
  /이미\s*(가입|사용\s*중|등록|존재)(된|인|하는|한|되어\s*있는|돼\s*있는)?\s*(이메일|아이디|계정|회원|ID|e-?mail)|already (registered|exists|in use|taken)/i

/** 새 비밀번호를 넣은 뒤 화면이 알려 주는 결과: 끝남·이미 있는 계정 (처음 화면에도 있던 글은 셈하지 않는다) */
export function accountOutcome(
  now: { url: string; title: string; text: string },
  base: { url: string; title: string; text: string },
): 'done' | 'exists' | undefined {
  const moved = now.url.split('#')[0] !== base.url.split('#')[0]
  // 몇 번 나오는지로 본다: 가입 화면에 원래 "이미 가입된 회원이신가요?"가 있어도, 새로 뜬 "이미 가입된 이메일이에요"는 하나 더 늘어난다
  const count = (re: RegExp, t: string) => t.match(new RegExp(re.source, 'gi'))?.length ?? 0
  if (count(DONE_RE, now.title) > count(DONE_RE, base.title)) return 'done'
  if (count(EXISTS_RE, now.text) > count(EXISTS_RE, base.text)) return 'exists'
  if (count(DONE_RE, now.text) > 0 && (moved || count(DONE_RE, now.text) > count(DONE_RE, base.text)))
    return 'done'
  return undefined
}

/**
 * 사용자의 말이 그 일(가입·비번 변경)을 부탁한 것인지. 주소 안의 /signup·/join은 셈하지 않는다
 * (실측: "…/signup 열어서 칸 채워 줘"를 가입 부탁으로 보고 묻지 않았다)
 */
export function askedForAccount(text: string, purpose: 'signup' | 'reset'): boolean {
  const said = text.replace(
    /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)+(?::\d+)?\/\S*|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\S*/gi,
    ' ',
  )
  return purpose === 'reset'
    ? /(비밀번호|비번)\s*(을|를|도)?\s*(찾|바꿔|바꾸|재설정|변경|새로)/.test(said)
    : /(회원\s*)?가입|계정\s*(을|도)?\s*(만들|새로|생성|하나)/.test(said)
}

/** 금고에 넣기 전, 가입·변경이 끝나기를 기다리는 비밀번호 */
interface PendingPassword {
  key: string
  origin: string
  username: string
  password: string
  purpose: 'signup' | 'reset'
  at: number
  base?: { url: string; title: string; text: string }
}

/** 사람에게 넘긴 탭을 폰 원격 화면으로 다룰 수 있는 시간 */
export const REMOTE_TTL_MS = 30 * 60_000

/**
 * 내 정보(이름·휴대폰·생년월일)를 넣어도 되는 공인 인증 창 사이트: 여러 사이트가 이 주소의 액자로 본인확인·인증서 창을 띄운다
 * (금융인증서 = 금융결제원 yeskey, 공동인증서·휴대폰 본인확인 = 인증기관·신용평가사). 비밀번호는 넣지 않는다
 */
export const AUTH_FRAME_SITES = [
  'yeskey.or.kr',
  'yessign.or.kr',
  'kftc.or.kr',
  'signkorea.com',
  'crosscert.com',
  'tradesign.net',
  'kica.or.kr',
  'niceid.co.kr',
  'nice.co.kr',
  'kmcert.com',
  'kcb.co.kr',
  'okname.co.kr',
  'sci.co.kr',
  'siren24.com',
]

export class BrowserTools {
  private pages = new Map<number, PageInfo>()
  /** 화면 넘기기를 한 번 되돌려 보낸 화면 (탭:주소) — 두 번째에만 넘긴다 */
  private handoffChecked = new Set<string>()
  /** 로그인 카드로 받았지만 아직 로그인에 성공한 적 없는 사이트(origin). 실패하면 금고에서 지우고 카드를 다시 받는다 */
  private unverified = new Set<string>()
  /** 금고 값으로 채운 로그인 시도 (탭 → 사이트·항목) — 다음 읽기에서 성공·실패를 본다 */
  private loginTries = new Map<number, { origin: string; entryId: string }>()
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

  /** 탭이 마지막으로 읽힌 사이트 주소 (일한 과정 기록이 단계를 사이트별로 묶을 때). 모르면 undefined */
  tabHost(tabId: number): string | undefined {
    try {
      return new URL(this.pages.get(tabId)?.url ?? '').host || undefined
    } catch {
      return undefined
    }
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
  requestProfile?: (fields: ProfileField[], reason: string, options?: string[]) => string | undefined
  /** 사용자 폰에 알림을 보낸다 (인증 앱 승인 기다리기 등) */
  notifyUser?: (title: string, body: string) => void
  /** 인증 앱 승인을 폰 카드로 기다린다: [인증 완료했어요]를 누르면 answer가 풀린다. cancel은 카드를 닫는다 */
  askAuthDone?: (
    host: string,
    label: string,
    hint: string,
  ) => { answer: Promise<string | undefined>; cancel: () => void }
  /** 인증번호 카드를 띄운다 (폰). 받은 번호는 본체가 그 칸에 넣고, 대화로 이어서 하라고 알린다 */
  requestCode?: (
    tabId: number,
    field: string,
    label: string,
    hint: string,
    host: string,
    kind?: 'code' | 'rrn_back' | 'captcha',
    ref?: string,
    /** 보안문자 그림 (jpeg base64) */
    image?: string,
  ) => string | undefined
  /** 그림 눌러 풀기 카드 (폰). 사용자가 그림에서 누른 곳(0~1000)을 본체가 rect 안의 같은 자리에 누른다 */
  requestTap?: (
    tabId: number,
    say: string,
    host: string,
    image: string,
    rect: { x: number; y: number; w: number; h: number },
    taps: number,
  ) => string | undefined
  /** 결제 비밀번호 키패드 카드 (폰 보안 키패드). 받은 숫자는 본체가 keys의 버튼을 차례로 누른다 */
  requestPin?: (
    tabId: number,
    label: string,
    host: string,
    keys: Record<string, PinKey>,
    length: number,
  ) => string | undefined
  /** 주소의 사이트에 서비스 도구(커넥터)가 있으면 그 서비스와 도구 이름 (ADR 0018) */
  siteConnector?: (url: string) => Promise<{ id: string; name: string; tools: string[] } | undefined>
  /** 금고 값으로 로그인 칸을 채웠다 (연결 카드 없이 일하다 로그인한 것도 연결로 남기게) */
  onVaultLogin?: (tabId: number, url: string) => void
  /** 그림 키패드를 잘라 보여 준 자리 (AI가 숫자 자리를 짚어 다시 부를 때까지) */
  private pinShots = new Map<number, { rect: { x: number; y: number; w: number; h: number }; at: number }>()
  /** 가입·비밀번호 변경이 끝나 금고에 계정을 넣었을 때 (본체가 그 서비스를 연결로 표시한다) */
  onAccountSaved?: (url: string) => void
  /** 이 사이트에 두리가 카드 없이 다시 로그인할 길(금고 계정·전에 쓴 간편 로그인)이 있으면 그 서비스 id */
  reloginFor?: (origin: string) => Promise<string | undefined>
  /** 탭마다 요령을 알린 사이트 (같은 사이트 안에서 옮길 때는 다시 알리지 않는다) */
  private guided = new Map<number, string>()
  /** 사이트마다 마지막으로 고른 결제 수단 (다음 승인 카드의 기본값) */
  private lastChoice = new Map<string, string>()
  /** 내 결제 수단 (ADR 0023, 맨 위가 주 결제 수단). 사이트가 받는 것 중 맞는 것을 승인 카드 기본값으로 */
  payMethods?: () => PayMethod[]
  /** 마지막으로 고른 결제 수단이 바뀌면 (본체가 설정에 남긴다) */
  onChoice?: (host: string, label: string) => void
  /** 사이트·묶음(카드·할부)마다 마지막으로 고른 것 ("www.coupang.com|할부" → "일시불"). 카드 번호는 화면에 보이는 가린 글만 */
  private lastSub = new Map<string, string>()
  /** 마지막으로 고른 등록 카드·할부가 바뀌면 (본체가 설정에 남긴다) */
  onSubChoice?: (key: string, label: string) => void
  loadSubChoices(map: Record<string, string>) {
    for (const [k, v] of Object.entries(map)) this.lastSub.set(k, v)
  }
  /** 설정에서 그 사이트의 결제 수단을 잊었을 때 (카드·할부 기억도 같이) */
  forgetChoice(host: string) {
    this.lastChoice.delete(host)
    for (const k of [...this.lastSub.keys()]) if (k.startsWith(`${host}|`)) this.lastSub.delete(k)
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
  /** 사용자가 가입·비번 변경을 고른 사이트 (siteKey → 만료 시각). 이게 없으면 새 비밀번호를 만들지 않고 먼저 묻는다 */
  private signupOk = new Map<string, number>()
  /** 가입·변경이 끝나기를 기다리는 새 비밀번호 (끝난 걸 화면에서 보면 금고에 넣는다) */
  private pendingPw: PendingPassword[] = []
  /**
   * 받는 곳 고르기: 화면의 배송지와 저장된 다른 배송지, 그리고 내 정보 주소.
   * 화면의 배송지가 내 정보 주소와 다르면(번지·동·호수 숫자가 빠졌으면) 경고를 붙이고 내 정보 주소를 바로 고르게 둔다.
   * AI는 내 정보 주소를 가린 값으로만 봐서 다른 줄 모른다 (실측 요기요: 동네 검색 위치 '신봉동 33'이 배달 주소가 됐다)
   */
  private async shipChoices(shipTo: string, others: string[]) {
    const labels = [shipTo, ...others]
    let shipWarn: string | undefined
    const p = this.profile ? await this.profile.get().catch(() => undefined) : undefined
    const home = [p?.address, p?.address_detail].filter(Boolean).join(' ').trim()
    if (home) {
      const nums = (t: string) => t.match(/\d+/g) ?? []
      // 동네 이름 (신봉1로 → 신봉, 신봉동 → 신봉): 도로명 주소와 지번 주소는 번지 숫자가 달라도 같은 곳이다
      const towns = (t: string) =>
        new Set(
          (t.match(/[가-힣]+\d*(?:동|로|길|가|리)(?=\s|\d|$)/g) ?? [])
            .map((w) => w.replace(/\d*(?:동|로|길|가|리)$/, ''))
            .filter((w) => w.length >= 2),
        )
      const detail = nums(p?.address_detail ?? '')
      const has = (t: string) => {
        const got = new Set(nums(t))
        if (nums(home).every((n) => got.has(n))) return true
        // 동·호수가 같고 같은 동네면 같은 집 (실측 11-20: '신봉동 905 · 506동 1303호'를 '신봉1로 27'과 다르다고 경고했다)
        const mine = towns(p?.address ?? '')
        return detail.length > 0 && detail.every((n) => got.has(n)) && [...towns(t)].some((w) => mine.has(w))
      }
      if (!has(shipTo)) {
        shipWarn = '내 정보 주소와 달라요. 받는 곳을 확인해 주세요'
        if (!labels.slice(1).some(has)) labels.splice(1, 0, `내 정보 주소 · ${home}`)
      }
    }
    return {
      shipOptions: labels.map((label, i) => ({ id: `a${i}`, label: label.slice(0, 140) })),
      ...(shipWarn ? { shipWarn } : {}),
    }
  }
  /** 승인받은 결제를 배송지를 바꾼 뒤 누르기: 탭마다 그 버튼 한 번 (결제 승인과 같은 1시간) */
  private paidPass = new Map<number, { label: string; until: number; approvalId: string }>()
  /** 승인받은 마지막 버튼이면 한 번 쓴다 (그 승인 id, 아니면 undefined) */
  private usePass(tabId: number, name: string): string | undefined {
    const p = this.paidPass.get(tabId)
    if (!p) return undefined
    if (p.until < Date.now()) {
      this.paidPass.delete(tabId)
      return undefined
    }
    if (name !== p.label && !sameFinal(name, p.label)) return undefined
    this.paidPass.delete(tabId)
    return p.approvalId
  }
  /** 사용자가 이 사이트의 가입·비번 변경을 골랐다 (폰 카드·대화) */
  allowSignup(hostOrUrl: string, ms = 60 * 60_000) {
    const key = siteKey(hostOrUrl)
    if (key) this.signupOk.set(key, Date.now() + ms)
  }
  private disallowSignup(key: string) {
    this.signupOk.delete(key)
  }
  private signupAllowed(key: string) {
    const t = this.signupOk.get(key)
    return t !== undefined && t > Date.now()
  }
  /**
   * 가입·비번 변경 전에 사용자에게 묻는다. 'ok' = 이미 그렇게 부탁했다(대화), 'asked' = 폰에 고르기 카드를 띄웠다.
   * 고르면 본체가 그 대화로 이어서 하라고 알린다
   */
  askSignup?: (
    site: string,
    key: string,
    purpose: 'signup' | 'reset',
    /** 두리가 만든 비밀번호를 그 칸이 받지 않았다: 사용자에게 직접 정해 달라고 꼭 묻는다 */
    needOwn?: boolean,
  ) => 'ok' | 'asked' | undefined
  /** 만든 비밀번호를 받지 않은 사이트 (다음엔 폰에서 직접 정하게) */
  private pwNeedOwn = new Set<string>()
  /**
   * 웹사이트에 올릴 PC 파일 확인 (browser_upload). 파일 도구와 같은 울타리(바탕화면·문서·다운로드·사진·동영상,
   * 숨은 폴더·인증서·키 제외)를 본체가 넣어 준다. 없으면 올리기를 하지 않는다
   */
  uploadFiles?: (paths: string[]) => Promise<{ files: UploadFile[] } | { error: string }>
  /** 올리기 승인 요청 → 올릴 파일들 (승인되면 본체가 그 칸에 넣는다) */
  private uploadAsks = new Map<string, UploadFile[]>()
  /** 승인받아 올린 파일: "사이트|실제 경로" → 이때까지 다시 묻지 않는다 (다시 시도·같은 사진 다른 칸) */
  private uploadPass = new Map<string, number>()

  /** 사용자가 직접 정한 새 비밀번호 (사이트마다, 한 번 쓰면 지운다). AI는 값을 받지 않는다 */
  private ownPw = new Map<string, string>()
  setOwnPassword(key: string, pw: string) {
    this.ownPw.set(key, pw)
  }

  async run(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.tabId === 'number') this.allowRemote(args.tabId)
    try {
      // 처음 보는 탭이 결제 중인 탭이 연 창(결제 창)이면 그 결제 묶음에 넣는다 (늦게 뜬 결제 창도 같은 결제)
      if (typeof args.tabId === 'number' && !this.pages.has(args.tabId)) await this.adoptTab(args.tabId)
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
        // 결제 중인 탭은 옮기지 않는다 (실측 11-20 G마켓: 승인 뒤 카드 결제창이 뜬 탭을 주문 내역으로 옮겨 결제가 끊겼다)
        if (this.isPaying(tabId))
          throw new Error(
            '결제 중인 탭이에요. 결제가 끝날 때까지(주문 완료 화면) 이 탭을 다른 주소로 옮기지 않아요. 화면이 비었으면 결제 창이 새 창이나 화면 안 액자로 떴을 수 있어요: browser_read·browser_screenshot으로 찾아 결제를 끝까지 마쳐요(결제 비밀번호·인증은 폰 카드로). 다른 일은 browser_open으로 새 탭에서 해요.',
          )
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
        // 화면 안 액자(다른 주소의 작은 창) 속 버튼: 액자는 늦게 바뀐다. 누른 직후 그대로면 잠깐 기다려 다시 읽는다
        // (실측 11-20 G마켓 배송지 추가: 양식이 떴는데 바로 읽어 '입력 창이 안 떠요'로 판단하고 사람에게 넘겼다)
        const inFrame = frameRef(String(a.ref ?? ''))
        const frameSig = () =>
          [...(this.pages.get(tabId)?.refs ?? new Map()).entries()]
            .filter(([k]) => frameRef(k))
            .map(([k, v]) => `${k}:${v.role}:${v.name}`)
            .join('|')
        const before = inFrame ? frameSig() : ''
        const r = await this.act(tabId, { ...a, do: 'click' })
        if (r.newTabId) return this.read(r.newTabId, undefined, `${r.note} 새 탭이 열려서 그 탭을 읽었어요.`)
        const out = await this.read(tabId, undefined, r.note)
        if (!inFrame || frameSig() !== before) return out
        await new Promise((res) => setTimeout(res, 1_500))
        return this.read(tabId, undefined, `${r.note} (화면 안 액자가 바뀌기를 잠깐 기다려 다시 읽었어요)`)
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
        const r = (await this.browser.call('scroll', {
          tabId,
          direction: a.direction === 'up' ? 'up' : 'down',
          ...(typeof a.ref === 'string' ? { ref: a.ref } : {}),
        })) as { scroll?: { target: string; before: number; after: number; max: number; atEnd: boolean } }
        const sc = r?.scroll
        const where = sc
          ? ` (${sc.target === 'box' ? '그 상자' : '페이지'} ${sc.before}→${sc.after}px / 끝 ${sc.max}px${sc.atEnd ? ', 끝까지 왔어요' : ''}${sc.before === sc.after ? ', 움직이지 않았어요' : ''})`
          : ''
        // 사람이 굴린 뒤 화면을 보듯, 지금 보이는 부분만 읽어 돌려준다 (한 화면이라 짧다)
        return this.read(tabId, undefined, `스크롤했어요.${where}`, { view: true })
      }
      case 'wait':
        return this.waitChange(tabId, a)
      case 'tabs':
        return this.tabList(a)
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
        if (this.isPaying(tabId))
          throw new Error(
            '결제 중인 탭이에요. 결제가 끝날 때까지(주문 완료 화면) 이 탭을 다른 주소로 옮기지 않아요. 화면이 비었으면 결제 창이 새 창이나 화면 안 액자로 떴을 수 있어요: browser_read·browser_screenshot으로 찾아 결제를 끝까지 마쳐요(결제 비밀번호·인증은 폰 카드로). 다른 일은 browser_open으로 새 탭에서 해요.',
          )
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
        if (a.failed === true) return this.loginFailed(tabId, String(a.reason ?? ''))
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
        const put = (await this.browser.call('fill', {
          tabId,
          ref: String(a.passwordRef),
          value: entry.password,
          origin,
          password: true,
        })) as { length?: number } | undefined
        // 키 입력을 막는 보안 키패드 칸이면 화면 키패드 버튼을 눌러 넣는다 (값은 AI에게 안 감)
        // (실측 11-21 신한카드: 가입은 키패드로 됐는데 로그인 화면이 금고 비밀번호를 받지 않아 로그인이 막혔다)
        let keypad = false
        if (typeof put?.length === 'number' && put.length !== entry.password.length)
          keypad = await this.keypadType(tabId, String(a.passwordRef), entry.password)
        await this.vault?.markUsed(entry.id)
        this.loginTries.set(tabId, { origin, entryId: entry.id })
        this.onVaultLogin?.(tabId, page.url)
        return this.read(
          tabId,
          undefined,
          keypad
            ? '두리 금고에서 로그인 정보를 채웠어요(비밀번호는 화면 보안 키패드로 눌러 넣었어요). 로그인 버튼을 눌러 주세요.'
            : '두리 금고에서 로그인 정보를 채웠어요. 로그인 버튼을 눌러 주세요.',
        )
      }
      case 'dialog': {
        // 사이트 확인 창(confirm·prompt)에서 고른다. [확인]이 결제·보내기·삭제가 되면 승인을 받는다
        const d = this.dialogs.get(tabId)
        if (!d)
          throw new Error('떠 있는 사이트 확인 창이 없어요. 페이지를 다시 읽어(browser_read) 확인해 주세요')
        const accept = a.accept !== false
        if (accept) {
          const risk = classifyDialogRisk(d.message)
          // 결제 묶음 안의 결제 회사 창이 묻는 확인은 같은 결제다. 여러 개를 한 번에 승인받았으면
          // 각 항목의 확인 창("삭제하시겠습니까?")도 묻지 않는다 (버튼에서 이미 하나를 썼다)
          if (risk && !this.inProvider(tabId, d.url) && !this.useSeries(d.url, risk.kind, false))
            throw new Error(
              this.finalStep() === 'self'
                ? `${GATE_STOP}: ${risk.reason} — ${RISK_TEXT[risk.kind]}이라 두리가 [확인]을 누르지 않아요. 사용자가 "마지막 버튼은 직접 누르기"로 정해 두었어요. 여기까지 준비한 내용(무엇을·어디서·얼마)을 정리해 알리고 이번 답을 끝내요.`
                : `${GATE_STOP}: ${risk.reason} — ${RISK_TEXT[risk.kind]}이에요. browser_request_approval(dialog: true, 무엇을·어디서·얼마)로 승인 카드를 띄워요. 승인되면 두리가 [확인]을 눌러요.`,
            )
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
      case 'checkout': {
        // 결제 카드 (11-20 사용자 시안): 결제 화면의 마지막 버튼 하나에 승인 한 번. 상품·금액·받는 곳·결제 수단·정보를 한 장에
        const page = this.pages.get(tabId)
        if (!page) throw new Error('먼저 결제 화면을 읽어 주세요')
        const ref = String(a.ref ?? '')
        if (!page.refs.has(ref))
          throw new Error(`${ref} 표시가 없어요. 결제 화면을 다시 읽어 마지막 버튼을 짚어 주세요`)
        // 결제 화면인지는 AI가 화면을 보고 정한다: 카드를 띄워 달라면 띄운다 (묻는 건 늘 안전하다).
        // (예전엔 결제 화면 표시를 정규식으로 찾아 못 찾으면 거절했다 — 실측 11-20 G마켓 주문서에서 카드가 안 떴다)
        const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '')
        const list = <T>(v: unknown, n: number, f: (x: Record<string, unknown>) => T | undefined): T[] =>
          (Array.isArray(v) ? v : [])
            .slice(0, n)
            .map((x) => (x && typeof x === 'object' ? f(x as Record<string, unknown>) : undefined))
            .filter((x): x is T => x !== undefined)
        const goods = list(a.goods, 20, (g) =>
          str(g.name, 80)
            ? {
                name: str(g.name, 80),
                ...(str(g.option, 80) ? { option: str(g.option, 80) } : {}),
                ...(str(g.qty, 20) ? { qty: str(g.qty, 20) } : {}),
                ...(str(g.price, 30) ? { price: str(g.price, 30) } : {}),
                ...(/^https:\/\//.test(str(g.image, 800)) ? { image: str(g.image, 800) } : {}),
              }
            : undefined,
        )
        const lines = list(a.lines, 10, (l) =>
          str(l.label, 24) && str(l.value, 30)
            ? {
                label: str(l.label, 24),
                value: str(l.value, 30),
                ...(l.kind === 'discount' || l.kind === 'fee' || l.kind === 'point'
                  ? { kind: l.kind as 'discount' | 'fee' | 'point' }
                  : {}),
              }
            : undefined,
        )
        // 휴대폰 번호는 가운데를 가린다 (카드·기록에 전체 번호를 남기지 않는다)
        const maskTel = (v: string) =>
          v.replace(/\b(01[016789])[-\s.]?(\d{3,4})[-\s.]?(\d{4})\b/g, (_m, a1, _b, c) => `${a1}-****-${c}`)
        const info = list(a.info, 8, (l) =>
          str(l.label, 16) && str(l.value, 160)
            ? { label: str(l.label, 16), value: maskTel(str(l.value, 160)) }
            : undefined,
        )
        const choices = Array.isArray(a.choices) ? (a.choices as unknown[]).map(String) : []
        const chose = Array.isArray(a.chose)
          ? (a.chose as unknown[])
              .map((c) => String(c ?? '').slice(0, 60))
              .filter(Boolean)
              .slice(0, 8)
          : []
        const title = str(a.title, 60)
        return this.askApproval(
          tabId,
          ref,
          {
            what:
              str(a.what, 200) ||
              [title, goods.map((g) => g.name).join('·')].filter(Boolean).join(' · ') ||
              '결제',
            where: str(a.where, 100) || title,
            ...(str(a.total, 60) ? { amount: str(a.total, 60) } : {}),
            ...(str(a.cancel, 200) ? { cancel: str(a.cancel, 200) } : {}),
            ...(choices.length ? { choices, choiceTitle: str(a.choiceTitle, 20) || '결제 수단' } : {}),
            ...(chose.length ? { chose } : {}),
            ...(str(a.ship_to, 120)
              ? {
                  shipTo: str(a.ship_to, 120),
                  shipOptions: (Array.isArray(a.ship_options) ? a.ship_options : [])
                    .map((x) =>
                      String(x ?? '')
                        .trim()
                        .slice(0, 120),
                    )
                    .filter((x) => x && x !== str(a.ship_to, 120))
                    .slice(0, 5),
                }
              : {}),
            checkout: {
              ...(title ? { title } : {}),
              ...(str(a.after, 120) ? { after: str(a.after, 120) } : {}),
              goods,
              lines,
              info,
            },
          },
          'money',
        )
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
        // 승인 요청은 거절하지 않는다: 사용자에게 묻는 건 늘 안전하다 (어느 단계의 버튼인지는 AI가 판단한다)
        const choices = Array.isArray(a.choices)
          ? (a.choices as unknown[]).map((c) =>
              typeof c === 'string' ? c : String((c as { ref?: unknown })?.ref ?? ''),
            )
          : []
        const chose = Array.isArray(a.chose)
          ? (a.chose as unknown[])
              .map((c) => String(c ?? '').slice(0, 60))
              .filter(Boolean)
              .slice(0, 8)
          : []
        return this.askApproval(tabId, ref, {
          what: String(a.what ?? ''),
          where: String(a.where ?? ''),
          ...(a.amount ? { amount: String(a.amount) } : {}),
          ...(a.cancel ? { cancel: String(a.cancel) } : {}),
          ...(choices.length
            ? { choices, choiceTitle: String(a.choiceTitle ?? '결제 수단').slice(0, 20) }
            : {}),
          ...(chose.length ? { chose } : {}),
          ...(Number(a.count) > 1 ? { count: Number(a.count) } : {}),
          ...(typeof a.ship_to === 'string' && a.ship_to.trim()
            ? {
                shipTo: a.ship_to.trim().slice(0, 120),
                shipOptions: (Array.isArray(a.ship_options) ? a.ship_options : [])
                  .map((x) =>
                    String(x ?? '')
                      .trim()
                      .slice(0, 120),
                  )
                  .filter((x) => x && x !== String(a.ship_to).trim())
                  .slice(0, 5),
              }
            : {}),
        })
      }
      case 'upload':
        return this.upload(tabId, a)
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
        const cut: string[] = []
        const missing = new Set<ProfileField>()
        let askedSecret = ''
        for (const x of asks.slice(0, 20)) {
          const ref = String(x.ref ?? '')
          // 주민번호 뒷자리: 내 정보에 저장하지 않는다. 폰 가린 카드로 그때만 받아 본체가 그 칸에 넣는다 (AI는 값을 안 본다)
          if (x.key === 'rrn_back' && !p.rrn_back) {
            const t = page.refs.get(ref)
            if (!t || !['입력칸', '검색칸', '비밀번호칸'].includes(t.role))
              throw new Error(`${ref}는 글을 넣는 칸이 아니에요`)
            let host = ''
            try {
              host = new URL(page.url).hostname
            } catch {}
            const id = this.requestCode?.(tabId, t.name, '주민등록번호 뒷자리', '', host, 'rrn_back', ref)
            if (!id) throw new Error('주민번호 뒷자리 카드를 띄우지 못했어요')
            // 사용자가 카드에 넣을 때까지 탭을 닫지 않는다 (답을 끝내면 일하던 탭을 정리한다)
            this.hold(tabId, 10 * 60_000)
            askedSecret = t.name
            continue
          }
          const key = String(x.key ?? '') as ProfileKey
          if (!(PROFILE_KEYS as readonly string[]).includes(key))
            throw new Error(`${key}는 내 정보 항목이 아니에요. 쓸 수 있는 것: ${PROFILE_KEYS.join(', ')}`)
          if (key === 'auth_app' || key === 'carrier')
            throw new Error(
              `${key === 'carrier' ? '통신사' : '간편인증 앱'}는 칸에 넣는 게 아니라 그 이름의 버튼·목록에서 골라요(결과에 오는 내 정보의 이름 그대로)`,
            )
          const role = page.refs.get(ref)?.role ?? ''
          if (!['입력칸', '검색칸'].includes(role) && !(key === 'rrn_back' && role === '비밀번호칸'))
            throw new Error(`${ref}는 글을 넣는 칸이 아니에요`)
          const value = profileValue(p, key)
          if (!value) {
            for (const f of sourceOf(key)) if (!p[f]) missing.add(f)
            continue
          }
          const r = (await this.browser.call('fill', {
            tabId,
            ref,
            value,
            origin,
            trust: AUTH_FRAME_SITES,
          })) as { length?: number }
          // 칸이 글자 수를 막으면(maxlength) 잘려 들어간다: 다른 모양으로 다시 채우게 알린다
          // 칸은 글자·숫자만 센다(구분자는 칸마다 달라서): 같은 기준으로 견준다
          const want = value.replace(/[^0-9A-Za-z\uAC00-\uD7A3]/g, '').length
          if (typeof r?.length === 'number' && r.length >= 0 && r.length < want)
            cut.push(`${ref}(${key}): ${want}자 중 ${r.length}자만 들어갔어요`)
          const shown = sourceOf(key)
            .map((f) => (p[f] ? maskValue(f, p[f] as string) : ''))
            .join(' ')
          done.push(`${PROFILE_FIELDS[sourceOf(key)[0] as ProfileField].label}(${shown})`)
        }
        // 간편인증 창이면 어느 앱을 누를지: 내 정보의 간편인증 앱 (없으면 카드로 받는다)
        const identity = asks.some((x) => /^(name|birth|phone)/.test(String(x.key ?? '')))
        const lines = [
          done.length ? `내 정보로 채웠어요: ${done.join(', ')}.` : '',
          askedSecret
            ? `주민번호 뒷자리가 내 정보에 없어서 폰 보안 키패드로 한 번 받는 중이에요("${askedSecret}" 칸, 받으면 금고에 저장). 사용자에게 "폰에 뜬 카드에 주민번호 뒷자리를 넣어 주세요"라고 한 문장으로 말하고 이번 답을 끝내요. 들어가면 알림이 와요.`
            : '',
          cut.length
            ? `잘려 들어간 칸이 있어요 — ${cut.join('; ')}. 이대로 보내면 다른 번호·날짜로 나가요. 그 칸이 받는 모양으로 다시 채워요: 앞자리(010)를 따로 고르는 휴대폰 칸은 phone_rest(뒤 8자리), 세 칸 휴대폰은 phone_head·phone_mid·phone_last, 6자리 생년월일은 birth6, 숫자만 받으면 phone_digits·birth_digits.`
            : '',
          identity && p.auth_app
            ? `간편인증 창이면 인증 앱은 내 정보의 기본 '${p.auth_app}'를 눌러 고르고 [인증 요청]까지 눌러요. 그 사이트 창에 '${p.auth_app}'가 없으면 browser_request_profile(fields: ["auth_app"], options: 그 창에 보이는 앱 이름들)로 이번에 쓸 앱을 받아요.`
            : identity
              ? '간편인증 창이면 쓸 인증 앱이 내 정보에 없어요. 대화로 묻지 말고 browser_request_profile(fields: ["auth_app"], options: 그 창에 보이는 앱 이름들)로 고르게 해요.'
              : '',
          identity && p.carrier
            ? `통신사를 고르는 칸이 있으면 내 정보의 '${p.carrier}'를 골라요.`
            : identity
              ? '통신사를 고르는 칸이 있으면 대화로 묻지 말고 browser_request_profile(fields: ["carrier"])로 받아요(한 번 넣으면 다음부터 두리가 골라요).'
              : '',
          missing.size
            ? `내 정보에 ${[...missing].map((f) => PROFILE_FIELDS[f].label).join('·')}이(가) 없어요. 사용자에게 묻지 말고 browser_request_profile로 내 정보 카드를 띄운 뒤 답을 끝내세요.`
            : '',
        ].filter(Boolean)
        return this.read(tabId, undefined, lines.join(' '))
      }
      case 'select': {
        // 펼침 목록(상품 옵션·선택 상자): choose가 없으면 목록을 보여 주고, 있으면 그 글로 고른다
        const page = this.pages.get(tabId)
        if (!page) throw new Error('먼저 페이지를 읽어 주세요')
        const ref = String(a.ref ?? '')
        if (!page.refs.has(ref)) throw new Error(`${ref} 표시가 없어요. 페이지를 다시 읽어 주세요`)
        const list = await this.selectOptions(tabId, ref)
        if (!list?.length)
          throw new Error(
            `${ref} 목록을 읽지 못했어요. browser_click으로 그 칸을 눌러 연 뒤 페이지를 읽고, 보이는 항목을 browser_click으로 눌러 주세요.`,
          )
        const labels = list.map((o) => o.label)
        // 결제 수단·할부 목록도 거절하지 않는다: 사용자가 이미 골랐으면 그대로 고르고, 아직이면 결제 카드에서 고르게 하는 건 AI가 정한다
        const want = typeof a.choose === 'string' ? a.choose.trim() : ''
        if (!want) {
          const lines = list.map(
            (o, i) =>
              `${i + 1}. ${o.label}${o.selected ? ' ✓(지금 골라진 것)' : ''}${/품절|재입고/.test(o.label) ? ' — 고를 수 없음' : ''}`,
          )
          return {
            content: [
              {
                type: 'text',
                text: `[탭 ${tabId}] ${ref} 목록 (${list.length}개)\n${lines.join('\n')}\n\n고르려면 browser_select에 choose로 항목 글을 넣어 주세요(사용자가 말한 옵션, 없으면 기억한 사이즈·색).`,
              },
            ],
          }
        }
        const hit = matchOption(labels, want)
        if (!hit)
          throw new Error(
            `"${want}"이(가) 목록에 없거나 여러 개와 비슷해요. 목록: ${labels.slice(0, 20).join(' · ')}. 맞는 것이 없으면 사용자에게 어느 걸로 할지 물어 주세요.`,
          )
        if (/품절|재입고/.test(hit))
          throw new Error(
            `"${hit}"은(는) 품절이에요. 사용자에게 알리고 다른 옵션을 물어 주세요(재입고 알림을 원하면 그것도).`,
          )
        await this.browser.call('choose', { tabId, ref, label: hit }, 20_000)
        return this.read(
          tabId,
          undefined,
          `${ref} 목록에서 "${hit}"을(를) 골랐어요. 옵션이 더 있으면 같은 방법으로 고르고, 다 고르면 수량·금액을 확인해 주세요.`,
        )
      }
      case 'new_password': {
        // 가입·비번 변경: 강한 비밀번호를 만들어 넣는다. 금고에는 끝난 걸 화면에서 본 뒤에 넣는다. AI는 값을 받지 않는다
        const page = this.pages.get(tabId)
        if (!page) throw new Error('먼저 페이지를 읽어 주세요')
        let origin: string
        try {
          origin = new URL(page.url).origin
        } catch {
          throw new Error('페이지 주소를 알 수 없어요')
        }
        const purpose = a.purpose === 'reset' ? 'reset' : 'signup'
        const pwRef = String(a.password ?? a.ref ?? '')
        const confirmRef = a.confirm ? String(a.confirm) : ''
        if (!pwRef) throw new Error('새 비밀번호를 넣을 칸(password: ref)을 알려 주세요')
        for (const r of [pwRef, confirmRef].filter(Boolean)) {
          const c = page.refs.get(r)
          const role = c?.role ?? ''
          // 비밀번호 칸만 (글 입력칸은 이름에 '비밀번호'가 있을 때만 — 쿠폰·검색 칸에 넣지 않게)
          const looksPw =
            role === '비밀번호칸' ||
            (role === '입력칸' && /비밀번호|password|passwd|\bpw\b|암호/i.test(c?.name ?? ''))
          if (!looksPw) throw new Error(`${r}는 비밀번호 칸이 아니에요. 페이지를 다시 읽어 주세요`)
        }
        // 실제 계정을 만들거나 비밀번호를 바꾸는 일: 사용자가 고른 사이트에서만 (지침만으로는 막지 못한다)
        const key = siteKey(origin)
        if (!this.signupAllowed(key)) {
          // 카드에는 서비스 이름으로 (커넥터가 있으면 "알라딘", 없으면 주소)
          const name = (await this.siteConnector?.(page.url).catch(() => undefined))?.name ?? key
          const said = this.askSignup?.(name, key, purpose, this.pwNeedOwn.has(key))
          if (said === 'ok') this.allowSignup(key)
          else if (said === 'asked')
            return {
              content: [
                {
                  type: 'text',
                  text:
                    purpose === 'reset'
                      ? `${name} 비밀번호를 새로 바꿀지 사용자 폰에 물었어요. 아직 아무것도 넣지 않았어요. 이번 답은 "폰에서 골라 주세요"라고 짧게 끝내요. 고르면 이어서 하라고 알려 드려요.`
                      : `${name}에 가입할지(또는 이미 계정이 있는지) 사용자 폰에 물었어요. 아직 아무것도 넣지 않았어요. 이번 답은 "폰에서 골라 주세요"라고 짧게 끝내요. 고르면 이어서 하라고 알려 드려요.`,
                },
              ],
            }
          else
            throw new Error(
              '가입·비밀번호 변경은 사용자가 고른 뒤에만 해요. 사용자에게 "로그인할까요, 가입할까요?"를 먼저 물어 주세요.',
            )
        }
        // 아이디(이메일): AI가 정한 것, 없으면 내 정보 이메일
        let username = String(a.username ?? '').trim()
        if (!username && this.profile) username = profileValue(await this.profile.get(), 'email') ?? ''
        if (!username)
          throw new Error(
            '어떤 아이디로 가입·변경하는지 알려 주세요(username). 내 정보에 이메일이 없으면 browser_request_profile로 받아요.',
          )
        // 넣고 나서 칸에 실제로 들어간 길이를 본다: 칸이 글자 수를 막으면(maxlength) 잘려 들어가서,
        // 금고 값과 사이트 비밀번호가 달라진다. 그 길이에 맞춰 다시 만든다
        const fill = async (ref: string, value: string) => {
          const r = (await this.browser.call('fill', { tabId, ref, value, origin, password: true })) as
            | { length?: number }
            | undefined
          return typeof r?.length === 'number' ? r.length : undefined
        }
        // 사용자가 폰에서 직접 정했으면 그 값으로 (안 맞으면 다시 묻는다)
        const own = this.ownPw.get(key)
        let pw = own ?? makePassword()
        let got = await fill(pwRef, pw)
        if (own && got !== undefined && got !== pw.length) {
          this.ownPw.delete(key)
          this.disallowSignup(key)
          throw new Error(
            `사용자가 정한 비밀번호가 이 칸에 다 들어가지 않았어요(${got}자만 들어감). 화면의 비밀번호 규칙(자릿수·특수문자)을 읽어 사용자에게 한 줄로 알리고 browser_new_password를 다시 부르세요(폰에서 다시 골라요).`,
          )
        }
        // 칸이 만든 비밀번호를 그대로 받지 않으면 사람에게 넘기지 않고 폰에서 다시 묻는다 (사용자가 규칙에 맞게 직접 정할 수 있다)
        const askAgain = (why: string) => {
          this.disallowSignup(key)
          // 다시 부르면 같은 걸 또 넣지 않고 폰에서 직접 정하게 한다 (예전엔 '가입해 줘'를 허락으로 보고 같은 실패를 되풀이)
          this.pwNeedOwn.add(key)
          return new Error(
            `${why} 화면의 비밀번호 규칙(자릿수·허용 문자)을 읽어 사용자에게 한 줄로 알리고 browser_new_password를 다시 불러요. 다시 부르면 폰에 물어 사용자가 규칙에 맞는 비밀번호를 정할 수 있어요.`,
          )
        }
        // 한 번에·키로 넣기를 다 막는 보안 키패드 칸: 화면 키패드 버튼을 이름표대로 눌러 넣는다 (값은 AI에게 안 감)
        let viaKeypad = false
        if (got !== undefined && got !== pw.length && !own) {
          const kp = makeKeypadPassword()
          if (await this.keypadType(tabId, pwRef, kp)) {
            pw = kp
            got = kp.length
            viaKeypad = true
            if (confirmRef && !(await this.keypadType(tabId, confirmRef, kp)))
              throw askAgain('비밀번호 확인 칸의 보안 키패드를 누르지 못했어요.')
          }
        }
        if (got !== undefined && got !== pw.length) {
          if (got < 8) throw askAgain('이 칸은 넣은 비밀번호를 그대로 받지 않아요(글자가 빠짐).')
          pw = makePassword(got)
          got = await fill(pwRef, pw)
          if (got !== undefined && got !== pw.length)
            throw askAgain('이 칸은 넣은 비밀번호를 그대로 받지 않아요(특수문자를 빼는 칸일 수 있어요).')
        }
        if (confirmRef && !viaKeypad) {
          const c = await fill(confirmRef, pw)
          if (c !== undefined && c !== pw.length)
            throw new Error(
              '비밀번호 확인 칸에 같은 값이 다 들어가지 않았어요. 페이지를 다시 읽어 확인 칸(confirm) 표시가 맞는지 보고 browser_new_password를 다시 불러요.',
            )
        }
        // 금고에는 아직 넣지 않는다: 가입이 끝난 걸 화면에서 보면 넣는다 (실패·"이미 가입" 때 틀린 값이 남지 않게)
        this.ownPw.delete(key)
        this.pwNeedOwn.delete(key)
        this.pendingPw = this.pendingPw.filter((p) => p.key !== key)
        this.pendingPw.push({ key, origin, username, password: pw, purpose, at: Date.now() })
        return this.read(
          tabId,
          undefined,
          `${own ? '사용자가 정한' : '새'} 비밀번호(${pw.length}자)를 ${own ? '' : '만들어 '}"${pwRef}"${confirmRef ? `·"${confirmRef}"` : ''} 칸에 넣었어요(${username}). ` +
            '당신에게는 비밀번호가 오지 않아요. 나머지 칸을 채우고 가입·변경 버튼을 눌러 주세요. 완료 화면이 보이면 두리가 금고에 저장하고 알려 드려요. ' +
            '비밀번호 규칙(자릿수·특수문자)에 걸리면 사용자에게 알려 주세요.',
        )
      }
      case 'request_code': {
        // 인증번호: 사용자가 폰 카드에 넣은 번호를 본체가 그 칸에 바로 넣는다. AI는 번호를 보지 않는다
        const page = this.pages.get(tabId)
        if (!page) throw new Error('먼저 페이지를 읽어 주세요')
        const ref = String(a.ref ?? '')
        // 결제 비밀번호 키패드(숫자가 그림이고 자리가 섞인 버튼들): AI가 화면을 보고 숫자 → 버튼 표시를 짚고,
        // 사용자는 폰 보안 키패드로 넣는다. 본체가 그 순서대로 누른다 — AI는 비밀번호를 보지 않는다
        if (a.kind === 'pin' && a.box && typeof a.box === 'object') {
          // 버튼으로 안 잡히는 그림 키패드(실측 11-22 동행복권 케이뱅크 간편충전): 키패드 상자를 잘라 보여 주고
          // AI가 그림에서 숫자 0~9 자리를 짚게 한다. 사용자는 폰 보안 키패드로 넣고, 본체가 그 자리를 누른다
          const at = (a.keys_at && typeof a.keys_at === 'object' ? a.keys_at : {}) as Record<string, unknown>
          const kept = this.pinShots.get(tabId)
          if (!Object.keys(at).length || !kept) {
            const got = (await this.browser
              .call('element-shots', { tabId, refs: [], boxes: [a.box] }, 30_000)
              .catch(() => undefined)) as
              | { shots?: { data: string; rect?: { x: number; y: number; w: number; h: number } }[] }
              | undefined
            const shot = got?.shots?.[0]
            if (!shot?.rect || shot.rect.w < 60 || shot.rect.h < 60)
              throw new Error(
                '키패드를 찍지 못했거나 너무 작아요. browser_screenshot으로 화면을 보고 숫자 키패드 전체가 들어가는 상자를 box(화면 기준 0~1000)로 다시 짚어 주세요',
              )
            this.pinShots.set(tabId, { rect: shot.rect, at: Date.now() })
            return {
              content: [
                {
                  type: 'text',
                  text: '키패드를 잘라 왔어요. 그림에서 숫자 0~9 버튼의 가운데를 keys_at({"0":[x,y],"1":[x,y],…}, 이 그림 기준 0~1000)으로 짚어 같은 box로 다시 불러요. 0~9가 한 번씩 다 있어야 해요. 지우기·재배열은 넣지 않아요. 화면을 사용자에게 넘기지 않아요.',
                },
                { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
              ],
            }
          }
          const points: Record<string, PinKey> = {}
          for (const d of '0123456789') {
            const v = at[d]
            const xy = Array.isArray(v) ? v.map(Number) : []
            const [px, py] = xy
            if (
              px === undefined ||
              py === undefined ||
              !Number.isFinite(px) ||
              !Number.isFinite(py) ||
              px < 0 ||
              px > 1000 ||
              py < 0 ||
              py > 1000
            )
              throw new Error(
                `숫자 ${d}의 자리가 없어요. 잘라 본 그림에서 0~9 버튼 가운데를 모두 [x, y](0~1000)로 짚어 keys_at에 넣어 주세요.`,
              )
            points[d] = {
              x: Math.round(kept.rect.x + (px / 1000) * kept.rect.w),
              y: Math.round(kept.rect.y + (py / 1000) * kept.rect.h),
            }
          }
          const spots = new Set(
            Object.values(points).map((p) =>
              typeof p === 'object' ? `${Math.round(p.x / 8)},${Math.round(p.y / 8)}` : p,
            ),
          )
          if (spots.size !== 10)
            throw new Error(
              '두 숫자를 같은 자리로 짚었어요. 그림을 다시 보고 0~9를 서로 다른 버튼으로 짚어 주세요.',
            )
          if (!this.requestPin)
            throw new Error(
              '지금은 폰 키패드 카드를 띄울 수 없어요(폰 연결이 없어요). 사용자에게 폰에서 두리 앱 연결을 확인해 달라고 한 줄로 말하고 이번 답을 끝내요.',
            )
          let host = ''
          try {
            host = new URL(page.url).hostname
          } catch {}
          const len = Math.min(Math.max(Number(a.length) || 6, 4), 8)
          const id = this.requestPin(tabId, String(a.label ?? '') || '결제 비밀번호', host, points, len)
          if (!id) throw new Error('키패드 카드를 띄우지 못했어요')
          this.pinShots.delete(tabId)
          this.hold(tabId, 10 * 60_000)
          return {
            content: [
              {
                type: 'text',
                text: `폰에 보안 키패드 카드를 띄웠어요(${len}자리). 사용자에게 "폰에 뜬 키패드에 비밀번호를 넣어 주세요"처럼 한 문장으로 말하고 이번 답을 끝내요. 넣으면 본체가 화면 키패드를 대신 누르고 다음 메시지로 알려 줘요.`,
              },
            ],
          }
        }
        if (a.kind === 'pin') {
          const keys = (a.keys && typeof a.keys === 'object' ? a.keys : {}) as Record<string, unknown>
          // 짚기 전: 키패드 버튼들(key_refs)을 하나씩 잘라 보여 주고 AI가 버튼마다 숫자를 읽게 한다.
          // 화면 한 장에서 자리로 맞추면 틀리기 쉽다 (실측 쿠팡: 비밀번호가 틀렸다고 나왔다)
          if (!Object.keys(keys).length) {
            const list = (Array.isArray(a.key_refs) ? a.key_refs : [])
              .map(String)
              .filter((r) => page.refs.has(r))
            if (list.length < 10)
              throw new Error(
                '키패드 버튼 표시들을 key_refs에 모두 넣어(숫자 버튼 10개, 지우기 등 포함 가능) 다시 불러 주세요. 버튼마다 잘라 보여 드릴게요. 키패드가 버튼으로 안 잡히는 그림이면 browser_screenshot으로 보고 키패드 전체 상자를 box(화면 기준 0~1000)로 짚어 kind: "pin"으로 불러요 — 화면을 사용자에게 넘기거나 그림 눌러 풀기 카드를 쓰지 않아요.',
              )
            const got = (await this.browser
              .call('element-shots', { tabId, refs: list }, 30_000)
              .catch(() => undefined)) as { shots?: { ref: string; data: string }[] } | undefined
            const shots = got?.shots ?? []
            if (shots.length < 10)
              throw new Error('키패드 버튼을 찍지 못했어요. 페이지를 다시 읽고 다시 불러 주세요')
            return {
              content: [
                {
                  type: 'text',
                  text: '키패드 버튼을 하나씩 잘랐어요. 그림마다 보이는 숫자를 읽어 keys({"0":"e…","1":"e…",…})에 넣고 같은 칸으로 다시 불러요. 숫자가 아닌 버튼(지우기·재배열)은 넣지 않아요. 0~9가 한 번씩 다 있어야 해요.',
                },
                ...shots.flatMap((sh) => [
                  { type: 'text' as const, text: sh.ref },
                  { type: 'image' as const, data: sh.data, mimeType: 'image/jpeg' },
                ]),
              ],
            }
          }
          const map: Record<string, string> = {}
          for (const d of '0123456789') {
            const r = String(keys[d] ?? '')
            if (!page.refs.has(r))
              throw new Error(
                `숫자 ${d}의 버튼 표시가 없어요. 잘라 본 그림에서 0~9를 모두 짚어 keys에 넣어 주세요.`,
              )
            map[d] = r
          }
          // 한 버튼을 두 숫자로 짚었으면 잘못 읽은 것이다 (누르면 비밀번호가 틀려 잠길 수 있다)
          if (new Set(Object.values(map)).size !== 10)
            throw new Error(
              '같은 버튼을 두 숫자로 짚었어요. 잘라 본 그림을 다시 보고 0~9를 서로 다른 버튼으로 짚어 주세요.',
            )
          if (!this.requestPin)
            throw new Error(
              '지금은 폰 키패드 카드를 띄울 수 없어요(폰 연결이 없어요). 사용자에게 폰에서 두리 앱 연결을 확인해 달라고 한 줄로 말하고 이번 답을 끝내요.',
            )
          let host = ''
          try {
            host = new URL(page.url).hostname
          } catch {}
          const len = Math.min(Math.max(Number(a.length) || 6, 4), 8)
          const id = this.requestPin(tabId, String(a.label ?? '') || '결제 비밀번호', host, map, len)
          if (!id) throw new Error('키패드 카드를 띄우지 못했어요')
          this.hold(tabId, 10 * 60_000)
          return {
            content: [
              {
                type: 'text',
                text: `폰에 ${len}자리 보안 키패드 카드를 띄웠어요. 사용자에게 "폰에 뜬 키패드에 결제 비밀번호를 넣어 주세요"처럼 한 문장으로 말하고 이번 답을 끝내세요. 넣으면 두리가 짚어 둔 버튼을 차례로 누르고 알려 줘요. 그때 화면을 읽어 이어 가고, 주문 완료 화면과 주문번호가 보이면 browser_order_done으로 끝내요.`,
              },
            ],
          }
        }
        if (!this.requestCode)
          throw new Error(
            '지금은 폰 인증번호 카드를 띄울 수 없어요(폰 연결이 없어요). 사용자에게 폰에서 두리 앱 연결을 확인해 달라고 한 줄로 말하고 이번 답을 끝내요.',
          )
        const target = page.refs.get(ref)
        if (!target || !['입력칸', '검색칸'].includes(target.role))
          throw new Error(
            `${ref}는 인증번호를 넣는 칸이 아니에요. 페이지를 다시 읽어 칸 표시를 확인해 주세요`,
          )
        // 보안문자: 칸 둘레를 잘라 AI에게 보여 주고 AI가 고른 그림(pick)을 카드에 붙인다 (그림 고르기를 규칙으로 하지 않는다)
        let image: string | undefined
        if (a.kind === 'captcha') {
          const got = (await this.browser
            .call('captcha-candidates', { tabId, ref }, 30_000)
            .catch(() => undefined)) as { shots?: { what: string; data: string }[] } | undefined
          const shots = got?.shots ?? []
          const pick = Number(a.pick)
          if (!Number.isInteger(pick) || pick < 1 || pick > shots.length) {
            if (!shots.length)
              throw new Error(
                '칸 둘레 그림을 찍지 못했어요. browser_screenshot으로 화면을 보고 칸을 다시 짚어 주세요',
              )
            return {
              content: [
                {
                  type: 'text',
                  text: `보안문자 칸(${ref}) 둘레를 ${shots.length}장 잘랐어요. 일그러진 글자·숫자가 또렷하게 다 보이는 그림의 번호를 골라 같은 칸으로 browser_request_code를 kind: "captcha", pick: 번호로 다시 부르세요. 어느 것에도 보안문자가 없으면 browser_screenshot으로 화면을 보고 칸을 다시 짚어요. 글자는 네가 읽어 넣지 말고 사용자에게 받는다.`,
                },
                ...shots.flatMap((sh, i) => [
                  { type: 'text' as const, text: `${i + 1}. ${sh.what}` },
                  { type: 'image' as const, data: sh.data, mimeType: 'image/jpeg' },
                ]),
              ],
            }
          }
          image = shots[pick - 1]?.data
        }
        // 화면의 안내 한 줄 ("휴대폰으로 보낸 6자리를 넣어 주세요")
        const snap = (await this.browser
          .call('snapshot', { tabId, maxChars: 12_000 })
          .catch(() => undefined)) as { text?: string } | undefined
        const hint =
          (snap?.text ?? '')
            .split('\n')
            .map((l: string) =>
              l
                .replace(/\[[^\]]*\]/g, '')
                .replace(/^\s*(#+|[-*•]|\d+\.)\s*/, '')
                .trim(),
            )
            .find((l: string) => l.length >= 8 && l.length <= 80 && /인증|번호|보냈|문자|발송/.test(l)) ?? ''
        let host = ''
        try {
          host = new URL(page.url).hostname
        } catch {}
        const id = this.requestCode(
          tabId,
          target.name,
          String(a.label ?? '') || target.name || '인증번호',
          hint,
          host,
          a.kind === 'rrn_back' ? 'rrn_back' : a.kind === 'captcha' ? 'captcha' : 'code',
          ref,
          image,
        )
        if (!id) throw new Error('인증번호 카드를 띄우지 못했어요')
        // 사용자가 카드에 넣을 때까지 탭을 닫지 않는다
        this.hold(tabId, 10 * 60_000)
        return {
          content: [
            {
              type: 'text',
              text: '폰에 인증번호 카드를 띄웠어요. 사용자에게 "폰에 온 인증번호를 카드에 넣어 주세요"처럼 한 문장으로 말하고 이번 답을 끝내세요. 번호가 칸에 들어가면 다음 메시지로 알려 줘요. 그때 [확인]을 눌러 이어 가요.',
            },
          ],
        }
      }
      case 'request_tap': {
        // 그림 눌러 풀기: 그 상자만 잘라 폰에 보내고, 사용자가 누른 곳을 같은 자리에 누른다 (사람에게 PC 화면을 넘기지 않는다)
        if (!this.requestTap) throw new Error('그림 카드를 띄울 수 없어요')
        const page = this.pages.get(tabId)
        if (!page) throw new Error('먼저 페이지를 읽어 주세요')
        // 그림에는 표시가 없는 일이 많다: 표시(ref)가 있으면 그 자리, 없으면 화면 사진에서 짚은 상자(box, 0~1000)
        const ref = a.ref ? String(a.ref) : ''
        const box = a.box && typeof a.box === 'object' ? (a.box as Record<string, unknown>) : undefined
        if (ref && !page.refs.has(ref))
          throw new Error(
            `${ref} 표시가 없어요. 그림에는 표시가 없는 일이 많아요. browser_screenshot으로 화면을 보고 문제 그림·지도가 다 들어가는 상자를 box(화면 기준 0~1000)로 짚어 주세요`,
          )
        if (!ref && !box)
          throw new Error(
            'browser_screenshot으로 화면을 보고 문제 글·그림·지도가 다 들어가는 상자를 box: {x, y, w, h}(화면 왼쪽 위 0, 오른쪽·아래 끝 1000)로 넉넉하게 짚어 주세요',
          )
        const got = (await this.browser
          .call('element-shots', ref ? { tabId, refs: [ref] } : { tabId, refs: [], boxes: [box] }, 30_000)
          .catch(() => undefined)) as
          | { shots?: { ref: string; data: string; rect?: { x: number; y: number; w: number; h: number } }[] }
          | undefined
        const shot = got?.shots?.[0]
        if (!shot?.rect || shot.rect.w < 40 || shot.rect.h < 40)
          throw new Error(
            '그 자리를 찍지 못했거나 너무 작아요. browser_screenshot으로 화면을 보고 문제 그림이 다 들어가는 상자를 box로 다시 짚어 주세요',
          )
        let host = ''
        try {
          host = new URL(page.url).hostname
        } catch {}
        const say =
          String(a.say ?? '')
            .trim()
            .slice(0, 80) || '그림에서 맞는 곳을 눌러 주세요'
        const taps = Math.min(9, Math.max(1, Math.round(Number(a.taps) || 1)))
        const id = this.requestTap(tabId, say, host, shot.data, shot.rect, taps)
        if (!id) throw new Error('그림 카드를 띄우지 못했어요')
        this.hold(tabId, 10 * 60_000)
        return {
          content: [
            {
              type: 'text',
              text: '폰에 그림 카드를 띄웠어요. 사용자에게 "폰 카드의 그림에서 맞는 곳을 눌러 주세요"처럼 한 문장으로 말하고 이번 답을 끝내세요. 누르면 두리가 PC 화면의 같은 자리를 누르고 다음 메시지로 알려 줘요. 그때 화면을 다시 읽어 [확인]·[제출]을 눌러 이어 가요.',
            },
          ],
        }
      }
      case 'request_profile': {
        if (!this.profile || !this.requestProfile) throw new Error('내 정보 카드를 띄울 수 없어요')
        const all = Object.keys(PROFILE_FIELDS) as ProfileField[]
        const asked = (Array.isArray(a.fields) ? a.fields : [])
          .map(String)
          .filter((f): f is ProfileField => all.includes(f as ProfileField))
        const { missing } = await this.profile.masked()
        // 주민번호 뒷자리는 본인인증 칸에서 보안 키패드로 따로 받는다 (내 정보 카드 기본 목록에는 넣지 않는다)
        const fields = asked.length
          ? asked.filter((f) => f !== 'rrn_back')
          : missing.filter((f) => f !== 'rrn_back')
        if (!fields.length) throw new Error('내 정보가 모두 있어요. browser_fill_profile로 채우세요')
        const options = (Array.isArray(a.options) ? a.options : [])
          .map((o) => String(o).trim().slice(0, 20))
          .filter(Boolean)
        const id = this.requestProfile(fields, String(a.reason ?? '').slice(0, 120), options)
        if (!id) throw new Error('내 정보 카드를 띄우지 못했어요')
        return {
          content: [
            {
              type: 'text',
              text:
                `내 정보 카드를 띄웠어요(${fields.map((f) => PROFILE_FIELDS[f].label).join('·')}). 카드가 답을 기다리는 동안 이 정보 없이 되는 일(대상 여부 판단·가격과 후보 조사·서류 읽기·서울 기준 후보·준비 목록)을 지금 마저 하고, 그 결과를 답에 담은 뒤 끝에 "카드에 한 번만 넣어 주시면 다음부터는 제가 알아서 채워요"처럼 한 문장을 붙여 답을 끝내세요. 카드 안내만 하고 끝내지 않아요. ` +
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
            '암호화(https)되지 않은 주소라 로그인 정보를 금고에 받지 않아요. 같은 서비스의 https 주소로 다시 열어 해 보고, 그런 주소가 없으면 사용자에게 이 사이트는 암호화되지 않아 로그인을 맡을 수 없다고 한 줄로 알려요.',
          )
        // 카드로 받았는데 로그인에 실패한 값은 이미 지웠다. 아직 확인 전인 값은 다시 받을 수 있다
        if ((await this.vault?.findForOrigin(origin)) && !this.unverified.has(origin))
          return {
            content: [
              { type: 'text', text: '이 사이트는 이미 두리 금고에 있어요. browser_login으로 채우세요.' },
            ],
          }
        // 연결해 둔 서비스면(금고 계정·간편 로그인) 사람에게 묻지 않고 본체가 다시 로그인한다
        // (실측 11-22 대한항공: 세션이 풀리자 네이버로 연결해 둔 곳인데도 로그인 카드부터 띄웠다)
        const relogin = await this.reloginFor?.(origin).catch(() => undefined)
        if (relogin)
          return {
            content: [
              {
                type: 'text',
                text: `이 사이트는 연결해 둔 방법(금고 계정 또는 전에 쓴 간편 로그인)이 있어 로그인 카드를 띄우지 않았어요. connect_ask("${relogin}")를 부르면 두리 본체가 카드 없이 다시 로그인하고, 끝나면 알려 줘요. 사용자에게는 "다시 로그인하고 이어서 할게요"처럼 한 문장만 말해요.`,
              },
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
      case 'wait_auth': {
        // 간편인증 승인 기다리기: 사람에게 넘기고 [다 했어요]를 기다리면 그사이 인증이 만료된다(실측).
        // 폰에 알리고, 몇 초마다 [인증 완료]를 눌러 승인됐는지 본다. "서명되지 않았습니다" 같은 글이 보이면 아직이다.
        // 인증 창이 팝업(새 탭)으로 뜨는 사이트(홈택스)가 있어, 두리가 최근에 연 탭들도 함께 본다
        const msg = String(a.message ?? '').trim() || '폰의 인증 앱에서 승인해 주세요'
        this.notifyUser?.('인증 앱에서 승인해 주세요', msg)
        // 탭만 열어 둔다. 폰 원격 화면 준비(holdForPerson)는 하지 않는다 — 화면이 바뀌어 인증 창이 닫혔다(실측)
        this.hold(tabId, 200_000)
        // 됐는지·아직인지는 글자 규칙으로 가리지 않는다(안내 문구 "…진행해주세요"를 아직으로 읽어 카드만 거듭 띄웠다, 실측 K-패스).
        // 화면에 구조 변화(주소·확인 창·인증 창 닫힘·버튼 바뀜)가 생기거나 사용자가 [인증 완료했어요]를 누르면 화면을 AI에게 넘긴다
        const buttons = (text: string) =>
          [...text.matchAll(/\[(e\d+) (?:버튼|링크) "([^"]*)"\]/g)].map((m) => ({
            ref: m[1] as string,
            name: m[2] as string,
          }))
        const buttonSet = (text: string) =>
          buttons(text)
            .map((b) => b.name.trim())
            .filter(Boolean)
            .sort()
            .join('|')
        const snap = (t: number) =>
          this.browser.call('snapshot', { tabId: t, maxChars: 40_000 }).catch(() => undefined) as Promise<
            Snapshot | undefined
          >
        // 볼 탭: 짚어 준 탭 + 두리가 최근에 읽은 다른 탭(팝업) 3개까지
        const tabs = [tabId, ...[...this.pages.keys()].filter((t) => t !== tabId).slice(-3)]
        const first = new Map<number, Snapshot>()
        for (const t of tabs) {
          const f = await snap(t)
          if (f) first.set(t, f)
        }
        const started = Date.now()
        const expired = () =>
          this.notifyUser?.('인증 시간이 지났어요', '다시 하려면 두리에게 "다시 해 줘"라고 해 주세요')
        let host = ''
        try {
          host = new URL(this.pages.get(tabId)?.url ?? '').hostname
        } catch {}
        // 승인 전에 [인증 완료]를 누르면 인증 창을 닫아 버리는 사이트가 있다(실측 홈택스: 요청 6초 뒤 창이 사라졌다).
        // 그래서 기다리는 동안은 아무것도 누르지 않고 지켜보기만 한다
        const card = (label: string) =>
          this.askAuthDone?.(
            host,
            label,
            '인증 앱(카카오톡·네이버·토스·PASS)에 온 알림에서 승인한 뒤 눌러 주세요.',
          )
        const waiting = card(msg)
        let pressedByUser = false
        if (waiting)
          void waiting.answer.then((v) => {
            if (v) pressedByUser = true
          })
        // 화면이 바뀐 표시: 주소가 바뀌었거나, 확인 창이 새로 떴거나, 인증 창(다른 탭)이 닫혔거나, 버튼 묶음이 바뀌었을 때
        const changed = async (): Promise<{ main: Snapshot; why: string } | undefined> => {
          for (const t of tabs) {
            const was = first.get(t)
            if (!was) continue
            const now = await snap(t)
            const main = async () => (t === tabId ? now : await snap(tabId))
            if (!now) {
              // 인증 팝업이 닫혔다 (승인 뒤 스스로 닫는 사이트가 많다)
              if (t === tabId) continue
              const m = await snap(tabId)
              if (m) return { main: m, why: '인증 창이 닫혔어요' }
              continue
            }
            if (now.dialog && !was.dialog)
              return { main: (await main()) ?? now, why: '사이트 확인 창이 떴어요' }
            if (now.url !== was.url && (t === tabId || !/about:blank/.test(now.url)))
              return { main: (await main()) ?? now, why: '주소가 바뀌었어요' }
            if (buttonSet(now.text) !== buttonSet(was.text)) {
              // 요청을 보낸 직후엔 사이트 버튼이 '재요청'·남은 시간 등으로 곧바로 바뀐다. 사람이 인증 앱에서 승인하기엔
              // 너무 이르니 기준만 새로 잡고 계속 기다린다 (실측 11-22 삼성화재: 10초 안에 두 번 끝내 폰 카드가 사라졌다)
              if (Date.now() - started < 20_000) {
                first.set(t, now)
                continue
              }
              return { main: (await main()) ?? now, why: '화면 버튼이 바뀌었어요' }
            }
          }
          return undefined
        }
        const others = tabs.filter((t) => t !== tabId)
        const judge =
          '아래 화면을 보고 직접 판단하세요: 인증이 됐다는 글이나 다음 단계가 보이면 이어서 하고, 다음으로 가는 버튼(인증 완료·인증 확인·확인·다음 — 안 보이면 browser_scroll로 내려서)이 있으면 눌러요' +
          `${others.length ? `. 인증 창이 다른 탭일 수 있어요(탭 ${others.join(', ')}) — browser_read로 보세요` : ''}. ` +
          '화면이 인증이 아직 안 됐다고 하면 그때만 browser_wait_auth를 다시 불러 사용자에게 다시 물어요(카드가 다시 떠요). 이어 가기 전에 "인증이 완료됐어요. 이어서 ○○할게요"처럼 한 줄 써요(진행 카드에 바로 보여요).'
        const handBack = (main: Snapshot, why: string) => {
          waiting?.cancel()
          this.pages.set(tabId, pageInfo(main.url, main.text))
          return this.read(tabId, undefined, `${why}. ${judge}`)
        }
        while (Date.now() - started < 180_000) {
          await new Promise((r) => setTimeout(r, 3_000))
          const c = await changed()
          if (c) {
            this.onNote?.('wait-auth', { by: 'screen', why: c.why, url: c.main.url.replace(/[?#].*$/, '') })
            return handBack(c.main, `인증을 기다리는 동안 화면이 바뀌었어요(${c.why})`)
          }
          if (!pressedByUser) continue
          // 사용자가 승인했다고 했다. AI가 짚어 둔 버튼(ref)이 있으면 그것만 한 번 누르고, 화면을 AI에게 넘긴다
          let pressed = ''
          if (typeof a.ref === 'string') {
            const now = await snap(tabId)
            const btn = now && buttons(now.text).find((b) => b.ref === a.ref)
            if (btn) {
              await this.browser.call('click', { tabId, ref: btn.ref }, 30_000).catch(() => undefined)
              await new Promise((r) => setTimeout(r, 2_500))
              pressed = btn.name
            }
          }
          this.onNote?.('wait-auth', { by: 'user', pressed })
          const main = (await snap(tabId)) ?? first.get(tabId)
          if (!main) break
          return handBack(
            main,
            `사용자가 인증 앱에서 승인하고 [인증 완료했어요]를 눌렀어요.${pressed ? ` 두리가 짚어 둔 [${pressed}]를 한 번 눌렀어요.` : ''}`,
          )
        }
        waiting?.cancel()
        expired()
        return {
          content: [
            {
              type: 'text',
              text: '3분 동안 승인이 확인되지 않아 기다리기를 멈췄어요(인증 요청도 곧 만료돼요). 다시 요청하지 말고, 사용자에게 "인증 시간이 지나 멈췄어요. 다시 하려면 \'다시 해 줘\'라고 해 주세요"처럼 짧게 답하고 이번 답을 끝내요.',
            },
          ],
        }
      }
      case 'order_done':
        return this.orderDone(tabId, a)
      case 'handoff': {
        // 사람이 해야 하는 일(로그인·캡차·본인인증·마지막 버튼): 두리 탭을 앞으로 띄우고 이번 답을 끝내게 한다.
        // 화면은 이 도구 호출을 보고 [Chrome에서 보기] [다 했어요]를 띄운다.
        // 사용자는 폰만 들고 있다 — PC 화면 넘기기는 거의 늘 고칠 곳이었다(실측: 금융인증서 창 휴대폰번호 칸을 못 읽어 넘김).
        // 그래서 같은 화면에서 처음 부르면 넘기지 않고 화면을 다시 읽어 돌려준다. 두 번째에만 넘긴다
        let where = ''
        try {
          where = new URL(this.pages.get(tabId)?.url ?? '').pathname
        } catch {}
        const key = `${tabId}:${where}`
        // 사용자 결정 11-20: PC 화면 넘기기 금지 — 폰 카드로 안 되는 비상(emergency)일 때만
        if (a.emergency !== true) {
          const again = await this.read(
            tabId,
            undefined,
            '넘기지 않았어요. PC 화면 넘기기는 금지예요(사용자 결정). 사람 몫은 폰 카드로 받아요: 결제 비밀번호 키패드·인증번호·인증서 비밀번호는 browser_request_code, 로봇 확인 그림은 browser_request_tap, 고를 것·결제는 browser_checkout·browser_request_approval, 내 정보는 browser_fill_profile. 화면이 잘려 안 보이면 browser_scroll·browser_read로 보이게 하고 다시 해요. 같은 길이 막히면 다른 길을 찾아요. 사용자에게 PC·다른 앱에서 직접 하라고 말하지 않아요. 정말 폰 카드로 안 되는 비상일 때만 emergency: true로 다시 불러요.',
          )
          return { ...again, isError: true }
        }
        if (!this.handoffChecked.has(key)) {
          this.handoffChecked.add(key)
          const again = await this.read(
            tabId,
            undefined,
            '아직 넘기지 않았어요. 사용자는 폰만 들고 있어 PC 화면을 만지기 어려워요. 화면을 다시 읽었어요(아래, 화면 안 액자와 "(화면에 보이는 칸)" 포함). ' +
              '여기 있는 칸·버튼으로 할 수 있으면 직접 하세요: 이름·휴대폰번호·생년월일은 browser_fill_profile, 문자 인증번호·인증서 비밀번호·PIN은 browser_request_code(폰 키패드 카드), 인증 앱 승인은 browser_wait_auth, 고를 것은 browser_request_approval, 그림을 눌러 푸는 로봇 확인은 browser_request_tap(폰에 그림 카드). ' +
              '그래도 사람 손이 꼭 필요하면 그때 browser_handoff를 다시 부르세요.',
          )
          // 실패로 돌려준다: 대화에 [PC 화면 넘기기] 카드가 남지 않게 (실제로 넘길 때만 남는다)
          return { ...again, isError: true }
        }
        await this.browser.call('focus', { tabId })
        this.holdForPerson(tabId)
        this.watchHandoff(tabId)
        return {
          content: [
            {
              type: 'text',
              text:
                '폰에 이 화면의 필요한 칸만 담은 카드를 띄웠어요. 사용자에게 "폰에 뜬 카드에서 ○○ 칸만 직접 넣어 주세요"처럼 무엇을 넣을지 한두 문장으로 말하고(PC 화면·두리 탭을 보라고 하지 말고) 이번 답은 여기서 끝내세요. ' +
                '사용자가 마치면(화면이 바뀌거나 [다 했어요]) 두리 본체가 알아채 다음 메시지로 이어서 하라는 알림이 와요. 그때 페이지를 다시 읽어 확인하고 이어 가세요. 사용자에게 "다 하면 말해 달라"고 하지 않아요.',
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
        const label = `${target.role} ${target.name}`
        const risk = classifyRisk(label)
        // AI가 화면을 보고 "이게 돈이 나가는(보내는·지우는) 마지막 버튼"이라고 선언했다
        const declared = s.final === true
        // 결제 묶음 안: 결제 회사 창(새 탭·화면 안 액자·결제 회사로 넘어간 주문서 탭)의 [카드 선택]·[다음]·[동의]·[결제하기]는
        // 사용자가 이미 승인한 같은 결제다. 다시 묻지 않는다 (실측 11-20 G마켓: 결제 창 안 [다음]이 또 승인을 요구해 멈췄다)
        const provider = this.inProvider(tabId, page.url, ref)
        // '신청하기'·'등록하기' 같은 말이라도 다른 화면으로 가기만 하는 진짜 링크는 승인 없이 누른다
        // (정부24는 조회만 하는 서비스도 들어가는 버튼이 '신청하기'). 결제 쪽 이름이라도 진짜 링크는 화면을 열 뿐이다
        // (실측 혜택 16: '페이' 메뉴 링크가 결제로 막혀 출석 체크를 못 했다). 지우기류는 GET 링크도 있어 그대로 막는다
        const navOnly =
          !declared &&
          !provider &&
          target.role === '링크' &&
          (risk?.kind === 'contact' || risk?.kind === 'money') &&
          (
            (await this.browser.call('link-navigates', { tabId, ref }).catch(() => undefined)) as
              | { navigates?: boolean }
              | undefined
          )?.navigates === true
        // 배송지를 바꾼 뒤 누르는, 이미 승인받은 그 결제 버튼 (한 번)
        const passed = !provider && !navOnly ? this.usePass(tabId, target.name) : undefined
        // AI가 화면을 보고 "결제 화면으로 넘어가기만 하는 버튼"이라고 판단했다(opens_checkout). 돈 말이 있는 버튼만 해당.
        // 누른 뒤 주문이 바로 확정된 화면이면 읽기 결과에서 크게 알린다 (안전장치)
        // 안전장치: 그 자체로 돈이 나가는 이름([결제하기]·[Place order]·[예약 확정])은 opens_checkout으로도 넘기지 않는다
        const opens =
          !declared &&
          !provider &&
          !navOnly &&
          !passed &&
          s.opens_checkout === true &&
          risk?.kind === 'money' &&
          !payNow(target.name)
        const gated = !provider && !navOnly && !passed && !opens && (declared || risk !== undefined)
        // 여러 개를 한 번에 승인받은 보내기·지우기는 남은 개수만큼 그대로 누른다 (결제는 묶지 않는다)
        if (gated && !(risk && !declared && this.useSeries(page.url, risk.kind)))
          throw new Error(this.gateText(ref, target.name, risk, declared))
        const r = (await this.browser.call(
          'click',
          { tabId, ref, ...(s.force === true ? { force: true } : {}) },
          30_000,
        )) as BrowserState & {
          newTabId?: number
          coveredBy?: string
          delivered?: boolean
        }
        // 결제 중인 탭에서 새 창이 뜨면 그 창도 같은 결제 묶음이다. 승인받은 결제 버튼이면 여기서 결제 묶음을 연다
        const ses = this.paySession(tabId)
        if (ses && r.newTabId) this.joinSession(ses, r.newTabId)
        if (passed) this.startSession(passed, tabId, page.url, target.name, r.newTabId ? [r.newTabId] : [])
        const note = [
          `${target.role} "${target.name}"을(를) 눌렀어요.`,
          provider && (risk || declared) ? '(결제 중인 묶음 안의 단계라 다시 승인받지 않고 눌렀어요.)' : '',
          navOnly
            ? '(다른 화면으로 가기만 하는 링크라 승인 없이 눌렀어요. 그 화면에서 실제로 제출하는 버튼은 승인을 받아요.)'
            : '',
          opens
            ? '(결제 화면으로 넘어가는 버튼이라고 보고 승인 없이 눌렀어요. 결제 화면의 마지막 버튼은 browser_checkout으로 한 번 승인받아요. 혹시 주문이 바로 확정됐으면 사용자에게 바로 알려요.)'
            : '',
          passed
            ? '(이미 승인받은 결제 버튼이라 그대로 눌렀어요. 결제 창까지 끝내고 주문 완료 화면의 주문번호로 browser_order_done을 불러요.)'
            : '',
          r.coveredBy ? `(그 자리를 "${r.coveredBy}"이(가) 덮고 있었어요. 팝업이면 먼저 닫아 주세요.)` : '',
          // 마우스가 그 요소에 닿지 않았다는 확장의 신호: '눌렀어요'로 끝내지 말고 AI가 화면을 보고 판단하게 (11-20 시험 가게)
          r.delivered === false
            ? '(누른 입력이 그 요소에 닿지 않았을 수 있어요. 화면이 바뀌었는지 다시 읽어 확인하고, 그대로면 다시 눌러요.)'
            : '',
        ]
          .filter(Boolean)
          .join(' ')
        return { note, ...state(r), ...(r.newTabId ? { newTabId: r.newTabId } : {}) }
      }
      case 'type': {
        const ref = String(s.ref ?? '')
        const page = this.pages.get(tabId)
        if (!page?.refs.has(ref)) throw new Error(`${ref}가 무엇인지 몰라요. 먼저 페이지를 읽어 주세요`)
        // Enter는 마지막 버튼이 아니다: 막지 않는다 (실측 11-20 G마켓 주소 찾기 Enter가 결제로 막혀 빈 결과).
        // 돈이 나가는 건 AI가 browser_checkout으로 올린 버튼뿐이다
        const text = String(s.text ?? '')
        const r = (await this.browser.call('type', {
          tabId,
          ref,
          text,
          submit: Boolean(s.submit),
        })) as BrowserState & { drawn?: boolean; seen?: boolean }
        const name = page.refs.get(ref)?.name
        const where = name ? `"${name}"에 ` : ''
        const done = s.submit ? `${where}입력하고 Enter를 눌렀어요.` : `${where}입력했어요.`
        // 편집기가 그린 자리(글 칸이 아닌 제목·본문 상자)는 눌러서 넣는다. 넣은 글이 화면에 안 보이면 그대로 알린다
        // (복사해 붙여 넣으라고 사람에게 넘기지 않고 AI가 화면을 보고 다시 하게)
        const spot = name ? `"${name}" 자리를` : '그 자리를'
        const note = !r.drawn
          ? done
          : r.seen === false
            ? `${spot} 눌러 글을 넣었지만 넣은 글이 화면에 보이지 않아요. browser_screenshot으로 확인하고, 안 들어갔으면 그 자리를 browser_click으로 누른 뒤 다시 넣어요.`
            : `${spot} 눌러 ${s.submit ? '입력하고 Enter를 눌렀어요' : '입력했어요'} (넣은 글이 화면에 보여요).`
        return { note, ...state(r) }
      }
      case 'press': {
        const key = String(s.key ?? '')
        // Enter도 그대로 누른다 (마지막 버튼이 아니다. 위 type과 같은 까닭)
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

  /** 고칠 때 볼 일한 기록 (못 읽은 결제 화면 목록의 모양 등) */
  onNote?: (kind: string, data: Record<string, unknown>) => void
  /** 화면 그림 남기기 (logs/shots) */
  onShot?: (label: string, base64: string) => void

  /** 펼침 목록의 고를 것 (확장이 못 읽으면 undefined, 그 이유는 일한 기록에) */
  private async selectOptions(tabId: number, ref: string) {
    const r = (await this.browser.call('options', { tabId, ref }, 15_000).catch(() => undefined)) as
      | { options?: { label: string; selected: boolean }[] | null; why?: string }
      | undefined
    if (!r?.options && r?.why) {
      let host = ''
      try {
        host = new URL(this.pages.get(tabId)?.url ?? '').hostname
      } catch {}
      this.onNote?.('select-unread', { host, ref, why: r.why })
    }
    return r?.options ?? undefined
  }

  /** 결제 화면의 세부 결제 선택 묶음 (등록 카드·할부). 많아야 3묶음, 묶음마다 12개 */
  private async subChoices(tabId: number, page: PageInfo) {
    const out: {
      key: string
      title: string
      ref: string
      options: string[]
      selected: number
      /** 이 사이트에서 지난번에 고른 것이 기본값인지 */
      remembered: boolean
    }[] = []
    let host = ''
    try {
      host = new URL(page.url).hostname
    } catch {}
    const selects = [...page.refs].filter(([, v]) => v.role === '선택 상자').slice(0, 6)
    for (const [ref] of selects) {
      if (out.length >= 3) break
      let opts = (await this.selectOptions(tabId, ref))?.slice(0, 40)
      if (!opts) continue
      const title = subChoiceTitle(opts.map((o) => o.label))
      if (!title) continue
      // 카드 목록에 등록 카드(번호 일부가 가려진 것)가 있으면 그것만: 뒤에 붙은 카드사 이름은 새 카드 등록이다
      // (실측 쿠팡: 등록 카드 4장 뒤에 'KB국민카드·삼성카드…'가 이어진다)
      const saved = opts.filter((o) => /\*{3,}/.test(o.label))
      if (title === '카드' && saved.length) opts = saved
      opts = opts.slice(0, 12)
      // 기본값: 이 사이트에서 지난번에 고른 카드·할부가 목록에 있으면 그것, 없으면 화면에 골라진 것
      const remembered = opts.findIndex((o) => o.label === this.lastSub.get(`${host}|${title}`))
      out.push({
        key: `s${out.length + 1}`,
        title,
        ref,
        options: opts.map((o) => o.label),
        remembered: remembered >= 0,
        selected:
          remembered >= 0
            ? remembered
            : Math.max(
                0,
                opts.findIndex((o) => o.selected),
              ),
      })
    }
    return out
  }

  /** 승인 때 본 펼침 목록을 지금 화면에서 찾는다 (표시가 같으면 그것, 아니면 고를 것이 같은 목록) */
  private async findSelect(
    tabId: number,
    refs: Map<string, { role: string; name: string }>,
    sr: { ref: string; options: string[] },
  ) {
    const same = (o?: { label: string }[]) =>
      !!o && o.length >= sr.options.length && sr.options.every((l, i) => o[i]?.label === l)
    const cands = [
      sr.ref,
      ...[...refs].filter(([k, v]) => v.role === '선택 상자' && k !== sr.ref).map(([k]) => k),
    ]
    for (const ref of cands.slice(0, 8)) {
      if (!refs.has(ref)) continue
      const o = await this.selectOptions(tabId, ref)
      if (same(o)) return { ref, selected: o?.find((x) => x.selected)?.label }
    }
    return undefined
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
      /** 결제 전에 두리가 스스로 고른 것 (보험 안 함·약관 동의 등) */
      chose?: string[]
      /** 같은 일을 몇 개 이어서 하나 (예: 일정 6개 지우기). 2 이상이면 한 번 승인으로 나머지도 */
      count?: number
      /** 받는 곳: 지금 골라진 배송지와 저장된 다른 배송지 */
      shipTo?: string
      shipOptions?: string[]
      /** 결제 카드의 상품·금액·정보 줄 (browser_checkout) */
      checkout?: {
        title?: string
        after?: string
        goods: CheckoutGood[]
        lines: NonNullable<ApprovalView['lines']>
        info: NonNullable<ApprovalView['info']>
      }
    },
    kind?: RiskKind,
  ): Promise<ToolResult> {
    const read = this.pages.get(tabId)
    const target = read?.refs.get(ref)
    if (!read || !target) throw new Error(`${ref}가 무엇인지 몰라요. 먼저 페이지를 읽어 주세요`)
    // 결제 카드(browser_checkout)면 결제 화면으로 본다: 화면의 결제 수단·등록 카드·할부를 카드에 싣는다
    const page: PageInfo = d.checkout && !read.checkout ? { ...read, checkout: '결제 카드' } : read
    // 선택지: 결제 화면에 실제로 있는 고르기 칸만. 그 자체가 결제·확정 버튼이면 안 된다
    const picks: { id: string; label: string; ref: string; role: string; name: string; near?: string }[] = []
    // AI가 선택지를 안 넘겨도, 결제 화면에 결제 수단 고르기 칸이 둘 이상이면 본체가 승인 카드에 싣는다
    // (실측: AI가 도구 설명을 따르지 않고 네이버페이를 스스로 골랐다). 넘겼어도 화면의 다른 결제 수단을 더한다
    const asked = approvalChoices(page, d.choices, d.choiceTitle)
    for (const cref of asked.slice(0, 8)) {
      const c = page.refs.get(cref)
      if (!c) throw new Error(`선택지 ${cref}가 화면에 없어요. 페이지를 다시 읽어 주세요`)
      if (!['라디오', '버튼', '선택지', '체크박스', '탭', '항목', '링크'].includes(c.role))
        throw new Error(`선택지 ${cref}는 고르는 칸이 아니에요`)
      const label = optionLabel(page, cref)
      if (
        cref === ref ||
        (c.role !== '라디오' && !isPayOption(c.role, label) && classifyRisk(`${c.role} ${c.name}`))
      )
        throw new Error(`선택지 ${cref}("${label}")는 결제·확정 버튼이라 선택지로 쓸 수 없어요`)
      if (!label) throw new Error(`선택지 ${cref}는 이름이 없어 무엇인지 몰라요`)
      picks.push({
        id: `c${picks.length + 1}`,
        label: payOptionName(label).slice(0, 40),
        ref: cref,
        role: c.role,
        name: c.name,
        ...(c.name ? {} : { near: label }),
      })
    }
    // 승인 요청은 거절하지 않는다 (어느 단계의 버튼이든 사용자에게 묻는 건 안전하다). 종류만 정한다:
    // 결제 카드는 늘 돈, 그 밖엔 버튼 글자 → 서비스 도구 등급 → 동의 버튼 → AI가 승인을 요청한 버튼
    const risk: Risk =
      (d.checkout ? { kind: 'money' as const, reason: '결제 카드' } : undefined) ??
      classifyRisk(`${target.role} ${target.name}`) ??
      (kind ? { kind, reason: '서비스 도구 등급' } : undefined) ??
      (/동의/.test(target.name)
        ? { kind: 'contact' as const, reason: `"${target.name}" (내 정보 이용 동의)` }
        : { kind: 'irreversible' as const, reason: 'AI가 승인을 요청한 버튼' })
    if (this.finalStep() === 'self')
      throw new Error(
        '사용자가 "마지막 버튼은 직접 누르기"로 정해 두어 두리는 이 버튼을 누르지 않아요. 여기까지 준비한 내용(무엇을·어디서·얼마·취소 조건)을 정리해 알리고 이번 답을 끝내요.',
      )
    // 결제 화면의 펼침 목록 중 등록 카드·할부 개월은 승인 카드에 아래 줄로 싣는다 (기본은 화면에 골라져 있던 것)
    const subs = page.checkout ? await this.subChoices(tabId, page) : []
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
    // 지금 골라진 결제 수단: 화면 표시(선택됨), 없으면 카드·할부 목록 바로 위에 있는 결제 수단
    // (실측 쿠팡: 고른 수단 버튼에 표시가 없고, 고른 수단 아래에만 등록 카드·할부 목록이 보인다)
    const at = (r: string) => page.pos?.get(r) ?? -1
    const firstSub = subs.length ? Math.min(...subs.map((g) => at(g.ref))) : -1
    const opened = picks.filter((p) => page.expanded?.has(p.ref))
    const onPage =
      picks.find((p) => page.selected?.has(p.ref)) ??
      // 골라진 수단만 혜택이 펼쳐지는 화면 (야놀자). 여러 개가 펼쳐져 있으면 모른다
      (opened.length === 1 ? opened[0] : undefined) ??
      (firstSub >= 0
        ? picks.filter((p) => at(p.ref) >= 0 && at(p.ref) < firstSub).sort((a, b) => at(b.ref) - at(a.ref))[0]
        : undefined)
    // 내 결제 수단: 순서대로 사이트가 받는 것과 맞춰 본다. 맞는 첫 번째가 기본값이고, 맞는 칩에는 표시를 붙인다
    const mine = this.payMethods?.() ?? []
    const minePick = pickPayMethod(
      mine,
      picks.map((p) => p.label),
    )
    const mineOf = (label: string) => mine.find((m) => payMethodMatches(m, label))
    const preferred =
      (minePick ? picks[minePick.option] : undefined) ??
      picks.find(
        (p) => last && (p.name === last || p.near === last || (p.name || p.near || '').includes(last)),
      ) ??
      onPage ??
      picks[0]
    // 카드를 골라 두었고 결제 화면에 카드사 목록이 있으면 등록한 카드사를 기본으로 (지난번에 고른 카드가 있으면 그게 먼저)
    const card = preferred ? mineOf(preferred.label) : undefined
    // 'KB국민카드' → '국민'도 (화면에는 '국민카드 / 9409…'처럼 나온다)
    const brand = card?.issuer?.replace(/카드$/, '')
    const brands = brand ? [...new Set([brand, brand.replace(/^[A-Z]+/, '')])].filter(Boolean) : []
    const subDefault = (g: (typeof subs)[number]) => {
      const screen = g.selected
      if (!brands.length || g.title !== '카드' || g.remembered) return screen
      const isMine = (o: string) => brands.some((b) => o.includes(b))
      const last4 = card?.last4
      const byLast4 = last4 ? g.options.findIndex((o) => isMine(o) && o.includes(last4)) : -1
      const at = byLast4 >= 0 ? byLast4 : g.options.findIndex(isMine)
      return at >= 0 ? at : screen
    }
    const rec = this.approvals.create({
      tabId,
      ref,
      role: target.role,
      label: target.name,
      url: page.url,
      kind: risk.kind,
      reason: risk.reason,
      what: `${d.count && d.count > 1 ? `[${d.count}개 모두] ` : ''}${d.what}`.slice(0, 200),
      where: d.where.slice(0, 100),
      ...(d.amount ? { amount: d.amount.slice(0, 60) } : {}),
      ...(d.cancel ? { cancel: d.cancel.slice(0, 200) } : {}),
      ...(d.chose?.length ? { chose: d.chose } : {}),
      ...(d.shipTo ? await this.shipChoices(d.shipTo, d.shipOptions ?? []) : {}),
      ...(d.checkout?.title ? { title: d.checkout.title } : {}),
      ...(d.checkout?.after ? { after: d.checkout.after } : {}),
      ...(d.checkout?.goods.length ? { goods: d.checkout.goods } : {}),
      ...(d.checkout?.lines.length ? { lines: d.checkout.lines } : {}),
      ...(d.checkout?.info.length ? { info: d.checkout.info } : {}),
      ...(shot?.data ? { shot: shot.data } : {}),
      ...(picks.length
        ? {
            choices: picks.map(({ id, label }) => {
              const m = mineOf(label)
              return { id, label, ...(m ? { mine: payMethodLabel(m) } : {}) }
            }),
            choiceTitle: d.choiceTitle ?? '결제 수단',
            ...(preferred ? { choice: preferred.id } : {}),
            choiceRefs: Object.fromEntries(
              picks.map((p) => [
                p.id,
                { ref: p.ref, role: p.role, name: p.name, ...(p.near ? { near: p.near } : {}) },
              ]),
            ),
          }
        : {}),
      ...(subs.length
        ? {
            subChoices: subs.map((g) => ({
              key: g.key,
              title: g.title,
              options: g.options.map((label, i) => ({ id: `${g.key}o${i + 1}`, label: label.slice(0, 40) })),
              choice: `${g.key}o${subDefault(g) + 1}`,
              // 지금 화면에 골라져 있는 결제 수단에 딸린 목록이다 (다른 수단을 고르면 이 줄은 안 쓴다)
              ...(onPage ? { when: onPage.id } : {}),
            })),
            subRefs: Object.fromEntries(subs.map((g) => [g.key, { ref: g.ref, options: g.options }])),
          }
        : {}),
    })
    if (d.count && d.count > 1) this.series.set(rec.id, Math.min(20, Math.floor(d.count)))
    // 결제 카드는 1시간 기다린다: 그동안 탭 정리에서 닫히지 않게 같은 시간 잡아 둔다
    this.hold(tabId, risk.kind === 'money' ? PAY_SESSION_TTL_MS : APPROVAL_TTL_MS)
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

  /**
   * PC 파일을 페이지의 파일 칸에 넣는다 (블로그 사진·영상·서류 첨부). 내 파일이 그 사이트로 나가는 일이라
   * 처음 한 번은 승인 카드(무슨 파일을·어느 사이트에)를 받는다. 승인한 같은 파일·같은 사이트는 30분 동안 다시 묻지 않는다.
   * 넣기만 한다: 글 올리기·제출 버튼은 AI가 이어서 누른다(보내기·제출은 그 버튼에서 따로 승인)
   */
  private async upload(tabId: number, a: Record<string, unknown>): Promise<ToolResult> {
    const page = this.pages.get(tabId)
    const ref = String(a.ref ?? '')
    const target = page?.refs.get(ref)
    if (!page || !target) throw new Error(`${ref || 'ref'}가 무엇인지 몰라요. 먼저 페이지를 읽어 주세요`)
    if (!this.uploadFiles) throw new Error('이 PC에서는 파일 올리기를 쓸 수 없어요')
    const paths = (Array.isArray(a.paths) ? a.paths : typeof a.path === 'string' ? [a.path] : []).map(String)
    const v = await this.uploadFiles(paths)
    if ('error' in v) throw new Error(v.error)
    const files = v.files
    let host = ''
    try {
      host = new URL(page.url).host
    } catch {}
    if (!host) throw new Error('페이지 주소를 알 수 없어요')
    const now = Date.now()
    if (files.every((f) => (this.uploadPass.get(`${host}|${f.path}`) ?? 0) > now)) {
      const r = await sendFiles(this.browser, tabId, ref, files)
      return this.read(tabId, undefined, this.uploadedText(files, r, host, target.name))
    }
    if (this.finalStep() === 'self')
      throw new Error(
        '사용자가 "마지막 버튼은 직접 누르기"로 정해 두어 두리는 내 파일을 사이트에 올리지 않아요. 어떤 파일을 어디에 올리면 되는지 정리해 알리고 이번 답을 끝내요.',
      )
    const shot = (await this.browser.call('screenshot', { tabId }).catch(() => undefined)) as
      | { data?: string }
      | undefined
    const names = files.map((f) => f.name)
    const what = String(a.what ?? '')
      .trim()
      .slice(0, 120)
    const rec = this.approvals.create({
      tabId,
      ref,
      role: target.role,
      label: target.name,
      url: page.url,
      kind: 'contact',
      reason: '내 PC 파일을 웹사이트에 올리는 일',
      what: (what || `파일 ${files.length}개 올리기 · ${names.join(', ')}`).slice(0, 200),
      where: host,
      items: files.map((f) => `${f.show} (${sizeText(f.size)})`),
      ...(shot?.data ? { shot: shot.data } : {}),
    })
    this.uploadAsks.set(rec.id, files)
    this.hold(tabId, APPROVAL_TTL_MS)
    return {
      content: [
        {
          type: 'text',
          text:
            `승인을 요청했어요(${rec.id.slice(0, 8)}). ${host}에 ${names.join(', ')}을(를) 올려도 되는지 사용자에게 한두 문장으로 묻고 이번 답은 여기서 끝내세요. ` +
            '승인되면 두리가 그 파일 칸에 직접 넣고, 다음 메시지로 결과를 알려 줘요. 그때 페이지를 다시 읽어 파일이 올라갔는지 보고 이어서 해요.',
        },
      ],
    }
  }

  /** 넣은 뒤 AI에게: 무엇이 들어갔고, 아직 올리기·제출은 안 했다 */
  private uploadedText(files: UploadFile[], r: UploadReply, host: string, label: string): string {
    const names = files.map((f) => f.name)
    const off = notAccepted(r.accept ?? '', names)
    return (
      `${host}의 ${label ? `"${label}" ` : ''}파일 칸에 ${names.join(', ')}을(를) 넣었어요` +
      `${r.found === 'chooser' ? ' (눌러서 뜬 파일 고르기 창으로)' : ''}.` +
      (off.length
        ? ` 이 칸은 "${r.accept}"만 받는다고 적혀 있어요: ${off.join(', ')}은(는) 거절될 수 있어요.`
        : '') +
      ' 아직 글 올리기·제출은 하지 않았어요. 사이트가 파일을 받는 데 시간이 걸릴 수 있으니 화면에서 올라간 것(미리보기·파일 이름·진행률)을 확인하고 이어서 해요.'
    )
  }

  /** 승인된 올리기: 그 칸이 그대로인지 보고 넣는다 */
  private async approveUpload(
    id: string,
    rec: ApprovalRecord,
    files: UploadFile[],
  ): Promise<{ ok: boolean; message: string }> {
    let host = ''
    try {
      host = new URL(rec.url).host
    } catch {}
    try {
      const s = (await this.browser.call('snapshot', { tabId: rec.tabId, maxChars: 40_000 })) as Snapshot
      this.pages.set(rec.tabId, pageInfo(s.url, s.text))
      const now = parseRefs(s.text).get(rec.ref)
      if (s.url !== rec.url || !now || now.name !== rec.label || now.role !== rec.role) {
        const msg = `승인한 뒤 화면이 바뀌어서 파일을 넣지 않았어요("${rec.label || rec.ref}"). 페이지를 다시 읽고 다시 올려 주세요.`
        this.approvals.finish(id, false, msg)
        return { ok: false, message: msg }
      }
      // 파일이 그사이 옮겨지거나 지워졌을 수 있다: 다시 확인한다
      const v = this.uploadFiles
        ? await this.uploadFiles(files.map((f) => f.path))
        : { error: '파일을 볼 수 없어요' }
      if ('error' in v) throw new Error(v.error)
      const r = await sendFiles(this.browser, rec.tabId, rec.ref, v.files)
      const until = Date.now() + 30 * 60_000
      for (const f of v.files) this.uploadPass.set(`${host}|${f.path}`, until)
      const msg = this.uploadedText(v.files, r, host, rec.label)
      this.approvals.finish(id, true, msg)
      return { ok: true, message: msg }
    } catch (e) {
      const msg = `파일을 올리지 못했어요: ${(e as Error).message}`
      this.approvals.finish(id, false, msg)
      return { ok: false, message: msg }
    }
  }

  /** 사이트 확인 창의 [확인]을 누를지 승인을 받는다 (창이 떠 있는 동안 페이지가 멈춰 있어 화면 캡처는 없다) */
  private askDialogApproval(
    tabId: number,
    d: { what: string; where: string; amount?: string; cancel?: string },
  ): ToolResult {
    const dlg = this.dialogs.get(tabId)
    if (!dlg) throw new Error('떠 있는 사이트 확인 창이 없어요. 페이지를 다시 읽어 확인해 주세요')
    // 거절하지 않는다: AI가 묻겠다면 카드를 띄운다
    const risk = classifyDialogRisk(dlg.message) ?? {
      kind: 'irreversible' as const,
      reason: 'AI가 승인을 요청한 확인 창',
    }
    if (this.finalStep() === 'self')
      throw new Error(
        '사용자가 "마지막 버튼은 직접 누르기"로 정해 두어 두리는 이 확인 창을 누르지 않아요. 여기까지 준비한 내용(무엇을·어디서·얼마)을 정리해 알리고 이번 답을 끝내요.',
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
    this.hold(tabId, risk.kind === 'money' ? PAY_SESSION_TTL_MS : APPROVAL_TTL_MS)
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

  /** 결제가 시작됐을 때 AI에게: 할 일은 주문 완료까지, 묶음의 탭, 끝내는 법 */
  private payingText(x: PaySession): string {
    const extra = [...x.tabs].filter((t) => t !== x.tabId)
    return (
      `결제가 시작됐어요. 이제 할 일은 주문 완료 화면까지 결제를 마치는 거예요. 결제 묶음: 탭 ${x.tabId}(주문서)` +
      `${extra.map((t) => `·탭 ${t}(결제 창)`).join('')}. ` +
      '결제 회사 창의 카드 선택·[다음]·[동의]·[결제하기]는 다시 승인받지 않고 눌러요(결제 비밀번호는 browser_request_code kind "pin", 인증 앱 승인은 browser_wait_auth). ' +
      '결제 창이 안 보이면 browser_read로 화면 안 액자나 새 탭을 찾아요(늦게 뜬 창도 두리가 묶음에 넣어요). 이 탭들은 결제가 끝날 때까지 다른 주소로 옮기지 않아요. ' +
      '주문 완료 화면에서 주문번호를 읽으면 browser_order_done(tabId, order_no)을 불러요. 결제가 안 되면 browser_order_done(failed: true, reason)으로 알리고 다른 길을 찾아요.'
    )
  }

  /**
   * 주문 완료(또는 결제 실패)를 AI가 화면을 보고 알린다: 결제 묶음을 닫고(탭 잡아 두기·결제 중 표시 풀기),
   * 결제 승인을 주문번호와 함께 끝낸다. 끝은 "주문 완료 화면 + 주문번호"다 (11-20 사용자 결정)
   */
  private async orderDone(tabId: number, a: Record<string, unknown>): Promise<ToolResult> {
    const failed = a.failed === true
    const cut = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '')
    const orderNo = cut(a.order_no, 60)
    const summary = cut(a.summary, 200)
    const reason = cut(a.reason, 200)
    if (!failed && !orderNo)
      throw new Error(
        '주문번호(order_no)를 넣어 주세요(주문 완료 화면에 적힌 그대로). 화면에 안 보이면 주문 내역을 새 탭으로 열어 찾아요. 결제가 안 됐으면 failed: true와 reason으로 불러요.',
      )
    // 주문번호를 다른 탭(주문 내역)에서 찾았어도: 결제 묶음이 하나뿐이면 그 결제다
    const live = this.liveSessions()
    const x = this.paySession(tabId) ?? (live.length === 1 ? live[0] : undefined)
    if (x) this.endSession(x)
    this.onNote?.('order-done', { site: x?.site ?? '', ok: !failed, ...(failed && reason ? { reason } : {}) })
    if (failed) {
      if (x)
        this.approvals.settle(x.approvalId, false, `결제를 마치지 못했어요${reason ? `: ${reason}` : ''}`)
      return {
        content: [
          {
            type: 'text',
            text: `결제를 마치지 못한 것으로 기록하고 결제 묶음을 닫았어요${reason ? `(${reason})` : ''}. 먼저 돈이 나갔는지 확인해요(주문 내역을 새 탭으로 열어 보기). 안 나갔으면 다른 결제 수단이나 다른 길로 다시 해 보고, 결제 버튼은 다시 browser_checkout으로 한 번 승인받아요. 사용자에게 PC나 다른 앱에서 직접 하라고 하지 않아요.`,
          },
        ],
      }
    }
    if (x)
      this.approvals.settle(
        x.approvalId,
        true,
        `주문 완료 · 주문번호 ${orderNo}${summary ? ` · ${summary}` : ''}`,
      )
    return {
      content: [
        {
          type: 'text',
          text:
            `주문 완료를 기록했어요(주문번호 ${orderNo})${x ? '. 결제 승인을 완료로 바꾸고 결제 중이던 탭을 풀었어요' : ''}. ` +
            '이제 show_result로 결과 한 장(무엇을·얼마·주문번호·도착이나 이용 예정)을 보여 주고, know_save로 이 주문(사이트·주문번호·금액·날짜)을 남겨요.',
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

  /**
   * 결제 묶음 (승인 id → 묶음). 승인한 결제 버튼을 누른 순간부터 주문 완료(browser_order_done)까지.
   * 누른 탭과 그 탭이 연 결제 창·새 탭이 한 묶음이고, 묶음 안 결제 회사 창의 버튼은 다시 승인받지 않는다.
   * 묶음의 탭은 다른 주소로 옮기거나 서비스 도구가 가져다 쓰지 않는다 (실측 11-20 G마켓: 승인 뒤 카드 결제창이 뜬
   * 탭을 주문 내역으로 옮겨 결제가 끊겼다)
   */
  private sessions = new Map<string, PaySession>()
  /** 늦게 뜨는 결제 창을 찾아볼 때 (누른 뒤 ms). 첫 번째는 승인 결과를 돌려주기 전에 기다려 본다 (시험은 짧게) */
  payPopupWaits = [2_500, 5_000, 10_000]
  private liveSessions(now = Date.now()): PaySession[] {
    for (const [id, x] of this.sessions) if (now - x.startedAt > PAY_SESSION_TTL_MS) this.sessions.delete(id)
    return [...this.sessions.values()]
  }
  /** 이 탭이 든 결제 묶음 (없으면 undefined) */
  paySession(tabId: number): PaySession | undefined {
    return this.liveSessions().find((x) => x.tabs.has(tabId))
  }
  isPaying(tabId: number): boolean {
    return this.paySession(tabId) !== undefined
  }
  /**
   * 폰 보안 키패드로 받은 비밀번호대로 짚어 둔 화면 키패드 버튼을 차례로 누른다 (값은 남기지 않는다). 다 눌렀으면 true.
   * force: 누를 때마다 키패드 위 '●○○○○○ (1/6자리)'가 바뀌어 둘레 글 검사(목록 칸 재활용 막기)가 둘째 숫자부터
   * 막았다 (시험 가게 결제 창). 키패드는 AI가 방금 짚은 것이고, 자리가 다시 섞였는지는 누른 뒤 AI가 화면으로 판단한다.
   * once: 화면이 안 바뀌는 숫자 버튼을 '안 눌렸다'고 보고 다시 누르면 숫자가 두 번 들어간다
   */
  /**
   * 화면 보안 키패드(키마다 이름표가 붙은 것: "3"·"소문자 q"·"느낌표")로 비밀번호를 누른다. 값은 AI에게 가지 않는다.
   * 키보드 입력을 막는 칸용 (실측 11-21 신한카드 가입: 키 입력·한 번에 넣기 모두 '보안 키패드가 막음').
   * 키패드가 없거나 글자 버튼을 못 찾으면 false
   */
  async keypadType(tabId: number, fieldRef: string, pw: string): Promise<boolean> {
    return keypadType(this.browser, tabId, fieldRef, pw)
  }

  async pressPin(tabId: number, keys: Record<string, PinKey>, pin: string): Promise<boolean> {
    for (const [i, d] of [...pin].entries()) {
      const ref = keys[d]
      if (!ref) return false
      // 버튼으로 안 잡히는 그림 키패드: 짚어 둔 화면 자리를 누른다
      if (typeof ref === 'object') {
        const ok = await this.browser
          .call('input', { tabId, action: 'tap', x: ref.x, y: ref.y }, 15_000)
          .then(
            () => true,
            () => false,
          )
        if (!ok) return false
        await new Promise((res) => setTimeout(res, 150))
        continue
      }
      // 화면 아래 키패드를 누르려고 늘린 화면 높이는 마지막 숫자까지 그대로 둔다 (숫자마다 늘렸다 줄이면 0.5초씩 더 든다)
      const keepTall = i < pin.length - 1
      const ok = await this.browser
        .call('click', { tabId, ref, once: true, force: true, quick: true, keepTall }, 15_000)
        .then(
          () => true,
          () => false,
        )
      if (!ok) return false
      await new Promise((res) => setTimeout(res, 120))
    }
    return true
  }
  /** 결제가 끝났다(주문 완료 화면을 확인했다): 그 탭의 결제 묶음을 닫는다 */
  donePaying(tabId: number) {
    const x = this.paySession(tabId)
    if (x) this.endSession(x)
  }
  /**
   * 결제 회사 창 안인지: 결제 묶음의 다른 탭(결제 창), 누른 탭의 화면 안 액자, 결제 회사 주소로 넘어간 누른 탭.
   * 가게 주문서 화면 자체의 돈 버튼은 여기 들지 않는다 (같은 가게에서 또 사는 건 다시 승인)
   */
  private inProvider(tabId: number, url: string, ref = ''): boolean {
    const x = this.paySession(tabId)
    if (!x) return false
    if (tabId !== x.tabId || frameRef(ref)) return true
    return url !== '' && siteKey(url) !== x.site
  }
  /** 승인한 결제 버튼을 눌렀다: 결제 묶음을 연다 */
  private startSession(approvalId: string, tabId: number, url: string, label: string, extra: number[] = []) {
    // 한 탭에 결제는 하나: 같은 탭의 예전 묶음은 닫는다
    for (const x of this.liveSessions()) if (x.tabs.has(tabId)) this.sessions.delete(x.approvalId)
    const x: PaySession = {
      approvalId,
      tabId,
      tabs: new Set([tabId]),
      site: siteKey(url),
      label,
      startedAt: Date.now(),
    }
    this.sessions.set(approvalId, x)
    this.hold(tabId, PAY_SESSION_TTL_MS)
    for (const t of extra) this.joinSession(x, t)
    this.onNote?.('pay-session', { site: x.site, tabs: [...x.tabs] })
    // 결제 창은 서버에 다녀와서 늦게 뜬다: 몇 번 더 찾아본다 (첫 번째는 approve가 기다려 본다)
    for (const ms of this.payPopupWaits.slice(1)) {
      const t = setTimeout(() => void this.findPayTabs(x), ms)
      t.unref?.()
    }
    return x
  }
  private joinSession(x: PaySession, tabId: number) {
    if (x.tabs.has(tabId)) return
    x.tabs.add(tabId)
    this.hold(tabId, PAY_SESSION_TTL_MS)
    this.onNote?.('pay-session-tab', { site: x.site, tabId })
  }
  private endSession(x: PaySession) {
    this.sessions.delete(x.approvalId)
    for (const t of x.tabs) {
      this.hold(t, 0)
      this.paidPass.delete(t)
    }
  }
  /** 결제 묶음의 탭들이 연 창을 찾아 묶음에 넣는다 (확장의 늦은 새 창 알림 + 탭 목록의 여는 탭) */
  private async findPayTabs(x: PaySession) {
    if (this.sessions.get(x.approvalId) !== x) return
    for (const t of [...x.tabs]) {
      const p = (await this.browser.call('popup', { tabId: t }, 5_000).catch(() => undefined)) as
        | { newTabId?: number }
        | undefined
      if (typeof p?.newTabId === 'number') this.joinSession(x, p.newTabId)
    }
    for (const t of await this.openerTabs())
      if (t.opener !== undefined && x.tabs.has(t.opener)) this.joinSession(x, t.tabId)
  }
  /**
   * 확장의 탭 목록 (탭·그 탭을 연 탭). 탭 목록 명령을 모르는 확장이면 빈 목록 — 늦은 새 창 알림(popup)만으로 한다.
   * (확장 쪽 탭 목록 명령은 따로 들어온다: 이름·모양이 달라도 깨지지 않게 넓게 읽는다)
   */
  private async openerTabs(): Promise<{ tabId: number; opener?: number }[]> {
    const r = (await this.browser.call(TABS_CMD, {}, 5_000).catch(() => undefined)) as unknown
    const list: unknown[] = Array.isArray(r)
      ? r
      : Array.isArray((r as { tabs?: unknown } | undefined)?.tabs)
        ? (r as { tabs: unknown[] }).tabs
        : []
    const out: { tabId: number; opener?: number }[] = []
    for (const v of list) {
      const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
      const id = Number(o.tabId ?? o.id)
      const opener = Number(o.openerTabId ?? o.opener)
      if (Number.isInteger(id)) out.push({ tabId: id, ...(Number.isInteger(opener) ? { opener } : {}) })
    }
    return out
  }
  /** 처음 보는 탭이 결제 묶음의 탭이 연 창이면 묶음에 넣는다 (결제 중일 때만 묻는다) */
  private async adoptTab(tabId: number) {
    const live = this.liveSessions()
    if (!live.length || live.some((x) => x.tabs.has(tabId))) return
    const me = (await this.openerTabs()).find((t) => t.tabId === tabId)
    const x = me?.opener !== undefined ? live.find((y) => y.tabs.has(me.opener as number)) : undefined
    if (x) this.joinSession(x, tabId)
  }
  /** 넘긴 화면이 바뀌면(사람이 마친 듯) 본체에 알린다: 사용자가 '다 했어요'를 말하지 않아도 이어 가게 */
  onHandoffChanged?: (tabId: number, why: string) => void
  private handoffWatches = new Map<number, ReturnType<typeof setInterval>>()
  stopHandoffWatch(tabId: number) {
    const t = this.handoffWatches.get(tabId)
    if (t) clearInterval(t)
    this.handoffWatches.delete(tabId)
  }
  /**
   * 3초마다 그 탭의 주소·로봇 확인·칸과 버튼 이름을 보고, 넘긴 때와 달라지면(로그인·인증을 마쳐 다음 화면) 알린다.
   * 칸에 글을 넣는 것만으로는 바뀌지 않는다(값은 보지 않는다). 탭이 닫히면(로그인 팝업이 끝나 닫힘) 그것도 마친 것으로 본다. 10분까지
   */
  /** 넘긴 화면을 볼 간격 (시험은 짧게) */
  handoffEveryMs = 3_000
  private watchHandoff(tabId: number, everyMs = this.handoffEveryMs) {
    this.stopHandoffWatch(tabId)
    const sig = (s: { url?: string; text?: string; captcha?: boolean }) =>
      `${s.url ?? ''}|${s.captcha ? 1 : 0}|${[...parseRefs(s.text ?? '').values()]
        .map((r) => `${r.role}:${r.name}`)
        .sort()
        .join(',')}`
    let base: string | undefined
    let fails = 0
    let n = 0
    const t = setInterval(() => {
      if (++n > (10 * 60_000) / everyMs) return this.stopHandoffWatch(tabId)
      void this.browser
        .call('snapshot', { tabId, maxChars: 20_000 }, 10_000)
        .then((s) => {
          fails = 0
          const cur = sig(s as { url?: string; text?: string; captcha?: boolean })
          if (base === undefined) base = cur
          else if (cur !== base && this.handoffWatches.has(tabId)) {
            this.stopHandoffWatch(tabId)
            this.onHandoffChanged?.(tabId, '화면이 다음 단계로 넘어갔어요')
          }
        })
        .catch(() => {
          // 두 번 이어 못 읽으면 탭이 닫힌 것 (간편 로그인 팝업은 마치면 저절로 닫힌다)
          if (++fails >= 2 && this.handoffWatches.has(tabId)) {
            this.stopHandoffWatch(tabId)
            this.onHandoffChanged?.(tabId, '넘긴 창이 닫혔어요')
          }
        })
    }, everyMs)
    t.unref?.()
    this.handoffWatches.set(tabId, t)
  }

  /** 사람이 직접 할 탭: 원격 화면을 열어 주고, 마칠 때까지 탭 정리에서 뺀다 (도구마다 부르는 allowRemote와 달리 넘길 때만) */
  holdForPerson(tabId: number) {
    this.allowRemote(tabId)
    this.hold(tabId, REMOTE_TTL_MS)
  }

  /**
   * 사람·승인을 기다리는 탭은 확장의 탭 정리(3개까지·12분이면 잠재우기)에서 뺀다.
   * 안 그러면 기다리는 동안 다른 탭(간편 로그인 창 등)이 열리며 가장 오래 안 쓴 이 탭이 닫혀,
   * 잡아 둔 좌석·결제 화면이 사라지고 "두리가 연 탭이 아니에요"가 났다 (실측: 롯데시네마 결제).
   * 옛 확장은 이 명령을 몰라도 일은 그대로 한다
   */
  private hold(tabId: number, ms: number) {
    void this.browser.call('hold', { tabId, ms }, 5_000).catch(() => undefined)
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

  /** 승인 요청 id → 몇 개를 한 번에 승인받는지 */
  private series = new Map<string, number>()
  /** 한 번 승인으로 이어서 누를 수 있는 남은 개수 (사이트·종류별, 10분). 보내기·지우기만 — 결제는 승인 한 번에 버튼 한 번 */
  private grants: { host: string; kind: RiskKind; left: number; until: number }[] = []

  private grantSeries(url: string, kind: RiskKind, left: number) {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {}
    if (!host || left < 1 || kind === 'money') return
    this.grants.push({ host, kind, left, until: Date.now() + 10 * 60_000 })
  }

  /**
   * 남은 승인이 있으면 하나 쓴다. 결제는 묶지 않는다: 예전엔 결제 한 번 승인하면 그 사이트의 돈 버튼이
   * 30분 동안 승인 없이 눌렸다 (안전 구멍, 11-20 전수조사)
   */
  private useSeries(url: string, kind: RiskKind, consume = true): boolean {
    if (kind === 'money') return false
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {}
    const now = Date.now()
    this.grants = this.grants.filter((g) => g.until > now && g.left > 0)
    const g = this.grants.find((x) => x.host === host && x.kind === kind)
    if (!g) return false
    if (!consume) return true
    g.left--
    this.onNote?.('approval-series', { host, kind, left: g.left })
    return true
  }

  /** 막은 버튼: 절차 설명 말고 짧게, 어느 카드로 올리면 되는지만 */
  private gateText(ref: string, name: string, risk: Risk | undefined, declared: boolean): string {
    const what = `[${ref} "${name}"]`
    if (this.finalStep() === 'self')
      return `${GATE_STOP}: ${what}은(는) ${risk ? RISK_TEXT[risk.kind] : '마지막 버튼'}이라 두리가 누르지 않아요. 사용자가 "마지막 버튼은 직접 누르기"로 정해 두었어요. 여기까지 준비한 내용(무엇을·어디서·얼마)을 정리해 알리고 이번 답을 끝내요.`
    if (!risk)
      return `${GATE_STOP}: ${what}을(를) 마지막 버튼이라고 했어요(final). 결제면 browser_checkout, 보내기·지우기면 browser_request_approval에 이 ref를 올려 승인 카드를 띄워요.`
    if (risk.kind === 'money')
      return `${GATE_STOP}: ${what}은(는) 돈이 나가는 버튼이에요(${risk.reason}). browser_checkout(ref: "${ref}")으로 결제 카드를 띄워 한 번 승인받아요.${declared ? '' : ' 결제 화면으로 넘어가기만 하는 버튼이면 opens_checkout: true로 다시 눌러요.'}`
    return `${GATE_STOP}: ${what}은(는) ${RISK_TEXT[risk.kind]}이에요(${risk.reason}). browser_request_approval(ref: "${ref}")로 승인 카드를 띄워요.`
  }

  /**
   * 사용자가 승인한 버튼을 누른다. 누르기 직전 페이지를 다시 읽어, 승인한 버튼 글자와 주소가 그대로일 때만.
   * 화면용 토큰을 가진 쪽(사용자 화면)만 부를 수 있다 (AI의 도구 토큰으로는 못 부른다)
   */
  async approve(id: string, choice?: string): Promise<{ ok: boolean; message: string }> {
    const rec: ApprovalRecord | undefined = this.approvals.take(id)
    if (!rec) return { ok: false, message: '이미 처리했거나 시간이 지난 승인 요청이에요' }
    const upFiles = this.uploadAsks.get(id)
    if (upFiles) {
      this.uploadAsks.delete(id)
      return this.approveUpload(id, rec, upFiles)
    }
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
        const pressed = `확인 창 "${dialogText.slice(0, 80)}"에서 [확인]을 눌렀어요.`
        // 결제 확인 창이면 버튼과 똑같이 결제 묶음을 열고 주문 완료까지 이어 간다
        if (rec.kind === 'money') {
          const x = this.startSession(id, rec.tabId, rec.url, rec.label)
          const msg = `${pressed} ${this.payingText(x)} 지금 화면: ${r.title ?? ''} (${r.url ?? ''})`
          this.approvals.progress(id, msg)
          return { ok: true, message: msg }
        }
        const msg = `${pressed} 지금 화면: ${r.title ?? ''} (${r.url ?? ''})`
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
      const picked: string[] = []
      const pickedSubs: [string, string][] = []
      // 고른 것: 결제 수단(c1)과 세부 선택(s1o2)을 쉼표로 이은 글 (폰이 서명한 그대로)
      const all = (choice ?? '').split(',').filter(Boolean)
      // 받는 곳: a0(지금 곳)이 아니면 배송지를 바꾼 뒤 결제해야 한다. 화면에서 배송지 바꾸기는 사이트마다 달라 AI가 하고,
      // 이 승인으로 마지막 버튼을 한 번 누를 수 있게 한다 (다시 묻지 않는다, 결제 승인과 같은 1시간)
      const isShip = (p: string) => /^a\d+$/.test(p) || p.startsWith('n:')
      const ship = all.find(isShip)
      // n:… = 사용자가 넣은 새 주소 (그 사이트 배송지에 추가해 고른다)
      const fresh = ship?.startsWith('n:') ? safeDecode(ship.slice(2)).trim().slice(0, 100) : ''
      const shipTo = fresh
        ? `새 주소 ${fresh}`
        : ship && ship !== 'a0'
          ? rec.shipOptions?.find((o) => o.id === ship)?.label
          : undefined
      const parts = all.filter((p) => !isShip(p))
      if (shipTo) {
        const pay = parts
          .map(
            (p) =>
              rec.choices?.find((c) => c.id === p)?.label ??
              rec.subChoices?.flatMap((g) => g.options).find((o) => o.id === p)?.label,
          )
          .filter(Boolean)
        this.paidPass.set(rec.tabId, {
          label: rec.label,
          until: Date.now() + PAY_SESSION_TTL_MS,
          approvalId: id,
        })
        const msg =
          `사용자가 승인하면서 받는 곳을 "${shipTo}"(으)로 바꿔 달라고 했어요. 아직 결제는 누르지 않았어요. ` +
          `화면의 배송지 변경으로 그곳을 고른 뒤(새 주소면 배송지 추가로 넣고, 받는 사람·연락처는 browser_fill_profile로)${pay.length ? ` 결제 수단 ${pay.map((x) => `"${x}"`).join(', ')}을(를) 고르고` : ''} [${rec.label}]을(를) browser_click으로 누르세요. 이번 결제는 이미 승인돼 다시 묻지 않아요(1시간 안, 한 번). 누른 뒤에는 결제 창까지 끝내고 주문 완료 화면의 주문번호로 browser_order_done을 불러요.`
        // 승인은 아직 끝나지 않았다: 주문 완료(browser_order_done)에서 끝낸다
        this.approvals.progress(id, msg)
        return { ok: true, message: msg }
      }
      const main = parts.find((p) => rec.choiceRefs?.[p])
      // 다른 결제 수단을 골랐으면 그 수단에 딸린 카드·할부 선택은 쓰지 않는다
      const applies = (p: string) => {
        const when = rec.subChoices?.find((g) => g.key === p.split('o')[0])?.when
        return !when || !main || when === main
      }
      const subs = parts.filter((p) => /^s\d+o\d+$/.test(p) && rec.subRefs?.[p.split('o')[0] as string])
      const fail = (why: string) => {
        const msg = `${why} 결제는 하지 않았어요. 페이지를 다시 읽고 승인을 다시 받아 주세요.`
        this.approvals.finish(id, false, msg)
        return { ok: false, message: msg }
      }
      if (parts.length !== subs.length + (main ? 1 : 0)) return fail('고른 결제 수단을 찾을 수 없어요.')
      if (main || subs.length) {
        const reread = async () => {
          base = (await this.browser.call('snapshot', { tabId: rec.tabId, maxChars: 40_000 })) as Snapshot
          this.pages.set(rec.tabId, pageInfo(base.url, base.text))
          return base.url === rec.url
        }
        if (main) {
          const c = rec.choiceRefs?.[main] as NonNullable<ApprovalRecord['choiceRefs']>[string]
          const what = c.name || c.near || '고른 결제 수단'
          const at = sameChoice(pageInfo(s.url, s.text), c)
          if (!at) return fail(`"${what}" 칸이 화면에서 바뀌었어요.`)
          await this.browser.call('click', { tabId: rec.tabId, ref: at }, 30_000)
          if (!(await reread())) return fail(`"${what}"을(를) 고르자 다른 화면으로 넘어갔어요.`)
          chosen = what
        }
        // 등록 카드·할부: 고른 것과 화면이 다르면 그 목록에서 고른다
        let changed = false
        for (const sid of subs.filter(applies)) {
          const [key = '', n = ''] = sid.split('o')
          const sr = rec.subRefs?.[key] as { ref: string; options: string[] }
          const label = sr.options[Number(n) - 1]
          const group = rec.subChoices?.find((g) => g.key === key)
          if (!label) return fail('고른 카드·할부를 찾을 수 없어요.')
          const at = await this.findSelect(rec.tabId, parseRefs(base.text), sr)
          if (!at) {
            // 결제 수단을 바꾸자 목록이 사라진 경우: 기본값 그대로면 넘어가고, 바꿔 달라고 한 것이면 멈춘다
            if (group?.choice === sid) continue
            return fail(`"${label}"을(를) 고를 ${group?.title ?? '칸'} 목록이 화면에서 사라졌어요.`)
          }
          if (at.selected !== label) {
            await this.browser.call('choose', { tabId: rec.tabId, ref: at.ref, label }, 15_000)
            changed = true
          }
          picked.push(label)
          if (group?.title) pickedSubs.push([group.title, label])
        }
        if (changed && !(await reread())) return fail('카드·할부를 고르자 다른 화면으로 넘어갔어요.')
        if (base !== s) {
          const refs = parseRefs(base.text)
          const next =
            sameControl(refs, rec.ref, rec.role, rec.label) ??
            [...refs].find(([, v]) => v.role === rec.role && sameFinal(v.name, rec.label))?.[0]
          if (!next) return fail(`고르고 나니 마지막 버튼("${rec.label}")이 바뀌었어요.`)
          finalRef = next
          finalName = refs.get(next)?.name ?? rec.label
        }
      }
      // 결제 창이 새 창으로 뜨는 사이트: Chrome 팝업 차단에 막히지 않게 이 사이트의 팝업을 허용해 둔다
      if (rec.kind === 'money')
        await this.browser.call('allow-popups', { tabId: rec.tabId }).catch(() => undefined)
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
      // 고른 등록 카드·할부도 사이트별로 기억 (다음 승인 카드의 기본값)
      try {
        const host = new URL(rec.url).hostname
        for (const [title, label] of pickedSubs) {
          this.lastSub.set(`${host}|${title}`, label)
          this.onSubChoice?.(`${host}|${title}`, label)
        }
      } catch {}
      const how = [chosen ? `결제 수단 "${chosen}"` : '', ...picked.map((p) => `"${p}"`)]
        .filter(Boolean)
        .join(', ')
      // 고른 간편결제에 사용자가 등록해 둔 "그 안에서 쓰는 것"이 있으면 결제 창에서 고르라고 알린다 (ADR 0023)
      const mainLabel = rec.choices?.find((c) => c.id === main)?.label
      const inner = mainLabel
        ? (this.payMethods?.() ?? []).find(
            (m) => m.kind !== 'card' && m.inner && payMethodMatches(m, mainLabel),
          )
        : undefined
      const hint = inner
        ? ` 사용자가 등록한 ${PAY_KINDS[inner.kind]} 결제 수단은 "${inner.inner}"이에요. 결제 창에서 고를 수 있으면 그걸 고르고, 결제 비밀번호는 browser_request_code(kind: "pin")로 폰 키패드, 본인 확인은 browser_wait_auth로 받아요.`
        : ''
      // 여러 개를 한 번에 승인했으면(일정 6개 지우기 등) 같은 사이트·같은 종류의 버튼은 10분 안에 남은 개수만큼 묻지 않고 누른다.
      // 사이트 통째로 30분 통과는 없다: 승인 한 번 = 버튼 한 번 (결제는 묶지 않는다)
      const many = this.series.get(id)
      this.series.delete(id)
      let rest = ''
      if (many && many > 1 && rec.kind !== 'money') {
        this.grantSeries(rec.url, rec.kind as RiskKind, many - 1)
        rest = ` 사용자가 ${many}개 모두 승인했어요: 남은 ${many - 1}개는 같은 버튼을 승인 요청 없이 browser_click으로 이어서 눌러요(10분 안).`
      }
      const pressed = `${how ? `${how}을(를) 고르고 ` : ''}"${finalName}" 버튼을 눌렀어요.${also}`
      if (rec.kind !== 'money') {
        const msg = `${pressed}${rest} 지금 화면: ${r.title ?? ''} (${r.url ?? ''})`
        this.approvals.finish(id, true, msg)
        return { ok: true, message: msg }
      }
      // 결제: 여기서 끝이 아니다. 누른 탭과 결제 창을 결제 묶음으로 묶고, 주문 완료(browser_order_done)까지 이어 간다.
      // 결제 창은 늦게 새 창으로 뜰 때가 많다: 잠깐 기다려 한 번 더 보고, 그 뒤에도 몇 번 더 찾는다(startSession)
      if (!r.newTabId) {
        await new Promise((res) => setTimeout(res, this.payPopupWaits[0] ?? 0))
        const late = (await this.browser.call('popup', { tabId: rec.tabId }).catch(() => ({}))) as {
          newTabId?: number
        }
        if (late.newTabId) r = { ...r, newTabId: late.newTabId }
      }
      const x = this.startSession(id, rec.tabId, rec.url, finalName, r.newTabId ? [r.newTabId] : [])
      const msg = `${pressed}${hint} ${this.payingText(x)} 지금 화면: ${r.title ?? ''} (${r.url ?? ''})`
      // 승인 기록은 '승인됨(결제 중)'으로 두고, 주문 완료를 확인하면(browser_order_done) 주문번호와 함께 끝낸다
      this.approvals.progress(id, msg)
      return { ok: true, message: msg }
    } catch (e) {
      const msg = `"${rec.label}" 버튼을 누르지 못했어요: ${(e as Error).message}`
      this.approvals.finish(id, false, msg)
      return { ok: false, message: msg }
    }
  }

  /**
   * 돈 내기 서비스 도구가 이 탭을 AI에게 넘겼다: 여기서부터 결제 흐름이다 (탭을 잡아 두고, 결제 화면·확정 화면 안내를 붙인다).
   * 버튼을 승인 없이 누르게 하는 우회는 없다: 결제 화면으로 넘어가기만 하는 버튼은 AI가 opens_checkout으로 판단한다
   */
  startPayFlow(tabId: number, tool: string, sites: string[] = [], now = Date.now()) {
    this.payFlows.set(tabId, { tool, at: now })
    // 좌석·장바구니를 잡아 둔 탭: 승인·결제 수단을 고르는 동안 정리에서 닫히지 않게
    this.hold(tabId, REMOTE_TTL_MS)
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

  /** 탭이 닫혔다 (사용자·탭 정리): 그 탭의 기록을 지우고, 기다리던 승인은 만료시킨다 */
  forgetTab(tabId: number) {
    this.pages.delete(tabId)
    this.guided.delete(tabId)
    this.handedOff.delete(tabId)
    this.dialogs.delete(tabId)
    this.payFlows.delete(tabId)
    // 결제 창이 닫혔다(결제를 마치면 스스로 닫는 창이 많다): 묶음에서 빼고, 다 닫혔으면 묶음도 닫는다
    for (const x of this.liveSessions())
      if (x.tabs.delete(tabId) && !x.tabs.size) this.sessions.delete(x.approvalId)
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

  /** 새 비밀번호를 넣은 뒤의 화면: 끝났으면 금고에 넣고, 이미 있는 계정이면 버린다 */
  private async settlePassword(s: {
    url: string
    title?: string
    text: string
  }): Promise<string | undefined> {
    this.pendingPw = this.pendingPw.filter((p) => Date.now() - p.at < 60 * 60_000)
    const key = siteKey(s.url)
    const p = this.pendingPw.find((x) => x.key === key)
    if (!p) return undefined
    const now = { url: s.url, title: s.title ?? '', text: s.text }
    // 넣은 직후 화면이 기준 (가입 화면에 원래 있던 "이미 가입하셨나요?" 같은 글은 셈하지 않는다)
    if (!p.base) {
      p.base = now
      return undefined
    }
    const r = accountOutcome(now, p.base)
    if (!r) return undefined
    this.pendingPw = this.pendingPw.filter((x) => x !== p)
    if (r === 'exists')
      return `🔐 "${p.username}"은(는) 이미 가입된 계정이래요. 만든 비밀번호는 버렸어요(금고에 넣지 않음). 가입을 멈추고 로그인으로 바꿔요: 비밀번호를 모르면 비밀번호 찾기(사용자 확인 뒤 purpose: "reset").`
    await this.vault?.savePassword?.(p.origin, p.username, p.password)
    this.onAccountSaved?.(s.url)
    return p.purpose === 'reset'
      ? `🔐 비밀번호 변경이 끝난 걸 확인하고 금고에 새 비밀번호를 저장했어요(${p.username}). 다음부터 두리가 이걸로 로그인해요.`
      : `🔐 가입이 끝난 걸 확인하고 금고에 저장했어요(${p.username}). 다음부터 두리가 이 계정으로 로그인해요.`
  }

  /** 로그인 카드로 받은 값: 금고에 넣지만 '확인 전'으로 둔다 (본체가 저장 직후 부른다) */
  markUnverified(origin: string) {
    this.unverified.add(origin)
  }

  /**
   * 금고 값으로 로그인한 뒤 읽은 화면. 됐는지 안 됐는지는 규칙으로 가리지 않고 AI가 화면을 보고 판단한다:
   * 비밀번호 칸이 없는 화면으로 넘어갔으면 성공으로 보고(확인 전 표시를 지운다), 아직 로그인 화면이면 판단을 맡긴다
   */
  private async settleLogin(tabId: number, s: Snapshot): Promise<string | undefined> {
    const t = this.loginTries.get(tabId)
    if (!t) return undefined
    let origin = ''
    try {
      origin = new URL(s.url).origin
    } catch {}
    if (origin === t.origin && /비밀번호칸/.test(s.text))
      return '🔑 방금 금고 값으로 로그인을 시도했어요. 이 화면이 로그인이 안 됐다고 말하면(아이디·비밀번호가 틀렸다는 안내, 같은 로그인 화면 그대로) browser_login을 failed: true와 reason(화면이 한 말)으로 불러 알려 주세요. 아직 버튼을 안 눌렀으면 로그인 버튼부터 누르세요.'
    // 비밀번호 칸이 없는 화면으로 넘어갔다: 성공
    this.loginTries.delete(tabId)
    this.unverified.delete(t.origin)
    return undefined
  }

  /** AI가 화면을 보고 "로그인이 안 됐다"고 알렸다: 카드로 막 받은 값이면 금고에서 지우고, 다시 받을 수 있게 한다 */
  private async loginFailed(tabId: number, reason: string): Promise<ToolResult> {
    const t = this.loginTries.get(tabId)
    let origin = t?.origin
    if (!origin)
      try {
        origin = new URL(this.pages.get(tabId)?.url ?? '').origin
      } catch {}
    if (!origin) throw new Error('어느 사이트 로그인인지 몰라요. 페이지를 다시 읽어(browser_read) 주세요')
    this.loginTries.delete(tabId)
    const fresh = this.unverified.has(origin)
    if (fresh && t) await this.vault?.remove?.(t.entryId)
    // 예전에 저장한 값이 바뀌었을 수도 있다: 카드를 다시 띄울 수 있게 한다(새 값이 예전 값을 덮는다)
    this.unverified.add(origin)
    const why = reason ? `("${reason.slice(0, 60)}")` : ''
    return {
      content: [
        {
          type: 'text',
          text: fresh
            ? `🔑 로그인이 안 됐어요${why}. 카드로 받은 아이디·비밀번호가 틀려서 금고에서 지웠어요. browser_request_login으로 카드를 다시 띄워 받으세요(사용자가 비밀번호를 모르면 비밀번호 찾기로).`
            : `🔑 로그인이 안 됐어요${why}. 금고에 있던 값이 바뀐 것 같아요. browser_request_login으로 카드를 띄워 새 값을 받으세요(받으면 예전 값을 덮어요). 사용자가 비밀번호를 모르면 비밀번호 찾기로.`,
        },
      ],
    }
  }

  /** 기다리기: 화면이 바뀔 때까지(많아야 ms) 기다리고 무엇이 바뀌었는지 알린다. 됐는지는 AI가 화면을 읽어 판단한다 */
  private async waitChange(tabId: number, a: Record<string, unknown>): Promise<ToolResult> {
    const ms = Math.min(Math.max(Number(a.ms) || 3_000, 100), 10_000)
    const r = (await this.browser.call(
      'wait',
      { tabId, ms, until: a.until === 'time' ? 'time' : 'change' },
      ms + 20_000,
    )) as BrowserState & {
      title?: string
      waitedMs?: number
      changed?: boolean
      what?: string[]
      dialogNotes?: SiteDialog[]
    }
    const sec = ((r.waitedMs ?? ms) / 1000).toFixed(1)
    if (r.dialog) this.dialogs.set(tabId, r.dialog)
    const lines = [
      `[탭 ${tabId}] ${r.title || '(제목 없음)'} — ${r.url ?? ''}`,
      r.changed ? `${sec}초 기다렸어요. 바뀐 것:` : `${sec}초 기다렸는데 화면이 그대로예요.`,
      ...(r.what ?? []).map((w) => `- ${w}`),
      ...dialogLines(r.dialogNotes ?? []),
      ...(r.dialog ? openDialogLines(r.dialog) : []),
      ...(r.changed && !r.dialog ? ['무엇이 됐는지는 browser_read로 화면을 읽어 확인해요.'] : []),
    ]
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }

  /** 두리 탭 목록: 새 창·결제 창이 어디 열렸는지, 막힌 새 창, 정리로 닫힌 탭 */
  private async tabList(a: Record<string, unknown>): Promise<ToolResult> {
    const tabId = Number(a.tabId)
    const r = (await this.browser.call('tabs', Number.isInteger(tabId) ? { tabId } : {})) as {
      tabs?: {
        tabId: number
        url: string
        title: string
        opener?: number
        createdAt?: number
        windowType?: string
        active?: boolean
        loading?: boolean
        held?: boolean
        sleeping?: boolean
      }[]
      closed?: { tabId: number; opener?: number; url: string; title: string; closedAt?: number }[]
      tidied?: { tabId: number; url: string; title: string; why: string; at: number }[]
      blockedPopups?: { tabId: number; url: string; at: number }[]
    }
    const ago = (t?: number) => {
      if (!t) return ''
      const m = Math.round((Date.now() - t) / 60_000)
      return m < 1 ? '방금' : `${m}분 전`
    }
    const tabs = r.tabs ?? []
    const lines = [
      `두리 탭 ${tabs.length}개:`,
      ...tabs.map((t) => {
        const bits = [
          t.opener !== undefined ? `탭 ${t.opener}이(가) 연 창` : '',
          t.windowType && t.windowType !== 'normal'
            ? `${t.windowType === 'popup' ? '팝업' : t.windowType} 창`
            : '',
          t.active ? '앞 탭' : '',
          t.loading ? '불러오는 중' : '',
          t.held ? '잡아 둠' : '',
          t.sleeping ? '잠듦' : '',
          t.createdAt ? `${ago(t.createdAt)} 열림` : '',
        ].filter(Boolean)
        return `- [탭 ${t.tabId}] ${t.title || '(제목 없음)'} — ${t.url}${bits.length ? ` (${bits.join(' · ')})` : ''}`
      }),
      ...((r.closed ?? []).length
        ? [
            '최근 닫힌 새 창:',
            ...(r.closed ?? []).map(
              (c) =>
                `- 탭 ${c.tabId}${c.opener !== undefined ? ` (탭 ${c.opener}이(가) 연 창)` : ''} ${c.title || ''} — ${c.url || '(주소 모름)'}, ${ago(c.closedAt)} 닫힘`,
            ),
          ]
        : []),
      ...((r.blockedPopups ?? []).length
        ? [
            'Chrome이 막은 새 창(팝업 차단):',
            ...(r.blockedPopups ?? []).map(
              (b) =>
                `- 탭 ${b.tabId}에서 ${ago(b.at)}: ${b.url || '(주소 없는 빈 창: 결제 양식을 보내는 창일 수 있어요)'}`,
            ),
          ]
        : []),
      ...((r.tidied ?? []).length
        ? [
            '두리가 정리하며 닫은 탭:',
            ...(r.tidied ?? []).map((t) => `- 탭 ${t.tabId} ${t.title || t.url} — ${t.why}, ${ago(t.at)}`),
          ]
        : []),
    ]
    return { content: [{ type: 'text', text: lines.join('\n') }] }
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
    // 화면을 덮은 창(쿠키 동의·광고·재촉 팝업)은 몰래 닫지 않는다: 닫기 버튼 표시만 알려 AI가 정하게 한다
    // (예전엔 읽을 때마다 두리가 몰래 눌렀다. 실측 2026-11-18 호텔스닷컴: 쿠키 창 막이 [예약하기]를 가렸던 일 때문)
    const cover = !s.dialog ? coverLine(s.text) : undefined
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
    const accountNote = await this.settlePassword(s)
    const loginNote = await this.settleLogin(tabId, s)
    // 구매 버튼을 눌렀는데 "옵션을 선택해 주세요"가 떴으면, 옵션 칸을 짚어 고르는 법을 알린다
    const optionNote =
      notes.some((d) => d.type !== 'beforeunload' && NEED_OPTION.test(d.message)) ||
      /옵션\s*선택\s*후에|옵션을\s*(먼저\s*)?선택해\s*주세요/.test(s.text)
        ? (() => {
            const fields = optionFields(info.refs)
            return `🧩 옵션을 먼저 골라야 해요.${fields.length ? ` 옵션 칸: ${fields.join(' ')}.` : ''} browser_select(ref)로 목록을 보고, 사용자가 말한 옵션(없으면 기억해 둔 사이즈·색)을 choose로 고른 뒤 다시 구매 버튼을 눌러요. 기억에도 없으면 사용자에게 한 번만 물어요(목록에서 고를 수 있는 것과 품절을 같이 알려 주기).`
          })()
        : undefined
    const guide = await this.guideFor(tabId, s.url)
    const ses = this.paySession(tabId)
    const flow = ses ? undefined : this.payFlow(tabId)
    const lines = [
      ...(note ? [note] : []),
      `[탭 ${tabId}] ${s.title || '(제목 없음)'} — ${s.url}`,
      ...(cover ? [cover] : []),
      ...(accountNote ? [accountNote] : []),
      ...(loginNote ? [loginNote] : []),
      ...(optionNote ? [optionNote] : []),
      ...(ses
        ? [
            `💳 결제 중이에요(묶음: ${[...ses.tabs].map((t) => `탭 ${t}`).join('·')}). 결제 회사 창 안의 버튼은 다시 승인받지 않아요. 주문 완료 화면과 주문번호가 보이면 browser_order_done으로 끝내요.`,
            ...(info.confirmed
              ? [
                  `✅ 화면에 "${info.confirmed}"이(가) 보여요. 주문 완료면 주문번호를 읽어 browser_order_done(order_no)을 불러요.`,
                ]
              : []),
          ]
        : []),
      ...(flow && info.confirmed
        ? [
            `⚠ 화면에 "${info.confirmed}"이(가) 보여요. 예약·주문이 이미 확정됐을 수 있어요. 사용자에게 그대로 알리고 내역 화면에서 확인해 주세요.`,
          ]
        : flow && info.checkout
          ? [
              `💳 결제 화면이에요('${info.checkout}'). 최종 금액·취소 규정·예약자 정보를 읽고, 마지막 버튼은 browser_checkout(결제 카드)으로 한 번만 승인받아요. 그 전에 이 화면의 배송지 바꾸기(사이트마다 이름이 달라요)를 열어 저장된 다른 배송지를 읽고 닫은 뒤, 상품(goods)·금액 줄(lines)·최종 금액(total)·받는 곳(ship_to·ship_options)·결제 수단(choices)·정보 줄(info: 도착·요청사항·예약자)을 한 카드에 넣어요. 결제 비밀번호 키패드가 뜨면 browser_request_code(kind: "pin", key_refs: 키패드 버튼 표시들)로 버튼마다 잘린 그림을 받아 숫자를 짚고(keys) 다시 불러 폰 보안 키패드로 받아요. 처음 쓰는 새 카드 번호처럼 사람만 넣을 수 있는 칸일 때만 비상(browser_handoff, emergency)이에요.`,
            ]
          : []),
      ...(s.captcha
        ? [
            '⚠ 로봇 확인(캡차·자동입력 방지)이 보여요. 글자를 입력하는 보안문자면 browser_request_code(kind: "captcha")로 그림과 함께 폰 카드로 받아요(글자를 네가 읽어 넣지 않는다). 그림을 눌러 푸는 확인(지도에서 위치 누르기·칸 고르기)이면 browser_screenshot으로 화면을 본 뒤 browser_request_tap(box: 문제 그림 자리, say: 문제 글)으로 폰에 그림을 보내 사용자가 누르게 해요. "로봇이 아닙니다" 체크 한 번이면 직접 눌러요. PC 화면을 사람에게 넘기지 않아요.',
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
            `(글이 길어 여기까지 ${max}자만 보여 드렸어요. 이어서 보려면 skip: ${(s.skipped ?? 0) + (s.mainLength ?? s.text.length)}로 다시 읽고, 찾는 부분이 있으면 from에 그 글자를 넣어 그 줄부터 읽어 주세요)`,
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

/**
 * 화면을 덮은 창 한 줄: 쿠키 동의 창의 거부 버튼, 광고·재촉 팝업의 닫기 버튼. 누르지는 않는다 (AI가 닫을지 정한다).
 * 없으면 undefined
 */
export function coverLine(text: string): string | undefined {
  const refs = parseRefs(text)
  const show = (ref: string, what: string) => {
    const c = refs.get(ref)
    return `🪟 덮은 창: [${ref} ${c?.role ?? '버튼'} "${c?.name ?? ''}"] (${what}). 할 일을 가리면 browser_click으로 닫아요.`
  }
  const cookie = cookieReject(text)
  if (cookie) return show(cookie, '쿠키 동의 창의 거부')
  const promo = promoClose(text)
  return promo ? show(promo, '광고·재촉 창의 닫기') : undefined
}

/** 폰이 보낸 글 조각 풀기 (깨졌으면 그대로) */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
