// Learn-by-watching, wired into the daemon (ADR 0046, the self-growing skill library).
//
// @dool2/skill-learn drafts a SKILL.md from a SessionRecording, but nothing produced one. This closes that: a
// SessionRecorder (@dool2/browser) captures a turn's internal API calls + the UI steps that worked + the login-field
// refs the vault located + the user's keywords, and on completion this controller folds the recording into a LOCAL
// draft — draftSkill for a new site, mergeIntoSkill for a site already seen — marked `needsReview` and kept in an
// in-memory store the desktop can review. Nothing is auto-published; distribution still goes through the maintainer
// who signs a pack (@dool2/packs). Secrets never reach a draft: the recorder stores no secret, and the drafter redacts.

import type { SessionRecorder } from '@dool2/browser'
import {
  baseDomain,
  type CoverageStats,
  coverageStats,
  type DraftedSkill,
  draftSkill,
  mergeIntoSkill,
  type RecordedLoginFields,
  type SessionRecording,
  toCoverageSkill,
  type UiStep,
} from '@dool2/skill-learn'

/** The acting-bridge sink the daemon's page/vault wrappers call during a turn, routed to the active recorder. */
export interface RecorderSink {
  /** The engine performed a UI step (goto/click/type). The typed value is NEVER passed — only the field ref/label. */
  addUiStep(step: UiStep): void
  /** The active tab navigated; keeps the data-path filter on the right host. */
  noteUrl(url: string): void
  /** The vault located login fields (page refs only, never a secret). */
  noteLoginFields(fields: RecordedLoginFields): void
}

/** One local, review-pending draft for a site, grown over one or more turns. */
export interface LocalDraft {
  /** Skill id (directory name). */
  id: string
  /** The base domain this draft covers (e.g. `coupang.com`). */
  host: string
  /** The drafted skill; `needsReview` is always true. */
  skill: DraftedSkill
  /** Unix ms of the last fold. */
  updatedAt: number
  /** How many recordings have been folded into this draft. */
  turns: number
}

/** The learn snapshot the desktop/dashboard reads: the drafts and the coverage KPIs. */
export interface LearnSnapshot {
  drafts: LocalDraft[]
  coverage: CoverageStats
}

/** True when a recording carries anything worth drafting (an API call or a UI step). */
export function recordingHasContent(recording: SessionRecording): boolean {
  return (recording.apiCalls?.length ?? 0) > 0 || (recording.uiSteps?.length ?? 0) > 0
}

/**
 * The local, in-memory store of review-pending drafts, keyed by base domain. A new site is drafted fresh; a site seen
 * before is merged into (so the same site gets faster/richer over time without duplicating). `coverage()` is the
 * dashboard signal: of the sites visited, how many a draft now covers, and what share of drafts carry a data path.
 */
export class LocalDraftStore {
  readonly #byHost = new Map<string, LocalDraft>()
  readonly #visited = new Set<string>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /**
   * Fold one recording into the drafts. Drafts a new skill for a site not seen before, or merges into the existing
   * draft for a site already seen. Returns the updated draft and whether it merged.
   */
  learn(recording: SessionRecording): { draft: LocalDraft; merged: boolean } {
    const host = baseDomain(recording.host)
    this.#visited.add(host)
    const existing = this.#byHost.get(host)
    const drafted = existing ? mergeIntoSkill(existing.skill.markdown, recording) : draftSkill(recording)
    const draft: LocalDraft = {
      id: drafted.id,
      host,
      skill: drafted,
      updatedAt: this.#now(),
      turns: (existing?.turns ?? 0) + 1,
    }
    this.#byHost.set(host, draft)
    return { draft, merged: Boolean(existing) }
  }

  /** Note a site was visited even if no draft formed (keeps the coverage denominator honest). */
  noteVisited(host: string): void {
    const base = baseDomain(host)
    if (base) this.#visited.add(base)
  }

