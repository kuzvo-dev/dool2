// 문제 알리기 (PC 앱 설정): 사용자가 적은 한 줄 + (고르면) 최근 이틀 기록을 두리 팀에 보낸다.
// 기록은 '무슨 일이 성공·실패했는지'만: 정해 둔 칸만 남기고 대화 내용·파일 이름·주소·이유 글은 뺀다.
// 보내기 전에 사용자가 '보낼 내용 보기'로 그대로 확인한다 (/api/report/preview). 받는 곳: dool2.com/api/report
import { homedir, release } from 'node:os'
import type { AgentStatus } from '@dool2/protocol'
import type { JournalEntry } from './journal.js'
import { scrubText } from './journal.js'

export const REPORT_URL = 'https://dool2.com/api/report'

/** 기록에서 남기는 칸 (값이 짧은 숫자·참거짓·이름일 때만) */
const KEEP = new Set([
  'at',
  'kind',
  'where',
  'ms',
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

/** 오류 글은 남기되 개인 정보·홈 폴더 경로를 가린다 */
function cleanError(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  return scrubText(v.split(homedir()).join('~'), 200)
}

/** 기록 한 줄을 보낼 모양으로 (정해 둔 칸 + 오류만) */
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
  /** 사용자가 적은 설명 */
  text: string
  /** 답장 받을 메일 (선택) */
  contact?: string
  /** 최근 기록을 함께 보낼지 */
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
    // 새것부터 400줄까지 (보내는 크기 제한)
    logs: input.includeLogs ? ctx.entries.slice(-400).map(reportEntry) : [],
  }
}

/** 두리 팀에 보낸다. 받은 번호를 돌려준다 */
export async function sendReport(
  payload: ReportPayload,
  f: typeof fetch = fetch,
  url = process.env.DOOL2_REPORT_URL ?? REPORT_URL,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const r = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; id?: string }
    if (!r.ok || !j.ok) return { ok: false, error: `보내지 못했어요 (${r.status})` }
    return { ok: true, ...(j.id ? { id: j.id } : {}) }
  } catch (e) {
    return { ok: false, error: `보내지 못했어요: ${(e as Error).message}` }
  }
}
