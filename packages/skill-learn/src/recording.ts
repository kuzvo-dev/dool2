/**
 * The recording input: what Dool2 observed while doing a task on a site.
 *
 * This package is pure drafting logic. The *live* capture — listening to CDP
 * `Network.requestWillBeSent` / `responseReceived` on the tab Dool2 opened to
 * learn the page's internal API calls and their headers, and transcribing the
 * UI steps and login fields — is the daemon/browser's job (see
 * `@dool2/browser`). It hands the result here as a {@link SessionRecording};
 * everything below is plain data, never a live connection.
 */

/**
 * One internal API call the page made during the task, as seen on the network.
 *
 * `headers` carries header *names* (and only safe values) — the session cookie
 * and `Authorization` are added by the browser automatically and are never
 * worth (or safe) recording. The drafter redacts anything secret-looking from
 * `url` and `headers` before it reaches the SKILL.md, so even a value captured
 * by mistake does not land in a skill.
 */
export interface CapturedApiCall {
  /** HTTP method, e.g. `GET`, `POST`. */
  method: string
  /** Full request URL as captured (query is stripped/redacted before drafting). */
  url: string
  /** Request header names, optionally with safe values. Secrets are redacted out. */
  headers?: Record<string, string>
  /** Response status, when the call succeeded. */
  status?: number
  /** Response content type, e.g. `application/json`. */
  contentType?: string
}

/** One UI action Dool2 took on the page, kept as the ordered fallback path. */
export interface UiStep {
  /** The kind of action. */
  action: 'goto' | 'click' | 'type' | 'fill'
  /** An accessibility-snapshot ref (`@dool2/browser`), when the action used one. */
  ref?: string
  /** A CSS selector, when the action targeted one directly. */
  selector?: string
  /** A human label for the target (may be a Korean site label; it is data). */
  label?: string
}

/**
 * The login fields Dool2 located on the site, as label text or selectors. These
 * become `login` frontmatter hints the vault reads; the values typed into them
 * are secrets the vault holds and never appear here.
 */
export interface RecordedLoginFields {
  /** The id / username field (label text or selector). */
  username?: string
  /** The password field. */
  password?: string
  /** The submit / login button. */
  submit?: string
  /** The one-time-code (TOTP / 2FA) field. */
  totp?: string
}

/** The full record of one task on one site, the input to {@link draftSkill}. */
export interface SessionRecording {
  /** A representative tab URL from the task. */
  url: string
  /** The site host, e.g. `order.coupang.com`. */
  host: string
  /** Internal API calls the page made (the data path). */
  apiCalls?: CapturedApiCall[]
  /** The UI steps that worked, in order (the fallback path). */
  uiSteps?: UiStep[]
  /** Login field hints, when the task involved signing in. */
  loginFields?: RecordedLoginFields
  /** Korean-first keywords seen in the task (used to derive `autoInject.keywords`). */
  keywordsSeen?: string[]
}
