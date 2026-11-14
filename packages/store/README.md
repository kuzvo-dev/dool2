# @dool2/store

두리의 기록 저장소예요. 사용자 PC에만 남고, Node 내장 SQLite(`node:sqlite`)를 써서 네이티브 모듈 빌드가 필요 없어요([ADR 0009](../../docs/decisions/0009-node-sqlite.md)).

```ts
import { Store } from '@dool2/store'

const store = new Store('/path/to/dool2.db')
const thread = store.createThread('claude', '지금 몇 시야?')
store.addMessage(thread.id, 'user', '지금 몇 시야?')
store.listThreads() // 최근에 바뀐 순서
store.listMessages(thread.id)
store.close()
```

- 테이블: `threads`(대화), `messages`(메시지). 마이그레이션은 `user_version`으로 관리해요.
- WAL 모드와 외래 키를 켜요. 대화를 지우면 메시지도 함께 지워져요.
- 시각이 같아도 순서가 뒤섞이지 않게 단조 증가 시계를 써요.
