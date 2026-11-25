// Which AI Dool2 runs on, for the AI itself (ai_account_view). Pay-as-you-go shows company, model and the key's last 4
// characters only: the key never reaches the AI, and no tool takes or changes it (the person does, in the PC settings)
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

function agentLine(a: AgentStatus): string {
  const name = agentLabel(a.id, 'en')
  if (!a.installed) return `- ${name}: not installed`
  if (!a.loggedIn) return `- ${name}: installed, ${a.id === 'opencode' ? 'no API key' : 'signed out'}`
  return `- ${name}: ready${a.plan && a.id !== 'opencode' ? ` (${a.plan} plan)` : ''}`
}

export function aiAccountText(input: AiAccountInput, lang: Lang = 'ko'): string {
  const m = aiAccountCopy(lang)
  const lines: string[] = [
    `Dool2 runs on: ${input.defaultAgent ? agentLabel(input.defaultAgent, 'en') : 'not chosen yet'}`,
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
    `Next: the API key never goes through chat, and no tool can take or change it: never ask for it. To add, change or remove the key (or switch the company or model), the person opens "${m.settingsPath}" and presses "${m.changeButton}" next to the API key; tell them that path in one sentence. The phone only shows which AI is in use. If they already pasted a key in chat, say to enter it there instead, and to be safe make a new key at the AI company.`,
  )
  return lines.join('\n')
}
