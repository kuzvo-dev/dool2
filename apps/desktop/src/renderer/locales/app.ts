// All user-facing copy for the chat window (ADR 0029). Korean is the reference voice (docs/persona.md: warm,
// result-first, no jargon); English is complete. This is a `locales/` file, so Korean lives here and nowhere else
// in the app's code. lines.ts turns a daemon event into one of the `work` keys below; the renderer draws the rest.

import type { Lang } from '@dool2/i18n'

/** The compact "일하는 중" step kinds lines.ts maps tool activity to. Never raw tool JSON — one friendly phrase each. */
export type WorkKey = 'open' | 'read' | 'login' | 'fill' | 'click' | 'pdf' | 'run'

/** Copy for the "review new site-skill drafts" panel (learn-by-watching, ADR 0046). */
export interface ReviewText {
  /** Panel caption. */
  title: string
  /** One-line explanation under the caption. */
  intro: string
  /** Shown when there is no draft to review. */
  empty: string
  /** The "awaiting review" marker on every draft. */
  needsReview: string
  /** Per-draft actions. */
  approve: string
  discard: string
  /** The small live affordance shown when a draft appears during a turn. */
  nudge: string
  /** A human summary of the drafted steps: data-path shortcuts + on-screen steps. */
  learned: (endpoints: number, steps: number) => string
  /** The library coverage KPI: of the sites visited, how many a draft covers. */
  coverage: (covered: number, total: number) => string
  /** The click-free (data-path) share of drafts, as a percentage. */
  clickFree: (pct: number) => string
  /** Confirmation after approving / discarding a draft. */
  approved: (name: string) => string
  discarded: (name: string) => string
}

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
  /** The review panel toggle (header). */
  reviewShow: string
  reviewHide: string
  /** The review panel copy (learn-by-watching drafts). */
  review: ReviewText
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
  reviewShow: '새 스킬 검수',
  reviewHide: '검수 닫기',
  review: {
    title: '새 스킬 초안 검수',
    intro: '두리가 사이트를 쓰면서 배운 초안이에요. 승인하면 이 컴퓨터에서 바로 써요.',
    empty: '아직 검수할 초안이 없어요.',
    needsReview: '검수 대기',
    approve: '승인',
    discard: '버리기',
    nudge: '새 스킬 초안이 생겼어요 — 검수하기',
    learned: (endpoints, steps) =>
      endpoints > 0
        ? `바로 통로 ${endpoints}개와 화면 단계 ${steps}개를 배웠어요.`
        : `화면 단계 ${steps}개를 배웠어요.`,
    coverage: (covered, total) => `방문한 사이트 ${total}곳 중 ${covered}곳을 커버해요.`,
    clickFree: (pct) => `바로 통로 비율 ${pct}%`,
    approved: (name) => `'${name}' 초안을 승인했어요.`,
    discarded: (name) => `'${name}' 초안을 버렸어요.`,
  },
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
  reviewShow: 'Review new skills',
  reviewHide: 'Close review',
  review: {
    title: 'Review new site-skill drafts',
    intro: 'Drafts Dool2 learned while using sites. Approve one to use it on this computer right away.',
    empty: 'No drafts to review yet.',
    needsReview: 'Needs review',
    approve: 'Approve',
    discard: 'Discard',
    nudge: 'A new site-skill draft is ready — review it',
    learned: (endpoints, steps) =>
      endpoints > 0
        ? `Learned ${endpoints} click-free ${endpoints === 1 ? 'shortcut' : 'shortcuts'} and ${steps} on-screen ${steps === 1 ? 'step' : 'steps'}.`
        : `Learned ${steps} on-screen ${steps === 1 ? 'step' : 'steps'}.`,
    coverage: (covered, total) => `Covers ${covered} of ${total} sites visited.`,
    clickFree: (pct) => `Click-free ${pct}%`,
    approved: (name) => `Approved the '${name}' draft.`,
    discarded: (name) => `Discarded the '${name}' draft.`,
  },
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
