# @dool2/store

Dool2's record store. It stays only on the user's PC and uses Node's built-in SQLite (`node:sqlite`), so no native module build is needed ([ADR 0009](../../docs/decisions/0009-node-sqlite.md)).

```ts
import { Store } from '@dool2/store'

const store = new Store('/path/to/dool2.db')
const thread = store.createThread('claude', '지금 몇 시야?') // "What time is it now?"
store.addMessage(thread.id, 'user', '지금 몇 시야?')
store.listThreads() // most recently changed first
store.listMessages(thread.id)
store.close()
```

- Tables: `threads` (conversations) and `messages`. Migrations are managed with `user_version`.
- WAL mode and foreign keys are on. Deleting a conversation deletes its messages too.
- It uses a monotonic clock so that order does not get scrambled even when timestamps are equal.
