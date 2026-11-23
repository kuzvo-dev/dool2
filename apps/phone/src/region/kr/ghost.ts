// Korean data for the ghost (continue-typing) suggestions: topic words, name filters, particles, bigram stop list.

export type Topic = 'food' | 'shop' | 'trip'

/** Words that tell what a reply is about (Korean text) */
export const TOPIC_WORDS: Record<Topic, RegExp> = {
  food: /식당|맛집|레스토랑|카페|브런치|오마카세|코스 ?요리|메뉴|기념일|디너|런치/,
  shop: /최저가|가격|상품|장바구니|배송|할인|구매|주문|쇼핑/,
  trip: /호텔|숙소|펜션|리조트|숙박|항공권|비행기|기차|KTX|SRT|여행/,
}

/** True when a bold span does not look like a name: a value, a sentence, a sentence ending, or a heading */
export function notAName(name: string, raw: string): boolean {
  if (/^[\d\s.,~%원분시개명박일:/-]+$/.test(name)) return true // value (3만 원, 19:00)
  if (/^\d/.test(name) && /[원분시개명박일]$/.test(name)) return true
  if (name.split(/\s+/).length > 3) return true // sentence
  if (/(요|다|죠|니다)$/.test(name)) return true // sentence ending
  if (/[:：]/.test(raw.trim().slice(-1))) return true // heading such as "주의:"
  return false
}

const DIGIT_BATCHIM = new Set(['0', '1', '3', '6', '7', '8']) // 영·일·삼·육·칠·팔

/** withB if the word ends in a final consonant, else withoutB (을/를, 이/가, 은/는, 과/와) */
export function josa(word: string, withB: string, withoutB: string): string {
  return hasBatchim(word) ? withB : withoutB
}

export function hasBatchim(word: string): boolean {
  const ch = word
    .trim()
    .replace(/[)\]'"”’]+$/, '')
    .slice(-1)
  if (!ch) return false
  const code = ch.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0
  if (/\d/.test(ch)) return DIGIT_BATCHIM.has(ch)
  // English names: ending in l, m or n sounds like a final consonant (Apple → 애플을 is not caught, only common cases)
  return /[lmn]/i.test(ch)
}

/** Common verb and ending pairs that are skipped as bigrams */
export const STOP = new Set([
  '알려',
  '찾아',
  '정리',
  '리해',
  '만들',
  '들어',
  '해요',
  '어요',
  '에요',
  '이에',
  '세요',
  '주세',
  '있어',
  '있는',
  '하는',
  '해서',
  '에서',
  '으로',
  '드릴',
  '릴게',
  '게요',
  '봐요',
  '까요',
  '이번',
  '지금',
])
