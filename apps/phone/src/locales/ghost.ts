import { messages } from '@dool2/i18n'
import { josa } from '../region/kr/ghost.js'

/** Follow-up lines suggested in the input box (what the user might type next) */
export const ghostText = messages({
  ko: {
    bookIt: (n: string) => `${n} 예약해 줘`,
    addToCart: (n: string) => `${n}${josa(n, '을', '를')} 장바구니에 담아 줘`,
    moreAbout: (n: string) => `${n} 더 자세히 알려 줘`,
    closingTime: (n: string) => `${n}${josa(n, '이', '가')} 몇 시까지 하는지 알려 줘`,
    more: '더 자세히 알려 줘',
    food: '예약 가능한 시간 알아봐 줘\n예약까지 해 줘\n가는 길 알려 줘\n다른 곳도 더 찾아 줘',
    shop: '제일 싼 곳으로 담아 줘\n후기 좋은 걸로 골라 줘\n가격 내려가면 알려 줘',
    trip: '예약 가능한 날짜 알아봐 줘\n더 싼 날짜도 찾아 줘\n예약까지 해 줘',
  },
  en: {
    bookIt: (n: string) => `Book ${n}`,
    addToCart: (n: string) => `Add ${n} to my cart`,
    moreAbout: (n: string) => `Tell me more about ${n}`,
    closingTime: (n: string) => `What time does ${n} close?`,
    more: 'Tell me more',
    food: 'Find available times\nBook it too\nShow me how to get there\nFind more places',
    shop: 'Add the cheapest one\nPick the best reviewed\nTell me if the price drops',
    trip: 'Find available dates\nFind cheaper dates too\nBook it too',
  },
})
