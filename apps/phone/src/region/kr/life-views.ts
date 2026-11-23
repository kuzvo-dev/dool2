// Korean data for the feed, goals and library screens: goal categories (stored as Korean keys) and the feed routine's name.
import type { GoalCategory } from '@dool2/protocol'

/** Look, per goal category (the category ids are Korean words stored by the daemon) */
export const GOAL_CATEGORY_STYLE: Record<
  GoalCategory,
  { icon: 'heart' | 'mail' | 'card' | 'pc' | 'star' | 'list' | 'goal'; tone: string; emo: string }
> = {
  건강: { icon: 'heart', tone: 'rose', emo: 'health' },
  관계: { icon: 'mail', tone: 'violet', emo: 'relation' },
  돈: { icon: 'card', tone: 'mint', emo: 'money' },
  일: { icon: 'pc', tone: 'blue', emo: 'work' },
  관심사: { icon: 'star', tone: 'amber', emo: 'interest' },
  생산성: { icon: 'list', tone: 'blue', emo: 'productivity' },
  기타: { icon: 'goal', tone: 'mint', emo: 'other' },
}

/** Title of the routine that posts the daily feed (hidden from the goals list) */
export const FEED_ROUTINE_TITLE = '피드'
