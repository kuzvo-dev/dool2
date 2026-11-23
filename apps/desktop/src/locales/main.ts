// Main process copy: window title, tray menu, file errors and smoke-test seed data (ADR 0029)
import { formatMoney, type Lang, messages } from '@dool2/i18n'

export const mainText = messages({
  ko: {
    appName: '두리',
    trayBusy: '두리가 일하는 중이에요',
    trayIdle: '두리가 기다리고 있어요',
    trayAwake: '일하는 동안 PC가 잠들지 않아요',
    trayOpen: '두리 열기',
    trayQuit: '두리 끝내기',
    openFileFailed: (err: string) => `파일을 열지 못했어요: ${err}`,
    secretsUnavailable: '이 컴퓨터에서는 키를 안전하게 저장할 수 없어요 (OS 키체인을 쓸 수 없음)',
    smokeNotes: 'AI 영상 클립, 더 멋있는 모션 영상, 새 버전 알림',
    smokeRole: '버튼',
    smokeLabel: '바로 구매',
    smokeReason: '"구매"',
    smokeWhat: '사과 1kg 바로 구매',
    smokeWhere: '두리 시험 가게',
    smokeCancel: '배송 전 취소 가능 (상품 페이지 안내)',
  },
  en: {
    appName: 'Dool2',
    trayBusy: 'Dool2 is working',
    trayIdle: 'Dool2 is ready',
    trayAwake: 'Your PC stays awake while Dool2 works',
    trayOpen: 'Open Dool2',
    trayQuit: 'Quit Dool2',
    openFileFailed: (err: string) => `Couldn't open the file: ${err}`,
    secretsUnavailable: "This computer can't store keys safely (the OS keychain isn't available)",
    smokeNotes: 'AI video clips, better motion videos, new version alerts',
    smokeRole: 'Button',
    smokeLabel: 'Buy now',
    smokeReason: '"Buy"',
    smokeWhat: 'Buy 1kg of apples now',
    smokeWhere: 'Dool2 test shop',
    smokeCancel: 'Can cancel before shipping (per the product page)',
  },
})

/** Demo price on the smoke-test approval card */
export const smokeAmount = (lang: Lang) => formatMoney(lang, 9900)
