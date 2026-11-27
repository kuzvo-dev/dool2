// How the PC is doing (PcHealth), for the phones: Dool2's own stalls, a busy PC, disk, the extension, the AI's limit
// and sign-in, and sleep. Sent every 30 s while a phone is around and at once when the issues change, so the phone can
// say why the PC is slow or silent instead of only "the PC is not answering" (user 11-26)

import { statfs } from 'node:fs/promises'
import { cpus, loadavg } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { PcHealth, PcHealthIssue } from '@dool2/protocol'

/** Dool2's loop answering later than this at worst in half a minute: something is stalling it */
export const SLOW_LAG_MS = 1_500
/** Load per core above this: the PC is busy with more than it can run at once */
export const BUSY_LOAD = 1.5
/** Free disk below this (GB): downloads and screenshots start failing */
export const LOW_DISK_GB = 3

export interface HealthFacts {
  lagMs: number
  load: number
  diskGb?: number
  extension: boolean
  ai?: 'limit' | 'signed-out'
  sleeping?: boolean
}

/** The issues the facts show, most urgent first */
export function healthIssues(f: HealthFacts): PcHealthIssue[] {
  const out: PcHealthIssue[] = []
  if (f.sleeping) out.push('sleeping')
  if (f.ai === 'signed-out') out.push('ai-signed-out')
  if (f.ai === 'limit') out.push('ai-limit')
  if (f.lagMs > SLOW_LAG_MS) out.push('slow')
  if (f.load > BUSY_LOAD) out.push('busy')
  if (f.diskGb !== undefined && f.diskGb < LOW_DISK_GB) out.push('low-disk')
  if (!f.extension) out.push('no-extension')
  return out
}

export interface HealthMonitorOptions {
  dataDir: string
  extension: () => boolean
  agents: () => number
  /** Sends one snapshot to the phones */
  send: (h: PcHealth, changed: boolean) => void
  everyMs?: number
}

export class HealthMonitor {
  private lag: ReturnType<typeof monitorEventLoopDelay> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private ai: { state: 'limit' | 'signed-out'; resetsAt?: string } | undefined
  private sleeping = false
  private lastIssues = ''

  constructor(private readonly opts: HealthMonitorOptions) {}

  start() {
    this.lag = monitorEventLoopDelay({ resolution: 50 })
    this.lag.enable()
    this.timer = setInterval(() => void this.tick(), this.opts.everyMs ?? 30_000)
    this.timer.unref?.()
  }

  stop() {
    clearInterval(this.timer)
    this.lag?.disable()
  }

  /** A turn ended: a usage limit or sign-out shows until a turn answers again */
  turnEnded(code: string | undefined, resetsAt?: string) {
    const was = JSON.stringify(this.ai)
    if (code === 'limit_reached' || code === 'rate_limited')
      this.ai = { state: 'limit', ...(resetsAt ? { resetsAt } : {}) }
    else if (code === 'not_logged_in') this.ai = { state: 'signed-out' }
    else if (!code) this.ai = undefined
    if (JSON.stringify(this.ai) !== was) void this.tick()
  }

  /** The PC is going to sleep or woke up (Electron powerMonitor). Sent at once: it may be the last word before sleep */
  setSleeping(on: boolean) {
    if (this.sleeping === on) return
    this.sleeping = on
    void this.tick()
  }

  async snapshot(): Promise<PcHealth> {
    // max, not a percentile: one long stall is what makes the phone wait
    const lagMs = this.lag ? Math.round(this.lag.max / 1e6) : 0
    this.lag?.reset()
    const load = Math.round(((loadavg()[0] ?? 0) / Math.max(1, cpus().length)) * 100) / 100
    let diskGb: number | undefined
    try {
      const s = await statfs(this.opts.dataDir)
      diskGb = Math.round(((s.bavail * s.bsize) / 1e9) * 10) / 10
    } catch {}
    const issues = healthIssues({
      lagMs,
      load,
      ...(diskGb !== undefined ? { diskGb } : {}),
      extension: this.opts.extension(),
      ...(this.ai ? { ai: this.ai.state } : {}),
      sleeping: this.sleeping,
    })
    return {
      at: Date.now(),
      issues,
      lagMs,
      load,
      ...(diskGb !== undefined ? { diskGb } : {}),
      agents: this.opts.agents(),
      ...(this.ai?.resetsAt ? { limitResetsAt: this.ai.resetsAt } : {}),
    }
  }

  private async tick() {
    const h = await this.snapshot()
    const key = h.issues.join(',')
    const changed = key !== this.lastIssues
    this.lastIssues = key
    this.opts.send(h, changed)
  }
}
