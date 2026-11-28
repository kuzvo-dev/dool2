// Korean role words for Dool2's page snapshots (ADR 0029). The daemon writes interactive elements as [e12 버튼 "검색"] and
// matches them with SNAP_ROLES (apps/daemon/src/region/kr/browser.ts). Dool2's own browser (cdp-caller.ts) must write the
// same words, so they live here as data and are injected into the in-page DOM-walk script, keeping that code English.
export interface SnapRoleWords {
  link: string
  button: string
  /** Plain text/number field */
  input: string
  search: string
  password: string
  checkbox: string
  radio: string
  switch: string
  tab: string
  menu: string
  option: string
  /** A <select> / listbox */
  select: string
}

export const SNAP_ROLE_WORDS: SnapRoleWords = {
  link: '링크',
  button: '버튼',
  input: '입력칸',
  search: '검색칸',
  password: '비밀번호칸',
  checkbox: '체크박스',
  radio: '라디오',
  switch: '스위치',
  tab: '탭',
  menu: '메뉴',
  option: '선택지',
  select: '선택 상자',
}
