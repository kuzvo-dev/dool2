// 아이디어 탭의 분류별 부탁 모음. 폰과 PC가 같은 목록을 쓴다.
// 각 분류 = 두리에게 바로 맡길 수 있는 일반 부탁 + 그 분류에 속한 연결 카드의 "할 수 있는 일"(skills/*/connect.json).
import type { ConnectCard, ConnectionItem } from './connect.js'

/** 두 앱 모두에 있는 아이콘 이름 */
export type IdeaIcon =
  | 'goal'
  | 'cart'
  | 'box'
  | 'star'
  | 'card'
  | 'place'
  | 'plane'
  | 'ticket'
  | 'note'
  | 'mail'
  | 'sun'
  | 'heart'
  | 'users'
  | 'play'
  | 'image'
  | 'pc'

export type IdeaTone = 'mint' | 'blue' | 'rose' | 'violet' | 'amber'

export interface IdeaAsk {
  /** 누르면 그대로 보내는 말 */
  text: string
  /** 아래 작은 글씨 한 줄 */
  note: string
}

export interface IdeaSection {
  id: string
  label: string
  icon: IdeaIcon
  tone: IdeaTone
  /** 이 분류에 넣을 연결 카드 분류 */
  cats: ConnectCard['category'][]
  /** 분류와 상관없이 이 분류로 옮길 카드 */
  cards?: string[]
  asks: IdeaAsk[]
}

