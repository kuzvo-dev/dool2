// Which AI Dool2 runs on, for the AI itself (ai_account_view), and switching it among the connected ones (ai_use, the
// PC and phone settings). Pay-as-you-go shows company, model and the key's last 4 characters only: the key never
// reaches the AI, and no tool takes or changes it (the person does, in the PC settings)
import type { Lang } from '@dool2/i18n'
import {
  type AgentId,
  type AgentStatus,
  agentLabel,
  type PaygAccount,
  type PaygProvider,
} from '@dool2/protocol'
import { aiAccountCopy } from './locales/ai-account.js'

export interface AiAccountInput {
  /** The AI new conversations use (settings.defaultAgent) */
  defaultAgent?: AgentId | undefined
  /** Last known status of each AI (no new check is run for this) */
  agents: AgentStatus[]
  payg: PaygAccount | null
  providers: PaygProvider[]
}

const ready = (a: AgentStatus | undefined) => Boolean(a?.installed && a.loggedIn)

/** The AI the conversation's next turn runs on: the chosen one when it is connected, else the first connected one */
export function effectiveAgent(chosen: AgentId | undefined, agents: AgentStatus[]): AgentId | undefined {
  if (chosen && ready(agents.find((a) => a.id === chosen))) return chosen
  return agents.find(ready)?.id
}

/** Why an AI cannot be picked yet, or undefined when it can (installed and signed in; for pay-as-you-go, a key saved) */
export function cannotUse(
  id: AgentId,
  agents: AgentStatus[],
): 'not-installed' | 'signed-out' | 'no-key' | undefined {
  const a = agents.find((x) => x.id === id)
  if (!a?.installed) return 'not-installed'
  if (!a.loggedIn) return id === 'opencode' ? 'no-key' : 'signed-out'
  return undefined
}

/** ai_use's result: what happened, what the next message runs on and what it keeps, or why not and what is possible */
export function aiUseText(
  input: { want: AgentId; before?: AgentId | undefined; agents: AgentStatus[] },
  lang: Lang = 'ko',
): string {
  const name = (id: AgentId) => agentLabel(id, 'en')
  const why = cannotUse(input.want, input.agents)
  if (why) {
    const ok = input.agents.filter(ready).map((a) => name(a.id))
    const state =
      why === 'not-installed'
        ? 'is not installed'
        : why === 'no-key'
          ? 'has no API key saved'
          : 'is signed out'
    return [
      `Not switched: ${name(input.want)} ${state} on this PC, so Dool2 stays on ${input.before ? name(input.before) : 'no AI'}.`,
      `Connected now: ${ok.length ? ok.join(', ') : 'none'}.`,
      `Installing and signing in happen in "${aiAccountCopy(lang).settingsPath}" on the PC (the button next to ${name(input.want)}); once it is connected, ai_use switches to it.`,
    ].join(' ')
  }
  if (input.before === input.want) return `Dool2 already runs on ${name(input.want)}. Nothing changed.`
  return [
    `Switched: from the user's next message Dool2 runs on ${name(input.want)}${input.before ? ` (it was ${name(input.before)})` : ''}.`,
    'This answer still comes from the AI writing it now.',
    `${name(input.want)} starts a fresh session: the chat on screen stays, and the recent messages are carried over to it.`,
    'Tasks already running finish on the AI they started on.',
  ].join(' ')
}

function agentLine(a: AgentStatus): string {
  const name = agentLabel(a.id, 'en')
  if (!a.installed) return `- ${name}: not installed`
  if (!a.loggedIn) return `- ${name}: installed, ${a.id === 'opencode' ? 'no API key' : 'signed out'}`
  return `- ${name}: ready${a.plan && a.id !== 'opencode' ? ` (${a.plan} plan)` : ''}`
}

export function aiAccountText(input: AiAccountInput, lang: Lang = 'ko'): string {
  const m = aiAccountCopy(lang)
  const now = effectiveAgent(input.defaultAgent, input.agents)
  const lines: string[] = [
    `Dool2 runs on: ${now ? agentLabel(now, 'en') : 'no AI connected yet'}`,
    ...input.agents.map(agentLine),
  ]
  const p = input.payg
  if (p) {
    const prov = input.providers.find((x) => x.id === p.provider)
    const model = prov?.models.find((x) => x.id === p.model)
    lines.push(
      `Pay-as-you-go: ${prov?.label ?? p.provider}, model ${model?.label ?? p.model}, ${
        p.hasKey ? `API key saved (ends in ${p.keyHint ?? '????'})` : 'no API key saved'
      }`,
    )
  } else lines.push('Pay-as-you-go: not set up')
  lines.push(
    '',
    `Next: the API key never goes through chat, and no tool can take or change it: never ask for it. To add, change or remove the key (or switch the company or model), the person opens "${m.settingsPath}" and presses "${m.changeButton}" next to the API key; tell them that path in one sentence. To switch to another connected AI (Claude Code, Codex or the API key), use ai_use; the person can also pick it there or in the phone settings. If they already pasted a key in chat, say to enter it there instead, and to be safe make a new key at the AI company.`,
  )
  return lines.join('\n')
}
