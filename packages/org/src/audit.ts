// Audit log: a typed, append-only record of the actions Dool2 takes for a member — tool runs, gate decisions,
// approvals (carrying the signed envelope hash, never the signature or any secret), logins and payments. The shape
// holds only the public facts of an action; secrets never belong here. `exportAudit` turns a list of events into a
// string an admin can export (JSONL or CSV), running every free-text value through a redactor as defence in depth so
// a secret that slipped into a summary never leaves the machine (master plan workstream H).

import type { ActionTier, AutonomyLevel, GateDecision } from '@dool2/core'
import { maskSecretsInText } from '@dool2/vault'

/** The kinds of events the audit log records. */
export type AuditEventType = 'tool_run' | 'gate_decision' | 'approval' | 'login' | 'payment'

/**
 * One audit record. Append-only: events are only ever added, never edited, and `exportAudit` preserves their order.
 * No field holds a secret — `envelopeHash` is a sha256 of the signed action envelope (from `@dool2/approvals`), not
 * the signature; `detail` is for small public facts (a tool name, a site host, an amount), run through the redactor
 * on export regardless.
 */
export interface AuditEvent {
  /** Unix ms when the event happened. */
  at: number
  type: AuditEventType
  /** The member the action belongs to. */
  memberId: string
  /** The org the member is in. */
  orgId: string
  /** Short machine summary for the admin, e.g. the tool name or the gate reason. Redacted on export. */
  summary: string
  /** The autonomy level in effect, when relevant. */
  level?: AutonomyLevel
  /** The action tier, when relevant. */
  tier?: ActionTier
  /** The gate decision, when relevant. */
  decision?: GateDecision
  /** sha256 of the signed `ActionEnvelope` for approvals/payments. Not a secret; binds the record to the action. */
  envelopeHash?: string
  /** Extra public facts. String values are redacted on export; numbers and booleans pass through. */
  detail?: Record<string, string | number | boolean>
}

/** A redactor turns one string into a safe string. The default is `@dool2/vault`'s `maskSecretsInText`. */
export type Redactor = (text: string) => string

/** Export options: the serialization format and an optional redactor (defaults to `maskSecretsInText`). */
export interface ExportOptions {
  format: 'jsonl' | 'csv'
  /** Override the redactor. Omit to use `maskSecretsInText`. Pass the identity function to disable redaction. */
  redactor?: Redactor
}

/** Append an event to an audit list, returning a new array. The log is append-only; this never mutates the input. */
export function appendAudit(events: readonly AuditEvent[], event: AuditEvent): AuditEvent[] {
  return [...events, event]
}

/** Apply the redactor to the string-valued fields of an event, leaving identifiers, numbers and booleans alone. */
function redactEvent(event: AuditEvent, redact: Redactor): AuditEvent {
  const out: AuditEvent = { ...event, summary: redact(event.summary) }
  if (event.detail) {
    const detail: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(event.detail)) {
      detail[key] = typeof value === 'string' ? redact(value) : value
    }
    out.detail = detail
  }
  return out
}

/** The CSV columns, in order. `detail` is JSON-encoded in its own cell. */
const CSV_COLUMNS = [
  'at',
  'type',
  'memberId',
  'orgId',
  'level',
  'tier',
  'decision',
  'envelopeHash',
  'summary',
  'detail',
] as const

/** Quote a CSV cell when it contains a comma, quote or newline, doubling any internal quotes (RFC 4180). */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

/** Render one event as a CSV row. */
function toCsvRow(event: AuditEvent): string {
  const cells: string[] = CSV_COLUMNS.map((col) => {
    if (col === 'detail') return event.detail ? JSON.stringify(event.detail) : ''
    const value = (event as unknown as Record<string, unknown>)[col]
    return value === undefined ? '' : String(value)
  })
  return cells.map(csvCell).join(',')
}

/**
 * Export audit events to a string an admin can save. Pure: it reads the events and returns text, touching no I/O.
 *
 * - `jsonl`: one redacted event per line as JSON. Round-trips via `parseAuditJsonl`.
 * - `csv`: a header row plus one redacted row per event (RFC 4180 quoting), `detail` JSON-encoded in its own cell.
 *
 * Every string value is passed through the redactor (default `maskSecretsInText`) first, so a secret that leaked into
 * a summary or detail is masked in the output.
 */
export function exportAudit(events: readonly AuditEvent[], options: ExportOptions): string {
  const redact = options.redactor ?? maskSecretsInText
  const redacted = events.map((event) => redactEvent(event, redact))
  if (options.format === 'jsonl') {
    return redacted.map((event) => JSON.stringify(event)).join('\n')
  }
  const header = CSV_COLUMNS.join(',')
  const rows = redacted.map(toCsvRow)
  return [header, ...rows].join('\n')
}

/** Parse JSONL produced by `exportAudit` back into events. The inverse of the `jsonl` format. */
export function parseAuditJsonl(text: string): AuditEvent[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AuditEvent)
}
