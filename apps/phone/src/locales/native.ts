import { messages } from '@dool2/i18n'

export const nativeText = messages({
  ko: {
    scannerInstalling: 'QR 스캐너를 받는 중이에요. 잠시 뒤 다시 눌러 주세요',
    downloaded: '내려받았어요',
    savedTo: (where: string) => `${where}에 저장했어요`,
    phone: '폰',
    shareInstead: '이 폰에서는 바로 저장이 안 돼서 보내기 창을 띄웠어요',
    saveFailed: '저장하지 못했어요',
    saveFailedWith: (why: string) => `저장하지 못했어요: ${why}`,
    shareFailedWith: (why: string) => `보내지 못했어요: ${why}`,
    updateApp: '새 앱으로 바꿔 주세요',
  },
  en: {
    scannerInstalling: 'Getting the QR scanner. Tap again in a moment.',
    downloaded: 'Downloaded',
    savedTo: (where: string) => `Saved to ${where}`,
    phone: 'your phone',
    shareInstead: "This phone can't save it directly, so the share sheet opened instead",
    saveFailed: "Couldn't save it",
    saveFailedWith: (why: string) => `Couldn't save it: ${why}`,
    shareFailedWith: (why: string) => `Couldn't send it: ${why}`,
    updateApp: 'Please update the app',
  },
})
