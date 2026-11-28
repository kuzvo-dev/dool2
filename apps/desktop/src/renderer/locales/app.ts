// All user-facing chrome copy for the chat window (ADR 0029). Korean is the reference voice (docs/persona.md: warm,
// result-first, no jargon); English is complete. This is a `locales/` file, so Korean lives here and nowhere else in
// the app's code. The design mock copy (docs/design/screens/src/PC.dc.html) is matched exactly where the screen shows
// it. Demo thread/task content is seed data and lives in locales/seed.ts; lines.ts maps daemon events to `work` keys.

import type { Lang } from '@dool2/i18n'

/** The compact "일하는 중" step kinds lines.ts maps tool activity to. Never raw tool JSON — one friendly phrase each. */
export type WorkKey = 'open' | 'read' | 'login' | 'fill' | 'click' | 'pdf' | 'run'

/** The four left-nav tabs (design mock order). */
export type Tab = 'talk' | 'tasks' | 'explore' | 'me'

/** Copy for the "review new site-skill drafts" panel (learn-by-watching, ADR 0046), folded under 나의 두리. */
export interface ReviewText {
  title: string
  intro: string
  empty: string
  needsReview: string
  approve: string
  discard: string
  nudge: string
  learned: (endpoints: number, steps: number) => string
  coverage: (covered: number, total: number) => string
  clickFree: (pct: number) => string
  approved: (name: string) => string
  discarded: (name: string) => string
}

export interface AppText {
  /** Brand + nav. */
  brandSmall: string
  navLabel: string
  tabs: Record<Tab, string>
  nowHead: string
  /** Header. */
  doori: string
  headStatus: string
  search: string
  /** Composer. */
  placeholder: string
  voice: string
  attachAria: string
  voiceAria: string
  composerNote: string
  /** Right pane (두리의 화면). */
  screenTitle: string
  takeOver: string
  stop: string
  screenTag: string
  beforePay: string
  nextUp: string
  awaitingApproval: string
  localFoot: string
  /** Day separators + empty states. */
  dayToday: string
  dayYesterday: string
  comingSoon: string
  comingHint: string
  /** 나의 두리: autonomy level (ADR 0047). */
  meTitle: string
  levelLabel: string
  levelSub: string
  levels: Record<'ask' | 'auto' | 'full', { name: string; desc: string }>
  /** The review panel (folded under 나의 두리). */
  review: ReviewText
  /** The "폰 연결" pairing screen (ADR 0047): pair a phone to approve payments/sends. */
  pair: {
    title: string
    intro: string
    codeLabel: string
    scanHint: string
    /** Scan hint for the second QR, read by the already-installed phone app (v1-compat pairing). */
    legacyScanHint: string
    waiting: string
    connected: string
    hint: string
  }
  /** Approval card shown inline in the chat (phone-signed; this screen only shows what needs signing). */
  approvalTitle: string
  approvalHint: string
  amount: (krw: number) => string
  blocked: (label: string) => string
  /** The compact work-step phrases, keyed by WorkKey. */
  work: Record<WorkKey, string>
}

