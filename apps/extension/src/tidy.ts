// Tidying Dool2 tabs: when finished tabs pile up, Chrome eats several GB of memory.
// Even if the AI forgets to close tabs at the end of a task, the extension puts long-idle Dool2 tabs to sleep (discard) and closes them.
// Pure functions that only decide, so tests pin them (the real closing and sleeping is in background.ts).

/** Only this many Dool2 tabs are kept open. When a new one opens, the longest idle tab is closed first.
 * On sites with heavy maps and lists one tab is 0.5-1GB, so even 4 is too much on an 8GB Mac (measured: Catch Table search map) */
export const MAX_TABS = 3
/** Put to sleep after this long idle (the tab stays and only the memory is freed; it reloads when used again). Longer than the approval wait (10 minutes) */
export const SLEEP_AFTER_MS = 12 * 60_000
/** A tab just opened or used: not closed during this time even if there are too many */
export const RECENT_MS = 60_000
/** Closed after this long idle */
export const CLOSE_AFTER_MS = 45 * 60_000

export interface TidyTab {
  id: number
  /** When Dool2 last asked this tab to do something (unknown counts as now) */
  usedAt: number
  /** Viewed on the phone's remote screen, just opened, or held: left alone */
  keep?: boolean
  /**
   * Family tabs: a tab whose opened new window is still alive (an order page that opened a payment window), or a tab opened within 30 minutes by a live tab (the payment window).
   * Neither closed nor put to sleep - closing or sleeping the order page leaves the payment window nowhere to return its result, and payment breaks (measured 11-20 Gmarket)
   */
  family?: boolean
  /** Already asleep */
  discarded?: boolean
  /** Chrome cannot put the front tab of a window to sleep */
  active?: boolean
}

export interface TidyPlan {
  close: number[]
  sleep: number[]
}

export function tidyPlan(input: TidyTab[], now: number, max = MAX_TABS): TidyPlan {
  const tabs = input.map((t) => (t.family ? { ...t, keep: true } : t))
  const close = new Set<number>()
  // 1) Close tabs idle for a long time
  for (const t of tabs) if (!t.keep && now - t.usedAt >= CLOSE_AFTER_MS) close.add(t.id)
  // 2) If still too many, close from the longest idle. Tabs opened or used just now (within 1 minute) are not closed:
  //    the Kakao/Naver window opened by a login button (a taken-over tab) was closed right after opening and stopped with 'the tab was closed' (measured 2026-11-19)
  const left = tabs.filter((t) => !close.has(t.id))
  const extra = left.length - max
  if (extra > 0) {
    const oldest = left
      .filter((t) => !t.keep && now - t.usedAt >= RECENT_MS)
      .sort((a, b) => a.usedAt - b.usedAt)
    for (const t of oldest.slice(0, extra)) close.add(t.id)
  }
  // 3) Of the rest, tabs idle for a while are put to sleep
  const sleep = tabs
    .filter(
      (t) => !close.has(t.id) && !t.keep && !t.discarded && !t.active && now - t.usedAt >= SLEEP_AFTER_MS,
    )
    .map((t) => t.id)
  return { close: [...close], sleep }
}
