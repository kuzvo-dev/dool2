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
// 첫 실행 마법사는 끝낸 상태로 둔다
store.setSetting('setupDone', true)
store.setSetting('aiChoice', 'both')
store.setSetting('defaultAgent', 'claude')
store.close()
console.log(`데모 데이터를 만들었어요: ${dir}`)
