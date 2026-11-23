// 두리 공통 타입: 에이전트 이벤트, 대화, 데몬 API.
// 폰↔PC 암호화 규약은 M2에서 이 패키지에 추가한다.
import { z } from 'zod'
import type { ConnectionItem, SocialProvider } from './connect.js'
import type { PayMethod, PayMethodInput } from './pay-methods.js'

/** 두리가 실행할 수 있는 AI. 사용자의 구독으로 돈다. */
/** claude·codex: 구독, opencode: API 키 종량제 (ADR 0010) */
export const AgentIdSchema = z.enum(['claude', 'codex', 'opencode'])
export type AgentId = z.infer<typeof AgentIdSchema>

export const AGENT_LABEL: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'API 키 (종량제)',
}

/** 설치·로그인 상태. 첫 설정 마법사와 진단 화면이 쓴다. */
export interface AgentStatus {
  id: AgentId
  installed: boolean
  version?: string
  /** 실행 파일 위치 */
  path?: string
  loggedIn: boolean
  /** 구독 종류 (예: max, pro, plus) */
  plan?: string
  /** 사용자에게 보여 줄 문제 설명. 없으면 정상 */
  problem?: string
}

/** 사용량 한도 한 칸 (예: 5시간 창, 7일 창) */
export interface UsageLimit {
  kind: string
  /** 0~100 */
  percent: number
  resetsAt?: string
}

/** 에이전트 한 턴 동안 나오는 이벤트. Claude·Codex 어댑터가 이 형태로 바꿔서 낸다. */
export type AgentEvent =
  | { type: 'started'; resumeId?: string; model?: string; tools: string[] }
  | { type: 'text'; delta: string }
  /** title: 서비스 도구의 사람이 읽는 제목 (엔진이 붙인다, 일하는 중 표시용) */
  | { type: 'tool'; name: string; input: unknown; title?: string }
  | { type: 'tool_result'; name?: string; ok: boolean }
  | { type: 'usage'; limits: UsageLimit[] }
  /** 종량제: 이번 단계에 쓴 돈(USD)과 토큰 */
  | { type: 'cost'; usd: number; inputTokens: number; outputTokens: number }
  /**
   * 지금 AI 세션이 실제로 읽는 양(토큰). 차례의 마지막 AI 호출 기준, 차례마다 한 번 (ADR 0015).
   * 브라우저 페이지 같은 도구 결과까지 들어 있어서, 구간을 바꿀 때를 정하는 데 쓴다. 화면에는 쓰지 않는다
   */
  | { type: 'context'; tokens: number }
  | { type: 'limit_reached'; resetsAt?: string; message: string }
  | { type: 'error'; code: AgentErrorCode; message: string }
  | { type: 'done'; resumeId?: string; text: string }

export type AgentErrorCode =
  | 'not_installed'
  | 'not_logged_in'
  | 'rate_limited'
  | 'tools_unsafe'
  | 'process_failed'
  | 'aborted'
  | 'unknown'

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

export interface ThreadSummary {
  id: string
  agent: AgentId
  title: string
  createdAt: string
  updatedAt: string
  /** 지금 답하는 중 (홈의 맡긴 일 카드·왼쪽 목록에서 도는 원) */
  busy?: boolean
  /** 마지막 두리 답의 앞부분 (마크다운 기호는 뺀 글자) */
  preview?: string
  /** 이 대화에서 승인을 기다리는 요청 */
  approval?: { id: string; what: string; amount?: string; label: string }
  /** 따로 하는 대화 (메인 대화가 아니다) */
  side?: boolean
}

/** 미리보기용: 마크다운 기호를 빼고 한 줄로 줄인다 */
export function previewText(text: string, max = 140): string {
  const flat = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*(?:[-*•]|\d{1,3}[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export interface StoredMessage {
  id: string
  threadId: string
  role: MessageRole
  text: string
  createdAt: string
}

// ── 데몬 로컬 API (PC 앱 화면 ↔ dool2d) ──────────────────────────

export const CreateThreadRequestSchema = z.object({
  /** 없으면 설정의 기본 AI (준비된 것 중) */
  agent: AgentIdSchema.optional(),
  /** 따로 하는 대화 (메인 대화에 섞지 않는다) */
  side: z.boolean().optional(),
})
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>

/** 따로 하는 대화는 이만큼까지 (피드 글을 쓰는 대화는 세지 않는다). 넘으면 안 쓰는 걸 지워 달라고 한다 */
export const SIDE_THREAD_MAX = 50
/** 메뉴에 처음 보여 주는 따로 하는 대화 수. 나머지는 '더 보기'로 펼친다 */
export const SIDE_THREAD_PEEK = 8

export const SendMessageRequestSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** 사진 (JPEG base64) */
  image: z.string().max(2_000_000).optional(),
})
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>

// ── 설정 (이 PC에만 저장) ──────────────────────────────────────

/** 첫 실행 때 고른 AI 구독. 잘 모르면 'unsure' */
export const AiChoiceSchema = z.enum(['claude', 'codex', 'both', 'unsure', 'payg'])
export type AiChoice = z.infer<typeof AiChoiceSchema>

export const SettingsSchema = z.object({
  /** 첫 실행 마법사를 끝냈는지 */
  setupDone: z.boolean(),
  aiChoice: AiChoiceSchema.optional(),
  /** 새 대화를 시작할 때 고를 AI */
  defaultAgent: AgentIdSchema.optional(),
  /** PC가 잠들지 않게: 일하는 동안만 / 항상 / 안 함 (docs/architecture.md 7.1) */
  keepAwake: z.enum(['working', 'always', 'off']).optional(),
  /** PC를 켜면 두리도 자동으로 켜기 */
  launchAtLogin: z.boolean().optional(),
  /**
   * 결제·보내기 같은 마지막 버튼: approve = 승인하면 두리가 누름 / self = 항상 사용자가 직접 누름
   * (ADR 0006 다시 검토의 "마지막 확인" 스위치)
   */
  finalStep: z.enum(['approve', 'self']).optional(),
  /** 폰에 보일 이 PC 이름. 비우면 컴퓨터 이름 */
  pcName: z.string().trim().min(1).max(40).optional(),
  /** 폰 연결에 쓸 중계 서버 주소 (M6). 비우면 기본 주소 */
  relay: z.string().url().max(200).optional(),
  /** 종량제 모드에서 고른 제공자·모델 (API 키는 여기 두지 않고 OS 키체인에) */
  payg: z.object({ provider: z.string(), model: z.string() }).optional(),
  /** PC 화면 제어로 다뤄도 된다고 허용한 앱 (맥 번들 id) */
  allowedApps: z
    .array(
      z
        .string()
        .regex(/^[\w.-]+$/)
        .max(200),
    )
    .max(100)
    .optional(),
  /** 사용 통계 보내기 (숫자만, apps/daemon/src/stats.ts). 비어 있으면 아직 안 물어봤다 */
  usageStats: z.boolean().optional(),
  /** 연결을 마친 서비스 (skills/<id>/connect.json의 id → 연결한 시각) ADR 0014 */
  connections: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/), z.string().max(40)).optional(),
})

/** PC 화면 제어 상태 (설정 화면) */
export interface ScreenControlStatus {
  /** 이 PC에서 쓸 수 있는지 (도우미가 있는지, 지금은 맥만) */
  available: boolean
  accessibility?: boolean
  screenRecording?: boolean
  locked?: boolean
  allowed: string[]
}
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = { setupDone: false }

/** 바꿀 항목만 보낸다. 모르는 항목은 거절한다 */
export const SettingsPatchSchema = SettingsSchema.partial().strict()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

