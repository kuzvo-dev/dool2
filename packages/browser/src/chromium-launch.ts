// Dool2's own browser, part 2: starting the downloaded Chromium hidden and talking to it (ADR 0046).
// - Its own profile in the Dool2 data folder (owner-only), never the person's Chrome profile.
// - DevTools over a pipe (--remote-debugging-pipe): no debugging port, nothing else on the PC can drive it.
// - No automation flag (--enable-automation shows a bar and changes how sites see the browser).
// - macOS: a mock keychain and basic password store. Without them Chromium asks macOS for the "Chromium Safe Storage"
//   key and macOS asks the person for their login password (seen on the test Mac).
// - No window at start. Each page gets its own window, created inactive (it never takes focus) and pushed to the
//   bottom-left corner as far as the OS allows, behind the person's windows. A page in a background tab would count
//   as hidden to the site, a window of its own stays "visible".
// - Closes itself after an idle period; the next use starts it again (profile and logins stay).
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { chmod, mkdir } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import { CdpError, CdpPipe } from './cdp-pipe.js'

/** Where a page window goes: far outside the screen; the OS pulls it back to the corner and keeps it behind */
export const HIDDEN_WINDOW = { left: -32000, top: 32000, width: 1280, height: 900 } as const

export interface ChromiumArgsOptions {
  profileDir: string
  platform?: NodeJS.Platform
}

/** The command line Dool2 starts Chromium with */
export function chromiumArgs(o: ChromiumArgsOptions): string[] {
  const platform = o.platform ?? process.platform
  const args = [
    `--user-data-dir=${o.profileDir}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-startup-window',
    // The pipe alone makes Chromium report navigator.webdriver = true to every page (measured on 158 and 160), which the
    // person's Chrome with the Dool2 extension never does. This turns only that flag off; the browser still says
    // plainly that it is Chromium
    '--disable-blink-features=AutomationControlled',
  ]
  // macOS: keep the profile's cookie key out of the OS keychain (no login-password prompt; Dool2 keeps it later,
  // ADR 0046), and keep Chromium away from the OS notification center: on its first start it registers there and macOS
  // shows the person a "Chromium notifications" banner (seen on the test Mac). Sites get no notification permission anyway
  if (platform === 'darwin')
    args.push('--use-mock-keychain', '--password-store=basic', '--disable-features=NativeNotifications')
  else if (platform === 'linux') args.push('--password-store=basic')
  return args
}

export class ChromiumLaunchError extends Error {}

type Spawn = (cmd: string, args: string[], opts: { stdio: unknown[] }) => ChildProcess

export interface LaunchChromiumOptions {
  executable: string
  profileDir: string
  platform?: NodeJS.Platform
  /** Closes the browser after this long without a command (default 5 minutes; 0 = never) */
  idleMs?: number
  /** How long the browser may take to answer its first command (default 30 s) */
  startMs?: number
  /** Swapped in tests */
  spawn?: Spawn
}

/** Makes the profile folder and keeps it to the owner (on Windows the user folder's rights already do) */
export async function prepareProfile(dir: string, platform: NodeJS.Platform = process.platform) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (platform !== 'win32') await chmod(dir, 0o700)
}

/** Starts Chromium and waits until it answers over the pipe */
export async function launchChromium(o: LaunchChromiumOptions): Promise<ChromiumBrowser> {
  const platform = o.platform ?? process.platform
  await prepareProfile(o.profileDir, platform)
  const doSpawn: Spawn = o.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts as never))
  const child = doSpawn(o.executable, chromiumArgs({ profileDir: o.profileDir, platform }), {
    // stdin, stdout ignored; stderr kept for errors; fd 3 = commands to the browser, fd 4 = answers from it
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-4000)
  })
  const spawnError = new Promise<never>((_, reject) => {
    child.once('error', (err) => reject(new ChromiumLaunchError(`Chromium did not start: ${err.message}`)))
    child.once('exit', (code) =>
      reject(
        new ChromiumLaunchError(`Chromium exited at start (code ${code}): ${stderr.trim().slice(-500)}`),
      ),
    )
  })
  spawnError.catch(() => {})
  const cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable)
  try {
    const v = await Promise.race([
      cdp.send('Browser.getVersion', {}, undefined, o.startMs ?? 30_000),
      spawnError,
    ])
    return new ChromiumBrowser(child, cdp, String(v.product ?? ''), o.idleMs ?? 5 * 60_000)
  } catch (err) {
    child.kill()
    throw err instanceof ChromiumLaunchError ? err : new ChromiumLaunchError((err as Error).message)
  }
}

/** One page of Dool2's browser: its own hidden window, attached as a flat session */
export class ChromiumPage {
  constructor(
    private readonly browser: ChromiumBrowser,
    readonly targetId: string,
    readonly sessionId: string,
  ) {}

  /** A DevTools command on this page */
  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId, timeoutMs)
  }

  navigate(url: string) {
    return this.send('Page.navigate', { url })
  }

  /**
   * Evaluates a JavaScript expression in the page and returns its value (promises are awaited). Runtime is not
   * enabled for this: sites can notice a page whose Runtime domain is on
   */
  async evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T> {
    const r = await this.send<{
      result?: { value?: unknown }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new CdpError(d.exception?.description ?? d.text ?? 'The expression threw', 'Runtime.evaluate')
    }
    return r.result?.value as T
  }

  /**
   * Waits until the page shows the text (content ready, not the load event, which busy shops reach only after ~30 s).
   * Resolves the ms it took; rejects after timeoutMs with what the page showed
   */
  async waitForText(text: string, timeoutMs = 30_000, everyMs = 200): Promise<number> {
    const started = Date.now()
    const expr = `(document.body?.innerText ?? '').includes(${JSON.stringify(text)})`
    for (;;) {
      const found = await this.evaluate<boolean>(expr, 10_000).catch(() => false)
      if (found) return Date.now() - started
      if (Date.now() - started >= timeoutMs) {
        const seen = await this.evaluate<string>('document.title', 5_000).catch(() => '')
        throw new CdpError(
          `"${text}" did not appear within ${timeoutMs} ms (the page's title is "${seen}")`,
          'waitForText',
        )
      }
      await new Promise((r) => setTimeout(r, everyMs))
    }
  }

  close() {
    return this.browser.send('Target.closeTarget', { targetId: this.targetId })
  }
}

