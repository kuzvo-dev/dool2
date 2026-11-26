// Decision logic of the first-run wizard, kept apart from the screen so it can be tested.
import type { AgentId, AgentStatus, AiChoice, ChromeStatus, ExtensionStatus } from '@dool2/protocol'
import { lang } from './lang.js'
import { setupModelText } from './locales/setup-model.js'

/** settings: the Settings screen opened after the wizard (no step dots) */
export type SetupStep = 'welcome' | 'choice' | 'check' | 'awake' | 'settings'
export const SETUP_STEPS: SetupStep[] = ['welcome', 'choice', 'check', 'awake']
/** Name of a subscription choice, in the UI language */
export function aiChoiceLabel(choice: AiChoice): string {
  const m = setupModelText(lang)
  const labels: Record<AiChoice, string> = {
    claude: 'Claude',
    codex: 'ChatGPT',
    both: m.choiceBoth,
    unsure: m.choiceUnsure,
    payg: m.choicePayg,
  }
  return labels[choice]
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
  /** Phone pairing on the Settings screen (for smoke captures) */
  | 'phone-pair'

export interface CheckItem {
  id: string
  label: string
  ok: boolean
  detail: string
  action?: CheckAction
}

/** Subscription choices on the wizard's second step */
export function choices(): { id: AiChoice; title: string; sub: string }[] {
  const m = setupModelText(lang)
  return [
    { id: 'claude', title: 'Claude', sub: m.claudeSub },
    { id: 'codex', title: 'ChatGPT', sub: m.codexSub },
    { id: 'both', title: m.bothTitle, sub: m.bothSub },
    { id: 'unsure', title: m.unsureTitle, sub: m.unsureSub },
    { id: 'payg', title: m.paygTitle, sub: m.paygSub },
  ]
}

/** AIs needed for the chosen subscription */
export function neededAgents(choice: AiChoice): AgentId[] {
  if (choice === 'claude') return ['claude']
  if (choice === 'codex') return ['codex']
  if (choice === 'payg') return ['opencode']
  return ['claude', 'codex']
}

/** Plan name for people: max → Max */
export const planLabel = (plan: string) =>
  // Codex signed in with a ChatGPT account reports the plan as "chatgpt" (first-run test 11-26: "Chatgpt")
  plan.toLowerCase() === 'chatgpt' ? 'ChatGPT' : plan.charAt(0).toUpperCase() + plan.slice(1)

const ready = (a?: AgentStatus) => Boolean(a?.installed && a.loggedIn)

/** Default AI for new conversations. undefined when none is ready */
export function pickDefault(choice: AiChoice, agents: AgentStatus[]): AgentId | undefined {
  return neededAgents(choice).find((id) => ready(agents.find((a) => a.id === id)))
}

/**
 * "Not sure" found no subscription on this PC (no Claude or Codex signed in): the wizard offers the
 * pay-as-you-go API key instead of only listing installs and sign-ins (people without either subscription
 * otherwise finished setup with no AI and found Dool2 asleep)
 */
export function noSubscriptionFound(choice: AiChoice, agents: AgentStatus[]): boolean {
  return choice === 'unsure' && !pickDefault(choice, agents)
}

/** "Not sure" shows only the AIs already signed in, if any */
function visibleAgents(choice: AiChoice, agents: AgentStatus[]): AgentId[] {
  const need = neededAgents(choice)
  if (choice !== 'unsure') return need
  const already = need.filter((id) => ready(agents.find((a) => a.id === id)))
  return already.length > 0 ? already : need
}

/** Readiness list. People read it, so no technical terms */
export function checklist(
  choice: AiChoice,
  agents: AgentStatus[],
  chrome?: ChromeStatus,
  extension?: ExtensionStatus,
  /** withKey: Settings also shows the API key of a set-up pay-as-you-go runner when another AI was chosen */
  opts: { withKey?: boolean } = {},
): CheckItem[] {
  const m = setupModelText(lang)
  const items: CheckItem[] = []
  for (const id of visibleAgents(choice, agents)) {
    const a = agents.find((x) => x.id === id)
    if (id === 'claude') {
      if (!a?.installed) {
        items.push({
          id: 'claude-app',
          label: 'Claude Code',
          ok: false,
          detail: m.notOnPc,
          action: 'claude-install',
        })
        // The sign-in that follows shows from the start, so "two things" does not turn into three after the install
        // (first-run test 11-26)
        items.push({ id: 'claude-login', label: m.claudeLogin, ok: false, detail: m.afterInstall })
        continue
      }
      items.push({ id: 'claude-app', label: 'Claude Code', ok: true, detail: m.installed })
      items.push(
        a.loggedIn
          ? {
              id: 'claude-login',
              label: m.claudeLogin,
              ok: true,
              detail: a.plan ? m.connectedPlan(planLabel(a.plan)) : m.connected,
            }
          : {
              id: 'claude-login',
              label: m.claudeLogin,
              ok: false,
              detail: m.claudeLoginTodo,
              action: 'claude-login',
            },
      )
    } else if (id === 'opencode') {
      items.push(
        a?.installed
          ? { id: 'opencode-app', label: m.paygRunner, ok: true, detail: m.ready }
          : {
              id: 'opencode-app',
              label: m.paygRunner,
              ok: false,
              detail: m.firstDownload(110),
              action: 'opencode-install',
            },
      )
      items.push(
        a?.loggedIn
          ? {
              id: 'payg-key',
              label: m.apiKey,
              ok: true,
              detail: a.plan ? m.connectedWith(a.plan) : m.connected,
              // A saved key can still be changed or removed (Settings → AI)
              action: 'payg-key',
            }
          : {
              id: 'payg-key',
              label: m.apiKey,
              ok: false,
              detail: m.apiKeyTodo,
              action: 'payg-key',
            },
      )
    } else {
      if (!a?.installed) {
        items.push({
          id: 'codex-app',
          label: 'Codex',
          ok: false,
          detail: m.firstDownload(120),
          action: 'codex-install',
        })
        items.push({ id: 'codex-login', label: m.chatgptLogin, ok: false, detail: m.afterInstall })
        continue
      }
      items.push({ id: 'codex-app', label: 'Codex', ok: true, detail: m.ready })
      items.push(
        a.loggedIn
          ? { id: 'codex-login', label: m.chatgptLogin, ok: true, detail: m.connected }
          : {
              id: 'codex-login',
              label: m.chatgptLogin,
              ok: false,
              detail: m.chatgptLoginTodo,
              action: 'codex-login',
            },
      )
    }
  }
  // A key saved before (or a runner set up) stays changeable in Settings whatever subscription was chosen
  // (beta report 11-25: "the button to edit the API key is not there")
  const payg = agents.find((a) => a.id === 'opencode')
  if (opts.withKey && payg?.installed && !visibleAgents(choice, agents).includes('opencode'))
    items.push({
      id: 'payg-key',
      label: m.apiKey,
      ok: payg.loggedIn,
      detail: payg.loggedIn ? (payg.plan ? m.connectedWith(payg.plan) : m.connected) : m.apiKeyTodo,
      action: 'payg-key',
    })
  // Browser work runs in Chrome (ADR 0006). Chat works without it, so it does not block starting
  if (chrome)
    items.push(
      chrome.installed
        ? { id: 'chrome', label: 'Chrome', ok: true, detail: m.chromeOk }
        : {
            id: 'chrome',
            label: 'Chrome',
            ok: false,
            detail: m.chromeTodo,
            action: 'chrome-install',
          },
    )
  // With Chrome installed, check the Dool2 extension connection
  if (chrome?.installed && extension)
    items.push(
      extension.connected
        ? {
            id: 'extension',
            label: m.extension,
            ok: true,
            detail: m.extensionOk,
          }
        : {
            id: 'extension',
            label: m.extension,
            ok: false,
            detail: m.extensionTodo,
            action: 'extension-install',
          },
    )
  return items
}

export function checkHeadline(
  choice: AiChoice,
  agents: AgentStatus[],
  chrome?: ChromeStatus,
  extension?: ExtensionStatus,
): { title: string; sub: string } {
  const m = setupModelText(lang)
  const items = checklist(choice, agents, chrome, extension)
  const left = items.filter((i) => !i.ok).length
  if (left === 0) return { title: m.allReady, sub: m.allReadySub }
  if (pickDefault(choice, agents)) return { title: m.canStart, sub: m.canStartSub }
  if (noSubscriptionFound(choice, agents)) return { title: m.noSubTitle, sub: m.noSubSub }
  return { title: m.left(left), sub: m.leftSub }
}

/** Exchange rate for the rough won amount. Only meant to give a feel for the cost, so it is rounded generously */
export const KRW_PER_USD = 1450

/** Pay-as-you-go cost: "$0.0034 · about 5 won", or "under 1 won" below one won */
export function costLabel(usd: number): string {
  const krw = usd * KRW_PER_USD
  const m = setupModelText(lang)
  const won =
    krw < 1 ? m.underOneWon : m.aboutWon(Math.round(krw).toLocaleString(lang === 'ko' ? 'ko-KR' : lang))
  const dollars = usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)
  return `$${dollars} · ${won}`
}

/** New version state (same shape as UpdateState in apps/desktop/src/update.ts) */
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

/** One line in Settings' Dool2 version box: the current state in plain words */
export function updateLine(u: UpdateInfo | null, now = Date.now()): string {
  const m = setupModelText(lang)
  if (!u) return m.devBuild
  const ago = u.checkedAt ? m.checkedAgo(agoLabel(now - u.checkedAt)) : ''
  switch (u.status) {
    case 'none':
      return m.upToDate(ago)
    case 'available':
      return m.available(String(u.latest))
    case 'downloading':
      return m.downloading(Math.round((u.progress ?? 0) * 100))
    case 'ready':
    case 'installing':
      return m.installing
    case 'error':
      return m.checkFailed(u.error ?? m.checkInternet)
    default:
      return m.notChecked
  }
}

function agoLabel(ms: number): string {
  const m = setupModelText(lang)
  const min = Math.floor(ms / 60_000)
  if (min < 1) return m.justNow
  if (min < 60) return m.minAgo(min)
  const h = Math.floor(min / 60)
  return h < 24 ? m.hoursAgo(h) : m.daysAgo(Math.floor(h / 24))
}
