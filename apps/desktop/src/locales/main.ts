// User-facing copy for the Electron main process (window title, tray-less app name). Korean is the reference copy
// (ADR 0029); English is complete. Code and comments stay English — only the copy values are Korean.

import type { Lang } from '@dool2/i18n'

export interface MainText {
  appName: string
}

const TEXT: Record<Lang, MainText> = {
  ko: { appName: '두리' },
  en: { appName: 'Dool2' },
}

export function mainText(lang: Lang): MainText {
  return TEXT[lang]
}
