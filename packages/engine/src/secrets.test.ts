import type { HostBridges, VaultItemSummary } from '@dool2/sandbox'
import { makeFakeBridges } from '@dool2/sandbox'
import { toAgentSummary, type VaultItem } from '@dool2/vault'
import { describe, expect, it } from 'vitest'
import { runTurn } from './engine.js'
import { scriptedBrain } from './scripted-brain.js'

const SECRET_PASSWORD = 'hunter2-super-secret'
const SECRET_TOTP_SEED = 'JBSWY3DPEHPK3PXP'

// A vault bridge that holds real secrets but only ever hands out masked summaries, exactly as the real vault does:
// listItems projects each VaultItem through toAgentSummary, so the secret payload cannot cross into the sandbox.
function makeVaultBridges(): HostBridges {
  const items: VaultItem[] = [
    {
      id: 'vlt_1',
      kind: 'login',
      site: 'naver.com',
      username: 'minji@example.com',
      secret: { password: SECRET_PASSWORD, totpSecret: SECRET_TOTP_SEED },
    },
  ]
  const base = makeFakeBridges()
  return {
    ...base,
    vault: {
      async listItems(): Promise<VaultItemSummary[]> {
        return items.map((item) => {
          const s = toAgentSummary(item)
          const summary: VaultItemSummary = {
            id: s.id,
            site: s.site ?? '',
            username: s.username ?? '',
            hasTotp: s.hasTotp,
          }
          return summary
        })
      },
      async fillLogin() {},
      async fillTotp() {},
    },
  }
}

describe('secrets never reach the brain or the transcript', () => {
  it('vault.listItems through the engine yields only masked summaries', async () => {
    const bridges = makeVaultBridges()
    const rounds = [
      [
        {
          kind: 'tool_call' as const,
          call: { id: 'c1', name: 'code' as const, args: { code: 'vault.listItems()' } },
        },
        { kind: 'turn_end' as const, stop: 'tool' as const },
      ],
      [{ kind: 'turn_end' as const, stop: 'done' as const }],
    ]
    const result = await runTurn(
      { brain: scriptedBrain(rounds), bridges },
      { message: 'what logins do I have?' },
    )

    const toolResult = result.transcript.find((t) => t.kind === 'tool_result')
    const content = toolResult?.kind === 'tool_result' ? toolResult.result.content : ''

    // the useful, non-secret fields are there
    expect(content).toContain('naver.com')
    expect(content).toContain('minji@example.com')
    expect(content).toContain('"hasTotp":true')

    // no secret anywhere in the whole transcript
    const whole = JSON.stringify(result)
    expect(whole).not.toContain(SECRET_PASSWORD)
    expect(whole).not.toContain(SECRET_TOTP_SEED)
  })
})
