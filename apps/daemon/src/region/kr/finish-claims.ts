// Korean patterns for the code-level false-completion check (ADR 0027, finish-check.ts claimsDone)

/** Verbs for an action that changes something outside: book, apply, send, order, pay, buy, submit, register, cancel */
const ACT_KR = '(?:예약|예매|신청|접수|주문|결제|구매|발송|전송|송금|이체|등록|제출|취소|해지)'

/**
 * A sentence that says Dool2 did it: "예약했어요", "주문해 뒀어요", "신청을 마쳤어요", "결제 완료했어요",
 * "보냈어요", "예약이 완료됐어요". Past tense at the end of a clause only, so "예약할게요" or "주문했던 내역" do not count
 */
export const CLAIM_KR = new RegExp(
  [
    `${ACT_KR}\\s*(?:을|를|도)?\\s*(?:했|해\\s*(?:뒀|두었|드렸|놨|놓았)|마쳤|끝냈|완료(?:했|됐|되었))(?:어요|습니다|어|다)`,
    `${ACT_KR}\\s*(?:이|가|은|는)?\\s*(?:완료|접수|처리)\\s*(?:됐|되었)(?:어요|습니다|어|다)`,
    '(?:보냈|부쳤|걸어\\s*(?:뒀|두었))(?:어요|습니다|어|다)',
    // "넣었어요" alone is also "I put it in the dining group" (a card summary was sent back for it, test PC 11-27):
    // only an application, order or booking put in counts
    `${ACT_KR}(?:서)?\\s*(?:을|를)?\\s*넣었(?:어요|습니다|어|다)`,
  ].join('|'),
)

/** "안 했어요", "못 보냈어요", "하지 않았어요": the clause is a denial, not a claim */
export const DENIAL_KR = /(?:안|못)\s*$|(?:지|진)\s*(?:않|못)/

/** Words on a page that shows a finished action (order, booking, application, payment) */
export const DONE_PAGE_KR =
  /(?:주문|예약|예매|신청|접수|결제|구매|발송|전송|등록|제출|취소)\s*(?:이|가)?\s*(?:완료|성공|되었|됐)|완료\s*되었습니다|정상\s*(?:처리|접수)/
