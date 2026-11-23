// Text the conversation records show people: approval card titles, the hand-off reason, and the "working on"
// lines of the work card. Korean is the reference copy and English must have the same keys (ADR 0029).
import type { Lang } from '@dool2/i18n'

export interface ThreadText {
  /** Hand-off card reason when the AI gave none */
  handoffReason: string
  /** Payment card title when there is no title or product name */
  payment: string
  /** Approval card for letting Dool2 control a PC app, with the AI's reason when given */
  appControl: (why?: string) => string
  fileMove: (n: number) => string
  filePrint: (name: string) => string
  fileRestore: (n: number) => string
  fileDownload: string
  pcLock: string
  pcSleep: string
  /** Work line for a tool without a service title, from the tool label */
  toolAct: (label: string) => string
  /**
   * Work line for a service tool from its title, without the trailing "in progress" word the screens add
   * themselves ("극장 찾기", "상영 중인 영화 보는")
   */
  serviceBare: (title: string) => string
  /** The full work line for a service tool ("극장 찾기 중") */
  serviceAct: (bare: string) => string
  /** Removes what `serviceAct` added, for screens that add it themselves */
  stripAct: (act: string) => string
}

const ko: ThreadText = {
  handoffReason: '직접 해 주실 일이 있어요',
  payment: '결제',
  appControl: (why) => `앱 조작 허용${why ? `: ${why}` : ''}`,
  fileMove: (n) => `파일 ${n}개 옮기기`,
  filePrint: (name) => `"${name}" 출력`,
  fileRestore: (n) => `휴지통에서 ${n}개 되살리기`,
  fileDownload: '실행 파일 받기',
  pcLock: '이 PC 화면 잠그기',
  pcSleep: '이 PC 잠자기',
  toolAct: (label) => `${label} 중`,
  // Action names (찾기·확인·조회·준비) take "… 중", and names of things to look at (상영 중인 영화·상영 시간) "… 보는 중"
  serviceBare: (title) => (/(기|인|회|비|약|청|문|소|색|산)$/.test(title) ? title : `${title} 보는`),
  serviceAct: (bare) => `${bare} 중`,
  stripAct: (act) => act.replace(/ 중$/, ''),
}

const en: ThreadText = {
  handoffReason: 'There is something for you to do',
  payment: 'Payment',
  appControl: (why) => `Let Dool2 use an app${why ? `: ${why}` : ''}`,
  fileMove: (n) => `Move ${n} files`,
  filePrint: (name) => `Print "${name}"`,
  fileRestore: (n) => `Restore ${n} items from the Trash`,
  fileDownload: 'Download a program',
  pcLock: 'Lock this PC',
  pcSleep: 'Put this PC to sleep',
  toolAct: (label) => `${label}…`,
  serviceBare: (title) => title,
  serviceAct: (bare) => `${bare}…`,
  stripAct: (act) => act.replace(/…$/, ''),
}

export const THREAD_TEXT: Record<Lang, ThreadText> = { ko, en }