export const IDEA_SECTIONS: IdeaSection[] = [
  {
    id: 'routine',
    label: '알아서 매일',
    icon: 'goal',
    tone: 'mint',
    cats: [],
    asks: [
      { text: '매일 아침 7시 반에 날씨랑 오늘 일정 알려 줘', note: '아침마다 피드에 올려요' },
      { text: '매주 월요일 아침에 이번 주 할 일 정리해 줘', note: '목표 탭에서 언제든 끌 수 있어요' },
      { text: '매일 밤 10시에 내일 챙길 것 알려 줘', note: '일정과 날씨를 보고 정리해요' },
      { text: '주 3회 운동하기 목표 만들어 줘', note: '계획을 세우고 정한 날 체크인해요' },
      { text: '석 달 동안 300만 원 모으기 목표 세워 줘', note: '매달 얼마씩 모을지 계획까지' },
      { text: '이번 달 책 두 권 읽기 목표 만들어 줘', note: '주마다 어디까지 읽었는지 물어봐요' },
      { text: '매일 영어 단어 10개 피드에 올려 줘', note: '아침에 피드로 받아요' },
    ],
  },
  {
    id: 'grocery',
    label: '장보기·배달',
    icon: 'cart',
    tone: 'mint',
    cats: ['grocery'],
    asks: [
      { text: '냉장고 사진 보낼게, 있는 재료로 저녁 메뉴 추천해 줘', note: '사진은 입력칸 + 에서 보내요' },
      { text: '김치찌개 재료 장보기 목록 만들어 줘', note: '목록은 보관함에 남겨요' },
      { text: '우유랑 계란 제일 싼 곳 찾아 줘', note: '쇼핑몰 여러 곳을 비교해요' },
      { text: '일주일 저녁 식단 짜고 장볼 것 정리해 줘', note: '식단과 장보기 목록을 함께' },
      { text: '이번 주 마트 할인 상품 알려 줘', note: '할인 전단을 찾아 정리해요' },
    ],
  },
  {
    id: 'shopping',
    label: '쇼핑',
    icon: 'box',
    tone: 'blue',
    cats: ['shopping'],
    asks: [
      {
        text: '30만 원 이하 무선 청소기 3개 비교표 만들어 줘',
        note: '가격·무게·후기를 표로, 보관함에 남겨요',
      },
      { text: '이 상품 다른 데서 더 싸게 파는지 찾아 줘', note: '링크나 상품 이름을 같이 보내 주세요' },
      { text: '에어팟 가격 10% 내려가면 알려 줘', note: '목표로 만들어 매일 확인해요' },
      { text: '부모님 선물 5만 원대로 골라 줘', note: '후기 좋은 것 위주로 3개' },
      { text: '주문한 택배 어디쯤 왔는지 봐 줘', note: '쇼핑몰 주문 내역이나 운송장 번호로' },
    ],
  },
  {
    id: 'fashion',
    label: '패션·뷰티',
    icon: 'star',
    tone: 'rose',
    cats: ['fashion'],
    asks: [
      { text: '겨울 패딩 10만 원대로 찾아 줘', note: '후기 많은 순으로 골라요' },
      { text: '건성 피부에 맞는 수분크림 추천해 줘', note: '성분과 후기를 같이 봐요' },
      { text: '이번 달 화장품 세일 모아 줘', note: '할인율 큰 것부터' },
      { text: '이 옷 사진이랑 비슷한 거 찾아 줘', note: '사진은 입력칸 + 에서 보내요' },
    ],
  },
  {
    id: 'money',
    label: '돈 관리',
    icon: 'card',
    tone: 'blue',
    cats: ['telecom'],
    asks: [
      { text: '영수증 사진 보낼게, 어디에 많이 썼는지 정리해 줘', note: '날짜·가게·금액을 표로' },
      { text: '메일함에서 정기 결제 찾아서 목록 만들어 줘', note: '해지는 꼭 승인받고 해요' },
      { text: '이번 달 카드값 얼마 나왔는지 정리해 줘', note: '카드사 메일이나 문자 내역으로' },
      { text: '지금 요금제보다 싼 휴대폰 요금제 있는지 봐 줘', note: '쓰는 데이터 양에 맞춰 비교해요' },
      { text: '적금 금리 높은 곳 비교해 줘', note: '조건까지 표로 정리해요' },
      { text: '연말정산 때 챙길 서류 목록 만들어 줘', note: '빠뜨리기 쉬운 공제부터' },
    ],
  },
  {
    id: 'travel',
    label: '여행·숙소',
    icon: 'place',
    tone: 'amber',
    cats: ['travel'],
    asks: [
      { text: '12월에 2박 3일 제주 여행 일정 짜 줘', note: '동선과 맛집까지, 보관함에 남겨요' },
      { text: '이번 주말 부산 호텔 20만 원 이하로 찾아 줘', note: '예약은 결제 전에 꼭 물어봐요' },
      { text: '오사카 3박 4일 경비 대충 계산해 줘', note: '항공·숙소·식비를 나눠서' },
      { text: '이번 달 주말에 빈자리 있는 캠핑장 찾아 줘', note: '가까운 곳부터' },
      { text: '여행 짐 챙길 목록 만들어 줘', note: '날씨와 일정에 맞춰' },
    ],
  },
  {
    id: 'transport',
    label: '기차·항공',
    icon: 'plane',
    tone: 'violet',
    cats: ['flight'],
    asks: [
      { text: '금요일 저녁 부산 가는 SRT 자리 찾아 줘', note: '결제는 폰에서 승인해요' },
      { text: '설 연휴 KTX 예매 열리는 날 알려 줘', note: '그날 아침에 다시 알려 드려요' },
      { text: '1월 도쿄 왕복 항공권 제일 싼 날 찾아 줘', note: '날짜별 가격을 비교해요' },
      { text: '서울에서 강릉 가는 고속버스 시간표 알려 줘', note: '남은 자리도 같이 봐요' },
      { text: '제주 항공권 5만 원 아래로 나오면 알려 줘', note: '목표로 만들어 매일 확인해요' },
    ],
  },
  {
    id: 'tickets',
    label: '예매·예약',
    icon: 'ticket',
    tone: 'rose',
    cats: ['tickets'],
    asks: [
      { text: '토요일 저녁 7시에 2명 식당 자리 찾아 줘', note: '확정 직전에 꼭 물어볼게요' },
      { text: '다음 주 미용실 예약 가능한 시간 알려 줘', note: '자주 가는 곳을 알려 주세요' },
      { text: '주말에 볼 만한 영화 자리 남았는지 봐 줘', note: '가까운 극장부터' },
      { text: '이번 달 아이랑 갈 만한 전시 찾아 줘', note: '예약 필요한 곳은 표시해요' },
      { text: '보고 싶은 공연 예매 열리는 날 알려 줘', note: '열리는 날 아침에 다시 알려요' },
    ],
  },
  {
    id: 'admin',
    label: '서류·행정',
    icon: 'note',
    tone: 'violet',
    cats: [],
    asks: [
      { text: '주민등록등본 떼는 방법 알려 줘', note: '본인인증은 직접 해 주셔야 해요' },
      { text: '자동차세 연납 신청 기간 알려 줘', note: '기간이 되면 알림도 만들어요' },
      { text: '올해 건강검진 대상인지 확인하는 법 알려 줘', note: '필요한 곳까지 바로 안내해요' },
      { text: '여권 새로 만들 때 준비물 정리해 줘', note: '가까운 발급 기관도 함께' },
      { text: '이사하면 해야 할 전입신고·주소 변경 목록 만들어 줘', note: '순서대로 체크리스트로' },
      { text: '이번 달 내야 할 공과금 정리해 줘', note: '메일로 온 고지서를 찾아봐요' },
    ],
  },
  {
    id: 'mail',
    label: '메일·일정',
    icon: 'mail',
    tone: 'blue',
    cats: ['mail', 'device'],
    asks: [
      { text: '메일함에서 이번 달 영수증만 모아 줘', note: '첨부 파일까지 한 번에' },
      { text: '안 읽은 메일 중 중요한 것만 요약해 줘', note: '광고는 빼고요' },
      { text: '다음 주 일정 정리해 줘', note: '겹치는 일정도 찾아요' },
      { text: '광고 메일 보내는 곳 목록 만들어 줘', note: '수신 거부는 승인받고 해요' },
    ],
  },
  {
    id: 'life',
    label: '생활',
    icon: 'sun',
    tone: 'amber',
    cats: ['life'],
    asks: [
      { text: '내일 아침 우산 챙겨야 해?', note: '사는 동네 날씨로 봐요' },
      { text: '우리 동네 분리수거 요일 알려 줘', note: '구청 안내를 찾아봐요' },
      { text: '이사 준비 체크리스트 만들어 줘', note: '날짜별로 할 일을 나눠요' },
      { text: '이번 주말에 여는 근처 약국 찾아 줘', note: '여는 시간까지' },
      { text: '보일러 고장 수리 업체 견적 비교해 줘', note: '후기와 가격을 같이 봐요' },
    ],
  },
  {
    id: 'health',
    label: '건강',
    icon: 'heart',
    tone: 'rose',
    cats: [],
    asks: [
      { text: '주 3회 30분 운동 계획 짜 줘', note: '집에서 할 수 있는 걸로' },
      { text: '토요일에 진료하는 근처 소아과 찾아 줘', note: '진료 시간까지 확인해요' },
      { text: '매일 밤 9시에 약 먹으라고 알려 줘', note: '알림으로 만들어요' },
      { text: '식단 사진 보낼게, 칼로리 대충 계산해 줘', note: '사진은 입력칸 + 에서 보내요' },
    ],
  },
  {
    id: 'family',
    label: '아이·가족',
    icon: 'users',
    tone: 'mint',
    cats: [],
    cards: ['kidsnote'],
    asks: [
      { text: '이번 주말에 아이랑 갈 만한 곳 추천해 줘', note: '날씨와 거리까지 보고' },
      { text: '아이 생일 파티 준비 목록 만들어 줘', note: '장볼 것까지 정리해요' },
      { text: '부모님 건강검진 예약 가능한 병원 찾아 줘', note: '예약은 승인받고 해요' },
      { text: '가족 생일이랑 기념일 미리 알려 줘', note: '일주일 전에 알림으로' },
    ],
  },
  {
    id: 'media',
    label: '영상·음악·책',
    icon: 'play',
    tone: 'violet',
    cats: ['media', 'books'],
    asks: [
      { text: '요즘 많이 보는 드라마 추천해 줘', note: '어디서 볼 수 있는지도' },
      { text: '출퇴근에 들을 플레이리스트 만들어 줘', note: '좋아하는 가수를 알려 주세요' },
      { text: '이 책 제일 싸게 파는 곳 찾아 줘', note: '서점 여러 곳을 비교해요' },
      { text: '안 보는 OTT 구독 정리해 줘', note: '해지는 승인받고 해요' },
    ],
  },
  {
    id: 'social',
    label: 'SNS',
    icon: 'image',
    tone: 'rose',
    cats: ['social'],
    asks: [
      { text: '이 사진으로 올릴 글 세 가지 버전으로 써 줘', note: '올리기 전에 꼭 보여 드려요' },
      { text: '우리 가게 홍보 글 써 줘', note: '말투를 골라 주세요' },
    ],
  },
  {
    id: 'work',
    label: '일·공부',
    icon: 'pc',
    tone: 'blue',
    cats: ['work'],
    asks: [
      { text: '회의 메모 정리해서 할 일만 뽑아 줘', note: '메모를 붙여 넣어 주세요' },
      { text: '자기소개서 다듬어 줘', note: '지원하는 곳에 맞춰서' },
      { text: '영어 메일 정중하게 고쳐 줘', note: '고친 이유도 짧게' },
      { text: '관심 있는 회사 채용 공고 올라오면 알려 줘', note: '목표로 만들어 매일 확인해요' },
    ],
  },
]

