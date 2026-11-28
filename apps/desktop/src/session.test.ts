import type { AgentdEvent } from '@dool2/agentd'
import { describe, expect, it } from 'vitest'
import { DEMO_MESSAGE, demoBrain } from './demo.js'
import { createSession } from './session.js'

describe('createSession (offline demo)', () => {
  it('runs a full demo turn in-process with no network or Chromium, and surfaces the vault fill', async () => {
    const session = createSession({ brain: demoBrain() })
    const events: AgentdEvent[] = []
    const result = await session.agentd.send(DEMO_MESSAGE, { onEvent: (e) => events.push(e) })

    expect(result.stop).toBe('done')
    // Dool2's own words came through.
    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)
    expect(texts.some((t) => t.includes('12,300'))).toBe(true)
    // It drove the code hand (the broad "big hand"), including the vault fill, and never asked for a signature.
    expect(events.some((e) => e.type === 'tool_call' && e.name === 'code')).toBe(true)
    expect(result.approvalsNeeded).toHaveLength(0)

    await session.close()
  })

  it('has no live browser frame to mirror when offline', async () => {
    const session = createSession({ brain: demoBrain() })
    expect(await session.captureFrame()).toBeNull()
    await session.close()
  })

  it('starts at the autonomy level it was given and can lower it freely', () => {
    const session = createSession({ brain: demoBrain(), level: 'auto' })
    expect(session.agentd.level).toBe('auto')
    const toAsk = session.agentd.setLevel('ask')
    expect(toAsk.ok).toBe(true)
    expect(session.agentd.level).toBe('ask')
  })

  it('refuses full-auto from the desktop without a phone-signed consent (ADR 0047)', () => {
    const session = createSession({ brain: demoBrain(), level: 'auto' })
    const result = session.agentd.setLevel('full')
    expect(result.ok).toBe(false)
    // The level stays where it was; full-auto only turns on from the phone's secure chip.
    expect(session.agentd.level).toBe('auto')
  })

  it('refuses the built-in browser without a data folder', () => {
    expect(() => createSession({ brain: demoBrain(), builtinBrowser: true })).toThrow(/dataDir/)
  })
})
