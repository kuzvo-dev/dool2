import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PcHealth } from '@dool2/protocol'
import { describe, expect, it } from 'vitest'
import { HealthMonitor, healthIssues } from './health.js'

describe('PC health for the phones', () => {
  it('names what is wrong, most urgent first', () => {
    expect(healthIssues({ lagMs: 20, load: 0.3, diskGb: 80, extension: true })).toEqual([])
    expect(
      healthIssues({ lagMs: 4000, load: 2.4, diskGb: 1.2, extension: false, ai: 'limit', sleeping: true }),
    ).toEqual(['sleeping', 'ai-limit', 'slow', 'busy', 'low-disk', 'no-extension'])
    expect(healthIssues({ lagMs: 0, load: 0, extension: true, ai: 'signed-out' })).toEqual(['ai-signed-out'])
  })

  it('a usage limit shows until a turn answers again, and sleep is sent at once', async () => {
    const sent: { h: PcHealth; changed: boolean }[] = []
    const mon = new HealthMonitor({
      dataDir: await mkdtemp(join(tmpdir(), 'dool2-health-')),
      extension: () => true,
      agents: () => 1,
      send: (h, changed) => sent.push({ h, changed }),
      everyMs: 60_000,
    })
    mon.turnEnded('limit_reached', '2026-11-27T03:00:00.000Z')
    await new Promise((r) => setTimeout(r, 30))
    expect(sent.at(-1)?.h.issues).toContain('ai-limit')
    expect(sent.at(-1)?.h.limitResetsAt).toBe('2026-11-27T03:00:00.000Z')
    expect(sent.at(-1)?.changed).toBe(true)
    // A stopped turn says nothing about the limit
    mon.turnEnded('aborted')
    await new Promise((r) => setTimeout(r, 30))
    expect(sent.at(-1)?.h.issues).toContain('ai-limit')
    mon.turnEnded(undefined)
    await new Promise((r) => setTimeout(r, 30))
    expect(sent.at(-1)?.h.issues).not.toContain('ai-limit')
    mon.setSleeping(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(sent.at(-1)?.h.issues[0]).toBe('sleeping')
    expect(sent.at(-1)?.h.agents).toBe(1)
    mon.stop()
  })
})
