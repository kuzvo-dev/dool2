// The vault bridge honors the LIVE account/per-item access policy and the LIVE lock state (ADR 0023/0047), not a
// constant default. These tests drive makeVaultBridge over an InMemoryVault directly, with a fake page (no real
// browser, no real account) and a fake clock, so unlock expiry can be stepped. The payment-PIN guard reads the live
// autonomy level at call time. Throughout, the secret (password / TOTP seed / PIN) must never appear in a recorded
// fill or the audit log.

import type { AutonomyLevel } from '@dool2/core'
import type { PageBridge, PageSnapshot } from '@dool2/sandbox'
import type { VaultItem } from '@dool2/vault'
import { describe, expect, it } from 'vitest'
import { InMemoryVault, makeVaultBridge } from './vault.js'

const PASSWORD = 'pw-LIVE-SECRET-99'
const TOTP_SEED = 'JBSWY3DPEHPK3PXP'
const PIN = '481902'

/** A shop login bound to shop.example.com, with a TOTP seed. Override id/accessPolicy per test. */
function loginItem(overrides: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 'vlt_shop',
    kind: 'login',
    site: 'shop.example.com',
    username: 'minji',
    secret: { password: PASSWORD, totpSecret: TOTP_SEED },
    ...overrides,
  } as VaultItem
}

/** A payment PIN bound to shop.example.com. */
function pinItem(): VaultItem {
  return {
    id: 'vlt_pin',
    kind: 'payment-pin',
    site: 'shop.example.com',
    label: '결제 PIN',
    secret: { pin: PIN },
  }
}

