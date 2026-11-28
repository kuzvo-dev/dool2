// Korean role words for Dool2's PC-app snapshots on Windows (ADR 0029). The helper writes actionable UI Automation
// elements as `[e12 버튼 "저장"]`, exactly the same marks @dool2/hands-mac emits for the macOS accessibility tree and
// @dool2/browser emits for a web page — so the daemon parses either helper with one regex. They live here as data and
// are read by English code in ../roles.ts; this keeps the role vocabulary consistent across mac, Windows and the web.
export interface PcRoleWords {
  button: string
  /** Plain text / number / multi-line edit field. */
  input: string
  search: string
  password: string
  checkbox: string
  radio: string
  switch: string
  tab: string
  menu: string
  link: string
  /** A dropdown / combo box that picks one value. */
  select: string
  /** A list / table / tree row or cell. */
  item: string
}

// Same words as @dool2/hands-mac's roleName() and @dool2/browser's SNAP_ROLE_WORDS, so a user (and Dool2) reads the
// same vocabulary whether the thing on screen is a native Windows control, a macOS control, or a web element.
export const PC_ROLE_WORDS: PcRoleWords = {
  button: '버튼',
  input: '입력칸',
  search: '검색칸',
  password: '비밀번호칸',
  checkbox: '체크박스',
  radio: '라디오',
  switch: '스위치',
  tab: '탭',
  menu: '메뉴',
  link: '링크',
  select: '선택 상자',
  item: '항목',
}

// Short Korean phrases the snapshot appends to an element line, mirroring @dool2/hands-mac.
export const PC_SNAPSHOT_WORDS = {
  on: '켜짐',
  off: '꺼짐',
  disabled: '(못 누름)',
  noName: '이름 없음',
  /** Position hint for a nameless icon button: `창 왼쪽에서 40% 위에서 70%`. */
  position: (xPercent: number, yPercent: number): string => `창 왼쪽에서 ${xPercent}% 위에서 ${yPercent}%`,
  value: (v: string): string => `값: "${v}"`,
  image: (name: string): string => `(그림: ${name})`,
  /** Header prefix for a window other than the front one. */
  otherWindow: (title: string): string => `## (다른 창) ${title}`,
} as const
