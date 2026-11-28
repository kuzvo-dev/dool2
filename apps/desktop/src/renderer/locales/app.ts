// All user-facing copy for the chat window (ADR 0029). Korean is the reference voice (docs/persona.md: warm,
// result-first, no jargon); English is complete. This is a `locales/` file, so Korean lives here and nowhere else
// in the app's code. lines.ts turns a daemon event into one of the `work` keys below; the renderer draws the rest.

import type { Lang } from '@dool2/i18n'

/** The compact "일하는 중" step kinds lines.ts maps tool activity to. Never raw tool JSON — one friendly phrase each. */
export type WorkKey = 'open' | 'read' | 'login' | 'fill' | 'click' | 'pdf' | 'run'

export interface AppText {
  /** Header + empty state. */
  title: string
  tagline: string
  emptyGreeting: string
  emptyHint: string
  /** Chat input. */
  placeholder: string
  send: string
  working: string
  /** The three autonomy levels (ADR 0047), in order. */
  levelLabel: string
  levels: { ask: string; auto: string; full: string }
  /** The browser pane. */
  browserShow: string
  browserHide: string
  browserIdle: string
  browserLive: string
  /** Approval card (phone-signed; this screen only shows what needs signing). */
  approvalTitle: string
  approvalHint: string
  amount: (krw: number) => string
  blocked: (label: string) => string
  /** The compact work-step phrases, keyed by WorkKey. */
  work: Record<WorkKey, string>
}

const KO: AppText = {
  title: '두리',
  tagline: '이 컴퓨터에 사는 AI',
  emptyGreeting: '안녕하세요, 저는 두리예요.',
  emptyHint: '예약, 주문, 자잘한 일을 대신 해 드려요. 돈 쓰는 일은 꼭 먼저 물어볼게요. 뭐부터 해 볼까요?',
  placeholder: '두리에게 말해 보세요',
  send: '보내기',
  working: '일하는 중이에요…',
  levelLabel: '맡기는 정도',
  levels: { ask: '허락받기', auto: '자동', full: '완전 자동' },
  browserShow: '두리 브라우저 보기',
  browserHide: '브라우저 닫기',
  browserIdle: '두리가 아직 브라우저에서 작업하고 있지 않아요.',
  browserLive: '두리가 지금 보고 있는 화면이에요.',
  approvalTitle: '폰에서 승인해 주세요',
  approvalHint: '돈 쓰는 일이라 폰에서 한 번 확인이 필요해요.',
  amount: (krw) => `${krw.toLocaleString('ko-KR')}원`,
  blocked: (label) => `"${label}"은(는) 지금은 할 수 없어요.`,
  work: {
    open: '페이지를 여는 중이에요',
    read: '페이지를 읽었어요',
    login: '저장해 둔 정보로 로그인했어요',
    fill: '내용을 입력했어요',
    click: '버튼을 눌렀어요',
    pdf: 'PDF로 저장했어요',
    run: '화면에서 작업하고 있어요',
  },
}

const EN: AppText = {
  title: 'Dool2',
  tagline: 'An AI that lives on your computer',
  emptyGreeting: "Hi, I'm Dool2.",
  emptyHint:
    "I handle bookings, orders and little errands for you. I'll always ask first before spending money. Where shall we start?",
  placeholder: 'Talk to Dool2',
  send: 'Send',
  working: 'Working on it…',
  levelLabel: 'How much to leave to me',
  levels: { ask: 'Ask first', auto: 'Auto', full: 'Full auto' },
  browserShow: "Watch Dool2's browser",
  browserHide: 'Close browser',
  browserIdle: "Dool2 isn't working in the browser yet.",
  browserLive: 'This is what Dool2 is looking at right now.',
  approvalTitle: 'Please approve on your phone',
  approvalHint: 'This spends money, so it needs one confirmation on your phone.',
  amount: (krw) => `₩${krw.toLocaleString('en-US')}`,
  blocked: (label) => `"${label}" can't be done right now.`,
  work: {
    open: 'Opening the page',
    read: 'Read the page',
    login: 'Signed in with saved details',
    fill: 'Filled in the details',
    click: 'Pressed a button',
    pdf: 'Saved as PDF',
    run: 'Working on the screen',
  },
}

const TEXT: Record<Lang, AppText> = { ko: KO, en: EN }

export function appText(lang: Lang): AppText {
  return TEXT[lang]
}
