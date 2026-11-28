// The demo world the window shows with no live daemon data yet: a seeded chat thread, the 지금 live tasks, the
// 두리의 화면 card, and the 다음 차례 queue. It makes the app (and the smoke screenshot) read as a full, working
// screen offline — the same role the base smoke's seed played. It is demo/test data on a generic rail site (no real
// product or company names, repo rule), so the Korean copy lives in this `locales/` file (ADR 0029). When the v2
// daemon grows real thread history / task state, the renderer reads that instead and this seed goes away.

/** Device pill at the bottom of the left nav. */
export const seedDevice = { name: '우리 집 MacBook Pro', on: '켜져 있어요' }

/** 지금: the live tasks list in the left nav. */
export const seedNow = [
  { tone: 'work' as const, title: 'KTX 예매', desc: '좌석 고르는 중', count: '3/5' },
  { tone: 'ask' as const, title: '장보기 승인', amount: '₩82,400' },
]

/** The seeded chat thread (design mock, docs/design/screens/src/PC.dc.html). */
export const seedThread = {
  time: '07:30',
  done: { text: '미용실 예약했어요', meta: '· 토 11:00' },
  dooriMorning:
    '좋은 아침이에요. 10시 가족 점심, 운동화는 14–16시에 와요. 안 읽은 광고 메일 38통은 정리해뒀어요.',
  dooriLunch: '벌써 1시인데 점심은요? 어제 맛있다던 국밥집, 배달 열려 있어요.',
  chips: ['응 시켜줘', '이따 먹을게', '다른 거 추천해줘'],
  me: '아 이따 ㅎㅎ 그보다 내일 아침 부산 KTX 창가로 잡아줘. 9시 전후면 좋아',
  dooriKtx: '좋아요! 9시 KTX 101이 제일 맞아요. 오른쪽에서 고르는 거 보여드릴게요. 결제 전엔 꼭 물어볼게요.',
}

/** The 두리의 화면 card: what Dool2 is doing right now. */
export const seedScreen = {
  title: 'KTX 예매',
  status: '좌석 고르는 중',
  url: 'letskorail.com',
  seat: '7호차 12A',
  price: '₩59,800',
  detail: '내일 09:00 서울→부산 · 창가 · 순방향',
  cursor: '두리',
  /** Seat strip: x = empty (dashed), . = taken, o = the one Dool2 picked. */
  seats: 'x..x..xo.x..',
}

/** 다음 차례: the queue under the live card. */
export const seedNextUp = [
  { icon: 'cart' as const, title: '장보기 결제', amount: '₩82,400', pill: true },
  { icon: 'box' as const, title: '택배 도착 확인', time: '14:00' },
]