// ── Claude 로그인 (공식 `claude auth login`을 띄워 진행) ─────────────

export type ClaudeLoginStatus =
  | { state: 'idle' }
  /** url: 브라우저에서 열 로그인 주소. codeRejected: 붙여 넣은 코드가 맞지 않았음 */
  | { state: 'waiting'; url?: string; codeRejected?: boolean }
  | { state: 'done' }
  | { state: 'failed'; message: string }

// ── 부품 설치 (Claude Code, Chrome) ─────────────────────────

export type InstallPhase = 'prepare' | 'download' | 'verify' | 'setup'

export type InstallStatus =
  | { state: 'idle' }
  /** percent: 내려받기 진행률(0~100) */
  | { state: 'running'; phase: InstallPhase; percent?: number }
  | { state: 'done'; version?: string }
  | { state: 'failed'; message: string }

export interface ChromeStatus {
  installed: boolean
  version?: string
  path?: string
}

// ── 종량제 (API 키) ──────────────────────────────────────────────

export interface PaygModel {
  id: string
  label: string
}

export interface PaygProvider {
  id: string
  label: string
  /** 키를 받는 곳 */
  keyUrl: string
  models: PaygModel[]
}

/** 저장된 종량제 계정. API 키 자체는 절대 내보내지 않는다 */
export interface PaygAccount {
  provider: string
  model: string
  hasKey: boolean
  /** 키 끝 4자리 (확인용) */
  keyHint?: string
}

export const PaygAccountRequestSchema = z.object({
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(120),
  /** 비우면 모델만 바꾼다 */
  apiKey: z.string().trim().min(8).max(500).optional(),
})

export const ClaudeLoginCodeSchema = z.object({
  code: z.string().trim().min(1).max(2_000),
})

/** 데몬이 SSE로 흘려보내는 이벤트 */
export type DaemonStreamEvent =
  | { type: 'agent'; event: AgentEvent }
  | { type: 'saved'; message: StoredMessage }
  | { type: 'end' }

// ── 대화 하나 (ADR 0015) ───────────────────────────────────────

/** GET /api/conversation: 대화 기록 (모든 구간을 시간순으로) */
export interface ConversationState {
  messages: StoredMessage[]
  /** 지금 답하는 중 */
  busy: boolean
  /** 답하는 동안 보내서 차례를 기다리는 말 */
  queued: string[]
  /** 더 앞의 말이 있을 수 있음 (before로 더 불러오기) */
  hasMore: boolean
}

/** GET /api/conversation/live: 대화에서 일어나는 일 (어디서 시작한 차례든) */
export type ConversationLiveEvent =
  /** side: 따로 하는 대화(피드 글 포함)의 차례. 메인 대화 화면에는 넣지 않는다 */
  | {
      kind: 'turn'
      threadId: string
      side?: boolean
      /** 본체가 대화에 바로 남긴 말·카드 (연결 카드·앱 알림). 두리가 답하는 차례가 아니다 */
      posted?: boolean
      event: DaemonStreamEvent
    }
  | { kind: 'queued'; texts: string[] }
  | { kind: 'busy'; busy: boolean }
  /** 목표·보관함·기억·피드가 바뀌었다 (GET /api/life로 다시 받는다) */
  | { kind: 'life' }
  /** 처음부터 다시(시험용 PC): 대화·기억이 모두 지워졌다. 화면을 처음부터 다시 받는다 */
  | { kind: 'reset' }
  /** 연결하기: 지금 로그인하는 서비스가 바뀌었다 */
  | { kind: 'connect'; connecting: string[] }

// ── 브라우저 손 (ADR 0006): 두리 본체 ↔ native messaging ↔ 두리 확장 ──────

/** native messaging 호스트 이름. Chrome이 이 이름으로 등록 파일을 찾는다 */
export const BROWSER_HOST_NAME = 'com.dool2.host'

/**
 * 개발용 확장 id. apps/extension/manifest.json의 `key`(공개키)에서 나온다.
 * 웹 스토어에 올리면 스토어 id를 여기에 더한다 (M5).
 */
export const DEV_EXTENSION_ID = 'mgjjgnbhoaalicncjbbcldjffpecocah'

/**
 * Chrome 웹 스토어에 올린 두리 확장 id. 스토어가 처음 올릴 때 정해 주므로 올린 뒤에 채운다.
 * 채우면 PC 앱이 "웹 스토어에서 추가(클릭 한 번)"와 외부 확장 등록을 쓴다. 비어 있으면 확장 폴더를 직접 올리는 안내.
 * Edge·웨일도 Chrome 웹 스토어의 같은 확장을 쓴다 (Edge는 외부 등록에 스토어 주소를 그대로 받는다).
 */
export const STORE_EXTENSION_ID: string | undefined = 'ogpbnlgnijmebpeiaceeepemcngiocif'

/**
 * 웹 스토어 심사를 통과해 게시됐는가. true일 때만 PC 앱이 [Chrome에서 추가]와 외부 확장 등록을 쓴다
 * (게시 전에 켜면 아직 없는 스토어 페이지가 열린다). 연결 통로는 게시 전에도 스토어 id를 허용해 둔다.
 * 2026-11-17 제출 (미등록·검토 통과 후 자동 게시). 2026-11-23 게시 확인(스토어 페이지 0.2.0).
 */
export const STORE_EXTENSION_PUBLISHED = true

/** 확장 업데이트를 받는 Chrome 웹 스토어 주소 (외부 확장 등록에 쓴다) */
export const CHROME_STORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx'

/** 웹 스토어의 두리 확장 페이지 ([Chrome에 추가] 한 번) */
export const storeExtensionPage = (id: string) => `https://chromewebstore.google.com/detail/${id}`

/** 서비스 도구(커넥터) 엔진이 들어간 확장 버전 (extract·find·capture). 이보다 낮으면 서비스 도구를 쓰지 않는다 */
export const MIN_CONNECTOR_EXTENSION = '0.2.0'

/** "0.10.1" >= "0.2.0" 같은 버전 비교 */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const b = min.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}

export const EXTENSION_IDS = [DEV_EXTENSION_ID, ...(STORE_EXTENSION_ID ? [STORE_EXTENSION_ID] : [])]

