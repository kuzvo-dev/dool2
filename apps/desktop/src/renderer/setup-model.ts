// 첫 실행 마법사의 판단 로직. 화면과 떼어 두어 테스트한다.
import type { AgentId, AgentStatus, AiChoice, ChromeStatus, ExtensionStatus } from '@dool2/protocol'

/** settings: 마법사를 끝낸 뒤 여는 설정 화면 (단계 표시 없음) */
export type SetupStep = 'welcome' | 'choice' | 'check' | 'awake' | 'settings'
export const SETUP_STEPS: SetupStep[] = ['welcome', 'choice', 'check', 'awake']
export const AI_CHOICE_LABEL: Record<AiChoice, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  both: 'Claude와 ChatGPT 둘 다',
  unsure: '두리가 고르기',
  payg: '구독 없이 쓴 만큼만 (API 키)',
}

export type CheckAction =
  | 'claude-install'
  | 'claude-login'
  | 'codex-login'
  | 'chrome-install'
  | 'opencode-install'
  | 'codex-install'
  | 'payg-key'
  | 'extension-install'
  /** 설정 화면의 폰 연결 (점검 캡처용) */
  | 'phone-pair'

export interface CheckItem {
  id: string
  label: string
  ok: boolean
  detail: string
  action?: CheckAction
}

export const CHOICES: { id: AiChoice; title: string; sub: string }[] = [
  { id: 'claude', title: 'Claude', sub: 'Pro·Max 구독. Claude Code로 일해요' },
  { id: 'codex', title: 'ChatGPT', sub: 'Plus·Pro 구독. Codex로 일해요' },
  { id: 'both', title: '둘 다 써요', sub: '상황에 맞게 골라 쓸 수 있어요' },
  { id: 'unsure', title: '잘 모르겠어요', sub: '이 컴퓨터를 보고 두리가 골라 드릴게요' },
  { id: 'payg', title: '구독 없이 쓸래요', sub: 'AI 회사의 API 키로, 쓴 만큼만 내요' },
]

/** 고른 구독에 필요한 AI */
export function neededAgents(choice: AiChoice): AgentId[] {
  if (choice === 'claude') return ['claude']
  if (choice === 'codex') return ['codex']
  if (choice === 'payg') return ['opencode']
  return ['claude', 'codex']
}

/** 구독 종류를 사람이 읽기 좋게: max → Max */
export const planLabel = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1)

const ready = (a?: AgentStatus) => Boolean(a?.installed && a.loggedIn)

/** 새 대화에 기본으로 쓸 AI. 준비된 것이 없으면 undefined */
export function pickDefault(choice: AiChoice, agents: AgentStatus[]): AgentId | undefined {
  return neededAgents(choice).find((id) => ready(agents.find((a) => a.id === id)))
}

/** "잘 모르겠어요"는 이미 로그인된 AI가 있으면 그것만 보여 준다 */
function visibleAgents(choice: AiChoice, agents: AgentStatus[]): AgentId[] {
  const need = neededAgents(choice)
  if (choice !== 'unsure') return need
  const already = need.filter((id) => ready(agents.find((a) => a.id === id)))
  return already.length > 0 ? already : need
}

