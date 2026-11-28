import { describe, expect, it } from 'vitest'
import { type AuditEvent, appendAudit, exportAudit, parseAuditJsonl } from './audit.js'

const events: AuditEvent[] = [
  {
    at: 1_700_000_000_000,
    type: 'login',
    memberId: 'm1',
    orgId: 'org1',
    summary: 'SSO login',
  },
  {
    at: 1_700_000_001_000,
    type: 'gate_decision',
    memberId: 'm1',
    orgId: 'org1',
    summary: 'send message',
    level: 'auto',
    tier: 'contact',
    decision: 'review',
    detail: { site: 'mail.example.com', count: 3 },
  },
  {
    at: 1_700_000_002_000,
    type: 'payment',
    memberId: 'm1',
    orgId: 'org1',
    summary: 'pay 50,000 won',
    level: 'ask',
    tier: 'pay',
    decision: 'sign',
    envelopeHash: 'a'.repeat(64),
    detail: { merchant: 'store', amountKrw: 50_000 },
  },
]

describe('appendAudit', () => {
  it('appends without mutating the input (append-only)', () => {
    const start: AuditEvent[] = [events[0] as AuditEvent]
    const next = appendAudit(start, events[1] as AuditEvent)
    expect(next).toHaveLength(2)
    expect(start).toHaveLength(1)
  })
})

describe('exportAudit jsonl', () => {
  it('round-trips the events through parseAuditJsonl (no redaction needed)', () => {
    const text = exportAudit(events, { format: 'jsonl' })
    expect(text.split('\n')).toHaveLength(events.length)
    expect(parseAuditJsonl(text)).toEqual(events)
  })
})

describe('exportAudit csv', () => {
  it('writes a header plus one row per event', () => {
    const text = exportAudit(events, { format: 'csv' })
    const lines = text.split('\n')
    expect(lines).toHaveLength(events.length + 1)
    expect(lines[0]).toBe('at,type,memberId,orgId,level,tier,decision,envelopeHash,summary,detail')
  })

  it('carries the values and the envelope hash into the rows', () => {
    const text = exportAudit(events, { format: 'csv' })
    expect(text).toContain('login')
    expect(text).toContain('m1')
    expect(text).toContain('a'.repeat(64))
    // detail is JSON-encoded and CSV-quoted (it contains a comma/quotes once encoded).
    expect(text).toContain('mail.example.com')
  })

  it('quotes cells that contain commas or quotes (RFC 4180)', () => {
    const tricky: AuditEvent[] = [
      { at: 1, type: 'tool_run', memberId: 'm1', orgId: 'org1', summary: 'ran a, b and "c"' },
    ]
    const text = exportAudit(tricky, { format: 'csv' })
    expect(text).toContain('"ran a, b and ""c"""')
  })
})

describe('exportAudit redaction', () => {
  it('the default redactor masks a secret that leaked into a summary', () => {
    const leaky: AuditEvent[] = [
      { at: 1, type: 'tool_run', memberId: 'm1', orgId: 'org1', summary: 'logged in with password: hunter2' },
    ]
    const jsonl = exportAudit(leaky, { format: 'jsonl' })
    expect(jsonl).not.toContain('hunter2')
    expect(jsonl).toContain('[redacted]')
  })

  it('masks a secret in a detail string value, leaving numbers alone', () => {
    const leaky: AuditEvent[] = [
      {
        at: 1,
        type: 'tool_run',
        memberId: 'm1',
        orgId: 'org1',
        summary: 'form fill',
        detail: { note: 'otp: 123456', count: 7 },
      },
    ]
    const parsed = parseAuditJsonl(exportAudit(leaky, { format: 'jsonl' }))
    expect(parsed[0]?.detail?.note).not.toContain('123456')
    expect(parsed[0]?.detail?.count).toBe(7)
  })

  it('an injected redactor is used instead of the default', () => {
    const redactor = (text: string) => text.replace(/SECRET/gu, '[gone]')
    const leaky: AuditEvent[] = [
      { at: 1, type: 'tool_run', memberId: 'm1', orgId: 'org1', summary: 'value is SECRET here' },
    ]
    const jsonl = exportAudit(leaky, { format: 'jsonl', redactor })
    expect(jsonl).not.toContain('SECRET')
    expect(jsonl).toContain('[gone]')
  })
})
