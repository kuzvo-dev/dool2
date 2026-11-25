// Opening Chrome when the browser is needed (ADR 0006 follow-up "Opening Chrome by itself").
// A browser tool, a service tool or a connect card that reaches for the browser while the extension is not connected
// opens the user's own Chrome into the profile that has the Dool2 extension, waits for the extension and goes on.
// When Chrome already runs without it (stuck on its profile picker, or no window of that profile), it opens that
// profile's window once. What could not be fixed comes back as one plain reason about Chrome or the extension, never
// as a broken service connection.

/** What needed the browser: a browser tool, a service tool or a connect card */
export type ChromeLaunchReason = 'browser' | 'service' | 'connect'

/** Why the browser is still not there */
export type BrowserMissing =
  /** Chrome is closed and opening it by itself is off in settings */
  | 'off'
  /** Chrome is not installed */
  | 'not-installed'
  /** Chrome is closed and the OS did not start it */
  | 'launch-failed'
  /** Dool2 opened Chrome, but the extension did not connect in time */
  | 'no-connect'
  /** Chrome is open but the extension is not connected (profile picker, extension turned off or not added) */
  | 'extension-off'

export interface BrowserNotReady {
  ok: false
  why: BrowserMissing
  /** The name the person sees for the Chrome profile that has (or should have) the extension */
  profile?: string
}

export type BrowserReady = { ok: true; launched?: boolean } | BrowserNotReady

/** The Chrome profile to open (see findChromeProfile in @dool2/browser) */
export interface LaunchProfile {
  dir: string
  name?: string
  hasExtension: boolean
}

export interface ChromeLauncherDeps {
  /** Whether the extension is connected now */
  connected(): boolean
  /** Resolves true as soon as the extension connects, false after ms */
  waitConnected(ms: number): Promise<boolean>
  installed(): Promise<boolean>
  running(): Promise<boolean>
  /** The profile with the Dool2 extension (else the last used one); undefined when Chrome's files cannot be read */
  profile(): Promise<LaunchProfile | undefined>
  /** Opens the user's Chrome into that profile (running: its window in the running Chrome). Resolves whether it started */
  launch(o: { profile?: string; running: boolean }): Promise<boolean>
  /** The setting (chromeAutoOpen, on by default) */
  enabled(): boolean
  /** One `chrome-launch` line in the work log */
  journal?(data: Record<string, unknown>): void
  now?(): number
  /** How long to wait for the extension after opening Chrome (default 20 s) */
  waitMs?: number
  /** How long to wait when Chrome is already open (the person may have just opened it; default 3 s) */
  graceMs?: number
  /** After an attempt that did not connect, no new attempt for this long (default 2 min): no loops */
  quietMs?: number
}

export class ChromeLauncher {
  private inflight?: Promise<BrowserReady>
  /** The last attempt that did not end connected */
  private failed?: { at: number; result: BrowserNotReady }

  constructor(private readonly d: ChromeLauncherDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now()
  }

  /**
   * Makes sure the extension is connected, opening Chrome when needed. Calls at the same time share one attempt
   */
  ensure(reason: ChromeLaunchReason): Promise<BrowserReady> {
    if (this.d.connected()) {
      // It connected since (the person fixed it): the next time Chrome closes, open it again
      this.failed = undefined
      return Promise.resolve({ ok: true })
    }
    this.inflight ??= this.attempt(reason).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async attempt(reason: ChromeLaunchReason): Promise<BrowserReady> {
    const started = this.now()
    // One attempt per short window: a call right after one that did not connect gets the same answer at once
    const last = this.failed
    if (last && started - last.at < (this.d.quietMs ?? 120_000)) return last.result
    const running = await this.d.running().catch(() => true)
    // Chrome is open: the extension may be a moment from connecting (the person just opened it)
    if (running && (await this.d.waitConnected(this.d.graceMs ?? 3_000))) return { ok: true }
    const found = await this.d.profile().catch(() => undefined)
    const name = found?.name ? { profile: found.name } : {}
    if (!this.d.enabled()) return { ok: false, why: running ? 'extension-off' : 'off', ...name }
    if (!running && !(await this.d.installed().catch(() => false))) return this.give({ why: 'not-installed' })
    // Chrome closed: start it. Chrome open without the extension (profile picker): open that profile's window once
    const mode = running ? 'window' : 'start'
    const launched = await this.d
      .launch({ ...(found ? { profile: found.dir } : {}), running })
      .catch(() => false)
    if (!launched) {
      this.d.journal?.({ reason, mode, ok: false, why: 'launch-failed', ms: this.now() - started })
      return this.give({ why: running ? 'extension-off' : 'launch-failed', ...name })
    }
    const ok = await this.d.waitConnected(this.d.waitMs ?? 20_000)
    const why: BrowserMissing = running ? 'extension-off' : 'no-connect'
    // No profile names in the log (they are often the person's name): only whether the profile had the extension
    this.d.journal?.({
      reason,
      mode,
      ok,
      ...(ok ? {} : { why }),
      ...(found ? { profileHasExtension: found.hasExtension } : { profileKnown: false }),
      ms: this.now() - started,
    })
    if (!ok) return this.give({ why, ...name })
    this.failed = undefined
    return { ok: true, launched: true }
  }

  private give(r: Omit<BrowserNotReady, 'ok'>): BrowserNotReady {
    const result: BrowserNotReady = { ok: false, ...r }
    this.failed = { at: this.now(), result }
    return result
  }
}

/**
 * The tool result line when the browser is still not there: what is wrong and what the person does. Every line says the
 * extension "is not connected" (the connectors' offline check matches it, so a service tool is not marked broken) and
 * that the service connection itself is fine
 */
export function browserMissingText(r: { why: BrowserMissing; profile?: string }): string {
  const fine = 'The service connection itself is fine; nothing needs to be connected again.'
  const after = 'Call this again once it is done.'
  const profile = r.profile ? `the "${r.profile}" profile` : 'the profile the Dool2 extension was added to'
  switch (r.why) {
    case 'off':
      return `Chrome is closed, so the Dool2 extension is not connected (opening Chrome automatically is off in Dool2's settings). ${fine} Tell the person to open Chrome on the PC (${profile}). ${after}`
    case 'not-installed':
      return `Chrome is not installed on this PC, so the Dool2 extension is not connected. Tell the person to install Chrome from Dool2's settings on the PC (AI · Browser). ${after}`
    case 'launch-failed':
      return `Chrome is closed and Dool2 could not open it, so the Dool2 extension is not connected. ${fine} Tell the person to open Chrome on the PC (${profile}). ${after}`
    case 'no-connect':
      return `Dool2 opened Chrome (${profile}), but the Dool2 extension is still not connected after 20 seconds: it may be turned off or not added there. ${fine} Tell the person to check that the Dool2 extension is on in Chrome's ${profile} (Dool2's settings on the PC, AI · Browser, show its state). ${after}`
    case 'extension-off':
      return `Chrome is open, but the Dool2 extension is not connected: Chrome may be waiting on its profile picker, or the extension is turned off there. ${fine} Tell the person to open Chrome's ${profile} and make sure the Dool2 extension is on in it (Dool2's settings on the PC, AI · Browser, show its state). ${after}`
  }
}