/** 확장이 할 수 있는 일. 판단은 하지 않고 시킨 것만 한다 */
export const BrowserCommandSchema = z.enum([
  // 펼침 목록(select): 고를 것 읽기, 글자로 고르기 (결제 화면의 등록 카드·할부)
  'options',
  'choose',
  'open',
  'navigate',
  'snapshot',
  'click',
  'type',
  'press',
  'scroll',
  'screenshot',
  'back',
  'close',
  'focus',
  'fill',
  'input',
  'form',
  'form-fill',
  // 보안문자 칸 둘레 그림 후보 (AI가 고른다)
  'captcha-candidates',
  // 표시마다 그 자리만 잘라 찍기 (그림 키패드)
  'element-shots',
  'popup',
  'allow-popups',
  'mark-text',
  'link-navigates',
  /** 커넥터 엔진 (ADR 0018): 목록 뽑기·글자 찾기·페이지가 받은 응답 읽기 */
  'extract',
  'find',
  'capture',
  /** 카드 사진을 받아 줄여 data: 주소로 (브라우저가 받는다: 그 사이트가 막지 않는 길) */
  'thumb',
  /** 확장을 새 코드로 다시 켠다 (압축해제 확장을 다시 빌드한 뒤) */
  'reload',
  /** 떠 있는 사이트 확인 창(confirm·prompt)에서 확인·취소를 고른다 */
  'dialog',
  /** 마우스를 그 자리로 옮기기만 한다 (올려 두어야 열리는 메뉴) */
  'hover',
  /**
   * 사람·승인을 기다리는 탭을 정해진 시간 동안 탭 정리(잠재우기·닫기)에서 뺀다 (ms: 0이면 풀기).
   * 탭은 3개까지만 두는데, 결제 승인을 기다리던 탭이 다른 탭이 열리며 닫혔다 (실측: 롯데시네마)
   */
  'hold',
  /**
   * 기다리기 {tabId, ms?(기본 3000, 많아야 10000), until?: 'change'|'time'}: 화면이 바뀔 때까지(문서 글·요소, 액자 이동,
   * 주소 이동, 새 탭, 알림창·확인 창) 기다리고 무엇이 바뀌었는지(what·details) 돌려준다. 됐는지는 AI가 본다
   */
  'wait',
  /**
   * 두리 탭 목록 {tabId?}: 탭마다 연 탭(opener)·주소·제목·연 때·창 종류·앞 탭인지, 최근 닫힌 새 창,
   * 정리로 닫은 탭, 막힌 새 창(팝업 차단). 늦게 뜬 결제 창·로그인 창을 AI가 직접 찾는다
   */
  'tabs',
  /**
   * PC 파일을 페이지의 파일 칸(input type=file)에 넣는다 {tabId, ref, paths} (블로그 사진·영상·서류 첨부).
   * ref가 버튼·라벨이면 딸린 파일 칸을 찾고, 없으면 눌러서 뜨는 파일 고르기 창을 가로채 넣는다.
   * 확장이 파일을 직접 못 읽으면(파일 접근 꺼짐) {needBytes, token}을 돌려주고, 본체가 조각({token, part})으로
   * 보낸 뒤 끝내기({token, finish})로 넣는다. 해도 되는지(승인)는 본체가 정한다
   */
  'upload',
])
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>

/** 본체 → 확장 */
export interface BridgeRequest {
  id: number
  cmd: BrowserCommand
  args: Record<string, unknown>
}

/** 확장 → 본체: 요청에 대한 답 */
export type BridgeReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

/** 확장 → 본체: 알림 */
export type BridgeNotice =
  | { event: 'hello'; version: string; browser?: string }
  | { event: 'tab-closed'; tabId: number }

export interface ExtensionStatus {
  connected: boolean
  version?: string
  browser?: string
}

export const FocusTabSchema = z.object({ tabId: z.number().int() })

/**
 * 일한 과정: 도구를 써서 일한 차례면 답 바로 앞에 'tool' 메시지로 남긴다.
 * 화면은 접힌 카드("캐치테이블에서 일했어요 · 5단계 · 32초")로 그리고, 펼치면 단계가 보인다
 */
export interface WorkRecordMessage {
  kind: 'work'
  /**
   * 단계 이름과 걸린 시간(ms). 많으면 마지막 30개만.
   * act: 도구가 한 일("웹페이지 여는 중"), place: 일한 곳(toolPlace — 사이트 주소·"tool:…"·"app"·"file").
   * 화면은 place가 같은 단계를 서비스 한 줄로 묶는다 (예전 기록에는 둘 다 없다)
   */
  steps: { text: string; ms: number; act?: string; place?: string }[]
  /** 전체 단계 수 (steps가 잘렸을 때도 원래 수) */
  count: number
  /** 차례 전체에 걸린 시간(ms) */
  ms: number
  /** 웹에서 일했으면 마지막으로 연 사이트 (www.catchtable.co.kr) */
  host?: string
}

/** 연결하는 동안의 한 단계. ask가 있으면 사람이 넣어 줘야 다음으로 간다 (그 요청을 카드에서 바로 연다) */
export interface ConnectStep {
  text: string
  /** 시작 시각 (ms) */
  at: number
  /**
   * 사람이 해 줘야 다음으로 가는 단계.
   * login·info: 그 요청(id)을 폰 입력 화면으로 연다 / confirm: 휴대폰 앱에서 승인을 누르면 된다(id = 탭 번호, 화면 보기용)
   */
  ask?: { kind: 'login' | 'info' | 'confirm'; id: string; label: string; detail?: string }
}

/** 사람에게 넘기기: 대화 기록에 'tool' 메시지로 남겨 다시 열어도 [다 했어요]를 보여 준다 */
export interface HandoffRecord {
  kind: 'handoff'
  tabId?: number
  reason: string
}

// ── 두리 금고 (ADR 0011): 로그인 정보는 PC 키체인에, AI가 아니라 두리가 채운다 ──────

/**
 * 대화 안 로그인 카드: 금고에 없는 사이트에서 두리가 아이디·비밀번호를 부탁한다.
 * 사용자가 카드에 넣은 값은 AI를 거치지 않고 금고에만 저장된다
 */
export interface LoginRequestView {
  id: string
  tabId: number
  /** 금고에 저장할 사이트 주소 (https://…) */
  origin: string
  /** 사용자에게 보일 사이트 이름 */
  site: string
  status: 'pending' | 'saved' | 'cancelled' | 'expired'
  /** 저장한 아이디 (비밀번호는 어디에도 돌려주지 않는다) */
  username?: string
  /** 서비스 연결 중 두리가 부탁한 것 (폰은 바로 입력 화면을 띄운다) */
  connect?: boolean
  createdAt: string
  expiresAt: string
}

/**
 * 로그인 중에 화면이 묻는 것 (인증번호·휴대폰 번호 등)을 폰 입력 화면으로 받는다.
 * 값은 AI를 거치지 않고 그 칸에만 넣고, 저장하지 않는다
 */
export interface InfoRequestView {
  id: string
  /** 사람에게 보일 사이트 이름·주소 */
  site: string
  host: string
  /** otp: 숫자 인증번호(문자 자동 채우기) · tel: 휴대폰 번호 · text: 그 밖의 글 · form: 여러 칸(내 정보 카드) · choice: 하나 고르기 · password: 사용자가 정하는 새 비밀번호(두 번 넣기, PC 금고로만) · tap: 그림을 눌러 푸는 로봇 확인 */
  field: 'otp' | 'tel' | 'text' | 'form' | 'choice' | 'secret' | 'password' | 'tap'
  /** tap(그림 눌러 풀기)일 때 누를 수 있는 곳 수. 답은 "x,y;x,y" (그림 기준 0~1000) */
  maxTaps?: number
  /** choice일 때 고를 것 (답은 고른 글 그대로) */
  options?: string[]
  /** form일 때 받을 칸들. 답은 {key: 값} JSON 한 줄 */
  fields?: {
    key: string
    label: string
    type: 'text' | 'tel' | 'email' | 'date' | 'choice' | 'secret'
    example?: string
    /** choice일 때 고를 것 (예: 간편인증 앱) */
    options?: readonly string[]
    /** 형식 검사 (정규식 글). 맞지 않으면 폰이 저장 전에 patternHint를 보여 준다 */
    pattern?: string
    patternHint?: string
  }[]
  /** 한 칸 받기(otp·secret 등)의 형식 검사 */
  pattern?: string
  patternHint?: string
  /** 화면의 칸 이름 ("인증번호 6자리") */
  label: string
  /** 화면의 안내 한 줄 ("카카오톡으로 보낸 번호를 넣어 주세요") */
  hint?: string
  /** 보안문자 그림 (jpeg base64). 있으면 카드에 그림을 보이고 그 글자를 받는다 */
  image?: string
  status: 'pending' | 'answered' | 'cancelled' | 'expired'
  expiresAt: string
}

