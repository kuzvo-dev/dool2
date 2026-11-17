#!/usr/bin/env node
// 캡처용 데모 데이터를 만든다. 실제 AI를 부르지 않고, 개인정보 없는 대화를 기록에 넣는다.
// 사용법: node apps/daemon/scripts/seed-demo.mjs <데이터 폴더>
//   DOOL2_DATA_DIR=<데이터 폴더> DOOL2_SMOKE_OPEN=latest pnpm --filter @dool2/desktop smoke
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '@dool2/store'

const dir = process.argv[2]
if (!dir) {
  console.error('데이터 폴더를 알려 주세요: node seed-demo.mjs /tmp/dool2-demo')
  process.exit(1)
}
mkdirSync(dir, { recursive: true })

let t = Date.parse('2026-11-14T00:58:00Z')
const now = () => {
  t += 20_000
  return new Date(t)
}
const store = new Store(join(dir, 'dool2.db'), { now })

const older = store.createThread('codex', '이번 주 일정 알려 줘')
store.addMessage(older.id, 'user', '이번 주 일정 알려 줘')
store.addMessage(
  older.id,
  'assistant',
  '아직 캘린더에 연결돼 있지 않아요. 연결해 주시면 바로 정리해 드릴게요.',
)

const thread = store.createThread('claude', '지금 몇 시야?')
store.addMessage(thread.id, 'user', '지금 몇 시야?')
store.addMessage(thread.id, 'assistant', '지금은 **2026년 11월 14일 토요일 오전 10시**예요. 주말이네요 ☕')
store.addMessage(thread.id, 'user', '넌 누구야?')
store.addMessage(
  thread.id,
  'assistant',
  '저는 두리예요. 이 컴퓨터 안에 살면서 부탁하신 일을 대신 해요.\n\n돈이 드는 일이나 누군가에게 연락하는 일은 꼭 먼저 여쭤볼게요. 오늘은 뭐부터 할까요?',
)
// 사람에게 넘긴 대화 (로그인이 풀린 경우). 가장 최근 대화라 DOOL2_SMOKE_OPEN=latest로 열린다
const shop = store.createThread('claude', '장바구니에 담아 둔 귤 가격 봐 줘')
store.addMessage(shop.id, 'user', '장바구니에 담아 둔 귤 가격 봐 줘')
store.addMessage(
  shop.id,
  'tool',
  JSON.stringify({
    kind: 'handoff',
    tabId: 1,
    reason: '쇼핑몰 로그인이 풀려 있어요. Chrome의 두리 탭에서 로그인해 주세요.',
  }),
)
store.addMessage(
  shop.id,
  'assistant',
  '장바구니를 보려고 했는데 로그인이 풀려 있어서 멈췄어요. Chrome에 띄워 둔 두리 탭에서 로그인만 해 주시면 바로 이어서 볼게요.',
)
// 먼저 챙긴 일 카드 (SEED_TELL=1): 아래 피드의 f-w1·f-w2와 같은 글
if (process.env.SEED_TELL) {
  store.addMessage(
    shop.id,
    'tool',
    JSON.stringify({
      kind: 'tell',
      id: 'f-w1',
      title: '어제 주문한 러닝화, 내일 오전에 도착해요',
      body: '문 앞에 두고 간대요.',
      from: '쿠팡 주문 내역을 보고',
    }),
  )
  store.addMessage(
    shop.id,
    'tool',
    JSON.stringify({
      kind: 'tell',
      id: 'f-w2',
      title: '토요일이 엄마 생신이에요',
      body: '작년엔 꽃을 보냈어요. 올해도 3만 원대로 골라 둘까요?',
      from: '기억해 둔 것과 지난 주문을 보고',
      ask: '토요일 엄마 생신 선물 3만 원대로 골라 줘. 작년엔 꽃을 보냈어',
      askLabel: '골라 줘',
    }),
  )
}
// 승인 요청 대화 (DOOL2_SMOKE_APPROVAL=<캡처 이미지>와 함께 쓰면 승인 카드가 보인다)
// 따로 하는 대화 (메인 대화에 섞이지 않는다)
store.createThread('claude', '이사 준비', undefined, true)
const trip = store.createThread('claude', '제주 2박 3일 여행 계획', undefined, true)
store.addMessage(trip.id, 'user', '다음 달 제주 2박 3일 일정 짜 줘. 아이랑 같이 가요')
store.addMessage(
  trip.id,
  'assistant',
  '좋아요. 아이랑 가기 좋은 곳 위주로 짰어요.\n\n1. 첫날: 공항 → 협재 해변 → 숙소\n2. 둘째 날: 오름 한 곳, 오후엔 실내 체험관\n3. 셋째 날: 동문시장 들렀다 공항\n\n숙소는 서쪽이 동선이 편해요. 찾아볼까요?',
)
if (process.env.SEED_APPROVAL) {
  const buy = store.createThread('claude', '사과 1kg 바로 사 줘')
  store.addMessage(buy.id, 'user', '두리 시험 가게에서 사과 1kg 바로 사 줘')
  store.addMessage(
    buy.id,
    'tool',
    JSON.stringify({ kind: 'approval', tabId: 1, ref: 'e4', what: '사과 1kg 바로 구매' }),
  )
  store.addMessage(
    buy.id,
    'assistant',
    '사과 1kg(9,900원) **바로 구매** 버튼 앞까지 왔어요. 화면을 확인하고 승인해 주시면 제가 그 버튼만 누를게요.',
  )
}
// 목표·알아서 하는 일·보관함·기억·피드 (PC·폰의 피드·목표·보관함 탭과 두리 판 캡처용). 시각은 지금 기준
{
  const day = 24 * 60
  /** 오늘(0)·내일(1)·그제(-2)의 그 시각 */
  const on = (offset, h, m = 0) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    d.setHours(h, m, 0, 0)
    return d.toISOString()
  }
  // 몇 분 전·뒤 (보통은 오늘 낮 시각으로 맞춘다)
  const at = (min) => new Date(Date.parse(on(0, 13, 20)) + min * 60_000).toISOString()
  const tomorrow730 = on(1, 7, 30)
  store.setSetting('routines', [
    {
      id: 'r-walk',
      title: '주 3회 30분 걷기',
      prompt: '오늘 걸었는지 물어보고, 이번 주 몇 번 걸었는지 세어서 짧게 응원해 주세요.',
      schedule: { kind: 'weekly', time: '20:00', days: [1, 3, 5] },
      enabled: true,
      createdAt: at(-6 * day),
      category: '건강',
      plan: [
        { text: '걷기 좋은 동네 코스 2개 찾기', done: true },
        { text: '월·수·금 저녁 8시로 시간 정하기', done: true },
        { text: '2주 동안 빠지지 않기', done: false },
        { text: '30분 → 40분으로 늘리기', done: false },
      ],
      log: [
        { at: at(-2 * day), text: '수요일: 32분 걸었어요. 이번 주 두 번째예요.' },
        { at: at(-4 * day), text: '월요일: 30분 걸었어요.' },
      ],
      nextRunAt: on(0, 20),
      lastRunAt: on(-2, 20),
      lastResult: '이번 주 두 번 걸었어요. 금요일만 걸으면 목표를 채워요.',
    },
    {
      id: 'r-save',
      title: '한 달 식비 40만 원 안으로',
      prompt: '카드 결제 문자를 보고 이번 주 식비를 정리해 주세요.',
      schedule: { kind: 'weekly', time: '09:00', days: [1] },
      enabled: true,
      createdAt: at(-10 * day),
      category: '돈',
      plan: [
        { text: '지난달 식비 정리', done: true },
        { text: '배달은 주 2회까지', done: false },
      ],
      nextRunAt: on(2, 9),
    },
    {
      id: 'r-brief',
      title: '아침 브리핑',
      prompt: '오늘 날씨, 일정, 오는 택배를 짧게 알려 주세요.',
      schedule: { kind: 'daily', time: '07:30' },
      enabled: true,
      createdAt: at(-12 * day),
      nextRunAt: tomorrow730,
      lastRunAt: on(0, 7, 30),
    },
    {
      id: 'r-phone',
      title: '휴대폰 요금 확인',
      prompt: '이번 달 휴대폰 요금이 얼마 나왔는지 확인해 주세요.',
      schedule: { kind: 'weekly', time: '10:00', days: [6] },
      enabled: false,
      createdAt: at(-20 * day),
    },
  ])
  store.setSetting('library', [
    {
      id: 'l-1',
      kind: 'product',
      title: '무선 청소기 최저가 3곳 비교',
      body: '같은 모델 기준으로 **가격·배송·적립**을 비교했어요.\n- 가장 싼 곳: 내일 도착\n- 두 번째: 카드 할인 시 비슷해요',
      price: '219,000원',
      url: 'https://shop.example/item/cleaner',
      savedAt: at(-50),
    },
    {
      id: 'l-2',
      kind: 'note',
      title: '제주 2박 3일 일정 초안',
      body: '1일차 공항 → 협재 해변, 2일차 오름 두 곳, 3일차 시장 들렀다 공항.',
      savedAt: at(-day - 120),
    },
    {
      id: 'l-3',
      kind: 'place',
      title: '성수동 파스타집 (토 7시 두 자리 가능)',
      body: '창가 자리는 미리 말해야 해요. 주차는 근처 공영 주차장.',
      savedAt: at(-3 * day),
    },
    {
      id: 'l-4',
      kind: 'link',
      title: '연말정산 간소화 서비스 안내',
      body: '1월 15일부터 열려요. 의료비·교육비 영수증은 따로 챙겨야 해요.',
      url: 'https://example.com/tax-guide',
      savedAt: at(-5 * day),
    },
  ])
  store.setSetting('memory', [
    { id: 'm-1', text: '아침은 7시 반에 먹어요', source: 'user', at: at(-8 * day) },
    { id: 'm-2', text: '아이가 초등학교 3학년이에요', source: 'doori', at: at(-5 * day) },
    { id: 'm-3', text: '배달은 주로 저녁에 시켜요', source: 'doori', at: at(-day) },
  ])
  store.setSetting('feed', [
    // 먼저 챙긴 일 (ADR 0019): 부탁 없이 연결한 서비스를 살펴 올린 것
    {
      id: 'f-w1',
      kind: 'suggest',
      title: '어제 주문한 러닝화, 내일 오전에 도착해요',
      body: '문 앞에 두고 간대요.',
      from: '쿠팡 주문 내역을 보고',
      key: 'coupang-러닝화-도착예정',
      at: at(-3),
    },
    {
      id: 'f-w2',
      kind: 'suggest',
      title: '토요일이 엄마 생신이에요',
      body: '작년엔 꽃을 보냈어요. 올해도 3만 원대로 골라 둘까요?',
      from: '기억해 둔 것과 지난 주문을 보고',
      key: 'memory-엄마생신',
      ask: '토요일 엄마 생신 선물 3만 원대로 골라 줘. 작년엔 꽃을 보냈어',
      askLabel: '골라 줘',
      at: at(-4),
    },
    {
      id: 'f-w3',
      kind: 'suggest',
      title: '답장이 필요한 메일이 1개 있어요',
      body: '집주인이 다음 주 점검 시간을 물어봤어요.',
      from: 'Gmail 받은편지함을 보고',
      key: 'gmail-점검시간',
      ask: '집주인 메일에 답장 초안 써 줘',
      askLabel: '초안 써 줘',
      answered: 'yes',
      at: at(-6 * 60),
    },
    {
      id: 'f-1',
      kind: 'post',
      title: '오늘 아침 소식',
      body: '오늘은 **맑고 최고 14도**예요. 오후 3시에 치과 예약이 있어요.\n- 택배 2개가 오늘 와요 (키보드, 휴지)\n- 내일은 비 소식이 있어요. 우산 챙기세요.',
      at: on(0, 7, 31),
      reaction: 'up',
    },
    {
      id: 'f-2',
      kind: 'done',
      title: '무선 청소기 최저가 찾았어요',
      body: '세 곳을 비교해서 보관함에 남겨 뒀어요.',
      at: at(-52),
    },
    { id: 'f-3', kind: 'saved', title: '보관함에 남겼어요: 무선 청소기 최저가 3곳 비교', at: at(-50) },
    {
      id: 'f-4',
      kind: 'routine',
      title: '걷기 체크인',
      body: '이번 주 두 번 걸었어요. 금요일만 걸으면 목표를 채워요.',
      ref: 'r-walk',
      at: on(-2, 20, 2),
    },
    {
      id: 'f-5',
      kind: 'suggest',
      title: '안 쓰는 정기 결제 2개를 찾았어요',
      body: '영상 서비스 두 곳이 석 달째 안 쓰였어요. 정리할까요?',
      at: at(-day - 30),
    },
    {
      id: 'f-6',
      kind: 'goal',
      title: '목표를 세웠어요: 주 3회 30분 걷기',
      body: '월·수·금 오후 8:00',
      ref: 'r-walk',
      at: at(-6 * day),
    },
  ])
  store.setSetting('feedPrompt', '매일 아침 날씨·일정·오는 택배')
  store.setSetting('connections', { coupang: at(-3 * day), gmail: at(-2 * day) })
  // 캡처하는 동안 살펴보기가 돌지 않게 (실제 AI를 부르지 않는다)
  store.setSetting('watchAt', new Date().toISOString())
}
// 첫 실행 마법사는 끝낸 상태로 둔다
store.setSetting('setupDone', true)
store.setSetting('aiChoice', 'both')
store.setSetting('defaultAgent', 'claude')
store.close()
console.log(`데모 데이터를 만들었어요: ${dir}`)
