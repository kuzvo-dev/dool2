// Dool2's "learn by watching" recorder (ADR 0046, the self-growing skill library).
//
// While Dool2 does a task on a site in its own hidden Chromium, a SessionRecorder watches the tab's network and the
// engine's acting steps and turns what worked into a `SessionRecording` (@dool2/skill-learn), which the daemon drafts
// into a SKILL.md. It captures the DATA PATH — the site's own internal API calls (XHR/fetch) made under the user's live
// session — and the UI PATH — the click/type/goto the engine performed — plus the login-field refs the vault located
// and the Korean keywords from the user's message.
//
// Two ways to feed it:
//   - Live: construct with `deps` (enableNetwork + subscribe) and call start(); it turns on the CDP Network domain and
//     listens to request/response events itself. The CdpBrowserCaller satisfies {@link RecordingBrowserCaller}, so
//     {@link recordSession} wires a recorder to a real tab.
//   - Direct: construct without deps and feed it fake CDP events via {@link SessionRecorder.onCdpEvent} (the unit
//     tests do this — no real browser or network).
//
// SECRETS NEVER LAND HERE. Captured request headers are reduced to safe NAMES only (cookie/authorization/token headers
// are dropped entirely, values are never stored — @dool2/skill-learn safeHeaderNames); the query string is stripped off
// every captured API url (that is where tokens ride); and nothing of a login value is recorded (only the page refs of
// the fields). The drafter runs its redactor over everything again as a final net.

import {
  type CapturedApiCall,
  type RecordedLoginFields,
  type SessionRecording,
  safeHeaderNames,
  sameRecordingSite,
  type UiStep,
} from '@dool2/skill-learn'