/** 대화 기록에 남기는 로그인 요청 (카드는 본체에 상태를 물어 그린다) */
export interface LoginRecordMessage {
  kind: 'login'
  tabId?: number
  site: string
}

/**
 * 대화 기록에 남기는 먼저 챙긴 일 (ADR 0019). 피드 글(id)과 같은 내용이고,
 * 답(맡겼어요·넘겼어요)은 생활 기록의 그 피드 글에서 읽어 피드 카드와 같이 바뀐다
 */
export interface TellRecordMessage {
  kind: 'tell'
  /** 피드 글 id */
  id: string
  title: string
  body?: string
  from?: string
  ask?: string
  askLabel?: string
}

/** 답에 붙는 카드 한 장 (상품·숙소·식당·공연 등) */
export interface ChatCard {
  title: string
  /** 사진 주소 (https). 화면은 PC에 물어 받는다 (폰이 바깥 서버에 직접 붙지 않는다) */
  image?: string
  /** 가격 한 줄 (예: 350,100원 · 1박 112,260원) */
  price?: string
  /** 짧은 정보 한 줄 (예: ★4.8 (1,203) · 내일 도착) */
  note?: string
  /** 눌렀을 때 열 주소 (https) */
  url?: string
  /** 눈에 띄게 붙일 말 (예: 최저가 · 추천) */
  badge?: string
}

/** 대화 기록에 남기는 카드 묶음 (show_cards). 답 바로 아래에 붙는다 */
export interface CardsRecordMessage {
  kind: 'cards'
  cards: ChatCard[]
  /** portrait: 세로 포스터·책 표지 (3:4). 없으면 정사각 */
  shape?: 'portrait'
}

/** 그림 AI로 만든 그림 (image_make): 답 아래에 큰 그림으로 보인다. photo는 PC가 넘겨주는 "photo:이름" 그림 */
export interface MadeImageRecordMessage {
  kind: 'made'
  title: string
  /** PC 작업 폴더 photos/의 파일 이름 (made-….jpg) */
  photo: string
  /** PC에 둔 원본 경로 (~/Documents/두리/….png) */
  path?: string
}

/** AI가 넘긴 카드를 믿을 수 있는 모양으로 다듬는다: 10장까지, 글 길이 자르기, https 주소만 */
export function cleanCards(input: unknown): ChatCard[] {
  const list = Array.isArray(input) ? input : []
  const str = (v: unknown, n: number) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined
  const https = (v: unknown) => {
    const u = str(v, 800)
    if (!u) return undefined
    try {
      const x = new URL(u)
      // http 주소는 https로 바꿔 본다 (사진·페이지 대부분이 둘 다 된다)
      if (x.protocol === 'http:') x.protocol = 'https:'
      return x.protocol === 'https:' ? x.toString() : undefined
    } catch {
      return undefined
    }
  }
  const out: ChatCard[] = []
  for (const raw of list.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const title = str(r.title, 80)
    if (!title) continue
    const card: ChatCard = { title }
    const image = https(r.image)
    const url = https(r.url)
    const price = str(r.price, 40)
    const note = str(r.note, 60)
    const badge = str(r.badge, 12)
    if (image) card.image = image
    if (price) card.price = price
    if (note) card.note = note
    if (url) card.url = url
    if (badge) card.badge = badge
    out.push(card)
  }
  return out
}

/** 대화 기록에 남기는 서비스 연결 부탁 (connect_ask). 카드는 연결 목록에서 그 서비스를 찾아 그린다 */
export interface ConnectRecordMessage {
  kind: 'connect'
  /** 카드 id 또는 서비스 이름 (AI가 넘긴 그대로) */
  service: string
}

export const LoginSubmitSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
})

export const VaultEntryRequestSchema = z.object({
  /** 사이트 주소 (예: https://nid.naver.com/nidlogin.login). 주소의 origin만 저장한다 */
  url: z.string().trim().min(3).max(500),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
})

/** 화면에 보여 줄 금고 항목. 비밀번호는 절대 내보내지 않는다 */
export interface VaultEntry {
  id: string
  origin: string
  username: string
  createdAt: string
  lastUsedAt?: string
}

// ── 승인 게이트 (M3) ─────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'done' | 'failed'

/** 화면에 보여 줄 승인 요청. 누를 버튼·주소는 두리 본체가 페이지에서 직접 읽은 값이다 */
export interface ApprovalView {
  id: string
  tabId: number
  ref: string
  role: string
  /** 누를 버튼의 글자 (페이지에서 읽은 그대로) */
  label: string
  url: string
  /**
   * app: 처음 다루는 PC 앱을 두리가 조작해도 되는지.
   * file: PC 파일 여러 개 옮기기·휴지통에서 되살리기·실행 파일 받기, print: 종이로 출력,
   * pc: 이 PC 화면 잠그기·잠자기 (ADR 0024. 모두 tabId -2)
   */
  kind: 'money' | 'contact' | 'irreversible' | 'app' | 'file' | 'print' | 'pc'
  reason: string
  /** 아래는 AI가 적은 설명. 틀릴 수 있어서 화면 캡처와 함께 보여 준다 */
  what: string
  where: string
  amount?: string
  cancel?: string
  /** 승인할 목록 (파일 옮기기: "a.pdf → ~/Downloads/영수증/" 한 줄씩). 본체가 만든 값 */
  items?: string[]
  status: ApprovalStatus
  createdAt: string
  expiresAt: string
  /** 처리 결과 (눌렀어요 / 화면이 바뀌어 못 눌렀어요) */
  result?: string
  /**
   * 승인할 때 고르는 것 (결제 수단, '지금 결제·숙박 시설에서 결제'). 결제 화면에 실제로 있는 칸만 들어 있다.
   * 사용자가 고른 것은 승인 서명에 함께 묶인다
   */
  choices?: {
    id: string
    label: string
    /** 내 결제 수단과 맞으면 그 이름 (ADR 0023, 예: '네이버페이 · 신한카드(1234)') */
    mine?: string
  }[]
  /** 선택지 제목 (예: '결제 수단') */
  choiceTitle?: string
  /** 기본으로 고른 것 (이 사이트에서 마지막으로 쓴 것, 없으면 화면에서 이미 골라진 것) */
  choice?: string
  /** 결제 전에 두리가 화면에서 스스로 고른 것 (보험 가입 안 함·약관 동의 등). 사용자가 보고 바꾸게 보여 준다 */
  chose?: string[]
  /**
   * 받는 곳 (결제 화면의 배송지). a0이 지금 골라진 곳, a1부터는 사이트에 저장된 다른 배송지.
   * 다른 곳을 고르고 승인하면 두리가 배송지를 바꾼 뒤 결제한다 (다시 묻지 않는다)
   */
  shipOptions?: { id: string; label: string }[]
  /** 받는 곳이 내 정보 주소와 다르면 그 경고 (본체가 비교한다. 화면은 받는 곳 고르기를 펼쳐 보여 준다) */
  shipWarn?: string
  /**
   * 결제 카드 (browser_checkout, 11-20 사용자 시안): 어느 결제든 같은 틀에 AI가 결제 화면을 보고 채운다.
   * title 가게·상품 묶음 이름, goods 상품 줄, lines 금액 줄(상품·배송비·할인·적립), info 정보 줄(도착·예약자·요청사항·규정).
   * 최종 금액은 amount
   */
  title?: string
  goods?: CheckoutGood[]
  /** 승인한 뒤 일어날 일 (예: "네이버페이 창에서 결제 비밀번호를 폰 키패드로 받아요"). 없으면 '이 결제 버튼 한 번만 눌러요' */
  after?: string
  lines?: { label: string; value: string; kind?: 'discount' | 'fee' | 'point' }[]
  info?: { label: string; value: string }[]
  /**
   * 결제 수단 안의 세부 선택 (등록 카드·할부 개월 등, 결제 화면의 펼침 목록).
   * 사용자가 고른 것은 choice와 함께 쉼표로 이어 승인 서명에 묶인다 (예: "c2,s1o3")
   */
  subChoices?: {
    key: string
    title: string
    options: { id: string; label: string }[]
    choice?: string
    /** 이 결제 수단(choices의 id)을 골랐을 때만 있는 선택 (카드를 골라야 보이는 등록 카드·할부) */
    when?: string
  }[]
}

