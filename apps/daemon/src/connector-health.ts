// Service tool health record (ADR 0020): records the result of every run and rests tools that keep breaking.
// So the same user does not keep meeting a tool broken by a site change. While it rests, Doori finishes the job with the general browser.
// The record stays on this PC only.
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

/** ok worked · broke blocked (loud failure) · empty fields came back blank (silent failure) · stopped normal stop (sold out, login needed, etc.) */
export type Outcome = 'ok' | 'broke' | 'empty' | 'stopped' | 'blocked'

interface Rec {
  at: number
  outcome: Outcome
  detail?: string
  /** Tool definition fingerprint: when the definition changes (a fixed tool arrives), old failures are not counted */
  v?: string
}

/** Rest after this many failures in a row */
export const REST_AFTER = 3
/** Count failures only within this window */
export const REST_WINDOW_MS = 24 * 3600_000
/** Rest time (afterwards it is tried once again on the next request) */
export const REST_MS = 6 * 3600_000

const bad = (o: Outcome) => o === 'broke' || o === 'empty'

export class ConnectorHealth {
  private data: Record<string, Rec[]> = {}
  private saving?: Promise<void>

  constructor(
    private readonly file?: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (raw && typeof raw === 'object') this.data = raw as Record<string, Rec[]>
    } catch {}
  }

  record(tool: string, outcome: Outcome, detail?: string, v?: string) {
    const list = this.data[tool] ?? []
    this.data[tool] = list
    list.push({
      at: this.now(),
      outcome,
      ...(detail ? { detail: detail.slice(0, 200) } : {}),
      ...(v ? { v } : {}),
    })
    if (list.length > 20) list.splice(0, list.length - 20)
    this.save()
  }

  /** If resting: until when and why. Given v (fingerprint of the current definition), records from other definitions are skipped */
  resting(tool: string, v?: string): { until: number; reason: string } | undefined {
    const list = (this.data[tool] ?? []).filter((r) => !v || !r.v || r.v === v)
    const last = list.slice(-REST_AFTER)
    if (last.length < REST_AFTER || !last.every((r) => bad(r.outcome))) return undefined
    const first = last[0] as Rec
    const end = last.at(-1) as Rec
    if (this.now() - first.at > REST_WINDOW_MS) return undefined
    const until = end.at + REST_MS
    if (this.now() >= until) return undefined
    return {
      until,
      reason: end.detail ?? (end.outcome === 'empty' ? 'result fields come back empty' : 'blocked'),
    }
  }

  /** Per tool: last result and failures within a day (for screens and checks) */
  summary(): Record<string, { last: Outcome; at: number; failures24h: number; resting: boolean }> {
    const out: Record<string, { last: Outcome; at: number; failures24h: number; resting: boolean }> = {}
    for (const [tool, list] of Object.entries(this.data)) {
      const end = list.at(-1)
      if (!end) continue
      out[tool] = {
        last: end.outcome,
        at: end.at,
        failures24h: list.filter((r) => bad(r.outcome) && this.now() - r.at < REST_WINDOW_MS).length,
        resting: Boolean(this.resting(tool)),
      }
    }
    return out
  }

  private save() {
    if (!this.file || this.saving) return
    const file = this.file
    // Write consecutive runs at once
    this.saving = new Promise<void>((r) => setTimeout(r, 500))
      .then(() => writeFile(file, JSON.stringify(this.data)))
      .catch(() => {})
      .finally(() => {
        this.saving = undefined
      })
  }
}
