// Text people read from the extension (ADR 0029): the popup, the cursor label drawn on the page, the tab group title.
// Korean is the reference copy; English must have the same keys.
import { messages } from '@dool2/i18n'

export const ui = messages({
  ko: {
    groupTitle: '두리',
    appNotInstalled: '두리 앱이 설치돼 있지 않아요',
    appOff: '두리 앱이 꺼져 있어요',
    cursorTyping: '두리가 입력하는 중',
    cursorClicking: '두리가 누르는 중',
    cursorHovering: '두리가 올려 보는 중',
    cursorFillingVault: '두리 금고로 채우는 중',
    cursorOpeningOptions: '옵션 목록 여는 중',
    cursorChoosing: (label: string) => `${label} 고르는 중`,
  },
  en: {
    groupTitle: 'Dool2',
    appNotInstalled: 'The Dool2 app is not installed',
    appOff: 'The Dool2 app is not running',
    cursorTyping: 'Dool2 is typing',
    cursorClicking: 'Dool2 is clicking',
    cursorHovering: 'Dool2 is hovering',
    cursorFillingVault: 'Filling from the Dool2 vault',
    cursorOpeningOptions: 'Opening the options',
    cursorChoosing: (label: string) => `Choosing ${label}`,
  },
})

export const popupText = messages({
  ko: {
    name: '두리',
    checking: '확인하는 중…',
    retry: '다시 연결하기',
    connected: '두리 앱과 연결됐어요',
    connecting: '연결하는 중…',
    notConnected: '연결되지 않았어요',
    connectedNote: '두리가 일할 때는 초록색 "두리" 탭 그룹에서만 움직여요.',
    offNote: (detail: string | undefined) =>
      `${detail ?? '두리 앱이 꺼져 있어요'}. 두리 앱을 켜면 30초 안에 다시 연결돼요.`,
  },
  en: {
    name: 'Dool2',
    checking: 'Checking…',
    retry: 'Reconnect',
    connected: 'Connected to the Dool2 app',
    connecting: 'Connecting…',
    notConnected: 'Not connected',
    connectedNote: 'While Dool2 works, it only moves inside the green "Dool2" tab group.',
    offNote: (detail: string | undefined) =>
      `${detail ?? 'The Dool2 app is not running'}. Start the Dool2 app and it reconnects within 30 seconds.`,
  },
})