/** 결제 카드의 상품 한 줄 */
export interface CheckoutGood {
  name: string
  /** 옵션·사이즈·색·객실·좌석 */
  option?: string
  /** 수량 (예: "1개", "2박", "성인 2") */
  qty?: string
  /** 가격 (화면 그대로) */
  price?: string
  /** 사진 주소 (https, PC가 받아 넘긴다) */
  image?: string
}

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  choice: z.string().max(200).optional(),
})

/** 대화 기록에 남기는 승인 요청 (카드를 다시 그릴 때 본체에 상태를 묻는다) */
export interface ApprovalRecordMessage {
  kind: 'approval'
  tabId?: number
  ref?: string
  what: string
}

// ── 폰 ↔ PC 메시지 (M6, ADR 0012). 모두 e2e.ts로 암호화된 봉투 안에 들어간다 ──────

/** QR에 담는 페어링 정보 (주소의 #p= 뒤에 base64url JSON) */
export interface PairInvite {
  /** PC id */
  pc: string
  /** PC X25519 공개키 */
  k: string
  /** 일회용 페어링 비밀 */
  s: string
  /** PC 이름 */
  n: string
  /** 중계 서버 주소. 예전 초대에는 없을 수 있다(그땐 폰 앱을 연 주소, 스토어 앱은 공식 중계 서버) */
  r?: string
}

/** 원격 화면을 폰 화면 크기로 */
export interface ScreenFit {
  width: number
  height: number
}

/** 폰 → PC */
// ── 두리의 생활 기록: 목표·보관함·기억·피드 (본체 저장소에만 둔다) ──

/** 언제: 매일 HH:MM · 요일마다(0=일, 여러 요일) · 매달 며칠(31=말일) · 한 번 · N분마다 (모두 한국 시간) */
export type RoutineSchedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; days: number[] }
  /** 매달 day일 (1~31). 그 날이 없는 달은 그 달 마지막 날 */
  | { kind: 'monthly'; time: string; day: number }
  | { kind: 'once'; at: string }
  | { kind: 'every'; minutes: number }

export const GOAL_CATEGORIES = ['건강', '관계', '돈', '일', '관심사', '생산성', '기타'] as const
export type GoalCategory = (typeof GOAL_CATEGORIES)[number]

/**
 * 목표·알아서 하는 일. category가 있으면 "목표"(계획 단계·진행 기록·체크인),
 * 없으면 "알아서 하는 일"(아침 브리핑, 취소표 지켜보기, 매달 요금 확인)
 */
export interface Routine {
  id: string
  title: string
  /** 정해진 때 두리에게 시킬 말 */
  prompt: string
  /** 정해진 때가 없는 목표도 있다 */
  schedule?: RoutineSchedule
  enabled: boolean
  createdAt: string
  /** 결과를 어디에: 대화(기본) 또는 피드 */
  target?: 'chat' | 'feed'
  category?: GoalCategory
  plan?: { text: string; done: boolean }[]
  log?: { at: string; text: string }[]
  nextRunAt?: string
  lastRunAt?: string
  lastResult?: string
  /** 지켜보기(when_found)가 마지막으로 알린 것 — 다음 차례에 같은 걸 또 알리지 않게 넘긴다 */
  lastTold?: string
  /** 끝나는 때: 날짜(YYYY-MM-DD, 그날까지 돌고 꺼짐) 또는 조건(그때 두리가 이뤄졌다고 하면 꺼짐) */
  until?: string
  /** 알리기: 매번(기본) 또는 조건에 맞을 때만 (아니면 피드·폰 알림 없이 조용히) */
  notify?: 'always' | 'when_found'
  /** 결과 알림 시각 HH:MM(한국 시간): 일은 정한 때 하고 폰 알림만 이 시각까지 미룬다 (밤새 해 두고 아침에 알려 줘) */
  tellAt?: string
  /** 끝나는 때가 지나 스스로 꺼진 시각 */
  endedAt?: string
}

/** 보관함: 두리가 찾아 준 것·만든 것 중 남겨 둔 것 */
export interface LibraryItem {
  id: string
  kind: 'note' | 'link' | 'product' | 'place' | 'file'
  title: string
  body: string
  url?: string
  price?: string
  savedAt: string
  /** 목록에서는 글을 앞부분만 보낸다 (전체는 하나 받기로: GET /api/life/library/<id>, 폰은 life-item) */
  cut?: true
  /** 두리가 만든 파일: PC 경로 (~/Documents/두리/…) */
  path?: string
  /** 두리가 만든 HTML(그림·초대장·보고서)을 PC가 그려 찍은 미리보기 (JPEG base64). 목록에는 안 실린다 */
  image?: string
  /** 목록에 보일 작은 미리보기 (JPEG base64, 가로 128px쯤) */
  thumb?: string
}

/** 보관함 파일 원본을 폰으로 받을 때 한 번에 오는 조각 (중계 봉투 500KB 안에 들게, 암호화로 커지는 것까지 생각) */
export const FILE_CHUNK = 192 * 1024
/** 폰으로 받는 파일 원본의 최대 크기 */
export const FILE_MAX = 60 * 1024 * 1024

/** 기억: 사용자에 대해 알게 된 것 (사용자가 보고 지울 수 있다) */
export interface MemoryItem {
  id: string
  text: string
  source: 'doori' | 'user'
  at: string
}

/**
 * 두리가 알아 둔 것 (조회 기억·한 일 장부). 로그인해서 본 내 정보의 사실(fact)과 두리가 하거나 확인한 신청·결제·예약·배송·가입(done).
 * 지금도 쓸 수 있는지는 정해진 유효기간 없이 AI가 오늘 날짜와 기준 시점을 보고 판단한다
 */
export interface KnowItem {
  id: string
  kind: 'fact' | 'done'
  /** 무엇 (예: "2025년 귀속 총급여", "레뷰 체험단 센티크 신청") */
  title: string
  /** 요약 값 (예: "약 7,750만 원", "발표 11/24") */
  value: string
  /** 어디서 봤는지 (사이트·서비스 이름) */
  source?: string
  /** 그 화면 주소 */
  url?: string
  /** 기준 시점 (예: "2025년 귀속", "11월 실적", "조회한 날") */
  basis?: string
  /** 언제 봤는지·한 날 */
  seenAt: string
  /** 다음에 챙길 때 (발표일·무료취소 마감·도착·만기) */
  next?: string
  /** 그때 할 일 (예: "당첨 발표 확인") */
  nextWhat?: string
  /** 한 일의 상태: 진행 중·끝남(취소·해지·완료). 지우지 않고 끝남으로 둔다 */
  state?: 'open' | 'done'
  updatedAt: string
}

/** 피드: 두리가 한 일·알아서 한 일·먼저 알려 주는 것 */
/** 원격 화면의 입력칸 자리 (사진 비율 0~1). 폰은 여기를 누르면 키보드를 바로 연다 */
export interface RemoteField {
  x: number
  y: number
  w: number
  h: number
  /** 비밀번호 칸 */
  secret?: boolean
  /** 폰 키보드 종류 (numeric·tel·email…) */
  mode?: string
  label?: string
}