export interface IdeaItem {
  /** 화면에 보이는 말 */
  text: string
  /** 누르면 보내는 말 (서비스 아이디어는 "쿠팡에서 …") */
  ask: string
  note: string
  /** 연결 카드에서 온 아이디어면 그 카드 */
  service?: { id: string; name: string; mark: string; connected: boolean; how: ConnectCard['how'] }
}

export interface IdeaGroup {
  section: IdeaSection
  items: IdeaItem[]
}

/** 서비스 이름 표시 글자: 숫자로 시작하면 숫자 묶음(11번가 → 11), 아니면 첫 글자 */
export function serviceMark(name: string): string {
  return /^\d+/.exec(name)?.[0] ?? [...name][0] ?? ''
}

/** "야놀자(NOL)" → "야놀자" */
function shortName(name: string): string {
  return name.replace(/\s*\(.*?\)\s*/g, '').trim() || name
}

/** 서비스 아이디어를 보낼 말: 서비스 이름이 없으면 앞에 붙인다 */
export function serviceAsk(card: Pick<ConnectCard, 'name' | 'how'>, say: string): string {
  const name = shortName(card.name)
  if (card.how === 'device' || say.includes(name)) return say
  return `${name}에서 ${say}`
}

/** 연결 카드가 어느 분류로 가는지 */
function sectionOf(card: ConnectCard): IdeaSection | undefined {
  return (
    IDEA_SECTIONS.find((s) => s.cards?.includes(card.id)) ??
    IDEA_SECTIONS.find((s) => s.cats.includes(card.category))
  )
}

