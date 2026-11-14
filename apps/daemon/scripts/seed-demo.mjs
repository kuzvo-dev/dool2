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
// 승인 요청 대화 (DOOL2_SMOKE_APPROVAL=<캡처 이미지>와 함께 쓰면 승인 카드가 보인다)
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
// 첫 실행 마법사는 끝낸 상태로 둔다
store.setSetting('setupDone', true)
store.setSetting('aiChoice', 'both')
store.setSetting('defaultAgent', 'claude')
store.close()
console.log(`데모 데이터를 만들었어요: ${dir}`)
