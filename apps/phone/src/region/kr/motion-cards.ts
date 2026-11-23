// Korean money and percent patterns for the number roll (won, man-won).

/** Amounts such as 12,000원, 3만 원, 15% */
export const KR_AMOUNT = /\d{1,3}(?:,\d{3})+(?:원|만 원|만원)?|\d+(?:\.\d+)?(?:원|%|만 원|만원)/g
