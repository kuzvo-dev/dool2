// Copy for separate chats, the intro, pairing and remote-screen messages in main.ts.
import { messages } from '@dool2/i18n'
import { lang } from '../lang.js'

const catalog = messages({
  ko: {
    sideTitle: '따로 하는 대화',
    sideEmpty: '여행·이사처럼 길게 이어질 일은 따로 이야기해요',
    fold: '접기',
    showMore: (n: number) => `${n}개 더 보기`,
    stepSuffix: (title: string) => `${title} 중`,
    waitingInput: (label: string) => `넣을 것이 있어요 · ${label}`,
    open: '열기',
    sideIntro: '주제 하나를 따로 이야기해요',
    sideIntroText:
      '여행 계획, 이사 준비처럼 길게 이어질 일을 여기서 하면 메인 대화가 어지럽지 않아요. 두리는 메인 대화에서 알게 된 것도 기억해요.',
    askPh: '두리에게 부탁하기',
    send: '보내기',
    back: '뒤로',
    delete: '지우기',
    confirmDelete: '이 대화를 지울까요?',
    // intro
    name: '두리',
    introSub: '내 컴퓨터의 두리에게 폰으로 부탁해요.',
    step1: 'PC에서 두리 앱을 열어요',
    step2: '설정 → 폰 연결 → [폰 연결하기]',
    step3Native: '아래 [QR 찍기]로 PC 화면의 QR을 찍어요',
    step3Web: '폰 카메라로 QR을 찍어요',
    scanQr: 'QR 찍기',
    encrypted: '주고받는 내용은 PC와 이 폰만 열 수 있게 암호화돼요.',
    notDoolQr: '두리 연결 QR이 아니에요. PC의 설정 → 폰 연결에서 띄운 QR을 찍어 주세요',
    scanFailed: 'QR을 찍지 못했어요',
    // unsupported
    updateTitle: '업데이트가 하나 필요해요',
    updateText:
      '폰의 Android System WebView가 오래돼서 암호화를 쓸 수 없어요. Play 스토어에서 업데이트한 뒤 다시 열어 주세요.',
    updateBtn: 'Play 스토어에서 업데이트',
    browserTitle: '이 브라우저에서는 열 수 없어요',
    browserText: '아이폰은 사파리 17 이상, 안드로이드는 크롬 최신 버전에서 열어 주세요.',
    // pairing
    rejectedTitle: 'PC에서 연결을 거절했어요',
    rejectedText: '숫자가 달랐다면 PC에서 QR을 새로 띄워 다시 찍어 주세요.',
    connectTo: (pc: string) => `${pc}에 연결할게요`,
    seeNumber: 'PC 화면에 이 숫자가 보이나요?',
    pairHint: 'PC에서 [같아요, 연결]을 눌러 주세요. 숫자가 다르면 "다른 숫자예요"를 눌러 주세요.',
    // remote
    checkingLogin: '로그인됐는지 확인할게요',
    checkingContinue: '확인하고 이어서 할게요',
  },
  en: {
    sideTitle: 'Separate chat',
    sideEmpty: 'Long topics like trips or moving get their own chat',
    fold: 'Show less',
    showMore: (n: number) => `Show ${n} more`,
    stepSuffix: (title: string) => `${title}…`,
    waitingInput: (label: string) => `Needs your input · ${label}`,
    open: 'Open',
    sideIntro: 'Talk about one topic on its own',
    sideIntroText:
      'Do long things like trip plans or moving here so the main chat stays tidy. Dool2 remembers what it learns in the main chat too.',
    askPh: 'Ask Dool2',
    send: 'Send',
    back: 'Back',
    delete: 'Delete',
    confirmDelete: 'Delete this chat?',
    name: 'Dool2',
    introSub: 'Ask Dool2 on your computer, from your phone.',
    step1: 'Open the Dool2 app on your PC',
    step2: 'Settings → Phone → [Connect a phone]',
    step3Native: 'Tap [Scan QR] below and scan the QR on your PC screen',
    step3Web: 'Scan the QR with your phone camera',
    scanQr: 'Scan QR',
    encrypted: 'What you send is encrypted so only your PC and this phone can open it.',
    notDoolQr: 'That isn’t a Dool2 QR. Scan the one shown in Settings → Phone on your PC',
    scanFailed: 'Couldn’t scan the QR',
    updateTitle: 'An update is needed',
    updateText:
      'Your phone’s Android System WebView is too old to use encryption. Update it in the Play Store, then open the app again.',
    updateBtn: 'Update in the Play Store',
    browserTitle: 'This browser can’t open Dool2',
    browserText: 'Use Safari 17 or later on iPhone, or the latest Chrome on Android.',
    rejectedTitle: 'Your PC declined the connection',
    rejectedText: 'If the numbers differed, show a new QR on your PC and scan it again.',
    connectTo: (pc: string) => `Connecting to ${pc}`,
    seeNumber: 'Do you see this number on your PC screen?',
    pairHint: 'On your PC, click [They match, connect]. If the numbers differ, click "Different number".',
    checkingLogin: 'Checking that you’re signed in',
    checkingContinue: 'Checking, then Dool2 will carry on',
  },
})

/** The catalog for the phone's language (read once at start). */
export const mdSide = catalog(lang)