/** 분류별 아이디어. 분류 안에서는 연결한 곳 → 일반 부탁 → 아직 연결 안 한 곳 순서 */
export function ideaCatalog(services: readonly ConnectionItem[]): IdeaGroup[] {
  const svc = new Map<string, { on: IdeaItem[]; off: IdeaItem[] }>()
  const sorted = [...services].sort((a, b) => a.card.name.localeCompare(b.card.name, 'ko'))
  for (const it of sorted) {
    const sec = sectionOf(it.card)
    if (!sec) continue
    const bucket = svc.get(sec.id) ?? { on: [], off: [] }
    svc.set(sec.id, bucket)
    const connected = Boolean(it.connectedAt) || it.card.how === 'open'
    for (const a of it.card.abilities)
      (connected ? bucket.on : bucket.off).push({
        text: a.say,
        ask: serviceAsk(it.card, a.say),
        note: `${it.card.name} · ${a.title}`,
        service: {
          id: it.card.id,
          name: it.card.name,
          mark: serviceMark(it.card.name),
          connected,
          how: it.card.how,
        },
      })
  }
  return IDEA_SECTIONS.map((section) => {
    const b = svc.get(section.id)
    const general: IdeaItem[] = section.asks.map((a) => ({ text: a.text, ask: a.text, note: a.note }))
    return { section, items: [...(b?.on ?? []), ...general, ...(b?.off ?? [])] }
  }).filter((g) => g.items.length)
}

/** 검색: 띄어쓰기를 무시하고 말·설명·분류 이름에서 찾는다 */
export function searchIdeas(
  groups: readonly IdeaGroup[],
  query: string,
  max = 40,
): { section: IdeaSection; item: IdeaItem }[] {
  const q = query.replace(/\s+/g, '').toLowerCase()
  if (!q) return []
  const out: { section: IdeaSection; item: IdeaItem }[] = []
  for (const g of groups)
    for (const item of g.items) {
      const hay = `${item.text}${item.note}${g.section.label}`.replace(/\s+/g, '').toLowerCase()
      if (hay.includes(q)) out.push({ section: g.section, item })
      if (out.length >= max) return out
    }
  return out
}

/** 연결해야 할 수 있는 아이디어인지 (아이디·비밀번호로 연결하는 곳인데 아직 안 했다) */
export function needsConnect(it: IdeaItem): boolean {
  return Boolean(it.service && !it.service.connected && it.service.how === 'browser')
}

/** 전부 몇 개인지 */
export function ideaCount(groups: readonly IdeaGroup[]): number {
  return groups.reduce((n, g) => n + g.items.length, 0)
}
