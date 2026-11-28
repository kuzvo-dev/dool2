import { describe, expect, it } from 'vitest'
import { canFillTotp, fillLogin, fillTotp, type PageFiller } from './fill.js'
import { computeTotp } from './totp.js'
import type { LoginItem, TotpItem } from './types.js'

function recordingFiller(): { filler: PageFiller; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = []
  return {
    calls,
    filler: {
      fillField: async (selector, value) => {
        calls.push([selector, value])
      },
    },
  }
}

const login: LoginItem = {
  id: 'vlt_login',
  kind: 'login',
  site: 'example.com',
  username: 'hong',
  secret: { password: 'pw-123', totpSecret: 'JBSWY3DPEHPK3PXP' },
}

describe('fillLogin / fillTotp — the vault types the value, nothing flows back', () => {
  it('fills username then password into the page, returning void', async () => {
    const { filler, calls } = recordingFiller()
    const result = await fillLogin(login, filler, { usernameSelector: '#id', passwordSelector: '#pw' })
    expect(result).toBeUndefined()
    expect(calls).toEqual([
      ['#id', 'hong'],
      ['#pw', 'pw-123'],
    ])
  })

  it('computes the TOTP and types it; the typed value matches computeTotp', async () => {
    const { filler, calls } = recordingFiller()
    const at = 1111111111000
    await fillTotp(login, filler, '#otp', at)
    expect(calls).toEqual([['#otp', computeTotp('JBSWY3DPEHPK3PXP', at)]])
  })

  it('canFillTotp narrows login-with-seed and standalone totp', () => {
    const totp: TotpItem = { id: 'vlt_t', kind: 'totp', secret: { totpSecret: 'JBSWY3DPEHPK3PXP' } }
    expect(canFillTotp(totp)).toBe(true)
    expect(canFillTotp(login)).toBe(true)
    expect(canFillTotp({ id: 'x', kind: 'login', secret: { password: 'p' } })).toBe(false)
  })

  it('throws if asked to fill a TOTP with no seed', async () => {
    const { filler } = recordingFiller()
    const noSeed: LoginItem = { id: 'x', kind: 'login', secret: { password: 'p' } }
    await expect(fillTotp(noSeed, filler, '#otp', 0)).rejects.toThrow(/TOTP/u)
  })
})
