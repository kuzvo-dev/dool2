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
  /** 입체 이모지 (packages/ui/emoji/<emo>.webp) */
  emo: string
  /** 이 분류에 넣을 연결 카드 분류 */
  cats: ConnectCard['category'][]
  /** 분류와 상관없이 이 분류로 옮길 카드 */
  cards?: string[]
  asks: IdeaAsk[]
}

export const IDEA_SECTIONS: IdeaSection[] = [
  {
    id: 'routine',
    label: '매일 챙기기',
    emo: 'routine',
    icon: 'goal',
    tone: 'mint',
    cats: [],
    asks: [
      { text: '아침마다 반도체·부동산 뉴스 세 줄씩 요약해 줘', note: '원문 링크도 같이 붙여요' },
      { text: '매일 아침 우리 동네 새 소식 있으면 알려 줘', note: '새 가게·무료 행사·도로 통제까지' },
      { text: '자는 동안 이 일들 처리해 두고 아침에 알려 줘', note: '끝난 일과 물어볼 일을 나눠 보고해요' },
      { text: '매일 밤 11시 반에 휴대폰 내려놓으라고 알려 줘', note: '습관 목표로 만들어 매일 체크해요' },
      { text: '매달 10일에 지역화폐 충전하라고 알려 줘', note: '매달 돌아오는 날도 알림으로' },
    ],
  },
  {
    id: 'benefit',
    label: '혜택·환급',
    emo: 'money',
    icon: 'star',
    tone: 'amber',
    cats: [],
    asks: [
      { text: '내가 받을 수 있는 정부 지원금 다 찾아 줘', note: '보조금24에서 조회해 마감 순으로 정리해요' },
      { text: '정부24에서 안 찾아간 환급금 있는지 봐 줘', note: '세금·건보·연금·통신비까지 한 번에' },
      { text: '건강보험에서 돌려받을 돈 있는지 확인해 줘', note: '본인인증은 폰에서 직접 승인해요' },
      { text: '잊고 있던 보험금이나 휴면 계좌 찾아 줘', note: '찾은 돈은 받는 방법까지 정리해요' },
      { text: '근로장려금 받을 수 있는지 봐 줘', note: '대상이면 신청 화면까지 채워 둬요' },
      { text: '문화누리카드나 에너지바우처 대상인지 봐 줘', note: '대상이면 신청까지 도와요' },
      { text: '연말정산 예상 환급액 미리 계산해 줘', note: '12월 안에 챙길 공제도 정리해요' },
      { text: '고향사랑기부 10만 원 할 곳이랑 답례품 골라 줘', note: '세액공제 되는 금액까지 계산해요' },
      { text: 'K-패스 등록해서 교통비 돌려받게 해 줘', note: '가입 화면까지 같이 가요' },
      { text: '청년 적금 다음 가입 기간 열리면 알려 줘', note: '열리는 날 아침에 알림을 보내요' },
      { text: '중소기업 청년 소득세 감면 신청서 채워 줘', note: '회사에 낼 서류로 만들어 드려요' },
      { text: '흩어진 포인트랑 마일리지 얼마 있는지 모아 줘', note: '사라지기 전에 쓸 곳도 골라요' },
      { text: '탑승했는데 빠진 마일리지 찾아서 적립 신청해 줘', note: '메일에서 탑승 내역을 찾아요' },
      { text: '배송 끝난 주문 구매확정하고 적립금 받아 줘', note: '쿠팡·네이버 주문을 같이 봐요' },
      { text: '안 쓴 구매 후기 찾아서 써 줘', note: '올리기 전에 글을 보여 드려요' },
      { text: '매일 하는 출석체크 대신 눌러 줘', note: '매일 정한 시간에 해 둬요' },
      { text: '오늘 밤 열리는 세일 쿠폰 시간 맞춰 받아 줘', note: '열리는 시각에 맞춰 실행해요' },
      { text: '나한테 맞는 체험단 모집 찾아서 신청해 줘', note: '조건에 맞는 것만 골라요' },
      { text: '상품권 걸린 공공기관 퀴즈 응모해 줘', note: '정답을 찾아 응모 화면을 채워요' },
      { text: '기한 지난 기프티콘 환불받게 해 줘', note: '연장할 수 있는 건 연장부터' },
    ],
  },
  {
    id: 'grocery',
    label: '장보기·배달',
    emo: 'grocery',
    icon: 'cart',
    tone: 'mint',
    cats: ['grocery'],
    asks: [
      {
        text: '있는 재료로 일주일 저녁 식단 짜고 모자란 것만 담아 줘',
        note: '장바구니에만 담고 결제는 물어봐요',
      },
      { text: '휴지랑 세제 떨어질 때쯤 지난번 거로 다시 시켜 줘', note: '주문 전에 폰으로 승인받아요' },
    ],
  },
  {
    id: 'shopping',
    label: '쇼핑',
    emo: 'shopping',
    icon: 'box',
    tone: 'blue',
    cats: ['shopping'],
    asks: [
      {
        text: '30만 원 이하 무선 청소기 3개 비교표 만들어 줘',
        note: '가격·무게·후기를 표로, 하나 골라 드려요',
      },
      { text: '갤럭시 버즈 제일 싼 곳 찾아서 주문해 줘', note: '결제 직전에 폰으로 승인받아요' },
      { text: '이 상품 다른 데서 더 싸게 파는지 찾아 줘', note: '링크나 상품 이름을 같이 보내 주세요' },
      { text: '이 상품 재입고되거나 3만 원 아래로 내려가면 알려 줘', note: '목표로 만들어 매일 확인해요' },
      { text: '닌텐도 스위치 25만 원 아래 중고 매물 찾아 줘', note: '상태와 가격을 비교해요' },
      { text: '사진 속 이 조명 어디서 파는지 찾아 줘', note: '사진은 입력칸 + 에서 보내요' },
      { text: '아이허브에서 마그네슘 주문해 줘', note: '통관번호 입력까지 챙겨요' },
      { text: '지난주 산 블루투스 스피커 반품 접수해 줘', note: '수거 날짜와 환불까지 지켜봐요' },
      { text: '택배 상자 찌그러져 왔어, 배상 접수해 줘', note: '사진으로 접수하고 답을 기다려요' },
      { text: '주문한 택배 어디쯤 왔는지 봐 줘', note: '도착할 때까지 지켜볼 수도 있어요' },
      { text: '부모님 선물 5만 원대로 골라 줘', note: '후기 좋은 것 위주로 3개' },
      { text: '근처 매장에 이 운동화 260 있는지 봐 줘', note: '온라인 재고 조회로 확인해요' },
    ],
  },
  {
    id: 'fashion',
    label: '패션·뷰티',
    emo: 'beauty',
    icon: 'star',
    tone: 'rose',
    cats: ['fashion'],
    asks: [
      {
        text: '이 사진 같은 스타일로 셔츠 골라서 장바구니에 담아 줘',
        note: '사이즈를 알려 주시면 맞춰 골라요',
      },
    ],
  },
  {
    id: 'money',
    label: '돈 관리',
    emo: 'card',
    icon: 'card',
    tone: 'blue',
    cats: ['telecom', 'finance'],
    asks: [
      { text: '매달 자동결제되는데 안 쓰는 서비스 골라 해지해 줘', note: '해지는 하나씩 승인받고 해요' },
      { text: '카드별로 실적 채우려면 얼마 더 써야 하는지 알려 줘', note: '어느 카드로 결제하면 좋은지도' },
      { text: '쓰는 카드 캐시백 이벤트 응모해 줘', note: '내 결제 계획에 맞는 것만 골라요' },
      { text: '한 달 생활비 80만 원 예산 잡고 지출 정리해 줘', note: '넘을 것 같으면 미리 알려요' },
      { text: '지금 요금제보다 싼 휴대폰 요금제 있는지 봐 줘', note: '실제 쓰는 데이터 양에 맞춰 비교해요' },
      { text: '매달 빠져나가는 휴대폰 부가서비스 찾아 줘', note: '안 쓰는 건 해지까지' },
      { text: '휴대폰 25% 약정할인 끝났는지 확인해 줘', note: '끝났으면 다시 신청해요' },
      { text: '통신사 장기고객 쿠폰 받을 거 있는지 봐 줘', note: '사라지기 전에 알려 드려요' },
      { text: '관리비 고지서 사진 보낼게, 기한 맞춰 내 줘', note: '납부는 폰으로 승인받고 해요' },
      { text: '자동차보험 같은 보장으로 더 싼 데 있는지 봐 줘', note: '증권을 보내 주시면 비교해요' },
      { text: '카카오 주가 7% 넘게 움직이면 알려 줘', note: '장 시작과 마감에 정리도 해요' },
      { text: '이번 달 공모주 청약 일정이랑 환불일 정리해 줘', note: '배정 결과까지 이어서 챙겨요' },
    ],
  },
  {
    id: 'travel',
    label: '여행·숙소',
    emo: 'travel',
    icon: 'place',
    tone: 'amber',
    cats: ['travel'],
    asks: [
      { text: '2월에 후쿠오카 3박 4일, 150만 원으로 일정 짜 줘', note: '날짜별 동선과 예상 비용까지' },
      { text: '크리스마스에 속초 바다 보이는 숙소 제일 싼 곳 예약해 줘', note: '결제 전에 꼭 물어봐요' },
      { text: '인스타에 저장한 맛집 지도에 지역별로 모아 줘', note: '캡처나 링크를 보내도 돼요' },
      { text: '예약한 호텔에 늦은 체크아웃 되는지 물어봐 줘', note: '메일로 묻고 답을 정리해요' },
      { text: '미국 ESTA 공식 사이트에서 신청서 채워 줘', note: '결제 직전까지 준비해요' },
      { text: '강아지 데리고 일본 가려면 뭐부터 해야 해?', note: '검역·신고·항공 규정을 날짜 순으로' },
      { text: '초보 둘이 갈 스키장이랑 숙소·장비 렌탈 비교해 줘', note: '원하는 날로 한 번에 예약해요' },
      { text: '도쿄 식당에 창가 자리 되는지 일본어로 메일 보내 줘', note: '보내기 전에 글을 보여 드려요' },
    ],
  },
  {
    id: 'transport',
    label: '교통·항공',
    emo: 'plane',
    icon: 'plane',
    tone: 'violet',
    cats: ['flight'],
    asks: [
      {
        text: '1월 김포-제주 왕복 7만 원 아래로 나오면 잡아 줘',
        note: '매일 가격을 보고, 결제는 승인받아요',
      },
      { text: '다음 주 비행기 체크인 열리면 앞쪽 나란히 자리 잡아 줘', note: '지연·결항도 지켜봐요' },
      { text: '마일리지로 5월 방콕 보너스 좌석 남은 날 찾아 줘', note: '없으면 매일 다시 봐요' },
      { text: '지난번 결항된 비행기 보상 받을 수 있는지 계산해 줘', note: '청구 화면까지 채워 둬요' },
      { text: '서울에서 전주 가는 고속버스 토요일 오전 표 찾아 줘', note: '남은 자리도 같이 봐요' },
      { text: '내일 10시까지 판교 도착하려면 몇 시에 나가야 해?', note: '시간대별 예상 시간을 비교해요' },
      { text: '토요일 오전부터 5시간 쏘카 빌려 줘', note: '결제 전에 한 번 확인받아요' },
      { text: '설 연휴 인천공항 주차 예약 열리면 잡아 줘', note: '열리는 시각에 맞춰 넣어요' },
    ],
  },
  {
    id: 'tickets',
    label: '예매·예약',
    emo: 'ticket',
    icon: 'ticket',
    tone: 'rose',
    cats: ['tickets'],
    asks: [
      { text: '토요일 저녁 7시에 4명 연남동 한식집 예약해 줘', note: '확정 직전에 꼭 물어볼게요' },
      { text: '오늘 저녁 스시집 취소 자리 나면 잡아 줘', note: '예약 앱을 지켜보다 잡아요' },
      { text: '일요일 오후 메가박스 가운데 자리 2장 예매해 줘', note: '결제는 폰에서 승인해요' },
      { text: '다음 주 미용실 늘 하던 선생님으로 예약해 줘', note: '네이버 예약으로 잡아요' },
      { text: '휴양림 예약 열리는 날 맞춰 2박 잡아 줘', note: '열리는 시각에 바로 신청해요' },
      { text: '국립공원 야영장 취소 자리 나오면 잡아 줘', note: '원하는 날을 지켜봐요' },
      { text: '가고 싶은 팝업 사전 예약 열리면 신청해 줘', note: '열리는 시각에 맞춰요' },
      { text: '봄 마라톤 접수 열리면 하프로 신청해 줘', note: '기념품 사이즈까지 넣어요' },
      { text: '토요일 아침 수도권 골프장 4명 티타임 찾아 줘', note: '꽉 찼으면 자리 날 때까지 봐요' },
      { text: '구민체육센터 수영 강습 등록일에 신청해 줘', note: '가격과 등록일부터 확인해요' },
      { text: '보고 싶은 공연 예매 열리는 날 알려 줘', note: '열리는 날 아침에 다시 알려요' },
    ],
  },
  {
    id: 'admin',
    label: '서류·행정',
    emo: 'document',
    icon: 'note',
    tone: 'violet',
    cats: ['gov'],
    asks: [
      { text: '주민등록등본 떼서 PDF로 줘', note: '본인인증은 폰에서 직접 승인해요' },
      { text: '이사했어, 전입신고랑 주소 바꿀 곳 챙겨 줘', note: '빠진 곳이 없게 순서대로' },
      { text: '내 명의로 몰래 개통된 휴대폰 있는지 봐 줘', note: '새 개통 막는 신청까지' },
      { text: '자동차 정기검사 기한 확인하고 검사소 잡아 줘', note: '기한 전에 알림도 만들어요' },
      { text: '운전면허 갱신 기간 알려 주고 준비물 챙겨 줘', note: '사진 규격까지 정리해요' },
      { text: '자동차세 1월에 연납 신청해 줘', note: '할인 금액도 계산해 드려요' },
      { text: '내 차 리콜이나 무상수리 대상인지 봐 줘', note: '대상이면 센터 예약까지' },
      { text: '홈택스에서 현금영수증 내역 PDF로 받아 줘', note: '지출증빙도 같이 챙겨요' },
      { text: '이 메일 보고 전자세금계산서 발급 화면 채워 줘', note: '발급은 인증만 하시면 돼요' },
      { text: '온라인 쇼핑몰 창업 서류 순서대로 챙겨 줘', note: '사업자등록부터 통신판매업까지' },
      { text: '소파 버리게 대형폐기물 신청해 줘', note: '사진을 보내 주시면 품목을 골라요' },
      { text: '이 집 등기부등본 떼서 위험한 데 짚어 줘', note: '근저당·압류를 쉬운 말로' },
      { text: '국가장학금 1차 신청 기간 알려 주고 챙겨 줘', note: '가족 동의까지 확인해요' },
      { text: '국민비서 알림 온 거 처리해 줘', note: '신청서를 채우고 접수번호를 받아 둬요' },
    ],
  },
  {
    id: 'mail',
    label: '메일·일정',
    emo: 'calendar',
    icon: 'mail',
    tone: 'blue',
    cats: ['mail', 'device', 'account'],
    asks: [
      { text: '오늘 일정과 받은 메일 중에 내가 할 일만 뽑아 줘', note: '바로 할 수 있는 건 처리해요' },
      { text: '답장해야 할 메일 찾아서 초안 써 줘', note: '보내기 전에 꼭 보여 드려요' },
      { text: '광고 메일만 골라서 정리해 줘', note: '영수증·안내 메일은 남겨 둬요' },
      { text: '다운로드 기한 있는 메일 첨부파일 받아 둬', note: '기한 전에 PC에 저장해요' },
      { text: '이 캡처에 있는 일정 캘린더에 넣어 줘', note: '해외 일정은 현지 시간으로 맞춰요' },
      { text: '캘린더에 겹친 일정이랑 지난 일정 정리해 줘', note: '지우기 전에 목록을 보여 드려요' },
      { text: '아빠 음력 생신 앞으로 10년치 캘린더에 넣어 줘', note: '해마다 양력 날짜로 바꿔요' },
      { text: '출장 메일 보고 기차랑 숙소 챙겨 줘', note: '미팅 시간에 맞춰 골라요' },
      { text: '다른 AI에 물어볼 질문 줘, 내 정보 옮기게', note: '답을 붙여 넣으면 기억해 둬요' },
    ],
  },
  {
    id: 'life',
    label: '집·생활',
    emo: 'home',
    icon: 'sun',
    tone: 'amber',
    cats: ['life'],
    asks: [
      { text: '내 조건에 맞는 청약 공고 나오면 알려 줘', note: '지역·소득 조건을 알려 주세요' },
      { text: '성동구 전세 2억 5천 이하 매물 찾고 전세가율도 봐 줘', note: '새 매물이 오르면 알려요' },
      { text: '이사 견적 세 군데 받아서 비교해 줘', note: '메일·견적 사이트로 요청해요' },
      { text: '보일러 고장 났어, 수리 접수해 줘', note: '가장 빠른 방문 날로 잡아요' },
      { text: '이 카페 반려견 동반이랑 주차 되는지 봐 줘', note: '헛걸음하지 않게 미리 확인해요' },
      { text: '지하철에서 잃어버린 우산 유실물 센터에 있는지 봐 줘', note: '유실물 포털을 찾아봐요' },
      { text: '청첩장 보낼게, 가는 길이랑 근처 숙소 찾아 줘', note: '화환 주문도 챙길 수 있어요' },
      { text: '다음 달 집들이 8명 준비 같이 하자', note: '장소·초대·장볼 것까지' },
    ],
  },
  {
    id: 'health',
    label: '건강',
    emo: 'medical',
    icon: 'heart',
    tone: 'rose',
    cats: [],
    asks: [
      { text: '주 3회 30분 운동 계획 짜서 캘린더에 넣어 줘', note: '운동할 시간에 알려 드려요' },
      { text: '식단 사진 보낼게, 칼로리 기록해 줘', note: '하루가 끝나면 합계를 알려요' },
      { text: '매일 밤 9시에 약 먹으라고 알려 줘', note: '약 떨어질 때쯤도 챙겨요' },
      { text: '올해 건강검진 대상인지 보고 예약할 곳 찾아 줘', note: '본인인증은 폰에서 직접 해요' },
      { text: '연말 전에 스케일링 받게 치과 예약해 줘', note: '네이버 예약으로 잡아요' },
      { text: '독감 무료접종 대상인지 보고 근처 병원 찾아 줘', note: '대상 조건부터 확인해요' },
      { text: '근처 병원 도수치료 가격 비교해 줘', note: '공개된 비급여 가격으로 표를 만들어요' },
      { text: '지금 문 연 소아과 찾아 줘', note: '진료 시간까지 확인해요' },
      { text: '대학병원 진료 더 빠른 날 나오면 알려 줘', note: '하루 한 번 예약 화면을 봐요' },
    ],
  },
  {
    id: 'family',
    label: '아이·가족',
    emo: 'family',
    icon: 'users',
    tone: 'mint',
    cats: [],
    cards: ['kidsnote'],
    asks: [
      { text: '7살 아이랑 이번 주 갈 만한 체험 프로그램 예약해 줘', note: '과학관·박물관 위주로 찾아요' },
      { text: '매일 아침 아이 학교 급식이랑 알레르기 알려 줘', note: '피해야 할 재료는 따로 표시해요' },
      { text: '유치원 입학 신청 일정 챙겨 줘', note: '추첨 결과와 추가모집까지' },
      { text: '강아지 접종 날짜 챙기고 사료 떨어질 때쯤 다시 시켜 줘', note: '주문은 승인받고 해요' },
      { text: '현장체험학습 가정통신문 써 줘', note: '회신서까지 갖춰 드려요' },
      { text: '가족 생일이랑 기념일 미리 알려 줘', note: '일주일 전에 알림으로' },
    ],
  },
  {
    id: 'fun',
    label: '즐길 거리',
    emo: 'sparkles',
    icon: 'heart',
    tone: 'violet',
    cats: [],
    asks: [
      { text: '오늘 운세랑 타로 한 장 봐 줘', note: '생년월일을 알려 주시면 사주도' },
      { text: '이번 주말 망원동 근처 갈 만한 전시나 팝업 찾아 줘', note: '예약이 필요한 곳은 예약까지' },
      { text: '좋아하는 가수 콘서트·굿즈 일정 챙겨 줘', note: '예매·응모 마감을 미리 알려요' },
      { text: '이번 주 로또 맞았는지 확인해 줘', note: '번호를 저장해 두면 매주 봐요' },
    ],
  },
  {
    id: 'media',
    label: '영상·음악·책',
    emo: 'media',
    icon: 'play',
    tone: 'violet',
    cats: ['media', 'books'],
    asks: [
      { text: '잔잔한 영국 드라마 추천하고 어디서 볼 수 있는지 찾아 줘', note: '대여 가격까지 같이' },
      { text: '이 책 제일 싸게 파는 곳 찾아 줘', note: '중고 재고까지 비교해요' },
      { text: '안 보는 OTT 구독 정리해 줘', note: '해지는 승인받고 해요' },
    ],
  },
  {
    id: 'social',
    label: 'SNS',
    emo: 'camera',
    icon: 'image',
    tone: 'rose',
    cats: ['social'],
    asks: [
      { text: '인스타 내보내기 파일로 맞팔 안 하는 계정 찾아 줘', note: '팔로워 변화도 정리해요' },
      { text: '이 사진이랑 메모로 블로그 글 써 줘', note: '올리기 전에 꼭 보여 드려요' },
    ],
  },
  {
    id: 'work',
    label: '일·공부',
    emo: 'laptop',
    icon: 'pc',
    tone: 'blue',
    cats: ['work'],
    asks: [
      { text: '서울 프론트엔드 경력 공고 매일 보고 알려 줘', note: '맞는 공고만 마감일과 함께' },
      { text: '보고서 초안 5쪽 자료까지 찾아서 만들어 줘', note: '주제와 분량을 알려 주세요' },
      { text: '강의계획서 보낼게, 과제 마감이랑 시험 날짜 넣어 줘', note: '마감 전에 미리 알려요' },
      { text: '대학생 인증으로 받을 수 있는 할인 정리해 줘', note: '쓸 만한 것만 골라요' },
      { text: '대학생 영상 공모전 마감 순으로 모아 줘', note: '제출 서류 체크리스트까지' },
      { text: '카페 창업 지원사업 공고 매주 정리해 줘', note: '신청할 수 있는 것만 골라요' },
      { text: '매일 아침 내 상품 검색 순위 기록해 줘', note: '크게 떨어지면 바로 알려요' },
      { text: '밤사이 들어온 쇼핑몰 문의 답변 초안 써 줘', note: '확인해 주시면 올려요' },
      { text: '이 페이지 바뀌면 알려 줘', note: '공고·심사 결과처럼 가끔 바뀌는 곳' },
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

/**
 * 분류별 아이디어. 직접 고른 부탁만 보여 준다 (연결 카드의 "할 수 있는 일"은 연결 화면에서 본다).
 * services는 예전처럼 서비스 아이디어를 섞을 때를 위해 받아만 둔다
 */
export function ideaCatalog(_services: readonly ConnectionItem[] = []): IdeaGroup[] {
  return IDEA_SECTIONS.map((section) => ({
    section,
    items: section.asks.map((a): IdeaItem => ({ text: a.text, ask: a.text, note: a.note })),
  })).filter((g) => g.items.length)
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
