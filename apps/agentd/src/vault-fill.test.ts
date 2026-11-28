import type { Brain } from '@dool2/brains'
import type { AutonomyLevel } from '@dool2/core'
import { type HostBridges, makeFakeBridges, type PageBridge, type PageSnapshot } from '@dool2/sandbox'
import { computeTotp, type VaultItem } from '@dool2/vault'
import { describe, expect, it } from 'vitest'
import { Agentd } from './agentd.js'
import { InMemoryVault, makeVaultBridge } from './vault.js'

const PASSWORD = 'pw-ULTRA-SECRET-42'
const USERNAME = 'minji@example.com'
const TOTP_SEED = 'JBSWY3DPEHPK3PXP'
const PIN = '137924'

function vaultItems(): VaultItem[] {
  return [
    {
      id: 'vlt_login',
      kind: 'login',
      site: 'shop.example.com',
      username: USERNAME,
      secret: { password: PASSWORD, totpSecret: TOTP_SEED },
    },
    { id: 'vlt_pin', kind: 'payment-pin', site: 'shop.example.com', label: '결제 PIN', secret: { pin: PIN } },
  ]
}

/** A page that records every fill/type as [ref, value], so a test can prove the vault typed the secret into a field. */
function recordingPage(nodes: PageSnapshot['nodes']): PageBridge & { fills: Array<[string, string]> } {
  const fills: Array<[string, string]> = []
  return {
    fills,
    async snapshot() {
      return { url: 'https://shop.example.com/login', title: 'Login', nodes }
    },
    async fetch() {
      return { status: 200, headers: {}, body: '' }
    },
    async goto() {},
    async click() {},
    async type(ref: string, text: string) {
      fills.push([ref, text])
    },
    async press() {},
    async fill(ref: string, value: string) {
      fills.push([ref, value])
    },
  }
}

function bridgesWith(vault: InMemoryVault, page: PageBridge, level: () => AutonomyLevel): HostBridges {
  // The vault is locked by default (ADR 0047); unlock it so these fill tests exercise the fill itself. The live lock
  // model is covered on its own in vault-live-policy.test.ts.
  vault.unlock()
  const fake = makeFakeBridges()
  return { page, vault: makeVaultBridge(vault, { page, level }), pc: fake.pc, fs: fake.fs }
}

/** A stateless brain that runs one `code` snippet per turn, then finishes. */
function codeBrain(code: string): Brain {
  return {
    id: 'pi',
    label: 'code',
    async ready() {
      return true
    },
    async *run(input, _handle) {
      if (input.messages.some((m) => m.role === 'tool')) {
        yield { kind: 'turn_end', stop: 'done' }
        return
      }
      yield { kind: 'tool_call', call: { id: 'c1', name: 'code', args: { code } } }
      yield { kind: 'turn_end', stop: 'tool' }
    },
  }
}

const loginNodes: PageSnapshot['nodes'] = [
  { ref: 'u', role: 'textbox', name: 'Email' },
  { ref: 'p', role: 'textbox', name: 'Password' },
  { ref: 'otp', role: 'textbox', name: 'One-time code' },
]
const pinNodes: PageSnapshot['nodes'] = [{ ref: 'pin', role: 'textbox', name: 'Payment PIN' }]

describe('vault fill: the secret is typed into the page, never into the transcript', () => {
  it('fillLogin types username then password into the matched fields, and the password never surfaces', async () => {
    const vault = new InMemoryVault(vaultItems())
    const page = recordingPage(loginNodes)
    const agentd = new Agentd({
      brain: codeBrain("await vault.fillLogin('vlt_login')"),
      bridges: bridgesWith(vault, page, () => 'ask'),
      level: 'ask',
    })

    const result = await agentd.send('log me in')

    // typed into exactly the username then password fields, with the real values
    expect(page.fills).toEqual([
      ['u', USERNAME],
      ['p', PASSWORD],
    ])
    // the password appears nowhere in the whole turn result (transcript, events, gate log)
    expect(JSON.stringify(result)).not.toContain(PASSWORD)
    expect(vault.fills).toEqual([{ id: 'vlt_login', kind: 'login' }])
    // the fill ran (gate let the act through at level ask) and nothing paused
    expect(result.approvalsNeeded).toHaveLength(0)
  })

  it('fillTotp computes the code with computeTotp and types it into the one-time-code field', async () => {
    const vault = new InMemoryVault(vaultItems())
    const page = recordingPage(loginNodes)
    const agentd = new Agentd({
      brain: codeBrain("await vault.fillTotp('vlt_login')"),
      bridges: bridgesWith(vault, page, () => 'ask'),
      level: 'ask',
    })

    const before = Date.now()
    const result = await agentd.send('fill the 2FA code')
    const after = Date.now()

    expect(page.fills).toHaveLength(1)
    const [[ref, typed]] = page.fills as [[string, string]]
    expect(ref).toBe('otp')
    // the typed value is a real TOTP for this moment (either side of a possible 30s step boundary)
    const acceptable = new Set([computeTotp(TOTP_SEED, before), computeTotp(TOTP_SEED, after)])
    expect(acceptable.has(typed)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(TOTP_SEED)
  })

  it('fillPaymentPin is refused unless the level is full-auto', async () => {
    const vault = new InMemoryVault(vaultItems())
    const page = recordingPage(pinNodes)
    const agentd = new Agentd({
      brain: codeBrain("await vault.fillPaymentPin('vlt_pin')"),
      bridges: bridgesWith(vault, page, () => 'ask'),
      level: 'ask',
    })

    const result = await agentd.send('enter my payment PIN')

    // nothing was typed, and the code hand saw an error telling it the PIN needs full-auto
    expect(page.fills).toHaveLength(0)
    const toolResult = result.transcript.find((t) => t.kind === 'tool_result')
    const content = toolResult?.kind === 'tool_result' ? toolResult.result.content : ''
    expect(toolResult?.kind === 'tool_result' && toolResult.result.isError).toBe(true)
    expect(content).toMatch(/full-auto|완전 자동/u)
    expect(JSON.stringify(result)).not.toContain(PIN)
  })

  it('fillPaymentPin types the PIN into the secure keypad in full-auto, and the PIN never surfaces', async () => {
    const vault = new InMemoryVault(vaultItems())
    const page = recordingPage(pinNodes)
    const agentd = new Agentd({
      brain: codeBrain("await vault.fillPaymentPin('vlt_pin')"),
      bridges: bridgesWith(vault, page, () => 'full'),
      level: 'full',
    })

    const result = await agentd.send('enter my payment PIN')

    expect(page.fills).toEqual([['pin', PIN]])
    expect(vault.fills).toEqual([{ id: 'vlt_pin', kind: 'payment-pin' }])
    // the PIN was typed into the page but never appears in the transcript/events
    expect(JSON.stringify(result)).not.toContain(PIN)
  })
})
