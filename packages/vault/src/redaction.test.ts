import { describe, expect, it } from 'vitest'
import { maskSecretsInText } from './redaction.js'

describe('maskSecretsInText', () => {
  it('redacts a Luhn-valid card number (with or without separators)', () => {
    const out = maskSecretsInText('card 4111 1111 1111 1111 on file')
    expect(out).toContain('[redacted:card]')
    expect(out).not.toContain('4111')
    expect(maskSecretsInText('4111111111111111')).toBe('[redacted:card]')
  })

  it('leaves a non-Luhn digit run alone', () => {
    expect(maskSecretsInText('order 1234567812345678')).toContain('1234567812345678')
  })

  it('redacts a 주민등록번호 (RRN), dashed or not', () => {
    expect(maskSecretsInText('주민번호 900101-1234567 입니다')).toContain('[redacted:rrn]')
    expect(maskSecretsInText('9001011234567')).toBe('[redacted:rrn]')
    expect(maskSecretsInText('주민번호 900101-1234567 입니다')).not.toContain('900101')
  })

  it('redacts a Korean bank account number', () => {
    const out = maskSecretsInText('계좌 110-123-456789 로 보내')
    expect(out).toContain('[redacted:account]')
    expect(out).not.toContain('110-123-456789')
  })

  it('redacts an OTP / 인증번호 by label', () => {
    expect(maskSecretsInText('OTP 123456')).toContain('[redacted:otp]')
    expect(maskSecretsInText('verification code: 123456')).toContain('[redacted:otp]')
    expect(maskSecretsInText('인증번호 482913')).toContain('[redacted:otp]')
    expect(maskSecretsInText('인증번호 482913')).not.toContain('482913')
  })

  it('redacts a labelled password (English and Korean)', () => {
    expect(maskSecretsInText('password: hunter2')).toContain('[redacted]')
    expect(maskSecretsInText('password: hunter2')).not.toContain('hunter2')
    expect(maskSecretsInText('비밀번호 hunter2')).toContain('[redacted]')
    expect(maskSecretsInText('비밀번호 hunter2')).not.toContain('hunter2')
  })

  it('leaves ordinary text untouched', () => {
    const text = 'Meet me at 3pm near gate 7, bring the report.'
    expect(maskSecretsInText(text)).toBe(text)
  })
})
