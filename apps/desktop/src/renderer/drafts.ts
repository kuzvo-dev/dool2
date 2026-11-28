// The "review new site-skill drafts" surface (learn-by-watching, ADR 0046). Dool2 drafts a site skill locally while
// it works; the daemon keeps the review-pending drafts and exposes them (GET /drafts in the HTTP daemon; in the
// desktop the same data comes through the preload bridge from the in-process agentd.drafts()/coverage()). This module
// is pure and framework-free so it unit-tests in node: it maps a draft to the display strings the panel shows, folds
// the coverage KPIs into one line, and holds the small bit of panel state (open, the nudge, the current list) behind a
// client interface. renderer.ts paints whatever the controller exposes; the @dool2/agentd imports here are type-only.

import type { AgentdEvent, LearnSnapshot, LocalDraft } from '@dool2/agentd'
import type { AppText } from './locales/app.js'

/** The drafts + coverage snapshot the daemon returns (same shape as GET /drafts). */
export type DraftsSnapshot = LearnSnapshot
type CoverageStats = LearnSnapshot['coverage']

/** The empty KPI used before the first fetch and when recording is off. */
const ZERO_COVERAGE: CoverageStats = { covered: 0, total: 0, clickFreeRatio: 0 }

// A drafted body lists its data-path endpoints as `- `METHOD /path`` bullets and its UI fallback as a numbered list
// (see @dool2/skill-learn draft.ts). We only COUNT those lines for a human summary — the paths themselves are never
// shown here, and the body is already redacted upstream.
const ENDPOINT_RE = /^\s*-\s+`[A-Z]+\s+[^`]+`/
const UI_STEP_RE = /^\s*\d+\.\s+\S/

/** How many internal API endpoints (click-free shortcuts) the draft's body lists. */
export function countEndpoints(body: string): number {
  return body.split('\n').filter((line) => ENDPOINT_RE.test(line)).length
}

/** How many UI fallback steps the draft's body lists. */
export function countUiSteps(body: string): number {
  return body.split('\n').filter((line) => UI_STEP_RE.test(line)).length
}

/** One draft as the panel draws it: the stable id, the site/host, its name, a learned-steps summary, the marker. */
export interface DraftRow {
  id: string
  host: string
  name: string
  learned: string
  marker: string
}

/** Map a draft to its display row (no secrets: only counts of what it learned, never the paths). */
export function draftRow(draft: LocalDraft, t: AppText): DraftRow {
  return {
    id: draft.id,
    host: draft.host,
    name: draft.skill.frontmatter.name,
    learned: t.review.learned(countEndpoints(draft.skill.body), countUiSteps(draft.skill.body)),
    marker: t.review.needsReview,
  }
}

/** The library KPIs as one line: coverage of visited sites, then the click-free (data-path) share. */
export function coverageText(coverage: CoverageStats, t: AppText): string {
  const pct = Math.round((coverage.clickFreeRatio ?? 0) * 100)
  return `${t.review.coverage(coverage.covered, coverage.total)} · ${t.review.clickFree(pct)}`
}

/** The outcome of an approve/discard call. `wired` is false while the daemon route is a stated TODO (another PR). */
export interface DraftActionResult {
  ok: boolean
  /** Whether the daemon actually persisted the change (false = the UI updated but the daemon side is pending). */
  wired: boolean
  reason?: string
}

/** The thin client the controller talks to (the preload bridge in the app, a fake in tests). */
export interface DraftsClient {
  list(): Promise<DraftsSnapshot>
  approve(id: string): Promise<DraftActionResult>
  discard(id: string): Promise<DraftActionResult>
}

/**
 * The panel's state, kept out of the DOM so it is testable. It fetches the drafts, folds in the live `draft` turn
 * event (which raises the nudge without interrupting the chat), and approves/discards against the client — removing
 * the card optimistically so the panel stays responsive even while the daemon approve/discard route is still a TODO.
 */
export class DraftsController {
  readonly #client: DraftsClient
  drafts: LocalDraft[] = []
  coverage: CoverageStats = ZERO_COVERAGE
  /** Whether the panel is open. */
  open = false
  /** Whether a draft arrived while the panel was closed (shows the live nudge). */
  nudge = false

  constructor(client: DraftsClient) {
    this.#client = client
  }

  /** Number of drafts awaiting review (the badge). */
  get count(): number {
    return this.drafts.length
  }

  /** Fetch the current drafts + coverage from the daemon. */
  async refresh(): Promise<void> {
    const snapshot = await this.#client.list()
    this.drafts = snapshot.drafts
    this.coverage = snapshot.coverage ?? ZERO_COVERAGE
  }

  /**
   * Fold one turn event in. A `draft` event carries the fresh coverage and (when the panel is closed) raises the
   * nudge; every other event is ignored. Returns true when it was a draft event, so the renderer knows to repaint.
   */
  noteEvent(event: AgentdEvent): boolean {
    if (event.type !== 'draft') return false
    this.coverage = event.coverage
    if (!this.open) this.nudge = true
    return true
  }

  /** Open or close the panel. Opening clears the nudge and refetches so the list is current. */
  async setOpen(on: boolean): Promise<void> {
    this.open = on
    if (on) {
      this.nudge = false
      await this.refresh()
    }
  }

  /** Approve a draft: it becomes an active local skill. Removes the card optimistically. */
  async approve(id: string): Promise<DraftActionResult> {
    const result = await this.#client.approve(id)
    this.drafts = this.drafts.filter((draft) => draft.id !== id)
    return result
  }

  /** Discard a draft. Removes the card optimistically. */
  async discard(id: string): Promise<DraftActionResult> {
    const result = await this.#client.discard(id)
    this.drafts = this.drafts.filter((draft) => draft.id !== id)
    return result
  }
}
