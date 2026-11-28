// RFC 6238 TOTP, computed by the vault so the AI never touches the seed. The vault derives the code and types it
// into the page (see fill.ts); the model only ever learns that a code exists (hasTotp). Defaults are the common
// authenticator settings: HMAC-SHA1, a 30-second step, 6 digits.

import { createHmac } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode an RFC 4648 base32 string (padding, spaces and case are tolerated) into bytes. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/u, '').replace(/\s+/gu, '').toUpperCase()
  const out: number[] = []
  let value = 0
  let bits = 0
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) throw new Error(`invalid base32 character: ${char}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(out)
}

/** HOTP (RFC 4226): one code for a counter value. */
function hotp(key: Buffer, counter: number, digits: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', key).update(message).digest()
  const offset = digest.readUInt8(digest.length - 1) & 0x0f
  const binary = digest.readUInt32BE(offset) & 0x7fffffff
  const code = binary % 10 ** digits
  return code.toString().padStart(digits, '0')
}

export interface TotpOptions {
  /** Seconds per step. Default 30. */
  stepSeconds?: number
  /** Number of digits. Default 6. */
  digits?: number
}

/**
 * Compute the RFC 6238 TOTP code for a base32 seed at a point in time (ms since epoch). The seed stays inside the
 * vault; only the short-lived code leaves, and only into the page the vault fills.
 */
export function computeTotp(secretBase32: string, atMs: number, options: TotpOptions = {}): string {
  const stepSeconds = options.stepSeconds ?? 30
  const digits = options.digits ?? 6
  const counter = Math.floor(atMs / 1000 / stepSeconds)
  return hotp(base32Decode(secretBase32), counter, digits)
}