/** The browser caller surface a live recorder drives: the page `call`, plus the Network seam. CdpBrowserCaller fits. */
export interface RecordingBrowserCaller {
  call(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  /** Turn on the CDP Network domain on Dool2's tabs (and future ones), so request/response events flow to sinks. */
  enableNetwork(): Promise<void>
  /** Subscribe to Network.* CDP events for Dool2's own tabs; returns an unsubscribe. */
  onNetwork(cb: (method: string, params: Record<string, unknown>) => void): () => void
}

/** Wiring for a LIVE recorder. Omitted → the recorder is fed events directly (tests). */
export interface SessionRecorderDeps {
  /** Enable the CDP Network domain so request/response events start flowing. Called once on start(). */
  enableNetwork?: () => Promise<void> | void
  /** Subscribe to CDP events; the recorder filters to Network.* itself. Returns an unsubscribe. */
  subscribe?: (fn: (method: string, params: Record<string, unknown>) => void) => () => void
}

export interface SessionRecorderOptions {
  /** The tab's representative URL — sets the host the data path is filtered to. Updated by {@link SessionRecorder.noteUrl}. */
  url?: string
  /** Korean-first keywords seen in the user's message, carried into the draft's autoInject. */
  keywords?: string[]
  /** Live wiring; omit to feed events directly. */
  deps?: SessionRecorderDeps
  /** Cap on distinct API calls kept (guards a chatty page). Default 200. */
  maxApiCalls?: number
  /** Cap on UI steps kept. Default 200. */
  maxUiSteps?: number
}

/** A request seen on the wire, held until its response enriches it with status + content type. */
interface Pending {
  method: string
  url: string
  headers?: Record<string, string>
  type?: string
}

const DEFAULT_MAX_API = 200
const DEFAULT_MAX_UI = 200
/** CDP resourceType values that are an internal API call (not a document/image/css/font/script). */
const API_RESOURCE_TYPES = new Set(['xhr', 'fetch'])

/** Strip the query and fragment off a url, keeping origin + path (that is where tokens ride). Best-effort. */
function stripQuery(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url.split(/[?#]/)[0] || url
  }
}

/** The host of a url, lowercased, or '' when it is not parseable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** The pathname of a path/url, with any query/fragment removed (the dedup key never carries a query). */
function pathOnly(path: string): string {
  return path.split(/[?#]/)[0] || path
}

/**
 * Watch one task on one tab and produce a {@link SessionRecording}.
 *
 * Call {@link SessionRecorder.start} for the live path, or feed {@link SessionRecorder.onCdpEvent} directly. Call
 * {@link SessionRecorder.addUiStep}, {@link SessionRecorder.setLoginFields} and {@link SessionRecorder.addKeywords} as
 * the engine acts, then {@link SessionRecorder.toRecording} when the turn ends.
 */
export class SessionRecorder {
  #url: string
  #host: string
  readonly #keywords: string[] = []
  /** Pending requests by CDP requestId, awaiting their response. */
  readonly #pending = new Map<string, Pending>()
  /** Kept API calls, de-duplicated by `METHOD path`, in first-seen order. */
  readonly #api = new Map<string, CapturedApiCall>()
  readonly #ui: UiStep[] = []
  #login: RecordedLoginFields | undefined
  readonly #deps: SessionRecorderDeps | undefined
  readonly #maxApi: number
  readonly #maxUi: number
  #unsub: (() => void) | undefined
  #started = false

  constructor(opts: SessionRecorderOptions = {}) {
    this.#url = opts.url ?? ''
    this.#host = hostOf(this.#url)
    this.#deps = opts.deps
    this.#maxApi = opts.maxApiCalls ?? DEFAULT_MAX_API
    this.#maxUi = opts.maxUiSteps ?? DEFAULT_MAX_UI
    if (opts.keywords) this.addKeywords(opts.keywords)
  }

  /** The host the data path is filtered to (its base domain and equivalents are kept). */
  get host(): string {
    return this.#host
  }

  /** Begin the live capture: enable the CDP Network domain and subscribe to events. No-op without deps / twice. */
  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    await this.#deps?.enableNetwork?.()
    if (this.#deps?.subscribe) {
      this.#unsub = this.#deps.subscribe((method, params) => this.onCdpEvent(method, params))
    }
  }

  /** Stop the live capture (unsubscribe). Safe to call when not started. */
  stop(): void {
    this.#unsub?.()
    this.#unsub = undefined
  }

  /** Update the representative URL (e.g. after a goto) so the data path is filtered to the right host. */
  noteUrl(url: string): void {
    if (!url) return
    this.#url = url
    const host = hostOf(url)
    if (host) this.#host = host
  }

  /** Record one UI step the engine performed. The typed-in value is never passed here — only the field ref/label. */
  addUiStep(step: UiStep): void {
    if (this.#ui.length >= this.#maxUi) return
    this.#ui.push(step)
  }

  /** Record the login-field refs the vault located (page refs, never a secret value). Fills only missing fields. */
  setLoginFields(fields: RecordedLoginFields): void {
    const next: RecordedLoginFields = { ...(this.#login ?? {}) }
    for (const key of ['username', 'password', 'submit', 'totp'] as const) {
      const v = fields[key]
      if (v && !next[key]) next[key] = v
    }
    if (next.username || next.password || next.submit || next.totp) this.#login = next
  }

  /** Add keywords seen in the user's message (de-duplicated, order-preserving). */
  addKeywords(words: readonly string[]): void {
    for (const raw of words) {
      const w = raw.trim()
      if (w && !this.#keywords.includes(w)) this.#keywords.push(w)
    }
  }

  /**
   * Feed one CDP event. Handles `Network.requestWillBeSent` (method/url/headers) and `Network.responseReceived`
   * (status/mime/resourceType); everything else is ignored. Only same-origin XHR/Fetch calls are kept.
   */
  onCdpEvent(method: string, params: Record<string, unknown>): void {
    if (method === 'Network.requestWillBeSent') this.#onRequest(params)
    else if (method === 'Network.responseReceived') this.#onResponse(params)
  }

  #onRequest(params: Record<string, unknown>): void {
    const requestId = typeof params.requestId === 'string' ? params.requestId : ''
    const request = params.request as { url?: unknown; method?: unknown; headers?: unknown } | undefined
    if (!requestId || !request || typeof request.url !== 'string') return
    const headers =
      request.headers && typeof request.headers === 'object'
        ? (request.headers as Record<string, string>)
        : undefined
    const pending: Pending = {
      method: typeof request.method === 'string' ? request.method : 'GET',
      url: request.url,
      ...(headers ? { headers } : {}),
      ...(typeof params.type === 'string' ? { type: params.type } : {}),
    }
    // Bound the pending map so a page that fires many unanswered requests cannot grow it without limit.
    if (this.#pending.size > this.#maxApi * 4) {
      const oldest = this.#pending.keys().next().value
      if (oldest !== undefined) this.#pending.delete(oldest)
    }
    this.#pending.set(requestId, pending)
  }

  #onResponse(params: Record<string, unknown>): void {
    const requestId = typeof params.requestId === 'string' ? params.requestId : ''
    const pending = requestId ? this.#pending.get(requestId) : undefined
    this.#pending.delete(requestId)
    const response = params.response as { status?: unknown; mimeType?: unknown; url?: unknown } | undefined
    const resourceType = typeof params.type === 'string' ? params.type : pending?.type
    const url = pending?.url ?? (typeof response?.url === 'string' ? response.url : '')
    if (!url) return
    // Keep only the internal API: an XHR/Fetch to the page's own site. document/image/css/font/script and cross-site
    // calls are dropped here.
    if (!resourceType || !API_RESOURCE_TYPES.has(resourceType.toLowerCase())) return
    if (!this.#sameSite(url)) return

    const path = stripQuery(url)
    const method = (pending?.method ?? 'GET').toUpperCase()
    const key = `${method} ${pathOnly(path)}`
    const status = typeof response?.status === 'number' ? response.status : undefined
    const contentType =
      typeof response?.mimeType === 'string' && response.mimeType ? response.mimeType : undefined
    // Header NAMES only, with session/secret headers dropped entirely (safeHeaderNames); values are never stored.
    const headerNames = safeHeaderNames(pending?.headers)
    const headers = headerNames.length > 0 ? Object.fromEntries(headerNames.map((n) => [n, ''])) : undefined

    const existing = this.#api.get(key)
    if (existing) {
      if (status !== undefined && existing.status === undefined) existing.status = status
      if (contentType && !existing.contentType) existing.contentType = contentType
      if (headers) existing.headers = { ...(existing.headers ?? {}), ...headers }
      return
    }
    if (this.#api.size >= this.#maxApi) return
    const call: CapturedApiCall = {
      method,
      url: path,
      ...(headers ? { headers } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(contentType ? { contentType } : {}),
    }
    this.#api.set(key, call)
  }

  /** True when a captured url is on the recorded page's own site (same base domain), the internal-API test. */
  #sameSite(url: string): boolean {
    const host = hostOf(url)
    if (!host || !this.#host) return false
    return sameRecordingSite(host, this.#host)
  }

  /** Assemble the recording. Empty collections are omitted so the drafter sees only what was actually captured. */
  toRecording(): SessionRecording {
    const apiCalls = [...this.#api.values()]
    const recording: SessionRecording = {
      url: this.#url,
      host: this.#host || hostOf(this.#url),
    }
    if (apiCalls.length > 0) recording.apiCalls = apiCalls
    if (this.#ui.length > 0) recording.uiSteps = [...this.#ui]
    if (this.#login) recording.loginFields = { ...this.#login }
    if (this.#keywords.length > 0) recording.keywordsSeen = [...this.#keywords]
    return recording
  }
}

/**
 * Wire a {@link SessionRecorder} to a live {@link RecordingBrowserCaller} (the CdpBrowserCaller). The recorder turns on
 * the Network domain and listens to the caller's Network events; call {@link SessionRecorder.start} to begin.
 */
export function recordSession(
  caller: RecordingBrowserCaller,
  opts: { url?: string; keywords?: string[] } = {},
): SessionRecorder {
  return new SessionRecorder({
    ...(opts.url !== undefined ? { url: opts.url } : {}),
    ...(opts.keywords !== undefined ? { keywords: opts.keywords } : {}),
    deps: {
      enableNetwork: () => caller.enableNetwork(),
      subscribe: (fn) => caller.onNetwork(fn),
    },
  })
}
