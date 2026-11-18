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
  `CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // 대화는 하나 (ADR 0015): threads는 대화의 구간. 구간을 닫을 때 요약을 남기고,
  // 새 구간은 앞 구간에서 넘겨받은 내용(carry)을 지침에 붙여 이어 간다
  `ALTER TABLE threads ADD COLUMN carry TEXT;
   ALTER TABLE threads ADD COLUMN summary TEXT;
   ALTER TABLE threads ADD COLUMN closed_at TEXT;
   CREATE INDEX messages_time ON messages(created_at);`,
  // 따로 하는 대화(주제별·피드 글): 메인 대화의 구간이 아니다. 메인 대화 기록과 "지금 구간"에서 뺀다
  `ALTER TABLE threads ADD COLUMN side INTEGER NOT NULL DEFAULT 0;`,
  // 구간의 실제 크기: AI가 마지막 차례에 읽은 토큰 수 (브라우저 페이지 같은 도구 결과 포함)
  `ALTER TABLE threads ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0;`,
]

interface ThreadRow {
  id: string
  agent: string
  title: string
  resume_id: string | null
  created_at: string
  updated_at: string
  carry: string | null
  summary: string | null
  closed_at: string | null
  side?: number
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
  /** 앞 구간에서 넘겨받은 내용 (요약·최근 대화). 이 구간의 매 차례 지침에 붙는다 */
  carry?: string
  /** 구간을 닫을 때 남긴 요약 */
  summary?: string
  /** 닫힌 구간이면 닫은 시각 */
  closedAt?: string
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

  createThread(agent: AgentId, title = '새 대화', carry?: string, side = false): ThreadRecord {
    const id = randomUUID()
    const at = this.stamp()
    this.db
      .prepare(
        'INSERT INTO threads (id, agent, title, carry, created_at, updated_at, side) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, agent, title, carry ?? null, at, at, side ? 1 : 0)
    return {
      id,
      agent,
      title,
      createdAt: at,
      updatedAt: at,
      ...(carry ? { carry } : {}),
      ...(side ? { side: true } : {}),
    }
  }

  /** 따로 하는 대화를 지운다 (말도 함께) */
  deleteThread(id: string) {
    this.db.prepare('DELETE FROM messages WHERE thread_id = ?').run(id)
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id)
  }

  /** 처음부터 다시(시험용): 모든 대화와 말을 지운다 */
  clearConversations() {
    this.db.exec('DELETE FROM messages; DELETE FROM threads;')
  }

  /** 따로 하는 대화로 표시한다 (메인 대화에서 뺀다) */
  setSide(id: string, side = true) {
    this.db.prepare('UPDATE threads SET side = ? WHERE id = ?').run(side ? 1 : 0, id)
  }

  /** 따로 하는 대화 목록 (최근 것부터) */
  listSideThreads(limit = 50): ThreadRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM threads WHERE side = 1 ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as unknown as ThreadRow[]
    return rows.map(toThread)
  }

  // ── 대화 하나 (ADR 0015) ─────────────────────────────

  /** 지금 열려 있는 구간 (닫히지 않은 것 중 가장 최근) */
  currentSession(): ThreadRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE closed_at IS NULL AND side = 0 ORDER BY updated_at DESC LIMIT 1')
      .get() as ThreadRow | undefined
    return row ? toThread(row) : undefined
  }

  /** 구간을 닫는다. 요약이 있으면 남긴다 */
  closeSession(id: string, summary?: string) {
    this.db
      .prepare('UPDATE threads SET closed_at = ?, summary = COALESCE(?, summary) WHERE id = ?')
      .run(this.stamp(), summary ?? null, id)
  }

  /** 열려 있는 다른 구간을 모두 닫는다 (예전 여러 방 → 대화 하나로 넘어올 때) */
  closeOtherSessions(keepId: string) {
    this.db
      .prepare('UPDATE threads SET closed_at = ? WHERE closed_at IS NULL AND side = 0 AND id != ?')
      .run(this.stamp(), keepId)
  }

  /** 구간의 길이: 사용자 차례 수, 저장된 글자 수, AI가 마지막 차례에 읽은 토큰 수 */
  sessionSize(id: string): { turns: number; chars: number; contextTokens: number } {
    const row = this.db
      .prepare(
        "SELECT SUM(role = 'user') AS turns, COALESCE(SUM(LENGTH(text)), 0) AS chars FROM messages WHERE thread_id = ?",
      )
      .get(id) as { turns: number | null; chars: number }
    const t = this.db.prepare('SELECT context_tokens FROM threads WHERE id = ?').get(id) as
      | { context_tokens: number | null }
      | undefined
    return { turns: row.turns ?? 0, chars: row.chars, contextTokens: t?.context_tokens ?? 0 }
  }

  /** 구간의 실제 크기(토큰)를 남긴다. 쉰 시간 계산이 흔들리지 않게 updated_at은 건드리지 않는다 */
  setContextTokens(id: string, tokens: number) {
    this.db
      .prepare('UPDATE threads SET context_tokens = ? WHERE id = ?')
      .run(Math.max(0, Math.round(tokens)), id)
  }

  /**
   * 대화 기록 찾기: 메인 대화(모든 구간)의 사용자·두리 말에서 찾는다. 따로 하는 대화는 뺀다.
   * 띄어쓰기는 무시하고("로봇청소기" = "로봇 청소기"), 낱말이 여럿이면 많이 맞은 것부터, 같으면 최근 것부터.
   */
  searchConversation(
    query: string,
    opts: { limit?: number; excludeThreadId?: string } = {},
  ): StoredMessage[] {
    const words = [...new Set(query.split(/\s+/).filter(Boolean))]
    // 낱말이 여럿이면 한 글자 낱말("본", "거")은 뺀다. 거의 모든 말에 걸린다
    const long = words.filter((w) => w.length > 1)
    const terms = (words.length > 1 && long.length ? long : words)
      .slice(0, 6)
      .map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    if (!terms.length) return []
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 10)), 50)
    const flat =
      "REPLACE(REPLACE(REPLACE(REPLACE(m.text, ' ', ''), char(10), ''), char(13), ''), char(9), '')"
    const score = terms.map(() => `(${flat} LIKE ? ESCAPE '\\')`).join(' + ')
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT m.*, (${score}) AS score FROM messages m JOIN threads t ON t.id = m.thread_id
           WHERE t.side = 0 AND m.role IN ('user', 'assistant') AND m.thread_id != ?
         ) WHERE score > 0 ORDER BY score DESC, created_at DESC LIMIT ?`,
      )
      .all(...terms, opts.excludeThreadId ?? '', limit) as unknown as MessageRow[]
    return rows.map(toMessage)
  }

  /**
   * 대화 하나: 모든 구간의 메시지를 시간순으로. before(시각)보다 앞의 것 중 마지막 limit개.
   */
  listConversation(opts: { before?: string; limit?: number } = {}): StoredMessage[] {
    const limit = opts.limit ?? 100
    const rows = (opts.before
      ? this.db
          .prepare(
            'SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.side = 0 AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?',
          )
          .all(opts.before, limit)
      : this.db
          .prepare(
            'SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.side = 0 ORDER BY m.created_at DESC LIMIT ?',
          )
          .all(limit)) as unknown as MessageRow[]
    return rows.reverse().map(toMessage)
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
    return rows.map(toMessage)
  }

  /** 설정 값 하나를 읽는다. 없으면 undefined */
  getSetting(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row ? JSON.parse(row.value) : undefined
  }

  /** 모든 설정을 객체로 읽는다 */
  getSettings(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as unknown as {
      key: string
      value: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  }

  /** 설정 값을 JSON으로 저장한다. undefined면 지운다 */
  setSetting(key: string, value: unknown) {
    if (value === undefined) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
      return
    }
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value))
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
    ...(r.carry ? { carry: r.carry } : {}),
    ...(r.summary ? { summary: r.summary } : {}),
    ...(r.closed_at ? { closedAt: r.closed_at } : {}),
    ...(r.side ? { side: true } : {}),
  }
}

function toMessage(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    threadId: r.thread_id,
    role: r.role as MessageRole,
    text: r.text,
    createdAt: r.created_at,
  }
}
