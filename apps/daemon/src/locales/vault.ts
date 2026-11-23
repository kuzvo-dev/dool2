// Vault copy shown to people (errors when saving a login). Korean is the reference (ADR 0029)
import { messages } from '@dool2/i18n'

export const vaultCopy = messages({
  ko: {
    badUrl: '사이트 주소가 올바르지 않아요',
    httpsOnly: 'https로 시작하는 사이트만 저장할 수 있어요',
  },
  en: {
    badUrl: 'That site address is not valid',
    httpsOnly: 'Only sites that start with https can be saved',
  },
})
