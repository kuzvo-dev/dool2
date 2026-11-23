// Phone link copy: messages the phone app and the desktop pairing screen show to people (ADR 0029)
import { messages } from '@dool2/i18n'

export const linkCopy = messages({
  ko: {
    noRelay: '중계 서버 주소가 정해지지 않았어요',
    phone: '폰',
    badPushAddress: '이 브라우저의 알림 주소는 쓸 수 없어요',
    noFileSend: '이 PC에서는 파일을 보낼 수 없어요',
    badSocial: '간편 로그인 종류가 이상해요',
    noReset: '이 PC에서는 처음부터 다시를 쓸 수 없어요',
    staleRequest: '요청이 오래됐어요. 다시 눌러 주세요',
    badSignature: '서명이 맞지 않아요',
    noApproval: '승인 요청을 찾을 수 없어요',
    tooBig: '보낼 내용이 너무 커서 폰으로 못 보냈어요. PC 화면에서 확인해 주세요',
  },
  en: {
    noRelay: 'No relay address is set',
    phone: 'Phone',
    badPushAddress: "This browser's notification address can't be used",
    noFileSend: "This PC can't send files",
    badSocial: 'Unknown social login type',
    noReset: "Start over isn't available on this PC",
    staleRequest: 'This request is too old. Tap again',
    badSignature: "The signature doesn't match",
    noApproval: "Can't find that approval request",
    tooBig: 'This was too large to send to the phone. Check it on the PC screen',
  },
})
