// Korean words the life store matches (ADR 0029).
import type { LibraryItem } from '@dool2/protocol'

/** Watch-type tasks: a run whose answer starts with this stays quiet (nothing to report) */
export const QUIET_MARK = '알릴 것 없음'
/** Appended to the end of an answer when the end condition came true: the task turns itself off */
export const END_MARK = '[끝]'

/** Wording that makes a task a conditional watch ("when it exceeds", "when it shows up" ...) */
export const CONDITIONAL =
  /(넘으면|넘어가면|나오면|뜨면|생기면|떨어지면|내려가면|오르면|올라가면|바뀌면|열리면|풀리면|있으면|이하면|이상이면|미만이면|초과하면)/

/** "Morning" in a one-off task text: the phone notice waits until 7 AM */
export const MORNING = /아침/

/** Library kind names as the Korean screens show them, so a Korean search word like "상품" still matches */
export const LIBRARY_LABEL_KR: Record<LibraryItem['kind'], string> = {
  note: '정리',
  link: '링크',
  product: '상품',
  place: '장소',
  file: '파일',
}
