// Korean-aware redaction patterns (ADR 0029 keeps this Korean data under region/kr). Used by maskSecretsInText so
// snapshots and logs never leak Korean identifiers or Korean-labelled secrets. Each rule replaces the match with a
// neutral tag. Patterns are deliberately conservative about separators, since Korean forms vary by site.

export interface RedactionRule {
  pattern: RegExp
  replace: string
}

export const KR_REDACTION_RULES: readonly RedactionRule[] = [
  // 주민등록번호 (resident registration number): 6 digits, then 7 digits, with an optional dash/space.
  { pattern: /\b\d{6}[-\s]?\d{7}\b/gu, replace: '[redacted:rrn]' },
  // Korean bank account number: 2-6 / 2-6 / 2-8 digit groups separated by dashes (e.g. 110-123-456789).
  { pattern: /\b\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,6})?\b/gu, replace: '[redacted:account]' },
  // 비밀번호 / 암호 (password) label followed by its value.
  { pattern: /(비밀번호|암호)\s*[:=]?\s*\S+/gu, replace: '$1 [redacted]' },
  // 인증번호 / 일회용 비밀번호 (verification / one-time code) label followed by digits.
  { pattern: /(인증번호|일회용\s*비밀번호|OTP)\s*[:=]?\s*\d{4,8}\b/giu, replace: '$1 [redacted:otp]' },
]