/** 준비 상태 목록. 사용자에게 보이는 문구라서 기술 용어를 쓰지 않는다 */
export function checklist(
  choice: AiChoice,
  agents: AgentStatus[],
  chrome?: ChromeStatus,
  extension?: ExtensionStatus,
): CheckItem[] {
  const items: CheckItem[] = []
  for (const id of visibleAgents(choice, agents)) {
    const a = agents.find((x) => x.id === id)
    if (id === 'claude') {
      if (!a?.installed) {
        items.push({
          id: 'claude-app',
          label: 'Claude Code',
          ok: false,
          detail: '이 컴퓨터에 아직 없어요',
          action: 'claude-install',
        })
        continue
      }
      items.push({ id: 'claude-app', label: 'Claude Code', ok: true, detail: '설치돼 있어요' })
      items.push(
        a.loggedIn
          ? {
              id: 'claude-login',
              label: 'Claude 로그인',
              ok: true,
              detail: a.plan ? `${planLabel(a.plan)} 구독으로 연결됐어요` : '연결됐어요',
            }
          : {
              id: 'claude-login',
              label: 'Claude 로그인',
              ok: false,
              detail: 'Claude 계정으로 로그인해 주세요',
              action: 'claude-login',
            },
      )
    } else if (id === 'opencode') {
      items.push(
        a?.installed
          ? { id: 'opencode-app', label: '종량제 실행기', ok: true, detail: '준비돼 있어요' }
          : {
              id: 'opencode-app',
              label: '종량제 실행기',
              ok: false,
              detail: '처음 한 번 받아 둘게요 (약 110MB)',
              action: 'opencode-install',
            },
      )
      items.push(
        a?.loggedIn
          ? {
              id: 'payg-key',
              label: 'API 키',
              ok: true,
              detail: a.plan ? `${a.plan}로 연결됐어요` : '연결됐어요',
            }
          : {
              id: 'payg-key',
              label: 'API 키',
              ok: false,
              detail: '쓸 AI 회사의 API 키를 넣어 주세요',
              action: 'payg-key',
            },
      )
    } else {
      if (!a?.installed) {
        items.push({
          id: 'codex-app',
          label: 'Codex',
          ok: false,
          detail: '처음 한 번 받아 둘게요 (약 120MB)',
          action: 'codex-install',
        })
        continue
      }
      items.push({ id: 'codex-app', label: 'Codex', ok: true, detail: '준비돼 있어요' })
      items.push(
        a.loggedIn
          ? { id: 'codex-login', label: 'ChatGPT 로그인', ok: true, detail: '연결됐어요' }
          : {
              id: 'codex-login',
              label: 'ChatGPT 로그인',
              ok: false,
              detail: 'ChatGPT 계정으로 로그인해 주세요',
              action: 'codex-login',
            },
      )
    }
  }
  // 브라우저 일은 Chrome으로 한다 (ADR 0006). 대화는 없어도 할 수 있어서 시작을 막지는 않는다
  if (chrome)
    items.push(
      chrome.installed
        ? { id: 'chrome', label: 'Chrome', ok: true, detail: '두리가 브라우저 일을 할 때 써요' }
        : {
            id: 'chrome',
            label: 'Chrome',
            ok: false,
            detail: '예약·조회 같은 브라우저 일을 하려면 필요해요',
            action: 'chrome-install',
          },
    )
  // Chrome이 있으면 두리 확장 연결을 본다
  if (chrome?.installed && extension)
    items.push(
      extension.connected
        ? {
            id: 'extension',
            label: '두리 확장',
            ok: true,
            detail: 'Chrome과 연결됐어요. 평소 로그인 그대로 써요',
          }
        : {
            id: 'extension',
            label: '두리 확장',
            ok: false,
            detail: 'Chrome에 두리 확장을 한 번 추가해 주세요',
            action: 'extension-install',
          },
    )
  return items
}

const COUNT: Record<number, string> = { 1: '한', 2: '두', 3: '세', 4: '네' }

export function checkHeadline(
  choice: AiChoice,
  agents: AgentStatus[],
  chrome?: ChromeStatus,
  extension?: ExtensionStatus,
): { title: string; sub: string } {
  const items = checklist(choice, agents, chrome, extension)
  const left = items.filter((i) => !i.ok).length
  if (left === 0) return { title: '준비가 다 됐어요', sub: '이제 부탁만 하시면 돼요.' }
  if (pickDefault(choice, agents))
    return { title: '바로 시작할 수 있어요', sub: '나머지는 나중에 연결해도 괜찮아요.' }
  return { title: `${COUNT[left] ?? left} 가지만 해 주세요`, sub: '버튼을 누르면 두리가 이어서 할게요.' }
}

/** 원화 어림값에 쓰는 환율. 정확한 금액이 아니라 감을 잡게 하려는 것이라 넉넉히 반올림한다 */
export const KRW_PER_USD = 1450

/** 종량제 비용 표시: "$0.0034 · 약 5원", 1원이 안 되면 "1원 미만" */
export function costLabel(usd: number): string {
  const krw = usd * KRW_PER_USD
  const won = krw < 1 ? '1원 미만' : `약 ${Math.round(krw).toLocaleString('ko-KR')}원`
  const dollars = usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)
  return `$${dollars} · ${won}`
}

/** 새 버전 상태 (apps/desktop/src/update.ts의 UpdateState와 같은 모양) */
export interface UpdateInfo {
  status: 'idle' | 'none' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'
  current: string
  latest?: string
  notes?: string
  required?: boolean
  progress?: number
  error?: string
  checkedAt?: number
}

/** 설정의 '두리 버전' 칸 한 줄: 지금 상태를 사용자 말로 */
export function updateLine(u: UpdateInfo | null, now = Date.now()): string {
  if (!u) return '개발용으로 켠 앱이라 새 버전을 확인하지 않아요'
  const ago = u.checkedAt ? ` · ${agoLabel(now - u.checkedAt)} 확인` : ''
  switch (u.status) {
    case 'none':
      return `최신 버전이에요${ago}`
    case 'available':
      return `새 버전이 나왔어요 (${u.latest})`
    case 'downloading':
      return `새 버전 받는 중 ${Math.round((u.progress ?? 0) * 100)}%`
    case 'ready':
    case 'installing':
      return '새 버전으로 바꾸는 중… 곧 다시 켜져요'
    case 'error':
      return `확인하지 못했어요: ${u.error ?? '인터넷 연결을 확인해 주세요'}`
    default:
      return '아직 확인하지 않았어요'
  }
}

function agoLabel(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`
}
