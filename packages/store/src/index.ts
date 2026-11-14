// 두리 기록 저장소. 사용자 PC에만 남는다 (Node 내장 SQLite, 네이티브 모듈 빌드 없음).
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { AgentId, MessageRole, StoredMessage, ThreadSummary } from '@dool2/protocol'

const MIGRATIONS: string[] = [
  `CREATE TABLE threads (
     id TEXT PRIMARY KEY,
     agent TEXT NOT NULL,
     title TEXT NOT NULL,
     resume_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX messages_thread ON messages(thread_id, created_at);`,
]

interface ThreadRow {
  id: string
  agent: string
  title: string
  resume_id: string | null
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  thread_id: string
  role: string
  text: string
  created_at: string
}

export interface ThreadRecord extends ThreadSummary {
  resumeId?: string
}

/** 같은 밀리초에 여러 번 저장해도 순서가 유지되게 단조 증가 시각을 쓴다. */
function makeClock(now: () => Date) {
  let last = 0
  return () => {
    const t = Math.max(now().getTime(), last + 1)
    last = t
    return new Date(t).toISOString()
  }
}

export class Store {
  private readonly db: DatabaseSync
  private readonly stamp: () => string

  /** path에 ':memory:'를 주면 테스트용 메모리 DB */
  constructor(path: string, opts: { now?: () => Date } = {}) {
    this.db = new DatabaseSync(path)
    this.stamp = makeClock(opts.now ?? (() => new Date()))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  private migrate() {
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    for (let v = current; v < MIGRATIONS.length; v++) {
      const sql = MIGRATIONS[v]
      if (!sql) continue
      this.db.exec('BEGIN')
      try {
        this.db.exec(sql)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
  }

  createThread(agent: AgentId, title = '새 대화'): ThreadRecord {
    const id = randomUUID()
    const at = this.stamp()
    this.db
      .prepare('INSERT INTO threads (id, agent, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, agent, title, at, at)
    return { id, agent, title, createdAt: at, updatedAt: at }
  }

  getThread(id: string): ThreadRecord | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined
    return row ? toThread(row) : undefined
  }

  listThreads(limit = 50): ThreadRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as unknown as ThreadRow[]
    return rows.map(toThread)
  }

  updateThread(id: string, patch: { title?: string; resumeId?: string }) {
    const t = this.getThread(id)
    if (!t) throw new Error(`대화를 찾을 수 없어요: ${id}`)
    this.db
      .prepare('UPDATE threads SET title = ?, resume_id = ?, updated_at = ? WHERE id = ?')
      .run(patch.title ?? t.title, patch.resumeId ?? t.resumeId ?? null, this.stamp(), id)
  }

  addMessage(threadId: string, role: MessageRole, text: string): StoredMessage {
    const id = randomUUID()
    const at = this.stamp()
    this.db
      .prepare('INSERT INTO messages (id, thread_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, threadId, role, text, at)
    this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(at, threadId)
    return { id, threadId, role, text, createdAt: at }
  }

  listMessages(threadId: string): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC')
      .all(threadId) as unknown as MessageRow[]
    return rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      role: r.role as MessageRole,
      text: r.text,
      createdAt: r.created_at,
    }))
  }

  close() {
    this.db.close()
  }
}

function toThread(r: ThreadRow): ThreadRecord {
  return {
    id: r.id,
    agent: r.agent as AgentId,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.resume_id ? { resumeId: r.resume_id } : {}),
  }
}
