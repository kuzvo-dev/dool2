// Korean copy for the phone approval card (the reference copy, ADR 0029). User-facing strings live here, not inline
// in code. The card answers three questions in plain words: 무엇을 (what), 어디서 (where), 얼마 (how much).

import type { CardCopy } from './types.js'

export const ko: CardCopy = {
  title: {
    pay: '결제 승인',
    contact: '보내기 승인',
    delete: '삭제 승인',
    act: '동작 승인',
    read: '확인',
  },
  tier: {
    pay: '결제',
    contact: '보내기',
    delete: '삭제',
    act: '동작',
    read: '읽기',
  },
  field: {
    what: '무엇을',
    where: '어디서',
    amount: '얼마',
  },
  approve: '승인',
  deny: '거절',
  amount: (won: number) => `${won.toLocaleString('ko-KR')}원`,
}
