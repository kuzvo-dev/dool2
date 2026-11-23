// Korean data the profile (my info) code matches or stores: plate format, sex values, carrier and app names
export const SEX_OPTIONS = ['남', '여'] as const
export const SEX_EXAMPLE = '남'
export const AUTH_APP_EXAMPLE = '카카오톡'
export const CAR_NO_EXAMPLE = '12가 3456'
/** Korean plate: 12가 3456 */
export const CAR_NO_PATTERN = '^(\\d{2,3})\\s?[가-힣]\\s?\\d{4}$'
export const CAR_NO_RE = /^(\d{2,3})\s?([가-힣])\s?(\d{4})$/

/** "남", "m" -> 남 / "여", "f", "w" -> 여 */
export function normalizeSex(s: string): string | undefined {
  return /^(남|m)/i.test(s) ? '남' : /^(여|f|w)/i.test(s) ? '여' : undefined
}

/** "lg", "유플러스", "skt 알뜰" -> a name from the carrier list */
export function normalizeCarrier(s: string): string | undefined {
  const k = s.replace(/\s/g, '').toLowerCase()
  const mvno = /알뜰|mvno/.test(k)
  const net = /lg|유플|u\+/.test(k)
    ? 'LG U+'
    : /kt|케이티/.test(k) && !/skt/.test(k)
      ? 'KT'
      : /sk|에스케이/.test(k)
        ? 'SKT'
        : ''
  if (!net) return undefined
  return mvno ? `${net} 알뜰폰` : net
}
