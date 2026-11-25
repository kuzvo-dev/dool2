import { describe, expect, it } from 'vitest'
import { browserMissingText, ChromeLauncher, type ChromeLauncherDeps } from './chrome-launch.js'

/**
 * A stand-in PC (no real Chrome is ever started): Chrome closed, the extension connects after a launch unless told
 * otherwise. waitConnected moves the clock by the time waited
 */
function fakePc(over: Partial<ChromeLauncherDeps> & { connectsAfterLaunch?: boolean } = {}) {
  let connected = false
  let running = false
  let clock = 0
  const launches: { profile?: string; running: boolean }[] = []
  const lines: Record<string, unknown>[] = []
  const waits: number[] = []
  const deps: ChromeLauncherDeps = {
    connected: () => connected,
    waitConnected: async (ms) => {
      waits.push(ms)
      const comes = launches.length > 0 && over.connectsAfterLaunch !== false
      clock += comes ? 1_500 : ms
      if (comes) connected = true
      return connected
    },
    installed: async () => true,
    running: async () => running,
    profile: async () => ({ dir: 'Profile 1', name: 'Work', hasExtension: true }),
    launch: async (o) => {
      launches.push(o)
      running = true
      return true
    },
    enabled: () => true,
    journal: (d) => lines.push(d),
    now: () => clock,
    ...over,
  }
  return {
    launcher: new ChromeLauncher(deps),
    launches,
    lines,
    waits,
    set: (s: { connected?: boolean; running?: boolean; clock?: number }) => {
      if (s.connected !== undefined) connected = s.connected
      if (s.running !== undefined) running = s.running
      if (s.clock !== undefined) clock = s.clock
    },
  }
}

describe('Opening Chrome when the browser is needed', () => {
  it('does nothing when the extension is connected', async () => {
    const pc = fakePc()
    pc.set({ connected: true, running: true })
    expect(await pc.launcher.ensure('browser')).toEqual({ ok: true })
    expect(pc.launches).toEqual([])
  })

  it('Chrome closed: starts it once in the extension profile, waits, and logs how long it took', async () => {
    const pc = fakePc()
    const [a, b] = await Promise.all([pc.launcher.ensure('service'), pc.launcher.ensure('browser')])
    expect(a).toEqual({ ok: true, launched: true })
    expect(b).toEqual(a)
    expect(pc.launches).toEqual([{ profile: 'Profile 1', running: false }])
    expect(pc.waits).toEqual([20_000])
    expect(pc.lines).toEqual([
      { reason: 'service', mode: 'start', ok: true, profileHasExtension: true, ms: 1_500 },
    ])
  })

  it('Chrome closed and Chrome files unreadable: starts it with no profile', async () => {
    const pc = fakePc({ profile: async () => undefined })
    expect(await pc.launcher.ensure('browser')).toEqual({ ok: true, launched: true })
    expect(pc.launches).toEqual([{ running: false }])
    expect(pc.lines[0]).toMatchObject({ profileKnown: false })
  })

  it('Chrome on its profile picker: waits a moment, opens the profile window once, and goes on', async () => {
    const pc = fakePc()
    pc.set({ running: true })
    expect(await pc.launcher.ensure('service')).toEqual({ ok: true, launched: true })
    expect(pc.waits).toEqual([3_000, 20_000])
    expect(pc.launches).toEqual([{ profile: 'Profile 1', running: true }])
    expect(pc.lines[0]).toMatchObject({ reason: 'service', mode: 'window', ok: true })
  })

  it('Chrome open but the extension off: says so with the profile name, and does not try again in the window', async () => {
    const pc = fakePc({ connectsAfterLaunch: false })
    pc.set({ running: true })
    expect(await pc.launcher.ensure('browser')).toEqual({ ok: false, why: 'extension-off', profile: 'Work' })
    expect(pc.launches).toHaveLength(1)
    expect(pc.lines).toEqual([
      {
        reason: 'browser',
        mode: 'window',
        ok: false,
        why: 'extension-off',
        profileHasExtension: true,
        ms: 23_000,
      },
    ])
    // A call right after: the same answer at once, nothing opened or waited
    expect(await pc.launcher.ensure('browser')).toEqual({ ok: false, why: 'extension-off', profile: 'Work' })
    expect(pc.launches).toHaveLength(1)
    expect(pc.waits).toHaveLength(2)
  })

  it('the extension never connects after starting Chrome: says so, and does not open Chrome again in the window', async () => {
    const pc = fakePc({ connectsAfterLaunch: false })
    expect(await pc.launcher.ensure('browser')).toEqual({ ok: false, why: 'no-connect', profile: 'Work' })
    expect(pc.lines).toEqual([
      {
        reason: 'browser',
        mode: 'start',
        ok: false,
        why: 'no-connect',
        profileHasExtension: true,
        ms: 20_000,
      },
    ])
    // Closed again a moment later: not opened again
    pc.set({ running: false })
    expect(await pc.launcher.ensure('browser')).toEqual({ ok: false, why: 'no-connect', profile: 'Work' })
    expect(pc.launches).toHaveLength(1)
    // After the quiet window it tries again
    pc.set({ clock: 20_000 + 121_000 })
    await pc.launcher.ensure('browser')
    expect(pc.launches).toHaveLength(2)
  })

  it('the setting off: Chrome is not opened, nor a profile window', async () => {
    const closed = fakePc({ enabled: () => false })
    expect(await closed.launcher.ensure('browser')).toEqual({ ok: false, why: 'off', profile: 'Work' })
    const open = fakePc({ enabled: () => false })
    open.set({ running: true })
    expect(await open.launcher.ensure('browser')).toEqual({
      ok: false,
      why: 'extension-off',
      profile: 'Work',
    })
    expect([...closed.launches, ...open.launches]).toEqual([])
  })

  it('Chrome missing or not starting: says which', async () => {
    const missing = fakePc({ installed: async () => false })
    expect(await missing.launcher.ensure('browser')).toEqual({ ok: false, why: 'not-installed' })
    expect(missing.launches).toEqual([])
    const stuck = fakePc({ launch: async () => false })
    expect(await stuck.launcher.ensure('connect')).toEqual({
      ok: false,
      why: 'launch-failed',
      profile: 'Work',
    })
    expect(stuck.lines).toEqual([
      { reason: 'connect', mode: 'start', ok: false, why: 'launch-failed', ms: 0 },
    ])
  })

  it('opens it again after the extension was connected in between', async () => {
    const pc = fakePc({ connectsAfterLaunch: false })
    await pc.launcher.ensure('browser')
    pc.set({ connected: true })
    await pc.launcher.ensure('browser')
    pc.set({ connected: false, running: false, clock: 30_000 })
    await pc.launcher.ensure('browser')
    expect(pc.launches).toHaveLength(2)
  })

  it('every reason says Chrome or the extension, not the service, is the problem', () => {
    for (const why of ['off', 'not-installed', 'launch-failed', 'no-connect', 'extension-off'] as const) {
      const t = browserMissingText({ why, profile: 'Work' })
      // The connectors' offline check (EXTENSION_OFFLINE_EN) must match, so the tool is not rested as broken
      expect(t).toMatch(/extension.*not connected/)
      expect(t).toMatch(/Chrome/)
      expect(t).not.toMatch(/reconnect|connect_ask/)
    }
    expect(browserMissingText({ why: 'extension-off', profile: 'Work' })).toContain('"Work" profile')
  })
})