const KO: AppText = {
  brandSmall: '두리',
  navLabel: '주요 메뉴',
  tabs: { talk: '대화', tasks: '맡긴 일', explore: '둘러보기', me: '나의 두리' },
  nowHead: '지금',
  doori: '두리',
  headStatus: '우리 집 MacBook에서 일하는 중',
  search: '대화에서 찾기',
  placeholder: '두리에게 부탁하기 · 돈 드는 일은 먼저 물어봐요',
  voice: '말하기',
  attachAria: '첨부',
  voiceAria: '말로 부탁하기',
  composerNote: '돈 드는 일과 누군가에게 보내는 일은 꼭 먼저 물어봐요',
  screenTitle: '두리의 화면',
  takeOver: '내가 할게요',
  stop: '멈추기',
  screenTag: '두리 화면',
  beforePay: '결제 전엔 물어볼게요',
  nextUp: '다음 차례',
  awaitingApproval: '승인 대기',
  localFoot: '이 화면은 우리 집 컴퓨터에서 바로 보내요. 두리 서버엔 남지 않아요.',
  dayToday: '오늘',
  dayYesterday: '어제',
  comingSoon: '곧 들어와요',
  comingHint: '두리가 맡은 일이 생기면 여기에 모아 보여드릴게요.',
  meTitle: '나의 두리',
  levelLabel: '맡기는 정도',
  levelSub: '두리가 어디까지 스스로 해도 될지 정해요. 돈 쓰는 일은 늘 먼저 물어봐요.',
  levels: {
    ask: { name: '허락받기', desc: '일마다 먼저 물어보고 나서 해요.' },
    auto: { name: '자동', desc: '웬만한 일은 알아서 하고, 돈 드는 일만 물어봐요.' },
    full: { name: '완전 자동', desc: '정해 둔 한도 안에서 끝까지 알아서 해요. 폰 승인이 필요해요.' },
  },
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
  pair: {
    title: '폰 연결',
    intro: '폰에서 결제와 보내기를 승인할 수 있어요. 폰 카메라로 QR을 찍어 연결해요.',
    codeLabel: '연결 코드',
    scanHint: '폰 카메라로 QR을 찍으면 바로 연결돼요. 안 되면 아래 코드를 넣어요.',
    legacyScanHint: '이미 설치한 두리 앱은 이 QR을 찍어 연결해요.',
    waiting: '폰 연결을 기다리고 있어요',
    connected: '폰이 연결됐어요',
    hint: '코드는 이 컴퓨터에서만 보여요. 폰은 공개 키만 보내고, 서명 키는 폰에만 남아요.',
  },
  approvalTitle: '폰에서 승인해 주세요',
  approvalHint: '돈 쓰는 일이라 폰에서 한 번 확인이 필요해요.',
  amount: (krw) => `₩${krw.toLocaleString('ko-KR')}`,
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
  brandSmall: 'Dool2',
  navLabel: 'Main menu',
  tabs: { talk: 'Chat', tasks: 'Tasks', explore: 'Explore', me: 'My Dool2' },
  nowHead: 'Now',
  doori: 'Dool2',
  headStatus: 'Working on your MacBook',
  search: 'Search the chat',
  placeholder: "Ask Dool2 · I'll check first before anything that costs money",
  voice: 'Speak',
  attachAria: 'Attach',
  voiceAria: 'Ask by voice',
  composerNote: 'Dool2 always asks first before spending money or sending anything to anyone',
  screenTitle: "Dool2's screen",
  takeOver: "I'll take over",
  stop: 'Stop',
  screenTag: "Dool2's view",
  beforePay: "I'll ask before paying",
  nextUp: 'Up next',
  awaitingApproval: 'Needs approval',
  localFoot: "This screen comes straight from your computer. Nothing is kept on Dool2's servers.",
  dayToday: 'Today',
  dayYesterday: 'Yesterday',
  comingSoon: 'Coming soon',
  comingHint: "When Dool2 takes on tasks, you'll see them gathered here.",
  meTitle: 'My Dool2',
  levelLabel: 'How much to leave to Dool2',
  levelSub: 'Decide how far Dool2 may go on its own. It always asks first before spending money.',
  levels: {
    ask: { name: 'Ask first', desc: 'Checks with you before each task.' },
    auto: { name: 'Auto', desc: 'Handles the everyday things, asks only when money is involved.' },
    full: { name: 'Full auto', desc: 'Finishes on its own within a set limit. Needs phone approval.' },
  },
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
  pair: {
    title: 'Connect your phone',
    intro: 'Approve payments and sends from your phone. Scan the QR with your phone camera to connect.',
    codeLabel: 'Connect code',
    scanHint: 'Scan the QR with your phone camera to connect. If that fails, enter the code below.',
    legacyScanHint: 'Already have the Dool2 app installed? Scan this QR to connect.',
    waiting: 'Waiting for a phone to connect',
    connected: 'A phone is connected',
    hint: 'The code only shows on this computer. The phone sends just its public key; its signing key stays on the phone.',
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
