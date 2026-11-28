/**
 * @dool2/skill-learn
 *
 * The self-growing skill library. When Dool2 does a task on a site, the daemon
 * records what worked — the data path it found (internal API endpoints + the
 * headers the page sent, captured off CDP Network), the UI steps and selectors,
 * and the login fields — as a {@link SessionRecording}. This package drafts a
 * SKILL.md from that recording ({@link draftSkill}), prefers the data path and
 * redacts every secret, refines an existing skill with a later recording
 * ({@link mergeIntoSkill}), hands a batch to `@dool2/packs` for a signed,
 * maintainer-reviewed pack ({@link installablePack}), and reports the coverage
 * and click-free KPIs ({@link coverageStats}).
 *
 * Pure drafting logic: the live capture (listening to CDP Network for the
 * internal API calls and their headers on the tab Dool2 opened) is the
 * daemon/browser's job and feeds this package its {@link SessionRecording}.
 */

export type { CoverageSkill, CoverageStats } from './coverage.js'
export { coverageStats, skillHasDataPath, toCoverageSkill } from './coverage.js'
export {
  baseDomain,
  type DraftedSkill,
  type DraftOptions,
  draftSkill,
  hostGlobs,
  mergeIntoSkill,
  serializeFrontmatter,
} from './draft.js'
export { installablePack, REVIEW_NOTE, toPackFiles } from './pack.js'
export type {
  CapturedApiCall,
  RecordedLoginFields,
  SessionRecording,
  UiStep,
} from './recording.js'
export { defaultRedactor, isSessionHeaderName, type Redactor, safeHeaderNames } from './redact.js'
