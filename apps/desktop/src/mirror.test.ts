import { describe, expect, it } from 'vitest'
import { type MirrorCaller, type MirrorFrame, startBrowserMirror } from './mirror.js'

/** A fake CdpBrowserCaller: records calls, delivers screencast frames on demand, and can refuse to start or have no tab. */
class FakeCaller implements MirrorCaller {
  started = false
  stopped = false
  failStart = false
  noTabs = false
  readonly tabId = 1
  readonly calls: { cmd: string; args?: Record<string, unknown> }[] = []
  private readonly subs = new Map<number, Set<(f: MirrorFrame) => void>>()

  async call(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ cmd, args })
    if (cmd === 'tabs') return { tabs: this.noTabs ? [] : [{ tabId: this.tabId, active: true }] }
    if (cmd === 'screencast') {
      if (args?.action === 'start') {
        if (this.failStart) throw new Error('screencast refused')
        this.started = true
        return { started: true }
      }
      if (args?.action === 'stop') {
        this.stopped = true
        return { stopped: true }
      }
    }
    if (cmd === 'screenshot') return { data: 'SHOT', mime: 'image/jpeg' }
    return {}
  }

  onScreencastFrame(tabId: number, cb: (f: MirrorFrame) => void): () => void {
    let s = this.subs.get(tabId)
    if (!s) {
      s = new Set()
      this.subs.set(tabId, s)
    }
    s.add(cb)
    return () => {
      this.subs.get(tabId)?.delete(cb)
    }
  }

  emit(tabId: number, f: MirrorFrame): void {
    for (const cb of this.subs.get(tabId) ?? []) cb(f)
  }

  subCount(tabId: number): number {
    return this.subs.get(tabId)?.size ?? 0
  }
}

describe('startBrowserMirror', () => {
  it('starts a screencast and forwards each frame to onFrame as a data: URL', async () => {
    const caller = new FakeCaller()
    const frames: (string | null)[] = []
    const stop = await startBrowserMirror({
      caller,
      captureFrame: async () => null,
      onFrame: (f) => frames.push(f),
    })
    expect(caller.started).toBe(true)
    caller.emit(1, { data: 'ABC', mime: 'image/jpeg' })
    expect(frames).toContain('data:image/jpeg;base64,ABC')
    await stop()
    expect(caller.stopped).toBe(true)
  })

  it('subscribes only while the pane is open: nothing before start, nothing after stop', async () => {
    const caller = new FakeCaller()
    expect(caller.subCount(1)).toBe(0) // pane closed → no subscription
    const stop = await startBrowserMirror({ caller, captureFrame: async () => null, onFrame: () => {} })
    expect(caller.subCount(1)).toBe(1)
    await stop()
    expect(caller.subCount(1)).toBe(0)
    // A frame arriving after stop reaches no one.
    const frames: (string | null)[] = []
    caller.emit(1, { data: 'LATE', mime: 'image/jpeg' })
    expect(frames).toHaveLength(0)
  })

  it('offline (no caller) shows the idle state once and streams nothing', async () => {
    const frames: (string | null)[] = []
    const stop = await startBrowserMirror({
      captureFrame: async () => null,
      onFrame: (f) => frames.push(f),
    })
    expect(frames).toEqual([null])
    await stop()
  })

  it('falls back to periodic screenshots when the screencast cannot start', async () => {
    const caller = new FakeCaller()
    caller.failStart = true
    const frames: (string | null)[] = []
    const stop = await startBrowserMirror({
      caller,
      captureFrame: async () => 'data:image/jpeg;base64,SHOT',
      onFrame: (f) => frames.push(f),
      pollMs: 10,
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(frames[0]).toBe('data:image/jpeg;base64,SHOT')
    expect(caller.subCount(1)).toBe(0) // the screencast subscription was dropped
    await stop()
  })

  it('falls back to periodic screenshots when no tab is open yet', async () => {
    const caller = new FakeCaller()
    caller.noTabs = true
    const frames: (string | null)[] = []
    const stop = await startBrowserMirror({
      caller,
      captureFrame: async () => 'data:image/jpeg;base64,SHOT',
      onFrame: (f) => frames.push(f),
      pollMs: 10,
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(frames[0]).toBe('data:image/jpeg;base64,SHOT')
    expect(caller.started).toBe(false)
    await stop()
  })
})
