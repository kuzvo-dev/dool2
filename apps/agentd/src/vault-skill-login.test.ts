// The vault bridge binds a login to the tab URL + a site skill's field hints + the access policy, and fills the right
// fields WITHOUT the AI ever seeing the secret. These tests use a fake page (no real browser) and the built-in skill
// pack (@dool2/skills), whose naver/gov24 skills carry Korean login hints (아이디/비밀번호/로그인/인증번호).

import type { Brain } from '@dool2/brains'
import type { AutonomyLevel } from '@dool2/core'
import { type HostBridges, makeFakeBridges, type PageBridge, type PageSnapshot } from '@dool2/sandbox'
import type { SkillMeta } from '@dool2/skill-sdk'
import { loadBuiltinSkillMetas } from '@dool2/skills'
import { computeTotp, type VaultItem } from '@dool2/vault'
import { describe, expect, it } from 'vitest'
import { Agentd } from './agentd.js'
import { InMemoryVault, makeVaultBridge, type VaultBridgeDeps } from './vault.js'

const PASSWORD = 'pw-NAVER-SECRET-77'
const USERNAME = 'minji'
const TOTP_SEED = 'JBSWY3DPEHPK3PXP'

const BUILTIN: readonly SkillMeta[] = loadBuiltinSkillMetas()

/** A naver login item bound to naver.com (login lives on nid.naver.com). */
function naverItem(overrides: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 'vlt_naver',
    kind: 'login',
    site: 'naver.com',
    username: USERNAME,
    secret: { password: PASSWORD, totpSecret: TOTP_SEED },
    ...overrides,
  } as VaultItem
}

/** The nid.naver.com login page as a snapshot: Korean-named fields that only a skill hint (not the English heuristic) can see. */
const naverNodes: PageSnapshot['nodes'] = [
  { ref: 'u', role: 'textbox', name: '아이디' },
  { ref: 'p', role: 'textbox', name: '비밀번호' },
  { ref: 'otp', role: 'textbox', name: '인증번호' },
  { ref: 'go', role: 'button', name: '로그인' },
]

/** A page that records every fill/type and click, so a test can prove which fields got the secret and that submit ran. */
function recordingPage(
  url: string,
  nodes: PageSnapshot['nodes'],
): PageBridge & { fills: Array<[string, string]>; clicks: string[] } {
  const fills: Array<[string, string]> = []
  const clicks: string[] = []
  return {
    fills,
    clicks,
    async snapshot() {
      return { url, title: 'login', nodes }
    },
    async fetch() {
      return { status: 200, headers: {}, body: '' }
    },
    async goto() {},
    async click(ref: string) {
      clicks.push(ref)
    },
    async type(ref: string, text: string) {
      fills.push([ref, text])
    },
    async press() {},
    async fill(ref: string, value: string) {
      fills.push([ref, value])
    },
  }
}

function deps(page: PageBridge, extra: Partial<VaultBridgeDeps> = {}): VaultBridgeDeps {
  return { page, level: () => 'ask', skills: () => BUILTIN, ...extra }
}

function bridgesWith(vault: InMemoryVault, page: PageBridge): HostBridges {
  const fake = makeFakeBridges()
  return { page, vault: makeVaultBridge(vault, deps(page)), pc: fake.pc, fs: fake.fs }
}

function codeBrain(code: string): Brain {
  return {
    id: 'pi',
    label: 'code',
    async ready() {
      return true
    },
    async *run(input) {
      if (input.messages.some((m) => m.role === 'tool')) {
        yield { kind: 'turn_end', stop: 'done' }
        return
      }
      yield { kind: 'tool_call', call: { id: 'c1', name: 'code', args: { code } } }
      yield { kind: 'turn_end', stop: 'tool' }
    },
  }
}