/** 원격 화면에 보이는 버튼 (가운데 자리, 사진 비율). 폰은 아래에 큰 버튼으로 모아 보여 준다 */
export interface RemoteButton {
  label: string
  x: number
  y: number
  /** 제출 버튼처럼 주 버튼 */
  main?: boolean
}

/** 지금 글자가 들어갈 칸 */
export interface RemoteFocus {
  label?: string
  secret?: boolean
  mode?: string
  /** 칸에 이미 있는 글자 (비밀번호 칸은 보내지 않는다) */
  value?: string
}

/**
 * 원격 화면의 '필요한 칸만': 사람이 채울 칸·고를 것·누를 버튼.
 * 브라우저 탭(확장)이든 PC 앱 창(접근성)이든 같은 모양으로 폰에 보낸다
 */
export interface RemoteFormField {
  id: string
  kind: 'text' | 'secret' | 'number' | 'tel' | 'email' | 'choice' | 'check'
  label: string
  /** 칸에 이미 있는 글자 (비밀번호 칸은 보내지 않는다) */
  value?: string
  checked?: boolean
  options?: { id: string; label: string; on?: boolean }[]
  max?: number
  hint?: string
  /** 문자로 받는 인증번호 칸 (폰은 여섯 칸으로) */
  code?: boolean
  /** 보안문자 그림 (JPEG base64): 이 칸에 그림의 글자를 쓴다 */
  captcha?: string
}

export interface RemoteFormButton {
  id: string
  label: string
  main?: boolean
}

export interface RemoteForm {
  title?: string
  url?: string
  fields: RemoteFormField[]
  buttons: RemoteFormButton[]
}

/** 폰에서 채운 값 하나: 글자(value), 체크(checked), 고르기(pick = 고른 것의 id) */
export interface RemoteFormValue {
  id: string
  value?: string
  checked?: boolean
  pick?: string
}

export interface RemoteInfo {
  fields?: RemoteField[]
  actions?: RemoteButton[]
  focus?: RemoteFocus | null
}

export interface FeedItem {
  id: string
  kind: 'done' | 'routine' | 'saved' | 'goal' | 'connected' | 'suggest' | 'post'
  title: string
  body?: string
  /** 관련 목표·보관함·대화 id */
  ref?: string
  at: string
  reaction?: 'up' | 'down'
  /** 먼저 챙기기(kind 'suggest'): 어디서 알게 됐는지 한 줄 (예: "쿠팡 주문 내역을 보고") */
  from?: string
  /** 먼저 챙기기: 같은 일을 두 번 알리지 않으려는 열쇠 (예: "coupang-order-123-도착") */
  key?: string
  /** 먼저 챙기기: [해 줘]를 누르면 두리에게 보낼 부탁. 없으면 알리기만 */
  ask?: string
  /** [해 줘] 버튼 글자 (예: "골라 줘"). 없으면 "해 줘" */
  askLabel?: string
  /** 사용자가 고른 답 */
  answered?: 'yes' | 'no'
}

/** 두리 설정: 사용자를 부르는 이름, 말투, 답 길이 */
export interface Identity {
  userName?: string
  tone?: 'warm' | 'neat' | 'buddy'
  length?: 'short' | 'normal' | 'detail'
}

/** 두리가 먼저 찾은 할 일 (아이디어 탭 맨 위) */
export interface SuggestedIdea {
  /** 누르면 그대로 두리에게 보낼 부탁 */
  text: string
  /** 왜 이걸 제안하는지 한 줄 */
  why: string
}

/** 나눠 받는 긴 목록 */
export type LifeList = 'feed' | 'library'
/** 보관함 칸: 만든 것(정리·링크·상품·장소) / 사진·파일 */
export type LibraryTab = 'made' | 'files'

export interface LifeState {
  identity?: Identity
  ideas?: SuggestedIdea[]
  /** 아이디어를 마지막으로 찾은 때 */
  ideasAt?: string
  /** 지금 아이디어를 찾는 중 */
  ideasBusy?: boolean
  routines: Routine[]
  /** 보관함 첫 페이지: 만든 것·사진·파일 칸마다 최근 30개 (글은 앞부분만, cut). 더는 libraryNext로 */
  library: LibraryItem[]
  /** 보관함 칸마다 다음 페이지 커서 (없으면 끝) */
  libraryNext?: { made?: string; files?: string }
  /** 보관함 칸마다 모두 몇 개인지 */
  libraryCount?: { made: number; files: number }
  memory: MemoryItem[]
  /** 두리가 알아 둔 것 (조회 기억·한 일 장부) 최근 순 */
  know?: KnowItem[]
  /** 피드 첫 페이지 (최근 30개). 더는 feedNext로 GET /api/life/feed?before=, 폰은 life-page */
  feed: FeedItem[]
  /** 피드 다음 페이지 커서 (없으면 끝) */
  feedNext?: string
  /** 이번 주 두리가 한 일: 최근 60일 날마다 한 일 개수 (마지막이 오늘, 이 PC 시간 기준) */
  feedDays?: number[]
  /** 피드에 무엇을 올릴지 사용자가 적은 말 */
  feedPrompt?: string
  /** 먼저 챙기기: 아침 6시~밤 10시 한 시간마다, 챙길 때가 된 한 일과 연결한 서비스를 살펴 챙길 일만 알린다 (기본 켜짐) */
  watch?: { on: boolean; at?: string; busy?: boolean }
}

export type LifeAction =
  | {
      action: 'routine-create'
      title: string
      prompt: string
      schedule?: RoutineSchedule
      category?: GoalCategory
    }
  | { action: 'goal-step'; id: string; index: number; done: boolean }
  | { action: 'feed-react'; id: string; reaction?: 'up' | 'down' }
  /** 먼저 챙긴 일의 제안에 답하기 ([해 줘]는 화면이 그 부탁을 대화로 따로 보낸다) */
  | { action: 'feed-answer'; id: string; answer: 'yes' | 'no' }
  | { action: 'feed-prompt'; text: string }
  | { action: 'library-save'; title: string; body: string; itemKind?: LibraryItem['kind'] }
  | { action: 'routine-toggle'; id: string; on: boolean }
  | { action: 'routine-delete'; id: string }
  | { action: 'routine-run'; id: string }
  | { action: 'library-delete'; id: string }
  | { action: 'memory-add'; text: string }
  | { action: 'memory-delete'; id: string }
  | { action: 'know-delete'; id: string }
  | ({ action: 'identity' } & Identity)
  | { action: 'ideas-refresh' }
  | { action: 'watch'; on: boolean }
  | { action: 'watch-now' }

