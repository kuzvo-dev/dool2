// Payment method copy. Korean is the reference and English must have the same keys (ADR 0029)
import { messages } from '@dool2/i18n'

export const payMethodsCopy = messages({
  ko: {
    /** Shown on the phone when the list cannot be saved */
    tooMany: (max: number) => `결제 수단은 ${max}개까지 등록할 수 있어요`,
    /** Menu path on the phone, quoted to the user as is */
    settingsPath: '폰 설정 > 내 정보 · 결제 > 결제 수단',
    shortPath: '폰 설정 > 결제 수단',
  },
  en: {
    tooMany: (max: number) => `You can add up to ${max} payment methods`,
    settingsPath: 'phone Settings > My info · Payment > Payment methods',
    shortPath: 'phone Settings > Payment methods',
  },
})
