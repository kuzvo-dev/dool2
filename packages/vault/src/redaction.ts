// maskSecretsInText strips secret-looking values out of free text so snapshots, activity logs and anything the AI
// might see never carry a password, card number, one-time code or Korean identifier (threat T15). It is a
// defence-in-depth net, not the primary boundary (that is the typed model + the fill path); it runs over text that
// was not meant to hold a secret but might. Korean patterns live in region/kr/redaction.ts.

import { KR_REDACTION_RULES, type RedactionRule } from './region/kr/redaction.js'

/** Luhn check for candidate card numbers. */
function passesLuhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** Replace 13-19 digit runs (with spaces or dashes between groups) that pass Luhn with a tag. */
function maskCardNumbers(text: string): string {
  return text.replace(/\d(?:[ -]?\d){12,18}/gu, (match) => {
    const digits = match.replace(/[ -]/gu, '')
    return passesLuhn(digits) ? '[redacted:card]' : match
  })
}

/** English-labelled secrets. Korean-labelled ones are in KR_REDACTION_RULES. */
const GENERAL_RULES: readonly RedactionRule[] = [
  // password / passwd / pw / pass = value
  { pattern: /\b(password|passwd|pwd|pw|pass)\b\s*[:=]?\s*\S+/giu, replace: '$1 [redacted]' },
  // otp / totp / one-time code / passcode / verification code: digits
  {
    pattern: /\b(otp|totp|one[-\s]?time(?:\s*code)?|passcode|verification\s*code)\b\s*[:=]?\s*\d{4,8}\b/giu,
    replace: '$1 [redacted:otp]',
  },
]

/**
 * Remove secret-looking values from text: Korean identifiers (resident registration numbers, account numbers) and
 * Korean-labelled secrets first, then card numbers validated by Luhn, then one-time codes and passwords by label.
 * Non-destructive to ordinary text — it only tags things that look like secrets.
 */
export function maskSecretsInText(text: string): string {
  let out = text
  // Korean identifiers and labels first (RRN before card, so a 13-digit RRN is not mistaken for a card).
  for (const rule of KR_REDACTION_RULES) out = out.replace(rule.pattern, rule.replace)
  // Card numbers (Luhn-validated).
  out = maskCardNumbers(out)
  // English-labelled OTP and passwords.
  for (const rule of GENERAL_RULES) out = out.replace(rule.pattern, rule.replace)
  return out
}
