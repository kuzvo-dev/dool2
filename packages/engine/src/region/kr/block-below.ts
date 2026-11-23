// Korean phrases that point "above" at a result block. Blocks show below the reply text, so these are turned into
// "below" (the AI often calls the block tool first and then writes "위").
export const ABOVE_BLOCK: [RegExp, string][] = [
  [/위(?:의)? (목록|카드|사진 카드|표|초안|글|결과|줄)/g, '아래 $1'],
  [/위에 (정리|붙|써|적|모아|올려|넣어|보여|골라)/g, '아래에 $1'],
]
