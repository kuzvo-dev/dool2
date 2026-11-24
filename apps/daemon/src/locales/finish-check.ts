// Text people see from the finish check: the first line of the "continue" note (the rest of the note is for the AI) (ADR 0029)
// claimWhy / claimNext: the code check caught an answer saying something was done with nothing behind it (shown as the
// step "continuing: …" while Dool2 checks)
export const FINISH_CHECK_TEXT = {
  ko: {
    again: '끝내기 전에 다시 보니 남은 게 있어서 이어서 할게요.',
    claimWhy: '했다고 답했지만 실제로 된 기록이 없어요.',
    claimNext: '정말 됐는지 결과 화면에서 확인하기',
  },
  en: {
    again: 'I checked again before finishing and something is left, so I will keep going.',
    claimWhy: 'The answer says it was done, but there is no record that it happened.',
    claimNext: 'check on the result page that it really went through',
  },
} as const
