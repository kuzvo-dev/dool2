// Where the person changes the AI and the pay-as-you-go API key, quoted to them as is. Korean is the reference (ADR 0029)
import { messages } from '@dool2/i18n'

export const aiAccountCopy = messages({
  ko: {
    /** Menu path on the PC app (apps/desktop/src/renderer/locales/setup.ts: settingsTitle → tabAi) */
    settingsPath: 'PC 앱 설정 > AI · 브라우저',
    /** Button next to the API key row there (changeKey) */
    changeButton: '바꾸기',
    /** Shown on the PC or phone screen when the AI picked there is not connected (yet) */
    notConnected: '아직 연결되지 않은 AI예요. 먼저 연결해 주세요.',
  },
  en: {
    settingsPath: 'PC app Settings > AI · Browser',
    changeButton: 'Change',
    notConnected: "That AI isn't connected yet. Connect it first.",
  },
})