export type PhoneToPc =
  | { kind: 'pair'; secret: string; signPub: string; name: string }
  | { kind: 'hello' }
  /** 폰에 보일 이 PC 이름 바꾸기 (PC 설정에 저장돼 다른 폰에도 같이 보인다) */
  | { kind: 'rename-pc'; name: string }
  /** 앱을 켜 두고 있어요 (1분마다). PC는 흘려 쓰는 답·실시간 화면을 켜 둔 폰에만 보낸다 */
  | { kind: 'ping' }
  /**
   * 문제 알리기: 폰 앱에서 방금 있었던 일(누른 것·받은 신호의 종류와 시각)을 PC의 일한 기록에 남긴다.
   * 대화 내용·넣은 값은 싣지 않는다. PC에만 며칠 남고 밖으로 나가지 않는다
   */
  | { kind: 'report'; note?: string; trail: { at: number; what: string }[]; app?: string }
  /**
   * 처음부터 다시 (시험용 PC만): PC의 대화·기억·목표·보관함을 지운다. 폰 서명(resetSignText)을 PC가 확인한다.
   * services면 연결한 서비스 표시도 지운다 (금고의 비밀번호·폰 짝짓기는 남는다)
   */
  | { kind: 'reset'; at: number; services: boolean; sig: string }
  /** 카드 사진을 PC에 부탁한다 (폰은 바깥 서버에 직접 붙지 않는다) */
  | { kind: 'thumb'; url: string }
  /** 설정 > 내 정보·결제 수단: 보기(가린 값), 고치기(빈 값 = 지우기), 모두 지우기, 사이트 결제 수단 잊기 */
  /** 설정 > 금고: 목록 보기, 비밀번호 하나 보기(폰 잠금 확인 뒤), 아이디·비밀번호 고치기, 지우기 (ADR 0026) */
  | { kind: 'vault-get' }
  | { kind: 'vault-reveal'; id: string }
  | { kind: 'vault-set'; id: string; username?: string; password?: string }
  | { kind: 'vault-delete'; id: string }
  | { kind: 'profile-get' }
  | { kind: 'profile-set'; values: Record<string, string> }
  | { kind: 'profile-clear' }
  | { kind: 'pay-choice-forget'; host: string }
  /** 내 결제 수단 목록을 통째로 바꾼다 (추가·지우기·순서 바꾸기). 맨 위가 주 결제 수단 (ADR 0023) */
  | { kind: 'pay-methods-set'; methods: PayMethodInput[] }
  | { kind: 'thread'; id: string }
  /** image: 폰에서 줄인 사진 (JPEG base64, 300KB 이하) */
  | { kind: 'ask'; threadId?: string; agent?: AgentId; text: string; image?: string }
  | { kind: 'cancel'; threadId: string }
  | { kind: 'approval'; id: string }
  | { kind: 'decide'; id: string; decision: 'approve' | 'reject'; sig: string; choice?: string }
  /** 로그인 카드에 넣은 아이디·비밀번호 (PC 금고에만 저장된다) */
  | { kind: 'login'; id: string; username: string; password: string }
  /** 원격 화면: 두리가 넘긴 탭의 화면 한 장을 달라 */
  /** fit: 폰 화면 크기(CSS px). 주면 PC 탭을 그 크기로 그려 폰에 꽉 차게 보낸다 */
  | { kind: 'screen'; tabId: number; fit?: ScreenFit }
  /**
   * 원격 화면에서 한 입력. tap·scroll 좌표는 사진 비율(0~1).
   * scroll의 dy는 ±1이면 한 화면씩, 그보다 크면 페이지 픽셀(손가락으로 끈 만큼).
   * view는 그 탭을 폰 너비(w×h CSS 픽셀)로 그리게 하고, leave는 원래대로 돌린다
   */
  | {
      kind: 'remote'
      tabId: number
      /** done: 사람이 넘겨받은 일을 마쳤다 (대화에 '다 했어요'를 쓰지 않고 두리에게 알린다) */
      action: 'tap' | 'text' | 'key' | 'scroll' | 'view' | 'leave' | 'done'
      x?: number
      y?: number
      text?: string
      key?: string
      dy?: number
      fit?: ScreenFit
      w?: number
      h?: number
    }
  /** 원격 화면의 '필요한 칸만'을 달라 */
  | { kind: 'form'; tabId: number }
  /** 칸만 화면에서 채운 값을 넣고, press가 있으면 그 버튼을 누른다 */
  | { kind: 'form-fill'; tabId: number; values: RemoteFormValue[]; press?: string }
  /** 웹 푸시 구독 (알림을 끄면 null). PC가 이 주소로 직접 알림을 보낸다 */
  | { kind: 'push'; sub: PushSubscriptionJSONLike | null }
  /** 서비스 연결 목록을 달라 (ADR 0014) */
  | { kind: 'connections' }
  /** 대화 하나의 기록을 달라 (ADR 0015). before를 주면 그보다 앞의 말 */
  | { kind: 'conversation'; before?: string; limit?: number }
  /** 대화에서 지금 하는 일을 멈춘다 */
  | { kind: 'conversation-cancel' }
  /** 따로 하는 대화: 새로 만들기(→ thread로 답), 지우기 */
  | { kind: 'side-new' }
  | { kind: 'side-delete'; id: string }
  /** 목표·보관함·기억·피드 받기 */
  | { kind: 'life' }
  /**
   * 긴 목록의 다음 페이지 (life-page로 답). before 없으면 첫 페이지.
   * feed는 kinds로 종류를 고를 수 있고(활동: done·routine), library는 tab(만든 것·사진·파일)
   */
  | {
      kind: 'life-page'
      list: LifeList
      before?: string
      limit?: number
      kinds?: FeedItem['kind'][]
      tab?: LibraryTab
    }
  /** 보관함 하나의 전체 글 (목록에는 앞부분만 온다). life-item으로 답 */
  | { kind: 'life-item'; id: string }
  /** 보관함 파일 원본 한 조각 (폰에 저장·공유). path가 있으면 답 속 파일 링크 (id는 폰이 기다리는 표시) */
  | { kind: 'file-chunk'; id: string; offset: number; path?: string }
  | ({ kind: 'life-action' } & LifeAction)
  /**
   * 서비스 연결: open = PC Chrome에 그 서비스를 열고 원격 화면으로 넘겨 달라(폰에서 로그인),
   * mark·unmark = 연결 표시·해제
   */
  /** chat: 대화에 "○○ 연결해 줘"와 연결 카드를 바로 남긴다 (AI를 부르지 않는다) */
  /** verify: [로그인했어요]를 눌렀을 때 — 본체가 사이트를 열어 정말 로그인됐는지 보고 연결로 표시한다 */
  | { kind: 'connect'; id: string; action: 'open' | 'mark' | 'unmark' | 'chat' | 'verify' }
  /** 연결하기: 아이디·비밀번호를 금고에 넣고 두리 본체가 대신 로그인한다 (값은 AI를 거치지 않는다) */
  | { kind: 'connect-login'; id: string; username: string; password: string }
  /** 로그인 중 화면이 묻는 것에 대한 답 (인증번호 등). value가 없으면 취소 */
  | { kind: 'info-answer'; id: string; value?: string }
  /** 카드의 "처음이에요 · 가입해 주세요": 그 사이트(주소) 가입을 사용자가 골랐다. loginId면 그 로그인 카드는 닫는다 */
  | { kind: 'signup'; site: string; loginId?: string }
  /** 계정을 몰라요: 기다리던 로그인 카드를 거두고, 두리가 아이디 찾기·비밀번호 재설정으로 이어 간다 */
  | { kind: 'forgot'; site: string; loginId?: string }
  /** 간편 로그인으로 연결 (카카오·네이버…). 공급자 쪽 로그인이 필요하면 원격 화면으로 넘긴다 */
  | { kind: 'connect-social'; id: string; provider: SocialProvider }

