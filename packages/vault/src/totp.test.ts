import { describe, expect, it } from 'vitest'
import { base32Decode, computeTotp } from './totp.js'

// RFC 6238 Appendix B test vectors (SHA1 seed "12345678901234567890" = 20 ASCII bytes).
// The RFC prints 8-digit codes; the common authenticator setting is 6 digits, so we take the last 6.
const SEED_ASCII = '12345678901234567890'
const SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

const VECTORS: Array<[time: number, code8: string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]

describe('computeTotp — RFC 6238', () => {
  it('base32 decodes the RFC seed to the ASCII bytes', () => {
    expect(base32Decode(SEED_BASE32).toString('ascii')).toBe(SEED_ASCII)
  })

  it('tolerates lowercase, spaces and padding', () => {
    expect(base32Decode('gezd gnbv='.toUpperCase())).toBeInstanceOf(Buffer)
    expect(base32Decode('JBSWY3DPEHPK3PXP')).toEqual(base32Decode('jbswy3dp ehpk3pxp'))
  })

  it('matches the 8-digit vectors', () => {
    for (const [time, code8] of VECTORS) {
      expect(computeTotp(SEED_BASE32, time * 1000, { digits: 8 })).toBe(code8)
    }
  })

  it('matches the 6-digit codes (last six digits of each vector)', () => {
    for (const [time, code8] of VECTORS) {
      expect(computeTotp(SEED_BASE32, time * 1000)).toBe(code8.slice(-6))
    }
  })

  it('throws on an invalid base32 character', () => {
    expect(() => computeTotp('0189!', Date.now())).toThrow()
  })
})
