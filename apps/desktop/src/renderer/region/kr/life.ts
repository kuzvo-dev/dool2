// Korean data values the Feed, Goals and Library screens match (ADR 0029). Not copy: these are stored values.
import type { GoalCategory } from '@dool2/protocol'

/**
 * GOAL_CATEGORIES from @dool2/protocol, copied because the window loads files without a bundler (a test checks
 * they match). Stored on users' PCs, so they stay Korean until goals get English keys.
 */
export const GOAL_CATEGORY_LIST = [
  '건강',
  '관계',
  '돈',
  '일',
  '관심사',
  '생산성',
  '기타',
] as const satisfies readonly GoalCategory[]

/** Title of the routine that posts to the feed (set by the daemon) */
export const FEED_ROUTINE_TITLE = '피드'

/** Photo marker the phone adds to a message ("[사진: file.jpg]"), including a cut-off one */
export const PHOTO_MARK_RE = /\s*\[사진:[^\]]*\]?/g
