// All user-facing copy for the phone app (ADR 0029). Korean is the reference voice (docs/persona.md: warm,
// result-first, plain words); English is complete. This is a `locales/` file, so Korean lives here and nowhere else in
// the app's code. The approval copy matches the design mock exactly (docs/design/screens/src/MApprove.dc.html):
// "승인을 기다리고 있어요", "₩59,800 결제할까요?", "Face ID로 승인하기", "내가 직접 할게요", "거절",
// "카드 번호는 두리도 저희도 볼 수 없어요".

import type { Lang } from '@dool2/i18n'
import { messages } from '@dool2/i18n'

const won = (lang: Lang, amount: number): string =>
  `₩${new Intl.NumberFormat(lang === 'ko' ? 'ko-KR' : 'en-US').format(amount)}`

export const text = messages({
  ko: {
    // Brand + header
    appName: '두리',
    name: '두리',
    statusWaiting: '승인을 기다리고 있어요',
    statusIdle: '할 일이 없어요',
    statusConnected: '우리 집 컴퓨터와 연결됐어요',
    menu: '메뉴',
    connectedPc: '연결된 컴퓨터',
    // Home (connected, nothing to approve)
    homeIdleTitle: '지금은 승인할 일이 없어요',
    homeIdleBody: '두리가 결제나 보내기를 하려고 하면 여기로 바로 올려 드릴게요.',
    threadMe: '7호차 이상이면 좋겠어',
    threadSay: '7호차 12A 창가로 골라뒀어요. 결제만 남았어요.',
    // Pairing screen
    pairTitle: '폰 연결',
    pairIntro: '컴퓨터의 두리 화면에 뜬 연결 코드를 넣으면, 결제·보내기를 폰에서 승인할 수 있어요.',
    pairUrlLabel: 'PC 주소',
    pairUrlHint: '컴퓨터 두리 화면의 연결 주소예요. 예: http://127.0.0.1:53219',
    pairCodeLabel: '연결 코드',
    pairCodeHint: '컴퓨터 화면에 보이는 코드를 그대로 넣어요.',
    pairNameLabel: '이 폰 이름',
    pairNamePlaceholder: '내 아이폰',
    pairConnect: '연결하기',
    pairConnecting: '연결하는 중이에요…',
    pairDone: '연결됐어요',
    pairKeyNote: '이 폰의 서명 키는 폰에만 있어요. 공개 키만 컴퓨터로 보내요.',
    pairFailed: (reason: string) => `연결하지 못했어요 (${reason}). 코드와 주소를 다시 확인해 주세요.`,
    // Approval sheet
    approveSource: (service: string) => `${service} · 우리 집 맥북에서 결제돼요`,
    payHeadline: (amount: string) => `${amount} 결제할까요?`,
    askHeadline: (label: string) => `${label}, 할까요?`,
    approve: 'Face ID로 승인하기',
    doMyself: '내가 직접 할게요',
    reject: '거절',
    privacyNote: '카드 번호는 두리도 저희도 볼 수 없어요',
    signing: '폰에서 확인하는 중이에요…',
    approved: '승인됐어요',
    approvedBody: '컴퓨터에서 두리가 이어서 처리하고 있어요.',
    rejected: '거절했어요',
    rejectedBody: '이 일은 하지 않을게요.',
    handedOff: '내가 직접 할게요',
    handedOffBody: '컴퓨터 화면에서 직접 이어서 하면 돼요.',
    close: '닫기',
    amount: (n: number) => won('ko', n),
    error: (reason: string) => `문제가 생겼어요 (${reason}).`,
  },
  en: {
    appName: 'Dool2',
    name: 'Dool2',
    statusWaiting: 'Waiting for your approval',
    statusIdle: 'Nothing to do',
    statusConnected: 'Connected to your computer',
    menu: 'Menu',
    connectedPc: 'Connected computer',
    homeIdleTitle: 'Nothing to approve right now',
    homeIdleBody: "When Dool2 goes to pay or send something, it'll come straight here.",
    threadMe: 'Car 7 or further back would be nice',
    threadSay: 'Picked car 7, 12A by the window. Just the payment left.',
    pairTitle: 'Connect your phone',
    pairIntro:
      'Enter the code shown on your computer, and you can approve payments and sends from your phone.',
    pairUrlLabel: 'PC address',
    pairUrlHint: "The connect address on your computer's Dool2 screen, e.g. http://127.0.0.1:53219",
    pairCodeLabel: 'Connect code',
    pairCodeHint: 'Type in the code shown on your computer.',
    pairNameLabel: 'This phone',
    pairNamePlaceholder: 'My iPhone',
    pairConnect: 'Connect',
    pairConnecting: 'Connecting…',
    pairDone: 'Connected',
    pairKeyNote: "This phone's signing key stays on the phone. Only the public key goes to the computer.",
    pairFailed: (reason: string) => `Couldn't connect (${reason}). Check the code and address.`,
    approveSource: (service: string) => `${service} · pays from your Mac at home`,
    payHeadline: (amount: string) => `Pay ${amount}?`,
    askHeadline: (label: string) => `Go ahead with ${label}?`,
    approve: 'Approve with Face ID',
    doMyself: "I'll do it myself",
    reject: 'Decline',
    privacyNote: 'Neither Dool2 nor we can see your card number',
    signing: 'Confirming on your phone…',
    approved: 'Approved',
    approvedBody: 'Dool2 is carrying on with it on your computer.',
    rejected: 'Declined',
    rejectedBody: "I won't do this one.",
    handedOff: "I'll do it myself",
    handedOffBody: 'You can carry on with it on the computer screen.',
    close: 'Close',
    amount: (n: number) => won('en', n),
    error: (reason: string) => `Something went wrong (${reason}).`,
  },
})

export type Text = ReturnType<typeof text>
