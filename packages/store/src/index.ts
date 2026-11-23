// Dool2's record store. It stays on the user's PC only (Node's built-in SQLite, no native module build).
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { AgentId, MessageRole, StoredMessage, ThreadSummary } from '@dool2/protocol'
import { NEW_THREAD_TITLE } from './locales/thread.js'

export { isNewThreadTitle, NEW_THREAD_TITLE } from './locales/thread.js'

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
  // One conversation (ADR 0015): threads are segments of it. Closing a segment leaves a summary,
  // and the next segment continues with what it carried over (carry) appended to the instructions
  `ALTER TABLE threads ADD COLUMN carry TEXT;
   ALTER TABLE threads ADD COLUMN summary TEXT;
   ALTER TABLE threads ADD COLUMN closed_at TEXT;
   CREATE INDEX messages_time ON messages(created_at);`,
  // Side conversations (by topic, feed posts) are not segments of the main conversation. They are left out of the main history and the "current segment"
  `ALTER TABLE threads ADD COLUMN side INTEGER NOT NULL DEFAULT 0;`,
  // Real size of a segment: tokens the AI read on its last turn (including tool results such as browser pages)
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
  /** What was carried over from the previous segment (summary, recent messages). Appended to the instructions on every turn of this segment */
  carry?: string
  /** Summary left when the segment was closed */
  summary?: string
  /** When the segment was closed, if it is closed */
  closedAt?: string
}

/** Uses monotonically increasing timestamps so order holds even with several saves in the same millisecond. */
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

  /** Pass ':memory:' as path for an in-memory test DB */
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

  createThread(
    agent: AgentId,
    title: string = NEW_THREAD_TITLE.ko,
    carry?: string,
    side = false,
  ): ThreadRecord {
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

  /** Deletes a side conversation (with its messages) */
  deleteThread(id: string) {
    this.db.prepare('DELETE FROM messages WHERE thread_id = ?').run(id)
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id)
  }

  /** Start over (for testing): deletes every conversation and message */
  clearConversations() {
    this.db.exec('DELETE FROM messages; DELETE FROM threads;')
  }

  /** Marks a thread as a side conversation (takes it out of the main conversation) */
  setSide(id: string, side = true) {
    this.db.prepare('UPDATE threads SET side = ? WHERE id = ?').run(side ? 1 : 0, id)
  }

  /** Side conversations, most recent first */
  listSideThreads(limit = 50): ThreadRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM threads WHERE side = 1 ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as unknown as ThreadRow[]
    return rows.map(toThread)
  }

  /**
   * Opens a new side conversation. If an empty one with no messages exists, it is moved to the top and reused
   * instead (so pressing New several times does not pile up empty ones). Undefined when none is empty and there are
   * already max. skip: a thread not to count (the one writing feed posts)
   */
  openSideThread(agent: AgentId, max: number, skip?: string): ThreadRecord | undefined {
    const empty = this.db
      .prepare(
        `SELECT t.id FROM threads t WHERE t.side = 1 AND t.id != ?
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id)
         ORDER BY t.updated_at DESC LIMIT 1`,
      )
      .get(skip ?? '') as { id: string } | undefined
    if (empty) {
      this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(this.stamp(), empty.id)
      return this.getThread(empty.id)
    }
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM threads WHERE side = 1 AND id != ?')
      .get(skip ?? '') as { n: number }
    if (n >= max) return undefined
    return this.createThread(agent, NEW_THREAD_TITLE.ko, undefined, true)
  }

  // ── One conversation (ADR 0015) ─────────────────────────────

  /** The segment open now (the most recent one not closed) */
  currentSession(): ThreadRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE closed_at IS NULL AND side = 0 ORDER BY updated_at DESC LIMIT 1')
      .get() as ThreadRow | undefined
    return row ? toThread(row) : undefined
  }

  /** Closes a segment, keeping the summary if there is one */
  closeSession(id: string, summary?: string) {
    this.db
      .prepare('UPDATE threads SET closed_at = ?, summary = COALESCE(?, summary) WHERE id = ?')
      .run(this.stamp(), summary ?? null, id)
  }

  /** Closes every other open segment (when moving from the old many-rooms model to one conversation) */
  closeOtherSessions(keepId: string) {
    this.db
      .prepare('UPDATE threads SET closed_at = ? WHERE closed_at IS NULL AND side = 0 AND id != ?')
      .run(this.stamp(), keepId)
  }

  /** Length of a segment: user turns, stored characters, and tokens the AI read on its last turn */
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

  /** Records the real size (tokens) of a segment. Leaves updated_at alone so idle-time math is not thrown off */
  setContextTokens(id: string, tokens: number) {
    this.db
      .prepare('UPDATE threads SET context_tokens = ? WHERE id = ?')
      .run(Math.max(0, Math.round(tokens)), id)
  }

  /**
   * Searches the history: user and Dool2 messages in the main conversation (all segments), without side conversations.
   * Spaces are ignored ("robotvacuum" = "robot vacuum"), and with several words the most matches come first, then the most recent.
   */
  searchConversation(
    query: string,
    opts: { limit?: number; excludeThreadId?: string } = {},
  ): StoredMessage[] {
    const words = [...new Set(query.split(/\s+/).filter(Boolean))]
    // With several words, drop one-character words (common Korean particles match almost every message)
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
   * The one conversation: messages of every segment in time order. The last `limit` ones before `before` (a time).
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
    if (!t) throw new Error(`Thread not found: ${id}`)
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

  /** Reads one setting. Undefined when missing */
  getSetting(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row ? JSON.parse(row.value) : undefined
  }

  /** Reads every setting as an object */
  getSettings(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as unknown as {
      key: string
      value: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  }

  /** Saves a setting as JSON. Undefined deletes it */
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
