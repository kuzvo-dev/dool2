import { messages } from '../i18n.js'

export const statsAsk = messages({
  ko: {
    title: '사용 통계를 보내도 될까요?',
    body: '숫자만 보내요(부탁 몇 개를 끝냈는지 등). 대화·사이트 이름은 안 보내고, 설정에서 언제든 꺼요.',
    yes: '보낼게요',
    no: '괜찮아요',
  },
  en: {
    title: 'Send usage stats?',
    body: 'Only numbers, like how many requests were finished. No conversations or site names. You can turn it off in Settings anytime.',
    yes: 'Send',
    no: 'No thanks',
  },
})
