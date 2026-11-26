// Copy for the store-review parts of the phone app: trying it without a PC (demo), the AI consent screen and
// reporting an AI answer
import { messages } from '@dool2/i18n'
import { lang } from '../lang.js'

const catalog = messages({
  ko: {
    tryDemo: 'PC 없이 둘러보기',
    demoPc: '체험용 PC',
    demoBar: '체험 중이에요 · 가짜 PC가 대답해요',
    demoExit: '나가기',
    demoHello:
      '안녕하세요, 두리예요. 지금은 체험이라 실제로 일하지는 않아요. "택배 어디쯤 왔어?"나 "사과 한 박스 주문해 줘"처럼 말해 보세요.',
    demoParcel:
      '택배를 찾아봤어요 (체험).\n\n**CJ대한통운 · 1234-5678-9012**\n- 오늘 오전 9:40 동네 대리점 도착\n- 오늘 오후 배송 예정이에요',
    demoOrder:
      '사과 한 박스를 장바구니에 담았어요 (체험). 결제는 꼭 먼저 물어봐요. 뜨는 승인 창에서 꾹 눌러 보세요.',
    demoOrderWhat: '사과 1박스 (5kg) 결제',
    demoShop: '체험 가게',
    demoPayLabel: '결제하기',
    demoAmount: '29,900원',
    demoGeneric:
      '체험에서는 정해진 답만 해요. PC에 두리를 설치하고 연결하면 예약·장보기·택배·서류 같은 일을 진짜로 맡길 수 있어요.',
    demoApproved: '체험이라 실제로 결제하지는 않았어요. 진짜 PC에서는 승인하신 그 버튼 하나만 두리가 눌러요.',
    consentTitle: '두리가 일하는 방식',
    consentBody1: '부탁하신 말은 이 폰에서 내 PC로 암호화되어 가요. 중계 서버도 내용을 볼 수 없어요.',
    consentBody2:
      'PC의 두리는 답을 만들려고 부탁하신 말과 필요한 화면 내용을 PC에 연결한 AI(Claude, ChatGPT 같은 AI 회사의 서비스)에 보내요. 그 AI 회사의 약관과 개인정보 처리 방침을 따라요.',
    consentBody3: '결제·송금·보내기처럼 되돌리기 어려운 일은 늘 이 폰에서 먼저 승인받아요.',
    consentAgree: '동의하고 시작하기',
    report: '이 답 신고하기',
    reportTitle: '이 답을 신고할까요?',
    reportHarmful: '불쾌하거나 해로운 내용',
    reportWrong: '틀린 내용',
    reportOther: '그 밖의 문제',
    reportNotePh: '더 알려 주실 게 있으면 적어 주세요 (안 적어도 돼요)',
    reportWhatGoes: '이 답의 내용과 고른 이유만 두리 팀에 보내져요. 다른 대화는 보내지 않아요.',
    reportSent: (id?: string) => (id ? `신고를 보냈어요 · 번호 ${id}` : '신고를 보냈어요'),
    reportFailed: (why?: string) => `신고를 보내지 못했어요${why ? ` · ${why}` : ''}`,
  },
  en: {
    tryDemo: 'Look around without a PC',
    demoPc: 'Demo PC',
    demoBar: 'Demo · a pretend PC answers',
    demoExit: 'Leave',
    demoHello:
      'Hi, I am Dool2. This is a demo, so nothing really happens. Try "Where is my parcel?" or "Order a box of apples".',
    demoParcel:
      'I looked up your parcel (demo).\n\n**Parcel · 1234-5678-9012**\n- Arrived at the local depot at 9:40 this morning\n- Out for delivery this afternoon',
    demoOrder:
      'I put a box of apples in the cart (demo). Payments always ask first: hold the button on the approval that opens.',
    demoOrderWhat: 'Pay for 1 box of apples (5 kg)',
    demoShop: 'Demo shop',
    demoPayLabel: 'Pay',
    demoAmount: '₩29,900',
    demoGeneric:
      'The demo only has set answers. Install Dool2 on your PC and connect it to hand over bookings, shopping, parcels and paperwork for real.',
    demoApproved:
      'This is a demo, so nothing was paid. On a real PC, Dool2 presses only the one button you approved.',
    consentTitle: 'How Dool2 works',
    consentBody1:
      'What you ask goes from this phone to your own PC, encrypted. The relay server cannot read it.',
    consentBody2:
      "To answer, Dool2 on your PC sends what you asked, and the screen content it needs, to the AI connected on the PC (a service of an AI company such as Claude or ChatGPT). That company's terms and privacy policy apply.",
    consentBody3:
      'Steps that are hard to undo, like paying, transferring or sending, are always approved on this phone first.',
    consentAgree: 'Agree and start',
    report: 'Report this answer',
    reportTitle: 'Report this answer?',
    reportHarmful: 'Offensive or harmful',
    reportWrong: 'Wrong',
    reportOther: 'Something else',
    reportNotePh: 'Anything to add? (optional)',
    reportWhatGoes: 'Only this answer and the reason you picked go to the Dool2 team. No other chat is sent.',
    reportSent: (id?: string) => (id ? `Report sent · number ${id}` : 'Report sent'),
    reportFailed: (why?: string) => `Couldn't send the report${why ? ` · ${why}` : ''}`,
  },
})

export const reviewText = catalog
export const tReview = catalog(lang)

/** Words in a demo request that get the parcel answer or the order with an approval card (any language) */
export const DEMO_PARCEL = /택배|배송|parcel|deliver/i
export const DEMO_ORDER = /주문|사과|결제|order|buy|apple/i
