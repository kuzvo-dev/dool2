/**
 * @dool2/hands-win
 *
 * Dool2's PC screen-control helper for Windows — the counterpart of @dool2/hands-mac. It reads and acts on native
 * desktop apps through UI Automation (UIA): list apps, snapshot an app's element tree as `[eN role "name"]` marks,
 * click, type, press keys, and capture a window. It speaks the exact same line-delimited JSON protocol as the macOS
 * helper, so the daemon drives either one with a single adapter.
 *
 * Safety that lives in the helper itself (not just the daemon): browsers, password managers and Dool2 are never driven;
 * a password/secure field's value is never read or emitted and `type` refuses it; destructive key combos are refused.
 *
 * The native UIA work sits behind the {@link UiaBackend} seam (backend.ts); {@link InMemoryUiaBackend} is a full fake
 * for tests and the offline smoke. Everything else here is platform-independent protocol + safety logic.
 */
export type {
  UiaApp,
  UiaBackend,
  UiaElement,
  UiaInstalledApp,
  UiaShot,
  UiaStatus,
  UiaWindow,
} from './backend.js'
export type { CommandArgs } from './hands.js'
export { Hands } from './hands.js'
export {
  type FakeApp,
  InMemoryUiaBackend,
  makeFakeUiaBackend,
  type RecordedActions,
  uiaEl,
} from './in-memory-backend.js'
export type { PcRoleWords } from './locales/roles.js'
export { PC_ROLE_WORDS, PC_SNAPSHOT_WORDS } from './locales/roles.js'
export type { HandsRequest, HandsResponse } from './protocol.js'
export { dispatch, runLoop } from './protocol.js'
export { isContainer, isStaticText, isTextField, isToggle, roleWord } from './roles.js'
export {
  checkAllowed,
  destructiveReason,
  fail,
  HARD_BLOCKED,
  HandsError,
  normalizeModifiers,
} from './safety.js'
export type { RefInfo, SnapshotResult } from './snapshot.js'
export { buildSnapshot } from './snapshot.js'
