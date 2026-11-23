// 두리의 생활 기록(피드·보관함·목표)에 사람이 보는 문구. 한국어가 기준이다 (ADR 0029)
import { messages } from '@dool2/i18n'

export const lifeText = messages({
  ko: {
    unnamedGoal: '이름 없는 목표',
    goalMade: '목표를 세웠어요',
    scheduled: '예약했어요',
    savedToLibrary: '보관함에 남겼어요',
    todayNews: '오늘의 소식',
    suggestFallback: '두리가 먼저 챙겼어요',
    feedRoutine: '피드',
    savedNote: '남긴 글',
    noTitle: '제목 없음',
    postFallback: '두리 소식',
  },
  en: {
    unnamedGoal: 'Untitled goal',
    goalMade: 'Goal set',
    scheduled: 'Scheduled',
    savedToLibrary: 'Saved to your library',
    todayNews: "Today's news",
    suggestFallback: 'Dool2 looked ahead for you',
    feedRoutine: 'Feed',
    savedNote: 'Saved note',
    noTitle: 'No title',
    postFallback: 'News from Dool2',
  },
})

/** Titles the daily feed task has had in any language (a language switch must still replace it) */
export const FEED_ROUTINE_TITLES = ['피드', 'Feed']