/** 폰 브라우저의 PushSubscription.toJSON() 중 PC가 쓰는 것 */
export interface PushSubscriptionJSONLike {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** PC → 폰 */
export type PcToPhone =
  | { kind: 'paired'; pcName: string }
  | { kind: 'pair-rejected' }
  | {
      kind: 'state'
      pcName: string
      agents: AgentId[]
      defaultAgent?: AgentId
      extension: boolean
      threads: ThreadSummary[]
      approvals: ApprovalView[]
      /** 기다리는 로그인 요청 */
      logins?: LoginRequestView[]
      /** 로그인 중 폰에서 받을 것 (인증번호 등) */
      infos?: InfoRequestView[]
      /** 두리가 마지막으로 다룬 Chrome 탭 (실시간 화면으로 볼 수 있다) */
      activeTab?: number
      /** 웹 푸시 VAPID 공개키 (폰의 applicationServerKey) */
      vapid?: string
      /** 이 폰이 알림을 받도록 PC에 구독이 등록돼 있는지 */
      push?: boolean
      /** 두리 본체가 지금 로그인하고 있는 서비스 */
      connecting?: string[]
      /** 시험용 PC: 폰 설정에 '처음부터 다시'를 보인다 */
      dev?: boolean
    }
  | { kind: 'thread'; thread: ThreadSummary; messages: StoredMessage[] }
  | { kind: 'stream'; threadId: string; event: DaemonStreamEvent }
  | { kind: 'approval'; approval: ApprovalView & { shot?: string } }
  /** 새 로그인 요청, 저장 결과 */
  | { kind: 'login-request'; request: LoginRequestView }
  | { kind: 'info-request'; request: InfoRequestView }
  | { kind: 'info-done'; id: string }
  | { kind: 'login-done'; id: string; ok: boolean; message: string }
  /** 원격 화면 한 장 (JPEG base64)과 그 화면의 입력칸·버튼·지금 칸. 중계 서버는 이 종류를 쌓아 두지 않는다 */
  | ({
      kind: 'screen'
      tabId: number
      shot?: string
      url?: string
      title?: string
      error?: string
    } & RemoteInfo)
  /** 원격 화면의 '필요한 칸만' (form-fill 뒤에도 새로 보낸다) */
  | { kind: 'form'; tabId: number; form?: RemoteForm; error?: string }
  | { kind: 'decided'; id: string; ok: boolean; message: string }
  /** 카드 사진 (PC가 받아 data: 주소로). 못 받으면 data가 없다 */
  | { kind: 'thumb'; url: string; data?: string }
  /** 금고 목록 (비밀번호 없음). message는 방금 한 일의 결과 */
  | { kind: 'vault'; entries: (VaultEntry & { name?: string })[]; message?: string }
  /** 비밀번호 하나 (사용자가 폰 잠금 확인 뒤 부탁했을 때만). 화면은 잠깐 보여 주고 지운다 */
  | { kind: 'vault-secret'; id: string; username: string; password: string }
  /** 내 정보(가린 값)와 사이트별 마지막 결제 수단. message는 방금 한 일의 결과 */
  | {
      kind: 'profile'
      have: Record<string, string>
      missing: string[]
      payChoices: Record<string, string>
      /** 내 결제 수단 (맨 위가 주 결제 수단). 예전 PC는 없다 */
      payMethods?: PayMethod[]
      message?: string
    }
  /** 처음부터 다시의 결과 */
  | { kind: 'reset-done'; ok: boolean; message: string }
  /** 대화 하나의 기록 (before에 대한 답이면 before가 같이 온다) */
  | { kind: 'conversation'; state: ConversationState; before?: string }
  /** 대화가 답하는 중인지, 줄 선 말 (바뀔 때마다) */
  | { kind: 'conversation-status'; busy: boolean; queued: string[] }
  | { kind: 'life'; state: LifeState }
  /** 긴 목록의 한 페이지 (부탁한 것을 그대로 돌려준다: 화면이 어느 목록인지 안다) */
  | {
      kind: 'life-page'
      list: 'feed'
      before?: string
      kinds?: FeedItem['kind'][]
      items: FeedItem[]
      next?: string
    }
  | {
      kind: 'life-page'
      list: 'library'
      before?: string
      tab?: LibraryTab
      items: LibraryItem[]
      next?: string
    }
  /** 보관함 하나 (전체 글). 없으면 item 없음 */
  | { kind: 'life-item'; id: string; item?: LibraryItem }
  | {
      kind: 'file-chunk'
      id: string
      offset: number
      /** 원본 전체 크기 (바이트) */
      size?: number
      name?: string
      mime?: string
      /** 이 조각 (base64) */
      data?: string
      error?: string
    }
  /** 서비스 연결 목록 (카드 + 절차 상태 + 연결 시각) */
  | { kind: 'connections'; services: ConnectionItem[] }
  /** 연결하려고 PC Chrome에 연 탭. 폰은 이 탭을 원격 화면으로 연다 */
  | { kind: 'connect-opened'; id: string; tabId: number }
  /** 대신 로그인 결과. human이면 그 탭을 원격 화면으로 넘겼다(로봇 확인·본인인증) */
  | {
      kind: 'connect-result'
      id: string
      ok: boolean
      message: string
      human?: boolean
      tabId?: number
      /** 왜 못 했는지: 사람 차례(보안문자·본인인증) / 아이디·비밀번호 틀림 / 로그인 칸·결과를 몰라서 */
      reason?: 'human' | 'wrong' | 'unknown'
      /** 자동 로그인이 멈춰서 두리(AI)가 대화에서 그 화면을 보며 이어서 하고 있다 */
      agent?: boolean
    }
  /** 두리가 지금 다루는 Chrome 탭 (대화에 일하는 화면을 실시간으로 띄운다) */
  | { kind: 'work-tab'; tabId: number }
  /** 두리 본체가 지금 로그인하고 있는 서비스 (연결하기는 뒤에서 하고, 끝나면 connect-result와 대화 알림) */
  | { kind: 'connect-status'; connecting: string[] }
  /** 연결하는 동안 본체가 지금 하는 단계 (연결 카드에 보여 준다. at = 시작 시각 ms) */
  /** tabId = 지금 로그인하고 있는 탭 (연결 카드에 그 화면을 작게 실시간으로 보여 준다) */
  | { kind: 'connect-progress'; id: string; steps: ConnectStep[]; tabId?: number }
  | { kind: 'error'; message: string }

export { approvalSignText } from './link.js'
export type { PayKind, PayMethod, PayMethodInput } from './pay-methods.js'

/** 페어링된 폰 (PC가 보관) */
export interface PairedPhone {
  id: string
  name: string
  boxPub: string
  signPub: string
  pairedAt: string
  /** 웹 푸시 구독. 있으면 앱이 꺼져 있어도 알림을 보낸다 */
  push?: PushSubscriptionJSONLike
}

export interface LinkStatus {
  relay?: string
  connected: boolean
  pcId?: string
  phones: (Omit<PairedPhone, 'boxPub' | 'signPub' | 'push'> & { push: boolean })[]
}

export type PairStatus =
  | { state: 'idle' }
  | { state: 'waiting'; url: string; qr: string; expiresAt: string }
  | { state: 'confirm'; code: string; name: string; url: string; qr: string; expiresAt: string }
  | { state: 'done'; name: string }
  | { state: 'expired' }

export const PairConfirmSchema = z.object({ accept: z.boolean() })

/** 간편인증 앱 (내 정보의 '간편인증 앱'): 정부24·홈택스 같은 공공 사이트 간편인증 창에 보이는 이름 그대로 */
export const AUTH_APPS = [
  '카카오톡',
  '네이버',
  '토스',
  'PASS',
  'KB국민인증서',
  '신한인증서',
  '삼성패스',
  '페이코',
] as const

/** 휴대폰 통신사 (본인확인 창에서 고른다). 알뜰폰은 망 이름과 함께 */
export const CARRIERS = ['SKT', 'KT', 'LG U+', 'SKT 알뜰폰', 'KT 알뜰폰', 'LG U+ 알뜰폰'] as const