/** A running Dool2 browser */
export class ChromiumBrowser {
  private idleTimer: NodeJS.Timeout | undefined
  private closing: Promise<void> | undefined
  readonly exited: Promise<number | null>

  constructor(
    private readonly child: ChildProcess,
    private readonly cdp: CdpPipe,
    /** "Chrome/160.0.…" */
    readonly product: string,
    private readonly idleMs: number,
  ) {
    this.exited = new Promise((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode)
      else child.once('exit', (code) => resolve(code))
    })
    void this.exited.then(() => this.stopIdle())
    this.touch()
  }

  get pid() {
    return this.child.pid
  }

  get running() {
    return this.child.exitCode === null && this.child.signalCode === null && !this.cdp.closed
  }

  /** DevTools events: (method, params, sessionId) */
  onEvent(fn: (method: string, params: Record<string, unknown>, sessionId?: string) => void) {
    this.cdp.on('event', fn)
    return () => this.cdp.off('event', fn)
  }

  /** A DevTools command (browser-wide without sessionId). Every command counts as use for the idle timer */
  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T> {
    this.touch()
    return this.cdp.send<T>(method, params, sessionId, timeoutMs)
  }

  /** Opens a page in a new hidden window (never activated) and attaches to it */
  async openPage(url = 'about:blank'): Promise<ChromiumPage> {
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', {
      url,
      newWindow: true,
      background: true,
      ...HIDDEN_WINDOW,
    })
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    return new ChromiumPage(this, targetId, sessionId)
  }

  /** Restarts the idle countdown */
  touch() {
    if (!this.idleMs) return
    this.stopIdle()
    this.idleTimer = setTimeout(() => void this.close(), this.idleMs)
    this.idleTimer.unref?.()
  }

  private stopIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /** Closes the browser: asks it to quit (it saves cookies), and ends the process if it has not after graceMs */
  close(graceMs = 5_000): Promise<void> {
    this.stopIdle()
    this.closing ??= (async () => {
      if (!this.running) return
      await this.cdp.send('Browser.close', {}, undefined, graceMs).catch(() => {})
      const done = await Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), graceMs).unref?.()),
      ])
      if (!done) {
        this.child.kill()
        await this.exited
      }
    })()
    return this.closing
  }
}