describe('vault bridge binds URL + skill hints + policy to a login fill', () => {
  it('fills the Korean id/password fields from the naver skill, clicks 로그인, and the password never surfaces', async () => {
    const vault = new InMemoryVault([naverItem()])
    const page = recordingPage('https://nid.naver.com/nidlogin.login', naverNodes)
    const agentd = new Agentd({
      brain: codeBrain("await vault.fillLogin('vlt_naver')"),
      bridges: bridgesWith(vault, page),
      level: 'ask',
    })

    const result = await agentd.send('네이버 로그인 해줘')

    // username into 아이디, password into 비밀번호, then the 로그인 button clicked
    expect(page.fills).toEqual([
      ['u', USERNAME],
      ['p', PASSWORD],
    ])
    expect(page.clicks).toEqual(['go'])
    expect(vault.fills).toEqual([{ id: 'vlt_naver', kind: 'login' }])
    // the password is nowhere in the whole turn result (transcript, events, gate log)
    expect(JSON.stringify(result)).not.toContain(PASSWORD)
    expect(result.approvalsNeeded).toHaveLength(0)
  })

  it('fillTotp uses the skill totp hint (인증번호) and types a real computeTotp code, never the seed', async () => {
    const vault = new InMemoryVault([naverItem()])
    const page = recordingPage('https://nid.naver.com/nidlogin.login', naverNodes)
    const bridge = makeVaultBridge(vault, deps(page))

    const before = Date.now()
    await bridge.fillTotp('vlt_naver')
    const after = Date.now()

    expect(page.fills).toHaveLength(1)
    const [[ref, typed]] = page.fills as [[string, string]]
    expect(ref).toBe('otp') // the 인증번호 field, not any English heuristic
    const acceptable = new Set([computeTotp(TOTP_SEED, before), computeTotp(TOTP_SEED, after)])
    expect(acceptable.has(typed)).toBe(true)
    expect(typed).not.toBe(TOTP_SEED)
  })

  it('refuses when the tab URL does not match the item site (URL binding)', async () => {
    const vault = new InMemoryVault([naverItem()])
    const page = recordingPage('https://evil.example.com/login', naverNodes)
    const bridge = makeVaultBridge(vault, deps(page))

    await expect(bridge.fillLogin('vlt_naver')).rejects.toThrow(/not bound/)
    expect(page.fills).toHaveLength(0)
    expect(page.clicks).toHaveLength(0)
  })

  it('refuses a non-http(s) tab URL (http-only binding)', async () => {
    const vault = new InMemoryVault([naverItem()])
    const page = recordingPage('file:///tmp/phish.html', naverNodes)
    const bridge = makeVaultBridge(vault, deps(page))

    await expect(bridge.fillLogin('vlt_naver')).rejects.toThrow(/not bound|http/)
    expect(page.fills).toHaveLength(0)
  })

  it('refuses when the item access policy is never, even on the right site while unlocked', async () => {
    const vault = new InMemoryVault([naverItem({ accessPolicy: 'never' })])
    const page = recordingPage('https://nid.naver.com/nidlogin.login', naverNodes)
    const bridge = makeVaultBridge(vault, deps(page, { unlocked: () => true }))

    await expect(bridge.fillLogin('vlt_naver')).rejects.toThrow(/access policy/)
    expect(page.fills).toHaveLength(0)
  })

  it('refuses a while-unlocked item when the vault is locked', async () => {
    const vault = new InMemoryVault([naverItem({ accessPolicy: 'while-unlocked' })])
    const page = recordingPage('https://nid.naver.com/nidlogin.login', naverNodes)
    const bridge = makeVaultBridge(vault, deps(page, { unlocked: () => false }))

    await expect(bridge.fillLogin('vlt_naver')).rejects.toThrow(/access policy/)
    expect(page.fills).toHaveLength(0)
  })

  it('fills a gov.kr login from the gov24 skill hints', async () => {
    const govItem: VaultItem = {
      id: 'vlt_gov',
      kind: 'login',
      site: 'gov.kr',
      username: 'hong',
      secret: { password: 'pw-GOV-SECRET-11' },
    }
    const vault = new InMemoryVault([govItem])
    const page = recordingPage('https://www.gov.kr/nlogin', [
      { ref: 'gid', role: 'textbox', name: '아이디' },
      { ref: 'gpw', role: 'textbox', name: '비밀번호' },
      { ref: 'gsubmit', role: 'button', name: '로그인' },
    ])
    const bridge = makeVaultBridge(vault, deps(page))

    await bridge.fillLogin('vlt_gov')

    expect(page.fills).toEqual([
      ['gid', 'hong'],
      ['gpw', 'pw-GOV-SECRET-11'],
    ])
    expect(page.clicks).toEqual(['gsubmit'])
  })
})