/** A page that records every fill/type as [ref, value]. Carries login, one-time-code and payment-PIN fields. */
function recordingPage(
  url = 'https://shop.example.com/login',
): PageBridge & { fills: Array<[string, string]> } {
  const fills: Array<[string, string]> = []
  const nodes: PageSnapshot['nodes'] = [
    { ref: 'u', role: 'textbox', name: 'Email' },
    { ref: 'p', role: 'textbox', name: 'Password' },
    { ref: 'otp', role: 'textbox', name: 'One-time code' },
    { ref: 'pin', role: 'textbox', name: 'Payment PIN' },
  ]
  return {
    fills,
    async snapshot() {
      return { url, title: 'login', nodes }
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

describe('vault bridge honors the live lock state and access policy', () => {
  it('a while-unlocked item refuses when locked, fills when unlocked, and re-locks on expiry', async () => {
    let now = 1000
    const vault = new InMemoryVault([loginItem({ accessPolicy: 'while-unlocked' })], { now: () => now })
    const page = recordingPage()
    const bridge = makeVaultBridge(vault, { page, level: () => 'ask' })

    // Default LOCKED -> refuses.
    await expect(bridge.fillLogin('vlt_shop')).rejects.toThrow(/access policy/)
    expect(page.fills).toHaveLength(0)

    // Unlock for 60s -> fills.
    vault.unlock({ ttlMs: 60_000 })
    await bridge.fillLogin('vlt_shop')
    expect(page.fills).toEqual([
      ['u', 'minji'],
      ['p', PASSWORD],
    ])

    // Advance the clock past expiry -> re-locked on its own -> refuses again, no further fill.
    now += 60_001
    await expect(bridge.fillLogin('vlt_shop')).rejects.toThrow(/access policy/)
    expect(page.fills).toHaveLength(2)

    // The audit log kept exactly the one fill, masked, at the unlocked time; no secret in it.
    expect(vault.auditLog()).toEqual([
      { actor: 'agent', id: 'vlt_shop', kind: 'login', masked: 'shop.example.com', at: 1000 },
    ])
    expect(JSON.stringify(vault.auditLog())).not.toContain(PASSWORD)
  })

  it('an always item fills even while locked (still URL-bound, http-only); a never item always refuses', async () => {
    const vault = new InMemoryVault([
      loginItem({ id: 'vlt_always', accessPolicy: 'always' }),
      loginItem({ id: 'vlt_never', accessPolicy: 'never' }),
    ])
    // The vault is never unlocked in this test.
    const page = recordingPage()
    const bridge = makeVaultBridge(vault, { page, level: () => 'ask' })

    // `always` fills despite the lock.
    await bridge.fillLogin('vlt_always')
    expect(page.fills).toEqual([
      ['u', 'minji'],
      ['p', PASSWORD],
    ])

    // `never` refuses even after an unlock.
    vault.unlock()
    await expect(bridge.fillLogin('vlt_never')).rejects.toThrow(/access policy/)

    // `always` is still bound to the site: a wrong host refuses.
    const offsite = makeVaultBridge(vault, {
      page: recordingPage('https://evil.example.com/login'),
      level: () => 'ask',
    })
    await expect(offsite.fillLogin('vlt_always')).rejects.toThrow(/not bound/)

    // `always` is still http(s)-only: a non-http tab refuses.
    const insecure = makeVaultBridge(vault, {
      page: recordingPage('file:///tmp/phish.html'),
      level: () => 'ask',
    })
    await expect(insecure.fillLogin('vlt_always')).rejects.toThrow(/not bound|http/)
  })

  it('a per-item override beats the account default, both ways', async () => {
    // Account default `always`, one item pinned to `never`.
    const vaultA = new InMemoryVault(
      [loginItem({ id: 'vlt_a' }), loginItem({ id: 'vlt_b', accessPolicy: 'never' })],
      { accountPolicy: 'always' },
    )
    const pageA = recordingPage()
    const bridgeA = makeVaultBridge(vaultA, { page: pageA, level: () => 'ask' })

    await bridgeA.fillLogin('vlt_a') // inherits account default `always` -> fills (locked)
    expect(pageA.fills).toHaveLength(2)
    await expect(bridgeA.fillLogin('vlt_b')).rejects.toThrow(/access policy/) // override `never` wins

    // The reverse: account default `never`, item pinned to `always`.
    const vaultB = new InMemoryVault([loginItem({ id: 'vlt_c', accessPolicy: 'always' })], {
      accountPolicy: 'never',
    })
    const pageB = recordingPage()
    const bridgeB = makeVaultBridge(vaultB, { page: pageB, level: () => 'ask' })
    await bridgeB.fillLogin('vlt_c') // override `always` wins over account `never`
    expect(pageB.fills).toHaveLength(2)
  })

  it('setAccountPolicy and setItemPolicy move the live decision', async () => {
    const vault = new InMemoryVault([loginItem({ id: 'vlt_x' })], { accountPolicy: 'never' })
    const page = recordingPage()
    const bridge = makeVaultBridge(vault, { page, level: () => 'ask' })

    await expect(bridge.fillLogin('vlt_x')).rejects.toThrow(/access policy/) // account `never`
    vault.setAccountPolicy('always')
    await bridge.fillLogin('vlt_x') // now fills
    expect(page.fills).toHaveLength(2)
    vault.setItemPolicy('vlt_x', 'never')
    await expect(bridge.fillLogin('vlt_x')).rejects.toThrow(/access policy/) // per-item override refuses again
  })

  it('payment PIN is available only when the live level getter returns full at call time', async () => {
    let level: AutonomyLevel = 'auto'
    const vault = new InMemoryVault([pinItem()])
    const page = recordingPage()
    const bridge = makeVaultBridge(vault, { page, level: () => level })

    // Not full -> refuses.
    await expect(bridge.fillPaymentPin('vlt_pin')).rejects.toThrow(/full-auto|완전 자동/u)
    expect(page.fills).toHaveLength(0)

    // Flip the live level to full on the SAME bridge/getter -> now fills.
    level = 'full'
    await bridge.fillPaymentPin('vlt_pin')
    expect(page.fills).toEqual([['pin', PIN]])

    // Flip back -> refuses again (the getter is read at call time, not snapshotted).
    level = 'auto'
    await expect(bridge.fillPaymentPin('vlt_pin')).rejects.toThrow(/full-auto|완전 자동/u)
    expect(page.fills).toHaveLength(1)
  })

  it('the password, TOTP seed and PIN never appear in the fills or the audit log', async () => {
    let now = 500
    const vault = new InMemoryVault([loginItem({ accessPolicy: 'always' }), pinItem()], { now: () => now })
    const page = recordingPage()
    const bridge = makeVaultBridge(vault, { page, level: () => 'full' })

    await bridge.fillLogin('vlt_shop')
    now = 600
    await bridge.fillTotp('vlt_shop')
    now = 700
    await bridge.fillPaymentPin('vlt_pin')

    expect(vault.auditLog()).toEqual([
      { actor: 'agent', id: 'vlt_shop', kind: 'login', masked: 'shop.example.com', at: 500 },
      { actor: 'agent', id: 'vlt_shop', kind: 'totp', masked: 'shop.example.com', at: 600 },
      { actor: 'agent', id: 'vlt_pin', kind: 'payment-pin', masked: '결제 PIN', at: 700 },
    ])
    const serialized = JSON.stringify({ audit: vault.auditLog(), fills: vault.fills })
    expect(serialized).not.toContain(PASSWORD)
    expect(serialized).not.toContain(TOTP_SEED)
    expect(serialized).not.toContain(PIN)
  })
})
