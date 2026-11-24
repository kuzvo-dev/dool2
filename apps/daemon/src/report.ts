// Report a problem (desktop app settings): the line the user wrote + (if chosen) the last two days of logs go to the Doori team.
// The log holds only 'what succeeded or failed': just the fixed fields are kept, with conversation content, file names, addresses and reason text left out.
// Before sending, the user checks exactly what goes with 'View what will be sent' (/api/report/preview). Receiver: dool2.com/api/report
import { homedir, release } from 'node:os'
import type { Lang } from '@dool2/i18n'
import type { AgentStatus } from '@dool2/protocol'
import type { JournalEntry } from './journal.js'
import { scrubText } from './journal.js'
import { REPORT_TEXT } from './locales/report.js'

export const REPORT_URL = 'https://dool2.com/api/report'

/** Fields kept from the log (only when the value is a short number, boolean or name) */
const KEEP = new Set([
  'at',
  'kind',
  'where',
  'ms',
  'startMs',
  'firstMs',
  'tools',
  'tool',
  'ok',
  'answered',
  'result',
  'cycles',
  'state',
  'id',
  'status',
  'code',
  'count',
  'checked',
  'phone',
  'step',
  'service',
  'agent',
  'connected',
  'version',
  'reason',
])

/** Keep error text but hide personal info and the home folder path */
function cleanError(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  return scrubText(v.split(homedir()).join('~'), 200)
}

/** One log line in the shape to send (the fixed fields + error only) */
export function reportEntry(e: JournalEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) {
    if (!KEEP.has(k)) continue
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string' && v.length <= 80 && !v.includes('/') && !v.includes('\\')) out[k] = v
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length <= 40))
      out[k] = v.slice(0, 30)
  }
  const err = cleanError(e.error)
  if (err) out.error = err
  return out
}

export interface ReportInput {
  /** Description the user wrote */
  text: string
  /** Email for the reply (optional) */
  contact?: string
  /** Whether to send the recent log too */
  includeLogs: boolean
}

export interface ReportPayload {
  text: string
  contact?: string
  app: { version: string; platform: string; arch: string; os: string }
  agents: { id: string; installed: boolean; loggedIn: boolean; problem?: string }[]
  extension: { connected: boolean; version?: string }
  logs: Record<string, unknown>[]
}

export function buildReport(
  input: ReportInput,
  ctx: {
    version: string
    agents: AgentStatus[]
    extension: { connected?: boolean; version?: string }
    entries: JournalEntry[]
  },
): ReportPayload {
  const contact = input.contact?.trim()
  return {
    text: input.text.trim().slice(0, 2000),
    ...(contact && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? { contact: contact.slice(0, 200) } : {}),
    app: { version: ctx.version, platform: process.platform, arch: process.arch, os: release() },
    agents: ctx.agents.map((a) => ({
      id: a.id,
      installed: a.installed,
      loggedIn: a.loggedIn,
      ...(a.problem ? { problem: scrubText(a.problem, 160) } : {}),
    })),
    extension: {
      connected: Boolean(ctx.extension.connected),
      ...(ctx.extension.version ? { version: ctx.extension.version } : {}),
    },
    // Newest 400 lines at most (size limit for sending)
    logs: input.includeLogs ? ctx.entries.slice(-400).map(reportEntry) : [],
  }
}

/** Sends to the Doori team. Returns the number received */
export async function sendReport(
  payload: ReportPayload,
  f: typeof fetch = fetch,
  url = process.env.DOOL2_REPORT_URL ?? REPORT_URL,
  lang: Lang = 'ko',
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const r = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; id?: string }
    if (!r.ok || !j.ok) return { ok: false, error: REPORT_TEXT[lang].failedStatus(r.status) }
    return { ok: true, ...(j.id ? { id: j.id } : {}) }
  } catch (e) {
    return { ok: false, error: REPORT_TEXT[lang].failed((e as Error).message) }
  }
}