  /** Every local draft, in first-seen order. */
  list(): LocalDraft[] {
    return [...this.#byHost.values()]
  }

  /** The draft covering a site, if any. */
  get(host: string): LocalDraft | undefined {
    return this.#byHost.get(baseDomain(host))
  }

  /** The dashboard KPIs: coverage of visited sites and the click-free (data-path) ratio across drafts. */
  coverage(): CoverageStats {
    const skills = this.list().map((d) => toCoverageSkill(d.skill))
    return coverageStats(skills, [...this.#visited])
  }

  /** The drafts + coverage, for the desktop/dashboard. */
  snapshot(): LearnSnapshot {
    return { drafts: this.list(), coverage: this.coverage() }
  }
}

/** Dependencies for {@link LearnController}. */
export interface LearnDeps {
  /** Make a recorder bound to the live browser for a turn. Unset → recording is off (fake browser / unit tests). */
  newRecorder?: (opts: { url?: string; keywords?: string[] }) => SessionRecorder
  /** The draft store to fold into. Defaults to a fresh in-memory one. */
  store?: LocalDraftStore
  /** Clock for the store's timestamps (tests pass a fake). */
  now?: () => number
}

/**
 * Owns the per-turn recorder lifecycle and the draft store, and is the {@link RecorderSink} the daemon's page/vault
 * wrappers push into. `begin()` starts a recorder for a turn (when on), the sink methods route acting steps to it, and
 * `end()` stops it and folds its recording into a review-pending local draft.
 */
export class LearnController implements RecorderSink {
  readonly store: LocalDraftStore
  #new: LearnDeps['newRecorder']
  #active: SessionRecorder | undefined

  constructor(deps: LearnDeps = {}) {
    this.store = deps.store ?? new LocalDraftStore(deps.now)
    this.#new = deps.newRecorder
  }

  /** Whether recording is wired (a recorder factory is set — i.e. the built-in browser is on). */
  get enabled(): boolean {
    return Boolean(this.#new)
  }

  /** Set (or replace) the recorder factory. Used to break the build order: bridges supply it after construction. */
  setFactory(newRecorder: LearnDeps['newRecorder']): void {
    this.#new = newRecorder
  }

  /** Begin recording a turn. Returns the started recorder, or undefined when recording is off. */
  async begin(message: string, url?: string): Promise<SessionRecorder | undefined> {
    if (!this.#new) return undefined
    const keywords = keywordsFromMessage(message)
    const recorder = this.#new({
      ...(url !== undefined ? { url } : {}),
      ...(keywords.length > 0 ? { keywords } : {}),
    })
    this.#active = recorder
    await recorder.start()
    return recorder
  }

  addUiStep(step: UiStep): void {
    this.#active?.addUiStep(step)
  }

  noteUrl(url: string): void {
    this.#active?.noteUrl(url)
  }

  noteLoginFields(fields: RecordedLoginFields): void {
    this.#active?.setLoginFields(fields)
  }

  /**
   * Finish the turn: stop the recorder and fold its recording into the drafts. Returns the draft outcome, or undefined
   * when recording was off or the turn captured nothing worth keeping.
   */
  end(recorder: SessionRecorder | undefined): { draft: LocalDraft; merged: boolean } | undefined {
    this.#active = undefined
    if (!recorder) return undefined
    recorder.stop()
    const recording = recorder.toRecording()
    if (recording.host) this.store.noteVisited(recording.host)
    if (!recordingHasContent(recording)) return undefined
    return this.store.learn(recording)
  }
}

// English stop-words that add no keyword value. Korean particles are left to a later Korean-aware tokenizer (a locale
// concern under region/kr, ADR 0029) — code here stays English; a stray token is harmless, the drafter redacts it.
const STOP_WORDS = new Set(['the', 'a', 'an', 'to', 'for', 'please', 'and'])

/**
 * Pull a few keywords out of the user's message for the draft's autoInject. Heuristic and small: split on
 * whitespace/punctuation, drop stop-words and very short tokens, keep first-seen order, cap the count. The drafter
 * redacts these again, so a stray token never becomes a secret.
 */
export function keywordsFromMessage(message: string, max = 8): string[] {
  const out: string[] = []
  for (const raw of message.split(/[\s,.!?;:()[\]"'`/\\]+/)) {
    const w = raw.trim()
    if (w.length < 2) continue
    if (STOP_WORDS.has(w.toLowerCase())) continue
    if (!out.includes(w)) out.push(w)
    if (out.length >= max) break
  }
  return out
}
