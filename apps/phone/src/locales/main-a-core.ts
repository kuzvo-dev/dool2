import { messages } from '@dool2/i18n'

export const mainCore = messages({
  ko: {
    resetAsk:
      '데이터를 초기화할까요?\n\nPC의 대화·기억·목표·보관함·아이디어·내 정보가 모두 지워져요. 되돌릴 수 없어요.',
    resetServicesAsk:
      '연결한 서비스 표시도 지울까요?\n\n[확인] 연결 표시도 지워요\n[취소] 연결은 그대로 둬요\n\n금고의 비밀번호와 이 폰의 PC 연결은 어느 쪽이든 남아요.',
    resetting: '지우는 중이에요…',
    paired: '연결됐어요. 이제 폰으로 부탁해 보세요',
    approvalWaiting: '승인을 기다려요',
    loginNeeded: '로그인이 필요해요',
    loginNeededBody: (site: string) => `${site} 아이디와 비밀번호를 넣어 주세요`,
    serviceConnected: (name: string) => `${name} 연결됐어요`,
    tapToOpen: (message: string) => `${message} 눌러서 열기`,
    doing: (title: string) => `${title} 중`,
    photoDefault: '이 사진 봐 줘',
    needPcOnline: 'PC와 연결되면 할 수 있어요',
    connectAsk: (name: string) => `${name} 연결해 줘`,
    photoTooBig: '사진이 너무 커요',
  },
  en: {
    resetAsk:
      'Reset your data?\n\nEverything on your PC will be erased: chats, memory, goals, library, ideas and your info. This cannot be undone.',
    resetServicesAsk:
      'Clear connected services too?\n\n[OK] Clear the connections too\n[Cancel] Keep the connections\n\nVault passwords and this phone’s link to your PC stay either way.',
    resetting: 'Erasing…',
    paired: 'Connected. You can now ask Dool2 from your phone',
    approvalWaiting: 'Waiting for your approval',
    loginNeeded: 'Login needed',
    loginNeededBody: (site: string) => `Enter your ${site} ID and password`,
    serviceConnected: (name: string) => `${name} is connected`,
    tapToOpen: (message: string) => `${message} Tap to open`,
    doing: (title: string) => `${title}…`,
    photoDefault: 'Take a look at this photo',
    needPcOnline: 'Available once your PC is connected',
    connectAsk: (name: string) => `Connect ${name}`,
    photoTooBig: 'This photo is too big',
  },
})
