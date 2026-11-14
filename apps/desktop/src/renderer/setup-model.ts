// 첫 실행 마법사의 판단 로직. 화면과 떼어 두어 테스트한다.
import type { AgentId, AgentStatus, AiChoice, ChromeStatus } from '@dool2/protocol'

export type SetupStep = 'welcome' | 'choice' | 'check'
export const SETUP_STEPS: SetupStep[] = ['welcome', 'choice', 'check']

export type CheckAction = 'claude-install' | 'claude-login' | 'codex-login' | 'chrome-install'

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
]

/** 고른 구독에 필요한 AI */
export function neededAgents(choice: AiChoice): AgentId[] {
  if (choice === 'claude') return ['claude']
  if (choice === 'codex') return ['codex']
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
export function checklist(choice: AiChoice, agents: AgentStatus[], chrome?: ChromeStatus): CheckItem[] {
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
    } else {
      if (!a?.installed) {
        items.push({ id: 'codex-app', label: 'Codex', ok: false, detail: '이 컴퓨터에서는 쓸 수 없어요' })
        continue
      }
      items.push({ id: 'codex-app', label: 'Codex', ok: true, detail: '두리에 함께 들어 있어요' })
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
  return items
}

const COUNT: Record<number, string> = { 1: '한', 2: '두', 3: '세', 4: '네' }

export function checkHeadline(
  choice: AiChoice,
  agents: AgentStatus[],
  chrome?: ChromeStatus,
): { title: string; sub: string } {
  const items = checklist(choice, agents, chrome)
  const left = items.filter((i) => !i.ok).length
  if (left === 0) return { title: '준비가 다 됐어요', sub: '이제 부탁만 하시면 돼요.' }
  if (pickDefault(choice, agents))
    return { title: '바로 시작할 수 있어요', sub: '나머지는 나중에 연결해도 괜찮아요.' }
  return { title: `${COUNT[left] ?? left} 가지만 해 주세요`, sub: '버튼을 누르면 두리가 이어서 할게요.' }
}
