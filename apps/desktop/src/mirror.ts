// The live mirror of Dool2's invisible browser for the "watch Dool2's browser" pane. It prefers a real screencast
// (Chromium's Page.startScreencast, surfaced by @dool2/browser CdpBrowserCaller.onScreencastFrame) over the old
// periodic screenshot: frames arrive as the page changes instead of once every poll. If there is no live browser
// (offline/fake page), no tab open yet, or the screencast cannot start, it falls back gracefully to a periodic
// screenshot loop. This module imports NO electron, so the main process can unit-test the forwarding with a fake
// caller. Frames are page pixels (same visibility as a screenshot); they are forwarded to the window, never kept on
// disk.

/** One screencast frame from the caller (base64 image bytes + mime). Mirrors @dool2/browser ScreencastFrame. */
export interface MirrorFrame {
  data: string
  mime: string
}

/** The slice of CdpBrowserCaller the mirror needs. CdpBrowserCaller satisfies it; tests inject a fake. */
export interface MirrorCaller {
  call(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  onScreencastFrame(tabId: number, cb: (frame: MirrorFrame) => void): () => void
}

export interface MirrorOptions {
  /** The live browser caller, or undefined when offline (fake page): then there is nothing to stream. */
  caller?: MirrorCaller
  /** Single-shot capture used for the fallback periodic loop (and offline). Returns a data: URL or null. */
  captureFrame: () => Promise<string | null>
  /** Called with each frame as a data: URL, or null to show the idle state. */
  onFrame: (dataUrl: string | null) => void
  /** Fallback poll interval in ms (default 700). */
  pollMs?: number
  /** Screencast jpeg quality 1-100 (default left to the caller). */
  quality?: number
  /** Screencast max frame width in px (default left to the caller). */
  maxWidth?: number
  /** Deliver only every Nth frame, to cap the rate (default 1). */
  everyNthFrame?: number
}

/** Stops a running mirror (idempotent): unsubscribes and tells the caller to stop the screencast. */
export type StopMirror = () => Promise<void>

/** Reads the active tab's id (the one the pane should mirror), or undefined when there is no tab yet. */
async function activeTabId(caller: MirrorCaller): Promise<number | undefined> {
  try {
    const { tabs } = (await caller.call('tabs')) as {
      tabs: { tabId: number; active: boolean }[]
    }
    const tab = tabs.find((t) => t.active) ?? tabs[0]
    return tab?.tabId
  } catch {
    return undefined
  }
}

/** The fallback: paint a fresh screenshot every pollMs until stopped. Also covers "no tab yet" (it paints once one opens). */
function startPolling(o: MirrorOptions): StopMirror {
  let stopped = false
  const tick = async (): Promise<void> => {
    if (stopped) return
    o.onFrame(await o.captureFrame().catch(() => null))
  }
  void tick()
  const timer = setInterval(() => void tick(), o.pollMs ?? 700)
  timer.unref?.()
  return async () => {
    stopped = true
    clearInterval(timer)
  }
}

/**
 * Start mirroring. Subscribes to screencast frames of the active tab and forwards each as a data: URL; returns a
 * stop function. Falls back to the periodic screenshot loop when there is no caller, no tab, or the screencast fails.
 */
export async function startBrowserMirror(o: MirrorOptions): Promise<StopMirror> {
  const { caller } = o
  // No live browser (offline/fake page): show the idle state once; there is nothing to stream.
  if (!caller) {
    o.onFrame(await o.captureFrame().catch(() => null))
    return async () => {}
  }
  const tabId = await activeTabId(caller)
  // No tab open yet: poll, which starts painting as soon as a tab appears.
  if (tabId === undefined) return startPolling(o)

  // Subscribe first, then start the screencast, so no early frame is missed.
  const unsub = caller.onScreencastFrame(tabId, (f) => o.onFrame(`data:${f.mime};base64,${f.data}`))
  try {
    await caller.call('screencast', {
      tabId,
      action: 'start',
      ...(o.quality !== undefined ? { quality: o.quality } : {}),
      ...(o.maxWidth !== undefined ? { maxWidth: o.maxWidth } : {}),
      ...(o.everyNthFrame !== undefined ? { everyNthFrame: o.everyNthFrame } : {}),
    })
  } catch {
    // Screencast could not start: drop the subscription and fall back to periodic screenshots.
    unsub()
    return startPolling(o)
  }

  let stopped = false
  return async () => {
    if (stopped) return
    stopped = true
    unsub()
    try {
      await caller.call('screencast', { tabId, action: 'stop' })
    } catch {
      // the browser may already be gone; nothing to stop
    }
  }
}
