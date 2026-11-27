// Korean names of a site's own print button (browser_click hands such a press to browser_save_pdf's print path)

/** "인쇄", "프린트", "출력", "문서출력", "증명서 출력" … and the English words */
export const PRINT_BUTTON =
  /(^|[\s"(])(인쇄|프린트|프린터|(문서|증명서|발급)?\s*출력|print(er)?)(\s*하기)?($|[\s")])/i
